use super::{AiAssistant, types::*};
use super::streaming::{self, StreamResult};
use async_trait::async_trait;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::io::Write;
use std::sync::RwLock;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Claude Code CLI assistant implementation
pub struct ClaudeAssistant {
    // 内部锁：create/delete/set 只锁这一小块，流式（stream_session）不碰它 →
    // 外层 handle 只需读锁（可共享），建会话与并发流式互不阻塞。
    sessions: RwLock<HashMap<String, ClaudeSession>>,
    default_model: String,
    git_bash_path: Option<String>,
    claude_cmd: String,
    /// cc-web 自带的 MCP 配置（解析后的绝对路径），None 表示没配 → 不加 --mcp-config
    mcp_config_path: Option<String>,
}

struct ClaudeSession {
    cwd: String,
    model: String,
}

impl Clone for ClaudeSession {
    fn clone(&self) -> Self {
        Self {
            cwd: self.cwd.clone(),
            model: self.model.clone(),
        }
    }
}

impl ClaudeAssistant {
    pub fn new() -> Self {
        let default_model = Self::read_default_model().unwrap_or_else(|| {
            log::warn!("[claude] no settings.json found, default model set to 'unknown'");
            "unknown".to_string()
        });

        let claude_cmd = Self::find_claude_cmd();

        // 找到 git-bash 的真实路径则用它（显式设置能覆盖 claude 自己的探测）；
        // 找不到就**不设置**这个变量（None），让 claude 自己探测。以前找不到会退回
        // 字面量 "bash"，claude 拿到一个不存在的路径会直接启动失败（退出码 1、
        // 报 unable to find CLAUDE_CODE_GIT_BASH_PATH path "bash"）——设错值比不设更糟。
        let git_bash_path: Option<String> = std::env::var("CLAUDE_CODE_GIT_BASH_PATH")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .and_then(|value| {
                // 显式给的值也必须真实存在：指向不存在路径的值与字面量 "bash" 一样，
                // 会让 claude 启动即退（stderr 报 unable to find CLAUDE_CODE_GIT_BASH_PATH）。
                // 忽略坏值、落到下面的候选路径，比把它原样传下去好。
                if std::path::Path::new(&value).exists() {
                    Some(value)
                } else {
                    log::warn!("[claude] CLAUDE_CODE_GIT_BASH_PATH 指向的 {} 不存在，忽略该值", value);
                    None
                }
            })
            .or_else(|| {
                let paths = vec![
                    r"D:\Downloads\Software\Git\bin\bash.exe",
                    r"C:\Program Files\Git\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\bin\bash.exe",
                    r"C:\Program Files\Git\usr\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
                ];
                paths
                    .into_iter()
                    .find(|path| std::path::Path::new(path).exists())
                    .map(str::to_string)
            });

        let mcp_config_path = super::mcp_config::resolve_mcp_config()
            .map(|path| path.to_string_lossy().to_string());

        Self {
            sessions: RwLock::new(HashMap::new()),
            default_model,
            git_bash_path,
            claude_cmd,
            mcp_config_path,
        }
    }

    /// 给 claude 追加 MCP 参数；未配置 MCP 时返回空 vec（即照旧不加 flag）
    ///
    /// 只在这里拼一次，四处调用点都走它，避免漏掉一处导致「有的会话有 MCP、有的没有」。
    /// is_available()/version() 不用它：那两个只跑 --version 做探测，带上 flag 会去
    /// spawn MCP 子进程，又慢又可能因为 exe 没部署而失败。
    fn mcp_flags(&self) -> Vec<String> {
        match &self.mcp_config_path {
            Some(path) => vec!["--mcp-config".to_string(), path.clone()],
            None => Vec::new(),
        }
    }

