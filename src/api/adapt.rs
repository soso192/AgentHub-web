//! 补丁适配（用户端）：接收本地上传的补丁包 → 存到 temp 并解压；检查客开工程的 git 状态。
//!
//! 目录约定（与「智能分析结果」一致，都放在 cc-web 所在目录下的 temp\）：
//!   <cc-web目录>\temp\adapt\<runId>\<seq>\<补丁文件名>
//!   <cc-web目录>\temp\adapt\<runId>\<seq>\<解压后的内容>
//! 事实来源在用户端；patch_search 只收摘要账本（供跨机器查询）。
//! 「开始适配」由后台线程执行（adapt_bg.rs），浏览器可随时关闭。

use actix_multipart::Multipart;
use actix_web::{web, HttpResponse};
use futures::StreamExt;
use serde::Deserialize;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
pub struct UploadQuery {
    pub run_id: String,
    pub seq: u32,
}

#[derive(Deserialize)]
pub struct GitStatusQuery {
    pub path: Option<String>,
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => c,
            _ => '_',
        })
        .collect()
}

/// <cc-web.exe 所在目录>\temp\adapt
fn adapt_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("temp").join("adapt"))
}

fn extract_zip(zip_path: &Path, dir: &Path) -> Result<usize, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut count = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        // enclosed_name 会挡掉 ../ 之类的目录穿越条目
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let target = dir.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}

/// 接收一个补丁包（multipart 单文件），存盘并解压。
/// 用法：POST /api/adapt/upload?run_id=<>&seq=<n>，body 为 multipart/form-data，文件字段任意名。
pub async fn upload(mut payload: Multipart, query: web::Query<UploadQuery>) -> HttpResponse {
    let run_id = sanitize(&query.run_id);
    if run_id.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "run_id 不能为空"}));
    }
    let Some(root) = adapt_root() else {
        return HttpResponse::InternalServerError().json(serde_json::json!({"success": false, "error": "无法定位 cc-web 所在目录"}));
    };
    let dir = root.join(&run_id).join(query.seq.to_string());
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return HttpResponse::InternalServerError().json(serde_json::json!({"success": false, "error": format!("创建目录失败：{error}")}));
    }

    let mut saved: Option<PathBuf> = None;
    while let Some(item) = payload.next().await {
        let mut field = match item {
            Ok(field) => field,
            Err(error) => return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": format!("读取上传内容失败：{error}")})),
        };
        let filename = field
            .content_disposition()
            .and_then(|cd| cd.get_filename())
            .map(|name| name.to_string())
            .unwrap_or_else(|| "patch.zip".to_string());
        let target = dir.join(sanitize(&filename));
        let mut file = match std::fs::File::create(&target) {
            Ok(file) => file,
            Err(error) => return HttpResponse::InternalServerError().json(serde_json::json!({"success": false, "error": format!("写入失败：{error}")})),
        };
        while let Some(chunk) = field.next().await {
            let data = match chunk {
                Ok(data) => data,
                Err(error) => return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": format!("读取分片失败：{error}")})),
            };
            if let Err(error) = file.write_all(&data) {
                return HttpResponse::InternalServerError().json(serde_json::json!({"success": false, "error": format!("写入失败：{error}")}));
            }
        }
        saved = Some(target);
    }

    let Some(zip_path) = saved else {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "没有收到文件"}));
    };
    match extract_zip(&zip_path, &dir) {
        Ok(entries) => HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "dir": dir.to_string_lossy(),
            "zip": zip_path.to_string_lossy(),
            "entries": entries,
        })),
        Err(error) => HttpResponse::Ok().json(serde_json::json!({
            "success": false,
            "error": format!("解压失败：{error}"),
            "zip": zip_path.to_string_lossy(),
        })),
    }
}

