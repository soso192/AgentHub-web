//! 补丁适配：后台执行器。
//!
//! 点击「开始适配」后由 cc-web 进程在独立线程串行跑完所有补丁，浏览器可随时关闭。
//! 每个补丁跑完立即上报 patch_search（跨机器可查），并落盘 ~/.cc-web/adapt_runs.json。
//!
//! 架构：std::thread + 单线程 tokio runtime（允许 !Send 的 RwLockReadGuard 跨 .await）。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::AppState;

// ── 数据结构 ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptRun {
    pub id: String,
    pub project_dir: String,
    pub product_name: String,
    pub product_version: String,
    pub session_id: String,
    pub agent_session_id: String,
    pub items: Vec<AdaptItem>,
    /// running（适配中）/ awaiting_confirmation（一个补丁跑完、等用户在详情页点「继续下一步」）/
    /// done / failed / aborted
    pub status: String,
    pub report: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub server_url: String,
    pub auth_token: String,
    pub abort_requested: bool,
    /// 用户点了「一键跑完剩余」：跑完一个补丁不再停下来等确认，一路跑到底。
    /// 加 serde(default) 是为了兼容旧清单（缺这个字段的老记录也能读出来）。
    #[serde(default)]
    pub auto_continue: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptItem {
    pub seq: u32,
    pub patch_name: String,
    pub problem_desc: String,
    pub dir: String,
    pub status: String,
    pub changed_files: Option<String>,
    pub conflict_detail: Option<String>,
    pub note: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub output_conclusion: Option<String>,
    pub output_summary: Option<String>,
}

impl AdaptRun {
    pub fn counts(&self) -> (u32, u32, u32, u32) {
        let mut done = 0; let mut conflict = 0; let mut nosource = 0; let mut failed = 0;
        for item in &self.items {
            match item.status.as_str() {
                "done" => done += 1,
                "conflict" => conflict += 1,
                "nosource" => nosource += 1,
                "failed" => failed += 1,
                _ => {}
            }
        }
        (done, conflict, nosource, failed)
    }
}

// ── 落盘 ──

fn adapt_file_path() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".cc-web").join("adapt_runs.json"))
}

pub fn save_adapt_runs(data: &AppState) {
    let Some(path) = adapt_file_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let snapshot = data.adapt_runs.read().unwrap().clone();
    if let Ok(json) = serde_json::to_string_pretty(&snapshot) {
        let _ = std::fs::write(&path, json);
    }
}

