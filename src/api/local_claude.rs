use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::{AppState, LocalExecution, LocalExecutionFingerprint};

#[derive(Debug, Deserialize)]
pub struct LocalClaudeRequest {
    pub execution_id: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
struct LocalClaudeResponse {
    execution_id: String,
    text: Option<String>,
    error: Option<String>,
    session_id: Option<String>,
}

fn resolve_cwd(cwd: Option<&str>) -> Result<String, &'static str> {
    let cwd = cwd.ok_or("working directory is required")?;
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return Err("working directory must be an absolute path");
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "working directory does not exist")?;
    if !canonical.is_dir() {
        return Err("working directory is not a directory");
    }
    canonical
        .into_os_string()
        .into_string()
        .map_err(|_| "working directory is not valid UTF-8")
}

pub async fn execute(data: web::Data<AppState>, body: web::Json<LocalClaudeRequest>) -> HttpResponse {
    if body.execution_id.trim().is_empty()
        || body.system_prompt.len() > 200_000
        || body.user_prompt.len() > 200_000
    {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "invalid request"}));
    }

    let cwd = match resolve_cwd(body.cwd.as_deref()) {
        Ok(cwd) => cwd,
        Err(error) => return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": error})),
    };
    let fingerprint = LocalExecutionFingerprint {
        system_prompt: body.system_prompt.clone(),
        user_prompt: body.user_prompt.clone(),
        cwd: cwd.clone(),
        model: body.model.clone(),
    };

    let (mut result_rx, start_execution) = {
        let mut executions = data.local_executions.lock().await;
        if let Some(execution) = executions.get(&body.execution_id) {
            if execution.fingerprint != fingerprint {
                return HttpResponse::Conflict().json(serde_json::json!({"success": false, "error": "execution_id was already used for a different request"}));
            }
            (execution.result_tx.subscribe(), false)
        } else {
            let (result_tx, result_rx) = tokio::sync::watch::channel(None);
            executions.insert(
                body.execution_id.clone(),
                LocalExecution { fingerprint, result_tx },
            );
            (result_rx, true)
        }
    };

    let result = if start_execution {
        let handle = {
            let registry = data.registry.read().unwrap();
            registry.get_handle("claude")
        };
        let result = match handle {
            Some(handle) => {
                let assistant = handle.read().unwrap();
                assistant
                    .execute_once_with_session(&body.system_prompt, &body.user_prompt, &cwd, body.model.as_deref())
                    .await
            }
            None => Err("ClaudeCode is unavailable".to_string()),
        };
        let execution = data.local_executions.lock().await;
        if let Some(execution) = execution.get(&body.execution_id) {
            let _ = execution.result_tx.send(Some(result.clone()));
        }
        result
    } else {
        loop {
            if let Some(result) = result_rx.borrow().clone() {
                break result;
            }
            if result_rx.changed().await.is_err() {
                break Err("local execution result was unavailable".to_string());
            }
        }
    };

    match result {
        Ok((text, session_id)) => HttpResponse::Ok().json(LocalClaudeResponse {
            execution_id: body.execution_id.clone(),
            text: Some(text),
            error: None,
            session_id,
        }),
        Err(error) => HttpResponse::Ok().json(LocalClaudeResponse {
            execution_id: body.execution_id.clone(),
            text: None,
            error: Some(error),
            session_id: None,
        }),
    }
}

pub async fn cancel(_data: web::Data<AppState>, _path: web::Path<String>) -> HttpResponse {
    HttpResponse::NotImplemented().json(serde_json::json!({"success": false, "error": "cancellation is not implemented for this execution"}))
}
