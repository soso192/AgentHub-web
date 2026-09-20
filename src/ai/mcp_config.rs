// ══════════════════════════════════════════════════════════════
//  cc-web 自己持有的 MCP 配置（供 claude 的 --mcp-config 使用）
//
//  为什么需要：cc-web 要部署到多台机器，而这些机器上的 stdio MCP
//  （如 java_compiler_mcp）必须写本机绝对路径，没法整份复制。与其在
//  每台机器上手工维护 ~/.claude.json 的 user 级 mcpServers（散落在机器
//  状态里，漏配一台就静默失效，还依赖跑 cc-web 的是哪个 Windows 用户），
//  不如让 cc-web 自己带一份：
//
//    读配置 → 把相对路径按「正在运行的 cc-web.exe 所在目录」解析成绝对
//    路径 → 落一份到 ~/.cc-web/mcp-servers.resolved.json → 把该路径交给
//    claude 的 --mcp-config。
//
//  这样一份配置在所有机器通用（前提是 MCP 的可执行文件与 cc-web.exe 保持
//  相同的相对布局），改动配置 = 改一个部署文件，而不是改机器状态。
//
//  文件格式与 Claude Code `--mcp-config` 的原生格式完全一致
//  （{"mcpServers": {...}}），这里只做「路径解析」一件事，不发明新 schema。
//  生效时机是 cc-web 启动时（ClaudeAssistant::new() 调用一次），改配置要重启
//  —— 与 patch_servers.json 的「不做热加载」口径一致。
//
//  任何一步失败都返回 None（调用方就不传 --mcp-config），并记日志，绝不 panic：
//  配置坏了不能让 cc-web 起不来。解析失败返回空的口径照 src/api/patch_config.rs。
// ══════════════════════════════════════════════════════════════

use std::path::{Component, Path, PathBuf};

/// 覆盖配置文件路径的环境变量（沿用本项目 CLAUDE_CMD / CODEX_CMD / PI_CMD 的习惯）
const ENV_OVERRIDE: &str = "CC_WEB_MCP_CONFIG";
/// 默认配置文件，放在 ~/.cc-web/ 下（沿用 main.rs 的目录约定）
const DEFAULT_FILE: &str = "mcp-servers.json";
/// 解析后的输出文件名，与源文件放同一目录，便于对照
const RESOLVED_FILE: &str = "mcp-servers.resolved.json";
const DATA_DIR: &str = ".cc-web";

/// 读 cc-web 的 MCP 配置，解析相对路径并落盘，返回给 `--mcp-config` 用的绝对路径。
///
/// 未配置 / JSON 坏了 / 拿不到 exe 目录 / 落盘失败，一律返回 None。
pub fn resolve_mcp_config() -> Option<PathBuf> {
    let source = match source_path() {
        Some(path) => path,
        None => {
            log::warn!("[mcp] 定位不到 MCP 配置文件（home 目录不可用），本次不追加 --mcp-config");
            return None;
        }
    };

    let content = match std::fs::read_to_string(&source) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            log::info!(
                "[mcp] 未配置 MCP（{} 不存在），本次不追加 --mcp-config",
                source.display()
            );
            return None;
        }
        Err(error) => {
            log::warn!("[mcp] 读不了 {}: {}", source.display(), error);
            return None;
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "[mcp] {} 不是合法 JSON，本次不追加 --mcp-config: {}",
                source.display(),
                error
            );
            return None;
        }
    };

    let servers = match parsed.get("mcpServers").and_then(|value| value.as_object()) {
        Some(map) if !map.is_empty() => map,
        _ => {
            log::warn!(
                "[mcp] {} 里没有非空的 mcpServers，本次不追加 --mcp-config",
                source.display()
            );
            return None;
        }
    };

    let base = match base_dir() {
        Some(dir) => dir,
        None => {
            log::warn!("[mcp] 拿不到 cc-web 所在目录，无法解析相对路径，本次不追加 --mcp-config");
            return None;
        }
    };

    let mut resolved = serde_json::Map::with_capacity(servers.len());
    for (name, server) in servers {
        resolved.insert(name.clone(), resolve_server(server, &base));
    }

    let path = match materialize(&resolved) {
        Some(path) => path,
        None => {
            log::warn!("[mcp] 解析后的配置写不出去，本次不追加 --mcp-config");
            return None;
        }
    };

    log::info!(
        "[mcp] 已加载 {} 个 MCP server（{}）→ {}",
        resolved.len(),
        source.display(),
        path.display()
    );
    Some(path)
}