pub fn load_adapt_runs(data: &AppState) {
    let Some(path) = adapt_file_path() else { return };
    let Ok(content) = std::fs::read_to_string(&path) else { return };
    let Ok(map) = serde_json::from_str::<HashMap<String, AdaptRun>>(&content) else { return };
    let mut map = map;
    for run in map.values_mut() {
        if run.status == "running" {
            run.status = "failed".to_string();
            run.report = Some("cc-web 重启，适配被中断".to_string());
            run.finished_at = Some(now_iso());
            for item in run.items.iter_mut() {
                match item.status.as_str() {
                    "running" => {
                        item.status = "failed".to_string();
                        item.note = Some("cc-web 重启中断".to_string());
                        item.finished_at = Some(now_iso());
                    }
                    "pending" => {
                        item.status = "skipped".to_string();
                        item.note = Some("cc-web 重启中断".to_string());
                        item.finished_at = Some(now_iso());
                    }
                    _ => {}
                }
            }
        }
    }
    *data.adapt_runs.write().unwrap() = map;
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

// ── 会话复用：在同一个 cc-web 会话上跑一轮（--resume 延续上下文）──

/// 跑一轮 claude 并收集结果。
/// `existing_agent_session_id` 非空时走 --resume，实现同一 run 内多个补丁共用上下文。
async fn run_session_turn(
    data: &AppState,
    handle: std::sync::Arc<std::sync::RwLock<Box<dyn crate::ai::AiAssistant>>>,
    session_id: &str,
    cwd: &str,
    model: &str,
    prompt: &str,
    existing_agent_session_id: Option<String>,
) -> Result<(String, Option<String>), String> {
    // 用**会话自己的**广播通道（不是私有 channel）：聊天页挂 SSE 时也能实时看到这一轮
    let Some(tx) = data.events_tx.read().unwrap().get(session_id).cloned() else {
        return Err("会话事件通道不存在（cc-web 会话未正确建立）".to_string());
    };
    let mut rx = tx.subscribe();
    let session_id_owned = session_id.to_string();
    let cwd_owned = cwd.to_string();
    let model_owned = model.to_string();
    let prompt_owned = prompt.to_string();

    // stream_session 是阻塞的（逐行读子进程 stdout），放到 blocking 线程；事件走 broadcast
    let join = tokio::task::spawn_blocking(move || {
        let assistant = handle.read().unwrap();
        assistant.stream_session(
            &session_id_owned,
            &cwd_owned,
            &model_owned,
            &prompt_owned,
            Some(&tx),
            existing_agent_session_id.as_deref(),
            None,
            None,
        )
    });

    let mut text = String::new();
    let mut new_sid: Option<String> = None;
    let mut outcome: Result<(String, Option<String>), String> = Err("会话结束但没有返回结果".to_string());
    loop {
        match rx.recv().await {
            Ok(message) => {
                let Ok(event) = serde_json::from_str::<serde_json::Value>(&message) else { continue };
                match event.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "start" => {
                        if let Some(sid) = event.get("agentSessionId").and_then(|v| v.as_str()) {
                            new_sid = Some(sid.to_string());
                        }
                    }
                    "chunk" => {
                        if let Some(part) = event.get("content").and_then(|c| c.as_str()) {
                            text.push_str(part);
                        }
                    }
                    "result" => {
                        let content = event.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
                        outcome = Ok((if content.is_empty() { text.clone() } else { content }, new_sid.clone()));
                        break;
                    }
                    "error" => {
                        outcome = Err(event.get("message").and_then(|m| m.as_str()).unwrap_or("执行出错").to_string());
                        break;
                    }
                    _ => {}
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
    let _ = join.await;
    outcome
}

// ── 提示词构建 ──

fn build_prompt(run: &AdaptRun, item: &AdaptItem) -> String {
    let total = run.items.len();
    // 结论/摘要的输出目录 = 补丁解压目录（temp\adapt\<runId>\<seq>\）
    let output_dir = &item.dir;
    format!(
        "【开始适配补丁 {}/{}】\n补丁文件：{}\n该补丁要解决的问题：{}\n补丁内容目录（已解压）：{}\n目标：把该补丁的改动合并进客开工程 {}。\n\n【对照物】**补丁包里的源码** 和 **客开工程里的源码**，把这两个直接对比就够了；\n不要把 patch_source MCP 里的标品源码当 diff 基线（那是反编译产物，拿它 diff 只会引入假「改动」）。\n唯一例外：补丁里的某个类在客开工程里**找不到**时，可以用 patch_source MCP 查该类的标品源码\n作参考（弄清它是干什么的、补丁相对标品改了什么），并在「说明」里注明参考过标品。\n\n【最关键的要求】**只合并「解决上面这个问题」所必需的那部分改动**；\n补丁里与本次问题无关的改动（其它功能、格式化、无关重构等）一律不要带进来。\n拿不准某处改动是否与本次问题相关，就在「说明」里写出来并保持不动。\n\n做法：\n1. 先判「是否已合入」：把补丁里的每个 .java 与客开工程里的对应文件直接对比（diff / md5）；\n   完全相同 → 本次无改动：按格式回「状态：完成」，改动文件写「无」，\n   说明里注明「与工程现状一致（疑似重复投递）」。\n2. 有差异才继续合并。差异里既有补丁要引入的修复、也可能混着工程自己的定制，逐处分清，\n   只把必需的那部分合进工程。\n3. 在客开工程里定位对应源码：先按类名 find 定位（不同工程布局不同：NC 模块工程里\n   hotwebs/fbip/WEB-INF/classes/x 对应 src/client/x、modules/<模块>/META-INF/classes/x 对应 src/private/x；\n   整包 war 工程里 hotwebs/fbip/WEB-INF/classes/x 对应 src/main/java/x）——\n   先看清工程实际结构再定，**别硬套某套映射**。\n   找不到该文件就是新增：可先用 patch_source MCP 查该类的标品源码作参考（若该版本已挂载），\n   再参照工程里同类文件的摆放位置新建。\n4. 工程里已被客开定制过的地方，以「保留客开定制 + 叠加补丁逻辑」为原则；\n5. 补丁里只有 .class 没有 .java 时，不要反编译，直接按下面格式回「状态：无源码」并说明；\n6. 遇到冲突不要猜着合，按下面格式回「状态：冲突」并写清冲突位置。\n\n【输出文件要求】\n本次适配完成后，在 {} 目录下写两个文件（文件名固定，不要加时间戳）：\n- 结论.md：本次适配的完整结论（改了什么、为什么这么改、有什么风险）\n- 摘要.md：对结论的简短摘要，控制在 3~5 句话\n这两个文件必须真实写盘。\n\n【回复必须以这个固定格式结尾，不要省略】\n状态：完成 / 冲突 / 无源码\n改动文件：（逐行列出，相对客开工程目录）\n冲突详情：（状态=冲突时写：哪个文件、哪一处、补丁怎么改、工程里原来是什么、为什么不能自动合）\n说明：（其余需要我知道的事；没有就写「无」）\n\n约束：只改客开工程里的源码；不要动 .git、不要执行任何 git 命令；不要反编译 jar/class；\npatch_source MCP 仅限「客开工程里找不到该类」时用来查标品源码作参考，其余情况不要用。",
        item.seq, total, item.patch_name, item.problem_desc, item.dir, run.project_dir, output_dir
    )
}

/// 读临时目录下的 结论.md / 摘要.md（读完由调用方删除）
fn read_output_files(dir: &str) -> (Option<String>, Option<String>) {
    let read_one = |name: &str| -> Option<String> {
        let path = std::path::Path::new(dir).join(name);
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                let trimmed = content.trim().to_string();
                if trimmed.is_empty() { None } else { Some(trimmed) }
            }
            Err(_) => None,
        }
    };
    let conclusion = read_one("结论.md");
    let summary = read_one("摘要.md");
    // 读完后删除临时文件（不留残留）
    for name in ["结论.md", "摘要.md"] {
        let _ = std::fs::remove_file(std::path::Path::new(dir).join(name));
    }
    (conclusion, summary)
}

// ── 结果解析（固定格式尾巴，手工解析避免引入 regex 依赖）──

const LABELS: [&str; 4] = ["状态", "改动文件", "冲突详情", "说明"];

fn pick_field(text: &str, label: &str) -> Option<String> {
    // 找到 "label:" 或 "label：" 的位置
    let mut content_start = None;
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        for sep in [":", "："] {
            let prefix = format!("{}{}", label, sep);
            if trimmed.starts_with(&prefix) {
                content_start = Some((i, trimmed[prefix.len()..].trim().to_string()));
                break;
            }
        }
        if content_start.is_some() { break; }
    }
    let Some((start_line, first_line)) = content_start else { return None };

    // 从下一行开始，读到遇到另一个标签或结束
    let mut lines: Vec<String> = Vec::new();
    if !first_line.is_empty() {
        lines.push(first_line);
    }
    for line in text.lines().skip(start_line + 1) {
        let trimmed = line.trim_start();
        let is_next_label = LABELS.iter().any(|other| {
            *other != label && {
                trimmed.starts_with(&format!("{}:", other)) || trimmed.starts_with(&format!("{}：", other))
            }
        });
        if is_next_label { break; }
        lines.push(line.to_string());
    }

    let result = lines.join("\n").trim().to_string();
    if result.is_empty() { None } else { Some(result) }
}

pub fn parse_result(text: &str) -> (String, Option<String>, Option<String>, Option<String>) {
    let status_raw = pick_field(text, "状态").unwrap_or_default();
    let status = if status_raw.contains("完成") {
        "done"
    } else if status_raw.contains("冲突") {
        "conflict"
    } else if status_raw.contains("无源码") {
        "nosource"
    } else {
        "failed"
    };
    (status.to_string(), pick_field(text, "改动文件"), pick_field(text, "冲突详情"), pick_field(text, "说明"))
}

// ── 上报 patch_search（blocking HTTP）──

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn report_run(run: &AdaptRun) {
    let (done, conflict, nosource, failed) = run.counts();
    let url = format!("{}/api/patch-adapt/runs", run.server_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "local_run_id": run.id,
        "product_name": if run.product_name.is_empty() { None } else { Some(&run.product_name) },
        "product_version": if run.product_version.is_empty() { None } else { Some(&run.product_version) },
        "code_directory": &run.project_dir,
        "status": &run.status,
        "patch_count": run.items.len(),
        "succeeded_count": done,
        "conflict_count": conflict,
        "nosource_count": nosource,
        "failed_count": failed,
        "client_host": hostname(),
        "report": &run.report,
        "started_at": &run.started_at,
        "finished_at": &run.finished_at,
    });
    let client = reqwest::blocking::Client::new();
    match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", run.auth_token))
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
    {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => log::warn!("[adapt] 上报 run 状态码: {}", resp.status()),
        Err(e) => log::warn!("[adapt] 上报 run 失败: {}", e),
    }
}

