use super::mapping::{Mapped, Mapper};
use super::model::{ArchivePlan, PlanEntry};
use super::util::{normalize_rel, sha256_file};
use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use zip::read::ZipFile;
use zip::ZipArchive;

fn decode_entry_name<R: Read + ?Sized>(entry: &ZipFile<'_, R>) -> String {
    let raw = entry.name_raw();
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let (text, _, _) = encoding_rs::GBK.decode(raw);
            text.into_owned()
        }
    }
}

fn is_symlink<R: Read + ?Sized>(entry: &ZipFile<'_, R>) -> bool {
    entry
        .unix_mode()
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

/// 读取压缩包内的 installpatch.xml。
pub fn read_installpatch(zip_path: &Path) -> Result<Vec<super::mapping::CopyRule>> {
    let file =
        File::open(zip_path).with_context(|| format!("打开补丁包失败：{}", zip_path.display()))?;
    let mut archive = ZipArchive::new(file).context("不是有效的 ZIP 文件")?;
    let mut target: Option<usize> = None;
    for index in 0..archive.len() {
        let name = {
            let entry = archive.by_index(index)?;
            decode_entry_name(&entry).replace('\\', "/")
        };
        if name.eq_ignore_ascii_case("installpatch.xml") {
            target = Some(index);
            break;
        }
        if name.eq_ignore_ascii_case("replacement/installpatch.xml") && target.is_none() {
            target = Some(index);
        }
    }
    let Some(index) = target else {
        return Ok(Vec::new());
    };
    let mut entry = archive.by_index(index)?;
    let mut bytes = Vec::new();
    io::copy(&mut entry, &mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let doc = roxmltree::Document::parse(&text).context("installpatch.xml 解析失败")?;
    let mut rules = Vec::new();
    for node in doc.descendants().filter(|n| n.has_tag_name("copy")) {
        let from = node
            .children()
            .find(|n| n.has_tag_name("from"))
            .and_then(|n| n.text())
            .unwrap_or("");
        let to = node
            .children()
            .find(|n| n.has_tag_name("to"))
            .and_then(|n| n.text())
            .unwrap_or("");
        if from.trim().is_empty() || to.trim().is_empty() {
            bail!("installpatch.xml 中存在空的 from/to");
        }
        rules.push(super::mapping::CopyRule {
            from: from.trim().to_string(),
            to: to.trim().to_string(),
        });
    }
    Ok(rules)
}

pub struct JarIndex {
    app_root: PathBuf,
    classes: Option<HashMap<String, String>>,
}

impl JarIndex {
    pub fn new(app_root: &Path) -> Self {
        Self {
            app_root: app_root.to_path_buf(),
            classes: None,
        }
    }

    fn build(&self) -> HashMap<String, String> {
        let mut classes = HashMap::new();
        let lib = self.app_root.join("WEB-INF").join("lib");
        let Ok(entries) = fs::read_dir(&lib) else {
            return classes;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path
                .extension()
                .and_then(|v| v.to_str())
                .map(|v| v.eq_ignore_ascii_case("jar"))
                .unwrap_or(false)
            {
                continue;
            }
            let Ok(file) = File::open(&path) else {
                continue;
            };
            let Ok(mut archive) = ZipArchive::new(file) else {
                continue;
            };
            let jar_name = entry.file_name().to_string_lossy().to_string();
            for i in 0..archive.len() {
                let Ok(item) = archive.by_index(i) else {
                    continue;
                };
                let name = decode_entry_name(&item).replace('\\', "/");
                if name.ends_with(".class") {
                    classes.entry(name).or_insert_with(|| jar_name.clone());
                }
            }
        }
        classes
    }

    pub fn find_for_rel(&mut self, rel: &str) -> Option<String> {
        let marker = "WEB-INF/classes/";
        let index = rel.find(marker)?;
        let class_rel = &rel[index + marker.len()..];
        if self.classes.is_none() {
            self.classes = Some(self.build());
        }
        self.classes
            .as_ref()
            .and_then(|classes| classes.get(class_rel).cloned())
    }
}

fn copy_entry_to<R: Read + ?Sized>(entry: &mut ZipFile<'_, R>, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建目录失败：{}", parent.display()))?;
    }
    let mut out =
        File::create(target).with_context(|| format!("写入文件失败：{}", target.display()))?;
    io::copy(entry, &mut out)?;
    Ok(())
}

/// 扫描一个补丁包，完成路径映射、冲突检测、class/jar 同名检测，并把待部署文件抽取到 staging/payload。
pub fn scan_archive(
    zip_path: &Path,
    archive_name: &str,
    mapper: &Mapper,
    staging_dir: &Path,
    jar_index: &mut JarIndex,
    seen_targets: &mut HashMap<String, String>,
) -> Result<ArchivePlan> {
    let file =
        File::open(zip_path).with_context(|| format!("打开补丁包失败：{}", zip_path.display()))?;
    let mut archive =
        ZipArchive::new(file).with_context(|| format!("{archive_name} 不是有效的 ZIP 文件"))?;
    let payload_root = staging_dir.join("payload");
    let mut plan = ArchivePlan {
        name: archive_name.to_string(),
        entries: Vec::new(),
        errors: Vec::new(),
    };

    for index in 0..archive.len() {
        let mut entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(error) => {
                plan.errors
                    .push(format!("读取第 {index} 个条目失败：{error}"));
                continue;
            }
        };
        if entry.is_dir() {
            continue;
        }
        let name = decode_entry_name(&entry).replace('\\', "/");
        if entry.encrypted() {
            plan.entries.push(PlanEntry {
                archive: archive_name.to_string(),
                archive_path: name,
                target_rel: String::new(),
                status: "error".to_string(),
                ignore_reason: None,
                warning: None,
                size: entry.size(),
                sha256: None,
                target_sha256: None,
                shadow_jar: None,
                error: Some("压缩包已加密，当前工具不支持".to_string()),
            });
            continue;
        }
        if is_symlink(&entry) {
            plan.entries.push(PlanEntry {
                archive: archive_name.to_string(),
                archive_path: name,
                target_rel: String::new(),
                status: "error".to_string(),
                ignore_reason: None,
                warning: None,
                size: entry.size(),
                sha256: None,
                target_sha256: None,
                shadow_jar: None,
                error: Some("压缩包内包含符号链接，已拒绝".to_string()),
            });
            continue;
        }
        if entry.enclosed_name().is_none() {
            plan.entries.push(PlanEntry {
                archive: archive_name.to_string(),
                archive_path: name,
                target_rel: String::new(),
                status: "error".to_string(),
                ignore_reason: None,
                warning: None,
                size: entry.size(),
                sha256: None,
                target_sha256: None,
                shadow_jar: None,
                error: Some("压缩包条目包含路径穿越，已拒绝".to_string()),
            });
            continue;
        }

        match mapper.map(&name) {
            Mapped::Ignore { reason } => {
                plan.entries.push(PlanEntry {
                    archive: archive_name.to_string(),
                    archive_path: name,
                    target_rel: String::new(),
                    status: "ignored".to_string(),
                    ignore_reason: Some(reason.clone()),
                    warning: Some(reason),
                    size: entry.size(),
                    sha256: None,
                    target_sha256: None,
                    shadow_jar: None,
                    error: None,
                });
            }
            Mapped::Error { message } => {
                plan.entries.push(PlanEntry {
                    archive: archive_name.to_string(),
                    archive_path: name,
                    target_rel: String::new(),
                    status: "error".to_string(),
                    ignore_reason: None,
                    warning: None,
                    size: entry.size(),
                    sha256: None,
                    target_sha256: None,
                    shadow_jar: None,
                    error: Some(message),
                });
            }
            Mapped::Deploy { rel, abs, warning } => {
                let rel = match normalize_rel(&rel) {
                    Ok(rel) if !rel.is_empty() => rel,
                    Ok(_) => continue,
                    Err(error) => {
                        plan.entries.push(PlanEntry {
                            archive: archive_name.to_string(),
                            archive_path: name,
                            target_rel: String::new(),
                            status: "error".to_string(),
                            ignore_reason: None,
                            warning: None,
                            size: entry.size(),
                            sha256: None,
                            target_sha256: None,
                            shadow_jar: None,
                            error: Some(error.to_string()),
                        });
                        continue;
                    }
                };
                if let Some(previous) = seen_targets.get(&rel.to_lowercase()) {
                    plan.entries.push(PlanEntry {
                        archive: archive_name.to_string(),
                        archive_path: name,
                        target_rel: rel,
                        status: "error".to_string(),
                        ignore_reason: None,
                        warning: None,
                        size: entry.size(),
                        sha256: None,
                        target_sha256: None,
                        shadow_jar: None,
                        error: Some(format!("目标路径重复，已被 {previous} 使用")),
                    });
                    continue;
                }
                seen_targets.insert(rel.to_lowercase(), format!("{archive_name}:{name}"));

                if abs.is_dir() {
                    plan.entries.push(PlanEntry {
                        archive: archive_name.to_string(),
                        archive_path: name,
                        target_rel: rel,
                        status: "error".to_string(),
                        ignore_reason: None,
                        warning: None,
                        size: entry.size(),
                        sha256: None,
                        target_sha256: None,
                        shadow_jar: None,
                        error: Some(format!("目标位置是目录：{}", abs.display())),
                    });
                    continue;
                }

                let shadow = jar_index.find_for_rel(&rel);
                let target_exists = abs.is_file();
                let target_sha = if target_exists {
                    match sha256_file(&abs) {
                        Ok(value) => Some(value),
                        Err(error) => {
                            plan.entries.push(PlanEntry {
                                archive: archive_name.to_string(),
                                archive_path: name,
                                target_rel: rel,
                                status: "error".to_string(),
                                ignore_reason: None,
                                warning: None,
                                size: entry.size(),
                                sha256: None,
                                target_sha256: None,
                                shadow_jar: shadow,
                                error: Some(format!("读取目标文件失败：{error}")),
                            });
                            continue;
                        }
                    }
                } else {
                    None
                };

                let payload = payload_root.join(&rel);
                if let Err(error) = copy_entry_to(&mut entry, &payload) {
                    plan.entries.push(PlanEntry {
                        archive: archive_name.to_string(),
                        archive_path: name,
                        target_rel: rel,
                        status: "error".to_string(),
                        ignore_reason: None,
                        warning: None,
                        size: entry.size(),
                        sha256: None,
                        target_sha256: None,
                        shadow_jar: shadow,
                        error: Some(format!("解压失败：{error}")),
                    });
                    continue;
                }
                let sha = sha256_file(&payload).ok();

                plan.entries.push(PlanEntry {
                    archive: archive_name.to_string(),
                    archive_path: name,
                    target_rel: rel,
                    status: if target_exists { "replace" } else { "add" }.to_string(),
                    ignore_reason: None,
                    warning,
                    size: entry.size(),
                    sha256: sha,
                    target_sha256: target_sha,
                    shadow_jar: shadow,
                    error: None,
                });
            }
        }
    }

    Ok(plan)
}

pub fn payload_path(staging_dir: &Path, rel: &str) -> PathBuf {
    staging_dir.join("payload").join(rel)
}
