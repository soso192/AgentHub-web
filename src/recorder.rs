//! 接口录制（CDP）—— 移植 `Y:\ahnx\api-recorder-tool\server.js` 的分工与状态机。
//!
//! 原理：用 Chrome DevTools Protocol 控制一个**独立**浏览器实例，在浏览器层面抓
//! XHR/Fetch 请求（默认只收 `.do`），页面里只注入一个悬浮按钮，点击后通过
//! sessionStorage 与 cc-web 通信（400ms 轮询）。停止录制 = 自动导出脱敏 JSON 并关闭浏览器。
//!
//! 只在 implCon feature 下编译（`tokio-tungstenite` 是 optional 依赖，开发版 exe 不带）。
//!
//! API（给前端的契约，见 novice_chat.js 的录制交互）：
//! - POST /api/recorder/open   body `{ record_url, env_id? }`
//!   —— `record_url` 是新建排查表单里必填的录制页面地址（http/https 校验后直接使用）；
//!   旧前端只传 `env_id` 时仍按请求头 Authorization 查 patch_search 的环境记录兜底
//! - GET  /api/recorder/status → `{ success, state: idle|browser_open|recording|finished, file, interfaces }`
//! - POST /api/recorder/close  —— 停止录制（自动导出）并关闭浏览器
//!
//! 与原工具的差异（按待办清单「移植时修掉原工具的问题」）：
//! - 停止录制后继续处理在途请求的响应体（300ms 补齐窗口），不再丢最后一条报错请求的响应；
//! - 二进制响应按 mime 跳过，不再存乱码；
//! - 重定向的前一跳正确收尾（保留上一跳记录并标状态）；
//! - 录制数据不逐条写盘，停止时一次性导出（不再 2s 全量重写大文件）；
//! - 不移植 `/api/_eval`；
//! - 导出前脱敏：请求头去 Cookie/Authorization/token 类，请求体/响应体里的
//!   password/token 等字段掩码。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use actix_web::{web, HttpRequest, HttpResponse};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

/// 注入页面的悬浮按钮脚本（原样取自 api-recorder-tool/inject/overlay.js）
const OVERLAY_SRC: &str = include_str!("../static/recorder_overlay.js");
/// 一次录制最多保留的请求条数（防爆内存）
const MAX_RECORDS: usize = 5000;
/// 单个响应体最多保留的字符数
const MAX_BODY_CHARS: usize = 200_000;
/// 超过这个大小的响应体不取（字节）
const MAX_BODY_BYTES: i64 = 2 * 1024 * 1024;
/// 轮询页面录制按钮的表达式（与 overlay.js 的 sessionStorage 约定一致）
const POLL_EXPR: &str = "(function(){try{var st=sessionStorage.getItem(\"__REC_TOOL_STATE__\")||\"off\";\
var rq=sessionStorage.getItem(\"__REC_TOOL_REQ__\")||\"\";return st+\"|\"+rq;}catch(e){return \"\";}})()";

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ══════════════════════════════════════════════════════════════════
//  CDP 客户端：命令带 id + oneshot 应答；事件转给 event 任务
// ══════════════════════════════════════════════════════════════════

struct CdpClient {
    next_id: AtomicU64,
    sink: Mutex<futures::stream::SplitSink<WsStream, Message>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
}

