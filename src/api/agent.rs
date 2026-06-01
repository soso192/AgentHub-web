use actix_web::{web, HttpResponse, HttpRequest};
use tokio::sync::broadcast;
use crate::models::{NewSessionRequest, StartPromptRequest, SwitchAssistantRequest, CommandRequest, Message};
use crate::AppState;
use chrono::Utc;
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

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
    };

    data.sessions.lock().unwrap().insert(session_id.clone(), session);

    // Create broadcast event channel for this session
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
    let (assistant_name, cwd, model) = {
        let sessions = data.sessions.lock().unwrap();
        match sessions.get(&session_id) {
            Some(s) => (s.assistant.clone(), s.cwd.clone(), s.model.clone()),
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

    // Get the broadcast sender for this session
    let tx = data.events_tx.lock().unwrap().get(&session_id).cloned();

    // Read and clear history context (used for first message after assistant switch)
    let history_context = {
        let mut sessions = data.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            session.history_context.take()
        } else {
            None
        }
    };

    // Build the effective message (prepend history context if present)
    let message = if let Some(ref ctx) = history_context {
        format!("{}\n\n---\n\nUser's latest message: {}", ctx, req.message)
    } else {
        req.message.clone()
    };
    let session_id_for_stream = session_id.clone();
    let session_id_for_cleanup1 = session_id.clone();
    let session_id_for_cleanup2 = session_id.clone();
    let data_clone = data.clone();

    // Dispatch to the correct assistant's streaming function
    match assistant_name.as_str() {
        "pi" => {
            // Pi Agent streaming via npx
            tokio::spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    stream_pi_session(&session_id_for_stream, &cwd, &model, &message, tx.as_ref())
                }).await;

                match result {
                    Ok(()) => {}
                    Err(e) => eprintln!("Pi streaming task error: {}", e),
                }
                data_clone.events_tx.lock().unwrap().remove(&session_id_for_cleanup1);
            });
        }
        _ => {
            // Default: Claude Code streaming
            let git_bash = std::env::var("CLAUDE_CODE_GIT_BASH_PATH").unwrap_or_else(|_| {
                let paths = vec![
                    r"D:\Downloads\Software\Git\bin\bash.exe",
                    r"C:\Program Files\Git\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\bin\bash.exe",
                ];
                for path in paths {
                    if std::path::Path::new(path).exists() {
                        return path.to_string();
                    }
                }
                "bash".to_string()
            });

            tokio::spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    stream_claude_session(&session_id_for_stream, &cwd, &model, &git_bash, &message, tx.as_ref())
                }).await;

                match result {
                    Ok(()) => {}
                    Err(e) => eprintln!("Claude streaming task error: {}", e),
                }
                data_clone.events_tx.lock().unwrap().remove(&session_id_for_cleanup2);
            });
        }
    }

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

    // Get current session info
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

    // Don't switch if already on the same assistant
    if old_assistant_name == new_assistant_name {
        return HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "message": "Already using this assistant",
            "assistant": new_assistant_name
        }));
    }

    // Check if new assistant exists
    {
        let registry = data.registry.lock().unwrap();
        if registry.get(&new_assistant_name).is_none() {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "success": false,
                "error": format!("Assistant '{}' not found", new_assistant_name)
            }));
        }
    }

    // Build history context string for injection into first message
    let history_context = if !existing_messages.is_empty() {
        let mut ctx = String::from("You are continuing a conversation that was started with a different AI assistant. Here is the conversation history for context:\n\n");
        for msg in &existing_messages {
            if msg.role == "system" { continue; } // Skip system messages
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

    // Create a new internal session with the new assistant
    // Note: create_session generates its own UUID, but we use the cc-web session ID
    // for routing in start_prompt. The internal session is mainly for set_model etc.
    {
        let mut registry = data.registry.lock().unwrap();
        let assistant = match registry.get_mut(&new_assistant_name) {
            Some(a) => a,
            None => {
                return HttpResponse::InternalServerError().json(serde_json::json!({
                    "success": false,
                    "error": format!("Assistant '{}' not available", new_assistant_name)
                }));
            }
        };

        if let Err(e) = assistant.create_session(cwd.clone(), new_model.clone()).await {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "success": false,
                "error": e
            }));
        }
    };

    // Get model from new assistant
    let current_model = {
        let registry = data.registry.lock().unwrap();
        let assistant = registry.get(&new_assistant_name).unwrap();
        new_model.clone().unwrap_or_else(|| assistant.default_model().to_string())
    };

    // Update the existing session to point to new assistant
    {
        let mut sessions = data.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            session.assistant = new_assistant_name.clone();
            session.model = current_model.clone();
            session.updated_at = Utc::now();
            session.history_context = history_context;

            // Add a system message about the switch
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

    // Clean up old assistant's internal session and register new one
    {
        let mut registry = data.registry.lock().unwrap();

        // Delete old assistant's internal session
        if let Some(old_assistant) = registry.get_mut(&old_assistant_name) {
            old_assistant.delete_session(&session_id);
        }
    }

    // Create a new broadcast channel for the switched session
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
fn stream_claude_session(
    session_id: &str,
    cwd: &str,
    model: &str,
    git_bash: &str,
    message: &str,
    tx: Option<&broadcast::Sender<String>>,
) {
    let args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
        "--model".to_string(),
        model.to_string(),
    ];

    let mut cmd = Command::new("claude");
    cmd.args(&args)
        .current_dir(cwd)
        .env("CLAUDE_CODE_GIT_BASH_PATH", git_bash)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            send_event(tx, serde_json::json!({
                "type": "error",
                "message": format!("Failed to start Claude: {}", e)
            }));
            return;
        }
    };

    // Write message to stdin
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(message.as_bytes());
    }

    // Read stdout line by line
    let stdout = child.stdout.take().expect("stdout should be piped");
    let reader = std::io::BufReader::new(stdout);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        let event: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let subtype = event.get("subtype").and_then(|s| s.as_str());

        match event_type {
            "system" if subtype == Some("init") => {
                // Forward init event
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
                                    let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
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
    }

    let _ = child.wait();
}

