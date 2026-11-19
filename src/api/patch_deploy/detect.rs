use super::model::{Edition, EnvInfo, ServiceInfo};
use super::service::service_message;
use super::util::{path_text, service_key};
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

const WINDOWS: bool = cfg!(windows);

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn file(path: &Path) -> Option<String> {
    if path.is_file() {
        Some(path_text(path))
    } else {
        None
    }
}

fn first_file(root: &Path, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| file(&root.join(name)))
}

fn detect_81_service(bip_home: &Path) -> ServiceInfo {
    let bin = bip_home.join("bin");
    let (stop, force, start) = if WINDOWS {
        (
            first_file(bip_home, &["stop.bat", "stopServer.bat"]),
            first_file(bip_home, &["forcestop.bat", "forceStop.bat"]),
            first_file(bip_home, &["startup.bat", "startServer.bat"]),
        )
    } else {
        (
            first_file(bip_home, &["stop.sh", "stopServer.sh"]),
            first_file(bip_home, &["forcestop.sh", "forceStop.sh"]),
            first_file(bip_home, &["startup.sh", "startServer.sh"]),
        )
    };
    let deploy = if WINDOWS {
        first_file(&bin, &["deploy.bat", "deploy.cmd"])
    } else {
        first_file(&bin, &["deploy.sh"])
    };
    let restart = if WINDOWS {
        first_file(bip_home, &["restart.bat", "restartServer.bat"])
    } else {
        first_file(bip_home, &["restart.sh", "restartServer.sh"])
    };
    let can_restart = restart.is_some() || (stop.is_some() && start.is_some());
    let mut info = ServiceInfo {
        kind: "fbip81".to_string(),
        root: path_text(bip_home),
        stop_script: stop,
        force_script: force,
        start_script: start,
        restart_script: restart,
        deploy_script: deploy,
        can_restart,
        message: String::new(),
    };
    info.message = service_message(&info);
    info
}

fn detect_82_service(app_root: &Path) -> ServiceInfo {
    let mut found: Option<PathBuf> = None;
    let mut cursor = app_root.parent();
    for _ in 0..8 {
        let Some(dir) = cursor else { break };
        let marker = if WINDOWS {
            dir.join("bin").join("windows").join("admin.bat")
        } else {
            dir.join("bin").join("admin.sh")
        };
        if marker.is_file() {
            found = Some(dir.to_path_buf());
            break;
        }
        cursor = dir.parent();
    }

    let Some(tongweb_home) = found else {
        return ServiceInfo {
            kind: "tongweb".to_string(),
            root: String::new(),
            stop_script: None,
            force_script: None,
            start_script: None,
            restart_script: None,
            deploy_script: None,
            can_restart: false,
            message: "未找到 TongWeb 根目录（bin/admin.sh 或 bin/windows/admin.bat），部署时不会自动重启服务"
                .to_string(),
        };
    };

    let (stop, force, start, restart) = if WINDOWS {
        let bin = tongweb_home.join("bin").join("windows");
        (
            file(&bin.join("stopserver.bat")),
            file(&bin.join("forcestop.bat")),
            file(&bin.join("startserver.bat")),
            file(&bin.join("restartserver.bat")),
        )
    } else {
        let bin = tongweb_home.join("bin");
        (
            file(&bin.join("stopserver.sh")),
            file(&bin.join("forcestop.sh")),
            file(&bin.join("startserver.sh")),
            file(&bin.join("restartserver.sh")),
        )
    };
    let can_restart = restart.is_some() || (stop.is_some() && start.is_some());
    let mut info = ServiceInfo {
        kind: "tongweb".to_string(),
        root: path_text(&tongweb_home),
        stop_script: stop,
        force_script: force,
        start_script: start,
        restart_script: restart,
        deploy_script: None,
        can_restart,
        message: String::new(),
    };
    info.message = service_message(&info);
    info
}

fn is_81_layout(app_dir: &Path) -> bool {
    app_dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("hotwebs"))
        .unwrap_or(false)
}

fn resolve_81(input: &Path, app_dir: PathBuf) -> Result<EnvInfo> {
    let bip_home = if app_dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("hotwebs"))
        .unwrap_or(false)
    {
        app_dir
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .ok_or_else(|| anyhow::anyhow!("无法从 {} 推断 FBIP 根目录", app_dir.display()))?
    } else {
        input.to_path_buf()
    };
    let app_root = bip_home.join("hotwebs").join("fbip");
    if !app_root.join("WEB-INF").join("web.xml").is_file() {
        bail!(
            "识别为 FBIP 8.1，但找不到应用目录：{}",
            app_root.join("WEB-INF").join("web.xml").display()
        );
    }
    Ok(EnvInfo {
        edition: Edition::Fbip81,
        edition_label: Edition::Fbip81.label().to_string(),
        input_path: path_text(input),
        target_root: path_text(&bip_home),
        app_root: path_text(&app_root),
        service_key: service_key(&path_text(&bip_home)),
        service: detect_81_service(&bip_home),
    })
}

fn resolve_82(input: &Path, app_root: PathBuf) -> Result<EnvInfo> {
    if !app_root.join("WEB-INF").join("web.xml").is_file() {
        bail!(
            "识别为 FBIP 8.2，但找不到：{}",
            app_root.join("WEB-INF").join("web.xml").display()
        );
    }
    Ok(EnvInfo {
        edition: Edition::Fbip82,
        edition_label: Edition::Fbip82.label().to_string(),
        input_path: path_text(input),
        target_root: path_text(&app_root),
        app_root: path_text(&app_root),
        service_key: service_key(&path_text(&app_root)),
        service: detect_82_service(&app_root),
    })
}

/// 识别 FBIP 8.1 / 8.2 部署环境。
///
/// 用户可以选择：
/// - FBIP 8.1 根目录（包含 modules、hotwebs）
/// - FBIP 8.1 的 hotwebs/fbip
/// - FBIP 8.2 的 fbip 应用根目录
/// - FBIP 8.2 的 TongWeb 根目录（自动找 deployment/fbip）
pub fn detect_env(input: &str, edition_hint: &str) -> Result<EnvInfo> {
    let raw = input.trim().trim_matches('"').trim_matches('\'');
    if raw.is_empty() {
        bail!("请填写 FBIP 部署目录");
    }
    let original = PathBuf::from(raw);
    if !original.exists() {
        bail!("目录不存在：{}", original.display());
    }
    let input_path = strip_verbatim(original.canonicalize().context("无法解析目录")?);

    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.push(input_path.clone());
    candidates.push(input_path.join("hotwebs").join("fbip"));
    candidates.push(input_path.join("deployment").join("fbip"));
    candidates.push(input_path.join("fbip"));

    let Some(app_dir) = candidates
        .into_iter()
        .find(|candidate| candidate.join("WEB-INF").join("web.xml").is_file())
    else {
        bail!(
            "未找到 WEB-INF/web.xml。请选择 FBIP 8.2 的 fbip 应用目录，或 FBIP 8.1 的根目录 / hotwebs/fbip"
        );
    };

    match edition_hint {
        "8.1" => resolve_81(&input_path, app_dir),
        "8.2" => resolve_82(&input_path, app_dir),
        _ => {
            let is_81 = is_81_layout(&app_dir);
            if is_81 {
                resolve_81(&input_path, app_dir)
            } else {
                resolve_82(&input_path, app_dir)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_edition_hint() {
        assert_eq!("8.1", Edition::Fbip81.as_str());
        assert_eq!("8.2", Edition::Fbip82.as_str());
    }
}
