# CC-Web 2026-06-05 — 流式传输优化、实时保存与用户体验改进

## 概述

本次改动大幅优化了流式传输的实时性和一致性，修复了多个影响用户体验的 Bug，增强了文件浏览器功能，并改进了 Pi Agent 的工具参数显示。

---

## Bug 修复

### 1. Markdown 渲染：数学表达式中的 `*` 被误解析

**问题**：`**13*(12+17)*20=**` 中的 `*` 被误解析为 Markdown 斜体标记，导致显示混乱。

**根因**：原正则表达式 `\*\*([^*]+)\*\*` 会匹配任何不是 `*` 的字符，但数学表达式中的 `*`（乘号）也被当作格式符号。

**修复**：
- 加粗：改为 `\*\*((?:[^*]|\*(?!\*))*)\*\*`，允许内容中包含 `*`
- 斜体：要求内容必须包含至少一个字母，避免匹配纯数学表达式
- 添加代码块和内联代码的保护机制

**涉及文件**：`static/app.js` — `renderMarkdown()` 函数

### 2. LIVE 标志在其他电脑上残留

**问题**：在自己电脑上测试正常，但在其他电脑上 LIVE 标志可能残留不消失。

**根因**：
- 300ms 固定延迟不可靠，网络延迟差异导致竞态条件
- 浏览器可能缓存了旧版本的前端代码
- SSE 断连时无法检测

**修复**：
- 使用指数退避重试机制（100→200→400→800→1600ms）
- 添加心跳机制（后端每 15 秒发送心跳，前端 30 秒超时检测）
- 错误处理时也清除 LIVE 状态
- 添加 ETag 缓存控制，强制使用最新版本

**涉及文件**：
- `static/app.js` — `renderSessionList()`, `finishStreaming()`, `connectSSE()`, `handleStreamEvent()`
- `src/api/agent.rs` — `start_prompt()`, `switch_assistant()`, `events()`
- `src/static_files.rs` — 添加 ETag 和 Cache-Control 头

### 3. Stop 中止功能无效

**问题**：用户点击 Stop 后，前端页面确实中止了，但后台的 Agent 还是继续回答问题。

**根因**：PID 在 `stream_session()` 返回后才存储到 `running_pids`，但 `stream_session()` 是阻塞的，只有子进程结束后才返回。用户点击 Stop 时，`running_pids` 是空的，无法杀进程。

**修复**：
- 修改 `AiAssistant` trait，添加 `pid_callback` 参数
- 子进程启动后立即通过回调函数存储 PID
- 这样用户点击 Stop 时，`running_pids` 已经有 PID 了

**涉及文件**：
- `src/ai/mod.rs` — `AiAssistant` trait 添加 `pid_callback` 参数
- `src/ai/claude.rs`, `src/ai/pi.rs`, `src/ai/codex.rs` — 子进程启动后调用 `pid_callback`
- `src/api/agent.rs` — `start_prompt()`, `switch_assistant()` 传递 PID 回调

### 4. 中止后 AI 误解问题

**问题**：用户提问 "生成一篇5000字的故事"，在 AI 思考过程中点击 Stop，然后提问 "12+23"，AI 认为用户同时提出了两个请求。

**根因**：中止时，后端会话历史中仍保留被中止的用户消息。发送新问题时，后端构建历史上下文包含所有消息，AI 看到两个用户消息。

**修复**：在 `abort_session()` 中，移除被中止的用户消息（最后一个没有得到回复的用户消息）。

**涉及文件**：`src/api/agent.rs` — `abort_session()` 添加消息清理逻辑

### 5. Pi Agent 工具调用参数为空

**问题**：选择 Pi Agent 时，Read、Edit 等工具调用的 `input` 显示为空 `{}`。

**根因**：Pi Agent 会发送两个 `tool_call` 事件：
- `tool_use_start` — 包含参数（来自 `tool.arguments`）
- `tool_execution_start` — 不包含参数（`input: {}`）

后端会把两个都保存下来，导致空参数覆盖了有参数的版本。

**修复**：
- 后端事件订阅者任务中，对 `tool_call` 事件进行去重处理
- 如果已存在相同 `id` 的 `tool_use`，只有当新 `input` 不为空时才更新
- 同时从 `tool_execution_start` 的 `args` 字段读取参数

