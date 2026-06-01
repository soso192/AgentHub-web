use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub assistant: String,
    pub cwd: String,
    pub model: String,
    pub messages: Vec<Message>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Context from previous assistant, injected into first message after switch
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_context: Option<String>,
    /// Agent's native session ID for session continuity (Claude --resume / Pi --session)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_blocks: Option<Vec<ContentBlock>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String, input: serde_json::Value },
    #[serde(rename = "tool_result")]
    ToolResult { tool_use_id: String, content: String },
}

#[derive(Debug, Deserialize)]
pub struct NewSessionRequest {
    pub cwd: String,
    pub message: Option<String>,
    pub model: Option<String>,
    pub assistant: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StartPromptRequest {
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct CommandRequest {
    #[serde(rename = "type")]
    pub cmd_type: String,
    pub message: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub content_blocks: Option<Vec<ContentBlock>>,
}

#[derive(Debug, Deserialize)]
pub struct SwitchAssistantRequest {
    pub assistant: String,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ModelsResponse {
    pub models: std::collections::HashMap<String, String>,
    pub model_list: Vec<ModelInfo>,
    pub default_model: DefaultModel,
}

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
}

#[derive(Debug, Serialize)]
pub struct DefaultModel {
    pub provider: String,
    pub model_id: String,
}
