use super::{AiAssistant, types::*};
use super::streaming::{self, StreamResult};
use async_trait::async_trait;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::io::Write;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Claude Code CLI assistant implementation
pub struct ClaudeAssistant {
    sessions: HashMap<String, ClaudeSession>,
    default_model: String,
    git_bash_path: String,
}

struct ClaudeSession {
    cwd: String,
    model: String,
}

impl Clone for ClaudeSession {
    fn clone(&self) -> Self {
        Self {
            cwd: self.cwd.clone(),
            model: self.model.clone(),
        }
    }
}

impl ClaudeAssistant {
    pub fn new() -> Self {
        let default_model = Self::read_default_model()
            .unwrap_or_else(|| "MiniMax-M2.7".to_string());

        let git_bash_path = std::env::var("CLAUDE_CODE_GIT_BASH_PATH")
            .unwrap_or_else(|_| {
                let paths = vec![
                    r"D:\Downloads\Software\Git\bin\bash.exe",
                    r"C:\Program Files\Git\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\bin\bash.exe",
                ];
                for path in paths {
                    if std::path::Path::new(path).exists() {
                        return path.to_string();
                    }
                }
                "bash".to_string()
            });

        Self {
            sessions: HashMap::new(),
            default_model,
            git_bash_path,
        }
    }