fn report_items(run: &AdaptRun) {
    let url = format!(
        "{}/api/patch-adapt/runs/{}/items",
        run.server_url.trim_end_matches('/'),
        run.id
    );
    let items: Vec<serde_json::Value> = run
        .items
        .iter()
        .map(|item| {
            serde_json::json!({
                "seq": item.seq,
                "patch_name": item.patch_name,
                "problem_desc": item.problem_desc,
                "status": item.status,
                "changed_files": item.changed_files,
                "conflict_detail": item.conflict_detail,
                "note": item.note,
                "started_at": item.started_at,
                "finished_at": item.finished_at,
                "output_conclusion": item.output_conclusion,
                "output_summary": item.output_summary,
            })
        })
        .collect();
    let client = reqwest::blocking::Client::new();
    match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", run.auth_token))
        .json(&serde_json::json!({ "items": items }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
    {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => log::warn!("[adapt] 上报 items 状态码: {}", resp.status()),
        Err(e) => log::warn!("[adapt] 上报 items 失败: {}", e),
    }
}

// ── 后台执行 ──

pub fn spawn_adaptation(data: std::sync::Arc<AppState>, run_id: String) {
    std::thread::Builder::new()
        .name(format!("adapt-{}", &run_id[..8.min(run_id.len())]))
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("[adapt] 创建 runtime 失败: {}", e);
                    return;
                }
            };
            rt.block_on(run_adaptation_loop(data, run_id));
        })
        .expect("failed to spawn adapt thread");
}

