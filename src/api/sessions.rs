use actix_web::{web, HttpResponse};
use crate::AppState;

pub async fn list_sessions(data: web::Data<AppState>) -> HttpResponse {
    let sessions = data.sessions.read().unwrap();
    let streaming = data.streaming_sessions.read().unwrap();
    let mut session_list: Vec<serde_json::Value> = sessions.iter().map(|(id, session)| {
        serde_json::json!({
            "id": id,
            "assistant": session.assistant,
            "cwd": session.cwd,
            "model": session.model,
            "messageCount": session.messages.len(),
            "firstMessage": session.messages.first().map(|m| m.content.clone()).unwrap_or_default(),
            "created": session.created_at.to_rfc3339(),
            "modified": session.updated_at.to_rfc3339(),
            "isStreaming": streaming.contains(id),
        })
    }).collect();

    // Sort by modified time, newest first
    session_list.sort_by(|a, b| {
        let a_time = a.get("modified").and_then(|v| v.as_str()).unwrap_or("");
        let b_time = b.get("modified").and_then(|v| v.as_str()).unwrap_or("");
        b_time.cmp(a_time)
    });

    HttpResponse::Ok().json(serde_json::json!({
        "sessions": session_list
    }))
}

pub async fn get_session(
    data: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let session_id = path.into_inner();
    let sessions = data.sessions.read().unwrap();

    if let Some(session) = sessions.get(&session_id) {
        HttpResponse::Ok().json(serde_json::json!({
            "sessionId": session.id,
            "assistant": session.assistant,
            "cwd": session.cwd,
            "model": session.model,
            "messages": session.messages,
            "created": session.created_at.to_rfc3339(),
            "modified": session.updated_at.to_rfc3339(),
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({
            "error": "Session not found"
        }))
    }
}

pub async fn delete_session(
    data: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let session_id = path.into_inner();
    let mut sessions = data.sessions.write().unwrap();

    if let Some(session) = sessions.remove(&session_id) {
        crate::save_sessions_to_disk(&sessions);
        drop(sessions);
        // Remove from the appropriate assistant (handle-based, no registry write lock)
        let registry = data.registry.read().unwrap();
        if let Some(handle) = registry.get_handle(&session.assistant) {
            let mut assistant = handle.write().unwrap();
            assistant.delete_session(&session_id);
        }
        HttpResponse::Ok().json(serde_json::json!({ "ok": true }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({
            "error": "Session not found"
        }))
    }
}
