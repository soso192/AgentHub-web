use super::deploy;
use super::detect::detect_env;
use super::model::{BatchSummary, Config, DeployResult, EnvInfo, SavedServiceCommands};
use super::service;
use super::state::PatchDeployState;
use super::util::{new_batch_id, service_key, LogFile};
use crate::AppState;
use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 补丁部署接口统一 HTTP 200：真正的业务状态码放在 `code` 字段里，
/// 前端按 `code` 判断成功/失败。这样失焦探测、部署失败等都能稳定拿到响应体。
fn json_error(status: actix_web::http::StatusCode, message: impl Into<String>) -> HttpResponse {
    HttpResponse::Ok().json(json!({
        "success": false,
        "code": status.as_u16(),
        "error": message.into(),
    }))
}

fn ok(data: impl serde::Serialize) -> HttpResponse {
    HttpResponse::Ok().json(json!({
        "success": true,
        "code": 0,
        "data": data,
    }))
}

fn internal_error(message: impl Into<String>) -> HttpResponse {
    json_error(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, message)
}

fn pd(state: &web::Data<AppState>) -> &PatchDeployState {
    &state.patch_deploy
}

/// 环境检测 + 用户手工保存的服务命令覆盖。
fn detect_with_overrides(
    deploy_state: &PatchDeployState,
    path: &str,
    edition: &str,
) -> anyhow::Result<EnvInfo> {
    let mut env = detect_env(path, edition)?;
    if let Some(saved) = deploy_state.service_commands(&env.service_key) {
        env.service.start_script = saved.start_script;
        env.service.stop_script = saved.stop_script;
        env.service.restart_script = saved.restart_script;
        env.service.can_restart = env.service.restart_script.is_some()
            || (env.service.start_script.is_some() && env.service.stop_script.is_some());
        env.service.message = service::service_message(&env.service);
    }
    Ok(env)
}

/// 补丁部署会停服务、覆盖本地文件。
///
/// 默认允许开发版/实施版从局域网页面使用（实施版本身就按局域网访问设计），
/// 但拒绝跨源页面请求，避免开发版宽松 CORS 下被外部网页调用。
/// 如需强制只允许本机，启动 cc-web 时设置 `CCWEB_PATCH_DEPLOY_LOCAL_ONLY=1`。
fn request_guard(req: &HttpRequest) -> Option<HttpResponse> {
    let enforced = std::env::var("CCWEB_PATCH_DEPLOY_LOCAL_ONLY")
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            value == "1" || value == "true" || value == "yes" || value == "on"
        })
        .unwrap_or(false);
    if enforced {
        let local = req
            .peer_addr()
            .map(|addr| addr.ip().is_loopback())
            .unwrap_or(false);
        if !local {
            return Some(json_error(
                actix_web::http::StatusCode::FORBIDDEN,
                "补丁部署工具仅允许本机访问",
            ));
        }
    }

    // 同源校验：浏览器 POST 会带 Origin。开发版 CORS 允许任意来源，
    // 这里必须把外部网页的请求挡住；curl 等无 Origin 请求不受影响。
    if let Some(origin) = req
        .headers()
        .get(actix_web::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        let Some((_, rest)) = origin.split_once("://") else {
            return Some(json_error(
                actix_web::http::StatusCode::FORBIDDEN,
                "补丁部署工具拒绝跨源请求",
            ));
        };
        let origin_host = rest.split('/').next().unwrap_or(rest);
        let host = req
            .headers()
            .get(actix_web::http::header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if host.is_empty() || !origin_host.eq_ignore_ascii_case(host) {
            return Some(json_error(
                actix_web::http::StatusCode::FORBIDDEN,
                "补丁部署工具拒绝跨源请求",
            ));
        }
    }
    None
}

pub async fn get_config(req: HttpRequest, state: web::Data<AppState>) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let config = pd(&state).config.lock().unwrap().clone();
    ok(json!({ "success": true, "config": config }))
}

#[derive(Deserialize)]
pub struct SaveConfigReq {
    pub last_target: Option<String>,
    pub edition: Option<String>,
    pub restart: Option<bool>,
    pub product_name: Option<String>,
    pub product_version: Option<String>,
}

