use super::model::Edition;
use super::util::{ensure_dir_trailing, is_within, normalize_rel};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct CopyRule {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug)]
pub struct Mapper {
    pub edition: Edition,
    pub target_root: PathBuf,
    pub app_root: PathBuf,
    pub rules: Vec<CopyRule>,
}

#[derive(Clone, Debug)]
pub enum Mapped {
    Deploy {
        rel: String,
        abs: PathBuf,
        warning: Option<String>,
    },
    Ignore {
        reason: String,
    },
    Error {
        message: String,
    },
}

const META_ROOT_FILES: &[&str] = &[
    "installpatch.xml",
    "packmetadata.xml",
    "readme.txt",
    "readme.md",
];

fn is_meta_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("__macosx/") || lower.contains("/__macosx/") {
        return true;
    }
    if lower
        .split('/')
        .any(|part| part == ".git" || part == ".svn")
    {
        return true;
    }
    let file_name = lower.rsplit('/').next().unwrap_or(&lower);
    if file_name == ".ds_store" || file_name == "thumbs.db" || file_name == "desktop.ini" {
        return true;
    }
    if lower.ends_with(".bak")
        || lower.ends_with(".orig")
        || lower.ends_with(".rej")
        || lower.ends_with('~')
    {
        return true;
    }
    if META_ROOT_FILES.contains(&lower.as_str()) {
        return true;
    }
    if let Some(rest) = lower.strip_prefix("replacement/") {
        if !rest.contains('/') && META_ROOT_FILES.contains(&rest) {
            return true;
        }
    }
    false
}

const FBIP82_APP_ROOTS: &[&str] = &[
    "WEB-INF",
    "modules",
    "resources",
    "external",
    "langlib",
    "lib",
    "META-INF",
    "ierp",
    "jsonconfig",
    "pfxx",
    "uapadp",
    "uclient",
    "messages",
    "conf",
    "bin",
];

fn is_fbip82_app_root(part: &str) -> bool {
    FBIP82_APP_ROOTS.contains(&part)
}

/// FBIP 8.2 补丁经常带一层任意名称的补丁目录，例如：
///   财务清单198-20260915/fbip/WEB-INF/...
///   财务清单198-20260915/WEB-INF/...
///   财务清单198-20260915/modules/...
/// 这里只对 8.2 生效：找到第一个合法应用根标记后，丢弃它前面的包装目录。
/// 8.1 保持原有规则不变。
fn strip_fbip82_wrapper(path: &str) -> Result<String> {
    let mut current = path;
    loop {
        if let Some(rest) = current.strip_prefix("replacement/") {
            current = rest;
            continue;
        }
        let parts: Vec<&str> = current.split('/').filter(|part| !part.is_empty()).collect();
        for (index, part) in parts.iter().enumerate() {
            if *part == "fbip" && index + 1 < parts.len() && is_fbip82_app_root(parts[index + 1]) {
                return Ok(parts[index + 1..].join("/"));
            }
            if *part == "hotwebs" || is_fbip82_app_root(part) {
                return Ok(parts[index..].join("/"));
            }
        }
        bail!("补丁结构不符合 FBIP 8.2：未找到 WEB-INF/modules/resources 等目录");
    }
}

fn allowed_roots(edition: Edition) -> &'static [&'static str] {
    match edition {
        Edition::Fbip81 => &[
            "WEB-INF",
            "modules",
            "resources",
            "external",
            "hotwebs",
            "langlib",
            "lib",
            "META-INF",
            "ierp",
            "jsonconfig",
            "pfxx",
            "uapadp",
            "uclient",
            "messages",
            "conf",
            "bin",
            "webapps",
        ],
        Edition::Fbip82 => &[
            "WEB-INF",
            "modules",
            "resources",
            "external",
            "langlib",
            "lib",
            "META-INF",
            "ierp",
            "jsonconfig",
            "pfxx",
            "uapadp",
            "uclient",
            "messages",
            "conf",
            "bin",
        ],
    }
}

