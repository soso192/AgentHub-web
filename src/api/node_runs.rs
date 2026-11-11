//! 智能开发节点的**本机运行清单**（`~/.cc-web/node_runs.json`）。
//!
//! 设计要点（与 patch_search 侧的 `problem_run` 表配套，见方案文档第二十章）：
//!
//! - **本机清单才是运行的事实来源**：执行所需的一切（claude 会话文件、cwd、暂存目录、
//!   补丁输出目录、JDK）都是这台机器上的东西，换机后记录即便还在也点不动。
//!   服务器上的 `problem_run` 只是这份清单的只写摘要账本。
//! - **cc-web 不解释字段**：run 对象整体是 `serde_json::Value`，字段含义全部由前端定义
//!   （problem_desc / phase / stage_dir / session_id / reported …）。这样以后前端加字段
//!   不需要改后端，也不需要迁移。只有两点例外：必须是一个 JSON 对象；`id` 以路径为准。
//! - 每次写入整体落盘，与 `sessions.json` 同一套机制（`main.rs` 的 load/save）。

use actix_multipart::Multipart;
use actix_web::{web, HttpResponse};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::Value;
use std::io::Write;

use crate::{save_node_runs_to_disk_async, AppState};

/// `id` 是清单里的键，也是前端生成的 uuid；限制长度只为挡住异常输入。
const MAX_ID_LEN: usize = 128;

/// run_id 会拼进目录名，只放行字母/数字/`-`/`_`，挡住 `..` 之类的穿越输入。
fn valid_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= MAX_ID_LEN
        && run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn ok(data: Value) -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({ "code": 0, "data": data }))
}

/// 本机机器名。用于让前端把它作为 `client_host` 上报到 patch_search：
/// 运行态（claude 会话文件、stageDir、JDK）只在这台机器上有效，换机后那条记录
/// 就只剩服务器摘要可读——列表里要靠这个名字说明"原来是哪台机器跑的"。
///
/// 取不到也不报错，返回 `unknown`：机器名只是个展示属性，不该影响列表接口。
fn host_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return v;
            }
        }
    }
    "unknown".to_string()
}

/// GET /api/node/runs —— 本机全部运行清单。
///
/// `data` 是 run 数组；**顺序不保证**（HashMap 迭代序），由前端自己排序后再展示。
/// 额外带一个 `host`（本机机器名），前端上报 `client_host` 时用它。
pub async fn list_runs(data: web::Data<AppState>) -> HttpResponse {
    let runs: Vec<Value> = data.node_runs.read().unwrap().values().cloned().collect();
    HttpResponse::Ok().json(serde_json::json!({
        "code": 0,
        "data": runs,
        "host": host_name(),
    }))
}

/// PUT /api/node/runs/{id} —— 整对象 upsert（不存在则创建）。
///
/// 前端在每个阶段结束、状态变化时全量 PUT 一次，所以这里不做字段级合并。
pub async fn put_run(id: web::Path<String>, body: web::Json<Value>, data: web::Data<AppState>) -> HttpResponse {
    let id = id.into_inner();
    if id.len() > MAX_ID_LEN {
        return HttpResponse::BadRequest().json(serde_json::json!({ "error": "运行标识过长" }));
    }
    let mut run = body.into_inner();
    if !run.is_object() {
        return HttpResponse::BadRequest().json(serde_json::json!({ "error": "运行记录必须是 JSON 对象" }));
    }
    // 以路径里的 id 为准：两者不一致时若各存一份，清单里就会凭空多出一条永远点不动的记录。
    run["id"] = Value::String(id.clone());
    data.node_runs.write().unwrap().insert(id, run);
    save_node_runs_to_disk_async(&data);
    ok(Value::Null)
}

/// DELETE /api/node/runs/{id} —— 从清单移除。
///
/// **不删**补丁输出目录里的产物，也**不删** cc-web 会话：产物是用户资产，
/// 会话还可能被「继续会话」用到。删除清单项只表示"不再跟踪这次运行"。
pub async fn delete_run(id: web::Path<String>, data: web::Data<AppState>) -> HttpResponse {
    let removed = data.node_runs.write().unwrap().remove(&id.into_inner()).is_some();
    if removed {
        save_node_runs_to_disk_async(&data);
    }
    ok(serde_json::json!({ "deleted": if removed { 1 } else { 0 } }))
}

#[derive(Deserialize)]
pub struct WorkspaceRequest {
    pub run_id: Option<String>,
}

/// POST /api/node/workspace —— 在 `<数据目录>/temp/node/<run_id>/` 下建本次运行的工作目录（幂等）。
///
/// 小白版没有客开工程概念，暂存目录（stage_dir）/产物目录全部落在 cc-web 自己的
/// temp 下，由后端建好并返回绝对路径，前端写进 run 对象。开发版暂不使用
/// （其暂存目录在用户自填的补丁输出目录下，由 claude 自己建）。
///
/// run_id 只放行字母/数字/`-`/`_`：它是 URL 路径的一部分，拦住 `..` 之类的穿越输入。
pub async fn create_workspace(body: web::Json<WorkspaceRequest>, _data: web::Data<AppState>) -> HttpResponse {
    let run_id = body.run_id.as_deref().unwrap_or("").trim().to_string();
    if !valid_run_id(&run_id) {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "success": false,
            "error": "run_id 只允许字母、数字、- 和 _（长度 1~128）"
        }));
    }
    let dir = crate::cc_web_temp_dir().join("node").join(&run_id);
    match std::fs::create_dir_all(&dir) {
        Ok(()) => HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "path": dir.to_string_lossy(),
        })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "success": false,
            "error": format!("创建运行工作目录失败: {e}")
        })),
    }
}

