use actix_web::{web, HttpResponse, HttpRequest};
use tokio::sync::broadcast;
use crate::models::{NewSessionRequest, StartPromptRequest, SwitchAssistantRequest, CommandRequest, Message};
use crate::AppState;
use chrono::Utc;

pub async fn new_session(
    data: web::Data<AppState>,
    req: web::Json<NewSessionRequest>,
) -> HttpResponse {
    let assistant_name = req.assistant.clone().unwrap_or_else(|| "claude".to_string());
    let model = req.model.clone();

    let mut registry = data.registry.lock().unwrap();

    let assistant = match registry.get_mut(&assistant_name) {
        Some(a) => a,
        None => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "success": false,
                "error": format!("Assistant '{}' not found", assistant_name)
            }));
        }
    };

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

    drop(registry);

    let now = Utc::now();

    let mut messages = Vec::new();
    if let Some(ref msg) = req.message {
        messages.push(Message {
            role: "user".to_string(),
            content: msg.clone(),
            timestamp: now.timestamp_millis(),
            content_blocks: None,
        });
    }

    let session = crate::models::Session {
        id: session_id.clone(),
        assistant: assistant_name.clone(),
        cwd: req.cwd.clone(),
        model: current_model.clone(),
        messages,
        created_at: now,
        updated_at: now,
        history_context: None,
        agent_session_id: None,
    };

    data.sessions.lock().unwrap().insert(session_id.clone(), session);
    crate::save_sessions_to_disk(&data.sessions.lock().unwrap());

    let (tx, _) = broadcast::channel::<String>(256);
    data.events_tx.lock().unwrap().insert(session_id.clone(), tx);

    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "sessionId": session_id,
        "assistant": assistant_name,
        "model": current_model
    }))
}

pub async fn start_prompt(
    data: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<StartPromptRequest>,
) -> HttpResponse {
    let session_id = path.into_inner();

    // Get session info
    let (assistant_name, cwd, model, existing_agent_session_id) = {
        let sessions = data.sessions.lock().unwrap();
        match sessions.get(&session_id) {
            Some(s) => (s.assistant.clone(), s.cwd.clone(), s.model.clone(), s.agent_session_id.clone()),
            None => {
                return HttpResponse::NotFound().json(serde_json::json!({
                    "success": false,
                    "error": "Session not found"
                }));
            }
        }
    };

    // Store user message
    let user_message = Message {
        role: "user".to_string(),
        content: req.message.clone(),
        timestamp: Utc::now().timestamp_millis(),
        content_blocks: None,
    };

    if let Some(session) = data.sessions.lock().unwrap().get_mut(&session_id) {
        session.messages.push(user_message);
        session.updated_at = Utc::now();
    }

    crate::save_sessions_to_disk(&data.sessions.lock().unwrap());

    // Get the broadcast sender for this session
    let tx = data.events_tx.lock().unwrap().get(&session_id).cloned();

    // Read and clear history context (set by switch_assistant)
    let history_context = {
        let mut sessions = data.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            session.history_context.take()
        } else {
            None
        }
    };

    // If no explicit history_context and no agent session ID (restart scenario),
    // build history from previous messages for agents without native persistence
    let auto_history = if history_context.is_none() && existing_agent_session_id.is_none() {
        let sessions = data.sessions.lock().unwrap();
        if let Some(session) = sessions.get(&session_id) {
            // Only inject if there are previous messages (more than the one we just added)
            if session.messages.len() > 1 {
                let mut ctx = String::from("Here is the previous conversation history for context:\n\n");
                for msg in &session.messages {
                    if msg.role == "system" { continue; }
                    let role_label = match msg.role.as_str() {
                        "user" => "User",
                        "assistant" => "Assistant",
                        _ => &msg.role,
                    };
                    let content = if msg.content.len() > 2000 {
                        format!("{}...(truncated)", &msg.content[..2000])
                    } else {
                        msg.content.clone()
                    };
                    ctx.push_str(&format!("**{}:** {}\n\n", role_label, content));
                }
                ctx.push_str("---\nPlease continue the conversation naturally, picking up where you left off.");
                Some(ctx)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    // Build the effective message (prepend history context if present)
    let message = if let Some(ref ctx) = history_context {
        format!("{}\n\n---\n\nUser's latest message: {}", ctx, req.message)
    } else if let Some(ref ctx) = auto_history {
        format!("{}\n\n---\n\nUser's latest message: {}", ctx, req.message)
    } else {
        req.message.clone()
    };

    let session_id_clone = session_id.clone();
    let session_id_for_save = session_id.clone();
    let session_id_for_cleanup = session_id.clone();
    let data_clone = data.clone();
    let data_clone2 = data.clone();

    // Dispatch streaming through the trait
    tokio::spawn(async move {
        let assistant_name_clone = assistant_name.clone();
        let result = tokio::task::spawn_blocking(move || {
            let registry = data_clone.registry.lock().unwrap();
            match registry.get(&assistant_name_clone) {
                Some(assistant) => assistant.stream_session(
                    &session_id_clone,
                    &cwd,
                    &model,
                    &message,
                    tx.as_ref(),
                    existing_agent_session_id.as_deref(),
                ),
                None => crate::ai::streaming::StreamResult { agent_session_id: None },
            }
        }).await;

        match result {
            Ok(stream_result) => {
                // Save agent session ID for session continuity (--resume)
                if let Some(sid) = stream_result.agent_session_id {
                    if let Some(session) = data_clone2.sessions.lock().unwrap().get_mut(&session_id_for_save) {
                        session.agent_session_id = Some(sid);
                    }
                    crate::save_sessions_to_disk(&data_clone2.sessions.lock().unwrap());
                }
            }
            Err(e) => eprintln!("Streaming task error: {}", e),
        }

        data_clone2.events_tx.lock().unwrap().remove(&session_id_for_cleanup);
    });

    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "sessionId": session_id
    }))
}

