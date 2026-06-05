# CC-Web 2026-06-04 — Bug 修复、功能优化与助手切换增强

## 概述

本次改动修复了多个影响用户体验的 Bug，优化了会话创建和模型选择流程，并重构了助手切换机制——切换时自动将对话历史发送给新助手并流式展示回复。

---

## Bug 修复

### 1. 侧边栏 LIVE 标志残留

**问题**：AI 回答结束后，侧边栏会话列表中的 🔴 LIVE 标志有时不会消失，需要刷新页面。

**根因**：前端 `finishStreaming()` 在 SSE `result` 事件到达时立即调用 `loadSessions()`，但后端的 `streaming_sessions` 清理在 `stream_session()` 返回后才执行，存在竞态条件——前端请求到达时后端尚未清理完毕。

**修复**：

- **后端 `src/api/agent.rs`**：将 `streaming_sessions.remove()` 从清理块末尾移到 `stream_session()` 返回后立即执行（`Ok` 分支内），确保前端请求到达时 `isStreaming` 已为 `false`。
- **前端 `static/app.js`**：`finishStreaming()` 中的 `loadSessions()` 用 `setTimeout(300ms)` 延迟，给后端足够的清理时间。同时将 `st._onDone` 回调和 `processSessionQueue` 也移入延迟块中。

### 2. 新建会话第一个问题不显示

**问题**：每次新建会话提问第一个问题时，用户消息、思考过程、回答结果均不显示，需要手动刷新后才能看到。刷新后继续提问第二个问题则正常。

**根因**：`createSessionWithMessage` 中 `showSessionView(data.sessionId)` 在 `addMessage(...)` 之前调用。此时新会话的 DOM 视图尚未创建（`sessionViews` Map 中无此条目），`showSessionView` 遍历 Map 找不到目标，不做任何操作。随后 `addMessage` 内部调用 `getSessionView` 创建视图，但 CSS 类 `.session-view` 默认 `display: none`，且后续无人将其覆盖为 `display: block`，导致所有内容渲染到隐藏容器中。

**修复**：交换两行顺序——`addMessage` 先创建视图并加入 Map，`showSessionView` 再找到它并设置可见。

### 3. 消息气泡对齐在不同会话中不一致

**问题**：用户消息应右对齐、AI 回复应左对齐，但在不同会话中对齐位置不一致，受消息长度影响。

**根因**：`.session-view` 只设置了 `max-width: 860px` 和 `margin: 0 auto`，没有 `width`。在 Flex 容器中，`margin: 0 auto` 的 auto margin 会覆盖 `align-items: stretch` 行为，导致元素变为内容自适应宽度——消息少的会话容器窄，消息多的会话容器宽，对齐基准不一致。

**修复**：给 `.session-view` 添加 `width: 100%`，确保始终撑满父容器可用宽度。

### 4. 切换会话后 Assistant 下拉框未同步

**问题**：在侧边栏切换不同会话时，顶部栏的 Assistant 下拉框仍显示上一个会话的助手，不会更新为当前会话正在使用的助手。

**根因**：`selectSession` 中 Assistant/Model 的同步逻辑仅在首次加载（`view.children.length === 0`）时执行，已查看过的会话不会触发更新。

**修复**：将同步逻辑移到函数开头，从 `sessions` 数组中读取当前会话的 assistant 和 model，每次切换都更新。同时调用 `loadModels()` 刷新该助手对应的模型列表，并恢复该会话正在使用的模型。

### 5. Pi Agent 切换后丢失上下文

**问题**：从 Claude 切换为 Pi 后，Pi 收不到之前的对话历史，回复 "I didn't receive the conversation context"。

**根因**：Pi Agent 通过命令行参数接收消息（`args.push(message)`），在 Windows 上包含换行符和 markdown 格式的长消息通过 `cmd.exe /C pi.cmd` 传递时格式被损坏，导致 Pi Agent 无法正确解析上下文。

**修复**：`src/ai/pi.rs` 中将消息传递方式从 CLI 参数改为 stdin（与 Claude 一致），避免 Windows 命令行转义问题。

### 6. 切换助手后第一个问题重复发送上下文

**问题**：切换助手后发送第一个问题时，消息前面会重复拼接历史上下文。

**根因**：`switch_assistant` 已通过 `stream_session` 将上下文发给新助手，但仍将 `history_context` 存在 session 上。用户发第一个问题时 `start_prompt` 又读取并拼接了 `history_context`，导致上下文重复。

