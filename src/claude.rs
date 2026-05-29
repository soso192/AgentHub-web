use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Clone)]
pub struct ClaudeManager {
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
}

struct SessionState {
    cwd: String,
    model: String,
}

impl ClaudeManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(&self, cwd: String, model: Option<String>) -> String {
        let session_id = Uuid::new_v4().to_string();
        let model = model.unwrap_or_else(|| "MiniMax-M2.7".to_string());
        
        let state = SessionState {
            cwd: cwd.clone(),
            model: model.clone(),
        };
        
        self.sessions.lock().unwrap().insert(session_id.clone(), state);
        session_id
    }

    pub fn get_session_model(&self, session_id: &str) -> Option<String> {
        self.sessions.lock().unwrap()
            .get(session_id)
            .map(|s| s.model.clone())
    }

    pub fn set_session_model(&self, session_id: &str, model: String) {
        if let Some(state) = self.sessions.lock().unwrap().get_mut(session_id) {
            state.model = model;
        }
    }

    pub fn remove_session(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
    }

    pub fn call_claude(
        &self,
        session_id: &str,
        message: &str,
    ) -> Result<String, String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        let cwd = session.cwd.clone();
        let model = session.model.clone();
        
        drop(sessions);

        let git_bash = std::env::var("CLAUDE_CODE_GIT_BASH_PATH")
            .unwrap_or_else(|_| r"D:\Downloads\Software\Git\bin\bash.exe".to_string());

        let output = Command::new("claude")
            .args(&[
                "--print",
                "--output-format", "text",
                "--permission-mode", "bypassPermissions",
                "--model", &model,
            ])
            .current_dir(&cwd)
            .env("CLAUDE_CODE_GIT_BASH_PATH", &git_bash)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start Claude: {}", e))
            .and_then(|mut child| {
                if let Some(mut stdin) = child.stdin.take() {
                    let msg = message.to_string();
                    std::thread::spawn(move || {
                        stdin.write_all(msg.as_bytes()).ok();
                    });
                }
                
                child.wait_with_output()
                    .map_err(|e| format!("Claude process error: {}", e))
            })?;

        if output.status.success() {
            String::from_utf8(output.stdout)
                .map(|s| s.trim().to_string())
                .map_err(|e| format!("Invalid UTF-8 output: {}", e))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Claude error: {}", stderr))
        }
    }

    pub fn call_claude_streaming(
        &self,
        session_id: &str,
        message: &str,
        tx: mpsc::UnboundedSender<String>,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        let cwd = session.cwd.clone();
        let model = session.model.clone();
        let message = message.to_string();
        
        drop(sessions);

        let git_bash = std::env::var("CLAUDE_CODE_GIT_BASH_PATH")
            .unwrap_or_else(|_| r"D:\Downloads\Software\Git\bin\bash.exe".to_string());

        std::thread::spawn(move || {
            let result = Command::new("claude")
                .args(&[
                    "--print",
                    "--output-format", "text",
                    "--permission-mode", "bypassPermissions",
                    "--model", &model,
                ])
                .current_dir(&cwd)
                .env("CLAUDE_CODE_GIT_BASH_PATH", &git_bash)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn();

            match result {
                Ok(mut child) => {
                    if let Some(mut stdin) = child.stdin.take() {
                        let msg = message.clone();
                        std::thread::spawn(move || {
                            stdin.write_all(msg.as_bytes()).ok();
                        });
                    }

                    match child.wait_with_output() {
                        Ok(output) => {
                            if output.status.success() {
                                if let Ok(text) = String::from_utf8(output.stdout) {
                                    let _ = tx.send(serde_json::json!({
                                        "type": "message_end",
                                        "message": {
                                            "role": "assistant",
                                            "content": text.trim(),
                                            "timestamp": chrono::Utc::now().timestamp_millis()
                                        }
                                    }).to_string());
                                }
                            } else {
                                let stderr = String::from_utf8_lossy(&output.stderr);
                                let _ = tx.send(serde_json::json!({
                                    "type": "error",
                                    "error": format!("Claude error: {}", stderr)
                                }).to_string());
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(serde_json::json!({
                                "type": "error",
                                "error": format!("Process error: {}", e)
                            }).to_string());
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(serde_json::json!({
                        "type": "error",
                        "error": format!("Failed to start Claude: {}", e)
                    }).to_string());
                }
            }
        });

        Ok(())
    }
}