impl Mapper {
    pub fn new(
        edition: Edition,
        target_root: PathBuf,
        app_root: PathBuf,
        rules: Vec<CopyRule>,
    ) -> Self {
        Self {
            edition,
            target_root,
            app_root,
            rules,
        }
    }

    fn root(&self) -> &Path {
        match self.edition {
            Edition::Fbip81 => &self.target_root,
            Edition::Fbip82 => &self.app_root,
        }
    }

    pub fn map(&self, raw_path: &str) -> Mapped {
        let raw = raw_path.replace('\\', "/");
        let raw = raw.trim_start_matches('/');
        if raw.is_empty() || raw.ends_with('/') {
            return Mapped::Ignore {
                reason: "目录条目".to_string(),
            };
        }
        if is_meta_path(raw) {
            return Mapped::Ignore {
                reason: "补丁元数据/系统文件".to_string(),
            };
        }

        let rel = if let Some(rel) = self.apply_rules(raw) {
            rel
        } else {
            match self.fallback(raw) {
                Ok(rel) => rel,
                Err(error) => {
                    return Mapped::Error {
                        message: error.to_string(),
                    }
                }
            }
        };

        let rel = match self.finish_rel(rel) {
            Ok(value) => value,
            Err(error) => {
                return Mapped::Error {
                    message: error.to_string(),
                }
            }
        };
        if rel.is_empty() {
            return Mapped::Ignore {
                reason: "映射后路径为空".to_string(),
            };
        }

        let root = self.root();
        let abs = root.join(&rel);
        if !is_within(root, &abs) {
            return Mapped::Error {
                message: format!("目标路径越界：{}", abs.display()),
            };
        }

        let first = rel.split('/').next().unwrap_or("");
        let warning = if allowed_roots(self.edition).contains(&first) {
            None
        } else {
            Some(format!("目标目录 {first} 未在 FBIP 常用目录中，请确认"))
        };

        Mapped::Deploy { rel, abs, warning }
    }

    fn apply_rules(&self, raw: &str) -> Option<String> {
        for rule in &self.rules {
            let from = ensure_dir_trailing(&rule.from);
            if from.is_empty() || raw == from.trim_end_matches('/') {
                continue;
            }
            if raw.starts_with(&from) {
                let rest = &raw[from.len()..];
                let to = ensure_dir_trailing(&rule.to);
                return Some(format!("{to}{rest}"));
            }
        }
        None
    }

    fn fallback(&self, raw: &str) -> Result<String> {
        let path = raw.strip_prefix("replacement/").unwrap_or(raw);
        match self.edition {
            Edition::Fbip81 => {
                // 8.1 的 installpatch.xml 语义：modules/resources/hotwebs 等相对 FBIP 根目录。
                Ok(path.to_string())
            }
            Edition::Fbip82 => {
                let path = strip_fbip82_wrapper(path)?;
                if path == "hotwebs" || path == "hotwebs/fbip" {
                    return Ok(String::new());
                }
                if let Some(rest) = path.strip_prefix("hotwebs/fbip/") {
                    return Ok(rest.to_string());
                }
                if path.starts_with("hotwebs/") {
                    bail!(
                        "补丁包含其他 hotwebs 应用（{}），当前目标只允许 fbip 应用",
                        path
                    );
                }
                Ok(path)
            }
        }
    }