**涉及文件**：
- `src/ai/pi.rs` — `tool_execution_start` 事件使用 `args` 字段
- `src/api/agent.rs` — 事件订阅者任务添加去重逻辑

### 6. 消息重复保存

**问题**：刷新页面后，同一个问题的思考和回复结果会展示两次。

**根因**：消息被保存了两次：
- `save_event_progress` — 流式传输过程中实时保存
- `save_message` — 流式传输完成后由前端调用

两者都会 `push` 新消息，导致重复。

**修复**：修改 `save_message` 的逻辑，如果最后一条消息已经是助手消息，则更新而不是添加新消息。

**涉及文件**：`src/api/agent.rs` — `send_command()` 中的 `save_message` 处理

### 7. UTF-8 字符边界问题导致 panic

**问题**：切换助手时程序崩溃，错误信息：`end byte index 2000 is not a char boundary; it is inside '的'`。

**根因**：构建历史上下文时，用字节索引 `2000` 截断字符串，但中文字符是 3 字节一个，索引 2000 正好在中文字符中间。

**修复**：改为字符索引截断：`msg.content.chars().take(2000).collect()`。

**涉及文件**：`src/api/agent.rs` — `start_prompt()` 和 `switch_assistant()` 中的截断逻辑

### 8. Thinking 显示在答案之后

**问题**：流式传输时，Thinking 显示在答案之后，需要刷新页面才会正确显示在答案之前。

**根因**：前端流式渲染时，`thinking` 事件直接 `appendChild` 到末尾，如果 `thinking` 事件在 `chunk` 事件之后到达，就会显示在答案之后。

**修复**：在前端流式渲染时，确保 Thinking 块总是在文本块之前：
```javascript
const firstTextBlock = st.contentDiv.querySelector('.text-block');
if (firstTextBlock) {
    st.contentDiv.insertBefore(te.firstElementChild, firstTextBlock);
} else {
    st.contentDiv.appendChild(te.firstElementChild);
}
```

**涉及文件**：`static/app.js` — `handleStreamEvent()` 中的 `thinking` 事件处理

---

## 功能优化

### 9. 助手切换体验优化

**改动**：点击切换按钮后立即显示视觉反馈，而不是等待后端响应。

**流程**：
1. 点击切换按钮 → 立即显示 "⏳ Switching to 🤖 Claude..."
2. 后端返回成功 → 显示 "⏳ 🤖 Claude is starting..."
3. 收到 `start` SSE 事件 → 移除切换指示器，显示 "🤖 Claude thinking..."
4. 响应完成 → 显示 "🔄 Switched from π to 🤖 Claude"

**涉及文件**：
- `static/app.js` — `switchAssistant()` 函数
- `static/style.css` — 添加 `.switching-indicator` 样式和脉冲动画

### 10. 流式事件实时保存到后端

**改动**：后端订阅 broadcast channel，自动捕获所有流式事件并保存到会话，确保刷新页面后进度不丢失。

**架构**：
```
Agent → broadcast → 前端显示
                ↓
            EventSaver → 会话文件
```

**保存策略**：
| 事件类型 | 保存时机 |
|----------|----------|
| thinking | 立即保存 |
| tool_call | 立即保存 |
| tool_result | 立即保存 |
| chunk | 每 1 秒 |
| result | 立即保存（最终） |

**涉及文件**：`src/api/agent.rs` — 添加 `save_event_progress()` 函数和事件订阅者任务

### 11. 内存缓存提升刷新一致性

**改动**：在 AppState 中添加流式状态缓存，刷新页面时从内存读取最新状态，实现 100% 数据一致性。

**涉及文件**：
- `src/main.rs` — 添加 `StreamingState` 结构和 `streaming_state` 字段
- `src/api/agent.rs` — `save_event_progress()` 同时更新内存缓存
- `src/api/sessions.rs` — `get_session()` 优先返回缓存状态

### 12. 页面刷新自动打开最近会话

**改动**：页面加载后自动选择最近的会话，无需手动点击。

**涉及文件**：`static/app.js` — `init()` 函数末尾添加自动选择逻辑

### 13. Typing Indicator 对齐优化

**改动**：将 "Claude thinking" 或 "Pi thinking" 的显示位置与 Assistant 消息框左对齐。

