use actix_web::{web, App, HttpServer};
use actix_cors::Cors;
use std::sync::RwLock;
use tokio::sync::{broadcast, watch, Mutex};

mod api;
mod ai;
mod models;
mod static_files;
mod logging;
mod claude_history;

use ai::{AssistantRegistry, AiAssistant};
use ai::claude::ClaudeAssistant;
use ai::codex::CodexAssistant;
use ai::pi::PiAssistant;

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
    /// 智能开发节点的本机运行清单（`~/.cc-web/node_runs.json`）。
    /// 存的是前端定义的 run 对象，cc-web 不解释其字段（见 api/node_runs.rs）。
    pub node_runs: RwLock<serde_json::Map<String, serde_json::Value>>,
    /// 补丁适配的后台执行状态（`~/.cc-web/adapt_runs.json`，见 api/adapt_bg.rs）。
    pub adapt_runs: RwLock<std::collections::HashMap<String, api::adapt_bg::AdaptRun>>,
}

/// `~/.cc-web` 数据目录（不存在则创建）。
fn cc_web_dir() -> std::path::PathBuf {
    let data_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".cc-web");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir
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
        Ok(content) => {
            match serde_json::from_str(&content) {
                Ok(sessions) => {
                    log::info!("📂 Loaded sessions from {}", path.display());
                    sessions
                }
                Err(e) => {
                    log::error!("⚠️ Failed to parse sessions file: {}", e);
                    std::collections::HashMap::new()
                }
            }
        }
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
        Ok(content) => match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&content) {
            Ok(runs) => {
                log::info!("📂 Loaded {} node run(s) from {}", runs.len(), path.display());
                runs
            }
            Err(e) => {
                log::error!("⚠️ Failed to parse node runs file: {}", e);
                serde_json::Map::new()
            }
        },
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
/// 监听地址与本地访问地址（编译期内嵌写死）
const BIND_ADDR: &str = "0.0.0.0:3030";
const WEB_URL: &str = "http://localhost:3030";

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
    // 初始化结构化日志系统（日志只写入文件，控制台不输出）
    // 设置 RUST_LOG 环境变量控制日志级别，例如：
    //   RUST_LOG=info                    (默认)
    //   RUST_LOG=debug                   (所有模块 debug)
    //   RUST_LOG=cc_web::api::agent=debug (只有 agent 模块 debug)
    //   RUST_LOG=cc_web::ai::pi=trace    (Pi Agent 最详细)
    logging::init();

    // ── 启动横幅（直接输出到控制台）──
    println!("🚀 CC-Web server starting...");
    println!("📍 {}", WEB_URL);

    // Initialize AI assistant registry
    let mut registry = AssistantRegistry::new();

    // Register Claude Code assistant
    let claude = ClaudeAssistant::new();
    println!("   ✅ Claude ({})", claude.default_model());
    log::info!("Claude Code registered (default model: {})", claude.default_model());
    registry.register(Box::new(claude));

    // Register Pi Agent assistant
    let pi = PiAssistant::new();
    println!("   ✅ Pi Agent ({})", pi.default_model());
    log::info!("Pi Agent registered (default model: {})", pi.default_model());
    registry.register(Box::new(pi));

    // Register Codex assistant
    let codex = CodexAssistant::new();
    println!("   ✅ Codex ({})", codex.default_model());
    log::info!("Codex registered (default model: {})", codex.default_model());
    registry.register(Box::new(codex));

    // Load persisted sessions
    let saved_sessions = load_sessions_from_disk();
    let session_count = saved_sessions.len();
    if session_count > 0 {
        println!("   📂 {} session(s) restored", session_count);
        log::info!("Restored {} session(s)", session_count);
    }

    // Load persisted node runs（智能开发节点的本机运行清单）
    let saved_node_runs = load_node_runs_from_disk();
    if !saved_node_runs.is_empty() {
        println!("   📂 {} node run(s) restored", saved_node_runs.len());
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
    });

    // 恢复补丁适配记录（重启后"执行中"的会标为失败——后台线程随进程消亡）
    api::adapt_bg::load_adapt_runs(&data);

    let patch_servers = api::patch_config::patch_search_servers();
    if patch_servers.is_empty() {
        println!("   ⚠️ patch_search API: 未配置（src/patch_servers.json 内嵌地址为空）");
    } else {
        println!("   📄 patch_search API ({} 条): {}", patch_servers.len(), patch_servers.join(", "));
    }
    println!("   🔗 Listening on {}", BIND_ADDR);
    println!("   📝 Logs: ~/.cc-web/logs/");
    println!();

    let server_builder = HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .max_age(3600);

        App::new()
            .wrap(cors)
            // 注释掉 actix Logger 中间件，避免 HTTP 请求日志输出到控制台
            // 详细日志已通过 logging 系统写入文件
            // .wrap(middleware::Logger::default())
            .app_data(data.clone())
            // 补丁包上传走 multipart：放宽请求体上限（默认偏小）
            .app_data(web::PayloadConfig::new(500 * 1024 * 1024))
            // API routes
            .route("/api/models", web::get().to(api::models::get_models))
            .route("/api/assistants", web::get().to(api::models::list_assistants))
            .route("/api/sessions", web::get().to(api::sessions::list_sessions))
            .route("/api/sessions/{id}", web::get().to(api::sessions::get_session))
            .route("/api/sessions/{id}", web::delete().to(api::sessions::delete_session))
            .route("/api/agent/new", web::post().to(api::agent::new_session))
            .route("/api/agent/{id}/start", web::post().to(api::agent::start_prompt))
            .route("/api/agent/{id}/abort", web::post().to(api::agent::abort_session))
            .route("/api/agent/{id}/switch", web::post().to(api::agent::switch_assistant))
            .route("/api/agent/{id}", web::post().to(api::agent::send_command))
            .route("/api/agent/{id}", web::get().to(api::agent::get_state))
            .route("/api/agent/{id}/events", web::get().to(api::agent::events))
            // 只读：按 claude 会话 id 读本机 ~/.claude/projects 下的记录（聊天页的"只读回放"用）
            .route("/api/claude-sessions/{sid}", web::get().to(api::agent::claude_session_history))
            .route("/api/files", web::get().to(api::files::list_files))
            // 原始字节/定位文件：必须在 /api/files/{path:.*} 之前注册（raw/reveal 是更具体的前缀）
            .route("/api/files/raw/{path:.*}", web::get().to(api::files::read_file_raw))
            .route("/api/files/reveal", web::post().to(api::files::reveal_file))
            // 在本机弹系统原生「选择文件夹」对话框，选中路径回填输入框（见 folderpick.js）
            .route("/api/pick-folder", web::get().to(api::files::pick_folder))
            // 补丁适配（用户端）：上传补丁包并解压、检查客开工程 git 状态
            .route("/api/adapt/upload", web::post().to(api::adapt::upload))
            .route("/api/adapt/import", web::post().to(api::adapt::import_patch))
            .route("/api/adapt/git-status", web::get().to(api::adapt::git_status))
            .route("/api/adapt/start", web::post().to(api::adapt::start))
            .route("/api/adapt/runs", web::get().to(api::adapt::list_runs))
            .route("/api/adapt/runs/{id}", web::get().to(api::adapt::get_run))
            .route("/api/adapt/runs/{id}/abort", web::post().to(api::adapt::abort_run))
            .route("/api/adapt/runs/{id}/next", web::post().to(api::adapt::next_run))
            .route("/api/adapt/runs/{id}/next-all", web::post().to(api::adapt::next_all_run))
            .route("/api/adapt/runs/{id}/re-report", web::post().to(api::adapt::re_report))
            .route("/api/adapt/runs/{id}/retry-failed", web::post().to(api::adapt::retry_failed))
            .route("/api/adapt/runs/{id}/delete", web::post().to(api::adapt::delete_run))
            .route("/api/files/{path:.*}", web::get().to(api::files::read_file))
            .route("/api/local-claude/execute", web::post().to(api::local_claude::execute))
            .route("/api/local-claude/{execution_id}/cancel", web::post().to(api::local_claude::cancel))
            // 智能开发节点的本机运行清单（见 api/node_runs.rs）
            .route("/api/node/runs", web::get().to(api::node_runs::list_runs))
            .route("/api/node/runs/{id}", web::put().to(api::node_runs::put_run))
            .route("/api/node/runs/{id}", web::delete().to(api::node_runs::delete_run))
            // 调试 API：返回所有会话的实时状态快照
            .route("/api/debug/state", web::get().to(debug_state))
            // 补丁中心配置：向前端下发 patch_search 后端地址（代码内写死，无需 patch_config.json）
            .route("/api/patch-config", web::get().to(api::patch_config::get_patch_config))
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
