use actix_web::{web, App, HttpServer};
// 实施版不装 CORS 中间件（见 HttpServer::new 里的说明），该 crate 只在开发版用到
#[cfg(not(feature = "implCon"))]
use actix_cors::Cors;
use std::sync::RwLock;
use tokio::sync::{broadcast, watch, Mutex};

mod ai;
mod api;
mod claude_history;
mod logging;
mod models;
mod static_files;
// 接口录制（CDP）：只在实施版编译（依赖 WebSocket 客户端，开发版 exe 不带）
#[cfg(feature = "implCon")]
mod recorder;

use ai::claude::ClaudeAssistant;
use ai::codex::CodexAssistant;
use ai::pi::PiAssistant;
use ai::{AiAssistant, AssistantRegistry};

/// Streaming state cache for real-time consistency
/// This cache stores the current streaming state in memory,
/// so when the user refreshes the page, they get the latest state immediately.
#[derive(Debug, Clone)]
pub struct StreamingState {
    pub content_blocks: Vec<models::ContentBlock>,
    pub final_result: String,
    pub assistant_name: String,
    pub last_updated: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalExecutionFingerprint {
    pub system_prompt: String,
    pub user_prompt: String,
    pub cwd: String,
    pub model: Option<String>,
}

pub struct LocalExecution {
    pub fingerprint: LocalExecutionFingerprint,
    pub result_tx: watch::Sender<Option<Result<(String, Option<String>), String>>>,
}

pub struct AppState {
    pub registry: RwLock<AssistantRegistry>,
    pub sessions: RwLock<std::collections::HashMap<String, models::Session>>,
    pub events_tx: RwLock<std::collections::HashMap<String, broadcast::Sender<String>>>,
    /// Running child process IDs for abort support (session_id → pid)
    pub running_pids: RwLock<std::collections::HashMap<String, u32>>,
    /// Sessions currently streaming (for frontend to know which sessions are active)
    pub streaming_sessions: RwLock<std::collections::HashSet<String>>,
    /// Streaming state cache for real-time consistency
    pub streaming_state: RwLock<std::collections::HashMap<String, StreamingState>>,
    /// Local workflow executions keyed by the caller-provided idempotency key.
    pub local_executions: Mutex<std::collections::HashMap<String, LocalExecution>>,
    /// 智能开发节点的本机运行清单（`~/.cc-web-dev/node_runs.json`）。
    /// 存的是前端定义的 run 对象，cc-web 不解释其字段（见 api/node_runs.rs）。
    pub node_runs: RwLock<serde_json::Map<String, serde_json::Value>>,
    /// 补丁适配的后台执行状态（`~/.cc-web-dev/adapt_runs.json`，见 api/adapt_bg.rs）。
    pub adapt_runs: RwLock<std::collections::HashMap<String, api::adapt_bg::AdaptRun>>,
    /// 本地补丁部署：批次/备份/表单配置（`~/.cc-web-dev/patch_deploy/`）。
    pub patch_deploy: api::patch_deploy::PatchDeployState,
}

/// `~/.cc-web-dev`（或实施版 `~/.cc-web-impl`）数据目录（不存在则创建）。
pub fn cc_web_dir() -> std::path::PathBuf {
    let data_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(DATA_DIR_NAME);
    std::fs::create_dir_all(&data_dir).ok();
    data_dir
}

/// 旧版数据目录名：实施版曾经用 `.cc-web-novice`，更早的开发版/实施版用 `.cc-web`。
fn legacy_data_dir_names() -> &'static [&'static str] {
    #[cfg(feature = "implCon")]
    {
        &[".cc-web-novice", ".cc-web"]
    }
    #[cfg(not(feature = "implCon"))]
    {
        &[".cc-web"]
    }
}

/// 把旧数据目录下的绝对路径重定位到当前数据目录。
///
/// 旧版 node_runs.json / sessions.json 里保存的是当时的绝对路径，只改目录名不会自动
/// 改历史记录。启动时做一次词法替换，既保留相对子路径，也不要求旧目录仍然存在。
fn rebase_legacy_path(value: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let home_text = home.to_string_lossy().replace('\\', "/");
    let home_text = home_text.trim_end_matches('/');
    let normalized = value.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    let home_lower = home_text.to_ascii_lowercase();
    for legacy in legacy_data_dir_names() {
        let prefix = format!("{home_lower}/{legacy}");
        if lower == prefix || lower.starts_with(&format!("{prefix}/")) {
            let suffix = &normalized[prefix.len()..];
            let mut next = format!("{home_text}/{DATA_DIR_NAME}{suffix}");
            #[cfg(windows)]
            {
                next = next.replace('/', "\\");
            }
            return Some(next);
        }
    }
    None
}