pub async fn save_config(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<SaveConfigReq>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    {
        let mut config = pd(&state).config.lock().unwrap();
        if let Some(target) = &body.last_target {
            config.last_target = target.clone();
            config.recent_targets.retain(|item| item != target);
            config.recent_targets.insert(0, target.clone());
            config.recent_targets.truncate(10);
        }
        if let Some(edition) = &body.edition {
            config.edition = edition.clone();
        }
        if let Some(restart) = body.restart {
            config.restart = restart;
        }
        if let Some(name) = &body.product_name {
            config.product_name = name.clone();
        }
        if let Some(version) = &body.product_version {
            config.product_version = version.clone();
        }
    }
    if let Err(error) = pd(&state).save_config() {
        return internal_error(format!("保存配置失败：{error}"));
    }
    let config = pd(&state).config.lock().unwrap().clone();
    ok(json!({ "success": true, "config": config }))
}

#[derive(Deserialize)]
pub struct DetectReq {
    pub path: String,
    #[serde(default)]
    pub edition: String,
}

pub async fn detect(
    req: HttpRequest,
    body: web::Json<DetectReq>,
    state: web::Data<AppState>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    match detect_with_overrides(pd(&state), &body.path, &body.edition) {
        Ok(env) => {
            let _ = pd(&state).remember_target(&body.path, &body.edition);
            ok(json!({ "success": true, "env": env }))
        }
        Err(error) => json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            format!("{error:#}"),
        ),
    }
}

fn safe_filename(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("patch.zip")
        .trim();
    let mut value: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '(' | ')' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if value.is_empty() {
        value = "patch.zip".to_string();
    }
    if !value.to_lowercase().ends_with(".zip") {
        value.push_str(".zip");
    }
    value
}

pub async fn preflight(
    req: HttpRequest,
    mut payload: Multipart,
    state: web::Data<AppState>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let batch_id = new_batch_id();
    let staging = pd(&state).staging_dir(&batch_id);
    if let Err(error) = fs::create_dir_all(staging.join("uploads")) {
        return internal_error(format!("创建临时目录失败：{error}"));
    }

    let mut target = String::new();
    let mut edition = "auto".to_string();
    let mut product_name = String::new();
    let mut product_version = String::new();
    let mut uploads: Vec<(String, PathBuf)> = Vec::new();
    let mut index = 0usize;

    while let Some(item) = payload.next().await {
        let mut field = match item {
            Ok(field) => field,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return json_error(
                    actix_web::http::StatusCode::BAD_REQUEST,
                    format!("读取上传内容失败：{error}"),
                );
            }
        };
        let field_name = field.name().unwrap_or("").to_string();
        let file_name = field
            .content_disposition()
            .and_then(|cd| cd.get_filename())
            .map(|v| v.to_string());

        let text_field = match field_name.as_str() {
            "target" | "edition" | "product_name" | "product_version" => true,
            _ => false,
        };
        if text_field {
            match field.bytes(64 * 1024).await {
                Ok(Ok(bytes)) => {
                    let text = String::from_utf8_lossy(&bytes).trim().to_string();
                    match field_name.as_str() {
                        "target" => target = text,
                        "edition" => edition = if text.is_empty() { "auto".into() } else { text },
                        "product_name" => product_name = text,
                        "product_version" => product_version = text,
                        _ => {}
                    }
                }
                Ok(Err(error)) => {
                    let _ = fs::remove_dir_all(&staging);
                    return json_error(
                        actix_web::http::StatusCode::BAD_REQUEST,
                        format!("读取 {field_name} 失败：{error}"),
                    );
                }
                Err(error) => {
                    let _ = fs::remove_dir_all(&staging);
                    return json_error(
                        actix_web::http::StatusCode::BAD_REQUEST,
                        format!("{field_name} 过长或读取失败：{error}"),
                    );
                }
            }
            continue;
        }

        if field_name != "files" {
            // 丢弃未知字段，避免 multipart 流停在未消费的 Field 上。
            while field.next().await.is_some() {}
            continue;
        }
        let Some(file_name) = file_name else {
            while field.next().await.is_some() {}
            continue;
        };
        if !file_name.to_lowercase().ends_with(".zip") {
            let _ = fs::remove_dir_all(&staging);
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                format!("只接受 ZIP 补丁包：{file_name}"),
            );
        }
        index += 1;
        let safe = safe_filename(&file_name);
        let path = staging.join("uploads").join(format!("{index:03}-{safe}"));
        let mut output = match fs::File::create(&path) {
            Ok(file) => file,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return internal_error(format!("创建上传文件失败：{error}"));
            }
        };
        use std::io::Write;
        let mut failed = None;
        while let Some(chunk) = field.next().await {
            match chunk {
                Ok(bytes) => {
                    if let Err(error) = output.write_all(&bytes) {
                        failed = Some(error.to_string());
                        break;
                    }
                }
                Err(error) => {
                    failed = Some(error.to_string());
                    break;
                }
            }
        }
        if let Some(message) = failed {
            let _ = fs::remove_dir_all(&staging);
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                format!("保存 {file_name} 失败：{message}"),
            );
        }
        uploads.push((file_name, path));
    }

    if target.is_empty() {
        let _ = fs::remove_dir_all(&staging);
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "请填写并检测本地服务地址",
        );
    }
    if uploads.is_empty() {
        let _ = fs::remove_dir_all(&staging);
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "请至少上传一个 ZIP 补丁包",
        );
    }

    let staging_for_task = staging.clone();
    let batch_for_task = batch_id.clone();
    let edition_for_config = edition.clone();
    let result = web::block(move || {
        deploy::preflight(
            &target,
            &edition,
            &product_name,
            &product_version,
            &uploads,
            &staging_for_task,
            &batch_for_task,
        )
    })
    .await;

    match result {
        Ok(Ok(plan)) => {
            let _ = pd(&state).remember_form(
                &plan.env.input_path,
                &edition_for_config,
                &plan.product_name,
                &plan.product_version,
            );
            ok(plan)
        }
        Ok(Err(error)) => {
            let _ = fs::remove_dir_all(&staging);
            json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                format!("{error:#}"),
            )
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            internal_error(format!("预检任务失败：{error}"))
        }
    }
}

