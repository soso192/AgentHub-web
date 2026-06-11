# CC-Web

> English | **[中文](./README.md)**

> 🚀 **[Download Now!!!](https://github.com/soso192/AgentHub-web/releases)** Start using it right now!!! 👉 **[https://github.com/soso192/AgentHub-web/releases](https://github.com/soso192/AgentHub-web/releases)**

> A Unified AI Coding Assistant Web Platform — One Interface to Rule All AI Agents

**CC-Web** is a high-performance web platform that lets you manage and use multiple AI coding assistants (Claude Code, Pi Agent, Codex, etc.) from a single browser interface. It features real-time streaming, multi-session split-screen, seamless agent switching, message queuing, dark theme, and other enterprise-grade capabilities.

---

## ✨ Core Features

### 🤖 Multi-Agent Management
- **Claude Code** — Anthropic's CLI coding assistant
- **Pi Agent** — Pi Coding Agent
- **OpenAI Codex** — OpenAI's coding assistant
- Switch freely between agents in one platform, no multiple terminal windows needed

### 🖥️ Split-Screen Parallel Mode
- **Grid Layouts** — 1×1, 2×1, 1×2, 2×2, 3×2, 3×3 (six layout options)
- **Independent Sessions** — Each panel runs its own AI session, no interference
- **Sync Mode** — Send one message to all panels simultaneously, multiple agents answer the same question in parallel
- **Panel Position Memory** — Add panels at any grid position, empty slots preserved automatically
- **Live Status** — Each panel independently shows streaming status (LIVE indicator)
- **Click Sync** — Clicking a panel auto-syncs sidebar selection, topbar assistant info, and file browser path

### 🔀 Seamless Agent Switching
- Switch between different agents in the same session, **conversation context automatically preserved**
- Auto-builds history summary on switch, new agent continues seamlessly
- Each message is tagged with its generating agent, tags persist after switch
- Split-screen mode fully supported, streaming content renders correctly in panels

### 🔄 Real-Time Streaming Output
- **Thinking** — Collapsible display of AI's reasoning process
- **Tool Calls** — Real-time display of Bash commands, file reads/writes, code edits
- **Tool Results** — Instant display of command execution output
- **Text Stream** — Character-by-character AI response output
- **Event Persistence** — Refreshing the page doesn't lose in-progress streaming content

### ⏹ Abort & Message Queue
- **Stop Button** — Abort a running agent at any time
- **Message Queue** — Keep typing while the agent works, messages auto-queue
- **Smart Routing** — Queued messages automatically route to the correct panel or main view
- **Queue UI** — Queue status displays above the input box, supports per-message deletion and clear
- **Race Condition Protection** — Abort immediately cleans up streaming state, prevents stale events from rendering in the next message

### 💾 Session Persistence
- All sessions auto-saved to `~/.cc-web/sessions.json`
- **Sessions survive restarts**, including full chat history and content blocks
- Claude Agent supports `--resume` native session recovery
- Pi Agent supports `--session` native session recovery

### 📁 Built-in File Browser
- Sidebar file tree, real-time browsing of working directory
- Click files for code preview (dark theme)
- Directory navigation, file icons, size display
- **Draggable Resize** — Drag the top border to adjust height, saved automatically
- **Session Sync** — File browser path auto-updates when switching sessions

### 🌙 Dark Theme
- Full Dark/Light dual theme support
- One-click toggle (🌙/☀️ button), preference auto-saved
- Auto-detect system theme preference (`prefers-color-scheme`)
- All components use CSS variables, theme switch with zero flicker

### 📝 Structured Logging System
- Logs written to file `~/.cc-web/logs/cc-web-YYYY-MM-DD.log`
- Five log levels: `error` > `warn` > `info` > `debug` > `trace`
- Console shows only startup banner, detailed logs go to file only
- Environment variable control: `RUST_LOG=debug`, `RUST_LOG=cc_web::ai::pi=trace`
- Auto-cleanup of log files older than 7 days
- Debug API: `GET /api/debug/state` returns real-time state snapshot of all sessions

### 🎨 Modern UI
- Dark code blocks, Markdown rendering, table support
- Collapsible thinking/tool-call blocks
- Unified CSS variable design system (border radius, shadows, semantic colors)
- Smooth transition animations on all interactive elements
- Responsive layout, mobile-friendly

---

## 💡 Use Cases

### Case 1: Multi-Agent Comparison — Ask three AIs the same question
In split-screen mode, send the same question to Claude, Pi, and Codex simultaneously, compare answers in real-time:

```
┌──────────────┬──────────────┬──────────────┐
│  🤖 Claude   │  ⚡ Pi Agent │  🔧 Codex    │
│              │              │              │
│ "Use index"  │ "Use partition│ "Use CTE"   │
│              │              │              │
│ [streaming...]│ [done]       │ [streaming...]│
└──────────────┴──────────────┴──────────────┘
```

### Case 2: Remote Development — Code from phone/tablet
Run `cc-web.exe` on your workstation, access from any device's browser:

```bash
# Start on workstation
./cc-web.exe --bind 0.0.0.0

# Open http://YOUR_IP:3030 on phone browser
```

### Case 3: Long Task Monitoring — Let AI run tasks, watch progress live
Let Claude execute a complex refactoring task:
- See in real-time which files it reads, what commands it runs
- Hit **Stop** anytime (stop if going in the wrong direction)
- Keep typing new instructions (messages auto-queue)

### Case 4: Teaching Demo — Show AI coding process
Open CC-Web on a projector, demonstrate AI's thinking process and code operations live.

---

## 🏗️ Technical Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (Vanilla JS)                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ SSE Client│  │  Chat UI │  │FileBrowser│  │  Queue   │ │
│  │(3-layer   │  │(split +  │  │(draggable)│  │(smart    │ │
│  │ timeout)  │  │ single)  │  │           │  │ routing) │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
└───────┼──────────────┼──────────────┼──────────────┼──────┘
        │              │              │              │
┌───────┼──────────────┼──────────────┼──────────────┼──────┐
│       ▼    Rust (Actix-Web)         ▼              ▼      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ SSE      │  │  Agent   │  │  Files   │  │ Session  │ │
│  │ Broadcast│  │  Router  │  │  API     │  │ Persist  │ │
│  │(1024 cap)│  │          │  │          │  │          │ │
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
  (stream-json) (JSON)       (JSON)
```

**Backend**: Rust + Actix-Web, single binary ~3MB, zero runtime dependencies
**Frontend**: Vanilla JavaScript, no framework dependencies, zero build steps
**Communication**: SSE (Server-Sent Events) real-time push, broadcast channel with multiple subscribers
**Persistence**: JSON file storage, auto-loaded on startup

### SSE Streaming 3-Layer Timeout Protection

| Layer | Mechanism | Timeout | Purpose |
|-------|-----------|---------|---------|
| ① | No-Event Timeout | 15s | Detect dead connections (backend sends no events) |
| ② | Heartbeat Check | 30s no heartbeat | Detect network disconnection or backend crash |
| ③ | Safety Timeout | 120s no activity | Final protection, active streams never killed |

### Event Flow

```
AI CLI Process → stdout → Event Parsing → broadcast channel
                                              ↓
                    ┌─────────────────────┼─────────────────────┐
                    ↓                     ↓                     ↓
              SSE Endpoint          Event Saver            Debug API
              (real-time push)      (persist to disk)      (state snapshot)
```

---

## 🚀 Quick Start

### Prerequisites

1. **Rust** (for building, or use pre-built `cc-web.exe` directly)
2. **Claude Code CLI**: `npm install -g @anthropic-ai/claude-code`
3. **Pi Agent** (optional): `npm install -g @earendil-works/pi-coding-agent`
4. **Codex** (optional): `npm install -g @openai/codex`

### Run

```bash
# Run pre-built binary directly
./cc-web.exe

# Or build from source
cargo build --release
./target/release/cc-web.exe

# Debug mode (detailed logs written to file)
RUST_LOG=debug ./cc-web.exe
```

Open http://localhost:3030

### Usage Flow

1. Click **+** to create a new session, select working directory and agent
2. Type messages, watch AI's thinking and operations in real-time
3. Want split-screen? Click the **⊞** button in the top bar
4. Want to switch agents? Select a new agent in the top dropdown, click **🔄 Switch**
5. Agent taking too long? Click **⏹ Stop** to abort
6. Keep typing messages, they auto-queue

---

## 📡 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/assistants` | List all available agents |
| `GET` | `/api/models` | List available models |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Delete session |
| `POST` | `/api/agent/new` | Create new session |
| `POST` | `/api/agent/:id/start` | Send message (streaming) |
| `POST` | `/api/agent/:id/switch` | Switch agent |
| `POST` | `/api/agent/:id/abort` | Abort running agent |
| `POST` | `/api/agent/:id` | Send command |
| `GET` | `/api/agent/:id/events` | SSE event stream |
| `GET` | `/api/files?path=` | Browse files |
| `GET` | `/api/files/:path` | Read file content |
| `GET` | `/api/debug/state` | Debug: real-time state snapshot |

---

## 🔧 Extending with New Agents

Just 3 steps:

1. Create `src/ai/newagent.rs`, implement the `AiAssistant` trait
2. Implement `stream_session` method (CLI invocation + JSON event parsing)
3. Register in `main.rs`

```rust
// src/ai/newagent.rs
pub struct NewAgentAssistant { /* ... */ }

#[async_trait]
impl AiAssistant for NewAgentAssistant {
    fn name(&self) -> &str { "newagent" }
    fn display_name(&self) -> &str { "New Agent" }
    // ... implement other methods
    fn stream_session(&self, ...) -> StreamResult {
        // Invoke CLI, parse stream-json output
    }
}
```

---

## 📁 Project Structure

```
src/
├── main.rs              # App entry, routing, persistence
├── models.rs            # Data models (Session, Message, ContentBlock)
├── static_files.rs      # Static file serving
├── logging.rs           # Structured logging (file output, rotation, debug API)
├── ai/
│   ├── mod.rs           # AiAssistant trait + AssistantRegistry
│   ├── types.rs         # Shared types (AiEvent, ModelInfo, etc.)
│   ├── streaming.rs     # Shared stream parsing + unified event sending
│   ├── claude.rs        # Claude Code adapter
│   ├── pi.rs            # Pi Agent adapter
│   └── codex.rs         # Codex adapter
├── api/
│   ├── mod.rs           # Module declarations
│   ├── agent.rs         # Agent APIs (SSE, streaming, switch, abort)
│   ├── sessions.rs      # Session CRUD
│   ├── models.rs        # Model/assistant listing
│   └── files.rs         # File browsing API
static/
├── index.html           # Page structure
├── app.js               # Frontend logic (SSE, split-view, queue, theme)
└── style.css            # Styles (CSS variables, dark theme, responsive)
```

---

## 📄 License

MIT