/// 配置文件来源：环境变量优先，否则 `~/.cc-web/mcp-servers.json`
fn source_path() -> Option<PathBuf> {
    if let Ok(value) = std::env::var(ENV_OVERRIDE) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    Some(dirs::home_dir()?.join(DATA_DIR).join(DEFAULT_FILE))
}

/// 相对路径的解析基准：正在运行的 exe 所在目录，退化到当前工作目录
fn base_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return Some(dir.to_path_buf());
        }
    }
    std::env::current_dir().ok()
}

/// 解析单个 server 里的路径类字段，其余字段原样透传
fn resolve_server(server: &serde_json::Value, base: &Path) -> serde_json::Value {
    let mut out = server.clone();
    let Some(obj) = out.as_object_mut() else {
        return out;
    };

    for key in ["command", "cwd"] {
        let Some(value) = obj.get(key).and_then(|v| v.as_str()) else {
            continue;
        };
        let resolved = resolve_path_like(value, base);
        if resolved != value {
            if !Path::new(&resolved).exists() {
                log::warn!("[mcp] {} 指向的 {} 不存在: {}", key, value, resolved);
            }
            obj.insert(key.to_string(), serde_json::Value::String(resolved));
        }
    }

    if let Some(args) = obj.get_mut("args").and_then(|v| v.as_array_mut()) {
        for arg in args.iter_mut() {
            if let Some(value) = arg.as_str() {
                let resolved = resolve_path_like(value, base);
                if resolved != value {
                    *arg = serde_json::Value::String(resolved);
                }
            }
        }
    }

    out
}

/// 把「相对 cc-web.exe 目录」的写法解析成绝对路径。
///
/// 只有**看起来像路径**的值才解析，判据见 `looks_like_path`；其余原样保留。
fn resolve_path_like(value: &str, base: &Path) -> String {
    let path = Path::new(value);
    if path.is_absolute() {
        return value.to_string();
    }
    if !looks_like_path(value) {
        return value.to_string();
    }
    normalize(&base.join(path)).to_string_lossy().to_string()
}

/// 这个值该不该当成「相对 exe 目录的路径」？
///
/// 解析：
/// - 以 `-` 开头 → 不是（`--verbose`、`-Dfile=x` 这类选项原样透传）
/// - 以 `.` 开头，或含路径分隔符 → 是（`./a`、`..\a`、`tools\a.exe`）
/// - 裸文件名带扩展名 → 是（`java_compiler_mcp.exe` 当成 exe 同目录下的文件）
///
/// 不解析：
/// - 裸命令名没有扩展名（`npx`、`node`、`python`）→ 走 PATH 查找，
///   拼成 `<exe目录>\npx` 会直接坏掉
fn looks_like_path(value: &str) -> bool {
    if value.starts_with('-') {
        return false;
    }
    if value.starts_with('.') || value.contains('/') || value.contains('\\') {
        return true;
    }
    let name = value.rsplit(['/', '\\']).next().unwrap_or(value);
    matches!(name.rsplit_once('.'), Some((stem, ext)) if !stem.is_empty() && !ext.is_empty())
}

/// 词法上消掉 `.` 与 `..`。
///
/// 不用 canonicalize：它会要求路径真实存在，而配置指向的文件在别的机器上可能
/// 还没部署好，那时我们仍要给出一个可读的绝对路径（并已在上面 warn 过）。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let mut depth = 0usize; // 已压入的普通组件数，用来判断能不能 pop
    let mut rooted = false; // 见过 Prefix/RootDir，即绝对路径

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if depth > 0 {
                    out.pop();
                    depth -= 1;
                } else if !rooted {
                    // 相对路径开头的 .. 有意义，必须留着（否则会把绝对路径拼错）
                    out.push("..");
                }
                // 绝对路径越过根：丢掉，钳在根上（D:\a\..\..\..\b → D:\b）
            }
            Component::Prefix(_) | Component::RootDir => {
                out.push(component.as_os_str());
                rooted = true;
            }
            Component::Normal(_) => {
                out.push(component.as_os_str());
                depth += 1;
            }
        }
    }

    out
}

