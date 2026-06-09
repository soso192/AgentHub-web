use super::{AiAssistant, types::*};
use super::streaming::StreamResult;
use async_trait::async_trait;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use tokio::sync::broadcast;
use uuid::Uuid;

/// OpenAI Codex CLI assistant implementation
pub struct CodexAssistant {
    sessions: HashMap<String, CodexSession>,
    default_model: String,
    codex_cmd: String,
}

struct CodexSession {
    cwd: String,
    model: String,
}

impl Clone for CodexSession {
    fn clone(&self) -> Self {
        Self {
            cwd: self.cwd.clone(),
            model: self.model.clone(),
        }
    }
}

impl CodexAssistant {
    pub fn new() -> Self {
        let codex_cmd = Self::find_codex_cmd();
        let default_model = Self::read_default_model().unwrap_or_else(|| "qwen3.6-plus".to_string());

        Self {
            sessions: HashMap::new(),
            default_model,
            codex_cmd,
        }
    }

    fn find_codex_cmd() -> String {
        // Check CODEX_CMD env var
        if let Ok(path) = std::env::var("CODEX_CMD") {
            if std::path::Path::new(&path).exists() {
                return path;
            }
        }

        // Try running `codex` directly
        if Command::new("codex").arg("--version").output().map(|o| o.status.success()).unwrap_or(false) {
            return "codex".to_string();
        }

        // Search common locations
        if let Some(home) = dirs::home_dir() {
            let npm_paths = vec![
                home.join("AppData").join("Roaming").join("npm").join("codex.cmd"),
                home.join("AppData").join("Roaming").join("npm").join("codex"),
            ];
            for path in &npm_paths {
                if path.exists() {
                    return path.to_string_lossy().to_string();
                }
            }
        }

        "codex".to_string()
    }

    fn read_default_model() -> Option<String> {
        let config_path = dirs::home_dir()?.join(".codex").join("config.toml");
        let content = std::fs::read_to_string(config_path).ok()?;
        // Simple TOML parsing for model = "xxx"
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("model") && trimmed.contains('=') {
                let value = trimmed.split('=').nth(1)?.trim();
                return Some(value.trim_matches('"').to_string());
            }
        }
        None
    }

    fn create_codex_command(&self) -> Command {
        if self.codex_cmd.ends_with(".cmd") {
            let mut cmd = Command::new("cmd.exe");
            cmd.arg("/C").arg(&self.codex_cmd);
            cmd
        } else {
            Command::new(&self.codex_cmd)
        }
    }
}

#[async_trait]
impl AiAssistant for CodexAssistant {
    fn name(&self) -> &str {
        "codex"
    }

    fn display_name(&self) -> &str {
        "Codex"
    }

    fn available_models(&self) -> Vec<ModelInfo> {
        vec![
            ModelInfo {
                id: "qwen3.6-plus".to_string(),
                name: "Qwen 3.6 Plus".to_string(),
                provider: "dashscope".to_string(),
                max_tokens: Some(128000),
                supports_streaming: true,
                supports_tools: true,
            },
            ModelInfo {
                id: "o3".to_string(),
                name: "O3".to_string(),
                provider: "openai".to_string(),
                max_tokens: Some(200000),
                supports_streaming: true,
                supports_tools: true,
            },
            ModelInfo {
                id: "o4-mini".to_string(),
                name: "O4 Mini".to_string(),
                provider: "openai".to_string(),
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

        self.sessions.insert(session_id.clone(), CodexSession {
            cwd,
            model,
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
        let codex_cmd = self.codex_cmd.clone();

        let result = tokio::task::spawn_blocking(move || {
            let args = vec![
                "exec".to_string(),
                "--json".to_string(),
                "-m".to_string(),
                model.clone(),
                message.clone(),
            ];

            let mut cmd = if codex_cmd.ends_with(".cmd") {
                let mut c = Command::new("cmd.exe");
                c.arg("/C").arg(&codex_cmd);
                c
            } else {
                Command::new(&codex_cmd)
            };

            cmd.args(&args)
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd.spawn()
                .map_err(|e| format!("Failed to start Codex: {}", e))?;

            if let Some(stdin) = child.stdin.take() {
                drop(stdin);
            }

            let output = child.wait_with_output()
                .map_err(|e| format!("Codex process error: {}", e))?;

            if output.status.success() {
                // Parse JSONL output to find the final assistant message
                let stdout = String::from_utf8_lossy(&output.stdout);
                let mut result_text = String::new();
                for line in stdout.lines() {
                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(line) {
                        if event.get("type").and_then(|t| t.as_str()) == Some("message.completed") {
                            if let Some(content) = event.get("content") {
                                if let Some(text) = content.as_str() {
                                    result_text = text.to_string();
                                }
                            }
                        }
                    }
                }
                if result_text.is_empty() {
                    result_text = stdout.trim().to_string();
                }
                Ok(result_text)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("Codex error: {}", stderr))
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
        pid_callback: Option<Box<dyn Fn(u32) + Send>>,
        on_result_callback: Option<Box<dyn Fn() + Send>>,
    ) -> StreamResult {
        log::info!("[codex] stream_session called: session={}, model={}", session_id, model);

        let mut args = vec![
            "exec".to_string(),
            "--json".to_string(),
            "--skip-git-repo-check".to_string(),
            "-m".to_string(),
            model.to_string(),
        ];

        // Resume session if we have one
        if let Some(sid) = agent_session_id {
            args.push("--resume".to_string());
            args.push(sid.to_string());
        }

        args.push(message.to_string());

        let mut cmd = self.create_codex_command();
        cmd.args(&args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => {
                log::info!("[codex] process spawned, pid={:?}", c.id());
                c
            }
            Err(e) => {
                log::error!("[codex] failed to spawn: {}", e);
                send_codex_event(tx, serde_json::json!({
                    "type": "error",
                    "message": format!("Failed to start Codex: {}", e)
                }));
                return StreamResult { agent_session_id: None, pid: None, result_sent: false };
            }
        };

        let pid = child.id();

        // Report PID immediately via callback for abort support
        if let Some(ref callback) = pid_callback {
            callback(pid);
        }

        // Close stdin
        if let Some(stdin) = child.stdin.take() {
            drop(stdin);
        }

        // Drain stderr
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        log::debug!("[codex:stderr] {}", line);
                    }
                }
            });
        }

        // Read stdout line by line
        let stdout = child.stdout.take().expect("stdout should be piped");
        let reader = std::io::BufReader::new(stdout);
        use std::io::BufRead;

        let mut codex_session_id: Option<String> = None;
        let mut line_count = 0;
        let mut result_callback_called = false;

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    log::error!("[codex] read error: {}", e);
                    continue;
                }
            };
            line_count += 1;