    /// 查找 Claude CLI 可执行文件路径
    ///
    /// 搜索优先级：
    /// 1. CLAUDE_CMD 环境变量
    /// 2. PATH 中的 claude / claude.exe
    /// 3. npm 全局安装路径
    /// 4. 常见安装路径
    /// 5. fallback: "claude"
    fn find_claude_cmd() -> String {
        // 1. 环境变量
        if let Ok(path) = std::env::var("CLAUDE_CMD") {
            if std::path::Path::new(&path).exists() {
                log::info!("[claude] found via CLAUDE_CMD: {}", path);
                return path;
            }
        }

        // 2. npm 全局安装路径（优先检查文件是否存在，比 spawn 子进程更快）
        if let Some(home) = dirs::home_dir() {
            let npm_paths = if cfg!(target_os = "windows") {
                vec![
                    home.join("AppData").join("Roaming").join("npm").join("claude.cmd"),
                    home.join("AppData").join("Roaming").join("npm").join("claude.exe"),
                    home.join("AppData").join("Roaming").join("npm").join("claude"),
                ]
            } else {
                vec![
                    home.join(".npm-global").join("bin").join("claude"),
                    home.join(".local").join("bin").join("claude"),
                ]
            };
            for path in &npm_paths {
                if path.exists() {
                    log::info!("[claude] found at: {}", path.display());
                    return path.to_string_lossy().to_string();
                }
            }

            // 3. node_modules 全局安装（通过 node + cli.js 调用）
            let global_node_modules = home.join("AppData").join("Roaming").join("npm").join("node_modules");
            if global_node_modules.exists() {
                let claude_cli = global_node_modules.join("@anthropic-ai").join("claude-code").join("cli.js");
                if claude_cli.exists() {
                    log::info!("[claude] found via node_modules: {}", claude_cli.display());
                    return format!("node:{}", claude_cli.to_string_lossy());
                }
            }

            // 4. Linux/macOS 常见路径
            let common_paths = vec![
                "/usr/local/bin/claude",
                "/usr/bin/claude",
            ];
            for path in &common_paths {
                if std::path::Path::new(path).exists() {
                    log::info!("[claude] found at: {}", path);
                    return path.to_string();
                }
            }
        }

        // 5. 尝试 PATH 中直接运行（spawn 子进程检测，放最后）
        // Windows 上需要分别尝试 claude、claude.cmd、claude.exe
        if cfg!(target_os = "windows") {
            for name in &["claude.cmd", "claude.exe", "claude"] {
                if Command::new("cmd.exe").arg("/C").arg(name).arg("--version")
                    .stdout(Stdio::null()).stderr(Stdio::null())
                    .output().map(|o| o.status.success()).unwrap_or(false)
                {
                    log::info!("[claude] found in PATH as: {}", name);
                    return name.to_string();
                }
            }
        } else {
            if Command::new("claude").arg("--version")
                .stdout(Stdio::null()).stderr(Stdio::null())
                .output().map(|o| o.status.success()).unwrap_or(false)
            {
                log::info!("[claude] found in PATH");
                return "claude".to_string();
            }
        }

        log::warn!("[claude] not found, falling back to 'claude'");
        "claude".to_string()
    }

    /// 创建 Claude 命令（处理 node: 前缀和 .cmd 文件）
    fn create_claude_command(&self) -> Command {
        if self.claude_cmd.starts_with("node:") {
            let cli_js = &self.claude_cmd[5..];
            let mut cmd = Command::new("node");
            cmd.arg(cli_js);
            cmd
        } else if self.claude_cmd.ends_with(".cmd") && cfg!(target_os = "windows") {
            let mut cmd = Command::new("cmd.exe");
            cmd.arg("/C").arg(&self.claude_cmd);
            cmd
        } else {
            Command::new(&self.claude_cmd)
        }
    }

