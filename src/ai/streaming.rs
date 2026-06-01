// Shared stream-json event parsing for all agents
// Both Claude CLI and Pi Agent use the same stream-json format

use tokio::sync::broadcast;
use serde_json::Value;

/// Result of a streaming session
pub struct StreamResult {
    /// The agent's internal session ID (for --resume / session continuity)
    pub agent_session_id: Option<String>,
}

/// Process one line of stream-json output and broadcast the corresponding SSE event.
/// Returns the agent's session_id if found in an init event.
pub fn process_stream_line(
    line: &str,
    session_id: &str,
    model: &str,
    tx: Option<&broadcast::Sender<String>>,
) -> Option<String> {
    let event: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return None,
    };

    let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let subtype = event.get("subtype").and_then(|s| s.as_str());

    let mut agent_session_id = None;

    match event_type {
        "system" if subtype == Some("init") => {
            // Capture agent session ID for session continuity
            if let Some(sid) = event.get("session_id").and_then(|s| s.as_str()) {
                agent_session_id = Some(sid.to_string());
            }
            send_event(tx, serde_json::json!({
                "type": "start",
                "sessionId": session_id,
                "model": model
            }));
        }
        "assistant" => {
            if let Some(message_obj) = event.get("message") {
                if let Some(content_arr) = message_obj.get("content").and_then(|c| c.as_array()) {
                    for block in content_arr {
                        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        match block_type {
                            "thinking" => {
                                if let Some(thinking_text) = block.get("thinking").and_then(|t| t.as_str()) {
                                    send_event(tx, serde_json::json!({
                                        "type": "thinking",
                                        "thinking": thinking_text
                                    }));
                                }
                            }
                            "tool_use" => {
                                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
                                let input = block.get("input").cloned().unwrap_or(Value::Null);
                                send_event(tx, serde_json::json!({
                                    "type": "tool_call",
                                    "id": id,
                                    "name": name,
                                    "input": input
                                }));
                            }
                            "text" => {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    send_event(tx, serde_json::json!({
                                        "type": "chunk",
                                        "content": text
                                    }));
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        "user" => {
            // Tool results come as user messages
            if let Some(message_obj) = event.get("message") {
                if let Some(content_arr) = message_obj.get("content").and_then(|c| c.as_array()) {
                    for block in content_arr {
                        if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                            let tool_use_id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                            let content = block.get("content").map(|c| {
                                if let Some(s) = c.as_str() { s.to_string() }
                                else { c.to_string() }
                            }).unwrap_or_default();
                            send_event(tx, serde_json::json!({
                                "type": "tool_result",
                                "id": tool_use_id,
                                "output": content
                            }));
                        }
                    }
                }
            }
        }
        "result" => {
            let result_text = event.get("result").and_then(|r| r.as_str()).unwrap_or("");
            let is_error = event.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);

            if is_error {
                send_event(tx, serde_json::json!({
                    "type": "error",
                    "message": result_text
                }));
            } else {
                send_event(tx, serde_json::json!({
                    "type": "result",
                    "content": result_text,
                    "model": model
                }));
            }
        }
        _ => {}
    }

    agent_session_id
}

/// Send a JSON event through the broadcast channel
pub fn send_event(tx: Option<&broadcast::Sender<String>>, event: serde_json::Value) {
    if let Some(tx) = tx {
        let _ = tx.send(event.to_string());
    }
}