#[derive(Deserialize)]
pub struct DeployReq {
    pub batch_id: String,
    #[serde(default)]
    pub restart: bool,
    #[serde(default)]
    pub confirm_replace: bool,
}

pub async fn deploy_handler(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<DeployReq>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let deploy_state = pd(&state);
    if deploy_state.busy.swap(true, Ordering::SeqCst) {
        return json_error(
            actix_web::http::StatusCode::CONFLICT,
            "已有部署/回滚任务正在执行，请稍后",
        );
    }
    let _guard = BusyGuard(&deploy_state.busy);

    let batch_id = body.batch_id.clone();
    let staging = deploy_state.staging_dir(&batch_id);
    if !staging.join("plan.json").is_file() {
        return json_error(
            actix_web::http::StatusCode::NOT_FOUND,
            "预检结果不存在或已过期，请重新预检",
        );
    }
    let batch_dir = deploy_state.batch_dir(&batch_id);
    let log_path = deploy_state.log_path(&batch_id);
    let seq = deploy_state.next_seq();
    let restart = body.restart;
    let confirm = body.confirm_replace;
    let service_override = if restart {
        super::util::read_json::<super::model::StoredPlan>(&staging.join("plan.json"))
            .ok()
            .and_then(|plan| {
                detect_with_overrides(deploy_state, &plan.env.target_root, plan.env.edition.as_str())
                    .ok()
                    .map(|env| env.service)
            })
    } else {
        None
    };

    let result = web::block(move || {
        let mut log = LogFile::create(log_path)?;
        log.line(format!(
            "开始部署批次 {batch_id}（restart={restart}, confirm_replace={confirm}）"
        ));
        let outcome = deploy::deploy(
            &staging,
            &batch_dir,
            &mut log,
            restart,
            confirm,
            service_override,
            seq,
        )?;
        Ok::<_, anyhow::Error>((outcome, staging))
    })
    .await;

    match result {
        Ok(Ok((outcome, staging))) => {
            {
                let mut batches = deploy_state.batches.lock().unwrap();
                batches.push(outcome.record.clone());
            }
            if let Err(error) = deploy_state.save_batches() {
                return internal_error(format!("部署完成，但保存批次记录失败：{error}"));
            }
            let _ = fs::remove_dir_all(&staging);
            ok(outcome.result)
        }
        Ok(Err(error)) => json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            format!("{error:#}"),
        ),
        Err(error) => internal_error(format!("部署任务失败：{error}")),
    }
}

