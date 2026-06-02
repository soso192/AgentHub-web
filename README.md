# CC-Web

> 统一的 AI 编程助手 Web 平台 — 一个界面管理所有 AI Agent

**CC-Web** 是一个高性能的 Web 平台，让你在浏览器中统一管理和使用多种 AI 编程助手（Claude Code、Pi Agent、Codex 等）。支持实时流式输出、会话持久化、Agent 无缝切换、消息队列等企业级特性。

---

## ✨ 核心特性

### 🤖 多 Agent 统一管理
- **Claude Code** — Anthropic 的 CLI 编程助手
- **Pi Agent** — Pi Coding Agent
- **OpenAI Codex** — OpenAI 的编程助手
- 同一平台自由切换，无需多个终端窗口

### 🔄 实时流式输出
- **思考过程**（Thinking）— 可折叠展示 AI 的推理过程
- **工具调用**（Tool Calls）— 实时显示 Bash 命令、文件读写、代码编辑等操作
- **工具结果**（Tool Results）— 即时展示命令执行输出
- **文本流**（Text Stream）— 逐字输出 AI 回复

### 🔀 Agent 无缝切换
- 在同一会话中切换不同 Agent，**对话上下文自动保留**
- 切换时自动构建历史摘要，新 Agent 无缝继续对话
- 每条消息标记生成它的 Agent，切换后历史消息标签不变

### 💾 会话持久化
- 所有会话自动保存到 `~/.cc-web/sessions.json`
- **重启后会话不丢失**，包括完整的聊天记录和 content blocks
- Claude Agent 支持 `--resume` 原生会话恢复
- Pi Agent 支持 `--session` 原生会话恢复

### ⏹ 中止 & 消息队列
- **Stop 按钮** — 随时中止正在运行的 Agent
- **消息队列** — Agent 工作时继续输入，消息自动排队
- 队列状态实时显示（`📨 N message(s) queued`）

### 📁 内置文件浏览器
- 侧边栏文件树，实时浏览工作目录
- 点击文件弹出代码预览（深色主题）
- 支持目录导航、文件图标、大小显示

### 🎨 现代化 UI
- 深色代码块、Markdown 渲染、表格支持
- 可折叠的思考/工具调用块
- 响应式布局，移动端友好
- 流式输出时的实时动画

---

## 💡 实际使用场景

### 场景 1：远程开发 — 用手机/平板写代码
在你的工作站上运行 `cc-web.exe`，然后用任何设备的浏览器访问。在地铁上用 iPad 让 Claude 帮你写代码，回到家直接看结果。

```bash
# 工作站上启动
./cc-web.exe --bind 0.0.0.0

# 手机浏览器打开 http://你的IP:3030
```

### 场景 2：多 Agent 比较 — 同一个问题问三个 AI
同一个会话里，先问 Claude，不满意切换到 Pi Agent，再试试 Codex。对话上下文自动保留，三个 AI 的回答直接对比。

```
用户: "优化这个 SQL 查询的性能"
Claude: 建议加索引 + 重写子查询  ← 不够好
🔄 切换到 Pi Agent
Pi: 用 EXPLAIN 分析后建议分区表   ← 更专业
🔄 切换到 Codex
Codex: 建议用 CTE 重构           ← 又一个思路
```

### 场景 3：长任务监控 — 让 AI 跑任务，实时看进度
让 Claude 执行一个复杂的重构任务，你可以：
- 实时看到它在读哪些文件、执行什么命令
- 随时点 **Stop** 中止（发现方向错了就停）
- 中途继续输入新指令（消息自动排队）

### 场景 4：团队共享 — 一个服务多人用
部署在服务器上，每个人通过浏览器访问，各自有独立的会话。不需要每台机器都装 Claude Code CLI。

### 场景 5：教学演示 — 展示 AI 编程过程
在投影仪上打开 CC-Web，实时展示 AI 的思考过程和代码操作。学生可以清楚看到：
- AI 如何分析问题（思考过程）
- 读了哪些文件（工具调用）
- 做了什么修改（文件编辑）
- 执行了什么命令（Bash 输出）

### 场景 6：Claude Code 的 Web 版 — 不喜欢终端？
如果你觉得 Claude Code 的终端界面不够直观，CC-Web 提供了：
- 可折叠的思考/工具调用块（不占屏幕空间）
- Markdown 渲染（表格、代码高亮、链接）
- 内置文件浏览器（不用切到文件管理器）
- 会话列表（快速切换项目）

---

## 🏗️ 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (Vanilla JS)                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ SSE Client│  │  Chat UI │  │FileBrowser│  │  Queue   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
└───────┼──────────────┼──────────────┼──────────────┼──────┘
        │              │              │              │