    fn finish_rel(&self, rel: String) -> Result<String> {
        let mut rel = normalize_rel(&rel)?;
        if self.edition == Edition::Fbip82 {
            if rel == "hotwebs/fbip" {
                rel.clear();
            } else if let Some(rest) = rel.strip_prefix("hotwebs/fbip/") {
                rel = rest.to_string();
            } else if rel.starts_with("hotwebs/") {
                bail!("补丁包含其他 hotwebs 应用（{rel}），当前目标只允许 fbip 应用");
            }
        }
        Ok(rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapper82() -> Mapper {
        Mapper::new(
            Edition::Fbip82,
            PathBuf::from("/fbip"),
            PathBuf::from("/fbip"),
            vec![],
        )
    }

    fn mapper81() -> Mapper {
        Mapper::new(
            Edition::Fbip81,
            PathBuf::from("/bip"),
            PathBuf::from("/bip/hotwebs/fbip"),
            vec![],
        )
    }

    #[test]
    fn fbip82_web_inf() {
        let mapped = mapper82().map("replacement/WEB-INF/classes/A.class");
        match mapped {
            Mapped::Deploy { rel, .. } => assert_eq!(rel, "WEB-INF/classes/A.class"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn fbip82_folds_hotwebs_fbip() {
        let mapped = mapper82().map("replacement/hotwebs/fbip/WEB-INF/classes/A.class");
        match mapped {
            Mapped::Deploy { rel, .. } => assert_eq!(rel, "WEB-INF/classes/A.class"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn fbip82_rejects_other_hotwebs() {
        let mapped = mapper82().map("replacement/hotwebs/other/WEB-INF/classes/A.class");
        assert!(matches!(mapped, Mapped::Error { .. }));
    }

    #[test]
    fn fbip81_keeps_hotwebs() {
        let mapped = mapper81().map("replacement/hotwebs/fbip/WEB-INF/classes/A.class");
        match mapped {
            Mapped::Deploy { rel, .. } => assert_eq!(rel, "hotwebs/fbip/WEB-INF/classes/A.class"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn source_is_deployed_for_conflict_visibility() {
        match mapper82().map("replacement/WEB-INF/classes/A.java") {
            Mapped::Deploy { rel, .. } => assert_eq!(rel, "WEB-INF/classes/A.java"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn fbip82_strips_arbitrary_patch_wrapper() {
        for (source, expected) in [
            (
                "财务清单198-20260915/WEB-INF/classes/A.class",
                "WEB-INF/classes/A.class",
            ),
            (
                "财务清单198-20260915/fbip/WEB-INF/classes/A.class",
                "WEB-INF/classes/A.class",
            ),
            (
                "财务清单198-20260915/modules/foo/bar.txt",
                "modules/foo/bar.txt",
            ),
            (
                "财务清单198-20260915/fbip/modules/foo/bar.txt",
                "modules/foo/bar.txt",
            ),
            (
                "财务清单198-20260915/resources/foo.txt",
                "resources/foo.txt",
            ),
            (
                "财务清单198-20260915/fbip/resources/foo.txt",
                "resources/foo.txt",
            ),
            (
                "财务清单198-20260915/replacement/WEB-INF/classes/A.class",
                "WEB-INF/classes/A.class",
            ),
        ] {
            match mapper82().map(source) {
                Mapped::Deploy { rel, .. } => assert_eq!(rel, expected, "source: {source}"),
                other => panic!("unexpected {source}: {other:?}"),
            }
        }
    }

    #[test]
    fn fbip82_rejects_unknown_wrapper_without_root() {
        assert!(matches!(
            mapper82().map("财务清单198-20260915/unknown/file.txt"),
            Mapped::Error { .. }
        ));
    }

    #[test]
    fn fbip81_rule_is_unchanged() {
        // 8.1 保持原有规则：不自动剥离任意补丁外层目录。
        match mapper81().map("财务清单198-20260915/modules/foo/bar.txt") {
            Mapped::Deploy { rel, .. } => {
                assert_eq!(rel, "财务清单198-20260915/modules/foo/bar.txt")
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn installpatch_rule_prefix() {
        let mapper = Mapper::new(
            Edition::Fbip82,
            PathBuf::from("/fbip"),
            PathBuf::from("/fbip"),
            vec![CopyRule {
                from: "/replacement/WEB-INF/".to_string(),
                to: "/WEB-INF/".to_string(),
            }],
        );
        match mapper.map("replacement/WEB-INF/classes/A.class") {
            Mapped::Deploy { rel, .. } => assert_eq!(rel, "WEB-INF/classes/A.class"),
            other => panic!("unexpected: {other:?}"),
        }
    }
}
