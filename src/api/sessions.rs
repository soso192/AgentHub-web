use actix_web::{web, HttpResponse};
use crate::AppState;

pub async fn list_sessions(data: web::Data<AppState>) -> HttpResponse {
    let sessions = data.sessions.lock().unwrap();
    let session_list: Vec<serde_json::Value> = sessions.iter().map(|(id, session)| {
        serde_json::json!({
            "id": id,
            "cwd": session.cwd,
            "model": session.model,
            "messageCount": session.messages.len(),
            "firstMessage": session.messages.first().map(|m| m.content.clone()).unwrap_or_default(),
            "created": session.created_at.to_rfc3339(),
            "modified": session.updated_at.to_rfc3339(),
        })
    }).collect();

    HttpResponse::Ok().json(serde_json::json!({
        "sessions": session_list
    }))
}

pub async fn get_session(
    data: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let session_id = path.into_inner();
    let sessions = data.sessions.lock().unwrap();
    
    if let Some(session) = sessions.get(&session_id) {
        HttpResponse::Ok().json(serde_json::json!({
            "sessionId": session.id,
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
    let mut sessions = data.sessions.lock().unwrap();
    
    if let Some(session) = sessions.remove(&session_id) {
        // Remove from the appropriate assistant
        let mut registry = data.registry.lock().unwrap();
        if let Some(assistant) = registry.get_mut(&session.assistant) {
            assistant.delete_session(&session_id);
        }
        HttpResponse::Ok().json(serde_json::json!({ "ok": true }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({
            "error": "Session not found"
        }))
    }
}
