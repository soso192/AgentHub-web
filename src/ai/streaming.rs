// ══════════════════════════════════════════════════════════════
//  Shared stream-json event parser for all AI agents
//
//  Claude CLI and Pi Agent both output structured JSON events to stdout.
//  This module parses those events and broadcasts them through a
//  shared broadcast channel, which feeds both the SSE endpoint
//  (real-time push to frontend) and the event saver (persist to disk).
//
//  Event types:
//    system/init → "start" — streaming session initialized
//    assistant   → "thinking" / "tool_call" / "chunk" — content blocks
//    user        → "tool_result" — tool execution output
//    result      → "result" / "error" — session completed
//
//  Returns: (agent_session_id, result_sent)
//    - agent_session_id: native session ID for --resume support
//    - result_sent: whether a terminal event (result/error) was broadcast
//      (used by callers to trigger on_result_callback for early cleanup)
// ══════════════════════════════════════════════════════════════

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

/// Parse one line of the agent's JSON output and broadcast SSE events.
///
/// Returns (agent_session_id, result_sent) to let the caller know:
///   1. Whether a native session ID was captured (for --resume)
///   2. Whether a terminal event was broadcast (for on_result_callback)
///
/// Previously this function only returned Option<String> (session ID),
/// which meant Claude/Codex had no way to know when the result was sent.
/// Now it returns both values, allowing all agents to call on_result_callback
/// immediately when the result event is broadcast — enabling faster cleanup
/// of streaming_sessions and more accurate isStreaming status.
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
        // ── Session init: capture native session ID for --resume ──
        // This allows the agent to resume the session next time
        // instead of starting fresh, preserving conversation history.
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
        // ── Assistant message: thinking + tool_use + text blocks ──
        // Claude sends these as content blocks inside an "assistant" event.
        // Each block type is broadcast as a separate SSE event.
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
        // ── User message (tool results from Claude) ──
        // Claude sends tool results as "user" type messages with
        // "tool_result" content blocks.
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
        // ── Result: final response or error ──
        // This is a terminal event. After this:
        //   - result_sent = true signals the caller to invoke on_result_callback
        //   - The frontend finishes streaming and closes the SSE connection
        //   - The session is cleaned up from streaming_sessions
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

/// 统一的事件发送函数
///
/// 所有 Agent（Claude、Pi、Codex）都通过这个函数发送 SSE 事件。
/// 之前每个 Agent 有自己的 send_*_event 函数（send_pi_event、send_codex_event），
/// 日志级别不一致。现在统一使用 streaming::send_event，trace 级别记录成功，
/// warn 级别记录失败，方便调试。
///
/// broadcast::Sender 是 Arc 包装的，多个克隆共享同一个底层 channel。
/// 当所有 receiver 都断开连接后，send 会返回错误（前端的 EventSource 已关闭）。
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
