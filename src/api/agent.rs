use actix_web::{web, HttpResponse, HttpRequest};
use tokio::sync::mpsc;
use crate::models::{NewSessionRequest, CommandRequest, Message};
use crate::AppState;
use chrono::Utc;

pub async fn new_session(
    data: web::Data<AppState>,
    req: web::Json<NewSessionRequest>,
) -> HttpResponse {
    let assistant_name = req.assistant.clone().unwrap_or_else(|| "claude".to_string());
    let model = req.model.clone();
    
    let mut registry = data.registry.lock().unwrap();
    
    // Get the requested assistant
    let assistant = match registry.get_mut(&assistant_name) {
        Some(a) => a,
        None => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "success": false,
                "error": format!("Assistant '{}' not found", assistant_name)
            }));
        }
    };

    // Create session - use async directly
    let session_id = match assistant.create_session(req.cwd.clone(), model.clone()).await {
        Ok(id) => id,
        Err(e) => {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "success": false,
                "error": e
            }));
        }
    };

    let current_model = assistant.get_model(&session_id)
        .unwrap_or_else(|| assistant.default_model().to_string());

    // Drop the registry lock before sending message
    drop(registry);

    // Store session info
    let now = Utc::now();
    let user_message = Message {
        role: "user".to_string(),
        content: req.message.clone(),
        timestamp: now.timestamp_millis(),
    };

    let session = crate::models::Session {
        id: session_id.clone(),
        assistant: assistant_name.clone(),
        cwd: req.cwd.clone(),
        model: current_model.clone(),
        messages: vec![user_message],
        created_at: now,
        updated_at: now,
    };

    data.sessions.lock().unwrap().insert(session_id.clone(), session);

    // Send message to assistant
    let registry = data.registry.lock().unwrap();
    let assistant = match registry.get(&assistant_name) {
        Some(a) => a,
        None => {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "success": false,
                "error": format!("Assistant '{}' not available", assistant_name)
            }));
        }
    };

    let response = assistant.send_message(&session_id, &req.message).await;

    match response {
        Ok(resp) => {
            let assistant_message = Message {
                role: "assistant".to_string(),
                content: resp.content.clone(),
                timestamp: Utc::now().timestamp_millis(),
            };

            if let Some(session) = data.sessions.lock().unwrap().get_mut(&session_id) {
                session.messages.push(assistant_message);
                session.updated_at = Utc::now();
            }

            HttpResponse::Ok().json(serde_json::json!({
                "success": true,
                "sessionId": session_id,
                "assistant": assistant_name,
                "data": {
                    "response": resp.content,
                    "model": resp.model
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
    
    // Get session info
    let session_info = data.sessions.lock().unwrap()
        .get(&session_id)
        .map(|s| (s.assistant.clone(), s.model.clone()));

    let (assistant_name, _model) = match session_info {
        Some(info) => info,
        None => {
            return HttpResponse::NotFound().json(serde_json::json!({
                "success": false,
                "error": "Session not found"
            }));
        }
    };

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

                let registry = data.registry.lock().unwrap();
                let assistant = match registry.get(&assistant_name) {
                    Some(a) => a,
                    None => {
                        return HttpResponse::InternalServerError().json(serde_json::json!({
                            "success": false,
                            "error": format!("Assistant '{}' not available", assistant_name)
                        }));
                    }
                };

                let response = assistant.send_message(&session_id, message).await;

                match response {
                    Ok(resp) => {
                        let assistant_message = Message {
                            role: "assistant".to_string(),
                            content: resp.content.clone(),
                            timestamp: Utc::now().timestamp_millis(),
                        };

                        if let Some(session) = data.sessions.lock().unwrap().get_mut(&session_id) {
                            session.messages.push(assistant_message);
                            session.updated_at = Utc::now();
                        }

                        HttpResponse::Ok().json(serde_json::json!({
                            "success": true,
                            "data": {
                                "response": resp.content,
                                "model": resp.model
                            }
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
                let mut registry = data.registry.lock().unwrap();
                let assistant = match registry.get_mut(&assistant_name) {
                    Some(a) => a,
                    None => {
                        return HttpResponse::InternalServerError().json(serde_json::json!({
                            "success": false,
                            "error": format!("Assistant '{}' not available", assistant_name)
                        }));
                    }
                };

                if let Err(e) = assistant.set_model(&session_id, model) {
                    return HttpResponse::InternalServerError().json(serde_json::json!({
                        "success": false,
                        "error": e
                    }));
                }
                
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
                        "assistant": session.assistant,
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
                "assistant": session.assistant,
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
    _req: HttpRequest,
) -> HttpResponse {
    let session_id = path.into_inner();
    
    let exists = data.sessions.lock().unwrap().contains_key(&session_id);
    if !exists {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "Session not found"
        }));
    }

    let (tx, rx) = mpsc::unbounded_channel::<String>();

    let _ = tx.send(serde_json::json!({
        "type": "connected",
        "sessionId": session_id
    }).to_string());

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
