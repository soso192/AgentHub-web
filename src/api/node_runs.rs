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

use actix_web::{web, HttpResponse};
use serde_json::Value;

use crate::{save_node_runs_to_disk_async, AppState};

/// `id` 是清单里的键，也是前端生成的 uuid；限制长度只为挡住异常输入。
const MAX_ID_LEN: usize = 128;

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