/// 从补丁中心取补丁包：普通检索列表点「适配」走这条（补丁已在服务器上，本机没有文件）。
#[derive(Deserialize)]
pub struct AdaptImportRequest {
    pub run_id: String,
    pub seq: u32,
    pub patch_id: String,
    /// 列表里的文件名（可能缺扩展名，仅作回退；响应头里的名字优先）
    pub patch_name: Option<String>,
    pub server_url: String,
    pub auth_token: String,
}

/// 下载补丁包到本机并解压：`POST /api/adapt/import`（JSON 请求，**流式响应**）。
///
/// 与 `/api/adapt/upload`（multipart 上传本地文件）**同一套目录约定与解压逻辑**，
/// 只是数据来源换成"从补丁中心拉"。
///
/// 响应为什么是流：下载要显示进度，而浏览器在 fetch 拿到完整响应前看不到任何字节。
/// 所以这里**一行一条**地把进度推出去（Content-Type: text/plain）：
///   `progress <已下载字节> <总字节>`   每 64KB 一条（总字节来自 Content-Length，没有则为 0）
///   `extracting`                       下载完、开始解压（大补丁解压也要几秒）
///   `ok <结果 JSON>`                   成功（与 upload 同形：{success,dir,zip,name,entries}）
///   `error <原因>`                     失败（下载/解压的失败只能走这里——HTTP 状态早就是 200 了）
///
/// 下载与解压都在 blocking 线程里跑，进度经 mpsc 送回 async 流。
pub async fn import_patch(body: web::Json<AdaptImportRequest>) -> HttpResponse {
    let run_id = sanitize(&body.run_id);
    if run_id.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "run_id 不能为空"}));
    }
    if body.patch_id.trim().is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "patch_id 不能为空"}));
    }
    if body.server_url.trim().is_empty() || body.auth_token.trim().is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "缺少补丁中心地址或凭据"}));
    }
    let Some(root) = adapt_root() else {
        return HttpResponse::InternalServerError().json(serde_json::json!({"success": false, "error": "无法定位 cc-web 所在目录"}));
    };
    let dir = root.join(&run_id).join(body.seq.to_string());
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return HttpResponse::InternalServerError().json(serde_json::json!({"success": false, "error": format!("创建目录失败：{error}")}));
    }

    let server_url = body.server_url.clone();
    let auth_token = body.auth_token.clone();
    let patch_id = body.patch_id.trim().to_string();
    let fallback_name = body.patch_name.clone().unwrap_or_default();
    let job_dir = dir.clone();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    tokio::task::spawn_blocking(move || {
        let tx_progress = tx.clone();
        let outcome = super::adapt_bg::download_patch_zip(
            &server_url,
            &auth_token,
            &patch_id,
            &job_dir,
            &fallback_name,
            |downloaded, total| {
                let _ = tx_progress.blocking_send(format!("progress {} {}\n", downloaded, total.unwrap_or(0)));
            },
        )
        .and_then(|(zip_path, name)| {
            let _ = tx.blocking_send("extracting\n".to_string());
            let entries = extract_zip(&zip_path, &job_dir).map_err(|error| format!("解压失败：{error}"))?;
            Ok((zip_path, name, entries))
        });

        let line = match outcome {
            Ok((zip_path, name, entries)) => format!("ok {}\n", serde_json::json!({
                "success": true,
                "dir": job_dir.to_string_lossy(),
                "zip": zip_path.to_string_lossy(),
                "name": name,
                "entries": entries,
            })),
            // 错误信息里不能带换行，否则前端按行解析会错位
            Err(error) => format!("error {}\n", error.replace(['\n', '\r'], " ")),
        };
        let _ = tx.blocking_send(line);
        // tx 在这里随闭包结束一起 drop → 流自然结束
    });

    let stream = async_stream::stream! {
        while let Some(line) = rx.recv().await {
            yield Ok::<_, actix_web::Error>(actix_web::web::Bytes::from(line));
        }
    };
    HttpResponse::Ok()
        .insert_header(("Content-Type", "text/plain; charset=utf-8"))
        .insert_header(("Cache-Control", "no-cache"))
        .streaming(stream)
}

