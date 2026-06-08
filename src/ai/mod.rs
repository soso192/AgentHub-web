// AI Assistant Interface Module
// This module provides a trait-based abstraction for different AI coding assistants.

pub mod claude;
pub mod codex;
pub mod pi;
pub mod streaming;
pub mod types;

use async_trait::async_trait;
use tokio::sync::broadcast;
use types::{AiResponse, AiEvent, ModelInfo};
use streaming::StreamResult;

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

    /// Stream a session message. Each agent implements its own CLI invocation.
    /// Default implementation does nothing (returns empty StreamResult).
    /// `pid_callback` is called with the child process PID as soon as it's spawned,
    /// allowing the caller to store the PID for abort support before streaming completes.
    /// `on_result_callback` is called when the result event is sent, allowing early cleanup.
    fn stream_session(
        &self,
        _session_id: &str,
        _cwd: &str,
        _model: &str,
        _message: &str,
        _tx: Option<&broadcast::Sender<String>>,
        _agent_session_id: Option<&str>,
        _pid_callback: Option<Box<dyn Fn(u32) + Send>>,
        _on_result_callback: Option<Box<dyn Fn() + Send>>,
    ) -> StreamResult {
        StreamResult { agent_session_id: None, pid: None, result_sent: false }
    }

    /// Check if the assistant is available (e.g., CLI is installed)
    async fn is_available(&self) -> bool;

    /// Get the version of the assistant
    async fn version(&self) -> Option<String>;
}

/// Type alias for a shared, individually-locked assistant
type AssistantHandle = std::sync::Arc<std::sync::RwLock<Box<dyn AiAssistant>>>;

/// Registry for managing multiple AI assistants.
/// Each assistant is wrapped in Arc<RwLock<>> so it can be locked independently —
/// streaming on one assistant does not block creation or streaming on another.
pub struct AssistantRegistry {
    /// name → assistant handle (each independently lockable)
    assistants: std::collections::HashMap<String, AssistantHandle>,
    default_name: String,
    /// Cached availability results (name -> (available, version))
    availability_cache: std::collections::HashMap<String, (bool, Option<String>)>,
}

impl AssistantRegistry {
    pub fn new() -> Self {
        Self {
            assistants: std::collections::HashMap::new(),
            default_name: String::new(),
            availability_cache: std::collections::HashMap::new(),
        }
    }

    /// Register a new assistant
    pub fn register(&mut self, assistant: Box<dyn AiAssistant>) {
        let name = assistant.name().to_string();
        if self.default_name.is_empty() {
            self.default_name = name.clone();
        }
        self.assistants.insert(name, std::sync::Arc::new(std::sync::RwLock::new(assistant)));
    }

    /// Set the default assistant by name
    pub fn set_default(&mut self, name: &str) -> Result<(), String> {
        if self.assistants.contains_key(name) {
            self.default_name = name.to_string();
            Ok(())
        } else {
            Err(format!("Assistant '{}' not found", name))
        }
    }

    /// Get the default assistant's name
    pub fn default_name(&self) -> &str {
        &self.default_name
    }

    /// Get an assistant handle by name. Clone the Arc to use independently of the registry lock.
    pub fn get_handle(&self, name: &str) -> Option<AssistantHandle> {
        self.assistants.get(name).cloned()
    }

    /// Get the default assistant handle
    pub fn get_default_handle(&self) -> Option<AssistantHandle> {
        self.assistants.get(&self.default_name).cloned()
    }

    /// Check if an assistant exists
    pub fn has(&self, name: &str) -> bool {
        self.assistants.contains_key(name)
    }

    /// List all registered assistants (without availability check)
    pub fn list(&self) -> Vec<AssistantInfo> {
        self.assistants.iter().map(|(name, handle)| {
            let a = handle.read().unwrap();
            AssistantInfo {
                name: name.clone(),
                display_name: a.display_name().to_string(),
                is_default: *name == self.default_name,
                available: false,
                version: None,
            }
        }).collect()
    }

    /// List all assistants with availability check (cached)
    pub async fn list_available(&mut self) -> Vec<AssistantInfo> {
        let mut result = Vec::new();
        for (name, handle) in self.assistants.iter() {
            let a = handle.read().unwrap();
            let (available, version) = if let Some(cached) = self.availability_cache.get(name) {
                cached.clone()
            } else {
                let avail = a.is_available().await;
                let ver = if avail { a.version().await } else { None };
                self.availability_cache.insert(name.clone(), (avail, ver.clone()));
                (avail, ver)
            };
            result.push(AssistantInfo {
                name: name.clone(),
                display_name: a.display_name().to_string(),
                is_default: *name == self.default_name,
                available,
                version,
            });
        }
        result
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AssistantInfo {
    pub name: String,
    pub display_name: String,
    pub is_default: bool,
    pub available: bool,
    pub version: Option<String>,
}