async fn run_adaptation_loop(data: std::sync::Arc<AppState>, run_id: String) {
    log::info!("[adapt] 后台适配任务启动: {}", run_id);

    // 获取 claude 助手句柄
    let handle = {
        let registry = data.registry.read().unwrap();
        registry.get_handle("claude")
    };
    let Some(handle) = handle else {
        log::error!("[adapt] ClaudeCode 不可用");
        set_run_failed(&data, &run_id, "ClaudeCode is unavailable");
        return;
    };

    // 会话 id + 补丁数 + 是否首次进入（所有补丁都还没动过）。
    // 「继续下一步」会重新起一次这个循环，启动消息只在首次推，免得重复推一条。
    let (session_id_for_init, patch_count, is_first_entry) = {
        let runs = data.adapt_runs.read().unwrap();
        runs.get(&run_id)
            .map(|r| (r.session_id.clone(), r.items.len(), r.items.iter().all(|i| i.status == "pending")))
            .unwrap_or((String::new(), 0, false))
    };
    if !session_id_for_init.is_empty() {
        // 会话事件通道只活在内存里：cc-web 重启后它没了，而会话本身（sessions.json）还在。
        // 「暂停 → 重启 cc-web → 继续下一步」这条路上必须把它补建出来，否则每一轮都会立刻
        // 失败在「会话事件通道不存在」（与 /api/agent/{id}/start 建通道是同一步骤）。
        {
            let mut channels = data.events_tx.write().unwrap();
            if !channels.contains_key(&session_id_for_init) {
                let (tx, _) = tokio::sync::broadcast::channel::<String>(1024);
                channels.insert(session_id_for_init.clone(), tx);
                log::info!("[adapt] 会话事件通道已补建（cc-web 重启后继续）: {}", session_id_for_init);
            }
        }
        if is_first_entry {
            push_session_message(
                &data,
                &session_id_for_init,
                "user",
                &format!("[补丁适配] 已启动适配任务（{} 个补丁），claude 将逐个适配。以下对话为后台自动执行的过程记录。", patch_count),
            );
        }
        // 整个 run 期间都标记为「执行中」：聊天页「查看会话」据此自动挂 SSE 看实时输出
        // （/api/sessions 的 isStreaming 来自这张表），侧边栏的 LIVE 标志也跟着亮。
        // 顺带让 start_prompt 的并发守卫挡住手动插话——适配是后台串行驱动的，
        // 用户中途插一句会打乱多补丁共用的 --resume 上下文。
        data.streaming_sessions.write().unwrap().insert(session_id_for_init.clone());
    }

    loop {
        // 检查中止
        let should_stop = {
            let runs = data.adapt_runs.read().unwrap();
            runs.get(&run_id)
                .map(|r| r.abort_requested || r.status != "running")
                .unwrap_or(true)
        };
        if should_stop {
            mark_remaining(&data, &run_id, "skipped", "用户中止");
            finalize_run(&data, &run_id, "aborted");
            break;
        }

        // 找下一个待跑的补丁
        let next = {
            let runs = data.adapt_runs.read().unwrap();
            let Some(run) = runs.get(&run_id) else { break };
            let Some(item) = run.items.iter().find(|i| i.status == "pending") else { break };
            Some((item.seq, build_prompt(run, item), run.project_dir.clone(), run.session_id.clone(), run.agent_session_id.clone()))
        };
        let Some((seq, prompt, cwd, session_id, agent_sid)) = next else { break };

        // 标记为 running 并上报
        {
            let mut runs = data.adapt_runs.write().unwrap();
            if let Some(run) = runs.get_mut(&run_id) {
                if let Some(item) = run.items.iter_mut().find(|i| i.seq == seq) {
                    item.status = "running".to_string();
                    item.started_at = Some(now_iso());
                }
            }
        }
        report_and_save(&data, &run_id);

        let name = get_item_name(&data, &run_id, seq);
        log::info!("[adapt] 开始适配补丁 #{}: {}", seq, name);

        // 会话复用：同一个 cc-web 会话 + 已有 claude 会话 id → --resume，多个补丁共用上下文
        let model = {
            let assistant = handle.read().unwrap();
            assistant.get_model(&session_id).unwrap_or_else(|| assistant.default_model().to_string())
        };
        let existing = if agent_sid.is_empty() { None } else { Some(agent_sid) };
        // 这一轮问了什么先落进会话（与 /api/agent/{id}/start 同一步骤），再起事件落盘器：
        // thinking / 工具调用 / 文本边跑边写进会话，跑到一半点「查看会话」就能看到已产出的过程，
        // 同时把 claude 会话 id 绑到会话上（--resume 的语义因此也是对的）。
        push_session_message(&data, &session_id, "user", &prompt);
        let saver = crate::api::agent::spawn_event_saver(data.clone(), session_id.clone(), "claude".to_string());
        let result = run_session_turn(&data, handle.clone(), &session_id, &cwd, &model, &prompt, existing).await;
        // 必须等落盘器收尾（它收到 result/error 就退出）：本线程用的是单线程 runtime，
        // run_adaptation_loop 返回后 runtime 就被 drop，没跑完的任务会被直接取消 → 末轮落盘会丢。
        // 超时只是兜底（正常情况下它和本轮看到的是同一个 result 事件）。
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), saver).await;

        match result {
            Ok((text, new_agent_sid)) => {
                // 记录 claude 会话 id（首次）
                if let Some(sid) = &new_agent_sid {
                    let mut runs = data.adapt_runs.write().unwrap();
                    if let Some(run) = runs.get_mut(&run_id) {
                        if run.agent_session_id.is_empty() {
                            run.agent_session_id = sid.clone();
                        }
                    }
                }
                let (status, changed, conflict, note) = parse_result(&text);
                // 读取临时目录下的 结论.md / 摘要.md（读完自动删除）
                let item_dir = get_item_dir(&data, &run_id, seq);
                let (conclusion, summary) = if let Some(dir) = &item_dir {
                    read_output_files(dir)
                } else {
                    (None, None)
                };
                {
                    let mut runs = data.adapt_runs.write().unwrap();
                    if let Some(run) = runs.get_mut(&run_id) {
                        if let Some(item) = run.items.iter_mut().find(|i| i.seq == seq) {
                            item.status = status;
                            item.changed_files = changed;
                            item.conflict_detail = conflict;
                            item.note = note;
                            item.output_conclusion = conclusion;
                            item.output_summary = summary;
                            item.finished_at = Some(now_iso());
                        }
                    }
                }
                log::info!("[adapt] 补丁 #{} 完成", seq);
            }
            Err(error) => {
                let mut runs = data.adapt_runs.write().unwrap();
                if let Some(run) = runs.get_mut(&run_id) {
                    if let Some(item) = run.items.iter_mut().find(|i| i.seq == seq) {
                        item.status = "failed".to_string();
                        item.note = Some(error.clone());
                        item.finished_at = Some(now_iso());
                    }
                }
                log::warn!("[adapt] 补丁 #{} 失败: {}", seq, error);
            }
        }
        report_and_save(&data, &run_id);

        // 还有待适配的补丁：
        //  - 手动模式（默认）→ 停下来等用户确认（详情页点「继续下一步」）
        //  - 自动模式（点过「一键跑完剩余」）→ 不停，直接接着跑下一个
        let (has_next, auto_continue) = {
            let runs = data.adapt_runs.read().unwrap();
            runs.get(&run_id)
                .map(|r| (r.items.iter().any(|i| i.status == "pending"), r.auto_continue))
                .unwrap_or((false, false))
        };
        if has_next && !auto_continue {
            {
                let mut runs = data.adapt_runs.write().unwrap();
                if let Some(run) = runs.get_mut(&run_id) {
                    run.status = "awaiting_confirmation".to_string();
                }
            }
            // 先告诉聊天页「这一轮到此为止」（它会关连接收尾），再上报 ——
            // 收尾不必等两个阻塞 HTTP 跑完，UI 能立刻落定。
            send_session_event(&data, &session_id, serde_json::json!({"type": "adapt_paused"}));
            report_and_save(&data, &run_id);
            log::info!("[adapt] 本轮补丁已跑完，等待用户确认继续（run={}）", run_id);
            // 必须在这里 break：下一轮循环开头的 should_stop 判据是 `status != "running"`，
            // 不 break 的话这次暂停会被当成"中止"，剩余补丁会被标成 skipped。
            break;
        }
    }

    // 收尾（如果不是因中止退出）
    let has_pending = {
        let runs = data.adapt_runs.read().unwrap();
        runs.get(&run_id)
            .map(|r| r.items.iter().any(|i| i.status == "pending" || i.status == "running"))
            .unwrap_or(false)
    };
    if !has_pending {
        let status = {
            let runs = data.adapt_runs.read().unwrap();
            runs.get(&run_id).map(|r| r.status.clone()).unwrap_or("done".to_string())
        };
        if status == "running" {
            finalize_run(&data, &run_id, "done");
        }
    }
    // 整轮结束：撤掉「执行中」标记与流式缓存。聊天页的「查看会话」据此收尾
    // （前端每 10s 的心跳检查会查后端 isStreaming，变 false 就关连接、清 LIVE 标志）。
    if !session_id_for_init.is_empty() {
        data.streaming_sessions.write().unwrap().remove(&session_id_for_init);
        data.streaming_state.write().unwrap().remove(&session_id_for_init);
    }
    log::info!("[adapt] 后台适配任务结束: {}", run_id);
}

