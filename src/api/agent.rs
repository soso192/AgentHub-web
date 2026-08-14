use actix_web::{web, HttpResponse, HttpRequest};
use tokio::sync::broadcast;
use crate::models::{NewSessionRequest, StartPromptRequest, SwitchAssistantRequest, CommandRequest, Message, ContentBlock};
use crate::AppState;
use chrono::Utc;

/// 异步保存会话到磁盘（在 async handler 中使用，不阻塞 tokio 工作线程）
fn save_async(data: &AppState) {
    crate::save_sessions_to_disk_async(data);
}

/// Save streaming event progress to session (called by the event saver task)
/// This updates both the in-memory cache and the session file.
fn save_event_progress(
    data: &web::Data<AppState>,
    session_id: &str,
    content_blocks: &[ContentBlock],
    final_result: &str,
    assistant_name: &str,
) {
    // Update in-memory streaming state cache first (for instant reads on page refresh)
    {
        let mut streaming_state = data.streaming_state.write().unwrap();
        streaming_state.insert(session_id.to_string(), crate::StreamingState {
            content_blocks: content_blocks.to_vec(),
            final_result: final_result.to_string(),
            assistant_name: assistant_name.to_string(),
            last_updated: Utc::now(),
        });
    }
    
    // Update session file
    let mut sessions = data.sessions.write().unwrap();
    if let Some(session) = sessions.get_mut(session_id) {
        let last_is_assistant = session.messages.last()
            .map(|m| m.role == "assistant")
            .unwrap_or(false);
        
        let blocks = if content_blocks.is_empty() { None } else { Some(content_blocks.to_vec()) };
        let content = if final_result.is_empty() {
            "(streaming...)".to_string()
        } else {
            final_result.to_string()
        };
        
        if last_is_assistant {
            if let Some(last_msg) = session.messages.last_mut() {
                last_msg.content = content;
                last_msg.content_blocks = blocks;
                last_msg.timestamp = Utc::now().timestamp_millis();
            }
        } else {
            session.messages.push(Message {
                role: "assistant".to_string(),
                content,
                timestamp: Utc::now().timestamp_millis(),
                content_blocks: blocks,
                assistant: Some(assistant_name.to_string()),
            });
        }
        session.updated_at = Utc::now();
    }
    drop(sessions);
    crate::save_sessions_to_disk(&data.sessions.read().unwrap());
}

