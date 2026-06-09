use super::{AiAssistant, types::*};
use super::streaming::StreamResult;
use async_trait::async_trait;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Pi Coding Agent assistant implementation
pub struct PiAssistant {
    sessions: HashMap<String, PiSession>,
    default_model: String,
    pi_cmd: String,
}

struct PiSession {
    cwd: String,
    model: String,
    /// Path to the pi session file for --resume
    session_file: Option<String>,
}

impl Clone for PiSession {
    fn clone(&self) -> Self {
        Self {
            cwd: self.cwd.clone(),
            model: self.model.clone(),
            session_file: self.session_file.clone(),
        }
    }
}

impl PiAssistant {
    fn create_pi_command(&self) -> Command {
        if self.pi_cmd.starts_with("node:") {
            let cli_js = &self.pi_cmd[5..];
            let sep = if cli_js.contains('\\') { "\\node_modules\\" } else { "/node_modules/" };
            if let Some(idx) = cli_js.find(sep) {
                let base_path = &cli_js[..idx];
                let node_exe = format!("{}{}node.exe", base_path, if cli_js.contains('\\') { "\\" } else { "/" });
                if std::path::Path::new(&node_exe).exists() {
                    let mut cmd = Command::new(&node_exe);
                    cmd.arg(cli_js);
                    return cmd;
                }
            }
            let mut cmd = Command::new("node");
            cmd.arg(cli_js);
            cmd
        } else if self.pi_cmd.ends_with(".cmd") {
            let mut cmd = Command::new("cmd.exe");
            cmd.arg("/C").arg(&self.pi_cmd);
            cmd
        } else {
            Command::new(&self.pi_cmd)
        }
    }

    pub fn new() -> Self {
        // Find the pi CLI executable
        let pi_cmd = Self::find_pi_cmd();

        Self {
            sessions: HashMap::new(),
            default_model: "mimo-v2.5-pro".to_string(),
            pi_cmd,
        }
    }

    /// Find the session file path from a UUID by searching ~/.pi/agent/sessions/
    fn find_session_file(uuid: &str) -> Option<String> {
        let sessions_dir = dirs::home_dir()?.join(".pi").join("agent").join("sessions");
        for entry in std::fs::read_dir(&sessions_dir).ok()? {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_dir() {
                continue;
            }
            for file in std::fs::read_dir(entry.path()).ok()? {
                let file = file.ok()?;
                let name = file.file_name().to_string_lossy().to_string();
                if name.contains(uuid) && name.ends_with(".jsonl") {
                    return Some(file.path().to_string_lossy().to_string());
                }
            }
        }
        None
    }

    /// Read the provider name for a model from pi's models.json
    fn find_provider_for_model(model: &str) -> Option<String> {
        let models_path = dirs::home_dir()?.join(".pi").join("agent").join("models.json");
        let content = std::fs::read_to_string(models_path).ok()?;
        let config: serde_json::Value = serde_json::from_str(&content).ok()?;
        let providers = config.get("providers")?.as_object()?;

        // First try: find the exact model in a provider
        for (provider_name, provider_config) in providers {
            if let Some(models) = provider_config.get("models").and_then(|m| m.as_array()) {
                for m in models {
                    if m.get("id").and_then(|id| id.as_str()) == Some(model) {
                        return Some(provider_name.clone());
                    }
                }
            }
        }

        // Fallback: use the first provider that has an API key configured
        for (provider_name, provider_config) in providers {
            if provider_config.get("apiKey").and_then(|k| k.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
                log::warn!("[pi] model '{}' not found, falling back to provider '{}'", model, provider_name);
                return Some(provider_name.clone());
            }
        }

        None
    }

