use super::archive::{payload_path, read_installpatch, scan_archive, JarIndex};
use super::detect::detect_env;
use super::mapping::Mapper;
use super::model::{
    ArchivePlan, BatchFile, BatchRecord, DeployResult, PlanStats, PreflightResult, ServiceInfo,
    StoredPlan,
};
use super::service;
use super::util::{
    is_within, read_json, remove_empty_parents, service_key, sha256_file, write_json_atomic,
    LogFile,
};
use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

fn count_stats(archives: &[ArchivePlan]) -> PlanStats {
    let mut stats = PlanStats::default();
    for archive in archives {
        for entry in &archive.entries {
            match entry.status.as_str() {
                "add" => {
                    stats.add += 1;
                    stats.total += 1;
                }
                "replace" => {
                    stats.replace += 1;
                    stats.total += 1;
                }
                "ignored" => stats.ignored += 1,
                "error" => stats.errors += 1,
                _ => {}
            }
            if entry.shadow_jar.is_some() && matches!(entry.status.as_str(), "add" | "replace") {
                stats.shadow += 1;
            }
        }
        stats.errors += archive.errors.len();
    }
    stats
}

pub fn preflight(
    target: &str,
    edition_hint: &str,
    product_name: &str,
    product_version: &str,
    uploads: &[(String, PathBuf)],
    staging: &Path,
    batch_id: &str,
) -> Result<PreflightResult> {
    if uploads.is_empty() {
        bail!("请至少上传一个补丁 ZIP");
    }
    let env = detect_env(target, edition_hint)?;
    fs::create_dir_all(staging.join("payload"))?;
    let mut jar_index = JarIndex::new(Path::new(&env.app_root));
    let mut archives = Vec::new();
    let mut seen_targets: HashMap<String, String> = HashMap::new();
    let mut warnings = Vec::new();

    for (name, path) in uploads {
        let rules = match read_installpatch(path) {
            Ok(rules) => rules,
            Err(error) => {
                archives.push(ArchivePlan {
                    name: name.clone(),
                    entries: Vec::new(),
                    errors: vec![format!("installpatch.xml 处理失败：{error}")],
                });
                continue;
            }
        };
        let mapper = Mapper::new(
            env.edition,
            PathBuf::from(&env.target_root),
            PathBuf::from(&env.app_root),
            rules,
        );
        match scan_archive(
            path,
            name,
            &mapper,
            staging,
            &mut jar_index,
            &mut seen_targets,
        ) {
            Ok(plan) => archives.push(plan),
            Err(error) => archives.push(ArchivePlan {
                name: name.clone(),
                entries: Vec::new(),
                errors: vec![format!("{error:#}")],
            }),
        }
    }

    for archive in &archives {
        for entry in &archive.entries {
            if let Some(warning) = &entry.warning {
                if entry.status != "ignored" {
                    warnings.push(format!("{}：{}", entry.archive_path, warning));
                }
            }
        }
        for error in &archive.errors {
            warnings.push(format!("{}：{}", archive.name, error));
        }
    }
    warnings.sort();
    warnings.dedup();

    let stats = count_stats(&archives);
    let has_conflicts = stats.replace > 0;
    let can_deploy = stats.errors == 0 && stats.total > 0;
    let created_at = super::util::now_text();

    let stored = StoredPlan {
        batch_id: batch_id.to_string(),
        created_at: created_at.clone(),
        product_name: product_name.to_string(),
        product_version: product_version.to_string(),
        env: env.clone(),
        archives: archives.clone(),
        stats: stats.clone(),
        warnings: warnings.clone(),
    };
    write_json_atomic(&staging.join("plan.json"), &stored)?;

    Ok(PreflightResult {
        success: true,
        batch_id: batch_id.to_string(),
        created_at,
        product_name: product_name.to_string(),
        product_version: product_version.to_string(),
        env,
        archives,
        stats,
        has_conflicts,
        can_deploy,
        warnings,
    })
}

fn backup_path(batch_dir: &Path, rel: &str) -> PathBuf {
    batch_dir.join("backup").join(rel)
}