/// 检查客开工程目录的 git 状态：有没有 .git、有没有未提交改动。
/// 适配是「直接改工程、无法自动恢复」，所以开始前要据此提示用户。
pub async fn git_status(query: web::Query<GitStatusQuery>) -> HttpResponse {
    let dir = query.path.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let Some(dir) = dir else {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "path 不能为空"}));
    };
    let path = Path::new(dir);
    if !path.is_dir() {
        return HttpResponse::Ok().json(serde_json::json!({"success": true, "is_git": false, "has_changes": false, "reason": "目录不存在"}));
    }
    if !path.join(".git").exists() {
        return HttpResponse::Ok().json(serde_json::json!({"success": true, "is_git": false, "has_changes": false}));
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("status")
        .arg("--porcelain")
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let summary = text.lines().take(20).collect::<Vec<_>>().join("\n");
            HttpResponse::Ok().json(serde_json::json!({
                "success": true,
                "is_git": true,
                "has_changes": !text.is_empty(),
                "summary": summary,
            }))
        }
        _ => HttpResponse::Ok().json(serde_json::json!({
            "success": true,
            "is_git": true,
            "has_changes": false,
            "reason": "git 命令不可用",
        })),
    }
}

// ── 后台适配：开始 / 查状态 / 中止 ──

use crate::AppState;
use super::adapt_bg::{AdaptRun, AdaptItem};

#[derive(Deserialize)]
pub struct AdaptStartRequest {
    pub project_dir: String,
    pub product_name: Option<String>,
    pub product_version: Option<String>,
    pub server_url: String,
    pub auth_token: String,
    pub items: Vec<AdaptStartItem>,
}

#[derive(Deserialize)]
pub struct AdaptStartItem {
    pub seq: u32,
    pub patch_name: String,
    pub problem_desc: String,
    pub dir: String,
}

/// 前端带来的「当前可用凭据」：适配可能跑很久（暂停、隔天继续），启动时存的 JWT
/// 过期后（默认 120 分钟），后台拿旧 token 上报会一直 401，服务器账本停在旧状态。
/// 前端手里是登录后的活 token——「继续下一步 / 一键跑完 / 补报」时都带上这份，刷新 run 的凭据。
#[derive(Deserialize)]
pub struct AdaptRefreshRequest {
    pub server_url: String,
    pub auth_token: String,
}

/// 把前端带来的地址与 token 刷进这条 run（空字段跳过）。返回 run 是否存在。
fn refresh_credentials(data: &actix_web::web::Data<AppState>, run_id: &str, body: Option<&AdaptRefreshRequest>) -> bool {
    let Some(body) = body else { return data.adapt_runs.read().unwrap().contains_key(run_id) };
    let mut runs = data.adapt_runs.write().unwrap();
    match runs.get_mut(run_id) {
        Some(run) => {
            let server_url = body.server_url.trim().trim_end_matches('/');
            if !server_url.is_empty() {
                run.server_url = server_url.to_string();
            }
            let auth_token = body.auth_token.trim();
            if !auth_token.is_empty() {
                run.auth_token = auth_token.to_string();
            }
            true
        }
        None => false,
    }
}