    fn find_pi_cmd() -> String {
        // 1. Check PI_CMD environment variable
        if let Ok(pi_path) = std::env::var("PI_CMD") {
            if std::path::Path::new(&pi_path).exists() {
                return pi_path;
            }
        }

        // 2. Try running `pi` directly (works if in PATH)
        if Command::new("pi").arg("--version").output().map(|o| o.status.success()).unwrap_or(false) {
            return "pi".to_string();
        }

        // 3. Search common installation paths
        if let Some(home) = dirs::home_dir() {
            // npm global: ~/.npm-global/bin/pi or AppData/Roaming/npm/pi
            let npm_paths = vec![
                home.join("AppData").join("Roaming").join("npm").join("pi.cmd"),
                home.join("AppData").join("Roaming").join("npm").join("pi"),
                home.join(".npm-global").join("bin").join("pi"),
            ];
            for path in &npm_paths {
                if path.exists() {
                    return path.to_string_lossy().to_string();
                }
            }

            // pi-node: ~/AppData/Local/pi-node/current/
            let pi_node = home.join("AppData").join("Local").join("pi-node").join("current");
            if pi_node.exists() {
                // Prefer direct node.exe + cli.js invocation
                let node_exe = pi_node.join("node.exe");
                let cli_js = pi_node.join("node_modules").join("@earendil-works").join("pi-coding-agent").join("dist").join("cli.js");
                if node_exe.exists() && cli_js.exists() {
                    return format!("node:{}", cli_js.to_string_lossy());
                }
                // Fallback to pi.cmd
                let pi_cmd = pi_node.join("pi.cmd");
                if pi_cmd.exists() {
                    return pi_cmd.to_string_lossy().to_string();
                }
            }
        }

        // 4. Fallback to just "pi"
        "pi".to_string()
    }
}

#[async_trait]
impl AiAssistant for PiAssistant {
    fn name(&self) -> &str {
        "pi"
    }

    fn display_name(&self) -> &str {
        "Pi Agent"
    }

    fn available_models(&self) -> Vec<ModelInfo> {
        vec![
            ModelInfo {
                id: "mimo-v2.5-pro".to_string(),
                name: "MiMo v2.5 Pro".to_string(),
                provider: "xiaomi".to_string(),
                max_tokens: Some(200000),
                supports_streaming: true,
                supports_tools: true,
            },
            ModelInfo {
                id: "anthropic/claude-sonnet-4-20250514".to_string(),
                name: "Claude Sonnet 4".to_string(),
                provider: "anthropic".to_string(),
                max_tokens: Some(200000),
                supports_streaming: true,
                supports_tools: true,
            },
            ModelInfo {
                id: "anthropic/claude-opus-4-20250514".to_string(),
                name: "Claude Opus 4".to_string(),
                provider: "anthropic".to_string(),
                max_tokens: Some(200000),
                supports_streaming: true,
                supports_tools: true,
            },
        ]
    }

    fn default_model(&self) -> &str {
        &self.default_model
    }

    async fn create_session(&mut self, cwd: String, model: Option<String>) -> Result<String, String> {
        let session_id = Uuid::new_v4().to_string();
        let model = model.unwrap_or_else(|| self.default_model.clone());

        self.sessions.insert(session_id.clone(), PiSession {
            cwd,
            model,
            session_file: None,
        });

        Ok(session_id)
    }

    async fn send_message(&self, session_id: &str, message: &str) -> Result<AiResponse, String> {
        let session = self.sessions.get(session_id)
            .ok_or_else(|| "Session not found".to_string())?
            .clone();

        let cwd = session.cwd.clone();
        let model = session.model.clone();
        let message = message.to_string();
        let pi_cmd = self.pi_cmd.clone();

        let result = tokio::task::spawn_blocking(move || {
            let mut args = vec![
                "--print".to_string(),
                "--mode".to_string(),
                "text".to_string(),
                "--model".to_string(),
                model.clone(),
            ];

            // Resume session if we have a session file
            if let Some(ref session_file) = session.session_file {
                args.push("--session".to_string());
                args.push(session_file.clone());
            }

            args.push(message.clone());

            let mut cmd = if pi_cmd.starts_with("node:") {
                let cli_js = &pi_cmd[5..];
                let sep = if cli_js.contains('\\') { "\\node_modules\\" } else { "/node_modules/" };
                let node_exe = cli_js.find(sep)
                    .map(|idx| {
                        let base = &cli_js[..idx];
                        let slash = if cli_js.contains('\\') { "\\" } else { "/" };
                        format!("{}{}node.exe", base, slash)
                    })
                    .filter(|p| std::path::Path::new(p).exists());
                match node_exe {
                    Some(ne) => {
                        let mut c = Command::new(&ne);
                        c.arg(cli_js);
                        c
                    }
                    None => {
                        let mut c = Command::new("node");
                        c.arg(cli_js);
                        c
                    }
                }
            } else if pi_cmd.ends_with(".cmd") {
                let mut c = Command::new("cmd.exe");
                c.arg("/C").arg(&pi_cmd);
                c
            } else {
                Command::new(&pi_cmd)
            };
            cmd.args(&args)
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd.spawn()
                .map_err(|e| format!("Failed to start Pi Agent: {}", e))?;

            // Close stdin to signal end of input
            if let Some(stdin) = child.stdin.take() {
                drop(stdin);
            }

            let output = child.wait_with_output()
                .map_err(|e| format!("Pi Agent process error: {}", e))?;

            if output.status.success() {
                String::from_utf8(output.stdout)
                    .map(|s| s.trim().to_string())
                    .map_err(|e| format!("Invalid UTF-8: {}", e))
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("Pi Agent error: {}", stderr))
            }
        })
        .await
        .map_err(|e| format!("Task error: {}", e))?;

