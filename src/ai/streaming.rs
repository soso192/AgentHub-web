// Shared stream-json event parsing for all agents
// Both Claude CLI and Pi Agent use the same stream-json format

use tokio::sync::broadcast;
use serde_json::Value;

/// Result of a streaming session
pub struct StreamResult {
    /// The agent's internal session ID (for --resume / session continuity)
    pub agent_session_id: Option<String>,
    /// The child process ID (for abort support)
    pub pid: Option<u32>,
    /// Whether a result event was already sent (for early cleanup)
    pub result_sent: bool,
}

/// Process one line of stream-json output and broadcast the corresponding SSE event.
/// Returns (agent_session_id, result_sent) where result_sent indicates if a
/// "result" or "error" event was broadcast (used for on_result_callback).
pub fn process_stream_line(
    line: &str,
    session_id: &str,
    model: &str,
    tx: Option<&broadcast::Sender<String>>,
) -> (Option<String>, bool) {
    let event: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[streaming] JSON parse error: {} (line: {})", e, &line[..line.len().min(80)]);
            return (None, false);
        }
    };

    let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let subtype = event.get("subtype").and_then(|s| s.as_str());

    let mut agent_session_id = None;
    let mut result_sent = false;

    match event_type {
        "system" if subtype == Some("init") => {
            if let Some(sid) = event.get("session_id").and_then(|s| s.as_str()) {
                agent_session_id = Some(sid.to_string());
                log::debug!("[streaming] init: session_id={}", sid);
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
                                let input = block.get("input").cloned().unwrap_or_else(|| serde_json::json!({}));
                                log::trace!("[streaming] tool_use: name={}", name);
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
                log::warn!("[streaming] error result: {}", &result_text[..result_text.len().min(100)]);
                send_event(tx, serde_json::json!({
                    "type": "error",
                    "message": result_text
                }));
            } else {
                log::debug!("[streaming] result sent (len={})", result_text.len());
                send_event(tx, serde_json::json!({
                    "type": "result",
                    "content": result_text,
                    "model": model
                }));
            }
            result_sent = true;
        }
        _ => {
            log::trace!("[streaming] unhandled event type: {}", event_type);
        }
    }

    (agent_session_id, result_sent)
}

/// Send a JSON event through the broadcast channel.
/// Logs send failures at warn level (indicates receivers disconnected).
pub fn send_event(tx: Option<&broadcast::Sender<String>>, event: serde_json::Value) {
    if let Some(tx) = tx {
        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("unknown");
        match tx.send(event.to_string()) {
            Ok(_) => {
                log::trace!("[sse:send] type={}, receivers={}", event_type, tx.receiver_count());
            }
            Err(e) => {
                log::warn!("[sse:send] FAILED type={}: {}", event_type, e);
            }
        }
    }
}
