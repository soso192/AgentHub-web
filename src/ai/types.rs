use serde::{Deserialize, Serialize};

/// Response from an AI assistant
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResponse {
    pub content: String,
    pub model: String,
    pub usage: Option<Usage>,
    pub metadata: Option<serde_json::Value>,
}

/// Token usage information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
}

/// Event for streaming responses
#[derive(Debug, Clone, Serialize)]
pub struct AiEvent {
    pub event_type: String,
    pub data: AiEventData,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum AiEventData {
    #[serde(rename = "start")]
    Start {
        session_id: String,
        model: String,
    },
    #[serde(rename = "chunk")]
    Chunk {
        content: String,
        accumulated: String,
    },
    #[serde(rename = "message")]
    Message {
        role: String,
        content: String,
    },
    #[serde(rename = "tool_call")]
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        id: String,
        output: String,
    },
    #[serde(rename = "end")]
    End {
        response: AiResponse,
    },
    #[serde(rename = "error")]
    Error {
        message: String,
    },
}

/// Model information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub max_tokens: Option<u32>,
    pub supports_streaming: bool,
    pub supports_tools: bool,
}

/// Session information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub assistant: String,
    pub model: String,
    pub cwd: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub message_count: usize,
}

/// Message in a conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub timestamp: i64,
}