fn rebase_node_run_paths(run: &mut serde_json::Value) -> bool {
    let mut changed = false;
    if let Some(object) = run.as_object_mut() {
        for key in [
            "out_dir",
            "turn_dir",
            "step_dir",
            "stage_dir",
            "patch_output_path",
            "trigger_url",
        ] {
            if let Some(value) = object.get(key).and_then(|item| item.as_str()) {
                if let Some(next) = rebase_legacy_path(value) {
                    object.insert(key.to_string(), serde_json::Value::String(next));
                    changed = true;
                }
            }
        }
        for key in ["artifacts", "image_paths", "log_paths"] {
            if let Some(items) = object.get_mut(key).and_then(|item| item.as_array_mut()) {
                for item in items.iter_mut() {
                    if let Some(value) = item.as_str() {
                        if let Some(next) = rebase_legacy_path(value) {
                            *item = serde_json::Value::String(next);
                            changed = true;
                        }
                    }
                }
            }
        }
    }
    changed
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 首次启动新版本时，把旧的 `~/.cc-web` 迁移到当前版本目录：
///   开发版 -> `~/.cc-web-dev`
///   实施版 -> `~/.cc-web-impl`
/// 目标目录已存在时不做任何事；迁移成功后才删除旧目录，避免复制失败丢数据。
fn migrate_legacy_data_dir() {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let legacy = home.join(".cc-web");
    let target = home.join(DATA_DIR_NAME);
    if !legacy.is_dir() || target.exists() {
        return;
    }

    println!(
        "📦 发现旧数据目录 {}，正在迁移到 {} ...",
        legacy.display(),
        target.display()
    );
    let staging = home.join(format!("{}.migrating", DATA_DIR_NAME));
    let _ = std::fs::remove_dir_all(&staging);

    let result =
        copy_dir_recursive(&legacy, &staging).and_then(|_| std::fs::rename(&staging, &target));
    match result {
        Ok(()) => {
            if let Err(error) = std::fs::remove_dir_all(&legacy) {
                eprintln!(
                    "⚠️ 旧数据目录迁移完成，但删除旧目录失败：{}（{}）",
                    legacy.display(),
                    error
                );
            } else {
                println!("✅ 旧数据目录迁移完成");
            }
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            eprintln!(
                "⚠️ 旧数据目录迁移失败，将继续使用新目录，旧目录保留：{}（{}）",
                legacy.display(),
                error
            );
        }
    }
}

/// **cc-web.exe 所在目录**（安装目录）。只用来读取随包资源（如 patch_servers.json），
/// 不要往这里写运行期数据——Program Files / .app 可能只读。
pub fn cc_web_install_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// `temp` 根目录：放在用户数据目录（`~/.cc-web-dev` / `~/.cc-web-impl`）下。
/// 安装目录可能只读，且用户换机器/升级后临时路径也应稳定落在当前用户目录。
/// 智能开发运行目录、问题附件、聊天附件等临时文件都落在这里。
pub fn cc_web_temp_dir() -> std::path::PathBuf {
    let dir = cc_web_dir().join("temp");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// 接口录制导出目录：用户数据目录下，和会话/运行记录同一层，便于备份和迁移。
pub fn cc_web_recordings_dir() -> std::path::PathBuf {
    let dir = cc_web_dir().join("recordings");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// Get the path to the sessions data file
fn get_sessions_file_path() -> std::path::PathBuf {
    cc_web_dir().join("sessions.json")
}

/// Get the path to the node runs data file（智能开发节点的本机运行清单）
fn get_node_runs_file_path() -> std::path::PathBuf {
    cc_web_dir().join("node_runs.json")
}

/// Load sessions from disk
fn load_sessions_from_disk() -> std::collections::HashMap<String, models::Session> {
    let path = get_sessions_file_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(sessions) => {
                log::info!("📂 Loaded sessions from {}", path.display());
                sessions
            }
            Err(e) => {
                log::error!("⚠️ Failed to parse sessions file: {}", e);
                std::collections::HashMap::new()
            }
        },
        Err(_) => std::collections::HashMap::new(),
    }
}

/// Save sessions to disk (同步版本，用于 spawn_blocking 内部)
pub fn save_sessions_to_disk(sessions: &std::collections::HashMap<String, models::Session>) {
    let path = get_sessions_file_path();
    match serde_json::to_string_pretty(sessions) {
        Ok(content) => {
            if let Err(e) = std::fs::write(&path, content) {
                log::error!("Failed to save sessions: {}", e);
            }
        }
        Err(e) => {
            log::error!("Failed to serialize sessions: {}", e);
        }
    }
}

/// Save sessions to disk (异步版本，不阻塞 tokio 工作线程)
pub fn save_sessions_to_disk_async(data: &AppState) {
    let sessions_snapshot = data.sessions.read().unwrap().clone();
    tokio::task::spawn_blocking(move || {
        save_sessions_to_disk(&sessions_snapshot);
    });
}

// ── 智能开发节点的本机运行清单（与 sessions.json 同一套机制） ──
/// Load node runs from disk. 解析失败按空清单处理：清单是"能不能继续动手"的索引，
/// 坏了顶多是这次运行要重来，不该影响启动。
fn load_node_runs_from_disk() -> serde_json::Map<String, serde_json::Value> {
    let path = get_node_runs_file_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&content) {
                Ok(runs) => {
                    log::info!(
                        "📂 Loaded {} node run(s) from {}",
                        runs.len(),
                        path.display()
                    );
                    runs
                }
                Err(e) => {
                    log::error!("⚠️ Failed to parse node runs file: {}", e);
                    serde_json::Map::new()
                }
            }
        }
        Err(_) => serde_json::Map::new(),
    }
}