fn apply_one(root: &Path, payload: &Path, target_rel: &str, batch_dir: &Path) -> Result<BatchFile> {
    let target = root.join(target_rel);
    if !is_within(root, &target) {
        bail!("目标路径越界：{}", target.display());
    }
    if target.is_dir() {
        bail!("目标位置是目录：{}", target.display());
    }
    let existed = target.is_file();
    let backup_rel = if existed {
        let backup = backup_path(batch_dir, target_rel);
        if let Some(parent) = backup.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&target, &backup).with_context(|| format!("备份失败：{}", target.display()))?;
        Some(target_rel.to_string())
    } else {
        None
    };
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(payload, &target)
        .with_context(|| format!("写入目标文件失败：{}", target.display()))?;
    let sha = sha256_file(&target)?;
    Ok(BatchFile {
        target_rel: target_rel.to_string(),
        action: if existed { "replace" } else { "add" }.to_string(),
        backup_rel,
        sha256: sha,
        size: fs::metadata(&target).map(|m| m.len()).unwrap_or(0),
        shadow_jar: None,
    })
}

fn undo_one(root: &Path, batch_dir: &Path, file: &BatchFile) -> Result<()> {
    let target = root.join(&file.target_rel);
    if let Some(rel) = &file.backup_rel {
        let backup = backup_path(batch_dir, rel);
        if !backup.is_file() {
            bail!("备份文件不存在，无法恢复：{}", backup.display());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&backup, &target)
            .with_context(|| format!("恢复文件失败：{}", target.display()))?;
    } else if target.exists() {
        fs::remove_file(&target)
            .with_context(|| format!("删除新增文件失败：{}", target.display()))?;
    }
    if let Some(parent) = target.parent() {
        remove_empty_parents(parent.to_path_buf(), root);
    }
    Ok(())
}

pub struct DeployOutcome {
    pub result: DeployResult,
    pub record: BatchRecord,
}