/// 把解析后的配置写进 `~/.cc-web/mcp-servers.resolved.json`
fn materialize(servers: &serde_json::Map<String, serde_json::Value>) -> Option<PathBuf> {
    let dir = dirs::home_dir()?.join(DATA_DIR);
    if let Err(error) = std::fs::create_dir_all(&dir) {
        log::warn!("[mcp] 建不了 {}: {}", dir.display(), error);
        return None;
    }

    let doc = serde_json::json!({ "mcpServers": servers });
    let text = match serde_json::to_string_pretty(&doc) {
        Ok(text) => text,
        Err(error) => {
            log::warn!("[mcp] 序列化解析后的配置失败: {}", error);
            return None;
        }
    };

    let path = dir.join(RESOLVED_FILE);
    if let Err(error) = std::fs::write(&path, text) {
        log::warn!("[mcp] 写不了 {}: {}", path.display(), error);
        return None;
    }

    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> PathBuf {
        PathBuf::from(r"D:\project\cc\target\release")
    }

    #[test]
    fn resolves_relative_ones() {
        let cases = [
            (r".\java_compiler_mcp.exe", r"D:\project\cc\target\release\java_compiler_mcp.exe"),
            ("./java_compiler_mcp.exe", r"D:\project\cc\target\release\java_compiler_mcp.exe"),
            (r"..\..\..\mcpadd\.venv\Scripts\python.exe", r"D:\project\mcpadd\.venv\Scripts\python.exe"),
            ("../../../mcpadd/java_compiler_mcp.py", r"D:\project\mcpadd\java_compiler_mcp.py"),
            (r"tools\a.exe", r"D:\project\cc\target\release\tools\a.exe"),
            // 裸文件名带扩展名 → 当成 exe 同目录下的文件（npx 这种没扩展名的走 PATH，见下个测试）
            ("java_compiler_mcp.exe", r"D:\project\cc\target\release\java_compiler_mcp.exe"),
        ];
        for (input, expected) in cases {
            assert_eq!(resolve_path_like(input, &base()), expected, "input={}", input);
        }
    }

    #[test]
    fn keeps_absolute_and_bare_names() {
        let cases = [
            // 已经是绝对路径 → 原样
            (r"D:\tools\java_compiler_mcp.exe", r"D:\tools\java_compiler_mcp.exe"),
            // 裸命令名（无扩展名）→ 走 PATH，不能被拼成 <base>\npx
            ("npx", "npx"),
            ("python", "python"),
            // 选项形式的 arg → 原样
            ("--flag", "--flag"),
        ];
        for (input, expected) in cases {
            assert_eq!(resolve_path_like(input, &base()), expected, "input={}", input);
        }
    }

    #[test]
    fn normalizes_parent_dirs_without_touching_fs() {
        assert_eq!(
            normalize(Path::new(r"D:\a\b\c\..\..\d\e")),
            PathBuf::from(r"D:\a\d\e")
        );
        // 绝对路径越过根 → 钳在根上，不吐 ..
        assert_eq!(normalize(Path::new(r"D:\a\..\..\..\b")), PathBuf::from(r"D:\b"));
    }

    #[test]
    fn only_path_like_fields_are_resolved() {
        let server = serde_json::json!({
            "type": "stdio",
            "command": "java_compiler_mcp.exe",
            "args": ["../mcpadd/java_compiler_mcp.py", "--verbose"],
            "cwd": "../work"
        });
        let out = resolve_server(&server, &base());
        assert_eq!(
            out["command"],
            serde_json::Value::String(r"D:\project\cc\target\release\java_compiler_mcp.exe".to_string())
        );
        assert_eq!(
            out["args"][0],
            serde_json::Value::String(r"D:\project\cc\target\mcpadd\java_compiler_mcp.py".to_string())
        );
        // 非路径的 arg 原样
        assert_eq!(out["args"][1], serde_json::Value::String("--verbose".to_string()));
        assert_eq!(out["cwd"], serde_json::Value::String(r"D:\project\cc\target\work".to_string()));
    }

    #[test]
    fn http_servers_pass_through_untouched() {
        let server = serde_json::json!({
            "type": "http",
            "url": "http://example.com/mcp",
            "headers": { "Authorization": "Bearer x" }
        });
        assert_eq!(resolve_server(&server, &base()), server);
    }
}