┌───────┼──────────────┼──────────────┼──────────────┼──────┐
│       ▼    Rust (Actix-Web)         ▼              ▼      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ SSE/SSE  │  │  Agent   │  │  Files   │  │ Session  │ │
│  │ Broadcast│  │  Router  │  │  API     │  │ Persist  │ │
│  └────┬─────┘  └────┬─────┘  └──────────┘  └──────────┘ │
└───────┼──────────────┼────────────────────────────────────┘
        │              │
        ▼              ▼
┌───────────────────────────────┐
│     AiAssistant Trait          │
│  ┌────────┐ ┌──────┐ ┌──────┐│
│  │ Claude │ │  Pi  │ │Codex ││
│  └───┬────┘ └──┬───┘ └──┬───┘│
└──────┼─────────┼────────┼─────┘
       ▼         ▼        ▼
   CLI Process  CLI Process  CLI Process
  (stream-json) (stream-json) (stream-json)
```

**后端**：Rust + Actix-Web，单文件 ~3MB，零依赖运行时
**前端**：原生 JavaScript，无框架依赖，零构建步骤
**通信**：SSE（Server-Sent Events）实时推送，broadcast channel 多订阅者
**持久化**：JSON 文件存储，启动时自动加载

---

## 🚀 快速开始

### 前置条件

1. **Rust** (编译用，或直接用预编译的 `cc-web.exe`)
2. **Claude Code CLI**：`npm install -g @anthropic-ai/claude-code`
3. **Pi Agent**（可选）：`npm install -g @earendil-works/pi-coding-agent`
4. **Codex**（可选）：`npm install -g @openai/codex`

### 运行

```bash
# 直接运行预编译版本
./cc-web.exe

# 或从源码编译
cargo build --release
./target/release/cc-web.exe
```

打开 http://localhost:3030

### 使用流程

1. 点击 **+** 创建新会话，选择工作目录和 Agent
2. 输入消息，实时观察 AI 的思考和操作过程
3. 需要切换 Agent？在顶部下拉框选择新 Agent，点击 **🔄 Switch**
4. Agent 工作太慢？点 **⏹ Stop** 中止
5. 继续输入消息，自动排队等待

---

## 📡 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/assistants` | 列出所有可用 Agent |
| `GET` | `/api/models` | 列出可用模型 |
| `GET` | `/api/sessions` | 列出所有会话 |
| `GET` | `/api/sessions/:id` | 获取会话详情 |
| `DELETE` | `/api/sessions/:id` | 删除会话 |
| `POST` | `/api/agent/new` | 创建新会话 |
| `POST` | `/api/agent/:id/start` | 发送消息（流式） |
| `POST` | `/api/agent/:id/switch` | 切换 Agent |
| `POST` | `/api/agent/:id/abort` | 中止运行 |
| `POST` | `/api/agent/:id` | 发送命令 |
| `GET` | `/api/agent/:id/events` | SSE 事件流 |
| `GET` | `/api/files?path=` | 浏览文件 |
| `GET` | `/api/files/:path` | 读取文件内容 |

---

## 🔧 扩展新 Agent

只需 3 步：

1. 创建 `src/ai/newagent.rs`，实现 `AiAssistant` trait
2. 实现 `stream_session` 方法（CLI 调用 + JSON 事件解析）
3. 在 `main.rs` 注册

```rust
// src/ai/newagent.rs
pub struct NewAgentAssistant { /* ... */ }

#[async_trait]
impl AiAssistant for NewAgentAssistant {
    fn name(&self) -> &str { "newagent" }
    fn display_name(&self) -> &str { "New Agent" }
    // ... 实现其他方法
    fn stream_session(&self, ...) -> StreamResult {
        // 调用 CLI，解析 stream-json 输出
    }
}
```

详见 [ADDING_ASSISTANTS.md](ADDING_ASSISTANTS.md)

---

## 📁 项目结构

```
src/
├── main.rs              # 应用入口、路由、持久化
├── models.rs            # 数据模型（Session, Message, ContentBlock）
├── static_files.rs      # 静态文件服务
├── ai/
│   ├── mod.rs           # AiAssistant trait + AssistantRegistry
│   ├── types.rs         # 共享类型（AiEvent, ModelInfo 等）
│   ├── streaming.rs     # 共享流式解析工具
│   ├── claude.rs        # Claude Code 适配器
│   ├── pi.rs            # Pi Agent 适配器
│   └── codex.rs         # Codex 适配器
├── api/
│   ├── mod.rs           # 模块声明
│   ├── agent.rs         # Agent 相关 API
│   ├── sessions.rs      # 会话 CRUD
│   ├── models.rs        # 模型/助手列表
│   └── files.rs         # 文件浏览 API
static/
├── index.html           # 页面结构
├── app.js               # 前端逻辑
└── style.css            # 样式
```

---

## 📄 License

MIT
