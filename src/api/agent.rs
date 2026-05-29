use actix_web::{web, HttpResponse, HttpRequest};
use actix_web::rt::time;
use tokio::sync::mpsc;
use futures::StreamExt;
use crate::models::{NewSessionRequest, CommandRequest, Message, AgentEvent};
use crate::AppState;
use chrono::Utc;

pub async fn new_session(
    data: web::Data<AppState>,
    req: web::Json<NewSessionRequest>,
) -> HttpResponse {
    let model = req.model.clone()
        .or_else(|| {
            dirs::home_dir()
                .map(|h| h.join(".claude").join("settings.json"))
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|s| s.get("env")?.get("ANTHROPIC_MODEL")?.as_str().map(String::from))
        })
        .unwrap_or_else(|| "MiniMax-M2.7".to_string());

    let session_id = data.claude_manager.lock().unwrap()
        .create_session(req.cwd.clone(), Some(model.clone()));

    let now = Utc::now();
    let user_message = Message {
        role: "user".to_string(),
        content: req.message.clone(),
        timestamp: now.timestamp_millis(),
    };

    let session = crate::models::Session {
        id: session_id.clone(),
        cwd: req.cwd.clone(),
        model: model.clone(),
        messages: vec![user_message],
        created_at: now,
        updated_at: now,
    };

    data.sessions.lock().unwrap().insert(session_id.clone(), session);

    // Call Claude
    let claude_response = data.claude_manager.lock().unwrap()
        .call_claude(&session_id, &req.message);

    match claude_response {
        Ok(response) => {
            let assistant_message = Message {
                role: "assistant".to_string(),
                content: response.clone(),
                timestamp: Utc::now().timestamp_millis(),
            };

            if let Some(session) = data.sessions.lock().unwrap().get_mut(&session_id) {
                session.messages.push(assistant_message);
                session.updated_at = Utc::now();
            }

            HttpResponse::Ok().json(serde_json::json!({
                "success": true,
                "sessionId": session_id,
                "data": {
                    "response": response
                }
            }))
        }
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "success": false,
            "error": e
        })),
    }
}

pub async fn send_command(
    data: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<CommandRequest>,
) -> HttpResponse {
    let session_id = path.into_inner();

    match req.cmd_type.as_str() {
        "prompt" => {
            if let Some(message) = &req.message {
                let user_message = Message {
                    role: "user".to_string(),
                    content: message.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                };

                if let Some(session) = data.sessions.lock().unwrap().get_mut(&session_id) {
                    session.messages.push(user_message);
                    session.updated_at = Utc::now();
                }

                let claude_response = data.claude_manager.lock().unwrap()
                    .call_claude(&session_id, message);

                match claude_response {
                    Ok(response) => {
                        let assistant_message = Message {
                            role: "assistant".to_string(),
                            content: response.clone(),
                            timestamp: Utc::now().timestamp_millis(),
                        };

                        if let Some(session) = data.sessions.lock().unwrap().get_mut(&session_id) {
                            session.messages.push(assistant_message);
                            session.updated_at = Utc::now();
                        }

                        HttpResponse::Ok().json(serde_json::json!({
                            "success": true,
                            "data": { "response": response }
                        }))
                    }
                    Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
                        "success": false,
                        "error": e
                    })),
                }
            } else {
                HttpResponse::BadRequest().json(serde_json::json!({
                    "success": false,
                    "error": "Message is required"
                }))
            }
        }
        "set_model" => {
            if let Some(model) = &req.model {
                data.claude_manager.lock().unwrap()
                    .set_session_model(&session_id, model.clone());
                
                if let Some(session) = data.sessions.lock().unwrap().get_mut(&session_id) {
                    session.model = model.clone();
                    session.updated_at = Utc::now();
                }

                HttpResponse::Ok().json(serde_json::json!({
                    "success": true,
                    "data": null
                }))
            } else {
                HttpResponse::BadRequest().json(serde_json::json!({
                    "success": false,
                    "error": "Model is required"
                }))
            }
        }
        "get_state" => {
            let sessions = data.sessions.lock().unwrap();
            if let Some(session) = sessions.get(&session_id) {
                HttpResponse::Ok().json(serde_json::json!({
                    "success": true,
                    "data": {
                        "sessionId": session.id,
                        "model": session.model,
                        "messageCount": session.messages.len(),
                        "cwd": session.cwd,
                        "isStreaming": false
                    }
                }))
            } else {
                HttpResponse::NotFound().json(serde_json::json!({
                    "success": false,
                    "error": "Session not found"
                }))
            }
        }
        _ => HttpResponse::BadRequest().json(serde_json::json!({
            "success": false,
            "error": format!("Unknown command: {}", req.cmd_type)
        })),
    }
}

pub async fn get_state(
    data: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let session_id = path.into_inner();
    let sessions = data.sessions.lock().unwrap();
    
    if let Some(session) = sessions.get(&session_id) {
        HttpResponse::Ok().json(serde_json::json!({
            "running": true,
            "state": {
                "sessionId": session.id,
                "model": session.model,
                "messageCount": session.messages.len(),
                "cwd": session.cwd,
                "isStreaming": false
            }
        }))
    } else {
        HttpResponse::Ok().json(serde_json::json!({
            "running": false
        }))
    }
}

pub async fn events(
    data: web::Data<AppState>,
    path: web::Path<String>,
    req: HttpRequest,
) -> HttpResponse {
    let session_id = path.into_inner();
    
    // Verify session exists
    let exists = data.sessions.lock().unwrap().contains_key(&session_id);
    if !exists {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "Session not found"
        }));
    }

    let (tx, rx) = mpsc::unbounded_channel::<String>();

    // Send connected event
    let _ = tx.send(serde_json::json!({
        "type": "connected",
        "sessionId": session_id
    }).to_string());

    // Create SSE stream
    let stream = async_stream::stream! {
        let mut rx = rx;
        while let Some(msg) = rx.recv().await {
            yield Ok::<_, actix_web::Error>(actix_web::web::Bytes::from(format!("data: {}\n\n", msg)));
        }
    };

    HttpResponse::Ok()
        .insert_header(("Content-Type", "text/event-stream"))
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("Connection", "keep-alive"))
        .streaming(stream)
}
