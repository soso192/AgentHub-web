//! 「获取新版本」：查最新版本 + 下载并自替换 cc-web.exe。
//!
//! 版本源是 patch_search（`GET /api/ccweb/latest?platform=…` + `/api/ccweb/download/<平台>`），发新版的人
//! 只需把 exe 放进服务器的发布目录（见 patch_search 的 config.yaml `ccweb_update.dir`）。
//!
//! **token 为什么由前端带**：cc-web 自己没有登录态（token 存在浏览器 localStorage 里），
//! 所以「检查/更新」都是前端带 token 调这里、后端代劳——与补丁导入、re-上报同一套模式。
//!
//! **替换方式按平台分两种**（见 install_staged）：
//! - Windows：运行中的 exe 被锁住，自己覆盖不了自己 → 下载到 `<原名>.new` → 校验 →
//!   写一个 .bat → 本进程退出 → 由脚本「备份 → 替换 → 重启」。脚本会把
//!   `CC_WEB_MCP_CONFIG` 设好再启动，等价于 start.bat 的那一步（否则 MCP 会静默不加载）。
//! - macOS 等其它平台：**不自动替换**，把新程序留在原地（加好可执行权限）并回报路径，
//!   由使用者手动替换后重启——mac 上一般从终端启动 cc-web，自动 nohup 重启会把进程
//!   从终端剥离（以后 Ctrl+C 停不掉），不如把这两步交回使用者。
//!
//! **「是不是新版」按版本号判断**：本机版本号（编译期 `Cargo.toml` 的 version）≠ 服务器上的
//! 「最新版本号」→ 提示更新。所以**发版前必须先改 Cargo.toml 的 version 再编译**，
//! 否则那批客户端会一直提示更新（服务器端发布时会扫二进制里有没有这个版本号来提醒）。
//! sha256 只用于下载完整性校验，不参与"要不要更新"的判断。
//! 最新版本里没有本平台的包时，服务器回 `has_package=false`，这里明确报"暂无本平台的安装包"。

use actix_web::{web, HttpResponse};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Deserialize)]
pub struct UpdateRequest {
    pub server_url: String,
    pub auth_token: String,
}

/// 本机平台键，与 patch_search 的发布槽位一一对应（见 app/routes/ccweb_update.py）：
/// windows / macos-arm64 / macos-x64，分别对应 CI 的三个产物。
/// 其它平台（Linux 等）没有发布槽位 —— 检查更新时明确说"不提供自动更新"，
/// 免得报一个看不懂的 HTTP 400。
#[cfg(target_os = "windows")]
const PLATFORM: &str = "windows";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const PLATFORM: &str = "macos-arm64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const PLATFORM: &str = "macos-x64";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const PLATFORM: &str = "";

/// 版本号哨兵：`CCWEB-VERSION:<版本>`。
///
/// 发布时服务器靠它确认"这个二进制确实是用这个版本号编译出来的"——直接去二进制里找裸版本号
/// 会误判（exe 里本来就有别的依赖的版本串，比如某个 crate 的 `1.0.1`），必须用这个唯一前缀。
/// 它随 `/api/version` 返回，保证不会被优化掉、确实留在二进制里。
pub const VERSION_MARKER: &str = concat!("CCWEB-VERSION:", env!("CARGO_PKG_VERSION"));