#[derive(Deserialize)]
pub struct ProblemImageQuery {
    pub run_id: String,
    pub name: Option<String>,
}

#[derive(Deserialize)]
pub struct ChatAttachmentQuery {
    pub session_id: String,
    pub name: Option<String>,
}

/// 只保留安全字符（允许中文/字母/数字/`-`/`_`/`.`/括号），空名兜底。
fn sanitize_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '(' | ')') { c } else { '_' })
        .collect();
    let cleaned = cleaned.trim_matches('_').trim_matches('.').to_string();
    if cleaned.is_empty() { "attachment.bin".to_string() } else { cleaned }
}

/// 附件只用于 AI 查看，不需要可执行：明显可执行的扩展名直接拒绝。
const BLOCKED_EXTENSIONS: [&str; 8] = ["exe", "bat", "cmd", "com", "msi", "scr", "dll", "ps1"];

fn upload_fail(status: u16, message: &str) -> HttpResponse {
    let mut response = match status {
        400 => HttpResponse::BadRequest(),
        404 => HttpResponse::NotFound(),
        _ => HttpResponse::InternalServerError(),
    };
    response.json(serde_json::json!({ "success": false, "error": message }))
}

/// 把 multipart 里的文件逐个存到 `dir`，返回绝对路径。
/// 单文件上限 20MB；文件名做安全化并加 uuid 前缀防重名。
async fn save_uploaded_files(
    mut payload: Multipart,
    dir: std::path::PathBuf,
    name_override: Option<String>,
) -> Result<Vec<String>, (u16, String)> {
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return Err((500, format!("创建附件目录失败: {error}")));
    }
    let mut saved: Vec<String> = Vec::new();
    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|error| (400u16, format!("读取上传内容失败: {error}")))?;
        let filename = field
            .content_disposition()
            .and_then(|cd| cd.get_filename())
            .map(|name| name.to_string());
        let Some(filename) = filename else {
            // 非文件字段直接丢弃
            while field.next().await.is_some() {}
            continue;
        };
        let provided = name_override
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(filename);
        let safe = sanitize_file_name(&provided);
        if let Some(ext) = std::path::Path::new(&safe).extension().and_then(|value| value.to_str()) {
            if BLOCKED_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                return Err((400, "不支持上传可执行文件".to_string()));
            }
        }
        let target = dir.join(format!("{}_{}", uuid::Uuid::new_v4().simple(), safe));
        let mut file = std::fs::File::create(&target)
            .map_err(|error| (500u16, format!("写入附件失败: {error}")))?;
        let mut size: u64 = 0;
        while let Some(chunk) = field.next().await {
            let data = chunk.map_err(|error| (400u16, format!("读取文件分片失败: {error}")))?;
            size += data.len() as u64;
            if size > 20 * 1024 * 1024 {
                drop(file);
                let _ = std::fs::remove_file(&target);
                return Err((400, "单个附件不能超过 20MB".to_string()));
            }
            file.write_all(&data)
                .map_err(|error| (500u16, format!("写入附件失败: {error}")))?;
        }
        saved.push(target.to_string_lossy().to_string());
    }
    if saved.is_empty() {
        return Err((400, "没有收到文件".to_string()));
    }
    Ok(saved)
}

/// POST /api/node/problem-image?run_id=<>&name=<文件名> —— 保存「新建排查」表单里的
/// 问题图片/附件（任意类型，可执行文件除外）。文件写到
/// `<数据目录>/temp/node/<run_id>/images/`，前端把绝对路径写进提示词，AI 用 Read 查看。
pub async fn save_problem_image(
    payload: Multipart,
    query: web::Query<ProblemImageQuery>,
    _data: web::Data<AppState>,
) -> HttpResponse {
    let run_id = query.run_id.trim().to_string();
    if !valid_run_id(&run_id) {
        return upload_fail(400, "run_id 只允许字母、数字、- 和 _（长度 1~128）");
    }
    let dir = crate::cc_web_temp_dir().join("node").join(&run_id).join("images");
    match save_uploaded_files(payload, dir, query.name.clone()).await {
        Ok(paths) => HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "path": paths[0],
            "paths": paths,
        })),
        Err((status, message)) => upload_fail(status, &message),
    }
}

/// POST /api/chat/attachment?session_id=<>&name=<文件名> —— 聊天框里发送的图片/文件。
///
/// 存到会话工作目录下的 `.cc-web-attachments/`（Claude 的 cwd 内，Read 可直接访问），
/// 前端把绝对路径追加到消息文本里，AI 用 Read 查看。
pub async fn save_chat_attachment(
    payload: Multipart,
    query: web::Query<ChatAttachmentQuery>,
    data: web::Data<AppState>,
) -> HttpResponse {
    let session_id = query.session_id.trim().to_string();
    if session_id.is_empty() || session_id.len() > MAX_ID_LEN {
        return upload_fail(400, "session_id 不合法");
    }
    let cwd = {
        let sessions = data.sessions.read().unwrap_or_else(|e| e.into_inner());
        sessions.get(&session_id).map(|session| session.cwd.clone())
    };
    let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) else {
        return upload_fail(404, "会话不存在或没有工作目录");
    };
    let dir = std::path::Path::new(&cwd).join(".cc-web-attachments");
    match save_uploaded_files(payload, dir, query.name.clone()).await {
        Ok(paths) => HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "path": paths[0],
            "paths": paths,
        })),
        Err((status, message)) => upload_fail(status, &message),
    }
}
