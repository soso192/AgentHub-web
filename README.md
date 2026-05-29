# CC-Web (Rust Version)

A lightweight web interface for Claude Code CLI, written in Rust.

## Features

- 🚀 Fast and lightweight (~3MB executable)
- 💾 In-memory session storage
- 🎨 Clean, modern UI
- 🔄 Real-time responses
- 🛠️ Full Claude Code CLI integration

## Prerequisites

1. **Claude Code CLI** installed:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. **Git Bash** (for Windows):
   - Install Git for Windows
   - Set `CLAUDE_CODE_GIT_BASH_PATH` if not in default location

## Usage

### Run from executable

```bash
# Double-click cc-web.exe or run from terminal
./cc-web.exe
```

### Run from source

```bash
cargo run --release
```

Then open http://localhost:3030 in your browser.

## Building

```bash
# Build release version
cargo build --release

# The executable will be at target/release/cc-web.exe
```

## Configuration

The app reads Claude Code settings from `~/.claude/settings.json`.

Default model is taken from `ANTHROPIC_MODEL` environment variable or settings file.

## API Endpoints

- `GET /api/models` - List available models
- `GET /api/sessions` - List all sessions
- `GET /api/sessions/:id` - Get session details
- `DELETE /api/sessions/:id` - Delete session
- `POST /api/agent/new` - Create new session and send message
- `POST /api/agent/:id` - Send command to session
- `GET /api/agent/:id` - Get agent state
- `GET /api/agent/:id/events` - SSE event stream

## License

MIT
