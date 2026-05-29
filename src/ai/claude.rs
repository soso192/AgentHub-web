use super::{AiAssistant, types::*};
use async_trait::async_trait;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::io::Write;
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
                // Try common locations
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
                "bash".to_string() // Fallback
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
        
        // Try ANTHROPIC_MODEL first, then model field
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

    fn get_claude_args(&self, model: &str) -> Vec<String> {
        vec![
            "--print".to_string(),
            "--output-format".to_string(),
            "text".to_string(),
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
            "--model".to_string(),
            model.to_string(),
        ]
    }

    fn execute_claude_blocking(&self, cwd: &str, model: &str, message: &str) -> Result<String, String> {
        let args = self.get_claude_args(model);
        
        let mut cmd = Command::new("claude");
        cmd.args(&args)
            .current_dir(cwd)
            .env("CLAUDE_CODE_GIT_BASH_PATH", &self.git_bash_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to start Claude: {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            let msg = message.to_string();
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

        // Add standard Claude models if not already present
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

        // Use spawn_blocking for the synchronous CLI call
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

        // Fire start event
        callback(AiEvent {
            event_type: "start".to_string(),
            data: AiEventData::Start {
                session_id: session_id.to_string(),
                model: model.clone(),
            },
        });

        // Execute in background
        tokio::task::spawn_blocking(move || {
            let args = vec![
                "--print".to_string(),
                "--output-format".to_string(),
                "text".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--model".to_string(),
                model.clone(),
            ];

            let result = Command::new("claude")
                .args(&args)
                .current_dir(&cwd)
                .env("CLAUDE_CODE_GIT_BASH_PATH", &git_bash)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .and_then(|mut child| {
                    if let Some(mut stdin) = child.stdin.take() {
                        let msg = message.clone();
                        let _ = stdin.write_all(msg.as_bytes());
                    }
                    child.wait_with_output()
                });

            match result {
                Ok(output) => {
                    if output.status.success() {
                        if let Ok(content) = String::from_utf8(output.stdout) {
                            let content = content.trim().to_string();
                            
                            callback(AiEvent {
                                event_type: "message".to_string(),
                                data: AiEventData::Message {
                                    role: "assistant".to_string(),
                                    content: content.clone(),
                                },
                            });

                            callback(AiEvent {
                                event_type: "end".to_string(),
                                data: AiEventData::End {
                                    response: AiResponse {
                                        content,
                                        model,
                                        usage: None,
                                        metadata: None,
                                    },
                                },
                            });
                        }
                    } else {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        callback(AiEvent {
                            event_type: "error".to_string(),
                            data: AiEventData::Error {
                                message: format!("Claude error: {}", stderr),
                            },
                        });
                    }
                }
                Err(e) => {
                    callback(AiEvent {
                        event_type: "error".to_string(),
                        data: AiEventData::Error {
                            message: format!("Failed to start Claude: {}", e),
                        },
                    });
                }
            }
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
