use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub cwd: String,
    pub model: String,
    pub messages: Vec<Message>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub timestamp: i64,
}

#[derive(Debug, Deserialize)]
pub struct NewSessionRequest {
    pub cwd: String,
    pub message: String,
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CommandRequest {
    #[serde(rename = "type")]
    pub cmd_type: String,
    pub message: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApiResponse<T: Serialize> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
}

#[derive(Debug, Serialize)]
pub struct ModelsResponse {
    pub models: std::collections::HashMap<String, String>,
    pub model_list: Vec<ModelInfo>,
    pub default_model: DefaultModel,
}

#[derive(Debug, Serialize)]
pub struct DefaultModel {
    pub provider: String,
    pub model_id: String,
}

#[derive(Debug, Serialize)]
pub struct AgentEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
