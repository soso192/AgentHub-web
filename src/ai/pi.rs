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
                eprintln!("[pi] model '{}' not found, falling back to provider '{}'", model, provider_name);
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

    fn stream_session(
        &self,
        session_id: &str,
        cwd: &str,
        model: &str,
        message: &str,
        tx: Option<&broadcast::Sender<String>>,
        agent_session_id: Option<&str>,
    ) -> StreamResult {
        eprintln!("[pi] stream_session called: session={}, model={}, pi_cmd={}", session_id, model, self.pi_cmd);
        eprintln!("[pi] message (len={}): {:?}",
            message.len(),
            message.chars().take(500).collect::<String>());
        let mut args = vec![
            "--mode".to_string(),
            "json".to_string(),
            "--print".to_string(),
            "--model".to_string(),
            model.to_string(),
        ];

        // Auto-detect provider from pi's models.json
        if let Some(provider) = Self::find_provider_for_model(model) {
            args.push("--provider".to_string());
            args.push(provider);
        }

        // Resume session if we have a session ID
        if let Some(sid) = agent_session_id {
            args.push("--session".to_string());
            args.push(sid.to_string());
        }

        // Message is passed via stdin to avoid Windows CLI argument
        // length/escaping issues with long formatted messages.

        let mut cmd = self.create_pi_command();
        cmd.args(&args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        eprintln!("[pi] cmd: {:?}, args: {:?}", cmd.get_program(), cmd.get_args().collect::<Vec<_>>());

        let mut child = match cmd.spawn() {
            Ok(c) => {
                eprintln!("[pi] process spawned successfully, pid={:?}", c.id());
                c
            }
            Err(e) => {
                eprintln!("[pi] failed to spawn: {}", e);
                send_pi_event(tx, serde_json::json!({
                    "type": "error",
                    "message": format!("Failed to start Pi Agent: {}", e)
                }));
                return StreamResult { agent_session_id: None, pid: None };
            }
        };

        let pid = child.id();
        // Write message to stdin and close it
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(message.as_bytes());
            let _ = stdin.flush();
        }

        // Drain stderr in background to prevent blocking
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        eprintln!("[pi:stderr] {}", line);
                    }
                }
            });
        }

        // Read stdout line by line
        let stdout = child.stdout.take().expect("stdout should be piped");
        let reader = std::io::BufReader::new(stdout);
        use std::io::BufRead;

        let mut pi_session_id: Option<String> = None;
        let mut line_count = 0;
        let mut got_result = false;
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[pi] read error: {}", e);
                    continue;
                }
            };
            line_count += 1;

            let event: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    let preview: String = line.chars().take(100).collect();
                    eprintln!("[pi] json parse error: {} (line: {})", e, preview);
                    continue;
                }
            };

            let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match event_type {
                "session" => {
                    // Capture session ID for future --session
                    if let Some(sid) = event.get("id").and_then(|s| s.as_str()) {
                        pi_session_id = Some(sid.to_string());
                    }
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
                                // Text ended - send final result
                                if let Some(content) = ame.get("content").and_then(|c| c.as_str()) {
                                    let preview: String = content.chars().take(100).collect();
                                    eprintln!("[pi] text_end: content={}", preview);
                                    send_pi_event(tx, serde_json::json!({
                                        "type": "result",
                                        "content": content,
                                        "model": model
                                    }));
                                    got_result = true;
                                } else {
                                    eprintln!("[pi] text_end: no content field in ame");
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
                    send_pi_event(tx, serde_json::json!({
                        "type": "tool_call",
                        "id": tool_id,
                        "name": tool_name,
                        "input": {}
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
                    // Fallback: extract final text from turn_end if text_end wasn't received
                    if let Some(msg) = event.get("message") {
                        if let Some(content_arr) = msg.get("content").and_then(|c| c.as_array()) {
                            for block in content_arr {
                                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        send_pi_event(tx, serde_json::json!({
                                            "type": "result",
                                            "content": text,
                                            "model": model
                                        }));
                                        got_result = true;
                                    }
                                }
                            }
                        }
                    }
                }
                "agent_end" => {
                    got_result = true;
                }
                _ => {}
            }
        }

        let exit_status = child.wait();
        eprintln!("[pi] stream loop ended, {} lines processed, exit={:?}", line_count, exit_status);

        // If no result was received, send an error so frontend doesn't hang
        if !got_result {
            let error_msg = if line_count <= 1 {
                "Pi Agent exited without producing output. Check API key and model configuration.".to_string()
            } else {
                format!("Pi Agent exited unexpectedly ({} lines processed)", line_count)
            };
            eprintln!("[pi] no result received, sending error: {}", error_msg);
            send_pi_event(tx, serde_json::json!({
                "type": "error",
                "message": error_msg
            }));
        }

        // Convert UUID to full file path for --session
        let session_path = pi_session_id.and_then(|uuid| {
            Self::find_session_file(&uuid).or_else(|| {
                eprintln!("[pi] could not find session file for UUID: {}", uuid);
                Some(uuid) // Fallback to UUID
            })
        });

        StreamResult {
            agent_session_id: session_path,
            pid: Some(pid),
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

fn send_pi_event(tx: Option<&broadcast::Sender<String>>, event: serde_json::Value) {
    if let Some(tx) = tx {
        let _ = tx.send(event.to_string());
    }
}
