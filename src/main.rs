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
}

/// Get the path to the sessions data file
fn get_sessions_file_path() -> std::path::PathBuf {
    let data_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".cc-web");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("sessions.json")
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
    println!("📍 http://localhost:3030");

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

    let data = web::Data::new(AppState {
        registry: RwLock::new(registry),
        sessions: RwLock::new(saved_sessions),
        events_tx: RwLock::new(std::collections::HashMap::new()),
        running_pids: RwLock::new(std::collections::HashMap::new()),
        streaming_sessions: RwLock::new(std::collections::HashSet::new()),
        streaming_state: RwLock::new(std::collections::HashMap::new()),
        local_executions: Mutex::new(std::collections::HashMap::new()),
    });

    println!("   🔗 Listening on 0.0.0.0:3030");
    println!("   📝 Logs: ~/.cc-web/logs/");
    println!();

    HttpServer::new(move || {
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
            .route("/api/files", web::get().to(api::files::list_files))
            .route("/api/files/{path:.*}", web::get().to(api::files::read_file))
            .route("/api/local-claude/execute", web::post().to(api::local_claude::execute))
            .route("/api/local-claude/{execution_id}/cancel", web::post().to(api::local_claude::cancel))
            // 调试 API：返回所有会话的实时状态快照
            .route("/api/debug/state", web::get().to(debug_state))
            // Static files (fallback)
            .default_service(web::route().to(static_files::serve))
    })
    .bind("0.0.0.0:3030")?
    .run()
    .await
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
