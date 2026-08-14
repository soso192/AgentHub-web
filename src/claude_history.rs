use crate::models::{ContentBlock, Message};
use chrono::Utc;
use std::fs;
use std::path::{Path, PathBuf};

/// 在 ~/.claude/projects/*/<sid>.jsonl 中定位 claude 会话文件。
/// sid 是全局唯一的 UUID，遍历项目子目录即可定位，规避路径编码（: → --、\\ → -）的差异问题。
pub fn find_session_file(sid: &str) -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let projects = Path::new(&home).join(".claude").join("projects");
    let entries = fs::read_dir(&projects).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let candidate = path.join(format!("{}.jsonl", sid));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 解析 claude 会话 jsonl 为 cc-web Message 列表。
///
/// 展示粒度（折中）：用户提问 + 助手回复文本 + 工具调用（tool_use / tool_result，前端默认折叠展示），
/// 不包含思考过程（thinking 块被跳过）。仅用于展示，claude 的上下文仍由 --resume 自带。
pub fn load_history(sid: &str, assistant: &str) -> Vec<Message> {
    let Some(path) = find_session_file(sid) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let now = Utc::now().timestamp_millis();
    let mut messages: Vec<Message> = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match event_type {
            "assistant" => {
                let mut blocks: Vec<ContentBlock> = Vec::new();
                let mut text_parts: Vec<String> = Vec::new();
                if let Some(arr) = event
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for block in arr {
                        match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                            "text" => {
                                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                    blocks.push(ContentBlock::Text { text: t.to_string() });
                                    text_parts.push(t.to_string());
                                }
                            }
                            "tool_use" => {
                                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
                                blocks.push(ContentBlock::ToolUse { id, name, input });
                            }
                            // thinking 块跳过：折中粒度不展示思考过程
                            _ => {}
                        }
                    }
                }
                if !blocks.is_empty() {
                    messages.push(Message {
                        role: "assistant".to_string(),
                        content: text_parts.join("\n\n"),
                        timestamp: parse_timestamp(event.get("timestamp"), now),
                        content_blocks: Some(blocks),
                        assistant: Some(assistant.to_string()),
                    });
                }
            }
            "user" => {
                // 跳过 sidechain 子会话
                if event.get("isSidechain").and_then(|v| v.as_bool()).unwrap_or(false) {
                    continue;
                }
                // 跳过 meta 消息（命令回显 / local-command-stdout / caveat 等）
                if event.get("isMeta").and_then(|v| v.as_bool()).unwrap_or(false) {
                    continue;
                }
                let Some(msg) = event.get("message") else { continue };
                let content = msg.get("content");
                if let Some(c) = content.and_then(|c| c.as_str()) {
                    // claude 注入的内部消息（命令、输出回显等）以 < 开头，非真实用户提问
                    if c.starts_with('<') || is_injected_user_message(c) {
                        continue;
                    }
                    messages.push(Message {
                        role: "user".to_string(),
                        content: c.to_string(),
                        timestamp: parse_timestamp(event.get("timestamp"), now),
                        content_blocks: None,
                        assistant: None,
                    });
                } else if let Some(arr) = content.and_then(|c| c.as_array()) {
                    // tool_result 追加到当前助手消息，保证与对应 tool_use 同一条 Message，
                    // 前端按 data-tool-id 注入到折叠的工具调用块内
                    for block in arr {
                        if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                            continue;
                        }
                        let tool_use_id = block
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let content = block
                            .get("content")
                            .map(|v| {
                                if let Some(s) = v.as_str() {
                                    s.to_string()
                                } else {
                                    v.to_string()
                                }
                            })
                            .unwrap_or_default();
                        if let Some(last) = messages.last_mut() {
                            if last.role == "assistant" {
                                if let Some(blocks) = last.content_blocks.as_mut() {
                                    blocks.push(ContentBlock::ToolResult { tool_use_id, content });
                                }
                            }
                        }
                    }
                }
            }
            // system / file-history-snapshot / summary 等事件跳过
            _ => {}
        }
    }
    messages
}

/// 识别 claude 自动注入、非用户亲发的内容（结构与真实提问一致，仅能靠内容前缀区分）：
/// - 上下文压缩摘要（长会话自动触发）
/// - 恢复会话时的既有项目上下文提示
fn is_injected_user_message(content: &str) -> bool {
    content.starts_with("This session is being continued from a previous conversation")
        || content.starts_with("When applied to an existing project, follow this sequence:")
}

fn parse_timestamp(value: Option<&serde_json::Value>, fallback: i64) -> i64 {
    if let Some(s) = value.and_then(|v| v.as_str()) {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return dt.timestamp_millis();
        }
    }
    fallback
}