    fn read_default_model() -> Option<String> {
        let settings_path = dirs::home_dir()?.join(".claude").join("settings.json");
        let content = std::fs::read_to_string(settings_path).ok()?;
        let settings: serde_json::Value = serde_json::from_str(&content).ok()?;

        settings.get("env")
            .and_then(|e| e.get("ANTHROPIC_MODEL"))
            .and_then(|m| m.as_str())
            .map(String::from)
            .or_else(|| {
                settings.get("model")
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
    }

    /// 从 ~/.claude/settings.json 的环境变量中提取模型列表
    ///
    /// Claude 不像 Pi/Codex 那样有模型发现文件，但 settings.json 的 env 字段中
    /// 会记录用户配置的各层级模型（Haiku/Sonnet/Opus 以及自定义模型）。
    /// 收集这些模型作为可选列表。
    fn discover_models_from_settings() -> Option<Vec<ModelInfo>> {
        let settings_path = dirs::home_dir()?.join(".claude").join("settings.json");
        let content = std::fs::read_to_string(settings_path).ok()?;
        let settings: serde_json::Value = serde_json::from_str(&content).ok()?;

        let mut model_ids = Vec::new();

        // 从环境变量中收集各层级模型
        if let Some(env) = settings.get("env").and_then(|e| e.as_object()) {
            let keys = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                        "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"];
            for key in &keys {
                if let Some(val) = env.get(*key).and_then(|v| v.as_str()) {
                    let trimmed = val.trim();
                    if !trimmed.is_empty() && !model_ids.contains(&trimmed.to_string()) {
                        model_ids.push(trimmed.to_string());
                    }
                }
            }
        }

        // 从 model 字段读取层级名（如 "opus"），也作为一个选项
        if let Some(m) = settings.get("model").and_then(|m| m.as_str()) {
            let trimmed = m.trim();
            if !trimmed.is_empty() && !model_ids.contains(&trimmed.to_string()) {
                model_ids.push(trimmed.to_string());
            }
        }

        if model_ids.is_empty() { return None; }

        Some(model_ids.into_iter().map(|id| ModelInfo {
            id: id.clone(),
            name: id,
            provider: "anthropic".to_string(),
            max_tokens: Some(200000),
            supports_streaming: true,
            supports_tools: true,
        }).collect())
    }
}

/// 判断一条 assistant 文本消息是否只是「后台任务通知」到来后的短收尾语。
/// 判定规则：消息本身较短(<300 字符)，且其前一条非空消息是 user 的 <task-notification>。
fn is_trailing_ack(seq: &[(bool, bool, String)], idx: usize) -> bool {
    if seq[idx].2.trim().chars().count() >= 300 {
        return false;
    }
    let mut j = idx;
    while j > 0 {
        j -= 1;
        let (is_assistant, is_task_notification, text) = &seq[j];
        if text.trim().is_empty() {
            continue;
        }
        if *is_assistant {
            return false; // 前面是另一条 assistant 消息，不是针对后台通知的收尾
        }
        return *is_task_notification;
    }
    false
}

/// `claude --print` 只返回最后一次 assistant 文本消息。若会话中途启动过后台 Bash
/// （run_in_background），其 <task-notification> 会在主交付结果产出之后才注入会话，
/// claude 会追加一条短收尾语，导致 --print 拿到的是收尾而不是真正的主交付内容。
/// 这里读取本次运行对应的项目会话 jsonl，跳过这类收尾，返回最后一个实质结果。
fn read_substantive_result(cwd: &str) -> Option<String> {
    // cwd -> 会话目录 slug，如 D:\patch-patches -> D--patch-patches
    let mut normalized = cwd.to_string();
    if let Some(stripped) = normalized.strip_prefix(r"\\?\") {
        normalized = stripped.to_string();
    } else if let Some(stripped) = normalized.strip_prefix(r"\\.\") {
        normalized = stripped.to_string();
    }
    let slug: String = normalized.replace([':', '\\', '/'], "-");
    let project_dir = dirs::home_dir()?.join(".claude").join("projects").join(slug);
    let entries = std::fs::read_dir(project_dir).ok()?;
    let mut latest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            if let Ok(modified) = metadata.modified() {
                if latest.as_ref().map_or(true, |(time, _)| modified > *time) {
                    latest = Some((modified, path));
                }
            }
        }
    }
    let (_, path) = latest?;
    let content = std::fs::read_to_string(path).ok()?;

    // 按顺序收集非空条目：(is_assistant, is_task_notification_user, text)
    let mut seq: Vec<(bool, bool, String)> = Vec::new();
    for line in content.lines() {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        if value.get("type").and_then(|v| v.as_str()) != Some("user")
            && value.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(message) = value.get("message") else { continue };
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let content = message.get("content");
        if role == "assistant" {
            let mut text = String::new();
            if let Some(blocks) = content.and_then(|c| c.as_array()) {
                for block in blocks {
                    if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                            text.push_str(t);
                        }
                    }
                }
            }
            if !text.trim().is_empty() {
                seq.push((true, false, text));
            }
        } else if role == "user" {
            let raw = match content {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Array(blocks)) => {
                    let mut parts = Vec::new();
                    for block in blocks {
                        if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                            parts.push("__tool_result__".to_string());
                        } else if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                            parts.push(t.to_string());
                        }
                    }
                    parts.join("\n")
                }
                _ => String::new(),
            };
            if !raw.trim().is_empty() {
                let is_task_notification = raw.contains("<task-notification>");
                seq.push((false, is_task_notification, raw));
            }
        }
    }

    let mut idx = seq.len();
    while idx > 0 {
        idx -= 1;
        let (is_assistant, _, text) = &seq[idx];
        if !is_assistant || text.trim().is_empty() {
            continue;
        }
        if is_trailing_ack(&seq, idx) {
            continue;
        }
        return Some(text.trim().to_string());
    }
    None
}