pub fn deploy(
    staging: &Path,
    batch_dir: &Path,
    log: &mut LogFile,
    restart: bool,
    confirm_replace: bool,
    service_override: Option<ServiceInfo>,
    seq: u64,
) -> Result<DeployOutcome> {
    let plan: StoredPlan =
        read_json(&staging.join("plan.json")).context("找不到预检结果，请重新预检")?;
    if plan.stats.errors > 0 {
        bail!("预检存在错误，不能部署");
    }
    if plan.stats.total == 0 {
        bail!("没有可部署文件");
    }
    if plan.stats.replace > 0 && !confirm_replace {
        bail!("环境中存在同名文件，需要确认替换后才能部署");
    }

    let service = service_override.unwrap_or_else(|| plan.env.service.clone());
    let root = PathBuf::from(&plan.env.target_root);
    if !root.is_dir() {
        bail!("目标目录不存在：{}", root.display());
    }

    // 部署前再次校验环境，避免预检后有人改了目标文件。
    for archive in &plan.archives {
        for entry in &archive.entries {
            if entry.status != "add" && entry.status != "replace" {
                continue;
            }
            let target = root.join(&entry.target_rel);
            if entry.status == "add" {
                if target.exists() {
                    bail!("环境已变化：{} 在预检后出现，请重新预检", entry.target_rel);
                }
            } else if target.is_file() {
                let current = sha256_file(&target)?;
                if let Some(expected) = &entry.target_sha256 {
                    if &current != expected {
                        bail!("环境已变化：{} 内容已改变，请重新预检", entry.target_rel);
                    }
                }
            } else if target.exists() {
                bail!("目标位置不是普通文件：{}", target.display());
            }
        }
    }

    fs::create_dir_all(batch_dir.join("backup"))?;

    let mut service_stopped = false;
    if restart {
        if service.stop_script.is_some() {
            service::stop(&service, log)?;
            service_stopped = true;
        } else if service.restart_script.is_none() {
            bail!("未找到重启命令");
        }
    }

    let mut applied: Vec<BatchFile> = Vec::new();
    let mut files: Vec<BatchFile> = Vec::new();
    for archive in &plan.archives {
        for entry in &archive.entries {
            if entry.status != "add" && entry.status != "replace" {
                continue;
            }
            let payload = payload_path(staging, &entry.target_rel);
            if !payload.is_file() {
                let error = anyhow::anyhow!("待部署文件缺失：{}", payload.display());
                rollback_applied(&root, batch_dir, &applied, log);
                if service_stopped {
                    let _ = service::start(&service, log);
                }
                return Err(error);
            }
            match apply_one(&root, &payload, &entry.target_rel, batch_dir) {
                Ok(mut file) => {
                    file.shadow_jar = entry.shadow_jar.clone();
                    files.push(file.clone());
                    applied.push(file);
                    log.line(format!(
                        "{} {}",
                        if files.last().map(|f| f.action.as_str()) == Some("replace") {
                            "替换"
                        } else {
                            "新增"
                        },
                        entry.target_rel
                    ));
                }
                Err(error) => {
                    rollback_applied(&root, batch_dir, &applied, log);
                    if service_stopped {
                        let _ = service::start(&service, log);
                    }
                    return Err(error);
                }
            }
        }
    }

    let mut service_restarted = false;
    let mut warnings = plan.warnings.clone();
    // 不重启时也执行 8.1 的 bin/deploy.sh（原命令行工具的行为），
    // 由用户稍后手动启动服务。
    if let Err(error) = service::run_deploy(&service, log) {
        warnings.push(format!("文件已复制，但 bin/deploy.sh 执行失败：{error}"));
        log.line(format!("deploy.sh 执行失败：{error}"));
    }
    if restart {
        match service::restart(&service, log, service_stopped) {
            Ok(()) => service_restarted = true,
            Err(error) => {
                warnings.push(format!("文件已部署，但服务重启失败：{error}"));
                log.line(format!("服务重启失败：{error}"));
            }
        }
    }

    let record = BatchRecord {
        id: plan.batch_id.clone(),
        seq,
        created_at: plan.created_at.clone(),
        product_name: plan.product_name.clone(),
        product_version: plan.product_version.clone(),
        edition: plan.env.edition.as_str().to_string(),
        target_root: plan.env.target_root.clone(),
        app_root: plan.env.app_root.clone(),
        archives: plan.archives.iter().map(|a| a.name.clone()).collect(),
        files: files.clone(),
        status: "deployed".to_string(),
        rolled_back_at: None,
        note: if warnings.is_empty() {
            None
        } else {
            Some(warnings.join("；"))
        },
    };

    let replaced = files.iter().filter(|f| f.action == "replace").count();
    let added = files.iter().filter(|f| f.action == "add").count();
    Ok(DeployOutcome {
        result: DeployResult {
            success: true,
            batch_id: plan.batch_id,
            message: format!("部署完成：替换 {replaced} 个，新增 {added} 个"),
            applied: files.len(),
            replaced,
            added,
            service_restarted,
            warnings,
            log_tail: log.tail(100),
        },
        record,
    })
}

fn rollback_applied(root: &Path, batch_dir: &Path, applied: &[BatchFile], log: &mut LogFile) {
    for file in applied.iter().rev() {
        if let Err(error) = undo_one(root, batch_dir, file) {
            log.line(format!("自动回退失败 {}：{error}", file.target_rel));
        } else {
            log.line(format!("自动回退 {}", file.target_rel));
        }
    }
}

fn detect_service(batch: &BatchRecord) -> Option<ServiceInfo> {
    detect_env(&batch.target_root, &batch.edition)
        .ok()
        .map(|env| env.service)
}