**修复**：`switch_assistant` 中发送完上下文后将 `session.history_context` 设为 `None`，避免 `start_prompt` 重复拼接。

---

## 功能优化

### 7. 新建会话表单简化

**改动**：移除新建会话表单中的 AI 助手下拉框，助手由顶部栏的助手选择器决定。

**涉及文件**：
- `static/index.html` — 删除 `<select id="assistantSelect">` 表单项
- `static/app.js` — 移除 `assistantSelect` DOM 引用，`createSession` 和 `createSessionWithMessage` 使用 `currentAssistant`（来自顶部栏）

### 8. 模型列表按助手动态加载

**改动**：`GET /api/models` 支持 `?assistant=xxx` 查询参数，返回指定助手的模型列表和默认模型。前端 `loadModels()` 根据当前选中的助手拼接参数，切换助手或切换会话时模型下拉框自动更新。

**涉及文件**：
- `src/api/models.rs` — 解析查询参数，按助手名查找 handle，返回对应模型列表
- `static/app.js` — `loadModels()` 拼接 `?assistant=` 参数

### 9. 助手切换时自动发送上下文并流式展示回复

**改动**：重构助手切换流程，从"切换 → 用户手动发消息 → 新助手回复"改为"切换 → 后端自动发送历史消息 → 新助手流式回复 → 显示切换确认"。

**后端 `src/api/agent.rs`**：
- `switch_assistant` 更新会话后，构建 `context_message`（包含完整历史消息 + 确认提示）
- 创建 broadcast channel，标记会话为 streaming 状态
- spawn 异步任务调用新助手的 `stream_session`，通过 stdin 将 `context_message` 发送给新助手
- 流式事件通过 broadcast channel 推送给前端
- 流式完成后清理 streaming 状态，保存 agent session ID
- 清空 `session.history_context`，避免后续消息重复拼接上下文

**前端 `static/app.js`**：
- `switchAssistant` 切换成功后，直接调用 `connectSSE` 监听新助手的回复
- 新助手的回复通过 SSE 实时渲染（思考、工具调用、文本等）
- 回复完成后（`onDone` 回调），显示 "🔄 Switched from X to Y" 系统消息

**用户体验**：
```
Claude: 2+23 = 25
用户: [点击切换为 Pi]
Pi Agent: [阅读上下文后回复，展示思考过程和确认消息]
系统: 🔄 Switched from claude to pi
```

---

## 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/ai/pi.rs` | Bug 修复 | 消息传递从 CLI 参数改为 stdin，修复 Windows 上下文丢失 |
| `src/api/agent.rs` | Bug 修复 | LIVE 标志提前清理、切换后清空 history_context |
| `src/api/agent.rs` | 功能优化 | 切换助手时自动发送上下文并流式返回新助手回复 |
| `src/api/models.rs` | 功能优化 | 支持按助手过滤模型列表 |
| `static/app.js` | Bug 修复 | 会话视图创建顺序、LIVE 标志延迟刷新、会话切换同步 |
| `static/app.js` | 功能优化 | 移除表单助手选择、动态模型加载、切换后自动接收流式回复 |
| `static/index.html` | 功能优化 | 移除新建会话表单中的助手下拉框 |
| `static/style.css` | Bug 修复 | `.session-view` 添加 `width: 100%` 修复对齐 |

---

## 数据流

### 正常消息发送

```
用户发送消息
    ↓
POST /api/agent/{id}/start
    ↓
后端：读取 history_context → 拼接到消息 → 根据 assistant 分发
    ↓
stream_session (stdin)
    ↓
CLI: --print --output-format stream-json
    ↓
逐行解析 stdout JSON → broadcast channel
    ↓
SSE: GET /api/agent/{id}/events
    ↓
前端 EventSource → handleStreamEvent() → 实时渲染 DOM
```

### 助手切换

```
用户点击 "🔄 Switch"
    ↓
POST /api/agent/{id}/switch
    ↓
后端：
  1. 读取 session.messages → 构建 history_context
  2. 更新 session (assistant, model, agent_session_id=None)
  3. 清空 session.history_context（避免重复拼接）
  4. 创建 broadcast channel
  5. spawn 任务 → stream_session(context_message via stdin)
  6. 返回 HTTP 成功
    ↓
前端：
  1. 更新 currentAssistant / currentModel
  2. connectSSE() 监听新助手的流式回复
  3. 实时渲染新助手的回复（思考、工具、文本）
  4. 回复完成 → 显示 "🔄 Switched from X to Y"
```