pub async fn switch_assistant(
    data: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<SwitchAssistantRequest>,
) -> HttpResponse {
    let session_id = path.into_inner();
    let new_assistant_name = req.assistant.clone();
    let new_model = req.model.clone();

    let (old_assistant_name, cwd, existing_messages) = {
        let sessions = data.sessions.lock().unwrap();
        match sessions.get(&session_id) {
            Some(s) => (s.assistant.clone(), s.cwd.clone(), s.messages.clone()),
            None => {
                return HttpResponse::NotFound().json(serde_json::json!({
                    "success": false,
                    "error": "Session not found"
                }));
            }
        }
    };

    if old_assistant_name == new_assistant_name {
        return HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "message": "Already using this assistant",
            "assistant": new_assistant_name
        }));
    }

    {
        let registry = data.registry.lock().unwrap();
        if registry.get(&new_assistant_name).is_none() {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "success": false,
                "error": format!("Assistant '{}' not found", new_assistant_name)
            }));
        }
    }

    let history_context = if !existing_messages.is_empty() {
        let mut ctx = String::from("You are continuing a conversation that was started with a different AI assistant. Here is the conversation history for context:\n\n");
        for msg in &existing_messages {
            if msg.role == "system" { continue; }
            let role_label = match msg.role.as_str() {
                "user" => "User",
                "assistant" => "Assistant",
                _ => &msg.role,
            };
            let content = if msg.content.len() > 2000 {
                format!("{}...(truncated)", &msg.content[..2000])
            } else {
                msg.content.clone()
            };
            ctx.push_str(&format!("**{}:** {}\n\n", role_label, content));
        }
        ctx.push_str("---\nPlease continue the conversation naturally, picking up where the previous assistant left off.");
        Some(ctx)
    } else {
        None
    };

    {
        let mut registry = data.registry.lock().unwrap();
        if let Some(assistant) = registry.get_mut(&new_assistant_name) {
            if let Err(e) = assistant.create_session(cwd.clone(), new_model.clone()).await {
                return HttpResponse::InternalServerError().json(serde_json::json!({
                    "success": false,
                    "error": e
                }));
            }
        }
    };

    let current_model = {
        let registry = data.registry.lock().unwrap();
        let assistant = registry.get(&new_assistant_name).unwrap();
        new_model.clone().unwrap_or_else(|| assistant.default_model().to_string())
    };

    {
        let mut sessions = data.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            session.assistant = new_assistant_name.clone();
            session.model = current_model.clone();
            session.updated_at = Utc::now();
            session.history_context = history_context;
            session.agent_session_id = None;

            session.messages.push(Message {
                role: "system".to_string(),
                content: format!(
                    "🔄 Switched from {} to {}. Conversation history preserved.",
                    old_assistant_name, new_assistant_name
                ),
                timestamp: Utc::now().timestamp_millis(),
                content_blocks: None,
            });
        }
    }

    crate::save_sessions_to_disk(&data.sessions.lock().unwrap());

    {
        let mut registry = data.registry.lock().unwrap();
        if let Some(old_assistant) = registry.get_mut(&old_assistant_name) {
            old_assistant.delete_session(&session_id);
        }
    }

    let (tx, _) = broadcast::channel::<String>(256);
    data.events_tx.lock().unwrap().insert(session_id.clone(), tx);

    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "sessionId": session_id,
        "assistant": new_assistant_name,
        "model": current_model,
        "message": format!("Switched to {}", new_assistant_name)
    }))
}

pub async fn send_command(
    data: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<CommandRequest>,
) -> HttpResponse {
    let session_id = path.into_inner();

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
        "save_message" => {
            if let Some(content) = &req.message {
                let assistant_message = Message {
                    role: "assistant".to_string(),
                    content: content.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    content_blocks: req.content_blocks.clone(),
                };

                if let Some(session) = data.sessions.lock().unwrap().get_mut(&session_id) {
                    session.messages.push(assistant_message);
                    session.updated_at = Utc::now();
                }

                crate::save_sessions_to_disk(&data.sessions.lock().unwrap());

                HttpResponse::Ok().json(serde_json::json!({
                    "success": true,
                    "data": null
                }))
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

    let mut rx = {
        let channels = data.events_tx.lock().unwrap();
        match channels.get(&session_id) {
            Some(tx) => tx.subscribe(),
            None => {
                drop(channels);
                let (tx, _) = broadcast::channel::<String>(256);
                let rx = tx.subscribe();
                data.events_tx.lock().unwrap().insert(session_id.clone(), tx);
                rx
            }
        }
    };

    let stream = async_stream::stream! {
        yield Ok::<_, actix_web::Error>(actix_web::web::Bytes::from(format!(
            "data: {}\n\n",
            serde_json::json!({"type": "connected", "sessionId": session_id})
        )));

        loop {
            match rx.recv().await {
                Ok(msg) => {
                    yield Ok::<_, actix_web::Error>(actix_web::web::Bytes::from(format!("data: {}\n\n", msg)));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    };

    HttpResponse::Ok()
        .insert_header(("Content-Type", "text/event-stream"))
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("Connection", "keep-alive"))
        .streaming(stream)
}
