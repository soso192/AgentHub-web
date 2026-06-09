// Example: How to add a new AI assistant
// 
// To add support for a new AI coding assistant (e.g., Codex, Pi-Agent):
// 1. Create a new file in src/ai/ (e.g., codex.rs)
// 2. Implement the AiAssistant trait
// 3. Register it in main.rs

use super::{AiAssistant, types::*};
use async_trait::async_trait;
use std::collections::HashMap;
use uuid::Uuid;

/// Example assistant implementation
/// Replace this with actual implementation for your AI assistant
pub struct ExampleAssistant {
    sessions: HashMap<String, ExampleSession>,
    default_model: String,
}

struct ExampleSession {
    cwd: String,
    model: String,
}

impl ExampleAssistant {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            default_model: "example-model".to_string(),
        }
    }
}

#[async_trait]
impl AiAssistant for ExampleAssistant {
    fn name(&self) -> &str {
        "example"  // Unique identifier
    }

    fn display_name(&self) -> &str {
        "Example Assistant"  // Display name in UI
    }

    fn available_models(&self) -> Vec<ModelInfo> {
        vec![
            ModelInfo {
                id: "example-model".to_string(),
                name: "Example Model".to_string(),
                provider: "example".to_string(),
                max_tokens: Some(100000),
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

        self.sessions.insert(session_id.clone(), ExampleSession {
            cwd,
            model,
        });

        Ok(session_id)
    }

    async fn send_message(&self, session_id: &str, message: &str) -> Result<AiResponse, String> {
        let session = self.sessions.get(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        // TODO: Replace with actual AI assistant API call
        // Example: Call your CLI or API here
        let response = format!("Echo from {}: {}", self.name(), message);

        Ok(AiResponse {
            content: response,
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
        // TODO: Implement streaming for your assistant
        let response = self.send_message(session_id, message).await?;
        
        callback(AiEvent {
            event_type: "end".to_string(),
            data: AiEventData::End { response },
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
        // TODO: Check if your assistant is installed/available
        true
    }

    async fn version(&self) -> Option<String> {
        // TODO: Return version of your assistant
        Some("1.0.0".to_string())
    }
}