/// 开始适配：创建后台任务并**立即返回**（浏览器可关窗口）。
/// 同一时间只允许一个适配任务在跑。
pub async fn start(data: actix_web::web::Data<AppState>, body: actix_web::web::Json<AdaptStartRequest>) -> HttpResponse {
    // 校验
    if body.items.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "补丁列表为空"}));
    }
    if body.project_dir.trim().is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "客开工程目录为空"}));
    }
    if body.auth_token.trim().is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({"success": false, "error": "缺少 patch_search token"}));
    }

    // 同一时间只允许一个
    let has_running = {
        let runs = data.adapt_runs.read().unwrap();
        runs.values().any(|r| r.status == "running")
    };
    if has_running {
        return HttpResponse::Conflict().json(serde_json::json!({
            "success": false,
            "error": "已有适配任务正在执行，请等它跑完或先中止"
        }));
    }

    // 创建会话：既要助手内部的会话（claude 的 cwd/model/agent_session_id），
    // 也要 cc-web 会话（进 data.sessions + 事件通道）——否则聊天页「查看会话」找不到它。
    let handle = {
        let registry = data.registry.read().unwrap();
        registry.get_handle("claude")
    };
    let Some(handle) = handle else {
        return HttpResponse::InternalServerError().json(serde_json::json!({"success": false, "error": "ClaudeCode 不可用"}));
    };
    let session_id = {
        let assistant = handle.read().unwrap();
        match assistant.create_session(body.project_dir.clone(), None).await {
            Ok(sid) => sid,
            Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({"success": false, "error": format!("创建会话失败：{}", e)})),
        }
    };
    let current_model = {
        let assistant = handle.read().unwrap();
        assistant.get_model(&session_id).unwrap_or_else(|| assistant.default_model().to_string())
    };
    // 建 cc-web 会话（与 /api/agent/new 同一步骤，聊天页据此列出并挂 SSE）
    let now = chrono::Utc::now();
    {
        let session = crate::models::Session {
            id: session_id.clone(),
            assistant: "claude".to_string(),
            cwd: body.project_dir.clone(),
            model: current_model.clone(),
            messages: Vec::new(),
            created_at: now,
            updated_at: now,
            history_context: None,
            agent_session_id: None,
            history_already_sent: false,
        };
        data.sessions.write().unwrap().insert(session_id.clone(), session);
    }
    crate::save_sessions_to_disk_async(&data);
    {
        let (tx, _) = tokio::sync::broadcast::channel::<String>(1024);
        data.events_tx.write().unwrap().insert(session_id.clone(), tx);
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let run = AdaptRun {
        id: run_id.clone(),
        project_dir: body.project_dir.clone(),
        product_name: body.product_name.clone().unwrap_or_default(),
        product_version: body.product_version.clone().unwrap_or_default(),
        session_id,
        agent_session_id: String::new(),
        items: body.items.iter().map(|item| AdaptItem {
            seq: item.seq,
            patch_name: item.patch_name.clone(),
            problem_desc: item.problem_desc.clone(),
            dir: item.dir.clone(),
            status: "pending".to_string(),
            changed_files: None,
            conflict_detail: None,
            note: None,
            started_at: None,
            finished_at: None,
            output_conclusion: None,
            output_summary: None,
        }).collect(),
        status: "running".to_string(),
        report: None,
        started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false),
        finished_at: None,
        server_url: body.server_url.clone(),
        auth_token: body.auth_token.clone(),
        abort_requested: false,
        auto_continue: false,
    };

    // 存入内存并落盘
    {
        let mut runs = data.adapt_runs.write().unwrap();
        runs.insert(run_id.clone(), run);
    }
    super::adapt_bg::save_adapt_runs(&data);

    // 启动后台线程
    // 注意：AppState 不是 Clone，这里用 data.clone()（web::Data = Arc）传进去
    let arc = data.clone();  // web::Data<AppState> → Arc<AppState>
    let inner: std::sync::Arc<AppState> = arc.into_inner().into();
    super::adapt_bg::spawn_adaptation(inner, run_id.clone());

    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "run_id": run_id,
        "message": "适配已在后台执行，可关闭页面。进度可在「适配记录」中查看。"
    }))
}

/// 本机适配任务列表（含实时状态）
pub async fn list_runs(data: actix_web::web::Data<AppState>) -> HttpResponse {
    let runs = data.adapt_runs.read().unwrap();
    let list: Vec<&AdaptRun> = runs.values().collect();
    HttpResponse::Ok().json(serde_json::json!({"success": true, "data": list}))
}

