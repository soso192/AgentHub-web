# Changelog - 2026-06-05

## 🐛 Bug Fixes

### 1. Markdown 渲染修复 - 数学表达式中的 `*` 被误解析

**问题描述：**
- `**13*(12+17)*20=**` 中的 `*` 被误解析为 Markdown 斜体标记
- `**113*122**` 解析错误
- 列表项格式混乱

**修复方案：**
- 改进加粗正则表达式：`\*\*((?:[^*]|\*(?!\*))*)\*\*`，允许内容中包含 `*`
- 改进斜体正则表达式：要求内容必须包含至少一个字母，避免匹配纯数学表达式
- 添加代码块和内联代码的保护机制

**涉及文件：**
- `static/app.js` - `renderMarkdown()` 函数

---

### 2. LIVE 标志残留问题

**问题描述：**
- 在自己电脑上测试正常，但在其他电脑上 LIVE 标志可能残留
- 300ms 固定延迟不可靠

**修复方案：**
- 改进状态判断逻辑，检查前端 `finished` 状态
- 使用指数退避重试机制（100→200→400→800→1600ms）
- 添加心跳机制（每15秒发送心跳，30秒超时检测）
- 错误处理时也清除 LIVE 状态
- 添加 ETag 缓存控制，强制使用最新版本

**涉及文件：**
- `static/app.js` - `renderSessionList()`, `finishStreaming()`, `connectSSE()`, `handleStreamEvent()`
- `src/api/agent.rs` - `start_prompt()`, `switch_assistant()`, `events()`
- `src/static_files.rs` - 添加 ETag 和 Cache-Control 头

---

### 3. Stop 中止功能无效

**问题描述：**
- 用户点击 Stop 后，前端页面确实中止了
- 但后台的 agent 还是继续回答问题

**根本原因：**
- PID 在 `stream_session()` 返回后才存储到 `running_pids`
- 但 `stream_session()` 是阻塞的，只有子进程结束后才返回
- 所以用户点击 Stop 时，`running_pids` 是空的，无法杀进程

**修复方案：**
- 修改 `AiAssistant` trait，添加 `pid_callback` 参数
- 子进程启动后立即通过回调函数存储 PID
- 这样用户点击 Stop 时，`running_pids` 已经有 PID 了

**涉及文件：**
- `src/ai/mod.rs` - `AiAssistant` trait 添加 `pid_callback` 参数
- `src/ai/claude.rs` - 子进程启动后调用 `pid_callback`
- `src/ai/pi.rs` - 子进程启动后调用 `pid_callback`
- `src/ai/codex.rs` - 子进程启动后调用 `pid_callback`
- `src/api/agent.rs` - `start_prompt()`, `switch_assistant()` 传递 PID 回调

---

### 4. 中止后 AI 误解问题

**问题描述：**
- 用户提问 "生成一篇5000字的故事"，在 AI 思考过程中点击 Stop
- 然后提问 "12+23"，AI 认为用户同时提出了两个请求

**根本原因：**
- 中止时，后端会话历史中仍保留被中止的用户消息
- 发送新问题时，后端构建历史上下文，包含所有消息
- AI 看到两个用户消息，误认为同时提出了两个请求

**修复方案：**
- 在 `abort_session()` 中，移除被中止的用户消息（最后一个没有得到回复的用户消息）

**涉及文件：**
- `src/api/agent.rs` - `abort_session()` 添加消息清理逻辑

---

## ✨ Improvements

### 5. 助手切换体验优化

**问题描述：**
- 从 pi 切换为 claude 时，需要等待几秒才会显示 "claude thinking"
- 切换过程中没有视觉反馈

**改进方案：**
- 点击切换按钮立即显示 "⏳ Switching to 🤖 Claude..."
- 后端返回成功后显示 "⏳ 🤖 Claude is starting..."
- 收到 `start` SSE 事件后移除切换指示器，显示 "🤖 Claude thinking..."
- 添加脉冲动画效果
- 切换失败或错误时自动移除切换指示器

**涉及文件：**
- `static/app.js` - `switchAssistant()` 函数
- `static/style.css` - 添加 `.switching-indicator` 样式和动画

---

### 6. Typing Indicator 对齐优化

**问题描述：**
- "Claude thinking" 或 "Pi thinking" 显示位置与 Assistant 消息框不对齐

**改进方案：**
- 添加 `max-width: 860px` 和 `margin: 0 auto` 与 `session-view` 一致
- 设置 `padding: 12px 18px` 与 Assistant 消息框的 padding 对齐

**涉及文件：**
- `static/style.css` - `.typing-indicator` 样式修改

---

## 📝 Summary

| 类型 | 数量 |
|------|------|
| Bug Fixes | 4 |
| Improvements | 2 |
| **Total** | **6** |

## 🔧 Technical Details

### Markdown 正则表达式

```javascript
// 加粗：允许内容中包含 *（用于数学表达式）
html = html.replace(/\*\*((?:[^*]|\*(?!\*))*)\*\*/g, '<strong>$1</strong>');

// 斜体：要求内容必须包含至少一个字母
html = html.replace(/(?<!\*)\*([^*\n]*[a-zA-Z][^*\n]*)\*(?!\*)/g, '<em>$1</em>');
```

### PID 回调机制

```rust
// AiAssistant trait 添加 pid_callback 参数
fn stream_session(
    &self,
    _session_id: &str,
    _cwd: &str,
    _model: &str,
    _message: &str,
    _tx: Option<&broadcast::Sender<String>>,
    _agent_session_id: Option<&str>,
    _pid_callback: Option<Box<dyn Fn(u32) + Send>>,  // 新增
) -> StreamResult { ... }

// 子进程启动后立即调用回调
let pid = child.id();
if let Some(ref callback) = pid_callback {
    callback(pid);
}
```

### 心跳机制

```rust
// 后端：每 15 秒发送心跳
let mut heartbeat_interval = tokio::time::interval(Duration::from_secs(15));

// 前端：每 10 秒检查，30 秒无心跳则检查后端状态
state.heartbeatCheck = setInterval(async () => {
    const timeSinceHeartbeat = Date.now() - st.lastHeartbeat;
    if (timeSinceHeartbeat > 30000) {
        // 检查后端状态，如果后端已结束则强制清除
    }
}, 10000);
```