/// 本机 exe 路径（自更新的目标就是它）
fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|error| format!("取不到本程序路径：{error}"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| format!("读不了 {}：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer).map_err(|error| format!("读文件出错：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn exe_meta() -> Result<serde_json::Value, String> {
    let path = current_exe()?;
    let meta = std::fs::metadata(&path).map_err(|error| format!("读不了程序文件：{error}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        // 版本号哨兵：发布端拿它核对"这包是不是用这个版本号编译的"（见 patch_search 的 ccweb_update.py）。
        // 放在返回里同时保证它不会被编译器优化掉（确实留在二进制中）。
        "marker": VERSION_MARKER,
        "build_unix": env!("CCWEB_BUILD_UNIX"),
        // 本机平台键（windows / macos-arm64 / macos-x64；其它平台为空串）：
        // 前端拿它给"没有发布本平台版本"之类的提示带上平台名，用户不用猜
        "platform": PLATFORM,
        "exe_path": path.to_string_lossy(),
        "exe_mtime": mtime,
        "size": meta.len(),
        "sha256": sha256_file(&path)?,
    }))
}

/// GET /api/version —— 本机版本信息（本地信息，不需要补丁中心的凭据）
pub async fn version() -> HttpResponse {
    match exe_meta() {
        Ok(meta) => HttpResponse::Ok().json(serde_json::json!({ "success": true, "data": meta })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({ "success": false, "error": error })),
    }
}

/// 拉补丁中心上**本平台**的最新版本信息（blocking reqwest，调用方负责放进 spawn_blocking）。
///
/// `?platform=windows|macos-arm64|macos-x64` 只回该平台的扁平条目；
/// 老版本 patch_search 没有这个参数、回的是顶层扁平字段，字段名一致，所以照样能读。
fn fetch_remote(server_url: &str, auth_token: &str) -> Result<Option<serde_json::Value>, String> {
    if PLATFORM.is_empty() {
        return Err("该平台暂不提供 cc-web 自动更新，请手动替换程序".to_string());
    }
    let url = format!(
        "{}/api/ccweb/latest?platform={}",
        server_url.trim_end_matches('/'),
        PLATFORM
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("创建请求客户端失败：{error}"))?;
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .send()
        .map_err(|error| format!("连接补丁中心失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "补丁中心凭据失效，请重新登录后再试".to_string(),
            other => format!("查询最新版本失败（HTTP {other}）"),
        });
    }
    let payload: serde_json::Value = response.json().map_err(|error| format!("解析响应失败：{error}"))?;
    Ok(payload.get("data").filter(|value| !value.is_null()).cloned())
}

/// POST /api/update/check —— 比对本机与补丁中心的最新版本
pub async fn check(body: web::Json<UpdateRequest>) -> HttpResponse {
    if body.server_url.trim().is_empty() || body.auth_token.trim().is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({ "success": false, "error": "缺少补丁中心地址或凭据" }));
    }
    let server_url = body.server_url.clone();
    let auth_token = body.auth_token.clone();
    let result = tokio::task::spawn_blocking(move || {
        let local = exe_meta()?;
        let remote = fetch_remote(&server_url, &auth_token)?;
        Ok::<_, String>((local, remote))
    })
    .await;

    match result {
        Ok(Ok((local, remote))) => {
            // 判断口径：**本机版本号 ≠ 最新版本号 → 有新版本**。
            // 本机版本号来自编译期（Cargo.toml 的 version），所以发版前必须改版本号再编译。
            // 两种情况不算"可更新"：
            //   - 服务器还没发布过（remote = null）
            //   - 最新版本里没有本平台的包（has_package=false）→ 前端提示"暂无本平台安装包"，
            //     而不是给一个点下去 404 的"可更新"
            let available = match remote.as_ref() {
                None => false,
                Some(value) if value.get("has_package").and_then(|v| v.as_bool()) == Some(false) => false,
                Some(value) => {
                    value.get("version").and_then(|v| v.as_str()).unwrap_or("")
                        != local.get("version").and_then(|v| v.as_str()).unwrap_or("")
                }
            };
            HttpResponse::Ok().json(serde_json::json!({
                "success": true,
                "data": { "update_available": available, "local": local, "remote": remote }
            }))
        }
        Ok(Err(error)) => HttpResponse::Ok().json(serde_json::json!({ "success": false, "error": error })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({ "success": false, "error": format!("检查更新失败：{error}") })),
    }
}

/// 生成更新脚本：等本进程退出 → 备份 → 替换 → 重启（用完自删）
/// `exe_name` 是正在运行的程序名、`staged_name` 是下载好的新程序名（按它们替换，不写死）
fn write_updater_bat(dir: &Path, exe_name: &str, staged_name: &str, pid: u32) -> Result<PathBuf, String> {
    let bat = dir.join("update-cc-web.bat");
    let script = format!(
        "@echo off\r\n\
         rem cc-web 自更新脚本（由 cc-web 生成，执行完自删）\r\n\
         setlocal\r\n\
         set \"DIR=%~dp0\"\r\n\
         set \"PID={pid}\"\r\n\
         :wait\r\n\
         tasklist /FI \"PID eq %PID%\" 2>nul | find \"%PID%\" >nul\r\n\
         if not errorlevel 1 (\r\n\
         \x20 timeout /t 1 /nobreak >nul\r\n\
         \x20 goto wait\r\n\
         )\r\n\
         copy /y \"%DIR%{exe_name}\" \"%DIR%{exe_name}.bak\" >nul 2>&1\r\n\
         move /y \"%DIR%{staged_name}\" \"%DIR%{exe_name}\" >nul\r\n\
         if errorlevel 1 (\r\n\
         \x20 rem 替换失败：把备份还原回去，至少保证还能启动\r\n\
         \x20 copy /y \"%DIR%{exe_name}.bak\" \"%DIR%{exe_name}\" >nul 2>&1\r\n\
         )\r\n\
         rem 与 start.bat 同一步：不设它 MCP 会静默不加载\r\n\
         set \"CC_WEB_MCP_CONFIG=%DIR%mcp-servers.json\"\r\n\
         start \"\" \"%DIR%{exe_name}\"\r\n\
         del \"%~f0\"\r\n"
    );
    std::fs::write(&bat, script).map_err(|error| format!("写更新脚本失败：{error}"))?;
    Ok(bat)
}