/// 本机某任务详情（逐补丁实时状态）
pub async fn get_run(data: actix_web::web::Data<AppState>, path: actix_web::web::Path<String>) -> HttpResponse {
    let run_id = path.into_inner();
    let runs = data.adapt_runs.read().unwrap();
    match runs.get(&run_id) {
        Some(run) => HttpResponse::Ok().json(serde_json::json!({"success": true, "data": run})),
        None => HttpResponse::NotFound().json(serde_json::json!({"success": false, "error": "适配任务不存在"})),
    }
}

/// 「继续下一步」与「一键跑完剩余」的共同实现——两者只差一个 `auto_continue`：
/// 前者跑完下一个补丁再次停下等确认，后者一路跑到底不再停。
///
/// 无论哪种，都在**同一个 claude 会话**里继续：重新起后台线程后，它会从第一个待适配的补丁
/// 接着跑，并因为 `run.agent_session_id` 非空而走 `--resume`（上下文不丢）。
/// 请求体可带当前可用的 server_url/auth_token，先刷新 run 的上报凭据再继续——
/// 否则暂停隔久了，旧 JWT 会让之后每一轮的上报都 401。
async fn continue_run(data: actix_web::web::Data<AppState>, run_id: String, auto_continue: bool, refresh: Option<&AdaptRefreshRequest>) -> HttpResponse {
    // 同一时间只允许一个适配任务在跑（与 start 同口径）
    let has_running = {
        let runs = data.adapt_runs.read().unwrap();
        runs.values().any(|r| r.status == "running")
    };
    if has_running {
        return HttpResponse::Conflict().json(serde_json::json!({
            "success": false,
            "error": "已有适配任务正在执行，请等它跑完或先中止"
        }));
    }

    {
        let mut runs = data.adapt_runs.write().unwrap();
        match runs.get_mut(&run_id) {
            Some(run) if run.status == "awaiting_confirmation" => {
                run.status = "running".to_string();
                if auto_continue {
                    run.auto_continue = true;
                }
                if let Some(body) = refresh {
                    let server_url = body.server_url.trim().trim_end_matches('/');
                    if !server_url.is_empty() {
                        run.server_url = server_url.to_string();
                    }
                    let auth_token = body.auth_token.trim();
                    if !auth_token.is_empty() {
                        run.auth_token = auth_token.to_string();
                    }
                }
            }
            Some(_) => {
                return HttpResponse::BadRequest().json(serde_json::json!({
                    "success": false,
                    "error": "该任务当前不在待确认状态"
                }));
            }
            None => {
                return HttpResponse::NotFound().json(serde_json::json!({
                    "success": false,
                    "error": "适配任务不存在"
                }));
            }
        }
    }
    // 落盘 + 上报（服务器账本也立刻变回「适配中」）
    super::adapt_bg::report_and_save(&data, &run_id);

    // 起后台线程继续跑（与「开始适配」同一个执行器）
    let arc = data.clone();  // web::Data<AppState> → Arc<AppState>
    let inner: std::sync::Arc<AppState> = arc.into_inner().into();
    super::adapt_bg::spawn_adaptation(inner, run_id);

    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "message": if auto_continue {
            "已开始跑完剩余补丁，中途想停就点「中止适配」。"
        } else {
            "已继续，剩余补丁将按顺序适配。"
        }
    }))
}

/// 继续下一步：多补丁任务跑完一个补丁后会停在「待确认」，由此继续跑**下一个**。
pub async fn next_run(data: actix_web::web::Data<AppState>, path: actix_web::web::Path<String>, body: Option<actix_web::web::Json<AdaptRefreshRequest>>) -> HttpResponse {
    continue_run(data, path.into_inner(), false, body.as_deref()).await
}