pub async fn new_session(
    data: web::Data<AppState>,
    req: web::Json<NewSessionRequest>,
) -> HttpResponse {
    let assistant_name = req.assistant.clone().unwrap_or_else(|| "claude".to_string());
    let model = req.model.clone();

    // Get assistant handle, then release registry lock
    let handle = {
        let registry = data.registry.read().unwrap();
        match registry.get_handle(&assistant_name) {
            Some(h) => h,
            None => {
                return HttpResponse::BadRequest().json(serde_json::json!({
                    "success": false,
                    "error": format!("Assistant '{}' not found", assistant_name)
                }));
            }
        }
    };

    // Lock only this assistant (other assistants are unaffected)
    let mut assistant = handle.write().unwrap();

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

    let now = Utc::now();

    // 继续会话：resume_session_id 存在时，把对应 claude 会话的历史消息解析进会话窗口展示。
    // 仅用于展示，claude 的上下文仍由 --resume 自带；start_prompt 也会因 agent_session_id
    // 存在而跳过 auto_history，不会把历史重复发给 claude。
    let mut messages = Vec::new();
    if let Some(ref sid) = req.resume_session_id {
        messages = crate::claude_history::load_history(sid, &assistant_name);
        if messages.is_empty() {
            log::warn!("[new_session] resume session {} has no history messages (jsonl missing or empty)", sid);
        } else {
            log::info!("[new_session] loaded {} history messages from claude session {}", messages.len(), sid);
        }
    }
    if let Some(ref msg) = req.message {
        messages.push(Message {
            role: "user".to_string(),
            content: msg.clone(),
            timestamp: now.timestamp_millis(),
            content_blocks: None,
            assistant: None,
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
        agent_session_id: req.resume_session_id.clone(),
        history_already_sent: false,
    };

    data.sessions.write().unwrap().insert(session_id.clone(), session);
    save_async(&data);

    let (tx, _) = broadcast::channel::<String>(1024);
    data.events_tx.write().unwrap().insert(session_id.clone(), tx);

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
        let sessions = data.sessions.read().unwrap();
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

    log::info!("[start_prompt] session={}, assistant={}, model={}, agent_session_id={:?}",
        session_id, assistant_name, model, existing_agent_session_id);

    // Store user message
    let user_message = Message {
        role: "user".to_string(),
        content: req.message.clone(),
        timestamp: Utc::now().timestamp_millis(),
        content_blocks: None,
        assistant: None,
    };

    if let Some(session) = data.sessions.write().unwrap().get_mut(&session_id) {
        session.messages.push(user_message);
        session.updated_at = Utc::now();
    }

    save_async(&data);

    // Get or create the broadcast sender for this session
    let tx: Option<broadcast::Sender<String>> = {
        let mut channels = data.events_tx.write().unwrap();
        if let Some(tx) = channels.get(&session_id) {
            log::debug!("[start_prompt] using existing events_tx channel");
            Some(tx.clone())
        } else {
            log::debug!("[start_prompt] creating new events_tx channel");
            let (tx, _) = broadcast::channel::<String>(1024);
            channels.insert(session_id.clone(), tx.clone());
            Some(tx)
        }
    };

    log::debug!("[start_prompt] tx is_some={}", tx.is_some());

    // ── Spawn event saver: subscribe to broadcast channel and save events to session ──
    // This runs in the background and captures all streaming events (thinking, tool_call,
    // tool_result, chunk) so that if the user refreshes the page, progress is preserved.
    if let Some(ref tx_clone) = tx {
        let saver_rx = tx_clone.subscribe();
        let saver_data = data.clone();
        let saver_sid = session_id.clone();
        let saver_assistant = assistant_name.clone();
        log::debug!("[saver] spawning event saver task for session={}", session_id);
        tokio::spawn(async move {
            let mut rx = saver_rx;
            let mut content_blocks: Vec<ContentBlock> = Vec::new();
            let mut final_result = String::new();
            let mut last_save = std::time::Instant::now();
            let mut event_count = 0;
            
            loop {
                match rx.recv().await {
                    Ok(msg) => {
                        event_count += 1;
                        let event: serde_json::Value = match serde_json::from_str(&msg) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        log::trace!("[saver] received event #{} for session={}, type={}", event_count, saver_sid, event_type);
                        
                        let mut needs_save = false;
                        
                        match event_type {
                            "thinking" => {
                                if let Some(thinking) = event.get("thinking").and_then(|t| t.as_str()) {
                                    // Insert thinking block before any text blocks
                                    // This ensures thinking always appears at the top
                                    let insert_pos = content_blocks.iter().position(|b| matches!(b, ContentBlock::Text { .. }));
                                    if let Some(pos) = insert_pos {
                                        content_blocks.insert(pos, ContentBlock::Thinking { thinking: thinking.to_string() });
                                    } else {
                                        content_blocks.push(ContentBlock::Thinking { thinking: thinking.to_string() });
                                    }
                                    needs_save = true;
                                }
                            }
                            "tool_call" => {
                                let id = event.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let name = event.get("name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                                let input = event.get("input").cloned().unwrap_or(serde_json::Value::Null);
                                // Check if we already have a tool_use with this id (avoid duplicates from Pi Agent)
                                let existing = content_blocks.iter_mut().find(|b| {
                                    matches!(b, ContentBlock::ToolUse { id: ref existing_id, .. } if *existing_id == id && !id.is_empty())
                                });
                                if let Some(ContentBlock::ToolUse { name: ref mut existing_name, input: ref mut existing_input, .. }) = existing {
                                    // Update existing block only if new input is not empty
                                    *existing_name = name;
                                    if input != serde_json::Value::Null && input != serde_json::json!({}) {
                                        *existing_input = input;
                                        needs_save = true;
                                    }
                                } else if !id.is_empty() {
                                    content_blocks.push(ContentBlock::ToolUse { id, name, input });
                                    needs_save = true;
                                }
                            }
                            "tool_result" => {
                                let tool_use_id = event.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let content = event.get("output").map(|o| {
                                    if let Some(s) = o.as_str() { s.to_string() }
                                    else { o.to_string() }
                                }).unwrap_or_default();
                                if !tool_use_id.is_empty() {
                                    content_blocks.push(ContentBlock::ToolResult { tool_use_id, content });
                                    needs_save = true;
                                }
                            }
                            "chunk" => {
                                if let Some(new_text) = event.get("content").and_then(|c| c.as_str()) {
                                    final_result.push_str(new_text);
                                    // Update or add text block
                                    match content_blocks.last_mut() {
                                        Some(ContentBlock::Text { text: ref mut existing }) => {
                                            existing.push_str(new_text);
                                        }
                                        _ => {
                                            content_blocks.push(ContentBlock::Text { text: new_text.to_string() });
                                        }
                                    }
                                    // Save chunks less frequently (every 1 second)
                                    if last_save.elapsed().as_secs() >= 1 {
                                        needs_save = true;
                                    }
                                }
                            }
                            "result" => {
                                if let Some(text) = event.get("content").and_then(|c| c.as_str()) {
                                    final_result = text.to_string();
                                }
                                // Final save and exit
                                save_event_progress(&saver_data, &saver_sid, &content_blocks, &final_result, &saver_assistant);
                                break;
                            }
                            "error" => {
                                // Save what we have and exit
                                save_event_progress(&saver_data, &saver_sid, &content_blocks, &final_result, &saver_assistant);
                                break;
                            }
                            _ => {}
                        }
                        
                        // Save if needed (thinking/tool events save immediately, chunks every 1s)
                        if needs_save {
                            save_event_progress(&saver_data, &saver_sid, &content_blocks, &final_result, &saver_assistant);
                            last_save = std::time::Instant::now();
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("[saver] lagged: dropped {} events for session={}", n, saver_sid);
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    // Read and clear history context (set by switch_assistant)
    let (history_context, history_already_sent) = {
        let mut sessions = data.sessions.write().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            let ctx = session.history_context.take();
            let already_sent = session.history_already_sent;
            session.history_already_sent = false;
            (ctx, already_sent)
        } else {
            (None, false)
        }
    };

    log::debug!("[start_prompt] history_context present: {}, history_already_sent: {}, agent_session_id: {:?}",
        history_context.is_some(), history_already_sent, existing_agent_session_id);

    // If no explicit history_context and no agent session ID (restart scenario),
    // build history from previous messages for agents without native persistence.
    // Skip if history was already sent via stream during assistant switch.
    let auto_history = if history_context.is_none() && existing_agent_session_id.is_none() && !history_already_sent {
        let sessions = data.sessions.read().unwrap();
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
                    let content = msg.content.clone();
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
    let data_clone2 = data.clone();

    // Get assistant handle from registry, then release registry lock immediately.
    // The handle is an Arc<RwLock<>> so we can lock the assistant independently.
    let assistant_handle = {
        let registry = data.registry.read().unwrap();
        registry.get_handle(&assistant_name)
    };

    // Mark session as actively streaming
    data.streaming_sessions.write().unwrap().insert(session_id.clone());

    log::debug!("[start_prompt] spawning streaming task for session={}", session_id);
    tokio::spawn(async move {
        let handle = match assistant_handle {
            Some(h) => h,
            None => {
                log::error!("[start_prompt] assistant not found: {}", assistant_name);
                return;
            }
        };

        log::debug!("[start_prompt] calling spawn_blocking for stream_session");
        // Clone data for PID callback
        let data_for_pid = data_clone2.clone();
        let session_id_for_pid = session_id_clone.clone();
        // Clone data for result callback
        let data_for_result = data_clone2.clone();
        let session_id_for_result = session_id_clone.clone();
        
        let result = tokio::task::spawn_blocking(move || {
            // Lock ONLY this assistant — other assistants are free to operate
            let assistant = handle.read().unwrap();
            log::debug!("[start_prompt] calling stream_session");
            
            // Create PID callback to store PID immediately when process spawns
            let pid_callback = Box::new(move |pid: u32| {
                log::debug!("[start_prompt] PID callback: storing pid={} for session={}", pid, session_id_for_pid);
                data_for_pid.running_pids.write().unwrap().insert(session_id_for_pid.clone(), pid);
            });
            
            // Create result callback to clean up streaming_sessions immediately when result is sent
            // Note: Only clean up streaming_sessions, NOT events_tx channel.
            // The events_tx channel needs to stay alive until the SSE stream ends.
            let on_result_callback = Box::new(move || {
                log::debug!("[start_prompt] on_result_callback called for session={}", session_id_for_result);
                
                // Clean up streaming_sessions
                {
                    let mut streaming = data_for_result.streaming_sessions.write().unwrap();
                    let existed = streaming.remove(&session_id_for_result);
                    log::debug!("[start_prompt] on_result_callback: streaming_sessions.remove returned {:?}", existed);
                }
                
                // Clean up streaming_state
                {
                    let mut state = data_for_result.streaming_state.write().unwrap();
                    state.remove(&session_id_for_result);
                }
                
                log::debug!("[start_prompt] on_result_callback: cleanup complete for session={}", session_id_for_result);
            });
            
            assistant.stream_session(
                &session_id_clone,
                &cwd,
                &model,
                &message,
                tx.as_ref(),
                existing_agent_session_id.as_deref(),
                Some(pid_callback),
                Some(on_result_callback),
            )
        }).await;

        match result {
            Ok(stream_result) => {
                log::info!("[start_prompt] stream_session completed, agent_session_id={:?}, pid={:?}, result_sent={}",
                    stream_result.agent_session_id, stream_result.pid, stream_result.result_sent);

                // Remove streaming status IMMEDIATELY after stream_session returns.
                // If result was already sent, the frontend is already done, so clean up immediately.
                data_clone2.streaming_sessions.write().unwrap().remove(&session_id_for_save);
                data_clone2.streaming_state.write().unwrap().remove(&session_id_for_save);

                // Store PID for abort support
                if let Some(pid) = stream_result.pid {
                    data_clone2.running_pids.write().unwrap().insert(session_id_for_save.clone(), pid);
                }
                // Save agent session ID for session continuity (--resume)
                if let Some(sid) = stream_result.agent_session_id {
                    if let Some(session) = data_clone2.sessions.write().unwrap().get_mut(&session_id_for_save) {
                        session.agent_session_id = Some(sid);
                    }
                    crate::save_sessions_to_disk(&data_clone2.sessions.read().unwrap());
                }
            }
            Err(e) => {
                log::error!("[start_prompt] Streaming task error: {}", e);
                // Clean up streaming status even on error
                data_clone2.streaming_sessions.write().unwrap().remove(&session_id_for_save);
                data_clone2.streaming_state.write().unwrap().remove(&session_id_for_save);
            },
        }

        // Clean up PID
        log::debug!("[start_prompt] cleaning up session={}", session_id_for_cleanup);
        data_clone2.running_pids.write().unwrap().remove(&session_id_for_cleanup);

        // 不删除 events_tx channel！
        // 原因：如果用户快速连续发送消息，新的 start_prompt 可能已经复用了这个 channel。
        // 删除会导致新流的 SSE 收到 RecvError::Closed。
        // broadcast::Sender 是 Arc 包装的，克隆的 Sender 共享同一个底层 channel。
        // 保留 channel 在 map 中，下次 start_prompt 会复用它，SSE endpoint 也会复用。
        // channel 会在服务器重启时自然清理。
        log::debug!("[start_prompt] cleanup complete for session={} (events_tx kept alive)", session_id_for_cleanup);
    });

    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "sessionId": session_id
    }))
}

/// Handle assistant switch request.
/// POST /api/agent/{session_id}/switch
///
/// Flow:
/// 1. Read existing conversation messages from the current session
/// 2. Build a history_context string from all user/assistant messages
/// 3. Update the session metadata (assistant, model, clear agent_session_id)
/// 4. Create a broadcast channel for SSE streaming
/// 5. Build a context_message (history + prompt) and spawn a streaming task
///    to send it to the new assistant via stdin
/// 6. Return HTTP success immediately — the frontend connects to SSE
///    to receive the new assistant's streamed response
///
/// After the new assistant responds, the frontend displays a
/// "Switched from X to Y" system message.
pub async fn switch_assistant(
    data: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<SwitchAssistantRequest>,
) -> HttpResponse {
    let session_id = path.into_inner();
    let new_assistant_name = req.assistant.clone();
    let new_model = req.model.clone();

    // ── Step 1: Read current session data ──────────────────────────────
    let (old_assistant_name, cwd, existing_messages) = {
        let sessions = data.sessions.read().unwrap();
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

    // Diagnostic logging: print all existing messages for debugging
    log::info!("[switch] session={}, old={}, new={}, msg_count={}",
        session_id, old_assistant_name, new_assistant_name, existing_messages.len());
    for (i, msg) in existing_messages.iter().enumerate() {
        log::debug!("[switch]   msg[{}]: role={}, assistant={:?}, content_len={}",
            i, msg.role, msg.assistant, msg.content.len());
    }

    // ── Step 2: Validate the switch request ────────────────────────────
    // No-op if already using the requested assistant
    if old_assistant_name == new_assistant_name {
        return HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "message": "Already using this assistant",
            "assistant": new_assistant_name
        }));
    }

    // Check that the target assistant is registered
    {
        let registry = data.registry.read().unwrap();
        if !registry.has(&new_assistant_name) {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "success": false,
                "error": format!("Assistant '{}' not found", new_assistant_name)
            }));
        }
    }

    // ── Step 3: Build history_context from existing messages ───────────
    // Converts the message array into a plain-text conversation summary
    // that the new assistant can understand.
    let history_context = if !existing_messages.is_empty() {
        let mut ctx = String::from("You are continuing a conversation that was started with a different AI assistant. Here is the conversation history for context:\n\n");
        for msg in &existing_messages {
            if msg.role == "system" { continue; }  // skip system notifications
            let role_label = match msg.role.as_str() {
                "user" => "User",
                "assistant" => "Assistant",
                _ => &msg.role,
            };
            let content = msg.content.clone();
            ctx.push_str(&format!("**{}:** {}\n\n", role_label, content));
        }
        ctx.push_str("---\nPlease continue the conversation naturally, picking up where the previous assistant left off.");
        Some(ctx)
    } else {
        None
    };

    // ── Step 4: Create internal session for the new assistant ──────────
    // Each assistant maintains its own internal session state (e.g. Claude's
    // --resume session ID). We create a fresh one for the new assistant.
    let new_handle = {
        let registry = data.registry.read().unwrap();
        registry.get_handle(&new_assistant_name)
    };
    if let Some(ref handle) = new_handle {
        let mut assistant = handle.write().unwrap();
        if let Err(e) = assistant.create_session(cwd.clone(), new_model.clone()).await {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "success": false,
                "error": e
            }));
        }
    }

    // Get the new assistant's default model
    let current_model = {
        if let Some(ref handle) = new_handle {
            let assistant = handle.read().unwrap();
            assistant.default_model().to_string()
        } else {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "success": false,
                "error": format!("Assistant '{}' not available", new_assistant_name)
            }));
        }
    };

    // ── Step 5: Update the session metadata ────────────────────────────
    {
        let mut sessions = data.sessions.write().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            session.assistant = new_assistant_name.clone();
            session.model = current_model.clone();
            session.updated_at = Utc::now();
            // Don't store history_context here — the context is sent to the new
            // assistant via stream_session below. Setting it would cause
            // start_prompt to prepend it again on the user's first question.
            session.history_context = None;
            session.agent_session_id = None;  // clear old assistant's native session ID
            session.history_already_sent = history_context.is_some();  // mark that history was already sent via stream

            // Add a system message documenting the switch
            session.messages.push(Message {
                role: "system".to_string(),
                content: format!(
                    "🔄 Switched from {} to {}. Conversation history preserved.",
                    old_assistant_name, new_assistant_name
                ),
                timestamp: Utc::now().timestamp_millis(),
                content_blocks: None,
                assistant: None,
            });
        }
    }

    save_async(&data);

    // ── Step 6: Clean up the old assistant's internal session ──────────
    {
        let registry = data.registry.read().unwrap();
        if let Some(handle) = registry.get_handle(&old_assistant_name) {
            let mut assistant = handle.write().unwrap();
            assistant.delete_session(&session_id);
        }
    }

    // ── Step 7: Create SSE broadcast channel ───────────────────────────
    let (tx, _) = broadcast::channel::<String>(1024);
    data.events_tx.write().unwrap().insert(session_id.clone(), tx.clone());

    // ── Step 7.5: Spawn event saver for switch ────────────────────────
    {
        let saver_rx = tx.subscribe();
        let saver_data = data.clone();
        let saver_sid = session_id.clone();
        let saver_assistant = new_assistant_name.clone();
        tokio::spawn(async move {
            let mut rx = saver_rx;
            let mut content_blocks: Vec<ContentBlock> = Vec::new();
            let mut final_result = String::new();
            let mut last_save = std::time::Instant::now();
            
            loop {
                match rx.recv().await {
                    Ok(msg) => {
                        let event: serde_json::Value = match serde_json::from_str(&msg) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        
                        match event_type {
                            "thinking" => {
                                if let Some(thinking) = event.get("thinking").and_then(|t| t.as_str()) {
                                    content_blocks.push(ContentBlock::Thinking { thinking: thinking.to_string() });
                                }
                            }
                            "tool_call" => {
                                let id = event.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let name = event.get("name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                                let input = event.get("input").cloned().unwrap_or(serde_json::Value::Null);
                                // Check if we already have a tool_use with this id (avoid duplicates from Pi Agent)
                                let existing = content_blocks.iter_mut().find(|b| {
                                    matches!(b, ContentBlock::ToolUse { id: ref existing_id, .. } if *existing_id == id && !id.is_empty())
                                });
                                if let Some(ContentBlock::ToolUse { name: ref mut existing_name, input: ref mut existing_input, .. }) = existing {
                                    *existing_name = name;
                                    if input != serde_json::Value::Null && input != serde_json::json!({}) {
                                        *existing_input = input;
                                    }
                                } else if !id.is_empty() {
                                    content_blocks.push(ContentBlock::ToolUse { id, name, input });
                                }
                            }
                            "tool_result" => {
                                let tool_use_id = event.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let content = event.get("output").map(|o| {
                                    if let Some(s) = o.as_str() { s.to_string() }
                                    else { o.to_string() }
                                }).unwrap_or_default();
                                if !tool_use_id.is_empty() {
                                    content_blocks.push(ContentBlock::ToolResult { tool_use_id, content });
                                }
                            }
                            "chunk" => {
                                if let Some(new_text) = event.get("content").and_then(|c| c.as_str()) {
                                    final_result.push_str(new_text);
                                    match content_blocks.last_mut() {
                                        Some(ContentBlock::Text { text: ref mut existing }) => {
                                            existing.push_str(new_text);
                                        }
                                        _ => {
                                            content_blocks.push(ContentBlock::Text { text: new_text.to_string() });
                                        }
                                    }
                                }
                            }
                            "result" => {
                                if let Some(text) = event.get("content").and_then(|c| c.as_str()) {
                                    final_result = text.to_string();
                                }
                                save_event_progress(&saver_data, &saver_sid, &content_blocks, &final_result, &saver_assistant);
                                break;
                            }
                            "error" => {
                                save_event_progress(&saver_data, &saver_sid, &content_blocks, &final_result, &saver_assistant);
                                break;
                            }
                            _ => {}
                        }
                        
                        if last_save.elapsed().as_secs() >= 2 {
                            save_event_progress(&saver_data, &saver_sid, &content_blocks, &final_result, &saver_assistant);
                            last_save = std::time::Instant::now();
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("[saver:switch] lagged: dropped {} events for session={}", n, saver_sid);
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    // ── Step 8: Build context_message and spawn streaming task ─────────
    // The context_message includes the full conversation history plus a
    // prompt asking the new assistant to acknowledge the context.
    // It is sent to the new assistant via stdin (not CLI argument) to
    // avoid Windows command-line escaping issues with long formatted text.
    let context_message = if let Some(ref ctx) = history_context {
        format!("{}\n\n---\n\nPlease review the conversation history above, acknowledge that you have the context, and await my next instruction.", ctx)
    } else {
        "No previous conversation history. Please introduce yourself and await instructions.".to_string()
    };

    log::debug!("[switch] context_message (len={}): {:?}",
        context_message.len(),
        context_message.chars().take(500).collect::<String>());

    // Clone values needed by the spawned async task
    let session_id_clone = session_id.clone();
    let session_id_for_save = session_id.clone();
    let session_id_for_cleanup = session_id.clone();
    let cwd_clone = cwd.clone();
    let model_clone = current_model.clone();
    let data_clone = data.clone();

    // Get the new assistant's handle for the streaming task
    let new_handle_for_stream = {
        let registry = data.registry.read().unwrap();
        registry.get_handle(&new_assistant_name)
    };

    // Mark this session as actively streaming
    data.streaming_sessions.write().unwrap().insert(session_id.clone());

    // Spawn the streaming task — this runs in the background while
    // the HTTP response is returned to the frontend immediately.
    tokio::spawn(async move {
        let handle = match new_handle_for_stream {
            Some(h) => h,
            None => return,
        };

        // stream_session runs in a blocking thread (it reads CLI stdout line by line)
        // Clone data for PID callback
        let data_for_pid = data_clone.clone();
        let session_id_for_pid = session_id_clone.clone();
        // Clone data for result callback
        let data_for_result = data_clone.clone();
        let session_id_for_result = session_id_clone.clone();
        let result = tokio::task::spawn_blocking(move || {
            let assistant = handle.read().unwrap();
            // Create PID callback to store PID immediately when process spawns
            let pid_callback = Box::new(move |pid: u32| {
                log::debug!("[switch] PID callback: storing pid={} for session={}", pid, session_id_for_pid);
                data_for_pid.running_pids.write().unwrap().insert(session_id_for_pid.clone(), pid);
            });
            // Create result callback to clean up streaming_sessions immediately when result is sent
            // Note: Only clean up streaming_sessions, NOT events_tx channel.
            // The events_tx channel needs to stay alive until the SSE stream ends.
            let on_result_callback = Box::new(move || {
                log::debug!("[switch] on_result_callback: cleaning up streaming_sessions for session={}", session_id_for_result);
                data_for_result.streaming_sessions.write().unwrap().remove(&session_id_for_result);
                data_for_result.streaming_state.write().unwrap().remove(&session_id_for_result);
            });
            assistant.stream_session(
                &session_id_clone,
                &cwd_clone,
                &model_clone,
                &context_message,
                Some(&tx),      // broadcast channel for SSE events
                None,            // no existing agent session ID (fresh start)
                Some(pid_callback),
                Some(on_result_callback),
            )
        }).await;

        // ── Cleanup after streaming completes ──────────────────────────
        match result {
            Ok(stream_result) => {
                // Clear streaming status immediately
                data_clone.streaming_sessions.write().unwrap().remove(&session_id_for_save);
                // Clear streaming state cache
                data_clone.streaming_state.write().unwrap().remove(&session_id_for_save);
                // Save the new assistant's native session ID for future --resume
                if let Some(sid) = stream_result.agent_session_id {
                    if let Some(session) = data_clone.sessions.write().unwrap().get_mut(&session_id_for_save) {
                        session.agent_session_id = Some(sid);
                    }
                    crate::save_sessions_to_disk(&data_clone.sessions.read().unwrap());
                }
            }
            Err(e) => {
                log::error!("[switch] Streaming task error: {}", e);
                // Clean up streaming status even on error
                data_clone.streaming_sessions.write().unwrap().remove(&session_id_for_save);
                data_clone.streaming_state.write().unwrap().remove(&session_id_for_save);
            },
        }

        // Final cleanup: remove streaming status
        // 不删除 events_tx channel（同 start_prompt 的理由）
        data_clone.streaming_sessions.write().unwrap().remove(&session_id_for_cleanup);
        data_clone.streaming_state.write().unwrap().remove(&session_id_for_cleanup);
        log::debug!("[switch] cleanup complete for session={} (events_tx kept alive)", session_id_for_cleanup);
    });

    // Return success immediately — the frontend will connect to SSE
    // to receive the new assistant's streamed response.
    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "sessionId": session_id,
        "assistant": new_assistant_name,
        "model": current_model,
        "message": format!("Switched to {}", new_assistant_name)
    }))
}

pub async fn abort_session(
    data: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let session_id = path.into_inner();

    // Remove the last user message that was aborted (the one without an assistant response)
    {
        let mut sessions = data.sessions.write().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            // Find and remove the last user message that doesn't have a corresponding assistant response
            if let Some(last_msg) = session.messages.last() {
                if last_msg.role == "user" {
                    log::info!("[abort] Removing aborted user message: {:?}", &last_msg.content[..last_msg.content.len().min(50)]);
                    session.messages.pop();
                }
            }
        }
    }

    // Get and remove the PID
    let pid = data.running_pids.write().unwrap().remove(&session_id);

    if let Some(pid) = pid {
        // Kill the process tree
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            let _ = Command::new("taskkill")
                .args(&["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }

        // Close the event channel so SSE connection closes and frontend resets
        data.events_tx.write().unwrap().remove(&session_id);
        data.streaming_sessions.write().unwrap().remove(&session_id);
        data.streaming_state.write().unwrap().remove(&session_id);

        HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "message": "Process killed"
        }))
    } else {
        // Also clean up event channel even if no PID
        data.events_tx.write().unwrap().remove(&session_id);
        data.streaming_sessions.write().unwrap().remove(&session_id);
        data.streaming_state.write().unwrap().remove(&session_id);

        HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "message": "No running process found"
        }))
    }
}