/// 分离启动更新脚本（我们的进程马上要退出，它得活下来）
#[cfg(target_os = "windows")]
fn spawn_updater(bat: &Path, pid: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "/min", &bat.to_string_lossy().to_string(), &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|error| format!("启动更新脚本失败：{error}"))?;
    Ok(())
}

/// 把下载好的新程序「装上去」——两个平台口径不同：
///
/// - **Windows**：生成 .bat 交给脚本完成「等本进程退出 → 备份 → 替换 → 重启」，
///   然后本进程退出（运行中的 exe 被锁，自己覆盖不了自己）。
/// - **其它平台（macOS）**：**不自动替换**，把新程序留在原地（加好可执行权限）并回报
///   文件路径，由使用者手动替换后重启。理由：mac 上 cc-web 一般是从终端启动的，
///   自动 nohup 重启会把进程从终端剥离（以后 Ctrl+C 停不掉、得 pkill），
///   不如把"换文件 + 重启"这两步交回给使用者，行为可预测。
fn install_staged(staged: &Path, exe_name: &str, dir: &Path) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let staged_name = staged
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{exe_name}.new"));
        let bat = write_updater_bat(dir, exe_name, &staged_name, std::process::id())?;
        spawn_updater(&bat, std::process::id())?;
        // 给响应留出发送时间再退出（前端要靠这一行知道"更新成功，正在重启"）
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(800));
            log::info!("[update] 新版本已就绪，退出以让更新脚本替换并重启");
            std::process::exit(0);
        });
        Ok(serde_json::json!({
            "success": true,
            "message": "新版本已下载并校验通过，cc-web 正在重启",
        }))
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        // 加可执行权限：拿到就能直接跑，不用再 chmod
        if let Err(error) = std::fs::set_permissions(staged, std::fs::Permissions::from_mode(0o755)) {
            log::warn!("[update] 给新程序加可执行权限失败：{error}");
        }
        let _ = dir;
        Ok(serde_json::json!({
            "success": true,
            "manual": true,
            "path": staged.to_string_lossy(),
            "message": "新版本已下载并校验通过。本平台不自动替换，请手动替换后重启 cc-web",
        }))
    }
}

/// POST /api/update/apply —— 下载新版本并自替换（**流式响应**，一行一条回报进度）
///
///   `progress <已下载字节> <总字节>`  每 256KB 一条
///   `ok <结果 JSON>`                 已下载并校验通过，随后本进程会退出
///   `error <原因>`                   失败（HTTP 状态早就是 200，失败只能走这里）
///
/// 前端拿到 `ok` 就可以提示"正在重启"，之后连接会断——那是本进程退出了。
pub async fn apply(body: web::Json<UpdateRequest>) -> HttpResponse {
    static UPDATING: AtomicBool = AtomicBool::new(false);

    if body.server_url.trim().is_empty() || body.auth_token.trim().is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({ "success": false, "error": "缺少补丁中心地址或凭据" }));
    }
    if UPDATING.swap(true, Ordering::SeqCst) {
        return HttpResponse::Conflict().json(serde_json::json!({ "success": false, "error": "更新正在进行中" }));
    }

    let server_url = body.server_url.clone();
    let auth_token = body.auth_token.clone();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    tokio::task::spawn_blocking(move || {
        let result = apply_blocking(&server_url, &auth_token, &tx);
        let line = match result {
            Ok(payload) => format!("ok {}\n", payload),
            Err(error) => format!("error {}\n", error.replace(['\n', '\r'], " ")),
        };
        let _ = tx.blocking_send(line);
        // 失败时别把守卫一直锁着；成功时进程马上就退出了，无所谓
        UPDATING.store(false, Ordering::SeqCst);
    });

    let stream = async_stream::stream! {
        while let Some(line) = rx.recv().await {
            yield Ok::<_, actix_web::Error>(actix_web::web::Bytes::from(line));
        }
    };
    HttpResponse::Ok()
        .insert_header(("Content-Type", "text/plain; charset=utf-8"))
        .insert_header(("Cache-Control", "no-cache"))
        .streaming(stream)
}