/// 一键跑完剩余：从「待确认」继续，且之后每个补丁跑完都不再停下。
pub async fn next_all_run(data: actix_web::web::Data<AppState>, path: actix_web::web::Path<String>, body: Option<actix_web::web::Json<AdaptRefreshRequest>>) -> HttpResponse {
    continue_run(data, path.into_inner(), true, body.as_deref()).await
}

/// 重试失败的补丁：把状态为 failed 的补丁放回待适配队列。
///
/// 只改状态、不自动开跑：若整轮已经结束（完成/中止/失败），顺手退回「待确认」，
/// 让详情页的「继续下一步 / 一键跑完剩余」按钮重新出现——由用户决定什么时候跑。
/// 这样重试和正常的逐补丁节奏是同一条路径，不会突然自己动起来。
pub async fn retry_failed(data: actix_web::web::Data<AppState>, path: actix_web::web::Path<String>) -> HttpResponse {
    let run_id = path.into_inner();

    // 正在跑的不给动（线程正往里写状态）
    let has_running = {
        let runs = data.adapt_runs.read().unwrap();
        runs.values().any(|r| r.status == "running")
    };
    if has_running {
        return HttpResponse::Conflict().json(serde_json::json!({
            "success": false,
            "error": "已有适配任务正在执行，请等它跑完或先中止"
        }));
    }

    let moved = {
        let mut runs = data.adapt_runs.write().unwrap();
        match runs.get_mut(&run_id) {
            None => {
                return HttpResponse::NotFound().json(serde_json::json!({
                    "success": false, "error": "适配任务不存在"
                }));
            }
            Some(run) => {
                let mut moved = 0usize;
                for item in run.items.iter_mut() {
                    if item.status == "failed" {
                        item.status = "pending".to_string();
                        // 上一次失败的痕迹一并清掉，免得重跑失败时还显示上一轮的结论
                        item.note = None;
                        item.changed_files = None;
                        item.conflict_detail = None;
                        item.output_conclusion = None;
                        item.output_summary = None;
                        item.started_at = None;
                        item.finished_at = None;
                        moved += 1;
                    }
                }
                if moved > 0 && run.status != "awaiting_confirmation" {
                    run.status = "awaiting_confirmation".to_string();
                    run.finished_at = None;
                    run.report = None;
                }
                moved
            }
        }
    };
    if moved == 0 {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "success": false, "error": "没有失败的补丁可重试"
        }));
    }
    super::adapt_bg::report_and_save(&data, &run_id);
    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "message": format!("已把 {} 个失败的补丁放回队列，点「继续下一步」或「一键跑完剩余」重跑。", moved)
    }))
}

/// 删除记录：本机清单里的这条 + 服务器账本里对应的那份。
///
/// 与智能开发的「删除记录」同口径：**不删**补丁解压目录（`<cc-web目录>\temp\adapt\<runId>`）
/// 和 cc-web 会话——前者是用户资产，后者可能还要用「查看会话」看。
/// 请求体带前端的活 token（老 token 可能已过期），服务器那份用它能删得掉。
pub async fn delete_run(
    data: actix_web::web::Data<AppState>,
    path: actix_web::web::Path<String>,
    body: Option<actix_web::web::Json<AdaptRefreshRequest>>,
) -> HttpResponse {
    let run_id = path.into_inner();

    let run = {
        let runs = data.adapt_runs.read().unwrap();
        match runs.get(&run_id) {
            Some(run) => run.clone(),
            None => {
                return HttpResponse::NotFound().json(serde_json::json!({
                    "success": false, "error": "适配任务不存在"
                }));
            }
        }
    };
    if run.status == "running" {
        return HttpResponse::Conflict().json(serde_json::json!({
            "success": false,
            "error": "该任务正在执行中，请先中止再删除"
        }));
    }

    // 服务器那份：优先用前端带来的地址与 token（可能是刚登录的新 token）
    let server_url = body
        .as_ref()
        .map(|b| b.server_url.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| run.server_url.clone());
    let auth_token = body
        .as_ref()
        .map(|b| b.auth_token.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| run.auth_token.clone());
    let server_deleted = super::adapt_bg::delete_server_run(&server_url, &auth_token, &run_id);

    data.adapt_runs.write().unwrap().remove(&run_id);
    super::adapt_bg::save_adapt_runs(&data);
    log::info!("[adapt] 已删除适配记录 run={}（服务器那份删除{}）", run_id, if server_deleted { "成功" } else { "失败" });

    HttpResponse::Ok().json(serde_json::json!({
        "success": true,
        "server_deleted": server_deleted,
        "message": if server_deleted { "已删除本机记录与服务器记录。" } else { "本机记录已删除；服务器那份没删掉（补丁中心不可达或凭据无效）。" }
    }))
}