fn get_item_name(data: &AppState, run_id: &str, seq: u32) -> String {
    let runs = data.adapt_runs.read().unwrap();
    runs.get(run_id)
        .and_then(|r| r.items.iter().find(|i| i.seq == seq))
        .map(|i| i.patch_name.clone())
        .unwrap_or_default()
}

fn get_item_dir(data: &AppState, run_id: &str, seq: u32) -> Option<String> {
    let runs = data.adapt_runs.read().unwrap();
    runs.get(run_id)
        .and_then(|r| r.items.iter().find(|i| i.seq == seq))
        .map(|i| i.dir.clone())
        .filter(|d| !d.is_empty())
}

// ── 把适配对话写入 cc-web 会话（聊天页「查看会话」靠这个能看到内容）──

fn push_session_message(data: &AppState, session_id: &str, role: &str, content: &str) {
    let now_ms = chrono::Utc::now().timestamp_millis();
    {
        let mut sessions = data.sessions.write().unwrap();
        if let Some(session) = sessions.get_mut(session_id) {
            session.messages.push(crate::models::Message {
                role: role.to_string(),
                content: content.to_string(),
                timestamp: now_ms,
                content_blocks: None,
                assistant: if role == "assistant" { Some("claude".to_string()) } else { None },
            });
            session.updated_at = chrono::Utc::now();
        }
    }
    crate::save_sessions_to_disk(&data.sessions.read().unwrap());
}