impl CdpClient {
    /// 发一条 CDP 命令并等应答（带超时）。
    async fn send(&self, method: &str, params: Value, session: Option<&str>, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let mut payload = json!({ "id": id, "method": method, "params": params });
        if let Some(sid) = session {
            payload["sessionId"] = json!(sid);
        }
        {
            let mut sink = self.sink.lock().await;
            if let Err(error) = sink.send(Message::Text(payload.to_string().into())).await {
                self.pending.lock().await.remove(&id);
                return Err(format!("CDP 发送失败: {error}"));
            }
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("CDP 连接已关闭".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("CDP 超时: {method}"))
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════
//  状态
// ══════════════════════════════════════════════════════════════════

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Idle,
    Launching,
    Running,
}

#[derive(Clone, Default)]
struct Record {
    id: u64,
    time_ms: i64,
    method: String,
    url: String,
    kind: String,
    status: Option<i64>,
    duration_ms: i64,
    size: i64,
    mime: String,
    request_headers: Value,
    request_body: String,
    response_body: String,
    body_truncated: bool,
    failed: String,
    page_url: String,
}

struct SessionInfo {
    target_id: String,
    kind: String,
    url: String,
    enabled: bool,
    last_sig: String,
}

struct Inner {
    status: Status,
    recording: bool,
    started_at_ms: i64,
    records: Vec<Record>,
    next_id: u64,
    req_seq: i64,
    sessions: HashMap<String, SessionInfo>,
    /// "sessionId:requestId" → records 下标
    pending: HashMap<String, usize>,
    nav_url: String,
    child: Option<std::process::Child>,
    cdp: Option<Arc<CdpClient>>,
    exported: Option<String>,
    error: String,
}

impl Default for Inner {
    fn default() -> Self {
        Inner {
            status: Status::Idle,
            recording: false,
            started_at_ms: 0,
            records: Vec::new(),
            next_id: 1,
            req_seq: 0,
            sessions: HashMap::new(),
            pending: HashMap::new(),
            nav_url: String::new(),
            child: None,
            cdp: None,
            exported: None,
            error: String::new(),
        }
    }
}

fn state() -> &'static Arc<Mutex<Inner>> {
    static GLOBAL: OnceLock<Arc<Mutex<Inner>>> = OnceLock::new();
    GLOBAL.get_or_init(|| Arc::new(Mutex::new(Inner::default())))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ══════════════════════════════════════════════════════════════════
//  浏览器发现与启动
// ══════════════════════════════════════════════════════════════════

fn find_browser() -> Result<std::path::PathBuf, String> {
    let mut candidates: Vec<String> = Vec::new();
    // 1) 显式指定优先
    if let Ok(value) = std::env::var("CHROME_PATH") {
        let value = value.trim().to_string();
        if !value.is_empty() {
            candidates.push(value);
        }
    }
    // 2) Windows 常见安装位置（其它系统上这些路径不存在，is_file 会跳过）
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".to_string());
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".to_string());
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    for dir in [&pf, &pf86] {
        candidates.push(format!(r"{dir}\Google\Chrome\Application\chrome.exe"));
        candidates.push(format!(r"{dir}\Microsoft\Edge\Application\msedge.exe"));
    }
    if !local.is_empty() {
        candidates.push(format!(r"{local}\Google\Chrome\Application\chrome.exe"));
        candidates.push(format!(r"{local}\Microsoft\Edge\Application\msedge.exe"));
    }
    // 3) macOS 常见安装位置（系统级 + 用户级）
    for path in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ] {
        candidates.push(path.to_string());
    }
    if let Some(home) = dirs::home_dir() {
        for rel in [
            "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            candidates.push(home.join(rel).to_string_lossy().to_string());
        }
    }
    for candidate in candidates {
        let path = std::path::PathBuf::from(&candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    // 4) Linux（以及装在 PATH 里的其它情况）：按命令名搜 PATH
    let names = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
        "chrome",
    ];
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    Err("未找到 Chrome / Edge / Chromium，请安装浏览器，或设置环境变量 CHROME_PATH 指向浏览器可执行文件".to_string())
}

async fn wait_port_file(path: &std::path::Path, timeout: Duration) -> Result<u16, String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Some(first) = text.trim().lines().next() {
                if let Ok(port) = first.trim().parse::<u16>() {
                    if port > 0 {
                        return Ok(port);
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("浏览器调试端口未就绪（可能 Chrome 启动失败）".to_string())
}

async fn browser_ws_url(port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    let payload: Value = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("连接浏览器调试端口失败: {error}"))?
        .json()
        .await
        .map_err(|error| format!("无法解析 /json/version: {error}"))?;
    payload
        .get("webSocketDebuggerUrl")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| "浏览器没有返回 webSocketDebuggerUrl".to_string())
}

/// 关闭浏览器：杀进程 + 清会话状态（导出的文件记录保留）。
async fn close_browser() {
    let (child, had_exported) = {
        let mut inner = state().lock().await;
        let child = inner.child.take();
        inner.sessions.clear();
        inner.pending.clear();
        inner.recording = false;
        inner.cdp = None; // 置空后轮询任务自行退出；socket 会随浏览器退出关闭
        inner.status = Status::Idle;
        (child, inner.exported.is_some())
    };
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = had_exported; // 导出文件与浏览器生命周期无关，状态接口按 exported 判断 finished
}

/// 拉起浏览器并接管 CDP。`url` 非空时导航到该地址。
async fn launch(url: String) -> Result<(), String> {
    close_browser().await;
    {
        let mut inner = state().lock().await;
        inner.status = Status::Launching;
        inner.error.clear();
        inner.nav_url = url.clone();
        inner.records.clear();
        inner.next_id = 1;
        inner.req_seq = 0;
        inner.started_at_ms = 0;
        inner.exported = None;
    }

    let exe = find_browser()?;
    let profile_dir = crate::cc_web_temp_dir().join("recorder-profile");
    std::fs::create_dir_all(&profile_dir).map_err(|error| format!("创建浏览器配置目录失败: {error}"))?;
    let port_file = profile_dir.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);

    let mut command = std::process::Command::new(exe);
    command
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-popup-blocking")
        .arg("--disable-background-timer-throttling")
        .arg("--disable-renderer-backgrounding")
        .arg("--disable-backgrounding-occluded-windows")
        .arg("--window-size=1440,900")
        .arg("about:blank")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = command.spawn().map_err(|error| format!("启动浏览器失败: {error}"))?;
    {
        let mut inner = state().lock().await;
        inner.child = Some(child);
    }

    // 启动失败时尽早报错：端口文件等不到就杀进程收摊
    let port = match wait_port_file(&port_file, Duration::from_secs(25)).await {
        Ok(port) => port,
        Err(error) => {
            close_browser().await;
            let mut inner = state().lock().await;
            inner.status = Status::Idle;
            inner.error = error.clone();
            return Err(error);
        }
    };
    let ws_url = match browser_ws_url(port).await {
        Ok(value) => value,
        Err(error) => {
            close_browser().await;
            return Err(error);
        }
    };

    let mut ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    ws_config.max_message_size = Some(256 * 1024 * 1024);
    ws_config.max_frame_size = Some(256 * 1024 * 1024);
    let (ws, _) = tokio_tungstenite::connect_async_with_config(&ws_url, Some(ws_config), false)
        .await
        .map_err(|error| format!("连接浏览器 CDP 失败: {error}"))?;
    let (sink, mut stream) = ws.split();

    let pending_map: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let cdp = Arc::new(CdpClient {
        next_id: AtomicU64::new(1),
        sink: Mutex::new(sink),
        pending: pending_map.clone(),
    });
    {
        let mut inner = state().lock().await;
        inner.cdp = Some(cdp.clone());
    }

    // 读任务：应答按 id 分发，事件转给 event 任务
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let pending_reader = pending_map.clone();
    tokio::spawn(async move {
        while let Some(message) = stream.next().await {
            let text = match message {
                Ok(Message::Text(text)) => text.to_string(),
                Ok(Message::Binary(bytes)) => String::from_utf8_lossy(&bytes).to_string(),
                Ok(_) => continue,
                Err(_) => break,
            };
            let value: Value = match serde_json::from_str(&text) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if let Some(id) = value.get("id").and_then(|item| item.as_u64()) {
                if let Some(tx) = pending_reader.lock().await.remove(&id) {
                    if let Some(error) = value.get("error") {
                        let text = error.get("message").and_then(|m| m.as_str()).unwrap_or("CDP error").to_string();
                        let _ = tx.send(Err(text));
                    } else {
                        let _ = tx.send(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
                    }
                }
            } else if value.get("method").is_some() {
                let _ = event_tx.send(value);
            }
        }
        // 连接断开：唤醒所有等在应答上的命令
        let mut pending = pending_reader.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("CDP 连接已关闭".to_string()));
        }
    });

