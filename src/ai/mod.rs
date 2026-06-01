// AI Assistant Interface Module
// This module provides a trait-based abstraction for different AI coding assistants.

pub mod claude;
pub mod pi;
pub mod types;

use async_trait::async_trait;
use types::{AiResponse, AiEvent, ModelInfo};

/// Core trait for AI coding assistants
/// Implement this trait to add support for new AI assistants
#[async_trait]
pub trait AiAssistant: Send + Sync {
    /// Get the name of this assistant (e.g., "claude", "codex", "pi")
    fn name(&self) -> &str;
    
    /// Get the display name (e.g., "Claude Code", "Codex", "Pi Agent")
    fn display_name(&self) -> &str;
    
    /// Get available models for this assistant
    fn available_models(&self) -> Vec<ModelInfo>;
    
    /// Get the default model
    fn default_model(&self) -> &str;
    
    /// Create a new session
    async fn create_session(&mut self, cwd: String, model: Option<String>) -> Result<String, String>;

    /// Send a message and get a response
    async fn send_message(&self, session_id: &str, message: &str) -> Result<AiResponse, String>;

    /// Send a message with streaming response
    async fn send_message_streaming(
        &self,
        session_id: &str,
        message: &str,
        callback: Box<dyn Fn(AiEvent) + Send>,
    ) -> Result<(), String>;

    /// Set the model for a session
    fn set_model(&mut self, session_id: &str, model: &str) -> Result<(), String>;

    /// Get the current model for a session
    fn get_model(&self, session_id: &str) -> Option<String>;

    /// Delete a session
    fn delete_session(&mut self, session_id: &str);

    /// Check if the assistant is available (e.g., CLI is installed)
    async fn is_available(&self) -> bool;
    
    /// Get the version of the assistant
    async fn version(&self) -> Option<String>;
}

/// Registry for managing multiple AI assistants
pub struct AssistantRegistry {
    assistants: Vec<Box<dyn AiAssistant>>,
    default_index: usize,
}

impl AssistantRegistry {
    pub fn new() -> Self {
        Self {
            assistants: Vec::new(),
            default_index: 0,
        }
    }
    
    /// Register a new assistant
    pub fn register(&mut self, assistant: Box<dyn AiAssistant>) {
        self.assistants.push(assistant);
    }
    
    /// Set the default assistant by name
    pub fn set_default(&mut self, name: &str) -> Result<(), String> {
        if let Some(index) = self.assistants.iter().position(|a| a.name() == name) {
            self.default_index = index;
            Ok(())
        } else {
            Err(format!("Assistant '{}' not found", name))
        }
    }
    
    /// Get the default assistant
    pub fn get_default(&self) -> &dyn AiAssistant {
        self.assistants[self.default_index].as_ref()
    }
    
    /// Get the default assistant (mutable)
    pub fn get_default_mut(&mut self) -> &mut dyn AiAssistant {
        self.assistants[self.default_index].as_mut()
    }
    
    /// Get an assistant by name
    pub fn get(&self, name: &str) -> Option<&dyn AiAssistant> {
        self.assistants.iter().find(|a| a.name() == name).map(|a| a.as_ref())
    }
    
    /// Get an assistant by name (mutable)
    pub fn get_mut(&mut self, name: &str) -> Option<&mut Box<dyn AiAssistant>> {
        self.assistants.iter_mut().find(|a| a.name() == name)
    }
    
    /// List all available assistants
    pub fn list(&self) -> Vec<AssistantInfo> {
        self.assistants.iter().enumerate().map(|(i, a)| {
            AssistantInfo {
                name: a.name().to_string(),
                display_name: a.display_name().to_string(),
                is_default: i == self.default_index,
            }
        }).collect()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AssistantInfo {
    pub name: String,
    pub display_name: String,
    pub is_default: bool,
}
