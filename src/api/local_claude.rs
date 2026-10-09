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
    // 智能分析产物：工作目录下「结论.md / 摘要.md」的内容（前端随 local-result 一起上报入库）
    conclusion: Option<String>,
    summary: Option<String>,
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

/// 读工作目录下的产物文件（提示词要求 claude 写出）：读不到/为空返回 None，不影响步骤成败。
fn read_output_file(dir: &Path, name: &str) -> Option<String> {
    let raw = std::fs::read(dir.join(name)).ok()?;
    let text = String::from_utf8(raw).unwrap_or_else(|invalid| String::from_utf8_lossy(invalid.as_bytes()).into_owned());
    let text = text.trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

fn sanitize_filename(value: &str) -> String {
    value.chars().map(|c| match c {
        'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => c,
        _ => '_',
    }).collect()
}

/// 把 claude 写出的 结论.md / 摘要.md 复制到 <cc-web所在目录>\temp\（平铺）。
/// 文件名 = <execution_id>_结论.md / _摘要.md（execution_id = "<runId>-<stepOrder>"，稳定名、覆盖即幂等）。
fn archive_output_md(exe_dir: &Path, execution_id: &str, cwd: &str) {
    let temp_dir = exe_dir.join("temp");
    if std::fs::create_dir_all(&temp_dir).is_err() {
        log::warn!("[local-claude] 无法创建 temp 目录：{}", temp_dir.display());
        return;
    }
    let safe_id = sanitize_filename(execution_id);
    for name in ["结论.md", "摘要.md"] {
        let src = Path::new(cwd).join(name);
        if src.is_file() {
            let dst = temp_dir.join(format!("{}_{}", safe_id, name));
            if let Err(error) = std::fs::copy(&src, &dst) {
                log::warn!("[local-claude] 复制 {} 到 temp 失败：{}", name, error);
            }
        }
    }
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
        Ok((text, session_id)) => {
            // 提示词要求 claude 在工作目录下写 结论.md / 摘要.md：
            // ① 复制到 <cc-web目录>\temp\ 留档（用户端）；② 内容随响应返回，由前端上报入库。
            let cwd_path = Path::new(&cwd);
            let conclusion = read_output_file(cwd_path, "结论.md");
            let summary = read_output_file(cwd_path, "摘要.md");
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    archive_output_md(dir, &body.execution_id, &cwd);
                }
            }
            HttpResponse::Ok().json(LocalClaudeResponse {
                execution_id: body.execution_id.clone(),
                text: Some(text),
                error: None,
                session_id,
                conclusion,
                summary,
            })
        }
        Err(error) => HttpResponse::Ok().json(LocalClaudeResponse {
            execution_id: body.execution_id.clone(),
            text: None,
            error: Some(error),
            session_id: None,
            conclusion: None,
            summary: None,
        }),
    }
}

pub async fn cancel(_data: web::Data<AppState>, _path: web::Path<String>) -> HttpResponse {
    HttpResponse::NotImplemented().json(serde_json::json!({"success": false, "error": "cancellation is not implemented for this execution"}))
}
