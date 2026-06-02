# CC-Web 流式输出与助手切换 — 变更清单

## 概述

本次改动实现了两个核心功能：

1. **流式输出** — 实时显示 AI 的思考过程、工具调用、文件改动和文本输出
2. **助手切换** — 在同一会话中切换 Claude Code / Pi Agent，保留对话上下文

---

## 修改文件清单

### 后端 Rust

#### `src/ai/mod.rs` — 助手模块注册

- 注册 `pub mod pi` 模块
- 保持 `AiAssistant` trait 不变，支持多助手扩展

#### `src/ai/pi.rs` — 新增 Pi Agent 助手

- **新文件** — `PiAssistant` 结构体，实现 `AiAssistant` trait
- 通过 `npx @earendil-works/pi-coding-agent` 调用 pi-agent CLI
- 支持 `--output-format stream-json --verbose` 流式输出
- 解析 thinking / tool_use / text / tool_result / result 事件
- 默认模型：`anthropic/claude-sonnet-4-20250514`

#### `src/ai/claude.rs` — Claude 流式输出改造

- `send_message_streaming` 改用 `--output-format stream-json --verbose`
- 用 `BufReader` 逐行读取 stdout，解析 JSON 事件
- 回调事件类型：
  - `thinking` — 思考过程
  - `tool_use` — 工具调用（Bash、Edit、Read 等）
  - `tool_result` — 工具执行结果
  - `text` — 文本输出（chunk）
  - `result` — 最终结果
- 保留 `send_message`（非流式）用于兼容

#### `src/ai/types.rs` — 事件类型扩展

- `AiEventData` 枚举新增 `Thinking { thinking: String }` 变体
- 清理未使用的 `HistoryMessage` 类型

#### `src/models.rs` — 数据模型扩展

- `Message` 新增 `content_blocks: Option<Vec<ContentBlock>>` 字段
- 新增 `ContentBlock` 枚举：`Text` / `Thinking` / `ToolUse` / `ToolResult`
- 新增 `StartPromptRequest` — 发送消息请求
- 新增 `SwitchAssistantRequest` — 切换助手请求
- `Session` 新增 `history_context: Option<String>` — 切换助手时的历史上下文

#### `src/api/agent.rs` — API 端点改造

- **`new_session`** — 改为只创建会话，不发送消息；创建 broadcast channel
- **`start_prompt`**（新端点）— `POST /api/agent/{id}/start`
  - 读取并清除 `history_context`，拼接到消息前面
  - 根据 `assistant_name` 分发到 `stream_claude_session` 或 `stream_pi_session`
- **`switch_assistant`**（新端点）— `POST /api/agent/{id}/switch`
  - 构建对话历史上下文字符串
  - 更新 session 的 assistant、model、history_context
  - 添加系统消息通知
  - 清理旧助手内部会话
- **`stream_claude_session`**（新函数）— 独立的 Claude 流式函数，解析 `stream-json` 并广播事件
- **`stream_pi_session`**（新函数）— 独立的 Pi Agent 流式函数，解析 `stream-json` 并广播事件
- **`events`** — SSE 端点改用 `broadcast::channel`，支持多订阅者

#### `src/main.rs` — 路由与状态注册

- 导入并注册 `PiAssistant`
- `AppState` 新增 `events_tx: Mutex<HashMap<String, broadcast::Sender<String>>>`
- 新增路由：
  - `POST /api/agent/{id}/start` → `start_prompt`
  - `POST /api/agent/{id}/switch` → `switch_assistant`

---

### 前端

#### `static/app.js` — 流式渲染与助手切换

- **消息发送流程改造**：
  - `createSessionWithMessage`：创建会话 → 打开 SSE → 发送 prompt
  - `sendToSession`：打开 SSE → 发送 prompt
- **新增 `connectSSE()`** — EventSource 客户端，处理实时事件：
  - `start` — 显示加载状态
  - `thinking` — 渲染可折叠思考块
  - `tool_call` — 渲染工具调用块（名称 + 输入预览）
  - `tool_result` — 渲染工具结果（嵌入到对应的 tool_call 块中）
  - `chunk` — 追加文本内容
  - `result` — 完成流式渲染
  - `error` — 显示错误信息
- **新增渲染函数**：
  - `renderThinkingBlock(thinking)` — 可折叠思考块
  - `renderToolCallBlock(id, name, input)` — 可折叠工具调用块
  - `renderToolResultBlock(content)` — 工具结果块
  - `createStreamingMessage()` — 创建流式消息容器
- **助手切换**：
  - `switchAssistant()` — 调用 switch API，更新 UI
  - `updateSwitchButton()` — 根据当前助手显示/隐藏 Switch 按钮

#### `static/index.html` — UI 元素

- topbar 助手选择器旁添加 `🔄 Switch` 按钮（`id="switchAssistantBtn"`）

#### `static/style.css` — 新增样式

- `.thinking-block` — 思考块（蓝色背景，可折叠）
- `.tool-call-block` — 工具调用块（绿色背景，可折叠）
- `.tool-result-block` / `.tool-result-inline` — 工具结果（灰色背景）
- `.switch-btn` — 助手切换按钮
- `.message.system` — 系统消息（居中胶囊样式）
- `.error-block` — 错误块（红色背景）

---

## 数据流

```
用户发送消息
    ↓
POST /api/agent/{id}/start
    ↓
后端：读取 history_context → 拼接到消息 → 根据 assistant 分发
    ↓
stream_claude_session / stream_pi_session
    ↓
Claude/Pi CLI: --output-format stream-json --verbose
    ↓
逐行解析 stdout JSON → broadcast channel
    ↓
SSE: GET /api/agent/{id}/events
    ↓
前端 EventSource → handleStreamEvent() → 实时渲染 DOM
```

## 助手切换流程

```
用户点击 "🔄 Switch"
    ↓
POST /api/agent/{id}/switch { assistant: "pi" }
    ↓
后端：构建历史上下文 → 存入 session.history_context
    ↓
前端：显示 "🔄 Switched to pi" 系统消息
    ↓
用户发送下一条消息
    ↓
start_prompt：读取 history_context → 拼接到消息 → 发送给新助手
    ↓
新助手收到带完整历史上下文的消息，继续对话
```