#[derive(Deserialize)]
pub struct CancelReq {
    pub batch_id: String,
}

pub async fn cancel(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<CancelReq>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let staging = pd(&state).staging_dir(&body.batch_id);
    if staging.exists() {
        if let Err(error) = fs::remove_dir_all(&staging) {
            return internal_error(format!("清理临时目录失败：{error}"));
        }
    }
    ok(json!({ "success": true }))
}

pub async fn list_batches(req: HttpRequest, state: web::Data<AppState>) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let batches = pd(&state).batches.lock().unwrap().clone();
    let mut summaries: Vec<BatchSummary> = batches
        .iter()
        .map(|batch| BatchSummary {
            batch: batch.clone(),
            later_deployed: batches
                .iter()
                .filter(|other| {
                    other.status == "deployed"
                        && other.seq > batch.seq
                        && service_key(&other.target_root) == service_key(&batch.target_root)
                        && other.edition == batch.edition
                })
                .count(),
            service_key: service_key(&batch.target_root),
        })
        .collect();
    summaries.sort_by_key(|item| std::cmp::Reverse(item.batch.seq));
    ok(json!({ "success": true, "batches": summaries }))
}

pub async fn batch_detail(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let id = path.into_inner();
    let batches = pd(&state).batches.lock().unwrap();
    match batches.iter().find(|batch| batch.id == id) {
        Some(batch) => ok(json!({ "success": true, "batch": batch })),
        None => json_error(actix_web::http::StatusCode::NOT_FOUND, "批次不存在"),
    }
}

#[derive(Deserialize)]
pub struct RollbackReq {
    pub batch_id: String,
    #[serde(default)]
    pub restart: bool,
    #[serde(default)]
    pub confirm: bool,
}

pub async fn rollback_handler(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<RollbackReq>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let deploy_state = pd(&state);
    if deploy_state.busy.swap(true, Ordering::SeqCst) {
        return json_error(
            actix_web::http::StatusCode::CONFLICT,
            "已有部署/回滚任务正在执行，请稍后",
        );
    }
    let _guard = BusyGuard(&deploy_state.busy);

    let id = body.batch_id.clone();
    let restart = body.restart;
    let confirm = body.confirm;
    if !confirm {
        return json_error(actix_web::http::StatusCode::BAD_REQUEST, "回滚需要二次确认");
    }
    let data_dir = deploy_state.data_dir.clone();
    let task_data_dir = data_dir.clone();
    let mut batches = deploy_state.batches.lock().unwrap().clone();
    let service_override = if restart {
        batches
            .iter()
            .find(|batch| batch.id == id)
            .and_then(|batch| {
                detect_with_overrides(deploy_state, &batch.target_root, &batch.edition)
                    .ok()
                    .map(|env| env.service)
            })
    } else {
        None
    };
    if restart
        && !service_override
            .as_ref()
            .map(|service| service.can_restart)
            .unwrap_or(false)
    {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "未找到重启命令，不能撤回并重启",
        );
    }
    let log_path = data_dir.join("logs").join(format!(
        "rollback-{}.log",
        super::util::now_text().replace([':', ' '], "-")
    ));

    let result = web::block(move || {
        let mut log = LogFile::create(log_path)?;
        log.line(format!("开始回滚到批次 {id}（restart={restart}）"));
        let result = deploy::rollback(
            &mut batches,
            &task_data_dir,
            &id,
            restart,
            confirm,
            service_override,
            &mut log,
        )?;
        Ok::<_, anyhow::Error>((result, batches))
    })
    .await;

    match result {
        Ok(Ok((result, updated))) => {
            {
                let mut batches = deploy_state.batches.lock().unwrap();
                *batches = updated;
            }
            if let Err(error) = deploy_state.save_batches() {
                return internal_error(format!("回滚完成，但保存批次记录失败：{error}"));
            }
            ok(result)
        }
        Ok(Err(error)) => {
            if let Ok(saved) = super::util::read_json::<Vec<super::model::BatchRecord>>(
                &data_dir.join("batches.json"),
            ) {
                *deploy_state.batches.lock().unwrap() = saved;
            }
            json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                format!("{error:#}"),
            )
        }
        Err(error) => internal_error(format!("回滚任务失败：{error}")),
    }
}