pub fn rollback(
    batches: &mut [BatchRecord],
    data_dir: &Path,
    target_batch_id: &str,
    restart: bool,
    confirm: bool,
    service_override: Option<ServiceInfo>,
    log: &mut LogFile,
) -> Result<DeployResult> {
    if !confirm {
        bail!("回滚需要二次确认");
    }
    let Some(target) = batches.iter().find(|b| b.id == target_batch_id) else {
        bail!("批次不存在：{target_batch_id}");
    };
    let target_seq = target.seq;
    let target_service = service_key(&target.target_root);
    let target_edition = target.edition.clone();
    let mut selected: Vec<usize> = batches
        .iter()
        .enumerate()
        .filter(|(_, b)| {
            b.status == "deployed"
                && b.seq >= target_seq
                && service_key(&b.target_root) == target_service
                && b.edition == target_edition
        })
        .map(|(index, _)| index)
        .collect();
    selected.sort_by_key(|index| std::cmp::Reverse(batches[*index].seq));
    if selected.is_empty() {
        bail!("没有可回滚的已部署批次");
    }

    let service = service_override.or_else(|| {
        selected
            .iter()
            .find_map(|index| detect_service(&batches[*index]))
    });
    let mut service_stopped = false;
    if restart {
        if let Some(service) = &service {
            if service.stop_script.is_some() {
                service::stop(service, log)?;
                service_stopped = true;
            } else if service.restart_script.is_none() {
                bail!("未找到重启命令");
            }
        } else {
            bail!("无法识别服务启停脚本，不能自动重启服务");
        }
    }

    let mut total_files = 0usize;
    let mut rolled_batches = 0usize;
    let mut failure: Option<anyhow::Error> = None;
    'outer: for index in selected {
        let batch = &mut batches[index];
        let batch_dir = data_dir.join("batches").join(&batch.id);
        let root = PathBuf::from(&batch.target_root);
        log.line(format!("开始回滚批次 {}", batch.id));
        for file in batch.files.iter().rev() {
            if let Err(error) = undo_one(&root, &batch_dir, file) {
                batch.status = "rollback_failed".to_string();
                log.line(format!("批次 {} 回滚失败：{error}", batch.id));
                failure = Some(error);
                break 'outer;
            }
            total_files += 1;
        }
        batch.status = "rolled_back".to_string();
        batch.rolled_back_at = Some(super::util::now_text());
        rolled_batches += 1;
        log.line(format!("批次 {} 回滚完成", batch.id));
    }

    if let Some(error) = failure {
        let _ = write_json_atomic(&data_dir.join("batches.json"), &batches);
        if restart && service_stopped {
            if let Some(service) = &service {
                let _ = service::start(service, log);
            }
        }
        return Err(error);
    }

    let mut service_restarted = false;
    let mut warnings = Vec::new();
    if let Some(service) = &service {
        // 不重启时也执行 8.1 的 bin/deploy.sh，由用户稍后手动启动服务。
        if let Err(error) = service::run_deploy(service, log) {
            warnings.push(format!("文件已回滚，但 bin/deploy.sh 执行失败：{error}"));
            log.line(format!("deploy.sh 执行失败：{error}"));
        }
        if restart {
            match service::restart(service, log, service_stopped) {
                Ok(()) => service_restarted = true,
                Err(error) => {
                    warnings.push(format!("文件已回滚，但服务重启失败：{error}"));
                    log.line(format!("服务重启失败：{error}"));
                }
            }
        }
    }
    Ok(DeployResult {
        success: true,
        batch_id: target_batch_id.to_string(),
        message: format!("回滚完成：{rolled_batches} 个批次，{total_files} 个文件"),
        applied: total_files,
        replaced: 0,
        added: 0,
        service_restarted,
        warnings,
        log_tail: log.tail(200),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, content) in entries {
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file(*name, options).unwrap();
            zip.write_all(content).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn fbip82_preflight_deploy_rollback() {
        let base =
            std::env::temp_dir().join(format!("cc-web-patch-deploy-test-{}", uuid::Uuid::new_v4()));
        let root = base.join("fbip");
        let class_dir = root.join("WEB-INF/classes/nccloud/demo");
        fs::create_dir_all(&class_dir).unwrap();
        fs::create_dir_all(root.join("WEB-INF/lib")).unwrap();
        fs::create_dir_all(root.join("modules")).unwrap();
        fs::create_dir_all(root.join("resources")).unwrap();
        fs::write(root.join("WEB-INF/web.xml"), b"<web-app/>").unwrap();
        fs::write(class_dir.join("A.class"), b"OLD").unwrap();

        let patch = base.join("patch.zip");
        write_zip(
            &patch,
            &[
                ("replacement/WEB-INF/classes/nccloud/demo/A.class", b"NEW"),
                (
                    "replacement/WEB-INF/classes/nccloud/demo/A.java",
                    b"class A {}",
                ),
                ("replacement/modules/foo/bar.txt", b"hello"),
            ],
        );

        let staging = base.join("staging");
        let uploads = vec![("patch.zip".to_string(), patch)];
        let plan = preflight(
            root.to_str().unwrap(),
            "auto",
            "FBIP",
            "8.2.0",
            &uploads,
            &staging,
            "test-batch",
        )
        .unwrap();
        assert_eq!(plan.product_name, "FBIP");
        assert_eq!(plan.stats.total, 3);
        assert_eq!(plan.stats.replace, 1);
        assert_eq!(plan.stats.add, 2);
        assert!(plan.can_deploy);

        let batch_dir = base.join("batches/test-batch");
        let mut log = LogFile::create(base.join("deploy.log")).unwrap();
        let outcome = deploy(&staging, &batch_dir, &mut log, false, true, None, 1).unwrap();
        assert_eq!(fs::read(class_dir.join("A.class")).unwrap(), b"NEW");
        assert!(root.join("WEB-INF/classes/nccloud/demo/A.java").is_file());
        assert!(root.join("modules/foo/bar.txt").is_file());
        assert_eq!(
            fs::read(batch_dir.join("backup/WEB-INF/classes/nccloud/demo/A.class")).unwrap(),
            b"OLD"
        );

        let mut batches = vec![outcome.record];
        rollback(&mut batches, &base, "test-batch", false, true, None, &mut log).unwrap();
        assert_eq!(fs::read(class_dir.join("A.class")).unwrap(), b"OLD");
        assert!(!root.join("WEB-INF/classes/nccloud/demo/A.java").exists());
        assert!(!root.join("modules/foo/bar.txt").exists());
        assert_eq!(batches[0].status, "rolled_back");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rollback_is_scoped_to_service() {
        let base = std::env::temp_dir().join(format!(
            "cc-web-patch-deploy-service-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&base).unwrap();
        let mut log = LogFile::create(base.join("rollback.log")).unwrap();
        let make = |id: &str, root: &str, seq: u64| BatchRecord {
            id: id.to_string(),
            seq,
            created_at: "2026-11-19 08:00:00".to_string(),
            product_name: "FBIP".to_string(),
            product_version: "8.2.0".to_string(),
            edition: "8.2".to_string(),
            target_root: root.to_string(),
            app_root: root.to_string(),
            archives: vec![format!("{id}.zip")],
            files: Vec::new(),
            status: "deployed".to_string(),
            rolled_back_at: None,
            note: None,
        };
        let mut batches = vec![
            make("p1", "D:/a/b/c", 1),
            make("p2", "D:/x/y/z", 2),
            make("p3", "D:/a/b/c", 3),
            make("p4", "D:/x/y/z", 4),
            make("p5", "D:/a/b/c", 5),
            make("p6", "D:/x/y/z", 6),
        ];

        rollback(&mut batches, &base, "p3", false, true, None, &mut log).unwrap();

        let status = |id: &str| {
            batches
                .iter()
                .find(|batch| batch.id == id)
                .map(|batch| batch.status.as_str())
                .unwrap()
        };
        assert_eq!(status("p1"), "deployed");
        assert_eq!(status("p2"), "deployed");
        assert_eq!(status("p3"), "rolled_back");
        assert_eq!(status("p4"), "deployed");
        assert_eq!(status("p5"), "rolled_back");
        assert_eq!(status("p6"), "deployed");

        let _ = fs::remove_dir_all(&base);
    }
}