/// 补报：把本机这份 run 的当前状态，用前端带来的**当前 token** 重新推给补丁中心。
///
/// 什么时候需要：适配跑得久，JWT 过期后后台的上报一直 401，服务器账本停在旧状态
/// （比如补丁明明完成了、列表还显示 0 成功 / 详情显示适配中）。本机清单才是事实来源，
/// 页面发现本地与服务器不一致时调这个接口把差距补上，顺带把活 token 刷进去——
/// 之后后台线程自己的上报也跟着恢复。
pub async fn re_report(data: actix_web::web::Data<AppState>, path: actix_web::web::Path<String>, body: actix_web::web::Json<AdaptRefreshRequest>) -> HttpResponse {
    let run_id = path.into_inner();
    if !refresh_credentials(&data, &run_id, Some(&body)) {
        return HttpResponse::NotFound().json(serde_json::json!({
            "success": false,
            "error": "适配任务不存在（本机没有这条记录）"
        }));
    }
    super::adapt_bg::report_and_save(&data, &run_id);
    log::info!("[adapt] 已按前端带来的凭据补报 run={}", run_id);
    HttpResponse::Ok().json(serde_json::json!({ "success": true }))
}

/// 中止：分两种情形。
/// - 正在跑：只标记中止请求，当前补丁跑完后由后台线程收尾（剩余补丁标跳过）。
/// - 停在「待确认」：**没有线程在跑**，必须就地收尾，否则暂停的任务只能继续、不能放弃。
pub async fn abort_run(data: actix_web::web::Data<AppState>, path: actix_web::web::Path<String>) -> HttpResponse {
    let run_id = path.into_inner();

    // 先只读状态，再决定怎么中止（mark_remaining/finalize_run 内部自己取写锁，不能持锁调用）
    let status = {
        let runs = data.adapt_runs.read().unwrap();
        match runs.get(&run_id) {
            Some(run) => run.status.clone(),
            None => {
                return HttpResponse::NotFound().json(serde_json::json!({"success": false, "error": "适配任务不存在"}));
            }
        }
    };

    match status.as_str() {
        "running" => {
            {
                let mut runs = data.adapt_runs.write().unwrap();
                if let Some(run) = runs.get_mut(&run_id) {
                    run.abort_requested = true;
                }
            }
            HttpResponse::Ok().json(serde_json::json!({
                "success": true,
                "message": "中止请求已提交。当前正在执行的补丁会先完成，之后剩余补丁将标记为跳过。"
            }))
        }
        "awaiting_confirmation" => {
            super::adapt_bg::mark_remaining(&data, &run_id, "skipped", "用户中止");
            super::adapt_bg::finalize_run(&data, &run_id, "aborted");
            HttpResponse::Ok().json(serde_json::json!({
                "success": true,
                "message": "已中止：剩余补丁标记为跳过。"
            }))
        }
        _ => HttpResponse::BadRequest().json(serde_json::json!({
            "success": false,
            "error": "该任务不在执行中"
        })),
    }
}