            // Skip non-JSON lines (like "Reading additional input from stdin...")
            if !line.starts_with('{') {
                continue;
            }

            let event: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match event_type {
                "thread.started" => {
                    if let Some(tid) = event.get("thread_id").and_then(|t| t.as_str()) {
                        codex_session_id = Some(tid.to_string());
                    }
                    send_codex_event(tx, serde_json::json!({
                        "type": "start",
                        "sessionId": session_id,
                        "model": model
                    }));
                }
                "turn.started" => {
                    // Turn started
                }
                "message.delta" => {
                    // Text delta
                    if let Some(delta) = event.get("delta").and_then(|d| d.as_str()) {
                        send_codex_event(tx, serde_json::json!({
                            "type": "chunk",
                            "content": delta
                        }));
                    }
                }
                "message.completed" => {
                    // Message completed
                    if let Some(content) = event.get("content").and_then(|c| c.as_str()) {
                        send_codex_event(tx, serde_json::json!({
                            "type": "result",
                            "content": content,
                            "model": model
                        }));
                        if !result_callback_called {
                            result_callback_called = true;
                            if let Some(ref callback) = on_result_callback {
                                log::debug!("[codex] result sent (message.completed), calling on_result_callback");
                                callback();
                            }
                        }
                    }
                }
                "turn.completed" => {
                    // Turn completed - extract final message
                    if let Some(message) = event.get("message") {
                        if let Some(content) = message.get("content").and_then(|c| c.as_str()) {
                            send_codex_event(tx, serde_json::json!({
                                "type": "result",
                                "content": content,
                                "model": model
                            }));
                            if !result_callback_called {
                                result_callback_called = true;
                                if let Some(ref callback) = on_result_callback {
                                    log::debug!("[codex] result sent (turn.completed), calling on_result_callback");
                                    callback();
                                }
                            }
                        }
                    }
                }
                "turn.failed" => {
                    let error_msg = event.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown error");
                    send_codex_event(tx, serde_json::json!({
                        "type": "error",
                        "message": error_msg
                    }));
                }
                "error" => {
                    let error_msg = event.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown error");
                    // Skip reconnection messages
                    if error_msg.contains("Reconnecting") {
                        continue;
                    }
                    send_codex_event(tx, serde_json::json!({
                        "type": "error",
                        "message": error_msg
                    }));
                }
                "tool.started" => {
                    let tool_name = event.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                    let tool_id = event.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    send_codex_event(tx, serde_json::json!({
                        "type": "tool_call",
                        "id": tool_id,
                        "name": tool_name,
                        "input": {}
                    }));
                }
                "tool.completed" => {
                    let tool_id = event.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    let output = event.get("output").map(|o| {
                        if let Some(s) = o.as_str() { s.to_string() }
                        else { o.to_string() }
                    }).unwrap_or_default();
                    send_codex_event(tx, serde_json::json!({
                        "type": "tool_result",
                        "id": tool_id,
                        "output": output
                    }));
                }
                _ => {}
            }
        }

        let _ = child.wait();
        log::info!("[codex] stream loop ended, {} lines processed", line_count);

        StreamResult {
            agent_session_id: codex_session_id,
            pid: Some(pid),
            result_sent: false,  // Codex doesn't track result_sent
        }
    }

    async fn is_available(&self) -> bool {
        Command::new(&self.codex_cmd)
            .args(&["--version"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn version(&self) -> Option<String> {
        Command::new(&self.codex_cmd)
            .args(&["--version"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|v| v.trim().to_string())
    }
}

fn send_codex_event(tx: Option<&broadcast::Sender<String>>, event: serde_json::Value) {
    if let Some(tx) = tx {
        let _ = tx.send(event.to_string());
    }
}