/// Stream Pi Agent CLI output, parsing stream-json events and broadcasting via channel
fn stream_pi_session(
    session_id: &str,
    cwd: &str,
    model: &str,
    message: &str,
    tx: Option<&broadcast::Sender<String>>,
) {
    let args = vec![
        "@earendil-works/pi-coding-agent".to_string(),
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
        "--model".to_string(),
        model.to_string(),
    ];

    let mut cmd = Command::new("npx");
    cmd.args(&args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            send_event(tx, serde_json::json!({
                "type": "error",
                "message": format!("Failed to start Pi Agent: {}", e)
            }));
            return;
        }
    };

    // Write message to stdin
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(message.as_bytes());
    }

    // Read stdout line by line
    let stdout = child.stdout.take().expect("stdout should be piped");
    let reader = std::io::BufReader::new(stdout);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        let event: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let subtype = event.get("subtype").and_then(|s| s.as_str());

        match event_type {
            "system" if subtype == Some("init") => {
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
                                    let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
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
    }

    let _ = child.wait();
}

fn send_event(tx: Option<&broadcast::Sender<String>>, event: serde_json::Value) {
    if let Some(tx) = tx {
        let _ = tx.send(event.to_string());
    }
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

    // Subscribe to the broadcast channel for this session
    let mut rx = {
        let channels = data.events_tx.lock().unwrap();
        match channels.get(&session_id) {
            Some(tx) => tx.subscribe(),
            None => {
                // Create a channel if it doesn't exist yet
                drop(channels);
                let (tx, _) = broadcast::channel::<String>(256);
                let rx = tx.subscribe();
                data.events_tx.lock().unwrap().insert(session_id.clone(), tx);
                rx
            }
        }
    };

    let stream = async_stream::stream! {
        // Send connected event
        yield Ok::<_, actix_web::Error>(actix_web::web::Bytes::from(format!(
            "data: {}\n\n",
            serde_json::json!({"type": "connected", "sessionId": session_id})
        )));

        // Forward all events from broadcast channel
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
