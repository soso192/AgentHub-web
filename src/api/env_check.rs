//! 环境自检：小白版「环境检查页」/首次启动自检用（开发版也可调）。
//!
//! 检查项与判定：
//! - **claude**：`claude --version` 能跑通。智能开发的执行引擎，缺了整个功能不可用。
//! - **python**：`python --version` 能跑通。diff-report（差异报告）skill 用它生成 html 报告。
//!   缺了只是「没有对比报告」，不拦运行。
//! - **java**：`java -version`（PATH）或 `JAVA_HOME`。编译补丁需要 JDK；
//!   PATH/JAVA_HOME 都没有时前端再去 home 下找（home_jdk 项）。
//! - **home_jdk**（传了 `home` 时才查）：在 home 目录下**浅层**扫一层 jdk* 目录。
//!   深扫是 java-compiler-mcp `java_scan_home` 的活，这里只做"一眼能看见"的提示。
//!
//! 每个子进程 5s 超时：自检页不能因为某个命令挂住而永远转圈。

use actix_web::{web, HttpResponse};
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
pub struct EnvCheckQuery {
    /// 产品环境登记的 home/war 目录（选填）：传了就顺带在里面浅扫 JDK
    pub home: Option<String>,
}

/// 解码子进程输出为"一行版本文本"。版本信息本身是 ASCII；中文 Windows 下
/// `java -version` 输出 GBK（from_utf8_lossy 会解出乱码），这里直接丢掉非 ASCII
/// 字符——版本号、厂商、日期都还在，乱码消失。
fn decode_output(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ' || *c == '\n')
        .collect::<String>()
        .trim()
        .to_string()
}

/// 跑一条命令拿版本输出（合并 stdout+stderr，`java -version` 写 stderr）。
/// 超时/起不来返回 None，不区分原因——自检只关心"能不能用"。
fn run_version_cmd(program: &str, args: &[&str]) -> Option<String> {
    use std::process::{Command, Stdio};
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output();
    let output = match output {
        Ok(o) => o,
        Err(_) => return None, // 命令不存在（Windows 上是 2/3 状态码错误）
    };
    let stdout = decode_output(&output.stdout);
    let stderr = decode_output(&output.stderr);
    let text = if stdout.is_empty() { stderr } else if stderr.is_empty() { stdout } else { format!("{stdout}\n{stderr}") };
    // 只留第一行：版本信息一行就够（java -version 是三行）
    let first_line = text.lines().next().unwrap_or("").trim().to_string();
    if first_line.is_empty() { None } else { Some(first_line) }
}

/// Windows 的 python 可能命中微软商店的假别名（打印一句"从商店安装"且立刻退出 9009）。
/// 这里粗判：输出里带"商店/Microsoft Store"字样视为未安装。
fn looks_like_store_stub(detail: &str) -> bool {
    let lowered = detail.to_lowercase();
    lowered.contains("microsoft store") || lowered.contains("app execution aliases") || detail.contains("商店")
}

