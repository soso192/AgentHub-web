use anyhow::{Context, Result};
use chrono::{FixedOffset, Utc};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

fn beijing_now() -> chrono::DateTime<FixedOffset> {
    // 统一使用北京时间（UTC+8），不依赖服务器本地时区。
    let offset = FixedOffset::east_opt(8 * 3600).expect("valid +08:00 offset");
    Utc::now().with_timezone(&offset)
}

pub fn now_text() -> String {
    beijing_now().format("%Y-%m-%d %H:%M:%S").to_string()
}

pub fn new_batch_id() -> String {
    beijing_now().format("%Y%m%d-%H%M%S-%3f").to_string()
}

pub fn path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// 只接受相对路径，拒绝绝对路径、盘符、`..` 和 NUL。
pub fn normalize_rel(raw: &str) -> Result<String> {
    if raw.contains('\0') {
        anyhow::bail!("路径包含 NUL 字符");
    }
    let value = raw.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in value.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            anyhow::bail!("路径包含 ..：{raw}");
        }
        if part.contains(':') {
            anyhow::bail!("路径包含盘符或非法字符：{raw}");
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

pub fn trim_slash(value: &str) -> String {
    value.trim().trim_matches('/').replace('\\', "/")
}

pub fn ensure_dir_trailing(value: &str) -> String {
    let mut v = trim_slash(value);
    if !v.is_empty() && !v.ends_with('/') {
        v.push('/');
    }
    v
}

/// 词法检查目标是否位于 root 下；目标可以尚不存在。
pub fn is_within(root: &Path, target: &Path) -> bool {
    let root_components: Vec<Component> = root.components().collect();
    let target_components: Vec<Component> = target.components().collect();
    if target_components.len() < root_components.len() {
        return false;
    }
    target_components
        .iter()
        .zip(root_components.iter())
        .all(|(a, b)| a == b)
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        fs::File::open(path).with_context(|| format!("打开文件失败：{}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow::anyhow!("无效路径"))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|v| v.to_str()).unwrap_or("data")
    ));
    let text = serde_json::to_vec_pretty(value)?;
    fs::write(&tmp, text)?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let text = fs::read_to_string(path).with_context(|| format!("读取失败：{}", path.display()))?;
    Ok(serde_json::from_str(&text)?)
}

pub fn remove_empty_parents(mut dir: PathBuf, stop: &Path) {
    while dir.starts_with(stop) && dir != stop {
        match fs::read_dir(&dir) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    break;
                }
                if fs::remove_dir(&dir).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
        let Some(parent) = dir.parent() else { break };
        dir = parent.to_path_buf();
    }
}

pub struct LogFile {
    path: PathBuf,
    lines: Vec<String>,
}

impl LogFile {
    pub fn create(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, "")?;
        Ok(Self {
            path,
            lines: Vec::new(),
        })
    }

    pub fn line(&mut self, text: impl Into<String>) {
        let text = format!("[{}] {}", now_text(), text.into());
        self.lines.push(text.clone());
        use std::io::Write;
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = writeln!(file, "{text}");
        }
        if self.lines.len() > 400 {
            self.lines.remove(0);
        }
    }

    pub fn tail(&self, count: usize) -> Vec<String> {
        let start = self.lines.len().saturating_sub(count);
        self.lines[start..].to_vec()
    }
}

/// 服务身份：同一部署目录视为同一个服务（Windows 下大小写不敏感）。
pub fn service_key(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/').to_string();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}