pub(super) fn mark_remaining(data: &AppState, run_id: &str, status: &str, reason: &str) {
    let mut runs = data.adapt_runs.write().unwrap();
    if let Some(run) = runs.get_mut(run_id) {
        for item in run.items.iter_mut() {
            if item.status == "pending" {
                item.status = status.to_string();
                item.note = Some(reason.to_string());
                item.finished_at = Some(now_iso());
            }
        }
    }
}

fn set_run_failed(data: &AppState, run_id: &str, reason: &str) {
    let session_id = {
        let mut runs = data.adapt_runs.write().unwrap();
        match runs.get_mut(run_id) {
            Some(run) => {
                run.status = "failed".to_string();
                run.report = Some(reason.to_string());
                run.finished_at = Some(now_iso());
                for item in run.items.iter_mut() {
                    if item.status == "pending" || item.status == "running" {
                        item.status = "failed".to_string();
                        item.note = Some(reason.to_string());
                        item.finished_at = Some(now_iso());
                    }
                }
                run.session_id.clone()
            }
            None => String::new(),
        }
    };
    send_session_event(data, &session_id, serde_json::json!({"type": "adapt_finished", "status": "failed"}));
    report_and_save(data, run_id);
}

pub(super) fn finalize_run(data: &AppState, run_id: &str, status: &str) {
    let session_id = {
        let mut runs = data.adapt_runs.write().unwrap();
        match runs.get_mut(run_id) {
            Some(run) => {
                run.status = status.to_string();
                run.finished_at = Some(now_iso());
                let (done, conflict, nosource, failed) = run.counts();
                let skipped = run.items.iter().filter(|i| i.status == "skipped").count();
                run.report = Some(format!(
                    "成功 {} / 冲突 {} / 无源码 {} / 失败 {} / 跳过 {}",
                    done, conflict, nosource, failed, skipped
                ));
                run.session_id.clone()
            }
            None => String::new(),
        }
    };
    // 整轮结束 → 明确告诉聊天页可以收尾了（自动模式下它一路保持着连接，见 send_session_event）
    send_session_event(data, &session_id, serde_json::json!({"type": "adapt_finished", "status": status}));
    report_and_save(data, run_id);
}