    // 事件任务
    let cdp_events = cdp.clone();
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            handle_event(&cdp_events, event).await;
        }
    });

    // 初始化：发现目标 + 自动挂载（接管新标签页和跨域 iframe）
    let _ = cdp.send("Target.setDiscoverTargets", json!({ "discover": true }), None, Duration::from_secs(15)).await;
    let _ = cdp
        .send(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
            None,
            Duration::from_secs(15),
        )
        .await;

    // 已存在的页面手动挂一次（不同 Chrome 版本行为略有差异）
    if let Ok(result) = cdp.send("Target.getTargets", json!({}), None, Duration::from_secs(10)).await {
        if let Some(infos) = result.get("targetInfos").and_then(|value| value.as_array()).cloned() {
            for info in infos {
                if info.get("type").and_then(|value| value.as_str()) != Some("page") {
                    continue;
                }
                if let Some(target_id) = info.get("targetId").and_then(|value| value.as_str()) {
                    let _ = cdp
                        .send(
                            "Target.attachToTarget",
                            json!({ "targetId": target_id, "flatten": true }),
                            None,
                            Duration::from_secs(10),
                        )
                        .await;
                }
            }
        }
    }

    {
        let mut inner = state().lock().await;
        if inner.child.is_none() {
            return Err("浏览器已退出".to_string());
        }
        inner.status = Status::Running;
    }
    // 轮询页面按钮（每 400ms）
    tokio::spawn(poll_loop());

    if !url.is_empty() {
        let sid = wait_for_page_session(Duration::from_secs(8))
            .await
            .ok_or_else(|| "没有可用的页面会话".to_string())?;
        // 导航前先把悬浮按钮脚本挂上（setup_session 里也挂过一次；overlay 自带防重复守卫）
        let _ = cdp
            .send(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": OVERLAY_SRC }),
                Some(&sid),
                Duration::from_secs(10),
            )
            .await;
        cdp.send("Page.navigate", json!({ "url": url }), Some(&sid), Duration::from_secs(15))
            .await
            .map_err(|error| format!("导航失败: {error}"))?;
    }
    Ok(())
}

