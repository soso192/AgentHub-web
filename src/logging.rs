/// 结构化日志系统
///
/// 日志只写入文件（~/.cc-web/logs/cc-web-YYYY-MM-DD.log），控制台不输出。
/// 启动横幅通过 println! 直接输出到控制台（不受日志系统控制）。
///
/// 使用方式：
///   - 设置环境变量 RUST_LOG 控制日志级别：RUST_LOG=debug,cc_web=trace
///   - 日志文件路径：~/.cc-web/logs/cc-web-YYYY-MM-DD.log
///   - 文件日志包含完整时间戳、模块名、行号
///
/// 日志级别：
///   error > warn > info > debug > trace
///
/// 在代码中使用：
///   log::info!("连接建立: session={}", session_id);
///   log::debug!("收到事件: type={}, count={}", event_type, count);
///   log::warn!("心跳超时: {}ms", time_since_heartbeat);
///   log::error!("SSE 发送失败: {}", error);

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use chrono::Local;

/// 全局日志文件句柄
static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);

/// 获取日志文件目录（~/.cc-web/logs/）
fn get_log_dir() -> PathBuf {
    let log_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cc-web")
        .join("logs");
    fs::create_dir_all(&log_dir).ok();
    log_dir
}

/// 获取今天的日志文件路径
fn get_log_file_path() -> PathBuf {
    let date = Local::now().format("%Y-%m-%d").to_string();
    get_log_dir().join(format!("cc-web-{}.log", date))
}

/// 自定义日志输出器（只写文件，不输出到控制台）
struct FileLogger {
    level: log::LevelFilter,
}

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let level = record.level();
        let module = record.module_path().unwrap_or("unknown");
        let line = record.line().unwrap_or(0);
        let args = record.args();

        // 格式：[2026-06-07 14:30:45.123 INFO cc_web::api::agent:123] 消息内容
        let log_line = format!("[{} {} {}:{}] {}\n", timestamp, level, module, line, args);

        // 写入文件
        if let Ok(mut guard) = LOG_FILE.lock() {
            if let Some(ref mut file) = *guard {
                let _ = file.write_all(log_line.as_bytes());
            }
        }
    }

    fn flush(&self) {
        if let Ok(mut guard) = LOG_FILE.lock() {
            if let Some(ref mut file) = *guard {
                let _ = file.flush();
            }
        }
    }
}

/// 初始化日志系统
///
/// 调用一次即可，在 main() 中调用。
/// 如果 RUST_LOG 未设置，默认级别为 info。
///
/// 日志只写入文件，控制台不输出（启动横幅用 println!）。
pub fn init() {
    let log_file_path = get_log_file_path();

    // 打开日志文件（追加模式）
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
        .expect("无法打开日志文件");

    // 存入全局变量
    *LOG_FILE.lock().unwrap() = Some(file);

    // 写入启动分隔线
    log::info!("═══════════════════════════════════════════════════════");
    log::info!("CC-Web 服务启动: {}", Local::now().format("%Y-%m-%d %H:%M:%S"));
    log::info!("═══════════════════════════════════════════════════════");

    // 读取 RUST_LOG 环境变量，决定日志级别
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|val| match val.to_lowercase().as_str() {
            "error" => Some(log::LevelFilter::Error),
            "warn" => Some(log::LevelFilter::Warn),
            "info" => Some(log::LevelFilter::Info),
            "debug" => Some(log::LevelFilter::Debug),
            "trace" => Some(log::LevelFilter::Trace),
            _ => None, // 复杂过滤器交给 env_logger 解析
        })
        .unwrap_or(log::LevelFilter::Info);

    // 如果 RUST_LOG 是简单的级别名（如 "debug"），使用自定义 FileLogger
    // 如果 RUST_LOG 是复杂过滤器（如 "cc_web::ai=debug"），使用 env_logger 写文件
    let rust_log = std::env::var("RUST_LOG").unwrap_or_default();
    if rust_log.contains("::") || rust_log.contains('=') {
        // 复杂过滤器：用 env_logger，但只输出到文件
        init_env_logger_to_file(&log_file_path);
    } else {
        // 简单级别：用自定义 FileLogger
        let logger = Box::new(FileLogger { level });
        // 这里需要泄漏 Box 来获取 'static 生命周期
        // 对于全局 logger 来说这是标准做法
        let logger: &'static FileLogger = Box::leak(logger);
        log::set_logger(logger).unwrap();
        log::set_max_level(level);
    }

    log::info!("日志系统初始化完成");
    log::info!("日志文件: {}", log_file_path.display());
    log::info!("设置 RUST_LOG 环境变量可调整日志级别: error|warn|info|debug|trace");

    // 日志轮转：清理 7 天前的日志文件
    cleanup_old_logs(7);
}

/// 使用 env_logger 写入文件（支持复杂过滤器如 "cc_web::ai=debug"）
fn init_env_logger_to_file(log_file_path: &PathBuf) {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file_path)
        .expect("无法打开日志文件");

    let env = env_logger::Env::default().default_filter_or("info");
    let mut builder = env_logger::Builder::from_env(env);
    builder.target(env_logger::Target::Pipe(Box::new(file)));
    builder.format(|buf, record| {
        let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        writeln!(
            buf,
            "[{} {} {}:{}] {}",
            timestamp,
            record.level(),
            record.module_path().unwrap_or("unknown"),
            record.line().unwrap_or(0),
            record.args()
        )
    });
    builder.init();
}

/// 清理指定天数前的日志文件
fn cleanup_old_logs(keep_days: u64) {
    let log_dir = get_log_dir();
    let cutoff = chrono::Local::now() - chrono::Duration::days(keep_days as i64);

    let entries = match fs::read_dir(&log_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 匹配 cc-web-YYYY-MM-DD.log 格式
        if !name.starts_with("cc-web-") || !name.ends_with(".log") {
            continue;
        }
        let date_str = &name[7..name.len() - 4]; // 提取 YYYY-MM-DD
        if let Ok(date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
            if date.and_hms_opt(0, 0, 0).unwrap() < cutoff.naive_local() {
                if fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
    }

    if removed > 0 {
        log::info!("已清理 {} 个过期日志文件（保留 {} 天）", removed, keep_days);
    }
}

/// 获取当前所有活跃会话的状态快照（用于调试 API）
pub fn format_state_snapshot(app_state: &crate::AppState) -> serde_json::Value {
    let sessions = app_state.sessions.read().unwrap();
    let streaming = app_state.streaming_sessions.read().unwrap();
    let events_tx = app_state.events_tx.read().unwrap();
    let pids = app_state.running_pids.read().unwrap();
    let streaming_state = app_state.streaming_state.read().unwrap();

    let mut session_details = Vec::new();
    for (id, session) in sessions.iter() {
        session_details.push(serde_json::json!({
            "id": id,
            "assistant": session.assistant,
            "model": session.model,
            "messageCount": session.messages.len(),
            "isStreaming": streaming.contains(id),
            "hasChannel": events_tx.contains_key(id),
            "channelReceivers": events_tx.get(id).map(|tx| tx.receiver_count()).unwrap_or(0),
            "pid": pids.get(id),
            "hasStreamingState": streaming_state.contains_key(id),
            "updatedAt": session.updated_at,
        }));
    }

    serde_json::json!({
        "timestamp": Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
        "totalSessions": sessions.len(),
        "streamingSessions": streaming.len(),
        "activeChannels": events_tx.len(),
        "runningProcesses": pids.len(),
        "sessions": session_details,
    })
}