    fn read_default_model() -> Option<String> {
        let settings_path = dirs::home_dir()?.join(".claude").join("settings.json");
        let content = std::fs::read_to_string(settings_path).ok()?;
        let settings: serde_json::Value = serde_json::from_str(&content).ok()?;

        settings.get("env")
            .and_then(|e| e.get("ANTHROPIC_MODEL"))
            .and_then(|m| m.as_str())
            .map(String::from)
            .or_else(|| {
                settings.get("model")
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
    }
}

#[async_trait]
impl AiAssistant for ClaudeAssistant {
    fn name(&self) -> &str {
        "claude"
    }

    fn display_name(&self) -> &str {
        "Claude Code"
    }

    fn available_models(&self) -> Vec<ModelInfo> {
        let mut models = vec![
            ModelInfo {
                id: self.default_model.clone(),
                name: self.default_model.clone(),
                provider: "anthropic".to_string(),
                max_tokens: Some(200000),
                supports_streaming: true,
                supports_tools: true,
            },
        ];

        let standard_models = vec![
            ("claude-sonnet-4-20250514", "Claude Sonnet 4"),
            ("claude-opus-4-20250514", "Claude Opus 4"),
            ("claude-haiku-3-20240307", "Claude Haiku 3"),
        ];

        for (id, name) in standard_models {
            if !models.iter().any(|m| m.id == id) {
                models.push(ModelInfo {
                    id: id.to_string(),
                    name: name.to_string(),
                    provider: "anthropic".to_string(),
                    max_tokens: Some(200000),
                    supports_streaming: true,
                    supports_tools: true,
                });
            }
        }

        models
    }

    fn default_model(&self) -> &str {
        &self.default_model
    }

    async fn create_session(&mut self, cwd: String, model: Option<String>) -> Result<String, String> {
        let session_id = Uuid::new_v4().to_string();
        let model = model.unwrap_or_else(|| self.default_model.clone());

        self.sessions.insert(session_id.clone(), ClaudeSession {
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
        let git_bash = self.git_bash_path.clone();

        let result = tokio::task::spawn_blocking(move || {
            let args = vec![
                "--print".to_string(),
                "--output-format".to_string(),
                "text".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--model".to_string(),
                model.clone(),
            ];

            let mut cmd = Command::new("claude");
            cmd.args(&args)
                .current_dir(&cwd)
                .env("CLAUDE_CODE_GIT_BASH_PATH", &git_bash)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd.spawn()
                .map_err(|e| format!("Failed to start Claude: {}", e))?;

            if let Some(mut stdin) = child.stdin.take() {
                let msg = message.clone();
                std::thread::spawn(move || {
                    let _ = stdin.write_all(msg.as_bytes());
                });
            }

            let output = child.wait_with_output()
                .map_err(|e| format!("Claude process error: {}", e))?;

            if output.status.success() {
                String::from_utf8(output.stdout)
                    .map(|s| s.trim().to_string())
                    .map_err(|e| format!("Invalid UTF-8: {}", e))
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("Claude error: {}", stderr))
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
        session_id: &str,
        message: &str,
        callback: Box<dyn Fn(AiEvent) + Send>,
    ) -> Result<(), String> {
        let session = self.sessions.get(session_id)
            .ok_or_else(|| "Session not found".to_string())?
            .clone();

        let message = message.to_string();
        let cwd = session.cwd.clone();
        let model = session.model.clone();
        let git_bash = self.git_bash_path.clone();

        callback(AiEvent {
            event_type: "start".to_string(),
            data: AiEventData::Start {
                session_id: session_id.to_string(),
                model: model.clone(),
            },
        });

        tokio::task::spawn_blocking(move || {
            let args = vec![
                "--print".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--model".to_string(),
                model.clone(),
            ];

            let mut cmd = Command::new("claude");
            cmd.args(&args)
                .current_dir(&cwd)
                .env("CLAUDE_CODE_GIT_BASH_PATH", &git_bash)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    callback(AiEvent {
                        event_type: "error".to_string(),
                        data: AiEventData::Error {
                            message: format!("Failed to start Claude: {}", e),
                        },
                    });
                    return;
                }
            };

            if let Some(mut stdin) = child.stdin.take() {
                let msg = message.clone();
                let _ = stdin.write_all(msg.as_bytes());
            }

            let stdout = child.stdout.take().expect("stdout should be piped");
            let reader = std::io::BufReader::new(stdout);
            use std::io::BufRead;

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        callback(AiEvent {
                            event_type: "error".to_string(),
                            data: AiEventData::Error {
                                message: format!("Read error: {}", e),
                            },
                        });
                        return;
                    }
                };

                let event: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match event_type {
                    "assistant" => {
                        if let Some(message_obj) = event.get("message") {
                            if let Some(content_arr) = message_obj.get("content").and_then(|c| c.as_array()) {
                                for block in content_arr {
                                    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                    match block_type {
                                        "thinking" => {
                                            if let Some(thinking_text) = block.get("thinking").and_then(|t| t.as_str()) {
                                                callback(AiEvent {
                                                    event_type: "thinking".to_string(),
                                                    data: AiEventData::Thinking {
                                                        thinking: thinking_text.to_string(),
                                                    },
                                                });
                                            }
                                        }
                                        "tool_use" => {
                                            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                                            let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
                                            callback(AiEvent {
                                                event_type: "tool_call".to_string(),
                                                data: AiEventData::ToolCall { id, name, input },
                                            });
                                        }
                                        "text" => {
                                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                                callback(AiEvent {
                                                    event_type: "chunk".to_string(),
                                                    data: AiEventData::Chunk {
                                                        content: text.to_string(),
                                                        accumulated: text.to_string(),
                                                    },
                                                });
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                    "user" => {
                        if let Some(message_obj) = event.get("message") {
                            if let Some(content_arr) = message_obj.get("content").and_then(|c| c.as_array()) {
                                for block in content_arr {
                                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                                        let tool_use_id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let content = block.get("content").map(|c| {
                                            if let Some(s) = c.as_str() { s.to_string() }
                                            else { c.to_string() }
                                        }).unwrap_or_default();
                                        callback(AiEvent {
                                            event_type: "tool_result".to_string(),
                                            data: AiEventData::ToolResult { id: tool_use_id, output: content },
                                        });
                                    }
                                }
                            }
                        }
                    }
                    "result" => {
                        let result_text = event.get("result").and_then(|r| r.as_str()).unwrap_or("");
                        let is_error = event.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);

                        if is_error {
                            callback(AiEvent {
                                event_type: "error".to_string(),
                                data: AiEventData::Error {
                                    message: result_text.to_string(),
                                },
                            });
                        } else {
                            callback(AiEvent {
                                event_type: "end".to_string(),
                                data: AiEventData::End {
                                    response: AiResponse {
                                        content: result_text.to_string(),
                                        model: model.clone(),
                                        usage: None,
                                        metadata: None,
                                    },
                                },
                            });
                        }
                    }
                    _ => {}
                }
            }

            let _ = child.wait();
        });

        Ok(())
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
        existing_agent_session_id: Option<&str>,
    ) -> StreamResult {
        eprintln!("[claude] stream_session: session={}, model={}, resume={:?}", session_id, model, existing_agent_session_id);
        let git_bash = &self.git_bash_path;

        let mut args = vec![
            "--print".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
            "--model".to_string(),
            model.to_string(),
        ];

        // Use --resume to continue an existing Claude session
        if let Some(resume_id) = existing_agent_session_id {
            args.push("--resume".to_string());
            args.push(resume_id.to_string());
        }

        let mut cmd = Command::new("claude");
        cmd.args(&args)
            .current_dir(cwd)
            .env("CLAUDE_CODE_GIT_BASH_PATH", git_bash)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                streaming::send_event(tx, serde_json::json!({
                    "type": "error",
                    "message": format!("Failed to start Claude: {}", e)
                }));
                return StreamResult { agent_session_id: None, pid: None };
            }
        };

        let pid = child.id();

        // Write message to stdin and close it (Claude CLI needs EOF to start processing)
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(message.as_bytes());
            let _ = stdin.flush();
        }
        eprintln!("[claude] message written, pid={}", pid);

        // Read stdout line by line and parse events
        let stdout = child.stdout.take().expect("stdout should be piped");
        let reader = std::io::BufReader::new(stdout);
        use std::io::BufRead;

        let mut agent_session_id: Option<String> = None;
        let mut line_count = 0;

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[claude] read error: {}", e);
                    continue;
                }
            };
            line_count += 1;

            if let Some(sid) = streaming::process_stream_line(&line, session_id, model, tx) {
                agent_session_id = Some(sid);
            }
        }

        let exit_status = child.wait();
        eprintln!("[claude] stream loop ended, {} lines, exit={:?}", line_count, exit_status);

        StreamResult { agent_session_id, pid: Some(pid) }
    }

    async fn is_available(&self) -> bool {
        Command::new("claude")
            .args(&["--version"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn version(&self) -> Option<String> {
        Command::new("claude")
            .args(&["--version"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|v| v.trim().to_string())
    }
}