pub(super) fn report_and_save(data: &AppState, run_id: &str) {
    let run = {
        let runs = data.adapt_runs.read().unwrap();
        runs.get(run_id).cloned()
    };
    if let Some(run) = run {
        report_run(&run);
        report_items(&run);
        save_adapt_runs(data);
    }
}

/// 让补丁中心删掉这条 run 的账本（本机删记录时用）。
/// 与 report_* 同款：blocking、失败只记日志——服务器那份删不掉不该挡住本地删除。
pub(super) fn delete_server_run(server_url: &str, auth_token: &str, local_run_id: &str) -> bool {
    let url = format!(
        "{}/api/patch-adapt/runs/{}",
        server_url.trim_end_matches('/'),
        local_run_id
    );
    let client = reqwest::blocking::Client::new();
    match client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .timeout(std::time::Duration::from_secs(15))
        .send()
    {
        Ok(resp) if resp.status().is_success() => true,
        Ok(resp) => {
            log::warn!("[adapt] 删除服务器记录状态码: {}", resp.status());
            false
        }
        Err(e) => {
            log::warn!("[adapt] 删除服务器记录失败: {}", e);
            false
        }
    }
}

/// 从补丁中心把补丁包下载到本机（**流式写盘**，大补丁不占内存——库里最大有 150MB）。
///
/// 文件名优先取响应头 Content-Disposition（patch_search 保证带扩展名），回退调用方给的名字。
/// `on_progress(已下载字节, 总字节)` 每读完一个分片回调一次（总字节取自 Content-Length，可能没有）。
/// 返回 (zip 落盘路径, 落盘文件名)。失败时把半个文件删掉，不留残渣。
pub(super) fn download_patch_zip<F: FnMut(u64, Option<u64>)>(
    server_url: &str,
    auth_token: &str,
    patch_id: &str,
    dest_dir: &std::path::Path,
    fallback_name: &str,
    mut on_progress: F,
) -> Result<(std::path::PathBuf, String), String> {
    use std::io::{Read, Write};

    let url = format!(
        "{}/api/patches/{}/download",
        server_url.trim_end_matches('/'),
        patch_id
    );
    // 大补丁：超时给足（默认 15s 是给上报用的，下载不能用）
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))?;
    let mut resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .send()
        .map_err(|e| format!("连接补丁中心失败：{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "补丁中心凭据失效，请重新登录后再试".to_string(),
            404 => "补丁文件在服务器上不存在（可能已被删除）".to_string(),
            other => format!("下载补丁包失败（HTTP {other}）"),
        });
    }

    let name = header_file_name(&resp)
        .unwrap_or_else(|| fallback_name.trim().to_string());
    let name = safe_file_name(&name);
    let target = dest_dir.join(&name);
    let total = resp.content_length();
    let mut file = std::fs::File::create(&target).map_err(|e| format!("创建补丁包文件失败：{e}"))?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    loop {
        let read = match resp.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&target);
                return Err(format!("下载中断：{e}"));
            }
        };
        if read == 0 {
            break;
        }
        if let Err(e) = file.write_all(&buf[..read]) {
            drop(file);
            let _ = std::fs::remove_file(&target);
            return Err(format!("写入补丁包失败：{e}"));
        }
        downloaded += read as u64;
        on_progress(downloaded, total);
    }
    drop(file);
    Ok((target, name))
}

