use super::{AiAssistant, types::*};
use async_trait::async_trait;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::io::Write;
use uuid::Uuid;

/// Pi Coding Agent assistant implementation
pub struct PiAssistant {
    sessions: HashMap<String, PiSession>,
    default_model: String,
}

struct PiSession {
    cwd: String,
    model: String,
}

impl Clone for PiSession {
    fn clone(&self) -> Self {
        Self {
            cwd: self.cwd.clone(),
            model: self.model.clone(),
        }
    }
}

impl PiAssistant {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            default_model: "anthropic/claude-sonnet-4-20250514".to_string(),
        }
    }

    fn get_pi_args(&self, model: &str) -> Vec<String> {
        vec![
            "@earendil-works/pi-coding-agent".to_string(),
            "--model".to_string(),
            model.to_string(),
            "--print".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
        ]
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
            ModelInfo {
                id: "anthropic/claude-haiku-3-20240307".to_string(),
                name: "Claude Haiku 3".to_string(),
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

        let result = tokio::task::spawn_blocking(move || {
            let args = vec![
                "@earendil-works/pi-coding-agent".to_string(),
                "--print".to_string(),
                "--output-format".to_string(),
                "text".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--model".to_string(),
                model.clone(),
            ];

            let mut cmd = Command::new("npx");
            cmd.args(&args)
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd.spawn()
                .map_err(|e| format!("Failed to start Pi Agent: {}", e))?;

            if let Some(mut stdin) = child.stdin.take() {
                let msg = message.clone();
                std::thread::spawn(move || {
                    let _ = stdin.write_all(msg.as_bytes());
                });
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

        // Fire start event
        callback(AiEvent {
            event_type: "start".to_string(),
            data: AiEventData::Start {
                session_id: session_id.to_string(),
                model: model.clone(),
            },
        });

        // Execute in background with stream-json output
        tokio::task::spawn_blocking(move || {
            let args = vec![
                "@earendil-works/pi-coding-agent".to_string(),
                "--print".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--model".to_string(),
                model.clone(),
            ];

            let mut cmd = Command::new("npx");
            cmd.args(&args)
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    callback(AiEvent {
                        event_type: "error".to_string(),
                        data: AiEventData::Error {
                            message: format!("Failed to start Pi Agent: {}", e),
                        },
                    });
                    return;
                }
            };

            // Write message to stdin
            if let Some(mut stdin) = child.stdin.take() {
                let msg = message.clone();
                let _ = stdin.write_all(msg.as_bytes());
            }

            // Read stdout line by line and parse stream-json events
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
                let subtype = event.get("subtype").and_then(|s| s.as_str());

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

            // Wait for process to finish
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

    async fn is_available(&self) -> bool {
        Command::new("npx")
            .args(&["@earendil-works/pi-coding-agent", "--version"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn version(&self) -> Option<String> {
        Command::new("npx")
            .args(&["@earendil-works/pi-coding-agent", "--version"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|v| v.trim().to_string())
    }
}