#[derive(Deserialize)]
pub struct SaveServiceCommandsReq {
    pub service_key: String,
    #[serde(default)]
    pub start_script: Option<String>,
    #[serde(default)]
    pub stop_script: Option<String>,
    #[serde(default)]
    pub restart_script: Option<String>,
}

fn nonempty(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// 保存用户手工修改的启动/停止/重启命令，按 service_key（部署目录）持久化。
pub async fn save_service_commands(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<SaveServiceCommandsReq>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let service_key = body.service_key.trim().to_string();
    if service_key.is_empty() {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "service_key 不能为空",
        );
    }
    let commands = SavedServiceCommands {
        start_script: nonempty(body.start_script.clone()),
        stop_script: nonempty(body.stop_script.clone()),
        restart_script: nonempty(body.restart_script.clone()),
    };
    if let Err(error) = pd(&state).save_service_commands(service_key.clone(), commands.clone()) {
        return internal_error(format!("保存服务命令失败：{error}"));
    }
    ok(json!({
        "success": true,
        "service_key": service_key,
        "commands": commands,
    }))
}

#[derive(Deserialize)]
pub struct RestartReq {
    pub path: String,
    #[serde(default)]
    pub edition: String,
}

/// 手动重启本地服务；部署/撤回本身不再自动重启。
pub async fn restart(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Json<RestartReq>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let path = body.path.trim().to_string();
    if path.is_empty() {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "请先填写本地服务地址",
        );
    }
    let edition = if body.edition.trim().is_empty() {
        "auto"
    } else {
        body.edition.trim()
    };
    let env = match detect_with_overrides(pd(&state), &path, edition) {
        Ok(env) => env,
        Err(error) => {
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                format!("{error:#}"),
            )
        }
    };
    if !env.service.can_restart {
        return json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            "未找到重启命令",
        );
    }
    let service_info = env.service.clone();
    let log_path = pd(&state).data_dir.join("logs").join(format!(
        "restart-{}.log",
        super::util::now_text().replace([':', ' '], "-")
    ));
    let result = web::block(move || {
        let mut log = LogFile::create(log_path)?;
        service::restart(&service_info, &mut log, false)?;
        Ok::<_, anyhow::Error>(log.tail(100))
    })
    .await;

    match result {
        Ok(Ok(log_tail)) => ok(DeployResult {
            success: true,
            batch_id: String::new(),
            message: "本地服务已重启".to_string(),
            applied: 0,
            replaced: 0,
            added: 0,
            service_restarted: true,
            warnings: Vec::new(),
            log_tail,
        }),
        Ok(Err(error)) => json_error(
            actix_web::http::StatusCode::BAD_REQUEST,
            format!("重启失败：{error:#}"),
        ),
        Err(error) => internal_error(format!("重启任务失败：{error}")),
    }
}

/// 删除已撤回批次的记录和备份；只允许删除 rolled_back 状态。
pub async fn delete_batch(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    let batch_id = path.into_inner();
    let deploy_state = pd(&state);
    {
        let mut batches = deploy_state.batches.lock().unwrap();
        let Some(index) = batches.iter().position(|batch| batch.id == batch_id) else {
            return json_error(actix_web::http::StatusCode::NOT_FOUND, "批次不存在");
        };
        if batches[index].status != "rolled_back" {
            return json_error(
                actix_web::http::StatusCode::BAD_REQUEST,
                "只有已撤回的记录可以删除",
            );
        }
        batches.remove(index);
    }
    if let Err(error) = deploy_state.save_batches() {
        return internal_error(format!("删除批次记录失败：{error}"));
    }
    let _ = fs::remove_dir_all(deploy_state.batch_dir(&batch_id));
    let _ = fs::remove_file(deploy_state.log_path(&batch_id));
    ok(json!({ "success": true, "batch_id": batch_id }))
}

/// 重置表单配置（用于调试/设置页）。
pub async fn reset_config_defaults(req: HttpRequest, state: web::Data<AppState>) -> impl Responder {
    if let Some(response) = request_guard(&req) {
        return response;
    }
    {
        let mut config = pd(&state).config.lock().unwrap();
        *config = Config::default();
    }
    let _ = pd(&state).save_config();
    ok(json!({ "success": true }))
}
