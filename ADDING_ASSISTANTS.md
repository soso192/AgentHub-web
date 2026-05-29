# Adding New AI Assistants

This guide explains how to add support for new AI coding assistants (e.g., Codex, Pi-Agent, Cursor, etc.)

## Architecture Overview

```
src/ai/
├── mod.rs              # AiAssistant trait + AssistantRegistry
├── types.rs            # Common types (AiResponse, AiEvent, ModelInfo)
├── claude.rs           # Claude Code implementation
└── example_assistant.rs # Example template
```

## Step-by-Step Guide

### 1. Create a New Assistant File

Create `src/ai/your_assistant.rs`:

```rust
use super::{AiAssistant, types::*};
use async_trait::async_trait;
use std::collections::HashMap;
use uuid::Uuid;

pub struct YourAssistant {
    sessions: HashMap<String, YourSession>,
    default_model: String,
}

struct YourSession {
    cwd: String,
    model: String,
}

impl YourAssistant {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            default_model: "your-default-model".to_string(),
        }
    }
}
```

### 2. Implement the AiAssistant Trait

```rust
#[async_trait]
impl AiAssistant for YourAssistant {
    // Required methods:
    
    fn name(&self) -> &str {
        "your_assistant"  // Unique identifier
    }
    
    fn display_name(&self) -> &str {
        "Your Assistant"  // Display name in UI
    }
    
    fn available_models(&self) -> Vec<ModelInfo> {
        vec![
            ModelInfo {
                id: "model-1".to_string(),
                name: "Model 1".to_string(),
                provider: "your_provider".to_string(),
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
        
        self.sessions.insert(session_id.clone(), YourSession {
            cwd,
            model,
        });
        
        Ok(session_id)
    }
    
    async fn send_message(&self, session_id: &str, message: &str) -> Result<AiResponse, String> {
        let session = self.sessions.get(session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        
        // TODO: Call your AI assistant CLI or API
        let response = call_your_assistant(&session.cwd, &session.model, message).await?;
        
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
        // TODO: Implement streaming if supported
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
        // TODO: Check if your assistant is installed
        true
    }
    
    async fn version(&self) -> Option<String> {
        // TODO: Get version
        Some("1.0.0".to_string())
    }
}
```

### 3. Register in main.rs

```rust
mod ai;

use ai::your_assistant::YourAssistant;

// In main():
let mut registry = AssistantRegistry::new();

// Register Claude
registry.register(Box::new(ClaudeAssistant::new()));

// Register your assistant
registry.register(Box::new(YourAssistant::new()));

// Optionally set default
registry.set_default("your_assistant").ok();
```

### 4. Add to ai/mod.rs

```rust
pub mod your_assistant;
```

## Examples of CLI Integration

### Calling a CLI Tool

```rust
async fn call_your_assistant(cwd: &str, model: &str, message: &str) -> Result<String, String> {
    let output = tokio::process::Command::new("your-cli")
        .args(&["--model", model, "--message", message])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to start CLI: {}", e))?;
    
    if output.status.success() {
        String::from_utf8(output.stdout)
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("Invalid UTF-8: {}", e))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("CLI error: {}", stderr))
    }
}
```

### Calling an HTTP API

```rust
async fn call_your_api(model: &str, message: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    
    let response = client.post("https://api.example.com/v1/chat")
        .json(&serde_json::json!({
            "model": model,
            "message": message,
        }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    
    let data: serde_json::Value = response.json().await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    
    data["response"].as_str()
        .map(String::from)
        .ok_or_else(|| "No response field".to_string())
}
```

## API Endpoints

After registering your assistant, it will be available via:

- `GET /api/assistants` - List all assistants
- `POST /api/agent/new` with `{"assistant": "your_assistant", ...}` - Use your assistant

## Frontend Integration

The frontend will automatically show your assistant in the model selector if you implement `available_models()` correctly.

## Tips

1. **Error Handling**: Always return descriptive errors
2. **Session Management**: Clean up resources in `delete_session()`
3. **Streaming**: Implement `send_message_streaming()` for better UX
4. **Availability Check**: Implement `is_available()` to handle missing CLI gracefully

## Existing Implementations

- `claude.rs` - Claude Code CLI (reference implementation)
- `example_assistant.rs` - Template for new assistants