**涉及文件**：`static/style.css` — `.typing-indicator` 添加 `max-width: 860px` 和 `margin: 0 auto`

### 14. 会话名称显示优化

**改动**：
- 会话名称显示第一条消息的前 40 个字符
- 超长名称自动截断并显示 "..."
- 鼠标悬浮时显示完整内容（`title` 属性）
- 有 LIVE 标志时名称自动缩短，留出空间

**涉及文件**：
- `static/app.js` — `renderSessionList()` 中的名称处理
- `static/style.css` — `.session-item.streaming .name` 添加 `max-width`

### 15. 文件浏览器增强

**改动**：
- 添加刷新按钮（🔄），点击后从磁盘重新加载文件夹内容
- AI 回答完成后自动刷新文件浏览器

**涉及文件**：
- `static/index.html` — 添加刷新按钮
- `static/app.js` — 添加 `refreshFiles()` 函数，`finishStreaming()` 中调用
- `static/style.css` — 添加 `.file-refresh-btn` 样式

---

## 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/ai/mod.rs` | Bug 修复 | `AiAssistant` trait 添加 `pid_callback` 参数 |
| `src/ai/claude.rs` | Bug 修复 | 子进程启动后调用 `pid_callback` |
| `src/ai/pi.rs` | Bug 修复 | 子进程启动后调用 `pid_callback`，`tool_execution_start` 使用 `args` 字段 |
| `src/ai/codex.rs` | Bug 修复 | 子进程启动后调用 `pid_callback` |
| `src/api/agent.rs` | Bug 修复 | LIVE 标志清理、中止消息清理、去重逻辑、UTF-8 截断、消息重复保存 |
| `src/api/agent.rs` | 功能优化 | PID 回调、事件订阅者任务、内存缓存、切换指示器 |
| `src/api/sessions.rs` | 功能优化 | `get_session()` 优先返回缓存状态 |
| `src/main.rs` | 功能优化 | 添加 `StreamingState` 结构 |
| `src/static_files.rs` | Bug 修复 | 添加 ETag 和 Cache-Control 头 |
| `static/app.js` | Bug 修复 | Markdown 渲染、LIVE 标志、Thinking 顺序、流式保存 |
| `static/app.js` | 功能优化 | 切换指示器、自动打开会话、文件浏览器刷新 |
| `static/index.html` | 功能优化 | 添加文件浏览器刷新按钮 |
| `static/style.css` | Bug 修复 | Typing Indicator 对齐、会话名称显示 |
| `static/style.css` | 功能优化 | 切换指示器动画、刷新按钮样式 |

---

## 数据流

### 流式传输与实时保存

```
用户发送消息
    ↓
POST /api/agent/{id}/start
    ↓
后端：
  1. 存储用户消息
  2. 创建 broadcast channel
  3. 启动 EventSaver 任务（订阅 channel）
  4. spawn 任务 → stream_session()
    ↓
Agent CLI (stream-json)
    ↓
逐行解析 stdout JSON → broadcast channel
    ↓
┌─────────────────────────────────────┐
│  EventSaver 任务                     │
│  - thinking → 立即保存到内存缓存     │
│  - tool_call → 立即保存到内存缓存    │
│  - chunk → 每 1 秒保存              │
│  - result → 最终保存并退出           │
└─────────────────────────────────────┘
    ↓
SSE: GET /api/agent/{id}/events
    ↓
前端 EventSource → handleStreamEvent() → 实时渲染 DOM
```

### 刷新页面恢复

```
用户刷新页面
    ↓
GET /api/sessions/{id}
    ↓
后端：
  1. 读取 session.messages（文件）
  2. 检查 streaming_state（内存缓存）
  3. 如果有缓存，合并最新状态
    ↓
返回完整消息（包括正在进行的流式内容）
    ↓
前端 renderMessagesInto() → 显示完整内容
```

### Stop 中止

```
用户点击 Stop
    ↓
POST /api/agent/{id}/abort
    ↓
后端：
  1. 从 running_pids 获取 PID（启动时已存储）
  2. taskkill /F /T /PID 杀掉进程树
  3. 清理 events_tx、streaming_sessions、streaming_state
  4. 移除被中止的用户消息
    ↓
SSE 连接断开 → 前端清理 UI 状态
```