/// Save node runs to disk（同步版本）
pub fn save_node_runs_to_disk(runs: &serde_json::Map<String, serde_json::Value>) {
    let path = get_node_runs_file_path();
    match serde_json::to_string_pretty(runs) {
        Ok(content) => {
            if let Err(e) = std::fs::write(&path, content) {
                log::error!("Failed to save node runs: {}", e);
            }
        }
        Err(e) => {
            log::error!("Failed to serialize node runs: {}", e);
        }
    }
}

/// Save node runs to disk（异步版本，不阻塞 tokio 工作线程）
pub fn save_node_runs_to_disk_async(data: &AppState) {
    let runs_snapshot = data.node_runs.read().unwrap().clone();
    tokio::task::spawn_blocking(move || {
        save_node_runs_to_disk(&runs_snapshot);
    });
}

// ── 自动打开浏览器（双击 cc-web.exe / start.bat 启动后直达 Web 界面） ──
/// 监听地址与本地访问地址（编译期内嵌写死，按版本区分）
/// 实施版 2026-11-09 起改为 0.0.0.0（允许局域网访问）；CORS 仍是关闭的，
/// 跨源网页读不到接口响应，但局域网机器可以直接打开本机页面使用。
#[cfg(feature = "implCon")]
const BIND_ADDR: &str = "0.0.0.0:3031";
#[cfg(not(feature = "implCon"))]
const BIND_ADDR: &str = "0.0.0.0:3030";

#[cfg(feature = "implCon")]
const WEB_URL: &str = "http://127.0.0.1:3031";
#[cfg(not(feature = "implCon"))]
const WEB_URL: &str = "http://localhost:3030";

/// 数据目录名（开发版 ~/.cc-web-dev，实施版 ~/.cc-web-impl），按版本区分；两个版本可共存于同一台机器
#[cfg(feature = "implCon")]
pub const DATA_DIR_NAME: &str = ".cc-web-impl";
#[cfg(not(feature = "implCon"))]
pub const DATA_DIR_NAME: &str = ".cc-web-dev";

/// 是否允许自动打开浏览器。
/// 默认允许；如需后台/服务方式启动、或不想每次自动弹浏览器，
/// 可设置环境变量 `CC_WEB_NO_BROWSER=1`，或启动参数加 `--no-browser`。
fn browser_open_allowed() -> bool {
    if std::env::var("CC_WEB_NO_BROWSER")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes" || v == "on"
        })
        .unwrap_or(false)
    {
        return false;
    }
    !std::env::args().skip(1).any(|arg| arg == "--no-browser")
}

/// 调用系统默认浏览器打开 URL。
#[cfg(target_os = "windows")]
fn open_browser(url: &str) {
    // start "" "url"：把 url 交给系统默认浏览器（http 开头会直接打开而非搜索）
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
}

#[cfg(target_os = "macos")]
fn open_browser(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}