fn apply_blocking(
    server_url: &str,
    auth_token: &str,
    tx: &tokio::sync::mpsc::Sender<String>,
) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};

    // 1) 先问清楚最新版本是什么（版本号用于判断 + 拼下载地址，sha256 用于下载完整性校验）
    let remote = fetch_remote(server_url, auth_token)?
        .ok_or_else(|| "补丁中心还没有发布 cc-web 新版本".to_string())?;
    if remote.get("has_package").and_then(|v| v.as_bool()) == Some(false) {
        let version = remote.get("version").and_then(|v| v.as_str()).unwrap_or("");
        return Err(format!("最新版本 {version} 暂无本平台的安装包，请联系管理员"));
    }
    let remote_version = remote.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let remote_sha = remote.get("sha256").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let remote_size = remote.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    if remote_version.is_empty() || remote_sha.is_empty() {
        return Err("服务器返回的版本信息不完整".to_string());
    }
    let local = exe_meta()?;
    if local.get("version").and_then(|v| v.as_str()) == Some(remote_version.as_str()) {
        return Ok(serde_json::json!({
            "success": true,
            "message": format!("本机已经是最新版本（{remote_version}），无需更新"),
        }));
    }

    // 2) 下载到同目录的 <原名>.new（同盘 move 才快且不跨卷）
    let exe = current_exe()?;
    let dir = exe.parent().ok_or_else(|| "取不到程序所在目录".to_string())?.to_path_buf();
    let exe_name = exe
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "cc-web.exe".to_string());
    let staged = dir.join(format!("{exe_name}.new"));
    let _ = std::fs::remove_file(&staged);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|error| format!("创建下载客户端失败：{error}"))?;
    // 地址里带上版本号：下载期间管理员即使把"最新版本"改了，也拿的是刚检查到的那个版本
    let url = format!(
        "{}/api/ccweb/download/{}/{}",
        server_url.trim_end_matches('/'),
        remote_version,
        PLATFORM
    );
    let mut response = client
        .get(&url)
        .header("Authorization", format!("Bearer {auth_token}"))
        .send()
        .map_err(|error| format!("连接补丁中心失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载新版本失败（HTTP {}）", response.status().as_u16()));
    }

    let mut file = std::fs::File::create(&staged).map_err(|error| {
        format!("写不了 {}（目录可能只读，请手动替换）：{error}", staged.display())
    })?;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut downloaded: u64 = 0;
    loop {
        let read = match response.read(&mut buffer) {
            Ok(n) => n,
            Err(error) => {
                drop(file);
                let _ = std::fs::remove_file(&staged);
                return Err(format!("下载中断：{error}"));
            }
        };
        if read == 0 {
            break;
        }
        if let Err(error) = file.write_all(&buffer[..read]) {
            drop(file);
            let _ = std::fs::remove_file(&staged);
            return Err(format!("写入新版本失败：{error}"));
        }
        downloaded += read as u64;
        let _ = tx.blocking_send(format!("progress {} {}\n", downloaded, remote_size));
    }
    drop(file);

    // 3) 校验：摘要不符（或大小明显不对）一律当失败，绝不拿半份文件去替换
    let actual_sha = sha256_file(&staged)?;
    if actual_sha != remote_sha {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("新版本校验失败（sha256 不符：期望 {}… 实际 {}…）", &remote_sha[..8.min(remote_sha.len())], &actual_sha[..8.min(actual_sha.len())]));
    }
    if remote_size > 0 && downloaded != remote_size {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("新版本大小不符（期望 {remote_size} 字节，实际 {downloaded} 字节）"));
    }

    // 4) 装上（Windows：脚本替换+重启；macOS：留在原地等使用者手动替换）
    let payload = install_staged(&staged, &exe_name, &dir)?;
    Ok(payload)
}