        let content = result?;

        Ok(AiResponse {
            content,
            model: session.model.clone(),
            usage: None,
            metadata: None,
        })
    }

    async fn send_message_streaming(
        &self,
        _session_id: &str,
        _message: &str,
        _callback: Box<dyn Fn(AiEvent) + Send>,
    ) -> Result<(), String> {
        // Use stream_session instead
        Err("Use stream_session instead".to_string())
    }

    fn set_model(&mut self, session_id: &str, model: &str) -> Result<(), String> {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.model = model.to_string();
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    fn get_model(&self, session_id: &str) -> Option<String> {
        self.sessions.get(session_id).map(|s| s.model.clone())
    }

    fn delete_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    /// Stream a session message through the Pi Agent CLI.
    ///
    /// The message is passed via stdin (not as a CLI argument) to avoid
    /// Windows command-line escaping issues with long formatted messages
    /// that contain newlines and markdown syntax.
    ///
    /// Pi CLI invocation:
    ///   pi --mode json --print --model <model> [--provider <provider>] [--session <id>]
    ///   stdin: <message>
    ///
    /// The CLI outputs JSON events to stdout, which are parsed and forwarded
    /// to the frontend via the broadcast channel (SSE).
    fn stream_session(
        &self,
        session_id: &str,
        cwd: &str,
        model: &str,
        message: &str,
        tx: Option<&broadcast::Sender<String>>,
        agent_session_id: Option<&str>,
        pid_callback: Option<Box<dyn Fn(u32) + Send>>,
        on_result_callback: Option<Box<dyn Fn() + Send>>,
    ) -> StreamResult {
        log::info!("[pi] stream_session called: session={}, model={}, pi_cmd={}", session_id, model, self.pi_cmd);
        log::debug!("[pi] message len={}", message.len());

        // ── Build CLI arguments ────────────────────────────────────────
        let mut args = vec![
            "--mode".to_string(), "json".to_string(),     // JSON output format
            "--print".to_string(),                         // Non-interactive: process and exit
            "--model".to_string(), model.to_string(),       // Model ID
        ];

        // Auto-detect provider from pi's models.json (e.g. "xiaomi", "anthropic")
        if let Some(provider) = Self::find_provider_for_model(model) {
            args.push("--provider".to_string());
            args.push(provider);
        }

        // Resume an existing Pi session if we have a session ID
        if let Some(sid) = agent_session_id {
            args.push("--session".to_string());
            args.push(sid.to_string());
        }

        // Note: The message is NOT added as a CLI argument here.
        // It is written to stdin below to avoid Windows cmd.exe escaping issues.

        // ── Spawn the Pi Agent process ─────────────────────────────────
        let mut cmd = self.create_pi_command();
        cmd.args(&args)
            .current_dir(cwd)
            .stdin(Stdio::piped())   // we'll write the message to stdin
            .stdout(Stdio::piped())  // read JSON events from stdout
            .stderr(Stdio::piped()); // drain stderr to prevent blocking

        log::debug!("[pi] cmd: {:?}, args: {:?}", cmd.get_program(), cmd.get_args().collect::<Vec<_>>());

        let mut child = match cmd.spawn() {
            Ok(c) => {
                log::info!("[pi] process spawned successfully, pid={:?}", c.id());
                c
            }
            Err(e) => {
                log::error!("[pi] failed to spawn: {}", e);
                send_pi_event(tx, serde_json::json!({
                    "type": "error",
                    "message": format!("Failed to start Pi Agent: {}", e)
                }));
                return StreamResult { agent_session_id: None, pid: None, result_sent: false };
            }
        };

        let pid = child.id();

        // Report PID immediately via callback for abort support
        if let Some(ref callback) = pid_callback {
            callback(pid);
        }

        // ── Write message to stdin ────────────────────────────────────
        // The message (including conversation history for assistant switches)
        // is passed via stdin to avoid Windows cmd.exe argument escaping issues.
        // After writing, we flush and close stdin so the CLI knows input is complete.
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(message.as_bytes());
            let _ = stdin.flush();
        }

        // ── Drain stderr in background ─────────────────────────────────
        // If we don't read stderr, the pipe buffer can fill up and cause
        // the child process to block (deadlock on Windows).
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        log::debug!("[pi:stderr] {}", line);
                    }
                }
            });
        }

        // ── Parse stdout JSON events ───────────────────────────────────
        // Pi Agent outputs one JSON object per line to stdout.
        // Each line represents an event (session, message_update, result, etc.).
        // We parse each line and forward relevant data to the frontend via SSE.
        let stdout = child.stdout.take().expect("stdout should be piped");
        let reader = std::io::BufReader::new(stdout);
        use std::io::BufRead;

        let mut pi_session_id: Option<String> = None;  // captured from "session" event
        let mut line_count = 0;
        let mut got_result = false;  // tracks whether we received a final result
        let mut result_callback_called = false;  // tracks whether on_result_callback was called
        let mut accumulated_text = String::new();  // accumulate text across multiple turns
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    log::error!("[pi] read error: {}", e);
                    continue;
                }
            };
            line_count += 1;

            // Parse the JSON event
            let event: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    let preview: String = line.chars().take(100).collect();
                    log::warn!("[pi] json parse error: {} (line: {})", e, preview);
                    continue;
                }
            };

            let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match event_type {
                // ── Session init event ──────────────────────────────────
                // Contains the Pi Agent's native session ID for --resume
                "session" => {
                    if let Some(sid) = event.get("id").and_then(|s| s.as_str()) {
                        pi_session_id = Some(sid.to_string());
                    }
                    // Notify frontend that streaming has started
                    send_pi_event(tx, serde_json::json!({
                        "type": "start",
                        "sessionId": session_id,
                        "model": model
                    }));
                }
                "message_update" => {
                    if let Some(ame) = event.get("assistantMessageEvent") {
                        let ame_type = ame.get("type").and_then(|t| t.as_str()).unwrap_or("");

                        match ame_type {
                            "thinking_end" => {
                                // Send complete thinking block
                                if let Some(content) = ame.get("content").and_then(|c| c.as_str()) {
                                    if !content.is_empty() {
                                        send_pi_event(tx, serde_json::json!({
                                            "type": "thinking",
                                            "thinking": content
                                        }));
                                    }
                                }
                            }
                            "text_delta" => {
                                if let Some(delta) = ame.get("delta").and_then(|d| d.as_str()) {
                                    send_pi_event(tx, serde_json::json!({
                                        "type": "chunk",
                                        "content": delta
                                    }));
                                }
                            }
                            "text_end" => {
                                // Text ended — 不发送 chunk 事件！
                                // text_delta 已经逐字发送了增量文本，前端已累加到 DOM。
                                // 如果这里再发送完整文本，会导致 DOM 中文本重复。
                                // turn_end/agent_end/fallback 会处理最终结果。
                                if let Some(content) = ame.get("content").and_then(|c| c.as_str()) {
                                    let preview: String = content.chars().take(100).collect();
                                    log::debug!("[pi] text_end: content={} (not re-sent, already streamed via deltas)", preview);
                                } else {
                                    log::debug!("[pi] text_end: no content field in ame");
                                }
                            }
                            "tool_use_start" => {
                                if let Some(tool) = ame.get("tool") {
                                    let id = tool.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                    let name = tool.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
                                    let input = tool.get("arguments").cloned().unwrap_or(serde_json::Value::Null);
                                    send_pi_event(tx, serde_json::json!({
                                        "type": "tool_call",
                                        "id": id,
                                        "name": name,
                                        "input": input
                                    }));
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "tool_execution_start" => {
                    let tool_id = event.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("");
                    let tool_name = event.get("toolName").and_then(|v| v.as_str()).unwrap_or("unknown");
                    let args = event.get("args").cloned().unwrap_or(serde_json::json!({}));
                    send_pi_event(tx, serde_json::json!({
                        "type": "tool_call",
                        "id": tool_id,
                        "name": tool_name,
                        "input": args
                    }));
                }
                "tool_execution_end" => {
                    let tool_id = event.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("");
                    let output = event.get("result").map(|r| {
                        if let Some(s) = r.as_str() { s.to_string() }
                        else { r.to_string() }
                    }).unwrap_or_default();
                    send_pi_event(tx, serde_json::json!({
                        "type": "tool_result",
                        "id": tool_id,
                        "output": output
                    }));
                }
                "turn_end" => {
                    // ── Pi Agent 的 turn_end 事件 ──
                    //
                    // Pi Agent 是多轮对话 Agent：一个 prompt 可能触发多个 turn，
                    // 每个 turn 包含：thinking → tool_call → tool_result → text
                    //
                    // turn_end 在每个 turn 结束时触发，但不代表 Agent 整体完成。
                    // 如果在 turn_end 发送 "result" 事件，前端会调用 finishStreaming()
                    // 关闭 SSE 连接，导致后续 turn 的事件无法送达。
                    //
                    // 因此这里只累积文本，不发送 result。最终的 result 在以下时机发送：
                    // 1. agent_end 事件（如果 Pi Agent 发送了此事件）
                    // 2. 流结束时的 fallback（如果 Pi Agent 没有发送 agent_end）
                    if let Some(msg) = event.get("message") {
                        if let Some(content_arr) = msg.get("content").and_then(|c| c.as_array()) {
                            for block in content_arr {
                                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        accumulated_text.push_str(text);
                                    }
                                }
                            }
                        }
                    }
                    log::debug!("[pi] turn_end: accumulated_text len={}", accumulated_text.len());
                }
                "agent_end" => {
                    // ── Pi Agent 的 agent_end 事件 ──
                    //
                    // 这是 Agent 会话的真正结束。此时发送最终的 result 事件。
                    // 前端收到 result 后会调用 finishStreaming() 关闭 SSE 连接——
                    // 这是正确的，因为 Agent 已经完成了所有工作。
                    //
                    // 注意：Pi Agent 可能不会发送 agent_end 事件（取决于 CLI 版本）。
                    // 如果没有 agent_end，流结束时的 fallback 代码会发送累积的文本。
                    log::info!("[pi] agent_end: sending final result, accumulated_text len={}", accumulated_text.len());
                    send_pi_event(tx, serde_json::json!({
                        "type": "result",
                        "content": accumulated_text,
                        "model": model
                    }));
                    got_result = true;
                    // 调用 on_result_callback 清理后端的 streaming_sessions
                    // 这会让前端的 isStreaming 查询返回 false
                    if !result_callback_called {
                        result_callback_called = true;
                        if let Some(ref callback) = on_result_callback {
                            log::debug!("[pi] calling on_result_callback after agent_end");
                            callback();
                        }
                    }
                }
                _ => {}
            }
        }

        // ── 等待 Pi Agent 进程退出 ──
        // 此时 stdout 已经读完（for line in reader.lines() 循环结束），
        // 说明 Pi Agent 进程已经关闭了 stdout（通常是进程退出）。
        let exit_status = child.wait();
        log::info!("[pi] stream loop ended, {} lines processed, exit={:?}, got_result={}, accumulated_text_len={}",
            line_count, exit_status, got_result, accumulated_text.len());

        // ══════════════════════════════════════════════════════════════
        //  Fallback：确保前端一定收到 result 或 error 事件
        // ══════════════════════════════════════════════════════════════
        //
        // 前端在等待 result/error 事件来结束 SSE 连接。如果这里不发送，
        // 前端会一直等待直到 120 秒安全超时触发（用户看到的就是 SSE 断开）。
        //
        // 三种情况：
        // 1. got_result = true：agent_end 已经发送了 result，跳过
        // 2. accumulated_text 非空：有文本但没有 agent_end，发送累积文本作为 result
        // 3. 既没有 result 也没有文本：发送 error 事件
        //
        // 注意：Pi Agent 可能不发送 agent_end 事件（取决于 CLI 版本），
        // 所以这个 fallback 是必需的。大多数情况下走的是第 2 种路径。
        if !got_result {
            if !accumulated_text.is_empty() {
                // ── 情况 2：发送累积文本作为最终结果 ──
                // 这是最常见的路径：Pi Agent 通过 turn_end 累积了文本，
                // 但没有发送 agent_end。我们在进程退出后发送累积的文本。
                log::info!("[pi] >>> SENDING FINAL RESULT (no agent_end), accumulated_text len={}", accumulated_text.len());
                let receivers = tx.as_ref().map(|t| t.receiver_count()).unwrap_or(0);
                log::debug!("[pi] >>> receivers before send: {}", receivers);
                send_pi_event(tx, serde_json::json!({
                    "type": "result",
                    "content": accumulated_text,
                    "model": model
                }));
                got_result = true;
            } else if line_count <= 1 {
                // ── 情况 3a：没有任何输出 ──
                // Pi Agent 启动后立即退出，可能是 API Key 未配置或模型不可用
                let error_msg = "Pi Agent exited without producing output. Check API key and model configuration.".to_string();
                log::warn!("[pi] >>> SENDING ERROR (no output): {}", error_msg);
                send_pi_event(tx, serde_json::json!({
                    "type": "error",
                    "message": error_msg
                }));
            } else {
                // ── 情况 3b：有输出但没有 result ──
                // Pi Agent 产出了事件（thinking/tool_call 等）但没有 turn_end，
                // 可能是进程被杀或异常退出
                let error_msg = format!("Pi Agent exited unexpectedly ({} lines processed)", line_count);
                log::warn!("[pi] >>> SENDING ERROR (unexpected exit): {}", error_msg);
                send_pi_event(tx, serde_json::json!({
                    "type": "error",
                    "message": error_msg
                }));
            }
        } else {
            log::debug!("[pi] result already sent via agent_end, skipping fallback");
        }

        // ── 确保 on_result_callback 被调用 ──
        // on_result_callback 负责清理后端的 streaming_sessions（让 isStreaming 返回 false）。
        // 如果没有调用，前端的 retryLoadSessions 会一直看到 isStreaming=true。
        //
        // 调用时机：
        // - 正常情况：agent_end 中调用（result_callback_called = true）
        // - fallback：这里调用（agent_end 没有触发）
        if !result_callback_called {
            if let Some(ref callback) = on_result_callback {
                log::debug!("[pi] calling on_result_callback at stream end (fallback)");
                callback();
            }
        } else {
            log::debug!("[pi] on_result_callback already called, skipping");
        }

        // Log final state before returning
        log::info!("[pi] stream_session COMPLETE: session={}, got_result={}, line_count={}, pi_session_id={:?}",
            session_id, got_result, line_count, pi_session_id);

        // Convert UUID to full file path for --session
        let session_path = pi_session_id.and_then(|uuid| {
            Self::find_session_file(&uuid).or_else(|| {
                log::warn!("[pi] could not find session file for UUID: {}", uuid);
                Some(uuid) // Fallback to UUID
            })
        });

        StreamResult {
            agent_session_id: session_path,
            pid: Some(pid),
            result_sent: got_result,
        }
    }

    async fn is_available(&self) -> bool {
        self.create_pi_command()
            .args(&["--version"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn version(&self) -> Option<String> {
        self.create_pi_command()
            .args(&["--version"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|v| v.trim().to_string())
    }
}

/// 发送 SSE 事件（复用 streaming 模块的统一实现）
fn send_pi_event(tx: Option<&broadcast::Sender<String>>, event: serde_json::Value) {
    super::streaming::send_event(tx, event);
}