#[async_trait]
impl AiAssistant for ClaudeAssistant {
    fn name(&self) -> &str {
        "claude"
    }

    fn display_name(&self) -> &str {
        "Claude Code"
    }

    fn available_models(&self) -> Vec<ModelInfo> {
        // 优先从 settings.json 的环境变量中读取模型列表
        if let Some(models) = ClaudeAssistant::discover_models_from_settings() {
            return models;
        }
        // 没有 settings.json，用 "unknown" 兜底
        vec![
            ModelInfo {
                id: "unknown".to_string(),
                name: "Unknown".to_string(),
                provider: "anthropic".to_string(),
                max_tokens: None,
                supports_streaming: true,
                supports_tools: true,
            },
        ]
    }

    async fn execute_once(&self, system_prompt: &str, user_prompt: &str, cwd: &str, model: Option<&str>) -> Result<String, String> {
        let (text, _) = self.execute_once_with_session(system_prompt, user_prompt, cwd, model).await?;
        Ok(text)
    }

    /// 与 execute_once 相同的一次性执行，但额外捕获本次 claude CLI 进程自身的
    /// `system/init` 事件里的 session_id，用于后续 `--resume`。
    /// 会话 id 来自本进程的 stream-json 输出，与工作目录下其他会话互不影响，无歧义。
    async fn execute_once_with_session(&self, system_prompt: &str, user_prompt: &str, cwd: &str, model: Option<&str>) -> Result<(String, Option<String>), String> {
        let prompt = format!("[System Prompt]\n{}\n\n[User Prompt]\n{}", system_prompt, user_prompt);
        let cwd_str = cwd.to_string();
        let cwd = std::path::PathBuf::from(cwd);
        if !cwd.is_dir() {
            return Err("working directory does not exist".to_string());
        }
        let selected_model = model.filter(|value| !value.trim().is_empty()).unwrap_or(&self.default_model).to_string();
        let git_bash = self.git_bash_path.clone();
        let claude_cmd = self.claude_cmd.clone();
        let mcp_flags = self.mcp_flags();
        tokio::task::spawn_blocking(move || {
            let mut args = vec![
                "--print", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model",
                selected_model.as_str(),
            ];
            args.extend(mcp_flags.iter().map(|value| value.as_str()));
            let mut cmd = if claude_cmd.starts_with("node:") {
                let mut command = Command::new("node");
                command.arg(&claude_cmd[5..]);
                command
            } else if claude_cmd.ends_with(".cmd") && cfg!(target_os = "windows") {
                let mut command = Command::new("cmd.exe");
                command.arg("/C").arg(&claude_cmd);
                command
            } else {
                Command::new(&claude_cmd)
            };
            cmd.args(args).current_dir(&cwd);
            // 只有确实找到真实路径才设 CLAUDE_CODE_GIT_BASH_PATH，否则留给 claude 自己探测
            // （设一个不存在的路径——以前退回字面量 "bash"——会让 claude 启动即失败）
            if let Some(git_bash) = &git_bash {
                cmd.env("CLAUDE_CODE_GIT_BASH_PATH", git_bash);
            }
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = cmd.spawn().map_err(|error| format!("failed to start ClaudeCode: {}", error))?;
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(prompt.as_bytes()).map_err(|error| format!("failed to send prompt: {}", error))?;
            }
            // stderr 单独线程攒起来：claude 启动即失败时原因都在 stderr，不读就只能看到
            // "退出码 1、没有输出"（与 stream_session 同一个坑，这里一并修掉）
            let stderr_holder: std::sync::Arc<std::sync::Mutex<String>> = std::sync::Arc::default();
            let stderr_thread = {
                let stderr = child.stderr.take().expect("stderr should be piped");
                let holder = std::sync::Arc::clone(&stderr_holder);
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut text = String::new();
                    let _ = std::io::BufReader::new(stderr).take(64 * 1024).read_to_string(&mut text);
                    if !text.trim().is_empty() {
                        *holder.lock().unwrap() = text.trim().to_string();
                    }
                })
            };
            let stdout = child.stdout.take().expect("stdout should be piped");
            let reader = std::io::BufReader::new(stdout);
            use std::io::BufRead;