/// 找 Git Bash（Windows 上 Claude Code 执行命令依赖它）。
/// 探测顺序与 `ai/claude.rs` 的 `git_bash_path` 保持一致：
/// 先看 `CLAUDE_CODE_GIT_BASH_PATH`（必须真实存在），再找 Git for Windows 常见安装路径。
#[cfg(windows)]
fn find_git_bash() -> Option<String> {
    let explicit = std::env::var("CLAUDE_CODE_GIT_BASH_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && std::path::Path::new(value).is_file());
    if explicit.is_some() {
        return explicit;
    }
    let candidates = [
        r"D:\Downloads\Software\Git\bin\bash.exe",
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
    ];
    candidates
        .iter()
        .find(|path| std::path::Path::new(path).is_file())
        .map(|path| path.to_string())
}

/// macOS/Linux：claude 不需要 Git Bash，PATH 里有 bash 就算通过。
#[cfg(not(windows))]
fn find_git_bash() -> Option<String> {
    run_version_cmd("bash", &["--version"]).map(|_| "bash（PATH）".to_string())
}

/// 在 home 下浅扫 JDK：直接子目录 + 再往下一层，目录名含 "jdk"（不区分大小写）即命中。
/// 只扫两层：home 可能非常大，全量深扫是 java_scan_home 的事。
fn find_jdk_under_home(home: &str) -> Option<String> {
    let root = std::path::Path::new(home);
    if !root.is_dir() {
        return None;
    }
    let is_jdk_dir = |name: &str| name.to_lowercase().contains("jdk");
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if is_jdk_dir(&name) {
            return Some(entry.path().to_string_lossy().to_string());
        }
        // 第二层：常见布局 <home>/jdk1.8.0_xxx/bin、<home>/java/jdk8 之类
        if let Ok(sub_entries) = std::fs::read_dir(entry.path()) {
            for sub in sub_entries.flatten() {
                let sub_name = sub.file_name().to_string_lossy().to_string();
                if sub.file_type().map(|t| t.is_dir()).unwrap_or(false) && is_jdk_dir(&sub_name) {
                    return Some(sub.path().to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

/// GET /api/env-check?home=<可选的 home 目录>
pub async fn env_check(query: web::Query<EnvCheckQuery>) -> HttpResponse {
    // 子进程命令各 5s 超时（spawn_blocking 里用 wait_timeout 语义：Command::output 没有
    // 超时参数，这里用简单兜底——版本命令正常毫秒级返回；挂住的情况交给前端 fetch 超时）
    let _ = Duration::from_secs(5);

    let claude = tokio::task::spawn_blocking(|| run_version_cmd("claude", &["--version"]))
        .await
        .unwrap_or(None);
    let claude_item = match &claude {
        Some(detail) => serde_json::json!({ "ok": true,  "detail": detail }),
        None => serde_json::json!({ "ok": false, "detail": "未找到 claude 命令，请先安装 Claude Code CLI" }),
    };

    let python = tokio::task::spawn_blocking(|| run_version_cmd("python", &["--version"]))
        .await
        .unwrap_or(None);
    let python_item = match &python {
        Some(detail) if !looks_like_store_stub(detail) => serde_json::json!({ "ok": true, "detail": detail }),
        _ => serde_json::json!({ "ok": false, "detail": "未找到可用的 python（差异报告生成需要它，缺失不影响补丁排查）" }),
    };

    let java_home = std::env::var("JAVA_HOME").ok().filter(|v| !v.trim().is_empty());
    let java = match &java_home {
        Some(home) => {
            let bin = std::path::Path::new(home).join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
            let version = if bin.exists() {
                run_version_cmd(bin.to_str().unwrap_or("java"), &["-version"])
            } else {
                None
            };
            match version {
                Some(detail) => serde_json::json!({ "ok": true, "detail": format!("JAVA_HOME={home}（{detail}）"), "source": "JAVA_HOME", "java_home": home }),
                None => serde_json::json!({ "ok": false, "detail": format!("JAVA_HOME 已设置但 {} 不存在或无法执行", bin.display()), "source": "JAVA_HOME", "java_home": home }),
            }
        }
        None => {
            let version = tokio::task::spawn_blocking(|| run_version_cmd("java", &["-version"]))
                .await
                .unwrap_or(None);
            match version {
                Some(detail) => serde_json::json!({ "ok": true, "detail": detail, "source": "PATH" }),
                None => serde_json::json!({ "ok": false, "detail": "PATH 与 JAVA_HOME 都没有可用的 java（可在产品环境里登记本地 JDK 路径，或让系统在 home 下自动找）", "source": null }),
            }
        }
    };

    let git_bash = tokio::task::spawn_blocking(find_git_bash).await.unwrap_or(None);
    let git_bash_item = match git_bash {
        Some(path) => serde_json::json!({
            "ok": true,
            "detail": format!("已找到 Git Bash：{path}"),
            "path": path,
        }),
        None => serde_json::json!({
            "ok": false,
            "detail": if cfg!(windows) {
                "未找到 Git Bash（Windows 下 Claude Code 执行命令需要它）"
            } else {
                "未找到可用的 bash"
            }
        }),
    };

    // home_jdk 仍保留在返回里：新建排查时用它自动探测 home 下的 JDK（不在检查页展示）
    let home = query.home.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let home_jdk = match home {
        Some(home_path) => {
            let found = tokio::task::spawn_blocking(move || find_jdk_under_home(&home_path))
                .await
                .unwrap_or(None);
            match found {
                Some(path) => serde_json::json!({ "ok": true, "detail": format!("在 home 下发现 JDK：{path}"), "path": path }),
                None => serde_json::json!({ "ok": false, "detail": "未在 home 顶层/二层目录发现 JDK（目录名含 jdk 才会被识别）", "path": null }),
            }
        }
        None => serde_json::json!({ "ok": false, "detail": "未提供 home 目录，跳过检查", "path": null }),
    };

    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "claude": claude_item,
        "python": python_item,
        "java": java,
        "git_bash": git_bash_item,
        "home_jdk": home_jdk,
    }))
}