#[cfg(target_os = "linux")]
fn open_browser(url: &str) {
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn open_browser(_url: &str) {}

/// 服务已成功监听后，延后片刻自动打开浏览器。
/// 延迟是为了让端口真正开始 accept，避免浏览器先弹出“无法访问”。
fn auto_open_browser_after_start() {
    if !browser_open_allowed() {
        return;
    }
    println!("   🌐 自动打开浏览器: {}", WEB_URL);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        open_browser(WEB_URL);
    });
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // 必须在日志系统初始化之前迁移：否则新目录会被日志先创建，导致迁移跳过。
    migrate_legacy_data_dir();

    // 初始化结构化日志系统（日志只写入文件，控制台不输出）
    // 设置 RUST_LOG 环境变量控制日志级别，例如：
    //   RUST_LOG=info                    (默认)
    //   RUST_LOG=debug                   (所有模块 debug)
    //   RUST_LOG=cc_web::api::agent=debug (只有 agent 模块 debug)
    //   RUST_LOG=cc_web::ai::pi=trace    (Pi Agent 最详细)
    logging::init();

    // ── 启动横幅（直接输出到控制台）──
    // 带上版本号与构建时间：一眼看出正在跑的是哪一版、哪次编译出来的
    // （版本号来自 Cargo.toml，发版前要改它；构建时间是 build.rs 注入的）
    let build_unix: i64 = env!("CCWEB_BUILD_UNIX").parse().unwrap_or(0);
    let built = chrono::DateTime::from_timestamp(build_unix, 0)
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| "-".to_string());
    println!(
        "🚀 CC-Web server starting... v{}（构建 {}）",
        env!("CARGO_PKG_VERSION"),
        built
    );
    println!("📍 {}", WEB_URL);

    // Initialize AI assistant registry
    let mut registry = AssistantRegistry::new();

    // Register Claude Code assistant
    let claude = ClaudeAssistant::new();
    // 模型显示：settings.json 没配 model 时显示「默认（settings.json）」，而不是 unknown——
    // 那种情况下 cc-web 不传 --model，claude 自己按它的配置选模型
    println!(
        "   ✅ Claude ({})",
        ai::claude::claude_model_display(claude.default_model())
    );
    log::info!(
        "Claude Code registered (default model: {})",
        claude.default_model()
    );
    registry.register(Box::new(claude));

    // Register Pi Agent assistant
    let pi = PiAssistant::new();
    println!("   ✅ Pi Agent ({})", pi.default_model());
    log::info!(
        "Pi Agent registered (default model: {})",
        pi.default_model()
    );
    registry.register(Box::new(pi));

    // Register Codex assistant
    let codex = CodexAssistant::new();
    println!("   ✅ Codex ({})", codex.default_model());
    log::info!(
        "Codex registered (default model: {})",
        codex.default_model()
    );
    registry.register(Box::new(codex));

    // Load persisted sessions
    let mut saved_sessions = load_sessions_from_disk();
    let mut sessions_rebased = false;
    for session in saved_sessions.values_mut() {
        if let Some(next) = rebase_legacy_path(&session.cwd) {
            session.cwd = next;
            sessions_rebased = true;
        }
    }
    if sessions_rebased {
        save_sessions_to_disk(&saved_sessions);
    }
    let session_count = saved_sessions.len();
    if session_count > 0 {
        println!("   📂 {} session(s) restored", session_count);
        log::info!("Restored {} session(s)", session_count);
    }

    // Load persisted node runs（智能开发节点的本机运行清单）
    let mut saved_node_runs = load_node_runs_from_disk();
    let mut node_runs_rebased = false;
    for run in saved_node_runs.values_mut() {
        if rebase_node_run_paths(run) {
            node_runs_rebased = true;
        }
    }
    if node_runs_rebased {
        save_node_runs_to_disk(&saved_node_runs);
    }
    if !saved_node_runs.is_empty() {
        println!("   📂 {} node run(s) restored", saved_node_runs.len());
    }

    // 本地补丁部署：数据目录独立于会话数据，支持批次备份和回滚。
    let patch_deploy = api::patch_deploy::PatchDeployState::new(cc_web_dir().join("patch_deploy"))
        .expect("初始化补丁部署数据目录失败");
    patch_deploy.cleanup_staging();
    let patch_deploy_count = patch_deploy.batches.lock().unwrap().len();
    if patch_deploy_count > 0 {
        println!(
            "   📦 {} patch deploy batch(es) restored",
            patch_deploy_count
        );
    }

    let data = web::Data::new(AppState {
        registry: RwLock::new(registry),
        sessions: RwLock::new(saved_sessions),
        events_tx: RwLock::new(std::collections::HashMap::new()),
        running_pids: RwLock::new(std::collections::HashMap::new()),
        streaming_sessions: RwLock::new(std::collections::HashSet::new()),
        streaming_state: RwLock::new(std::collections::HashMap::new()),
        local_executions: Mutex::new(std::collections::HashMap::new()),
        node_runs: RwLock::new(saved_node_runs),
        adapt_runs: RwLock::new(std::collections::HashMap::new()),
        patch_deploy,
    });

    // 恢复补丁适配记录（重启后"执行中"的会标为失败——后台线程随进程消亡）
    api::adapt_bg::load_adapt_runs(&data);

    let patch_servers = api::patch_config::patch_search_servers();
    if patch_servers.is_empty() {
        println!("   ⚠️ patch_search API: 未配置（src/patch_servers.json 内嵌地址为空）");
    } else {
        println!(
            "   📄 patch_search API ({} 条): {}",
            patch_servers.len(),
            patch_servers.join(", ")
        );
    }
    println!("   🔗 Listening on {}", BIND_ADDR);
    println!("   📝 Logs: ~/{}/logs/", DATA_DIR_NAME);
    println!();

    let server_builder = HttpServer::new(move || {
        let app = App::new()
            // 注释掉 actix Logger 中间件，避免 HTTP 请求日志输出到控制台
            // 详细日志已通过 logging 系统写入文件
            // .wrap(middleware::Logger::default())
            .app_data(data.clone())
            // 补丁包上传走 multipart：放宽请求体上限（默认偏小）
            .app_data(web::PayloadConfig::new(500 * 1024 * 1024));
        // 开发版保持宽松 CORS（沿用现行为）。实施版不装 CORS 中间件 = 不发任何
        // Access-Control-Allow-Origin：页面本身由本进程同源服务，浏览器禁止一切
        // 跨源页面读 cc-web 接口（实施版监听 0.0.0.0:3031，局域网可达，但没有 CORS
        // 响应头时网页脚本读不到响应体，`curl` 这类非浏览器客户端不受此限制——实施版
        // 接口本身没有鉴权，部署在可信局域网内是前提）。
        #[cfg(not(feature = "implCon"))]
        let app = app.wrap(
            Cors::default()
                .allow_any_origin()
                .allow_any_method()
                .allow_any_header()
                .max_age(3600),
        );

        let app = app
            // ── 共享路由（两个版本都有）──
            .route("/api/models", web::get().to(api::models::get_models))
            .route(
                "/api/assistants",
                web::get().to(api::models::list_assistants),
            )
            .route("/api/sessions", web::get().to(api::sessions::list_sessions))
            .route(
                "/api/sessions/{id}",
                web::get().to(api::sessions::get_session),
            )
            .route(
                "/api/sessions/{id}",
                web::delete().to(api::sessions::delete_session),
            )
            .route(
                "/api/sessions/{id}/name",
                web::patch().to(api::sessions::rename_session),
            )
            // 聊天框发送的图片/文件（保存到会话工作目录，AI 用 Read 查看；两版共用）
            .route(
                "/api/chat/attachment",
                web::post().to(api::node_runs::save_chat_attachment),
            )
            .route("/api/agent/new", web::post().to(api::agent::new_session))
            .route(
                "/api/agent/{id}/start",
                web::post().to(api::agent::start_prompt),
            )
            .route(
                "/api/agent/{id}/abort",
                web::post().to(api::agent::abort_session),
            )
            .route(
                "/api/agent/{id}/switch",
                web::post().to(api::agent::switch_assistant),
            )
            .route("/api/agent/{id}", web::post().to(api::agent::send_command))
            .route("/api/agent/{id}", web::get().to(api::agent::get_state))
            .route("/api/agent/{id}/events", web::get().to(api::agent::events))
            // 只读：按 claude 会话 id 读本机 ~/.claude/projects 下的记录（聊天页的"只读回放"用）
            .route(
                "/api/claude-sessions/{sid}",
                web::get().to(api::agent::claude_session_history),
            )
            .route("/api/files", web::get().to(api::files::list_files))
            // 原始字节/定位文件：必须在 /api/files/{path:.*} 之前注册（raw/reveal 是更具体的前缀）
            .route(
                "/api/files/raw/{path:.*}",
                web::get().to(api::files::read_file_raw),
            )
            .route("/api/files/reveal", web::post().to(api::files::reveal_file))
            .route(
                "/api/files/open-folder",
                web::post().to(api::files::open_folder),
            )
            // 在本机弹系统原生「选择文件夹」对话框，选中路径回填输入框（见 folderpick.js）
            .route("/api/pick-folder", web::get().to(api::files::pick_folder));

        // ── 开发版专属路由：补丁适配 + 智能分析（实施版不注册）──
        #[cfg(not(feature = "implCon"))]
        let app = app
            .route("/api/adapt/upload", web::post().to(api::adapt::upload))
            .route(
                "/api/adapt/import",
                web::post().to(api::adapt::import_patch),
            )
            .route(
                "/api/adapt/git-status",
                web::get().to(api::adapt::git_status),
            )
            .route("/api/adapt/start", web::post().to(api::adapt::start))
            .route("/api/adapt/runs", web::get().to(api::adapt::list_runs))
            .route("/api/adapt/runs/{id}", web::get().to(api::adapt::get_run))
            .route(
                "/api/adapt/runs/{id}/abort",
                web::post().to(api::adapt::abort_run),
            )
            .route(
                "/api/adapt/runs/{id}/next",
                web::post().to(api::adapt::next_run),
            )
            .route(
                "/api/adapt/runs/{id}/next-all",
                web::post().to(api::adapt::next_all_run),
            )
            .route(
                "/api/adapt/runs/{id}/re-report",
                web::post().to(api::adapt::re_report),
            )
            .route(
                "/api/adapt/runs/{id}/retry-failed",
                web::post().to(api::adapt::retry_failed),
            )
            .route(
                "/api/adapt/runs/{id}/delete",
                web::post().to(api::adapt::delete_run),
            )
            .route(
                "/api/local-claude/execute",
                web::post().to(api::local_claude::execute),
            )
            .route(
                "/api/local-claude/{execution_id}/cancel",
                web::post().to(api::local_claude::cancel),
            )
            // 智能分析 local_temp 步骤：在用户数据目录的 temp 下创建临时工作目录
            .route(
                "/api/workflows/local-temp",
                web::post().to(api::local_claude::workflow_temp),
            );

        // ── 实施版专属路由：接口录制（CDP）──
        #[cfg(feature = "implCon")]
        let app = app
            .route("/api/recorder/open", web::post().to(recorder::open))
            .route("/api/recorder/status", web::get().to(recorder::status))
            .route("/api/recorder/close", web::post().to(recorder::close));

        // ── 更多共享路由 ──
        app.route("/api/files/{path:.*}", web::get().to(api::files::read_file))
            // 智能开发节点的本机运行清单（见 api/node_runs.rs）
            .route("/api/node/runs", web::get().to(api::node_runs::list_runs))
            .route(
                "/api/node/runs/{id}",
                web::put().to(api::node_runs::put_run),
            )
            .route(
                "/api/node/runs/{id}",
                web::delete().to(api::node_runs::delete_run),
            )
            .route(
                "/api/node/runs/{id}/ensure-dir",
                web::post().to(api::node_runs::ensure_dir),
            )
            // 建运行工作目录（实施版：暂存/产物目录都在 <数据目录>/temp/node/<runId> 下）
            .route(
                "/api/node/workspace",
                web::post().to(api::node_runs::create_workspace),
            )
            // 智能开发/排查表单的问题附件与日志附件（两版共用，写到 temp/node/<runId>/images）
            .route(
                "/api/node/problem-image",
                web::post().to(api::node_runs::save_problem_image),
            )
            // 环境自检（实施版环境检查页；开发版也可调）
            .route("/api/env-check", web::get().to(api::env_check::env_check))
            // 调试 API：返回所有会话的实时状态快照
            .route("/api/debug/state", web::get().to(debug_state))
            // 本地补丁部署（开发版/实施版共用；接口内部有同源/可选本机限制）
            .route(
                "/api/patch-deploy/config",
                web::get().to(api::patch_deploy::get_config),
            )
            .route(
                "/api/patch-deploy/config",
                web::post().to(api::patch_deploy::save_config),
            )
            .route(
                "/api/patch-deploy/config/reset",
                web::post().to(api::patch_deploy::reset_config_defaults),
            )
            .route(
                "/api/patch-deploy/detect",
                web::post().to(api::patch_deploy::detect),
            )
            .route(
                "/api/patch-deploy/preflight",
                web::post().to(api::patch_deploy::preflight),
            )
            .route(
                "/api/patch-deploy/preflight-by-path",
                web::post().to(api::patch_deploy::preflight_by_path),
            )
            .route(
                "/api/patch-deploy/session-artifacts",
                web::get().to(api::patch_deploy::session_artifacts),
            )
            .route(
                "/api/patch-deploy/deploy",
                web::post().to(api::patch_deploy::deploy_handler),
            )
            .route(
                "/api/patch-deploy/cancel",
                web::post().to(api::patch_deploy::cancel),
            )
            .route(
                "/api/patch-deploy/batches",
                web::get().to(api::patch_deploy::list_batches),
            )
            .route(
                "/api/patch-deploy/batches/{id}",
                web::get().to(api::patch_deploy::batch_detail),
            )
            .route(
                "/api/patch-deploy/batches/{id}/delete",
                web::post().to(api::patch_deploy::delete_batch),
            )
            .route(
                "/api/patch-deploy/rollback",
                web::post().to(api::patch_deploy::rollback_handler),
            )
            .route(
                "/api/patch-deploy/restart",
                web::post().to(api::patch_deploy::restart),
            )
            .route(
                "/api/patch-deploy/service-commands",
                web::post().to(api::patch_deploy::save_service_commands),
            )
            // 补丁中心配置：向前端下发 patch_search 后端地址（代码内写死，无需 patch_config.json）
            .route(
                "/api/patch-config",
                web::get().to(api::patch_config::get_patch_config),
            )
            // 获取新版本：本机版本 + 比对补丁中心的最新版本 + 下载自替换（见 api/update.rs）
            .route("/api/version", web::get().to(api::update::version))
            .route("/api/update/check", web::post().to(api::update::check))
            .route("/api/update/apply", web::post().to(api::update::apply))
            // Static files (fallback)
            .default_service(web::route().to(static_files::serve))
    });

    match server_builder.bind(BIND_ADDR) {
        Ok(server) => {
            // 已成功监听 → 打开浏览器直达 Web 界面
            auto_open_browser_after_start();
            server.run().await
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                // 端口被占用：多半是已有一个 cc-web 实例在运行。
                // 此时不再报错退出，而是打开浏览器复用该实例。
                println!("   ⚠️ {} 已被占用，疑似 cc-web 已在运行。", BIND_ADDR);
                if browser_open_allowed() {
                    println!("   🌐 打开已有实例: {}", WEB_URL);
                    open_browser(WEB_URL);
                }
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

/// 调试 API：返回所有会话的实时状态快照
///
/// 访问方式：GET /api/debug/state
///
/// 返回内容：
/// - 所有会话的基本信息（assistant、model、messageCount）
/// - 每个会话的流式传输状态（isStreaming、hasChannel、channelReceivers）
/// - 运行中的进程 PID
/// - streaming_state 缓存状态
///
/// 用途：
/// - 调试 SSE 断开问题：检查 isStreaming 和 channelReceivers
/// - 调试进程泄漏：检查 runningProcesses
/// - 调试 channel 泄漏：检查 activeChannels
async fn debug_state(data: web::Data<AppState>) -> actix_web::HttpResponse {
    let snapshot = logging::format_state_snapshot(&data);
    actix_web::HttpResponse::Ok().json(snapshot)
}

#[cfg(test)]
mod patch_deploy_routes_test {
    use super::*;
    use actix_web::test;

    fn test_state() -> AppState {
        let dir = std::env::temp_dir().join(format!(
            "cc-web-patch-deploy-route-test-{}",
            uuid::Uuid::new_v4()
        ));
        test_state_at(dir)
    }

    fn test_state_at(dir: std::path::PathBuf) -> AppState {
        AppState {
            registry: RwLock::new(AssistantRegistry::new()),
            sessions: RwLock::new(std::collections::HashMap::new()),
            events_tx: RwLock::new(std::collections::HashMap::new()),
            running_pids: RwLock::new(std::collections::HashMap::new()),
            streaming_sessions: RwLock::new(std::collections::HashSet::new()),
            streaming_state: RwLock::new(std::collections::HashMap::new()),
            local_executions: Mutex::new(std::collections::HashMap::new()),
            node_runs: RwLock::new(serde_json::Map::new()),
            adapt_runs: RwLock::new(std::collections::HashMap::new()),
            patch_deploy: api::patch_deploy::PatchDeployState::new(dir).unwrap(),
        }
    }

    #[actix_web::test]
    async fn patch_deploy_config_route() {
        let state = test_state();
        let app = test::init_service(App::new().app_data(web::Data::new(state)).route(
            "/api/patch-deploy/config",
            web::get().to(api::patch_deploy::get_config),
        ))
        .await;

        let local = test::TestRequest::get()
            .uri("/api/patch-deploy/config")
            .peer_addr("127.0.0.1:12345".parse().unwrap())
            .to_request();
        assert!(test::call_service(&app, local).await.status().is_success());

        let remote = test::TestRequest::get()
            .uri("/api/patch-deploy/config")
            .peer_addr("10.0.0.1:12345".parse().unwrap())
            .to_request();
        assert!(test::call_service(&app, remote).await.status().is_success());

        let cross_origin = test::TestRequest::get()
            .uri("/api/patch-deploy/config")
            .peer_addr("127.0.0.1:12345".parse().unwrap())
            .insert_header(("origin", "http://evil.example"))
            .insert_header(("host", "127.0.0.1:3030"))
            .to_request();
        let response = test::call_service(&app, cross_origin).await;
        assert!(response.status().is_success());
        let bytes = test::read_body(response).await;
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], 403);
    }
    #[actix_web::test]
    async fn patch_deploy_api_preflight_deploy_rollback() {
        use std::io::Write;

        let base = std::env::temp_dir().join(format!(
            "cc-web-patch-deploy-api-test-{}",
            uuid::Uuid::new_v4()
        ));
        let root = base.join("fbip");
        let class_dir = root.join("WEB-INF/classes/nccloud/demo");
        std::fs::create_dir_all(&class_dir).unwrap();
        std::fs::create_dir_all(root.join("WEB-INF/lib")).unwrap();
        std::fs::create_dir_all(root.join("modules")).unwrap();
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::write(root.join("WEB-INF/web.xml"), b"<web-app/>").unwrap();
        std::fs::write(class_dir.join("A.class"), b"OLD").unwrap();

        let patch = base.join("p.zip");
        {
            let file = std::fs::File::create(&patch).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("replacement/WEB-INF/classes/nccloud/demo/A.class", options).unwrap();
            zip.write_all(b"NEW").unwrap();
            zip.start_file("replacement/WEB-INF/classes/nccloud/demo/A.java", options).unwrap();
            zip.write_all(b"class A {}").unwrap();
            zip.finish().unwrap();
        }

        let state = test_state_at(base.join("data"));
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(state))
                .route(
                    "/api/patch-deploy/preflight",
                    web::post().to(api::patch_deploy::preflight),
                )
                .route(
                    "/api/patch-deploy/deploy",
                    web::post().to(api::patch_deploy::deploy_handler),
                )
                .route(
                    "/api/patch-deploy/batches",
                    web::get().to(api::patch_deploy::list_batches),
                )
                .route(
                    "/api/patch-deploy/rollback",
                    web::post().to(api::patch_deploy::rollback_handler),
                ),
        )
        .await;

        let boundary = "----ccweb-patch-test-boundary";
        let patch_bytes = std::fs::read(&patch).unwrap();
        let mut body: Vec<u8> = Vec::new();
        for (name, value) in [
            ("target", root.to_str().unwrap()),
            ("edition", "auto"),
        ] {
            write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").unwrap();
        }
        write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"p.zip\"\r\nContent-Type: application/zip\r\n\r\n").unwrap();
        body.extend_from_slice(&patch_bytes);
        write!(body, "\r\n--{boundary}--\r\n").unwrap();

        let request = test::TestRequest::post()
            .uri("/api/patch-deploy/preflight")
            .peer_addr("127.0.0.1:12345".parse().unwrap())
            .insert_header((
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            ))
            .set_payload(body)
            .to_request();
        let response = test::call_service(&app, request).await;
        assert!(response.status().is_success());
        let bytes = test::read_body(response).await;
        let envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(envelope["code"], 0);
        let plan = &envelope["data"];
        assert_eq!(plan["stats"]["replace"], 1);
        assert_eq!(plan["stats"]["add"], 1);
        let batch_id = plan["batch_id"].as_str().unwrap().to_string();

        let deploy = test::TestRequest::post()
            .uri("/api/patch-deploy/deploy")
            .peer_addr("127.0.0.1:12345".parse().unwrap())
            .set_json(serde_json::json!({
                "batch_id": batch_id,
                "restart": false,
                "confirm_replace": true
            }))
            .to_request();
        let response = test::call_service(&app, deploy).await;
        assert!(response.status().is_success());
        assert_eq!(std::fs::read(class_dir.join("A.class")).unwrap(), b"NEW");

        let batches = test::TestRequest::get()
            .uri("/api/patch-deploy/batches")
            .peer_addr("127.0.0.1:12345".parse().unwrap())
            .to_request();
        let response = test::call_service(&app, batches).await;
        assert!(response.status().is_success());

        let rollback = test::TestRequest::post()
            .uri("/api/patch-deploy/rollback")
            .peer_addr("127.0.0.1:12345".parse().unwrap())
            .set_json(serde_json::json!({
                "batch_id": batch_id,
                "restart": false,
                "confirm": true
            }))
            .to_request();
        let response = test::call_service(&app, rollback).await;
        assert!(response.status().is_success());
        assert_eq!(std::fs::read(class_dir.join("A.class")).unwrap(), b"OLD");
        assert!(!root.join("WEB-INF/classes/nccloud/demo/A.java").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

}