            let mut agent_session_id: Option<String> = None;
            let mut result_text: Option<String> = None;
            let mut error_text: Option<String> = None;

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
                        if let Some(sid) = event.get("session_id").and_then(|s| s.as_str()) {
                            agent_session_id = Some(sid.to_string());
                            log::debug!("[claude] execute_once_with_session: session_id={}", sid);
                        }
                    }
                    "result" => {
                        let text = event.get("result").and_then(|r| r.as_str()).unwrap_or("");
                        let is_error = event.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                        if is_error {
                            error_text = Some(text.to_string());
                        } else {
                            result_text = Some(text.to_string());
                        }
                    }
                    _ => {}
                }
            }

            let _ = child.wait();
            let _ = stderr_thread.join();
            let stderr_note = stderr_holder.lock().map(|text| text.trim().to_string()).unwrap_or_default();

            if let Some(err) = error_text {
                return Err(if stderr_note.is_empty() { err } else { format!("{err}（stderr: {stderr_note}）") });
            }
            // result 事件为空时（如中途后台任务通知后的收尾语），退回读取会话 jsonl 的实质结果
            let result = result_text
                .filter(|text| !text.trim().is_empty())
                .map(|text| text.trim().to_string())
                .or_else(|| read_substantive_result(&cwd_str));
            match result {
                Some(text) => Ok((text, agent_session_id)),
                None => Err(if stderr_note.is_empty() {
                    "ClaudeCode produced no output".to_string()
                } else {
                    format!("ClaudeCode produced no output（stderr: {stderr_note}）")
                }),
            }
        }).await.map_err(|error| format!("task error: {}", error))?
    }

    fn default_model(&self) -> &str {
        &self.default_model
    }

    async fn create_session(&self, cwd: String, model: Option<String>) -> Result<String, String> {
        let session_id = Uuid::new_v4().to_string();
        let model = model.unwrap_or_else(|| self.default_model.clone());

        self.sessions.write().unwrap().insert(session_id.clone(), ClaudeSession {
            cwd,
            model,
        });

        Ok(session_id)
    }

    async fn send_message(&self, session_id: &str, message: &str) -> Result<AiResponse, String> {
        let session = self.sessions.read().unwrap().get(session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?;

        let cwd = session.cwd.clone();
        let model = session.model.clone();
        let message = message.to_string();
        let git_bash = self.git_bash_path.clone();
        let claude_cmd = self.claude_cmd.clone();
        let mcp_flags = self.mcp_flags();

        let result = tokio::task::spawn_blocking(move || {
            let mut args = vec![
                "--print".to_string(),
                "--output-format".to_string(),
                "text".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--model".to_string(),
                model.clone(),
            ];
            args.extend(mcp_flags);

            let mut cmd = Command::new(&claude_cmd);
            cmd.args(&args).current_dir(&cwd);
            // 只有确实找到真实路径才设 CLAUDE_CODE_GIT_BASH_PATH，否则留给 claude 自己探测
            if let Some(git_bash) = &git_bash {
                cmd.env("CLAUDE_CODE_GIT_BASH_PATH", git_bash);
            }
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = cmd.spawn()
                .map_err(|e| format!("Failed to start Claude: {}", e))?;

            if let Some(mut stdin) = child.stdin.take() {
                let msg = message.clone();
                std::thread::spawn(move || {
                    let _ = stdin.write_all(msg.as_bytes());
                });
            }

            let output = child.wait_with_output()
                .map_err(|e| format!("Claude process error: {}", e))?;

            if output.status.success() {
                String::from_utf8(output.stdout)
                    .map(|s| s.trim().to_string())
                    .map_err(|e| format!("Invalid UTF-8: {}", e))
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("Claude error: {}", stderr))
            }
        })
        .await
        .map_err(|e| format!("Task error: {}", e))?;

        let content = result?;

        Ok(AiResponse {
            content,
            model: session.model.clone(),
            usage: None,
            metadata: None,
        })
    }

    async fn send_message_streaming(
        &self,
        session_id: &str,
        message: &str,
        callback: Box<dyn Fn(AiEvent) + Send>,
    ) -> Result<(), String> {
        let session = self.sessions.read().unwrap().get(session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?;

        let message = message.to_string();
        let cwd = session.cwd.clone();
        let model = session.model.clone();
        let git_bash = self.git_bash_path.clone();
        let claude_cmd = self.claude_cmd.clone();
        let mcp_flags = self.mcp_flags();

        callback(AiEvent {
            event_type: "start".to_string(),
            data: AiEventData::Start {
                session_id: session_id.to_string(),
                model: model.clone(),
            },
        });

        tokio::task::spawn_blocking(move || {
            let mut args = vec![
                "--print".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "--model".to_string(),
                model.clone(),
            ];
            args.extend(mcp_flags);

            let mut cmd = Command::new(&claude_cmd);
            cmd.args(&args).current_dir(&cwd);
            // 只有确实找到真实路径才设 CLAUDE_CODE_GIT_BASH_PATH，否则留给 claude 自己探测
            if let Some(git_bash) = &git_bash {
                cmd.env("CLAUDE_CODE_GIT_BASH_PATH", git_bash);
            }
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    callback(AiEvent {
                        event_type: "error".to_string(),
                        data: AiEventData::Error {
                            message: format!("Failed to start Claude: {}", e),
                        },
                    });
                    return;
                }
            };

            if let Some(mut stdin) = child.stdin.take() {
                let msg = message.clone();
                let _ = stdin.write_all(msg.as_bytes());
            }

            let stdout = child.stdout.take().expect("stdout should be piped");
            let reader = std::io::BufReader::new(stdout);
            use std::io::BufRead;

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        callback(AiEvent {
                            event_type: "error".to_string(),
                            data: AiEventData::Error {
                                message: format!("Read error: {}", e),
                            },
                        });
                        return;
                    }
                };

                let event: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match event_type {
                    "assistant" => {
                        if let Some(message_obj) = event.get("message") {
                            if let Some(content_arr) = message_obj.get("content").and_then(|c| c.as_array()) {
                                for block in content_arr {
                                    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                    match block_type {
                                        "thinking" => {
                                            if let Some(thinking_text) = block.get("thinking").and_then(|t| t.as_str()) {
                                                callback(AiEvent {
                                                    event_type: "thinking".to_string(),
                                                    data: AiEventData::Thinking {
                                                        thinking: thinking_text.to_string(),
                                                    },
                                                });
                                            }
                                        }
                                        "tool_use" => {
                                            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                                            let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
                                            callback(AiEvent {
                                                event_type: "tool_call".to_string(),
                                                data: AiEventData::ToolCall { id, name, input },
                                            });
                                        }
                                        "text" => {
                                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                                callback(AiEvent {
                                                    event_type: "chunk".to_string(),
                                                    data: AiEventData::Chunk {
                                                        content: text.to_string(),
                                                        accumulated: text.to_string(),
                                                    },
                                                });
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
                                        let tool_use_id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let content = block.get("content").map(|c| {
                                            if let Some(s) = c.as_str() { s.to_string() }
                                            else { c.to_string() }
                                        }).unwrap_or_default();
                                        callback(AiEvent {
                                            event_type: "tool_result".to_string(),
                                            data: AiEventData::ToolResult { id: tool_use_id, output: content },
                                        });
                                    }
                                }
                            }
                        }
                    }
                    "result" => {
                        let result_text = event.get("result").and_then(|r| r.as_str()).unwrap_or("");
                        let is_error = event.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);

                        if is_error {
                            callback(AiEvent {
                                event_type: "error".to_string(),
                                data: AiEventData::Error {
                                    message: result_text.to_string(),
                                },
                            });
                        } else {
                            callback(AiEvent {
                                event_type: "end".to_string(),
                                data: AiEventData::End {
                                    response: AiResponse {
                                        content: result_text.to_string(),
                                        model: model.clone(),
                                        usage: None,
                                        metadata: None,
                                    },
                                },
                            });
                        }
                    }
                    _ => {}
                }
            }

            let _ = child.wait();
        });

        Ok(())
    }

    fn set_model(&self, session_id: &str, model: &str) -> Result<(), String> {
        if let Some(session) = self.sessions.write().unwrap().get_mut(session_id) {
            session.model = model.to_string();
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    fn get_model(&self, session_id: &str) -> Option<String> {
        self.sessions.read().unwrap().get(session_id).map(|s| s.model.clone())
    }

    fn delete_session(&self, session_id: &str) {
        self.sessions.write().unwrap().remove(session_id);
    }

    fn stream_session(
        &self,
        session_id: &str,
        cwd: &str,
        model: &str,
        message: &str,
        tx: Option<&broadcast::Sender<String>>,
        existing_agent_session_id: Option<&str>,
        pid_callback: Option<Box<dyn Fn(u32) + Send>>,
        on_result_callback: Option<Box<dyn Fn() + Send>>,
    ) -> StreamResult {
        log::info!("[claude] stream_session: session={}, model={}, resume={:?}", session_id, model, existing_agent_session_id);

        let mut args = vec![
            "--print".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
            "--model".to_string(),
            model.to_string(),
        ];

        if let Some(resume_id) = existing_agent_session_id {
            args.push("--resume".to_string());
            args.push(resume_id.to_string());
        }

        args.extend(self.mcp_flags());

        let mut cmd = self.create_claude_command();
        cmd.args(&args).current_dir(cwd);
        // 只有确实找到真实路径才设 CLAUDE_CODE_GIT_BASH_PATH，否则留给 claude 自己探测
        if let Some(git_bash) = &self.git_bash_path {
            cmd.env("CLAUDE_CODE_GIT_BASH_PATH", git_bash);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                log::error!("[claude] failed to spawn: {}", e);
                streaming::send_event(tx, serde_json::json!({
                    "type": "error",
                    "message": format!("Failed to start Claude: {}", e)
                }));
                return StreamResult { agent_session_id: None, pid: None, result_sent: false };
            }
        };

        let pid = child.id();
        log::info!("[claude] process spawned, pid={}", pid);

        if let Some(ref callback) = pid_callback {
            callback(pid);
        }

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(message.as_bytes());
            let _ = stdin.flush();
        }

        // stderr 单独起一个线程攒起来（最多 64KB）：claude 启动即失败时真正的报错
        // 都写在 stderr。以前只设了 Stdio::piped() 却从不读——管道没人消费，日志里
        // 只能看到"退出码 1、0 行输出"，等于把失败原因直接扔了。
        let stderr_holder: std::sync::Arc<std::sync::Mutex<String>> = std::sync::Arc::default();
        let stderr_thread = {
            let stderr = child.stderr.take().expect("stderr should be piped");
            let holder = std::sync::Arc::clone(&stderr_holder);
            std::thread::spawn(move || {
                use std::io::Read;
                let mut text = String::new();
                let _ = std::io::BufReader::new(stderr).take(64 * 1024).read_to_string(&mut text);
                if !text.trim().is_empty() {
                    *holder.lock().unwrap() = text.trim().to_string();
                }
            })
        };

        let stdout = child.stdout.take().expect("stdout should be piped");
        let reader = std::io::BufReader::new(stdout);
        use std::io::BufRead;

        let mut agent_session_id: Option<String> = None;
        let mut line_count = 0;
        let mut callback_called = false;
        // claude 的 API 级报错（system/api_error，如供应商被删后的 503）只出现在 stdout 事件流里；
        // 重试耗尽后它常常**不发 result 终态事件**直接退出——前端就永远收不到终态，
        // 智能开发这轮会被对账落成普通「待判定」，报错被吞。记下最后一次的报错文本，
        // 循环结束仍无终态时用它补发 error 事件（见循环后的兜底）。
        let mut last_api_error: Option<String> = None;

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    log::error!("[claude] read error: {}", e);
                    continue;
                }
            };
            line_count += 1;

            let (sid, result_sent) = streaming::process_stream_line(&line, session_id, model, tx);
            if let Some(sid) = sid {
                agent_session_id = Some(sid);
            }
            if result_sent && !callback_called {
                callback_called = true;
                if let Some(ref callback) = on_result_callback {
                    log::debug!("[claude] result sent, calling on_result_callback");
                    callback();
                }
            }
            if !result_sent && line.contains("\"api_error\"") {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                    let err = event.get("error");
                    let text = err
                        .and_then(|e| e.get("formatted")).and_then(|v| v.as_str())
                        .or_else(|| err.and_then(|e| e.get("message")).and_then(|v| v.as_str()))
                        .map(|s| s.to_string());
                    if let Some(t) = text {
                        last_api_error = Some(t);
                    }
                }
            }
        }

        let exit_status = child.wait();
        // 进程退出后 stderr 也到 EOF，攒下来的就是它退出的真正原因（如果有）
        let _ = stderr_thread.join();
        log::info!("[claude] stream loop ended, {} lines, exit={:?}", line_count, exit_status);
        if let Ok(stderr_text) = stderr_holder.lock() {
            if !stderr_text.is_empty() {
                log::warn!("[claude] stderr: {}", *stderr_text);
            }
        }

        // 兜底终态：claude 从未发出终态事件（result/error）就退出时，补发一个 error 事件，
        // 否则前端收不到任何终态、页面永远停在"执行中"。两类触发：
        // 1) 流里见过 api_error（如网关 503，重试耗尽后 claude 常常不发 result 直接退）；
        // 2) 一行 stdout 都没有就退出 = 启动即失败，真实原因在 stderr（典型：
        //    CLAUDE_CODE_GIT_BASH_PATH 指向不存在的路径、未登录、参数不合法）。
        //    以前这种情况日志只剩"退出码 1、0 行"，前端则表现为彻底没反应。
        // 正常完成（result 已发）不受影响；用户中断（taskkill）发生时通常已有输出，也不受影响。
        if !callback_called {
            let fallback_message: Option<String> = if let Some(err) = last_api_error {
                Some(format!("API Error: {}", err))
            } else if line_count == 0 {
                let exit_code = exit_status
                    .as_ref()
                    .ok()
                    .and_then(|status| status.code())
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                let stderr_text = match stderr_holder.lock() {
                    Ok(text) if !text.is_empty() => text.clone(),
                    _ => "(stderr 无输出)".to_string(),
                };
                Some(format!("Claude 启动即退出（exit code {}）：{}", exit_code, stderr_text))
            } else {
                None
            };

            if let Some(message) = fallback_message {
                log::warn!("[claude] exited without terminal event, emitting fallback error event");
                streaming::send_event(tx, serde_json::json!({
                    "type": "error",
                    "message": message
                }));
                if let Some(ref callback) = on_result_callback {
                    callback();
                }
            }
        }

        StreamResult { agent_session_id, pid: Some(pid), result_sent: false }
    }

    async fn is_available(&self) -> bool {
        let mut cmd = self.create_claude_command();
        cmd.args(&["--version"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        tokio::task::spawn_blocking(move || {
            cmd.output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false)
    }

    async fn version(&self) -> Option<String> {
        let mut cmd = self.create_claude_command();
        cmd.args(&["--version"]);
        tokio::task::spawn_blocking(move || {
            cmd.output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|v| v.trim().to_string())
        })
        .await
        .unwrap_or(None)
    }
}