async fn wait_for_page_session(timeout: Duration) -> Option<String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        {
            let inner = state().lock().await;
            for (sid, session) in inner.sessions.iter() {
                if session.kind == "page" {
                    return Some(sid.clone());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

// ══════════════════════════════════════════════════════════════════
//  会话与录制开关
// ══════════════════════════════════════════════════════════════════

async fn setup_session(cdp: &Arc<CdpClient>, sid: &str, target_info: &Value, waiting_for_debugger: bool) {
    let target_id = target_info.get("targetId").and_then(|value| value.as_str()).unwrap_or("").to_string();
    let kind = target_info.get("type").and_then(|value| value.as_str()).unwrap_or("").to_string();
    let url = target_info.get("url").and_then(|value| value.as_str()).unwrap_or("").to_string();
    let recording_now = {
        let mut inner = state().lock().await;
        if inner.sessions.contains_key(sid) {
            return;
        }
        // 同一个 target 可能被自动挂载和手动挂载各挂一次，只保留一个
        if inner.sessions.values().any(|session| session.target_id == target_id) {
            return;
        }
        inner.sessions.insert(
            sid.to_string(),
            SessionInfo { target_id, kind: kind.clone(), url, enabled: false, last_sig: String::new() },
        );
        inner.recording
    };

    let _ = cdp.send("Page.enable", json!({}), Some(sid), Duration::from_secs(10)).await;
    let _ = cdp.send("Runtime.enable", json!({}), Some(sid), Duration::from_secs(10)).await;
    if kind == "page" {
        let _ = cdp
            .send(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": OVERLAY_SRC }),
                Some(sid),
                Duration::from_secs(10),
            )
            .await;
        // 让跨进程 iframe（OOPIF）也能挂上
        let _ = cdp
            .send(
                "Target.setAutoAttach",
                json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
                Some(sid),
                Duration::from_secs(10),
            )
            .await;
    }
    if recording_now {
        enable_network(cdp, sid).await;
    }
    if waiting_for_debugger {
        let _ = cdp.send("Runtime.runIfWaitingForDebugger", json!({}), Some(sid), Duration::from_secs(10)).await;
    }
}

async fn enable_network(cdp: &Arc<CdpClient>, sid: &str) {
    let should = {
        let inner = state().lock().await;
        match inner.sessions.get(sid) {
            Some(session) => !session.enabled,
            None => false,
        }
    };
    if !should {
        return;
    }
    if cdp
        .send(
            "Network.enable",
            json!({ "maxTotalBufferSize": 200 * 1024 * 1024, "maxResourceBufferSize": 20 * 1024 * 1024 }),
            Some(sid),
            Duration::from_secs(10),
        )
        .await
        .is_ok()
    {
        let mut inner = state().lock().await;
        if let Some(session) = inner.sessions.get_mut(sid) {
            session.enabled = true;
        }
    }
}

/// 录制开/关。开：所有会话开网络；关：推送按钮状态 → 补齐在途响应体 → 导出 → 关浏览器。
async fn set_recording(on: bool) {
    let (all_sids, page_sids, changed) = {
        let mut inner = state().lock().await;
        if inner.recording == on {
            return;
        }
        inner.recording = on;
        if on {
            inner.pending.clear();
            inner.started_at_ms = now_ms();
        }
        let all: Vec<String> = inner.sessions.keys().cloned().collect();
        let pages: Vec<String> = inner
            .sessions
            .iter()
            .filter(|(_, session)| session.kind == "page")
            .map(|(sid, _)| sid.clone())
            .collect();
        (all, pages, true)
    };
    if !changed {
        return;
    }
    let cdp = {
        let inner = state().lock().await;
        inner.cdp.clone()
    };
    if let Some(cdp) = cdp {
        if on {
            for sid in &all_sids {
                enable_network(&cdp, sid).await;
            }
        }
        for sid in &page_sids {
            push_state(&cdp, sid, on).await;
        }
    }
    if !on {
        flush_and_export_and_close().await;
    }
}

/// 把录制状态推给页面悬浮按钮（页面跳转/加载后也用它纠正显示）
async fn push_state(cdp: &Arc<CdpClient>, sid: &str, on: bool) {
    let value = if on { "on" } else { "off" };
    let _ = cdp
        .send(
            "Runtime.evaluate",
            json!({ "expression": format!("window.__recToolSet && window.__recToolSet(\"{value}\")"), "returnByValue": false }),
            Some(sid),
            Duration::from_secs(4),
        )
        .await;
}

/// 停止后补齐在途响应体 → 导出脱敏 JSON → 关闭浏览器。
async fn flush_and_export_and_close() {
    // 1) 补齐还没取回的响应体（最多 300ms，关浏览器前给最后那条报错请求留时间）
    let jobs: Vec<(String, String, usize)> = {
        let inner = state().lock().await;
        inner
            .pending
            .iter()
            .filter_map(|(key, idx)| {
                let record = inner.records.get(*idx)?;
                if record.status.is_none() && record.failed.is_empty() {
                    return None; // 还没响应，补也补不到
                }
                let (sid, request_id) = key.split_once(':')?;
                Some((sid.to_string(), request_id.to_string(), *idx))
            })
            .collect()
    };
    {
        let mut inner = state().lock().await;
        inner.pending.clear();
    }
    if !jobs.is_empty() {
        let cdp = {
            let inner = state().lock().await;
            inner.cdp.clone()
        };
        if let Some(cdp) = cdp {
            let mut handles = Vec::new();
            for (sid, request_id, idx) in jobs {
                let cdp = cdp.clone();
                handles.push(async move { fetch_response_body(&cdp, &sid, &request_id, idx).await });
            }
            let all = futures::future::join_all(handles);
            let _ = tokio::time::timeout(Duration::from_millis(300), all).await;
        }
    }

    // 2) 导出
    let payload = {
        let inner = state().lock().await;
        let interfaces: Vec<Value> = inner
            .records
            .iter()
            .map(|record| {
                let mut item = Map::new();
                item.insert("id".to_string(), json!(record.id));
                item.insert("time".to_string(), json!(record.time_ms));
                item.insert("method".to_string(), json!(record.method));
                item.insert("url".to_string(), json!(record.url));
                item.insert("type".to_string(), json!(record.kind));
                item.insert("status".to_string(), json!(record.status));
                item.insert("duration".to_string(), json!(record.duration_ms));
                item.insert("size".to_string(), json!(record.size));
                item.insert("mime".to_string(), json!(record.mime));
                item.insert("failed".to_string(), json!(record.failed));
                if !record.failed.is_empty() {
                    item.insert("error".to_string(), json!(record.failed));
                }
                item.insert("pageUrl".to_string(), json!(record.page_url));
                item.insert("requestHeaders".to_string(), sanitize_headers(&record.request_headers));
                item.insert("requestBody".to_string(), json!(mask_sensitive_body(&record.request_body)));
                item.insert("responseBody".to_string(), json!(mask_sensitive_body(&record.response_body)));
                item.insert("bodyTruncated".to_string(), json!(record.body_truncated));
                Value::Object(item)
            })
            .collect();
        if interfaces.is_empty() {
            None
        } else {
            Some(json!({
                "exportedAt": now_ms(),
                "startedAt": inner.started_at_ms,
                "pageUrl": inner.nav_url,
                "interfaces": interfaces,
            }))
        }
    };
    if let Some(payload) = payload {
        // 导出文件放在 cc-web.exe 所在目录的 recordings 下，文件名全英文（避免中文路径带来的编码问题）
        let dir = crate::cc_web_install_dir().join("recordings");
        let _ = std::fs::create_dir_all(&dir);
        let stamp = chrono::Local::now().format("%Y%m%d%H%M%S").to_string();
        let file = dir.join(format!("record_{stamp}.json"));
        if std::fs::write(&file, serde_json::to_string_pretty(&payload).unwrap_or_default()).is_ok() {
            let mut inner = state().lock().await;
            inner.exported = Some(file.to_string_lossy().to_string());
        }
    }

    // 3) 关浏览器
    close_browser().await;
}

// ══════════════════════════════════════════════════════════════════
//  CDP 事件
// ══════════════════════════════════════════════════════════════════

async fn handle_event(cdp: &Arc<CdpClient>, event: Value) {
    let method = event.get("method").and_then(|value| value.as_str()).unwrap_or("").to_string();
    let params = event.get("params").cloned().unwrap_or(Value::Null);
    let sid = event.get("sessionId").and_then(|value| value.as_str()).unwrap_or("").to_string();

    if method == "Target.attachedToTarget" {
        let new_sid = params.get("sessionId").and_then(|value| value.as_str()).unwrap_or("").to_string();
        let waiting = params.get("waitingForDebugger").and_then(|value| value.as_bool()).unwrap_or(false);
        let target_info = params.get("targetInfo").cloned().unwrap_or(Value::Null);
        if !new_sid.is_empty() {
            setup_session(cdp, &new_sid, &target_info, waiting).await;
        }
        return;
    }
    if method == "Target.detachedFromTarget" {
        let dead = params.get("sessionId").and_then(|value| value.as_str()).unwrap_or("").to_string();
        let mut inner = state().lock().await;
        inner.sessions.remove(&dead);
        inner.pending.retain(|key, _| !key.starts_with(&format!("{dead}:")));
        return;
    }
    if method == "Target.targetDestroyed" {
        let target_id = params.get("targetId").and_then(|value| value.as_str()).unwrap_or("").to_string();
        let mut inner = state().lock().await;
        let dead: Vec<String> = inner
            .sessions
            .iter()
            .filter(|(_, session)| session.target_id == target_id)
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in dead {
            inner.sessions.remove(&sid);
            inner.pending.retain(|key, _| !key.starts_with(&format!("{sid}:")));
        }
        return;
    }
    if method == "Page.frameNavigated" {
        let is_top = params.get("frame").and_then(|frame| frame.get("parentId")).is_none();
        if is_top {
            let url = params
                .get("frame")
                .and_then(|frame| frame.get("url"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let recording = {
                let mut inner = state().lock().await;
                if let Some(session) = inner.sessions.get_mut(&sid) {
                    if !url.is_empty() {
                        session.url = url;
                    }
                }
                inner.recording
            };
            // 页面跳转后重新同步录制按钮状态
            let cdp = cdp.clone();
            let sid2 = sid.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                push_state(&cdp, &sid2, recording).await;
            });
        }
        return;
    }
    if method == "Page.loadEventFired" {
        let recording = {
            let inner = state().lock().await;
            inner.recording
        };
        let cdp = cdp.clone();
        let sid2 = sid.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            push_state(&cdp, &sid2, recording).await;
        });
        return;
    }

    if !method.starts_with("Network.") {
        return;
    }
    let recording = {
        let inner = state().lock().await;
        inner.recording && inner.sessions.contains_key(&sid)
    };
    if !recording {
        return;
    }
    let request_id = params.get("requestId").and_then(|value| value.as_str()).unwrap_or("").to_string();
    if request_id.is_empty() {
        return;
    }
    let key = format!("{sid}:{request_id}");

    match method.as_str() {
        "Network.requestWillBeSent" => {
            let request = params.get("request").cloned().unwrap_or(Value::Null);
            let kind = params.get("type").and_then(|value| value.as_str()).unwrap_or("Other").to_string();
            // 重定向：前一跳收尾（同一个 requestId 会被新请求复用）
            if let Some(redirect) = params.get("redirectResponse") {
                let status = redirect.get("status").and_then(|value| value.as_i64());
                let mut inner = state().lock().await;
                if let Some(idx) = inner.pending.get(&key).copied() {
                    if let Some(record) = inner.records.get_mut(idx) {
                        record.status = status;
                        record.duration_ms = now_ms() - record.time_ms;
                    }
                }
            }
            if !(kind == "XHR" || kind == "Fetch") {
                return;
            }
            let url = request.get("url").and_then(|value| value.as_str()).unwrap_or("").to_string();
            // 默认只收 .do 接口（小白排查的目标是 NC 后端 action）
            if !url.to_lowercase().contains(".do") {
                return;
            }
            let page_url = {
                let inner = state().lock().await;
                inner.sessions.get(&sid).map(|session| session.url.clone()).unwrap_or_default()
            };
            let has_post_data = request.get("hasPostData").and_then(|value| value.as_bool()).unwrap_or(false);
            let post_data = request.get("postData").and_then(|value| value.as_str()).unwrap_or("").to_string();
            {
                let mut inner = state().lock().await;
                let id = inner.next_id;
                inner.next_id += 1;
                let record = Record {
                    id,
                    time_ms: now_ms(),
                    method: request.get("method").and_then(|value| value.as_str()).unwrap_or("GET").to_string(),
                    url,
                    kind,
                    request_headers: request.get("headers").cloned().unwrap_or(Value::Null),
                    request_body: post_data,
                    page_url,
                    ..Default::default()
                };
                inner.records.push(record);
                if inner.records.len() > MAX_RECORDS {
                    let overflow = inner.records.len() - MAX_RECORDS;
                    inner.records.drain(0..overflow);
                    // pending 里的下标整体前移
                    for value in inner.pending.values_mut() {
                        *value = value.saturating_sub(overflow);
                    }
                }
                let idx = inner.records.len() - 1;
                inner.pending.insert(key.clone(), idx);
            }
            if has_post_data {
                let cdp = cdp.clone();
                let sid2 = sid.clone();
                let request_id2 = request_id.clone();
                let key2 = key.clone();
                tokio::spawn(async move {
                    if let Ok(result) = cdp
                        .send("Network.getRequestPostData", json!({ "requestId": request_id2 }), Some(&sid2), Duration::from_secs(5))
                        .await
                    {
                        if let Some(post_data) = result.get("postData").and_then(|value| value.as_str()) {
                            let mut inner = state().lock().await;
                            if let Some(idx) = inner.pending.get(&key2).copied() {
                                if let Some(record) = inner.records.get_mut(idx) {
                                    if record.request_body.is_empty() {
                                        record.request_body = post_data.to_string();
                                    }
                                }
                            }
                        }
                    }
                });
            }
        }
        "Network.responseReceived" => {
            let response = params.get("response").cloned().unwrap_or(Value::Null);
            let mut inner = state().lock().await;
            if let Some(idx) = inner.pending.get(&key).copied() {
                if let Some(record) = inner.records.get_mut(idx) {
                    record.status = response.get("status").and_then(|value| value.as_i64());
                    record.mime = response.get("mimeType").and_then(|value| value.as_str()).unwrap_or("").to_string();
                    record.request_headers = record.request_headers.clone(); // 保持原样（导出时脱敏）
                }
            }
        }
        "Network.loadingFinished" => {
            let size = params.get("encodedDataLength").and_then(|value| value.as_f64()).unwrap_or(0.0) as i64;
            let idx = {
                let mut inner = state().lock().await;
                let idx = inner.pending.remove(&key);
                if let Some(idx) = idx {
                    if let Some(record) = inner.records.get_mut(idx) {
                        record.size = size;
                        record.duration_ms = now_ms() - record.time_ms;
                    }
                }
                idx
            };
            if let Some(idx) = idx {
                let cdp = cdp.clone();
                let sid2 = sid.clone();
                let request_id2 = request_id.clone();
                tokio::spawn(async move {
                    fetch_response_body(&cdp, &sid2, &request_id2, idx).await;
                });
            }
        }
        "Network.loadingFailed" => {
            let error_text = params.get("errorText").and_then(|value| value.as_str()).unwrap_or("failed").to_string();
            let mut inner = state().lock().await;
            if let Some(idx) = inner.pending.remove(&key) {
                if let Some(record) = inner.records.get_mut(idx) {
                    record.failed = error_text;
                    record.status = Some(0);
                    record.duration_ms = now_ms() - record.time_ms;
                }
            }
        }
        _ => {}
    }
}

/// 取响应体：只取文本类、限大小；二进制按 mime 跳过（不存乱码）。
async fn fetch_response_body(cdp: &Arc<CdpClient>, sid: &str, request_id: &str, idx: usize) {
    let (size, mime) = {
        let inner = state().lock().await;
        match inner.records.get(idx) {
            Some(record) => (record.size, record.mime.clone()),
            None => return,
        }
    };
    if size > MAX_BODY_BYTES {
        let mut inner = state().lock().await;
        if let Some(record) = inner.records.get_mut(idx) {
            record.response_body = format!("[响应体过大，已跳过：{size} 字节]");
        }
        return;
    }
    // 二进制响应（图片/字体/压缩包等）没有阅读价值，跳过
    let lower = mime.to_lowercase();
    let is_binary_mime = ["image/", "font/", "audio/", "video/", "application/octet-stream", "application/zip", "application/pdf"]
        .iter()
        .any(|prefix| lower.starts_with(prefix));
    if is_binary_mime {
        let mut inner = state().lock().await;
        if let Some(record) = inner.records.get_mut(idx) {
            record.response_body = format!("[二进制内容（{mime}），已跳过]");
        }
        return;
    }
    let result = cdp
        .send("Network.getResponseBody", json!({ "requestId": request_id }), Some(sid), Duration::from_secs(8))
        .await;
    let mut inner = state().lock().await;
    let Some(record) = inner.records.get_mut(idx) else { return };
    match result {
        Ok(value) => {
            let mut body = value.get("body").and_then(|item| item.as_str()).unwrap_or("").to_string();
            if value.get("base64Encoded").and_then(|item| item.as_bool()).unwrap_or(false) {
                body = decode_base64(&body).unwrap_or_else(|| "[二进制内容，已跳过]".to_string());
            }
            if body.chars().count() > MAX_BODY_CHARS {
                body = body.chars().take(MAX_BODY_CHARS).collect();
                record.body_truncated = true;
            }
            record.response_body = body;
        }
        Err(error) => {
            record.response_body = format!("[无法获取响应体：{error}]");
        }
    }
}

// ══════════════════════════════════════════════════════════════════
//  轮询页面上的录制按钮（sessionStorage 通信，避免 CSP / 跨域限制）
// ══════════════════════════════════════════════════════════════════

async fn poll_loop() {
    loop {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let (alive, page_sids, cdp) = {
            let inner = state().lock().await;
            let alive = inner.child.is_some() && inner.status == Status::Running;
            (
                alive,
                inner
                    .sessions
                    .iter()
                    .filter(|(_, session)| session.kind == "page")
                    .map(|(sid, _)| sid.clone())
                    .collect::<Vec<_>>(),
                inner.cdp.clone(),
            )
        };
        if !alive || cdp.is_none() {
            break;
        }
        let cdp = cdp.unwrap();
        for sid in page_sids {
            let result = cdp
                .send(
                    "Runtime.evaluate",
                    json!({ "expression": POLL_EXPR, "returnByValue": true }),
                    Some(&sid),
                    Duration::from_secs(3),
                )
                .await;
            let Ok(result) = result else { continue };
            let value = result
                .get("result")
                .and_then(|item| item.get("value"))
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .to_string();
            if value.is_empty() {
                continue;
            }
            let mut parts = value.splitn(2, '|');
            let st = parts.next().unwrap_or("").to_string();
            let rq = parts.next().unwrap_or("").to_string();

            if !rq.is_empty() {
                let changed = {
                    let mut inner = state().lock().await;
                    match inner.sessions.get_mut(&sid) {
                        Some(session) if session.last_sig != rq => {
                            session.last_sig = rq.clone();
                            true
                        }
                        _ => false,
                    }
                };
                if changed {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&rq) {
                        let seq = parsed.get("seq").and_then(|item| item.as_i64()).unwrap_or(0);
                        let on = parsed.get("on").and_then(|item| item.as_bool()).unwrap_or(false);
                        let should_apply = {
                            let mut inner = state().lock().await;
                            if seq > inner.req_seq {
                                inner.req_seq = seq;
                                true
                            } else {
                                false
                            }
                        };
                        if should_apply {
                            set_recording(on).await;
                        }
                    }
                }
            }

            // 页面上的显示状态与工具不一致（比如跳转后），纠正一下
            let expected = if state().lock().await.recording { "on" } else { "off" };
            if st != expected {
                push_state(&cdp, &sid, expected == "on").await;
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════
//  脱敏与 base64
// ══════════════════════════════════════════════════════════════════

fn is_sensitive_header(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "cookie"
        || lower == "set-cookie"
        || lower == "authorization"
        || lower == "proxy-authorization"
        || lower.contains("token")
        || lower.contains("csrf")
        || lower.contains("xsrf")
}

/// 请求头脱敏：Cookie / Authorization / token 类一律去掉值（保留键名，便于看出带了什么头）。
fn sanitize_headers(headers: &Value) -> Value {
    let Some(map) = headers.as_object() else { return Value::Null };
    let mut out = Map::new();
    for (key, value) in map {
        if is_sensitive_header(key) {
            out.insert(key.clone(), json!("[已移除]"));
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

/// 请求体/响应体脱敏：把 JSON 风格 `"password": "..."` / `"token": "..."` 的值换成 ******，
/// 以及 `password=...&` 这种表单串。只做字符串级处理——宁可多掩，不漏。
fn mask_sensitive_body(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let sensitive_keys = ["password", "passwd", "pwd", "token", "secret", "credential", "authorization", "cookie"];
    let is_sensitive_key = |key: &str| {
        let lower = key.to_lowercase();
        sensitive_keys.iter().any(|needle| lower.contains(needle))
    };

    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let ch = bytes[i];
        // JSON 风格："key"\s*:\s*"value"
        if ch == b'"' {
            // 解析 key
            if let Some(end) = find_string_end(bytes, i + 1) {
                let key = &text[i + 1..end];
                // 跳过空白找冒号
                let mut j = end + 1;
                while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b':' {
                    let mut k = j + 1;
                    while k < bytes.len() && (bytes[k] as char).is_whitespace() {
                        k += 1;
                    }
                    if k < bytes.len() && bytes[k] == b'"' {
                        if let Some(value_end) = find_string_end(bytes, k + 1) {
                            out.push('"');
                            out.push_str(key);
                            out.push_str("\":\"");
                            if is_sensitive_key(key) {
                                out.push_str("******");
                            } else {
                                out.push_str(&text[k + 1..value_end]);
                            }
                            out.push('"');
                            i = value_end + 1;
                            continue;
                        }
                    }
                }
                // 不是 key:value 结构，原样输出这个字符串
                out.push_str(&text[i..end + 1]);
                i = end + 1;
                continue;
            }
        }
        // 普通字符：按 UTF-8 字符边界整段拷贝（中文/emoji 不能按字节输出，否则会乱码）
        let char_len = match ch {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            _ => 4,
        };
        let end = (i + char_len).min(bytes.len());
        out.push_str(&text[i..end]);
        i = end;
    }
    // 表单风格单独扫一遍（JSON 处理已原样保留这些文本）
    mask_form_fields(&out)
}

fn find_string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

/// `key=value` 表单串里掩掉敏感值
fn mask_form_fields(text: &str) -> String {
    let sensitive_keys = ["password", "passwd", "pwd", "token=", "secret=", "credential="];
    let mut out = String::with_capacity(text.len());
    let lower = text.to_lowercase();
    let mut i = 0usize;
    while i < text.len() {
        let rest = &lower[i..];
        let mut matched = None;
        for key in sensitive_keys {
            // 要求前面是起始/&/?/空白，避免误伤 "notoken="
            if rest.starts_with(key) {
                let prev_ok = i == 0
                    || matches!(text.as_bytes()[i - 1], b'&' | b'?' | b' ' | b'\n' | b'\r' | b';');
                if prev_ok {
                    matched = Some(key.len());
                    break;
                }
            }
        }
        if let Some(key_len) = matched {
            // 原样输出 key= 部分，值换成 ******
            out.push_str(&text[i..i + key_len]);
            let mut j = i + key_len;
            while j < text.len() && !matches!(text.as_bytes()[j], b'&' | b' ' | b'\n' | b'\r' | b';') {
                j += 1;
            }
            out.push_str("******");
            i = j;
            continue;
        }
        let ch = text[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 最小 base64 解码（CDP 的 base64Encoded 响应体用；无第三方依赖）
fn decode_base64(input: &str) -> Option<String> {
    fn value(ch: u8) -> Option<u8> {
        match ch {
            b'A'..=b'Z' => Some(ch - b'A'),
            b'a'..=b'z' => Some(ch - b'a' + 26),
            b'0'..=b'9' => Some(ch - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut bytes = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for &ch in input.as_bytes() {
        if ch == b'=' || ch == b'\n' || ch == b'\r' {
            continue;
        }
        let v = value(ch)?;
        buffer = (buffer << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
        }
    }
    String::from_utf8(bytes).ok()
}

// ══════════════════════════════════════════════════════════════════
//  HTTP 接口
// ══════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
pub struct OpenRequest {
    /// 兼容旧前端：没传 record_url 时按环境里登记的地址兜底
    pub env_id: Option<i64>,
    /// 新建排查表单里填的录制页面地址（2026-11 起由前端必填并直接传入）
    pub record_url: Option<String>,
}

/// 录制页面地址必须是 http/https（前端也校验，这里兜底）
fn validate_record_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().to_string();
    if url.is_empty() {
        return Err("缺少「录制页面地址」".to_string());
    }
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("「录制页面地址」必须是 http/https 地址".to_string());
    }
    Ok(url)
}

fn ok(data: Value) -> HttpResponse {
    HttpResponse::Ok().json(json!({ "success": true, "data": data }))
}

fn fail(status: u16, message: &str) -> HttpResponse {
    let mut response = match status {
        400 => HttpResponse::BadRequest(),
        401 => HttpResponse::Unauthorized(),
        404 => HttpResponse::NotFound(),
        409 => HttpResponse::Conflict(),
        _ => HttpResponse::InternalServerError(),
    };
    response.json(json!({ "success": false, "error": message }))
}

/// 用调用方转发来的 token 从 patch_search 查产品环境的「录制页面地址」。
/// 不信任前端传 URL：地址只从服务器上的环境记录取。
async fn fetch_record_url(req: &HttpRequest, env_id: i64) -> Result<String, String> {
    let auth = req
        .headers()
        .get("Authorization")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少登录凭据（Authorization 头）".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    let servers = crate::api::patch_config::patch_search_servers();
    if servers.is_empty() {
        return Err("补丁中心地址未配置".to_string());
    }
    for base in servers {
        let url = format!("{base}/api/project-envs");
        let response = match client.get(&url).header("Authorization", &auth).send().await {
            Ok(response) => response,
            Err(_) => continue, // 连不上换下一条
        };
        if !response.status().is_success() {
            continue;
        }
        let payload: Value = match response.json().await {
            Ok(value) => value,
            Err(_) => continue,
        };
        let list = payload.get("data").and_then(|value| value.as_array()).cloned().unwrap_or_default();
        if let Some(env) = list
            .iter()
            .find(|item| item.get("id").and_then(|value| value.as_i64()) == Some(env_id))
        {
            let record_url = env.get("record_url").and_then(|value| value.as_str()).unwrap_or("");
            return validate_record_url(record_url)
                .map_err(|_| "该产品环境没有配置「录制页面地址」".to_string());
        }
    }
    Err("找不到该产品环境（可能是登录已失效，或环境已被删除）".to_string())
}

/// POST /api/recorder/open
pub async fn open(req: HttpRequest, body: web::Json<OpenRequest>) -> HttpResponse {
    // 优先用新建排查表单里填的地址；旧调用方只传 env_id 时仍按环境记录兜底
    let record_url = if let Some(raw) = body.record_url.as_deref() {
        match validate_record_url(raw) {
            Ok(value) => value,
            Err(error) => return fail(400, &error),
        }
    } else if let Some(env_id) = body.env_id {
        match fetch_record_url(&req, env_id).await {
            Ok(value) => value,
            Err(error) => return fail(400, &error),
        }
    } else {
        return fail(400, "缺少「录制页面地址」");
    };
    match launch(record_url).await {
        Ok(()) => ok(Value::Null),
        Err(error) => fail(500, &error),
    }
}

/// GET /api/recorder/status
pub async fn status() -> HttpResponse {
    let mut inner = state().lock().await;
    // 浏览器被用户直接关掉：进程已退出 → 回收（没点停止就没导出，前端据此提示重录）
    if let Some(child) = inner.child.as_mut() {
        if let Ok(Some(_)) = child.try_wait() {
            inner.child = None;
            inner.cdp = None;
            inner.recording = false;
            inner.sessions.clear();
            inner.pending.clear();
            inner.status = Status::Idle;
        }
    }
    let state_name = if inner.child.is_some() {
        if inner.recording { "recording" } else { "browser_open" }
    } else if inner.exported.is_some() {
        "finished"
    } else {
        "idle"
    };
    let interfaces: Vec<Value> = inner
        .records
        .iter()
        .take(300)
        .map(|record| json!({
            "method": record.method,
            "url": record.url,
            "status": record.status,
            "failed": record.failed,
        }))
        .collect();
    let payload = json!({
        "success": true,
        "state": state_name,
        "file": inner.exported,
        "interfaces": interfaces,
        "error": inner.error,
    });
    HttpResponse::Ok().json(payload)
}

/// POST /api/recorder/close —— 停止录制（自动导出）并关闭浏览器
pub async fn close() -> HttpResponse {
    let recording = {
        let inner = state().lock().await;
        inner.recording
    };
    if recording {
        // 走停止流程：补齐在途响应体 → 导出 → 关浏览器
        set_recording(false).await;
    } else {
        close_browser().await;
    }
    ok(Value::Null)
}