pub async fn send_command(
    data: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<CommandRequest>,
) -> HttpResponse {
    let session_id = path.into_inner();

    let session_info = data.sessions.read().unwrap()
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
                let mut sessions = data.sessions.write().unwrap();
                if let Some(session) = sessions.get_mut(&session_id) {
                    // Check if the last message is already an assistant message (from save_event_progress)
                    let last_is_assistant = session.messages.last()
                        .map(|m| m.role == "assistant")
                        .unwrap_or(false);
                    
                    if last_is_assistant {
                        // Update existing assistant message instead of adding a new one
                        if let Some(last_msg) = session.messages.last_mut() {
                            last_msg.content = content.clone();
                            if let Some(blocks) = &req.content_blocks {
                                last_msg.content_blocks = Some(blocks.clone());
                            }
                            last_msg.timestamp = Utc::now().timestamp_millis();
                        }
                    } else {
                        // Add new assistant message
                        session.messages.push(Message {
                            role: "assistant".to_string(),
                            content: content.clone(),
                            timestamp: Utc::now().timestamp_millis(),
                            content_blocks: req.content_blocks.clone(),
                            assistant: Some(assistant_name.clone()),
                        });
                    }
                    session.updated_at = Utc::now();
                }
                drop(sessions);

                save_async(&data);

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
                let handle = {
                    let registry = data.registry.read().unwrap();
                    registry.get_handle(&assistant_name)
                };
                let handle = match handle {
                    Some(h) => h,
                    None => {
                        return HttpResponse::InternalServerError().json(serde_json::json!({
                            "success": false,
                            "error": format!("Assistant '{}' not available", assistant_name)
                        }));
                    }
                };
                let mut assistant = handle.write().unwrap();

                if let Err(e) = assistant.set_model(&session_id, model) {
                    return HttpResponse::InternalServerError().json(serde_json::json!({
                        "success": false,
                        "error": e
                    }));
                }

                if let Some(session) = data.sessions.write().unwrap().get_mut(&session_id) {
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
            let sessions = data.sessions.read().unwrap();
            if let Some(session) = sessions.get(&session_id) {
                HttpResponse::Ok().json(serde_json::json!({
                    "success": true,
                    "data": {
                        "sessionId": session.id,
                        "assistant": session.assistant,
                        "model": session.model,
                        "messageCount": session.messages.len(),
                        "cwd": session.cwd,
                        "isStreaming": data.streaming_sessions.read().unwrap().contains(&session_id)
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
    let sessions = data.sessions.read().unwrap();

    if let Some(session) = sessions.get(&session_id) {
        let is_streaming = data.streaming_sessions.read().unwrap().contains(&session_id);
        HttpResponse::Ok().json(serde_json::json!({
            "running": true,
            "state": {
                "sessionId": session.id,
                "assistant": session.assistant,
                "model": session.model,
                "messageCount": session.messages.len(),
                "cwd": session.cwd,
                "isStreaming": is_streaming
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
    log::debug!("[sse] events endpoint called for session={}", session_id);

    let exists = data.sessions.read().unwrap().contains_key(&session_id);
    if !exists {
        log::warn!("[sse] session not found: {}", session_id);
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "Session not found"
        }));
    }

    // Check if session is currently streaming
    let is_streaming = data.streaming_sessions.read().unwrap().contains(&session_id);
    log::debug!("[sse] session={} is_streaming={}", session_id, is_streaming);

    let mut rx = {
        let channels = data.events_tx.read().unwrap();
        match channels.get(&session_id) {
            Some(tx) => {
                log::debug!("[sse] found existing channel for session={}, receivers={}", session_id, tx.receiver_count());
                tx.subscribe()
            }
            None => {
                log::debug!("[sse] no channel found for session={}, creating new one", session_id);
                drop(channels);
                let (tx, _) = broadcast::channel::<String>(1024);
                let rx = tx.subscribe();
                data.events_tx.write().unwrap().insert(session_id.clone(), tx);
                rx
            }
        }
    };

    let session_id_clone = session_id.clone();
    let session_id_for_heartbeat = session_id.clone();
    let stream = async_stream::stream! {
        log::debug!("[sse] stream started for session={}", session_id_clone);
        yield Ok::<_, actix_web::Error>(actix_web::web::Bytes::from(format!(
            "data: {}\n\n",
            serde_json::json!({"type": "connected", "sessionId": session_id_clone})
        )));

        let mut heartbeat_interval = tokio::time::interval(std::time::Duration::from_secs(15));
        heartbeat_interval.tick().await; // Skip first immediate tick
        let mut event_count = 0;

        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Ok(msg) => {
                            event_count += 1;
                            let event_type = serde_json::from_str::<serde_json::Value>(&msg)
                                .ok()
                                .and_then(|v| v.get("type").and_then(|t| t.as_str().map(String::from)))
                                .unwrap_or_else(|| "unknown".to_string());
                            log::trace!("[sse] sending event #{} for session={}, type={}", event_count, session_id_clone, event_type);
                            yield Ok::<_, actix_web::Error>(actix_web::web::Bytes::from(format!("data: {}\n\n", msg)));
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            log::warn!("[sse] lagged: dropped {} events for session={}", n, session_id_clone);
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            log::info!("[sse] channel closed for session={}", session_id_clone);
                            break;
                        }
                    }
                }
                _ = heartbeat_interval.tick() => {
                    // Send heartbeat to keep connection alive and detect disconnects
                    yield Ok::<_, actix_web::Error>(actix_web::web::Bytes::from(format!(
                        "data: {}\n\n",
                        serde_json::json!({"type": "heartbeat", "sessionId": session_id_for_heartbeat})
                    )));
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