/// 从 Content-Disposition 里取文件名（先 filename*=UTF-8''…，再 filename="…"）。
fn header_file_name(resp: &reqwest::blocking::Response) -> Option<String> {
    let value = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)?
        .to_str()
        .ok()?;
    for part in value.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=") {
            // 形如 UTF-8''%E8%A1%A5%E4%B8%81.zip
            let encoded = rest.splitn(3, '\'').nth(2).unwrap_or("");
            if let Ok(decoded) = percent_decode(encoded) {
                if !decoded.trim().is_empty() {
                    return Some(decoded);
                }
            }
        }
    }
    for part in value.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename=") {
            let name = rest.trim().trim_matches('"').trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// 极简百分号解码（只用于文件名，够用即可）。
fn percent_decode(value: &str) -> Result<String, ()> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| ())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| ())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// 落盘文件名：只挡目录穿越与非法字符，**中文原样保留**（补丁名常是中文）。
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "patch.zip".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 往会话通道发一条**适配自己的**事件，聊天页据此决定收尾还是接着渲染。
///
/// 两类事件（见 app.js 的 handleStreamEvent）：
/// - `adapt_paused`：一个补丁跑完、停在待确认，这一轮到此为止 → 聊天页关连接
/// - `adapt_finished`：整轮适配真的结束（完成/中止/失败）→ 聊天页关连接
///
/// 为什么需要它们：聊天页收到任何 `result` 都会收尾关连接，而适配是「一个会话跑多个补丁」，
/// 必须让它能区分"这个补丁跑完了"和"整轮结束了"。自动模式（一键跑完剩余）下中间那些
/// result 之后连接要保持不断，所以只能由后端在真正的边界上明确发一条事件。
///
/// 没人在看（没有 receiver）就不发：`send_event` 会为发失败记一条 warn，
/// 而"没人在看"是常态（比如暂停态下从详情页点中止），不该刷日志。
fn send_session_event(data: &AppState, session_id: &str, event: serde_json::Value) {
    if session_id.is_empty() {
        return;
    }
    let tx = data.events_tx.read().unwrap().get(session_id).cloned();
    let Some(tx) = tx else { return };
    if tx.receiver_count() == 0 {
        return;
    }
    crate::ai::streaming::send_event(Some(&tx), event);
}
