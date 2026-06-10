// CC-Web Frontend - Concurrent Multi-Session Architecture
const API_BASE = '';

// ===== Global State =====
let currentSessionId = null;
let sessions = [];
let assistants = [];
let models = [];
let currentAssistant = 'claude';
let currentModel = null;
let pendingCwd = null;
let currentBrowsePath = null;
let fileBrowserExpanded = false;

// Per-session streaming: sessionId → { eventSource, streamingDiv, contentDiv, contentBlocks, toolCallMap, hasContent, finalResult, finished, safetyTimeout }
const streamingSessions = new Map();
// Per-session message queues: sessionId → [message, ...]
const messageQueues = new Map();
// Per-session DOM containers: sessionId → .session-view div
const sessionViews = new Map();

// ===== Theme =====
function initTheme() {
    const saved = localStorage.getItem('cc-web-theme');
    const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(theme);
}

function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cc-web-theme', theme);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
    const current = document.documentElement.dataset.theme || 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
}

// ===== DOM References =====
const sidebar = document.getElementById('sidebar');
const toggleSidebar = document.getElementById('toggleSidebar');
const newSessionBtn = document.getElementById('newSessionBtn');
const newSessionForm = document.getElementById('newSessionForm');
const modelSelectNew = document.getElementById('modelSelectNew');
const cwdInput = document.getElementById('cwdInput');
const createSessionBtn = document.getElementById('createSessionBtn');
const cancelSessionBtn = document.getElementById('cancelSessionBtn');
const sessionList = document.getElementById('sessionList');
const welcomeScreen = document.getElementById('welcomeScreen');
const chatContainer = document.getElementById('chatContainer');
const assistantCards = document.getElementById('assistantCards');
const inputArea = document.getElementById('inputArea');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const assistantSelector = document.getElementById('assistantSelector');
const modelSelector = document.getElementById('modelSelector');
const statusDisplay = document.getElementById('statusDisplay');
const assistantStatus = document.getElementById('assistantStatus');
const typingIndicator = document.getElementById('typingIndicator');
const switchAssistantBtn = document.getElementById('switchAssistantBtn');
const stopBtn = document.getElementById('stopBtn');

// ===== Constants =====
const ASSISTANT_ICONS = { 'claude': '🤖', 'codex': '⚡', 'pi': 'π', 'cursor': '📝', 'default': '🔧' };
const ASSISTANT_DESCS = { 'claude': 'Anthropic Claude Code CLI', 'codex': 'OpenAI Codex CLI', 'pi': 'Pi Coding Agent', 'cursor': 'Cursor AI Editor', 'default': 'AI Assistant' };
const TOOL_ICONS = { 'Bash': '💻', 'bash': '💻', 'Read': '📖', 'read': '📖', 'Write': '✏️', 'write': '✏️', 'Edit': '📝', 'edit': '📝', 'Glob': '🔍', 'glob': '🔍', 'Grep': '🔎', 'grep': '🔎', 'WebFetch': '🌐', 'WebSearch': '🔎', 'Agent': '🤖', 'default': '🔧' };

// ===== Session View Management =====

// Get or create a session's own DOM container inside chatContainer
function getSessionView(sessionId) {
    if (sessionViews.has(sessionId)) return sessionViews.get(sessionId);
    const view = document.createElement('div');
    view.className = 'session-view';
    view.dataset.sessionId = sessionId;
    // Insert before typingIndicator so indicator stays at bottom
    chatContainer.insertBefore(view, typingIndicator);
    sessionViews.set(sessionId, view);
    return view;
}

// Show only the given session's view, hide all others
function showSessionView(sessionId) {
    for (const [sid, view] of sessionViews) {
        view.style.display = sid === sessionId ? 'block' : 'none';
    }
}

// ===== Initialization =====

async function init() {
    initTheme();
    await loadAssistants();
    await loadModels();
    await loadSessions();
    setupEventListeners();
    renderAssistantCards();
    renderAssistantStatus();
    
    // Auto-select the most recent session on page load
    if (sessions.length > 0 && !currentSessionId) {
        const latestSession = sessions[0]; // Already sorted by modified time, newest first
        await selectSession(latestSession.id);
    }
}

async function loadAssistants() {
    try {
        const res = await fetch(`${API_BASE}/api/assistants`);
        const data = await res.json();
        assistants = data.assistants || [];
        const def = assistants.find(a => a.is_default);
        if (def) currentAssistant = def.name;
        updateAssistantSelectors();
    } catch (e) {
        console.error('Failed to load assistants:', e);
        assistants = [{ name: 'claude', display_name: 'Claude Code', is_default: true }];
        currentAssistant = 'claude';
        updateAssistantSelectors();
    }
}

/// Load available models from the backend, filtered by the currently selected assistant.
/// Each assistant (Claude, Pi, Codex) supports different models, so the model list
/// changes when the user switches assistants or selects a different session.
async function loadModels() {
    try {
        // Pass the current assistant name as a query parameter
        // so the backend returns that assistant's model list.
        const url = currentAssistant
            ? `${API_BASE}/api/models?assistant=${encodeURIComponent(currentAssistant)}`
            : `${API_BASE}/api/models`;
        const res = await fetch(url);
        const data = await res.json();
        models = data.model_list || [];
        currentModel = data.default_model?.model_id;  // set default model for this assistant
        updateModelSelectors();  // refresh all model dropdowns in the UI
    } catch (e) {
        console.error('Failed to load models:', e);
    }
}

async function loadSessions() {
    try {
        const res = await fetch(`${API_BASE}/api/sessions`);
        const data = await res.json();
        sessions = data.sessions || [];
        renderSessionList();
    } catch (e) {
        console.error('Failed to load sessions:', e);
    }
}

// ===== UI Updates =====

function updateAssistantSelectors() {
    assistantSelector.innerHTML = '';
    assistants.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.name;
        const status = a.available ? '' : ' ⚠️未安装';
        const version = a.version ? ` v${a.version}` : '';
        opt.textContent = `${ASSISTANT_ICONS[a.name] || ASSISTANT_ICONS.default} ${a.display_name}${version}${status}`;
        if (!a.available) opt.style.color = '#999';
        if (a.name === currentAssistant) opt.selected = true;
        assistantSelector.appendChild(opt);
    });
}

function updateModelSelectors() {
    [modelSelectNew, modelSelector].forEach(select => {
        select.innerHTML = '';
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            if (m.id === currentModel) opt.selected = true;
            select.appendChild(opt);
        });
    });
    statusDisplay.textContent = currentModel || '';
}

function renderAssistantCards() {
    assistantCards.innerHTML = '';
    assistants.forEach(a => {
        const card = document.createElement('div');
        card.className = `assistant-card ${a.name === currentAssistant ? 'selected' : ''} ${!a.available ? 'unavailable' : ''}`;
        const badge = a.available
            ? `<div class="card-status available">✅ 已安装${a.version ? ' v' + a.version : ''}</div>`
            : '<div class="card-status unavailable">⚠️ 未安装</div>';
        card.innerHTML = `
            <div class="icon">${ASSISTANT_ICONS[a.name] || ASSISTANT_ICONS.default}</div>
            <div class="name">${a.display_name}</div>
            <div class="desc">${ASSISTANT_DESCS[a.name] || ASSISTANT_DESCS.default}</div>
            ${badge}`;
        card.onclick = a.available ? () => selectAssistant(a.name) : () => alert(`⚠️ ${a.display_name} 未在本地安装，请先安装对应的 CLI 工具。`);
        assistantCards.appendChild(card);
    });
}

function renderAssistantStatus() {
    assistantStatus.innerHTML = '';
    assistants.forEach(a => {
        const badge = document.createElement('span');
        badge.className = `assistant-badge-lg ${a.name === currentAssistant ? 'active' : ''}`;
        badge.innerHTML = `<span class="dot"></span>${ASSISTANT_ICONS[a.name] || ASSISTANT_ICONS.default} ${a.name}`;
        badge.onclick = () => selectAssistant(a.name);
        assistantStatus.appendChild(badge);
    });
}

function selectAssistant(name) {
    currentAssistant = name;
    assistantSelector.value = name;
    renderAssistantCards();
    renderAssistantStatus();
    loadModels();
    updateSwitchButton();
}

function updateSwitchButton() {
    if (!currentSessionId) { switchAssistantBtn.style.display = 'none'; return; }
    const session = sessions.find(s => s.id === currentSessionId);
    switchAssistantBtn.style.display = (session && session.assistant !== currentAssistant) ? 'inline-flex' : 'none';
}

function updateSendButtonState() {
    if (currentSessionId && streamingSessions.has(currentSessionId)) {
        sendBtn.classList.add('streaming');
        stopBtn.style.display = 'inline-flex';
    } else {
        sendBtn.classList.remove('streaming');
        stopBtn.style.display = 'none';
    }
}

// ===== Session List =====

function renderSessionList() {
    sessionList.innerHTML = '';
    sessions.forEach(session => {
        const div = document.createElement('div');
        // Show streaming indicator: check frontend state first (more responsive),
        // then fallback to backend state (handles edge cases)
        const frontendStreaming = streamingSessions.has(session.id) && !streamingSessions.get(session.id).finished;
        const isLive = frontendStreaming || session.isStreaming;
        div.className = `session-item ${session.id === currentSessionId ? 'active' : ''} ${isLive ? 'streaming' : ''}`;
        const icon = ASSISTANT_ICONS[session.assistant] || ASSISTANT_ICONS.default;
        const live = isLive ? '<span class="session-streaming-badge">🔴 LIVE</span>' : '';
        const fullName = session.firstMessage || 'Untitled';
        const displayName = fullName.length > 40 ? fullName.slice(0, 40) + '...' : fullName;
        div.innerHTML = `
            <div class="header">
                <div class="name" title="${escapeHtml(fullName)}">${icon} ${escapeHtml(displayName)}</div>
                ${live}
                <button class="delete-btn" data-id="${session.id}">×</button>
            </div>
            <div class="meta">
                <span class="assistant-badge">${session.assistant || 'claude'}</span>
                <span>${session.messageCount || 0} msgs</span>
                <span class="cwd-label" title="${escapeHtml(session.cwd || '')}">📁 ${escapeHtml(session.cwd || '')}</span>
            </div>`;
        div.onclick = (e) => {
            if (e.target.classList.contains('delete-btn')) return;
            // 如果当前是面板模式，先退出面板模式再切换会话
            if (splitViewManager.enabled) splitViewManager.toggle();
            selectSession(session.id);
        };
        div.querySelector('.delete-btn').onclick = async (e) => {
            e.stopPropagation();
            if (confirm('Delete this session?')) await deleteSession(session.id);
        };
        sessionList.appendChild(div);
    });
}

// ===== Select Session =====
// Switches the UI to display a specific session.
//
// This is called when the user clicks on a session in the sidebar.
// It syncs the topbar assistant/model selectors, loads messages
// from the backend (if not already loaded), and shows the session view.
let selectSessionGeneration = 0; // 竞态条件保护：每次调用递增，丢弃过期调用
async function selectSession(sessionId) {
    const gen = ++selectSessionGeneration;
    currentSessionId = sessionId;

    // Reload sessions to get fresh isStreaming status from backend
    await loadSessions();
    if (gen !== selectSessionGeneration) return; // 用户已切换到其他会话，丢弃本次结果
    renderSessionList();

    // Sync the topbar assistant/model selectors with this session's settings.
    // This runs EVERY time a session is selected (not just the first time),
    // so the dropdown always reflects the current session's assistant.
    const sessionInfo = sessions.find(s => s.id === sessionId);
    if (sessionInfo) {
        if (sessionInfo.assistant) { currentAssistant = sessionInfo.assistant; assistantSelector.value = sessionInfo.assistant; }
        if (sessionInfo.model) { currentModel = sessionInfo.model; modelSelector.value = sessionInfo.model; statusDisplay.textContent = sessionInfo.model; }
        await loadModels();
        if (gen !== selectSessionGeneration) return;
        if (sessionInfo.model) { currentModel = sessionInfo.model; modelSelector.value = sessionInfo.model; statusDisplay.textContent = sessionInfo.model; }
    }

    // Get or create this session's DOM view
    const view = getSessionView(sessionId);

    // Load messages from backend if view is empty (first time viewing, e.g. after page refresh)
    if (view.children.length === 0) {
        try {
            const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
            if (gen !== selectSessionGeneration) return;
            const data = await res.json();
            if (data.messages) renderMessagesInto(view, data.messages, data.assistant);
        } catch (e) { console.error('Failed to load session:', e); }
    }

    // 每次切换会话都更新文件浏览器目录
    if (sessionInfo?.cwd) {
        currentBrowsePath = sessionInfo.cwd;
        if (fileBrowserExpanded) loadFiles(sessionInfo.cwd);
        else {
            document.getElementById('fileBrowserPath').textContent = sessionInfo.cwd;
        }
    }

    // Show this session's view, hide all others
    showSessionView(sessionId);
    welcomeScreen.style.display = 'none';
    chatContainer.style.display = 'flex'; chatContainer.style.flexDirection = 'column';
    inputArea.style.display = 'block';

    // If backend says this session is still streaming but frontend has no connection,
    // check if the backend is really still streaming before reconnecting
    if (sessionInfo?.isStreaming && !streamingSessions.has(sessionId)) {
        // First check backend status to avoid connecting to a dead stream
        try {
            const statusRes = await fetch(`${API_BASE}/api/agent/${sessionId}`);
            const statusData = await statusRes.json();
            
            if (statusData.state?.isStreaming) {
                // Backend confirms streaming, reconnect SSE
                console.log(`[selectSession] Backend confirms streaming for ${sessionId}, reconnecting SSE`);
                connectSSE(sessionId, null);
            } else {
                // Backend says not streaming, update local state
                console.log(`[selectSession] Backend says NOT streaming for ${sessionId}, skipping SSE reconnect`);
                // Force update the session's isStreaming flag
                const session = sessions.find(s => s.id === sessionId);
                if (session) session.isStreaming = false;
                renderSessionList();
            }
        } catch (e) {
            console.error('[selectSession] Failed to check backend status:', e);
        }
    }

    updateSwitchButton();
    updateQueueUI();
    updateSendButtonState();

    if (streamingSessions.has(sessionId)) {
        typingIndicator.style.display = 'block';
        typingIndicator.querySelector('.assistant-name').textContent = currentAssistant;
    } else {
        typingIndicator.style.display = 'none';
    }

    scrollToBottom();
}

// ===== Delete Session =====

async function deleteSession(sessionId) {
    cleanupSessionStreaming(sessionId);
    messageQueues.delete(sessionId);
    // Remove session view from DOM
    const view = sessionViews.get(sessionId);
    if (view) { view.remove(); sessionViews.delete(sessionId); }
    updateQueueUI();

    try {
        await fetch(`${API_BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });
        if (currentSessionId === sessionId) {
            currentSessionId = null;
            welcomeScreen.style.display = 'flex';
            chatContainer.style.display = 'none';
            inputArea.style.display = 'none';
        }
        await loadSessions();
    } catch (e) { console.error('Failed to delete session:', e); }
}

// ===== Switch Assistant =====
// Switches the current session to a different AI assistant.
//
// Flow:
// 1. Validate the switch request (not same assistant, assistant available)
// 2. POST /api/agent/:id/switch → backend updates session, sends history
//    to new assistant, starts streaming response via SSE
// 3. Connect to SSE to receive the new assistant's response
// 4. Display "Switched from X to Y" system message after response completes
//
// The backend handles sending the conversation history to the new assistant.
// The frontend just needs to listen for the streamed response.
async function switchAssistant() {
    // Guard: no session, already streaming, same assistant, or assistant unavailable
    if (!currentSessionId || streamingSessions.has(currentSessionId)) return;
    const newAssistant = assistantSelector.value;
    const session = sessions.find(s => s.id === currentSessionId);
    if (!session || session.assistant === newAssistant) return;
    const info = assistants.find(a => a.name === newAssistant);
    if (info && !info.available) { alert(`⚠️ ${info.display_name} 未在本地安装，无法切换。`); return; }

    // Show immediate visual feedback before making the request
    const fromName = session.assistant;
    const toName = newAssistant;
    const toInfo = assistants.find(a => a.name === toName);
    const toDisplayName = toInfo?.display_name || toName;
    const toIcon = ASSISTANT_ICONS[toName] || ASSISTANT_ICONS.default;
    const sessionId = currentSessionId; // 捕获，防止异步期间变化

    const isPanelMode = splitViewManager.enabled;
    const activePanelId = isPanelMode ? splitViewManager.activePanelId : null;

    try {
        switchAssistantBtn.disabled = true;
        switchAssistantBtn.textContent = '⏳ Switching...';

        // Show a "switching" indicator immediately in the chat
        // 面板模式下显示在面板的聊天区域，普通模式显示在主视图
        const chatTarget = isPanelMode
            ? document.getElementById(`panel-chat-${activePanelId}`)
            : getSessionView(sessionId);
        const switchingDiv = document.createElement('div');
        switchingDiv.className = 'message system switching-indicator';
        // 使用基于 sessionId 的唯一 ID，避免多个面板同时切换时 ID 冲突
        const indicatorId = `switching-indicator-${sessionId}`;
        switchingDiv.id = indicatorId;
        switchingDiv.innerHTML = `<div class="system-content">⏳ Switching to ${toIcon} <strong>${toDisplayName}</strong>...</div>`;
        if (chatTarget) { chatTarget.appendChild(switchingDiv); chatTarget.scrollTop = chatTarget.scrollHeight; }

        // Step 1: Ask the backend to switch assistants.
        const res = await fetch(`${API_BASE}/api/agent/${sessionId}/switch`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistant: newAssistant, model: modelSelector.value })
        });
        const data = await res.json();

        if (data.success) {
            // Step 2: Update local state
            currentAssistant = data.assistant; currentModel = data.model;
            assistantSelector.value = data.assistant; modelSelector.value = data.model;
            statusDisplay.textContent = data.model;

            // Update the switching indicator to show we're waiting for the assistant
            const indicator = document.getElementById(indicatorId);
            if (indicator) {
                indicator.innerHTML = `<div class="system-content">⏳ ${toIcon} <strong>${toDisplayName}</strong> is starting...</div>`;
            }

            // Step 3: Connect to SSE to receive the new assistant's streamed response.
            // 面板模式下需要传入 activePanelId，否则流式内容会渲染到隐藏的主视图
            connectSSE(sessionId, null, () => {
                // Step 4: After the new assistant responds, remove switching indicator and show switch message
                const ind = document.getElementById(indicatorId);
                if (ind) ind.remove();

                const sysDiv = document.createElement('div');
                sysDiv.className = 'message system';
                sysDiv.innerHTML = `<div class="system-content">🔄 Switched from <strong>${ASSISTANT_ICONS[fromName] || ASSISTANT_ICONS.default} ${fromName}</strong> to <strong>${toIcon} ${toDisplayName}</strong></div>`;
                // 面板模式下系统消息显示在面板聊天区域
                const target = isPanelMode
                    ? document.getElementById(`panel-chat-${activePanelId}`)
                    : getSessionView(sessionId);
                if (target) { target.appendChild(sysDiv); target.scrollTop = target.scrollHeight; }
            }, { panelId: activePanelId });

            // Refresh session list to reflect the new assistant
            await loadSessions(); renderSessionList(); updateSwitchButton();
        } else {
            const indicator = document.getElementById(indicatorId);
            if (indicator) indicator.remove();
            alert('Switch failed: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        const indicator = document.getElementById(indicatorId);
        if (indicator) indicator.remove();
        alert('Switch error: ' + e.message);
    }
    finally { switchAssistantBtn.disabled = false; switchAssistantBtn.textContent = '🔄 Switch'; }
}

// ===== Render Messages =====

function renderMessagesInto(view, messages, assistant) {
    messages.forEach(msg => {
        const div = document.createElement('div');
        div.className = `message ${msg.role}`;
        let html = '';
        if (msg.role === 'assistant') {
            const a = msg.assistant || assistant;
            html += `<div class="assistant-label">${ASSISTANT_ICONS[a] || ASSISTANT_ICONS.default} ${a || 'Assistant'}</div>`;
        }
        if (msg.content_blocks && msg.content_blocks.length > 0) {
            html += '<div class="message-content">';
            
            // First pass: render all blocks except tool_result
            msg.content_blocks.forEach(block => {
                if (block.type === 'thinking') html += renderThinkingBlock(block.thinking);
                else if (block.type === 'tool_use') html += renderToolCallBlock(block.id, block.name, block.input);
                else if (block.type === 'text') html += `<div class="text-block">${renderMarkdown(block.text)}</div>`;
                // Skip tool_result for now
            });
            html += '</div>';
            
            // After rendering, inject tool results into their corresponding tool-call blocks
            div.innerHTML = html;
            msg.content_blocks.forEach(block => {
                if (block.type === 'tool_result') {
                    const area = div.querySelector(`.tool-result-area[data-tool-id="${block.tool_use_id}"]`);
                    if (area) {
                        area.innerHTML = `<div class="tool-result-inline"><div class="tool-result-header"><span class="tool-result-icon">📋</span><span class="tool-result-label">Output</span></div><pre class="tool-result-content">${escapeHtml(block.content)}</pre></div>`;
                    }
                }
            });
            
            view.appendChild(div);
        } else {
            html += `<div class="message-content">${msg.role === 'assistant' ? renderMarkdown(msg.content) : escapeHtml(msg.content)}</div>`;
            div.innerHTML = html;
            view.appendChild(div);
        }
    });
    scrollToBottom();
}

function addMessage(role, content, assistant, sessionId) {
    sessionId = sessionId || currentSessionId;
    if (!sessionId) return;
    const view = getSessionView(sessionId);
    const div = document.createElement('div');
    div.className = `message ${role}`;
    let html = '';
    if (role === 'assistant') {
        const icon = ASSISTANT_ICONS[assistant] || ASSISTANT_ICONS.default;
        html += `<div class="assistant-label">${icon} ${assistant || currentAssistant}</div>`;
    }
    html += `<div class="message-content">${escapeHtml(content)}</div>`;
    div.innerHTML = html;
    view.appendChild(div);
    if (sessionId === currentSessionId) scrollToBottom();
}

function createStreamingMessage(sessionId) {
    const view = getSessionView(sessionId);
    const div = document.createElement('div');
    div.className = 'message assistant streaming';
    const session = sessions.find(s => s.id === sessionId);
    const streamAssistant = session ? session.assistant : currentAssistant;
    const icon = ASSISTANT_ICONS[streamAssistant] || ASSISTANT_ICONS.default;
    div.innerHTML = `<div class="assistant-label">${icon} ${streamAssistant}</div><div class="message-content"></div>`;
    view.appendChild(div);
    if (sessionId === currentSessionId) scrollToBottom();
    return div;
}

// ===== Rendering Helpers =====

function renderThinkingBlock(thinking) {
    return `<div class="thinking-block">
        <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="thinking-icon">💭</span><span class="thinking-label">Thinking</span><span class="thinking-toggle">▶</span>
        </div>
        <div class="thinking-content">${escapeHtml(thinking)}</div></div>`;
}

function getToolPreview(name, input) {
    if (!input || typeof input !== 'object') return '';
    const n = name.toLowerCase();
    if (n === 'bash') return input.command || '';
    if (['read','write','edit'].includes(n)) return input.file_path || input.filePath || input.path || input.filename || '';
    if (n === 'glob') return input.pattern || input.glob || '';
    if (n === 'grep') return input.pattern || input.query || input.regex || '';
    if (n === 'webfetch') return input.url || '';
    if (n === 'websearch') return input.query || input.search || '';
    return input.command || input.path || input.file_path || input.filePath || input.pattern || input.query || '';
}

function renderToolCallBlock(id, name, input) {
    const icon = TOOL_ICONS[name] || TOOL_ICONS.default;
    let preview = getToolPreview(name, input);
    if (typeof preview === 'object') preview = JSON.stringify(preview);
    if (preview.length > 100) preview = preview.slice(0, 100) + '...';
    // Handle empty or null input
    const safeInput = input && typeof input === 'object' ? input : {};
    const inputDisplay = (name === 'Bash' || name === 'bash')
        ? (safeInput.command ? escapeHtml(safeInput.command) : escapeHtml(JSON.stringify(safeInput, null, 2)))
        : escapeHtml(JSON.stringify(safeInput, null, 2));
    return `<div class="tool-call-block" data-tool-id="${id}">
        <div class="tool-call-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="tool-icon">${icon}</span><span class="tool-name">${escapeHtml(name)}</span>
            <span class="tool-preview">${escapeHtml(preview)}</span><span class="tool-toggle">▶</span></div>
        <div class="tool-call-content"><pre class="tool-input">${inputDisplay}</pre>
            <div class="tool-result-area" data-tool-id="${id}"></div></div></div>`;
}

function renderToolResultBlock(content) {
    return `<div class="tool-result-block">
        <div class="tool-result-header"><span class="tool-result-icon">📋</span><span class="tool-result-label">Result</span></div>
        <pre class="tool-result-content">${escapeHtml(content)}</pre></div>`;
}

function scrollToBottom() { chatContainer.scrollTop = chatContainer.scrollHeight; }

/** 滚动面板的聊天区域到底部（如果在面板模式下） */
function scrollPanelToBottom(st) {
    if (st && st.panelId) {
        const chatDiv = document.getElementById(`panel-chat-${st.panelId}`);
        if (chatDiv) chatDiv.scrollTop = chatDiv.scrollHeight;
    }
}

function escapeHtml(text) {
    if (typeof text !== 'string') text = String(text || '');
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    
    // Protect code blocks and inline code first
    const codeBlocks = [];
    const inlineCodes = [];
    
    // Protect code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
        codeBlocks.push(`<pre><code>${code}</code></pre>`);
        return placeholder;
    });
    
    // Protect inline code
    html = html.replace(/`([^`\n]+)`/g, (_, code) => {
        const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
        inlineCodes.push(`<code>${code}</code>`);
        return placeholder;
    });
    
    // Bold: match **content** where content can contain * (for math expressions)
    // Use non-greedy match for the outer ** markers
    html = html.replace(/\*\*((?:[^*]|\*(?!\*))*)\*\*/g, '<strong>$1</strong>');
    
    // Italic: match *content* but avoid matching math expressions like 13*(12+17)*20
    // Require content to contain at least one letter to avoid matching pure math
    html = html.replace(/(?<!\*)\*([^*\n]*[a-zA-Z][^*\n]*)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    // Restore code blocks and inline code
    for (let i = 0; i < codeBlocks.length; i++) {
        html = html.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
    }
    for (let i = 0; i < inlineCodes.length; i++) {
        html = html.replace(`__INLINE_CODE_${i}__`, inlineCodes[i]);
    }
    
    if (!html.startsWith('<')) html = '<p>' + html + '</p>';
    return html;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║                    SSE 流式传输管理                              ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║                                                                  ║
// ║  SSE 连接生命周期：                                               ║
// ║  1. connectSSE() 创建 EventSource，注册所有超时机制               ║
// ║  2. 收到 connected 事件 → 发送 prompt 到后端                     ║
// ║  3. 接收流式事件（thinking/chunk/tool_call 等）→ 渲染到 DOM       ║
// ║  4. 收到 result/error 事件 → 调用 finishStreaming()              ║
// ║  5. finishStreaming() 清理所有超时、关闭 EventSource              ║
// ║                                                                  ║
// ║  超时机制（3 层保护）：                                           ║
// ║  ┌─────────────────────────────────────────────────────────┐     ║
// ║  │ ① 无事件超时 (noEventTimeout): 15 秒                    │     ║
// ║  │   - 连接打开后启动                                       │     ║
// ║  │   - 收到第 2 个事件后清除                                 │     ║
// ║  │   - 用途：检测死连接（后端不发送任何事件）                  │     ║
// ║  ├─────────────────────────────────────────────────────────┤     ║
// ║  │ ② 心跳检查 (heartbeatCheck): 每 10 秒检查一次            │     ║
// ║  │   - 检查最后一次心跳是否超过 30 秒                        │     ║
// ║  │   - 超时后查询后端 isStreaming 状态                       │     ║
// ║  │   - 用途：检测网络断开或后端崩溃                           │     ║
// ║  ├─────────────────────────────────────────────────────────┤     ║
// ║  │ ③ 安全超时 (safetyTimeout): 每 30 秒检查，120 秒无事件触发│     ║
// ║  │   - 每 30 秒检查 lastEventTime                            │     ║
// ║  │   - 只有 120 秒内无任何事件才触发                          │     ║
// ║  │   - 用途：最终保护，防止连接永久挂起                       │     ║
// ║  │   - 注意：活跃的流（持续收到事件）永远不会被此超时杀掉      │     ║
// ║  └─────────────────────────────────────────────────────────┘     ║
// ║                                                                  ║
// ║  重要：safetyTimeout 使用 setInterval 而非 setTimeout            ║
// ║  原因：setTimeout 是硬性截止（到期即杀），会误杀长时间运行的      ║
// ║  工具调用（如编译、大文件读取超过 2 分钟）。                     ║
// ║  setInterval + lastEventTime 实现"无活动超时"：只要还在收到      ║
// ║  事件，定时器每次检查都会重置，永远不会触发。                     ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * 为指定会话建立 SSE (Server-Sent Events) 连接
 *
 * SSE 连接用于实时接收 AI 的流式响应。每个会话同一时间只能有一个活跃连接。
 * 连接建立后，会自动发送 prompt 到后端触发 AI 响应。
 *
 * 工作流程：
 * 1. 检查是否已有活跃连接（防重复连接）
 * 2. 创建 EventSource 连接到 /api/agent/{id}/events
 * 3. 注册 3 层超时保护机制
 * 4. 收到 connected 事件后，将 prompt 发送到后端
 * 5. 接收流式事件并实时渲染到聊天界面
 *
 * @param {string} sessionId - 会话ID
 * @param {string|null} message - 要发送的消息（首次连接时传入）
 * @param {function|null} onDone - 流式传输完成后的回调（用于助手切换）
 * @returns {object} 流式状态对象
 */
/**
 * 为会话建立 SSE 连接（统一入口，主视图和面板共用）
 *
 * @param {string} sessionId - 会话ID
 * @param {string|null} message - 待发送的消息（主视图首次连接时传入）
 * @param {function|null} onDone - 完成回调（助手切换场景）
 * @param {object} options - 可选参数
 * @param {string} options.panelId - 面板ID（面板模式下传入）
 */
function connectSSE(sessionId, message, onDone, options = {}) {
    const panelId = options.panelId || null;

    // ── 防重复连接 ──
    // 如果已有未完成的连接，直接返回现有状态，避免重复建立 SSE
    const existing = streamingSessions.get(sessionId);
    if (existing && !existing.finished) {
        console.log(`[SSE] Already connected for ${sessionId}, skipping`);
        if (message) existing._message = message;
        if (onDone) existing._onDone = onDone;
        if (panelId) existing.panelId = panelId;
        return existing;
    }

    // 获取助手信息（面板模式需要）
    const assistant = panelId
        ? (splitViewManager.panels.get(panelId)?.sessionInfo || sessions.find(s => s.id === sessionId))?.assistant || 'claude'
        : null;

    // ── 创建流式状态对象 ──
    const state = {
        eventSource: null,
        streamingDiv: null,
        contentDiv: null,
        contentBlocks: [],
        toolCallMap: {},
        hasContent: false,
        finalResult: '',
        promptSent: false,
        finished: false,
        safetyTimeout: null,
        noEventTimeout: null,
        _message: message,
        _onDone: onDone,
        _startTime: Date.now(),
        lastHeartbeat: Date.now(),
        lastEventTime: Date.now(),
        heartbeatCheck: null,
        eventCount: 0,
        // 面板模式特有字段
        panelId: panelId,
        assistant: assistant,
    };
    streamingSessions.set(sessionId, state);

    // ── 创建 EventSource 连接 ──
    // EventSource 是浏览器原生 API，自动处理重连和事件解析
    // 后端 endpoint: /api/agent/{sessionId}/events
    const es = new EventSource(`${API_BASE}/api/agent/${sessionId}/events`);
    state.eventSource = es;

    // ══════════════════════════════════════════════════════════════
    //  连接打开事件
    // ══════════════════════════════════════════════════════════════
    es.onopen = () => {
        console.log(`[SSE] Connection opened for session ${sessionId}`);

        // ── 超时机制 ①：无事件超时 ──
        // 连接打开后，如果 15 秒内没有收到有意义的事件（eventCount <= 1，
        // 即只收到初始的 connected 事件），说明后端可能没有在流式传输。
        // 此时查询后端状态，如果后端确认不在流式传输，则关闭 SSE 连接。
        //
        // 典型场景：用户刷新页面后，SSE 重连但会话已经完成流式传输
        state.noEventTimeout = setTimeout(() => {
            const st = streamingSessions.get(sessionId);
            if (!st || st.finished) return;
            // eventCount <= 1 表示只收到了 connected 事件，没有收到任何 AI 响应事件
            if (st.eventCount <= 1) {
                console.warn(`[SSE] No meaningful events received for 15s for session ${sessionId}`);
                // 向后端查询是否仍在流式传输
                checkBackendStreamingStatus(sessionId, () => {
                    // 后端确认不在流式传输 → 关闭 SSE
                    console.warn(`[SSE] Backend not streaming, closing SSE for session ${sessionId}`);
                    finishStreaming(sessionId);
                });
            }
        }, 15000);
    };

    // ══════════════════════════════════════════════════════════════
    //  接收消息事件
    // ══════════════════════════════════════════════════════════════
    es.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);

            // ── 更新事件计数和最后事件时间 ──
            // lastEventTime 是安全超时机制的核心：每次收到事件都更新，
            // 安全超时定时器检查这个时间来判断是否有活动
            state.eventCount = (state.eventCount || 0) + 1;
            state.lastEventTime = Date.now();

            // ── 清除无事件超时 ──
            // 收到第 2 个事件后（第 1 个是 connected），说明后端在正常发送事件，
            // 清除无事件超时定时器，避免误触发
            if (state.noEventTimeout && state.eventCount > 1) {
                clearTimeout(state.noEventTimeout);
                state.noEventTimeout = null;
            }

            console.log(`[SSE] Received event #${state.eventCount} for session ${sessionId}:`, data.type);
            // 分发事件到处理器（thinking/chunk/tool_call/result 等）
            handleStreamEvent(sessionId, data);
        } catch (err) {
            console.error('[SSE] Parse error:', err, 'Raw data:', e.data);
        }
    };

    // ══════════════════════════════════════════════════════════════
    //  连接错误事件
    // ══════════════════════════════════════════════════════════════
    es.onerror = (err) => {
        const st = streamingSessions.get(sessionId);
        console.error(`[SSE] Error for session ${sessionId}, readyState=${es.readyState}, finished=${st?.finished}`);
        // 如果已经完成或状态不存在，忽略错误
        if (!st || st.finished) return;
        // 如果 prompt 还没发送（连接还没完全建立），尝试重连一次
        if (!st.promptSent) {
            setTimeout(() => {
                const st2 = streamingSessions.get(sessionId);
                if (st2 && !st2.finished && es.readyState === EventSource.CLOSED && !st2.promptSent) {
                    console.log(`[SSE] Attempting reconnect for session ${sessionId}`);
                    connectSSE(sessionId, message, onDone);
                }
            }, 1000);
        }
    };

    // ══════════════════════════════════════════════════════════════
    //  超时机制 ②：安全超时（无活动超时）
    // ══════════════════════════════════════════════════════════════
    //
    //  工作原理：
    //  - 每 30 秒检查一次 lastEventTime（在 onmessage 中更新）
    //  - 如果距离上次事件超过 120 秒，认为连接已死，调用 finishStreaming
    //  - 只要还在收到事件，每次检查都会发现 timeSinceLastEvent < 120s，不做任何操作
    //
    //  为什么用 setInterval 而不是 setTimeout：
    //  - setTimeout(120s) 是硬性截止：不管是否在接收事件，120 秒后直接杀掉
    //  - 这会误杀长时间运行的工具调用（如编译、大文件读取超过 2 分钟）
    //  - setInterval + lastEventTime 实现"无活动超时"：活跃的流永远不会被杀
    //
    //  触发场景：
    //  - 后端进程崩溃，不再发送任何事件
    //  - 网络断开，EventSource 没有触发 onerror（某些浏览器行为）
    //  - 后端发送了 result 但前端没收到（极端网络情况）
    state.safetyTimeout = setInterval(() => {
        const st = streamingSessions.get(sessionId);
        // 如果已完成或状态不存在，自清理定时器
        if (!st || st.finished) { clearInterval(state.safetyTimeout); return; }
        // 计算距离上次事件的时间
        const timeSinceLastEvent = Date.now() - (st.lastEventTime || st._startTime);
        if (timeSinceLastEvent > 120000) {
            console.warn(`[SSE] No events for ${Math.round(timeSinceLastEvent/1000)}s, closing SSE for ${sessionId}`);
            clearInterval(state.safetyTimeout);
            finishStreaming(sessionId);
        }
    }, 30000); // 每 30 秒检查一次

    // ══════════════════════════════════════════════════════════════
    //  超时机制 ③：心跳检查
    // ══════════════════════════════════════════════════════════════
    //
    //  工作原理：
    //  - 每 10 秒检查一次 lastHeartbeat（在 connected 和 heartbeat 事件中更新）
    //  - 后端 SSE endpoint 每 15 秒发送一次 heartbeat 事件（通过 broadcast channel）
    //  - 如果超过 30 秒没有心跳，认为连接可能断开
    //  - 此时向后端查询 isStreaming 状态，如果后端确认不在流式传输，关闭 SSE
    //
    //  与安全超时的区别：
    //  - 安全超时检查 lastEventTime（任何事件都算）
    //  - 心跳检查只检查 heartbeat 事件（后端 SSE endpoint 发送的 keepalive）
    //  - 心跳检查更精确：即使 AI 没有产生事件，后端心跳也会每 15 秒到达
    //  - 如果心跳也停了，说明 SSE 连接本身出了问题（网络断开等）
    state.heartbeatCheck = setInterval(async () => {
        const st = streamingSessions.get(sessionId);
        // 如果已完成或状态不存在，自清理定时器
        if (!st || st.finished) {
            clearInterval(state.heartbeatCheck);
            return;
        }

        const now = Date.now();
        const lastHeartbeat = st.lastHeartbeat || st._startTime;
        const timeSinceHeartbeat = now - lastHeartbeat;

        // 超过 30 秒没有心跳 → 向后端查询状态
        if (timeSinceHeartbeat > 30000) {
            console.warn(`[SSE] Heartbeat timeout (${timeSinceHeartbeat}ms) for session ${sessionId}`);
            try {
                const res = await fetch(`${API_BASE}/api/agent/${sessionId}`);
                const data = await res.json();
                console.log(`[SSE] Backend state for ${sessionId}:`, data.state);
                // 后端确认不在流式传输 → 关闭 SSE
                if (!data.state?.isStreaming) {
                    console.warn(`[SSE] Backend not streaming, closing SSE for ${sessionId}`);
                    finishStreaming(sessionId);
                    clearInterval(state.heartbeatCheck);
                }
                // 如果后端仍在流式传输但心跳停了，可能是网络抖动，
                // 不做处理，让安全超时机制 ② 兜底
            } catch (e) {
                console.error('[SSE] Heartbeat check failed:', e);
                // 网络请求失败，可能是网络断开，不做处理
                // 让安全超时机制 ② 兜底
            }
        }
    }, 10000); // 每 10 秒检查一次

    renderSessionList(); // Update sidebar indicators
    console.log(`[SSE] Connected to session ${sessionId}`);

    return state;
}

function handleStreamEvent(sessionId, event) {
    const st = streamingSessions.get(sessionId);
    if (!st || st.finished) return;
    const isCurrent = sessionId === currentSessionId;

    function ensureDiv() {
        // 检查 streamingDiv 是否仍在 DOM 中（面板模式下 renderGrid 会重建 DOM）
        if (st.streamingDiv && !document.body.contains(st.streamingDiv)) {
            // DOM 已被重建，需要重新获取引用
            st.streamingDiv = null;
            st.contentDiv = null;
        }

        if (!st.streamingDiv) {
            // 如果是面板模式（有 panelId），在面板中创建流式消息 div
            if (st.panelId) {
                const chatDiv = document.getElementById(`panel-chat-${st.panelId}`);
                if (chatDiv) {
                    // 移除 Thinking 指示器（内容即将开始渲染）
                    const thinkingIndicator = chatDiv.querySelector('.panel-thinking-indicator');
                    if (thinkingIndicator) thinkingIndicator.remove();

                    const div = document.createElement('div');
                    div.className = 'message assistant streaming';
                    const contentDiv = document.createElement('div');
                    contentDiv.className = 'message-content';
                    div.appendChild(contentDiv);
                    chatDiv.appendChild(div);
                    st.streamingDiv = div;
                    st.contentDiv = contentDiv;
                }
            } else {
                st.streamingDiv = createStreamingMessage(sessionId);
                st.contentDiv = st.streamingDiv.querySelector('.message-content');
            }
        }
    }

    switch (event.type) {
        case 'connected':
            if (st._message && !st.promptSent) { st.promptSent = true; sendStartPrompt(sessionId, st._message); }
            st.lastHeartbeat = Date.now();
            break;
        case 'heartbeat':
            // Update last heartbeat time to detect connection issues
            st.lastHeartbeat = Date.now();
            break;
        case 'start':
            // Remove switching indicator if present
            const switchingIndicator = document.getElementById('switching-indicator');
            if (switchingIndicator) switchingIndicator.remove();

            if (st.panelId) {
                // 面板模式：更新面板的流式状态 + 显示 Thinking 指示器
                splitViewManager.updatePanelStreaming(st.panelId, true);
                const chatDiv = document.getElementById(`panel-chat-${st.panelId}`);
                if (chatDiv) {
                    // 先移除旧的 Thinking 指示器（可能是上次 abort 残留的）
                    chatDiv.querySelectorAll('.panel-thinking-indicator').forEach(el => el.remove());
                    const icon = ASSISTANT_ICONS[st.assistant] || ASSISTANT_ICONS.default;
                    const thinkingDiv = document.createElement('div');
                    thinkingDiv.className = 'panel-thinking-indicator';
                    thinkingDiv.innerHTML = `<span class="assistant-name">${icon} ${st.assistant}</span> <span class="thinking-text">Thinking...</span>`;
                    chatDiv.appendChild(thinkingDiv);
                    chatDiv.scrollTop = chatDiv.scrollHeight;
                }
            } else if (isCurrent) {
                typingIndicator.style.display = 'block';
                typingIndicator.querySelector('.assistant-name').textContent =
                    (sessions.find(s => s.id === sessionId) || {}).assistant || currentAssistant;
            }
            renderSessionList();
            break;
        case 'thinking':
            ensureDiv();
            const te = document.createElement('div');
            te.innerHTML = renderThinkingBlock(event.thinking);
            // Insert thinking block before any text blocks
            const firstTextBlock = st.contentDiv.querySelector('.text-block');
            if (firstTextBlock) {
                st.contentDiv.insertBefore(te.firstElementChild, firstTextBlock);
            } else {
                st.contentDiv.appendChild(te.firstElementChild);
            }
            st.hasContent = true;
            st.contentBlocks.push({ type: 'thinking', thinking: event.thinking });
            if (st.panelId) scrollPanelToBottom(st); else if (isCurrent) scrollToBottom();
            break;
        case 'tool_call':
            ensureDiv();
            const tce = document.createElement('div');
            tce.innerHTML = renderToolCallBlock(event.id, event.name, event.input);
            st.contentDiv.appendChild(tce.firstElementChild);
            st.hasContent = true;
            st.toolCallMap[event.id] = { name: event.name, input: event.input };
            st.contentBlocks.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
            if (st.panelId) scrollPanelToBottom(st); else if (isCurrent) scrollToBottom();
            break;
        case 'tool_result':
            ensureDiv();
            const area = st.contentDiv.querySelector(`.tool-result-area[data-tool-id="${event.id}"]`);
            if (area) {
                area.innerHTML = `<div class="tool-result-inline"><div class="tool-result-header"><span class="tool-result-icon">📋</span><span class="tool-result-label">Output</span></div><pre class="tool-result-content">${escapeHtml(event.output)}</pre></div>`;
            } else {
                const re = document.createElement('div');
                re.innerHTML = renderToolResultBlock(event.output);
                st.contentDiv.appendChild(re.firstElementChild);
            }
            st.contentBlocks.push({ type: 'tool_result', tool_use_id: event.id, content: event.output });
            if (st.panelId) scrollPanelToBottom(st); else if (isCurrent) scrollToBottom();
            break;
        case 'chunk':
            ensureDiv();
            let tb = st.contentDiv.querySelector('.text-block:last-child');
            if (!tb || tb.dataset.finalized === 'true') {
                tb = document.createElement('div'); tb.className = 'text-block';
                tb.dataset.rawText = ''; st.contentDiv.appendChild(tb);
            }
            tb.dataset.rawText = (tb.dataset.rawText || '') + event.content;
            tb.innerHTML = renderMarkdown(tb.dataset.rawText);
            st.hasContent = true; st.finalResult += event.content;
            const lb = st.contentBlocks[st.contentBlocks.length - 1];
            if (lb && lb.type === 'text') lb.text += event.content;
            else st.contentBlocks.push({ type: 'text', text: event.content });
            if (st.panelId) scrollPanelToBottom(st); else if (isCurrent) scrollToBottom();
            break;
        case 'result':
            ensureDiv();
            // Always update finalResult if content is provided
            // This handles Pi Agent where turn_end sends the complete response
            if (event.content) {
                st.finalResult = event.content;
                // If no content was streamed yet, display the result
                if (!st.hasContent) {
                    let lt = st.contentDiv.querySelector('.text-block:last-child');
                    if (!lt) { lt = document.createElement('div'); lt.className = 'text-block'; st.contentDiv.appendChild(lt); }
                    lt.innerHTML = renderMarkdown(event.content);
                    lt.dataset.finalized = 'true';
                    if (!st.contentBlocks.some(b => b.type === 'text')) st.contentBlocks.push({ type: 'text', text: event.content });
                }
            }
            finishStreaming(sessionId);
            break;
        case 'error':
            ensureDiv();
            const ee = document.createElement('div');
            ee.className = 'error-block'; ee.textContent = `Error: ${event.message}`;
            st.contentDiv.appendChild(ee);
            finishStreaming(sessionId);
            break;
    }
}

/**
 * 结束 SSE 流式传输
 *
 * 当收到 result 或 error 事件时调用。负责清理所有 SSE 相关资源：
 * 1. 标记流式状态为已完成（finished = true），后续事件被忽略
 * 2. 清除所有 3 个超时/定时器，防止"幽灵定时器"在关闭后触发
 * 3. 关闭 EventSource 连接
 * 4. 从全局 streamingSessions Map 中移除
 * 5. 更新 UI（移除流式指示器、LIVE 标志）
 * 6. 延迟重试加载会话（等待后端清理 streaming_sessions）
 * 7. 触发 onDone 回调（用于助手切换场景）
 * 8. 处理消息队列（等待中的下一条消息）
 *
 * 注意：loadSessions 延迟执行是因为后端清理 streaming_sessions 需要时间，
 * 如果立即查询会得到 isStreaming=true 的过期状态。
 * 使用指数退避重试（200ms, 400ms, 600ms, 1000ms, 1500ms）。
 *
 * @param {string} sessionId - 会话ID
 */
function finishStreaming(sessionId) {
    const st = streamingSessions.get(sessionId);
    if (!st || st.finished) {
        console.log(`[finishStreaming] Already finished or not found for session ${sessionId}`);
        return;
    }

    const startTime = st._startTime || Date.now();
    const elapsed = Date.now() - startTime;
    console.log(`[finishStreaming] Called for session ${sessionId}, elapsed=${elapsed}ms, eventCount=${st.eventCount || 0}`);

    // ── 标记完成，后续事件全部忽略 ──
    st.finished = true;

    // ── 清除所有超时/定时器 ──
    // 必须全部清除，否则定时器会在连接关闭后继续触发，
    // 导致重复调用 finishStreaming 或发送无效的后端请求
    if (st.safetyTimeout) clearInterval(st.safetyTimeout);   // 安全超时（setInterval）
    if (st.noEventTimeout) clearTimeout(st.noEventTimeout);  // 无事件超时（setTimeout）
    if (st.heartbeatCheck) clearInterval(st.heartbeatCheck); // 心跳检查（setInterval）

    // ── 关闭 EventSource 连接 ──
    if (st.eventSource) st.eventSource.close();

    // ── 从全局 Map 中移除 ──
    // 移除后侧边栏的 LIVE 标志会消失
    streamingSessions.delete(sessionId);

    // Update UI: remove streaming indicators
    if (st.panelId) {
        // 面板模式：更新面板的流式状态
        splitViewManager.updatePanelStreaming(st.panelId, false);
    } else {
        const isCurrent = sessionId === currentSessionId;
        if (isCurrent) {
            sendBtn.classList.remove('streaming');
            stopBtn.style.display = 'none';
            typingIndicator.style.display = 'none';
        }
    }
    if (st.streamingDiv) st.streamingDiv.classList.remove('streaming');

    // Refresh file browser after AI finishes responding
    if (fileBrowserExpanded && currentBrowsePath) {
        refreshFiles();
    }

    // Delay loadSessions to let the backend clean up streaming_sessions first.
    // Use retry logic with exponential backoff for reliability.
    const retryLoadSessions = async () => {
        const delays = [200, 400, 600, 1000, 1500]; // Exponential backoff
        let cleaned = false;
        
        for (let i = 0; i < delays.length; i++) {
            const delay = delays[i];
            console.log(`[finishStreaming] Retry ${i+1}/${delays.length}, waiting ${delay}ms for session ${sessionId}`);
            await new Promise(r => setTimeout(r, delay));
            try {
                await loadSessions();
                const session = sessions.find(s => s.id === sessionId);
                const isStreaming = session?.isStreaming;
                console.log(`[finishStreaming] Backend isStreaming=${isStreaming} for session ${sessionId}`);
                
                if (!isStreaming) {
                    cleaned = true;
                    console.log(`[finishStreaming] ✓ Backend confirmed not streaming for session ${sessionId}`);
                    break;
                }
            } catch (e) {
                console.warn(`[finishStreaming] loadSessions failed:`, e);
            }
        }
        
        if (!cleaned) {
            console.warn(`[finishStreaming] ⚠ Backend still reports streaming for ${sessionId}, forcing local cleanup`);
            // Force update local sessions array to remove streaming status
            const session = sessions.find(s => s.id === sessionId);
            if (session) session.isStreaming = false;
        }
        
        renderSessionList();
    };
    
    retryLoadSessions();
    // Fire the onDone callback if set (used by assistant switching
    // to show the "Switched from X to Y" system message)
    if (st._onDone) st._onDone();
    // Process any queued messages for this session
    processSessionQueue(sessionId);
}

/**
 * 强制清理会话的流式传输状态
 *
 * 用于中止会话 (abortSession) 或删除会话 (deleteSession) 时调用。
 * 与 finishStreaming 不同，这个函数不触发 onDone 回调、不处理消息队列、
 * 不重试加载会话——因为会话已经被中止或删除了。
 *
 * 必须清除所有超时/定时器，否则：
 * - safetyTimeout 会在关闭后继续检查并尝试调用 finishStreaming
 * - noEventTimeout 会触发 checkBackendStreamingStatus 请求已删除的会话
 * - heartbeatCheck 会持续轮询后端（浪费资源）
 *
 * @param {string} sessionId - 会话ID
 */
function cleanupSessionStreaming(sessionId) {
    const st = streamingSessions.get(sessionId);
    if (st) {
        st.finished = true;
        // 清除所有超时/定时器，防止"幽灵定时器"
        if (st.safetyTimeout) clearInterval(st.safetyTimeout);
        if (st.noEventTimeout) clearTimeout(st.noEventTimeout);
        if (st.heartbeatCheck) clearInterval(st.heartbeatCheck);
        // 关闭 EventSource 连接
        if (st.eventSource) st.eventSource.close();
        // 从全局 Map 中移除
        streamingSessions.delete(sessionId);
    }
}

// ===== Per-Session Queue =====

function processSessionQueue(sessionId) {
    const queue = messageQueues.get(sessionId);
    if (!queue || queue.length === 0) { messageQueues.delete(sessionId); updateQueueUI(sessionId); return; }
    if (streamingSessions.has(sessionId)) return;
    const nextMsg = queue.shift();
    updateQueueUI(sessionId);

    // 查找该会话是否在面板中
    const panelId = findPanelIdForSession(sessionId);
    if (panelId) {
        // 面板模式：通过面板发送，SSE 连接到面板
        sendToPanelWithMessage(panelId, nextMsg);
    } else if (sessionId === currentSessionId) {
        sendToSession(nextMsg);
    } else {
        sendToBackgroundSession(sessionId, nextMsg);
    }
}

async function sendToBackgroundSession(sessionId, message) {
    try {
        // 先在会话的 DOM 视图中添加用户消息（如果视图已创建）
        const view = sessionViews.get(sessionId);
        if (view) {
            const session = sessions.find(s => s.id === sessionId);
            const assistant = session?.assistant || 'claude';
            addMessageToView(view, 'user', message, assistant);
        }

        const res = await fetch(`${API_BASE}/api/agent/${sessionId}/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (data.success) {
            const st = connectSSE(sessionId, null);
            st._message = null; // Already sent via start endpoint
        }
    } catch (e) { console.error('Background send error:', e); }
}

/**
 * 向指定会话视图添加消息（不切换当前视图）
 * @param {HTMLElement} view - 会话的 DOM 视图
 * @param {string} role - 'user' 或 'assistant'
 * @param {string} content - 消息内容
 * @param {string} assistant - 助手名称
 */
function addMessageToView(view, role, content, assistant) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (role === 'assistant') {
        const a = assistant || 'assistant';
        const icon = ASSISTANT_ICONS[a] || ASSISTANT_ICONS.default;
        div.innerHTML = `<div class="assistant-label">${icon} ${a}</div><div class="message-content"></div>`;
    } else {
        div.innerHTML = `<div class="message-content">${escapeHtml(content)}</div>`;
    }
    view.appendChild(div);
}

/**
 * 更新队列 UI 显示
 * 队列显示在消息输入框上方（普通模式和面板模式一致）
 *
 * @param {string} [targetSessionId] - 指定要更新的会话ID（不传则更新所有有队列的会话）
 */
function updateQueueUI(targetSessionId) {
    // 先清理不属于当前可见视图的队列元素
    // （切换会话后，旧会话的队列 DOM 可能残留在新会话的视图中）
    document.querySelectorAll('[id^="queueStatus-"]').forEach(el => {
        const sid = el.id.replace('queueStatus-', '');
        const panelId = findPanelIdForSession(sid);
        // 如果该会话既不在面板中，也不是当前会话，且不在 targetSessionId 中，清理
        const isTargeted = targetSessionId === sid;
        const isPanelSession = panelId !== null;
        const isCurrentSession = sid === currentSessionId;
        if (!isTargeted && !isPanelSession && !isCurrentSession) {
            el.remove();
        }
    });

    const sessionIds = targetSessionId
        ? [targetSessionId]
        : [...messageQueues.keys()];

    for (const sid of sessionIds) {
        const queue = messageQueues.get(sid);
        const queueId = `queueStatus-${sid}`;

        // 找到输入框容器，在其上方插入队列
        const panelId = findPanelIdForSession(sid);
        const inputContainer = panelId
            ? document.getElementById(`panel-chat-${panelId}`)?.parentElement?.querySelector('.panel-input')
            : (sid === currentSessionId ? document.getElementById('inputArea') : null);
        if (!inputContainer) continue;

        // 在输入框的父容器中查找已有的队列元素
        const parent = inputContainer.parentElement;
        const existing = parent.querySelector(`#${queueId}`);

        if (queue && queue.length > 0) {
            let html = `<div class="queue-header">📨 ${queue.length} message(s) queued <button class="queue-clear-btn" onclick="clearSessionQueue('${sid}')">Clear</button></div>`;
            queue.forEach((msg, i) => {
                const preview = msg.length > 50 ? msg.slice(0, 50) + '...' : msg;
                html += `<div class="queue-item" onclick="removeFromSessionQueue('${sid}', ${i})" title="Click to remove"><span class="queue-item-text">${escapeHtml(preview)}</span><span class="queue-item-remove">×</span></div>`;
            });
            if (existing) {
                existing.innerHTML = html;
            } else {
                const div = document.createElement('div');
                div.id = queueId;
                div.className = 'queue-status';
                div.innerHTML = html;
                // 插入到输入框上方
                parent.insertBefore(div, inputContainer);
            }
        } else if (existing) {
            existing.remove();
        }
    }
}

function removeFromSessionQueue(sessionId, index) {
    const queue = messageQueues.get(sessionId);
    if (queue) {
        queue.splice(index, 1);
        if (queue.length === 0) messageQueues.delete(sessionId);
        updateQueueUI(sessionId);
    }
}
function clearSessionQueue(sessionId) {
    messageQueues.delete(sessionId);
    updateQueueUI(sessionId);
}
// 兼容旧调用
function removeFromCurrentQueue(index) { removeFromSessionQueue(currentSessionId, index); }
function clearCurrentQueue() { clearSessionQueue(currentSessionId); }

// ===== Send Messages =====

async function sendStartPrompt(sessionId, message) {
    try {
        const res = await fetch(`${API_BASE}/api/agent/${sessionId}/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (!data.success) console.error('Start prompt failed:', data.error);
    } catch (e) { console.error('Start prompt error:', e); }
}

async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    if (!currentSessionId) {
        if (pendingCwd) { await createSessionWithMessage(pendingCwd, message); }
        else { newSessionForm.style.display = 'block'; cwdInput.focus(); }
        return;
    }

    // If current session is streaming, queue the message
    if (streamingSessions.has(currentSessionId)) {
        if (!messageQueues.has(currentSessionId)) messageQueues.set(currentSessionId, []);
        messageQueues.get(currentSessionId).push(message);
        messageInput.value = ''; messageInput.style.height = 'auto';
        sendBtn.classList.add('streaming');
        updateQueueUI();
        return;
    }

    await sendToSession(message);
}

// ===== Create Session with First Message =====
// Creates a new session and sends the first message in one flow.
// Called when the user types a message and presses Enter without an active session.
//
// Flow:
// 1. Create session via POST /api/agent/new
// 2. Add user message to the session view (this also creates the view DOM element)
// 3. Show the session view (set display: block)
// 4. Connect SSE and send the prompt to the backend
// 5. Stream the AI's response in real-time
//
// Note: addMessage MUST be called before showSessionView, because addMessage
// internally calls getSessionView() which creates the session view DOM element
// and adds it to the sessionViews Map. showSessionView then finds it in the
// Map and sets display: block.
async function createSessionWithMessage(cwd, message) {
    const assistant = currentAssistant;
    try {
        sendBtn.classList.add('streaming');
        messageInput.value = ''; messageInput.style.height = 'auto';
        stopBtn.style.display = 'inline-flex';
        typingIndicator.style.display = 'block';
        typingIndicator.querySelector('.assistant-name').textContent = assistant;

        // Step 1: Create the session on the backend
        const res = await fetch(`${API_BASE}/api/agent/new`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd, model: null, assistant })
        });
        const data = await res.json();

        if (data.success) {
            currentSessionId = data.sessionId;
            currentAssistant = data.assistant || assistant;
            pendingCwd = null;

            // Step 2-3: Show chat UI, add user message, then show the session view
            welcomeScreen.style.display = 'none';
            chatContainer.style.display = 'flex'; chatContainer.style.flexDirection = 'column';
            addMessage('user', message, assistant, data.sessionId);  // creates session view
            showSessionView(data.sessionId);                          // makes it visible

            // Step 4: Refresh session list and connect SSE for streaming
            await loadSessions(); renderSessionList();

            // Connect SSE — message is passed to connectSSE and stored in state
            connectSSE(data.sessionId, message);
        } else {
            addMessage('assistant', `Error: ${data.error}`, assistant, '__error__');
            sendBtn.classList.remove('streaming'); typingIndicator.style.display = 'none';
        }
    } catch (e) {
        addMessage('assistant', `Error: ${e.message}`, assistant, '__error__');
        sendBtn.classList.remove('streaming'); typingIndicator.style.display = 'none';
    }
}

async function sendToSession(message, onDone) {
    try {
        sendBtn.classList.add('streaming');
        messageInput.value = ''; messageInput.style.height = 'auto';
        addMessage('user', message, null, currentSessionId);
        typingIndicator.style.display = 'block';
        typingIndicator.querySelector('.assistant-name').textContent = currentAssistant;
        stopBtn.style.display = 'inline-flex';
        await loadSessions();

        connectSSE(currentSessionId, message, onDone);
    } catch (e) {
        addMessage('assistant', `Error: ${e.message}`, currentAssistant, currentSessionId);
        sendBtn.classList.remove('streaming'); typingIndicator.style.display = 'none';
    }
}

// ===== Abort =====

async function abortSession(sessionId) {
    sessionId = sessionId || currentSessionId;
    if (!sessionId) return;

    // 立即标记流为完成 + 关闭 EventSource，防止后续事件被渲染到错误的位置
    // 必须在 await fetch 之前执行，否则旧 SSE 可能在 POST 完成前收到 result 事件
    cleanupSessionStreaming(sessionId);
    if (sessionId === currentSessionId) {
        sendBtn.classList.remove('streaming'); stopBtn.style.display = 'none'; typingIndicator.style.display = 'none';
        const sm = getSessionView(sessionId)?.querySelector('.message.streaming');
        if (sm) sm.classList.remove('streaming');
    }

    try { await fetch(`${API_BASE}/api/agent/${sessionId}/abort`, { method: 'POST' }); } catch (e) { console.error('Abort failed:', e); }
    loadSessions().then(() => renderSessionList());
    setTimeout(() => processSessionQueue(sessionId), 500);
}

// ===== Create Session (form) =====

async function createSession() {
    const cwd = cwdInput.value.trim();
    if (!cwd) { alert('Please enter a working directory'); return; }
    const model = modelSelectNew.value;
    newSessionForm.style.display = 'none'; cwdInput.value = '';

    // Show welcome screen, hide chat container
    welcomeScreen.style.display = 'flex';
    chatContainer.style.display = 'none';
    inputArea.style.display = 'block';

    currentSessionId = null;
    currentModel = model; pendingCwd = cwd;
    modelSelector.value = model; statusDisplay.textContent = model;
    sendBtn.classList.remove('streaming'); stopBtn.style.display = 'none'; typingIndicator.style.display = 'none';
    renderSessionList(); messageInput.focus();
}

// ===== File Browser =====

function toggleFileBrowser() {
    fileBrowserExpanded = !fileBrowserExpanded;
    document.getElementById('fileBrowserContent').style.display = fileBrowserExpanded ? 'block' : 'none';
    document.getElementById('fileBrowserToggle').textContent = fileBrowserExpanded ? '▼' : '▶';
    if (fileBrowserExpanded && currentBrowsePath) loadFiles(currentBrowsePath);
}

async function loadFiles(dirPath) {
    currentBrowsePath = dirPath;
    const fileList = document.getElementById('fileList');
    document.getElementById('fileBrowserPath').textContent = dirPath.split(/[/\\]/).slice(-2).join('/');
    try {
        const res = await fetch(`${API_BASE}/api/files?path=${encodeURIComponent(dirPath)}`);
        const data = await res.json();
        if (!data.success) { fileList.innerHTML = `<div class="file-error">${escapeHtml(data.error)}</div>`; return; }
        fileList.innerHTML = '';
        if (data.parent) {
            const p = createFileItem('⬆️', '..', '', true); p.onclick = () => loadFiles(data.parent); p.classList.add('file-parent'); fileList.appendChild(p);
        }
        data.files.forEach(f => {
            const icon = f.is_dir ? '📁' : getFileIcon(f.name);
            const item = createFileItem(icon, f.name, f.is_dir ? '' : formatFileSize(f.size), f.is_dir);
            item.onclick = () => f.is_dir ? loadFiles(f.path) : viewFile(f.path);
            fileList.appendChild(item);
        });
        if (fileList.children.length === 0) fileList.innerHTML = '<div class="file-empty">Empty directory</div>';
    } catch (e) { fileList.innerHTML = `<div class="file-error">Failed to load</div>`; }
}

function refreshFiles() {
    if (currentBrowsePath) {
        loadFiles(currentBrowsePath);
    }
}

function createFileItem(icon, name, size, isDir) {
    const div = document.createElement('div');
    div.className = `file-item ${isDir ? 'is-dir' : 'is-file'}`;
    div.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(name)}</span><span class="file-size">${size}</span>`;
    return div;
}

function getFileIcon(name) {
    const ext = name.split('.').pop()?.toLowerCase();
    const icons = { 'rs':'🦀','js':'📜','ts':'📘','py':'🐍','go':'🔵','html':'🌐','css':'🎨','json':'📋','toml':'⚙️','yaml':'⚙️','yml':'⚙️','md':'📝','txt':'📄','log':'📃','png':'🖼️','jpg':'🖼️','gif':'🖼️','svg':'🖼️','sh':'💻','bat':'💻','cmd':'💻','ps1':'💻','exe':'⚙️','dll':'⚙️','so':'⚙️','zip':'📦','tar':'📦','gz':'📦','lock':'🔒','env':'🔐' };
    return icons[ext] || '📄';
}

function formatFileSize(bytes) {
    if (bytes === 0) return '';
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
    return (bytes / (1024 * 1024)).toFixed(1) + 'M';
}

async function viewFile(filePath) {
    try {
        const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(filePath)}`);
        const data = await res.json();
        if (data.success) showFileContent(filePath, data.content); else alert(data.error);
    } catch (e) { alert('Failed to read file'); }
}

function showFileContent(filePath, content) {
    const fileName = filePath.split(/[/\\]/).pop();
    const overlay = document.createElement('div');
    overlay.className = 'file-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `<div class="file-viewer"><div class="file-viewer-header"><span class="file-viewer-name">📄 ${escapeHtml(fileName)}</span><button class="file-viewer-close" onclick="this.closest('.file-overlay').remove()">×</button></div><pre class="file-viewer-content">${escapeHtml(content)}</pre></div>`;
    document.body.appendChild(overlay);
}

// ===== Event Listeners =====

function setupEventListeners() {
    toggleSidebar.onclick = () => sidebar.classList.toggle('closed');
    newSessionBtn.onclick = () => { newSessionForm.style.display = newSessionForm.style.display === 'none' ? 'block' : 'none'; };
    cancelSessionBtn.onclick = () => { newSessionForm.style.display = 'none'; cwdInput.value = ''; };
    createSessionBtn.onclick = createSession;
    // 使用箭头函数调用 sendMessage()（按名称解析），这样猴子补丁能生效
    sendBtn.onclick = () => sendMessage();
    messageInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
    messageInput.oninput = () => { messageInput.style.height = 'auto'; messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px'; };
    assistantSelector.onchange = (e) => selectAssistant(e.target.value);
    switchAssistantBtn.onclick = switchAssistant;
    stopBtn.onclick = () => abortSession(currentSessionId);
    modelSelector.onchange = async (e) => {
        currentModel = e.target.value; statusDisplay.textContent = currentModel;
        if (currentSessionId) {
            try { await fetch(`${API_BASE}/api/agent/${currentSessionId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'set_model', model: currentModel }) }); }
            catch (e) { console.error('Failed to set model:', e); }
        }
    };
    cwdInput.onkeydown = (e) => { if (e.key === 'Enter') createSession(); };
    
    // Split view event listeners
    document.getElementById('toggleSplitView').onclick = toggleSplitView;
    document.getElementById('splitLayoutSelect').onchange = (e) => splitViewManager.setLayout(e.target.value);
    document.getElementById('addPanelBtn').onclick = openAddPanelModal;
    document.getElementById('toggleSyncMode').onclick = toggleSyncMode;

    // Theme toggle
    document.getElementById('themeToggle').onclick = toggleTheme;

    // 文件浏览器拖拽调整高度
    initFileBrowserResize();
}

/**
 * 初始化文件浏览器的拖拽调整高度功能
 *
 * 拖拽手柄位于文件浏览器顶部，上下拖拽可调整高度。
 * 高度持久化到 localStorage。
 */
function initFileBrowserResize() {
    const handle = document.getElementById('fileBrowserResize');
    const fileBrowser = document.getElementById('fileBrowser');
    if (!handle || !fileBrowser) return;

    // 从 localStorage 恢复上次的高度
    const savedHeight = localStorage.getItem('cc-web-file-browser-height');
    if (savedHeight) fileBrowser.style.height = savedHeight + 'px';

    let startY = 0;
    let startHeight = 0;
    let isDragging = false;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isDragging = true;
        startY = e.clientY;
        startHeight = fileBrowser.offsetHeight;
        handle.classList.add('dragging');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        // 向上拖动 = 减小高度（handle 在底部，鼠标上移 = 高度减小）
        const delta = startY - e.clientY;
        const newHeight = Math.max(60, startHeight + delta);
        fileBrowser.style.height = newHeight + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // 持久化高度
        localStorage.setItem('cc-web-file-browser-height', fileBrowser.offsetHeight);
    });
}

init();


// ╔══════════════════════════════════════════════════════════════════╗
// ║                    分屏视图管理器 (SPLIT VIEW MANAGER)            ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * SplitViewManager - 分屏视图管理器
 * 
 * 功能：
 * 1. 支持多种网格布局（1x1, 2x1, 1x2, 2x2, 3x2, 3x3）
 * 2. 每个面板独立运行一个 AI 会话
 * 3. 支持同步模式：一个输入同时发送到所有面板
 * 4. 面板可以独立添加、删除、设置活跃状态
 * 
 * 数据结构：
 * - panels: Map<panelId, { sessionId, element, streamingState, sessionInfo }>
 * - panelOrder: Array<panelId> - 面板显示顺序（从左到右，从上到下）
 * - layout: 当前网格布局（如 '2x2' 表示 2列2行）
 * - activePanelId: 当前活跃的面板ID
 * - syncMode: 是否开启同步模式
 * - syncSourcePanelId: 同步源面板ID（发送消息的面板）
 */
class SplitViewManager {
    constructor() {
        /** @type {boolean} 是否启用分屏模式 */
        this.enabled = false;
        
        /** @type {string} 当前网格布局，格式为 '列数x行数' */
        this.layout = '2x2';
        
        /** @type {Map<string, object>} 面板集合，key为panelId */
        this.panels = new Map();
        
        /** @type {Array<string>} 面板显示顺序数组 */
        this.panelOrder = [];
        
        /** @type {string|null} 当前活跃面板的ID */
        this.activePanelId = null;
        
        /** @type {boolean} 是否开启同步模式 */
        this.syncMode = false;
        
        /** @type {string|null} 同步源面板ID（消息从这个面板广播到其他面板） */
        this.syncSourcePanelId = null;
        
        /** @type {number} 面板计数器，用于生成唯一ID */
        this.panelCounter = 0;
        
        /** @type {number} 最大面板数量限制 */
        this.maxPanels = 9;
    }

    /**
     * 切换分屏模式的启用/禁用状态
     * 
     * 工作流程：
     * 1. 切换 enabled 状态
     * 2. 显示/隐藏单屏和分屏容器
     * 3. 显示/隐藏分屏控制按钮（布局选择、添加面板、同步模式）
     * 4. 如果启用分屏且有当前会话，自动添加为第一个面板
     * 5. 如果禁用分屏，重新加载当前会话的消息到单屏视图
     * 6. 更新侧边栏会话列表
     */
    toggle() {
        this.enabled = !this.enabled;
        
        // 获取相关 DOM 元素
        const singleView = document.getElementById('singleViewContainer');  // 单屏容器
        const splitView = document.getElementById('splitViewContainer');    // 分屏容器
        const layoutSelect = document.getElementById('splitLayoutSelect');  // 布局选择下拉框
        const addBtn = document.getElementById('addPanelBtn');              // 添加面板按钮
        const syncBtn = document.getElementById('toggleSyncMode');          // 同步模式按钮
        
        if (this.enabled) {
            // ── 启用分屏模式 ──
            singleView.style.display = 'none';      // 隐藏单屏
            splitView.style.display = 'flex';        // 显示分屏
            layoutSelect.style.display = 'inline-block';  // 显示布局选择
            addBtn.style.display = 'inline-flex';    // 显示添加按钮
            syncBtn.style.display = 'inline-flex';   // 显示同步按钮
            
            // 如果有当前会话且面板为空，自动添加为第一个面板
            if (currentSessionId && this.panels.size === 0) {
                this.addPanel(currentSessionId);
            }
            
            this.renderGrid();  // 渲染网格布局
        } else {
            // ── 禁用分屏模式 ──
            singleView.style.display = 'flex';       // 显示单屏
            splitView.style.display = 'none';         // 隐藏分屏
            layoutSelect.style.display = 'none';      // 隐藏布局选择
            addBtn.style.display = 'none';            // 隐藏添加按钮
            syncBtn.style.display = 'none';           // 隐藏同步按钮
            
            // 关闭同步模式
            this.syncMode = false;
            syncBtn.classList.remove('active');
            document.querySelector('.sync-mode-indicator')?.remove();
            
            // ── 重要：切换回单屏时重新加载当前会话的消息 ──
            // 因为分屏和单屏使用不同的 DOM 容器，需要重新加载
            if (currentSessionId) {
                const view = getSessionView(currentSessionId);
                view.innerHTML = '';  // 清空现有内容
                // 从后端 API 获取完整消息并渲染
                fetch(`${API_BASE}/api/sessions/${currentSessionId}`)
                    .then(res => res.json())
                    .then(data => {
                        if (data.messages) renderMessagesInto(view, data.messages, data.assistant);
                    })
                    .catch(e => console.error('Failed to reload messages:', e));
            }
        }
        
        // 更新分屏按钮的激活状态样式
        document.getElementById('toggleSplitView').classList.toggle('active', this.enabled);
        // 刷新侧边栏会话列表（更新 LIVE 标志等）
        renderSessionList();
    }

    /**
     * 设置网格布局
     * @param {string} layout - 布局格式，如 '2x2', '3x2' 等
     */
    setLayout(layout) {
        this.layout = layout;
        this.renderGrid();  // 重新渲染网格
    }

    /**
     * 获取当前布局的最大面板数量
     * @returns {number} 最大面板数（列数 × 行数）
     */
    getMaxPanelsForLayout() {
        const [cols, rows] = this.layout.split('x').map(Number);
        return cols * rows;
    }

    /**
     * 添加新面板
     * @param {string} sessionId - 要在面板中显示的会话ID
     * @param {number|null} position - 可选，指定面板插入的位置（0-based）
     * @returns {string|null} 新面板的ID，如果达到上限则返回null
     */
    addPanel(sessionId, position = null) {
        const maxPanels = this.getMaxPanelsForLayout();
        // 检查是否达到当前布局的最大面板数
        if (this.panels.size >= maxPanels) {
            alert(`Maximum ${maxPanels} panels for ${this.layout} layout`);
            return null;
        }

        // ── 防重复检查（安全兜底）──
        // 正常情况下下拉框已过滤掉已打开的 session，不会触发这里
        // 但保留检查以防并发操作或 bug 导致重复添加
        for (const [pid, panel] of this.panels) {
            if (panel.sessionId === sessionId) {
                console.warn(`[addPanel] Session ${sessionId} already in panel ${pid}, skipping`);
                return null;
            }
        }

        // 生成唯一面板ID
        const panelId = `panel-${++this.panelCounter}`;
        // 查找会话信息
        const session = sessions.find(s => s.id === sessionId);

        // 存储面板数据
        this.panels.set(panelId, {
            sessionId,           // 关联的会话ID
            element: null,       // DOM元素引用
            streamingState: null,// 流式状态
            sessionInfo: session || null  // 会话信息缓存
        });

        // ── 位置插入逻辑 ──
        // position 是网格位置索引（0-based，从左到右、从上到下）
        // panelOrder 是面板 ID 数组，按显示顺序排列
        // 两者的关系：panelOrder[i] 显示在网格位置 i
        //
        // 例如 2x2 布局：
        //   网格位置 0 (左上) → panelOrder[0]
        //   网格位置 1 (右上) → panelOrder[1]
        //   网格位置 2 (左下) → panelOrder[2]
        //   网格位置 3 (右下) → panelOrder[3]
        //
        // 当用户点击空面板的位置 N 时，position = N
        // 我们需要将新面板放到 panelOrder[N] 的位置
        //
        // 关键：如果 panelOrder.length < N，需要先用 null 填充空位
        // 例如：panelOrder = ["panel-1"], position = 3 (右下)
        //   → 先填充: ["panel-1", null, null]
        //   → 插入:   ["panel-1", null, null, "panel-2"]
        //   → renderGrid 时 null 位置显示空面板
        if (position !== null && position >= 0) {
            // 用 null 填充空位，确保 position 位置可用
            while (this.panelOrder.length < position) {
                this.panelOrder.push(null);
            }
            if (position < this.panelOrder.length) {
                // 替换已有的空位（null）
                this.panelOrder[position] = panelId;
            } else {
                // 追加到末尾
                this.panelOrder.push(panelId);
            }
        } else {
            // 未指定位置，添加到末尾（跳过 null 空位）
            this.panelOrder.push(panelId);
        }

        this.renderGrid();  // 重新渲染网格

        // ── 接管活跃的 SSE 连接 ──
        // 如果该会话正在流式传输（主视图有活跃的 SSE 连接），
        // 需要将流式状态迁移到面板，否则面板看不到实时更新
        this.takeoverStreaming(panelId, sessionId);

        return panelId;
    }

    /**
     * 接管活跃的 SSE 流式连接
     *
     * 当从主视图切换到面板模式时，主视图可能有一个活跃的 SSE 连接。
     * 这个方法将该连接的 DOM 引用重定向到面板的聊天区域，
     * 使流式事件继续在面板中渲染。
     *
     * @param {string} panelId - 面板ID
     * @param {string} sessionId - 会话ID
     */
    takeoverStreaming(panelId, sessionId) {
        const st = streamingSessions.get(sessionId);
        if (!st || st.finished) return;

        // 获取面板的聊天区域 DOM
        const chatDiv = document.getElementById(`panel-chat-${panelId}`);
        if (!chatDiv) return;

        console.log(`[SplitView] Taking over SSE connection for session ${sessionId} → panel ${panelId}`);

        // 将已累积的流式内容迁移到面板
        // （主视图的 handleStreamEvent 已经渲染了部分内容到主视图的 DOM）
        // 我们需要在面板中重建这些内容
        if (st.contentBlocks && st.contentBlocks.length > 0) {
            chatDiv.innerHTML = '';
            const assistant = st.assistant || sessions.find(s => s.id === sessionId)?.assistant || 'claude';
            const tempContainer = document.createElement('div');

            // 重建所有内容块
            st.contentBlocks.forEach(block => {
                if (block.type === 'thinking') {
                    const te = document.createElement('div');
                    te.innerHTML = renderThinkingBlock(block.thinking);
                    tempContainer.appendChild(te.firstElementChild);
                } else if (block.type === 'tool_use') {
                    const tce = document.createElement('div');
                    tce.innerHTML = renderToolCallBlock(block.id, block.name, block.input);
                    tempContainer.appendChild(tce.firstElementChild);
                } else if (block.type === 'text') {
                    const textDiv = document.createElement('div');
                    textDiv.className = 'text-block';
                    textDiv.innerHTML = renderMarkdown(block.text);
                    tempContainer.appendChild(textDiv);
                } else if (block.type === 'tool_result') {
                    // tool_result 需要注入到对应的 tool_use 块
                    const area = tempContainer.querySelector(`.tool-result-area[data-tool-id="${block.tool_use_id}"]`);
                    if (area) {
                        area.innerHTML = `<div class="tool-result-inline"><div class="tool-result-header"><span class="tool-result-icon">📋</span><span class="tool-result-label">Output</span></div><pre class="tool-result-content">${escapeHtml(block.content)}</pre></div>`;
                    }
                }
            });

            chatDiv.appendChild(tempContainer);
            chatDiv.scrollTop = chatDiv.scrollHeight;
        }

        // 重定向 SSE 连接的 DOM 引用到面板
        st.streamingDiv = chatDiv.querySelector('.message.assistant.streaming') ||
                          chatDiv.querySelector('.message.assistant') ||
                          (() => {
                              // 如果没有流式消息 div，创建一个
                              const div = document.createElement('div');
                              div.className = 'message assistant streaming';
                              const contentDiv = document.createElement('div');
                              contentDiv.className = 'message-content';
                              div.appendChild(contentDiv);
                              chatDiv.appendChild(div);
                              return div;
                          })();
        st.contentDiv = st.streamingDiv.querySelector('.message-content');

        // 标记为面板模式（panelId），这样 handlePanelStreamEvent 可以处理后续事件
        st.panelId = panelId;

        // 更新面板的流式状态指示器
        this.updatePanelStreaming(panelId, true);

        console.log(`[SplitView] SSE connection migrated: contentBlocks=${st.contentBlocks.length}, hasContent=${st.hasContent}`);
    }

    /**
     * 删除面板
     * @param {string} panelId - 要删除的面板ID
     */
    removePanel(panelId) {
        const panel = this.panels.get(panelId);
        if (panel) {
            // 如果面板有关联的会话，清理其流式状态
            if (panel.sessionId) {
                cleanupSessionStreaming(panel.sessionId);
            }
            this.panels.delete(panelId);

            // 用 null 替换（保留位置），而非 splice 删除
            // 这样其他面板的位置索引不会改变
            const orderIndex = this.panelOrder.indexOf(panelId);
            if (orderIndex !== -1) {
                this.panelOrder[orderIndex] = null;
            }

            // 如果删除的是当前活跃面板，切换到第一个可用面板
            if (this.activePanelId === panelId) {
                const firstPanel = this.panelOrder.find(id => id !== null);
                this.activePanelId = firstPanel || null;
            }

            this.renderGrid();  // 重新渲染网格（renderGrid 会清理末尾的 null）
        }
    }

    /**
     * 设置活跃面板
     * 活跃面板会高亮显示，表示当前正在操作的面板
     * @param {string} panelId - 面板ID
     */
    setActive(panelId) {
        this.activePanelId = panelId;
        // 更新所有面板的 CSS 类，高亮活跃面板
        document.querySelectorAll('.split-panel').forEach(el => {
            el.classList.toggle('active', el.dataset.panelId === panelId);
        });

        // 同步更新侧边栏、顶栏、文件浏览器
        const panel = this.panels.get(panelId);
        if (!panel || !panel.sessionId) return;
        const sessionId = panel.sessionId;
        const sessionInfo = sessions.find(s => s.id === sessionId);

        // 1. 更新侧边栏选中状态
        currentSessionId = sessionId;
        renderSessionList();

        // 2. 更新顶栏助手/模型选择器
        if (sessionInfo) {
            if (sessionInfo.assistant) {
                currentAssistant = sessionInfo.assistant;
                assistantSelector.value = sessionInfo.assistant;
            }
            if (sessionInfo.model) {
                currentModel = sessionInfo.model;
                modelSelector.value = sessionInfo.model;
                statusDisplay.textContent = sessionInfo.model;
            }
        }

        // 3. 更新文件浏览器目录
        if (sessionInfo?.cwd) {
            currentBrowsePath = sessionInfo.cwd;
            if (fileBrowserExpanded) loadFiles(sessionInfo.cwd);
            else document.getElementById('fileBrowserPath').textContent = sessionInfo.cwd;
        }
    }

    /**
     * 切换同步模式
     * 
     * 同步模式下：
     * - 用户在一个面板输入消息，会同时发送到所有面板
     * - 第一个面板默认为同步源，可以通过 setSyncSource() 更改
     * - 同步源面板显示 "📤 Source" 标记
     * - 其他面板显示绿色边框，表示是同步目标
     */
    toggleSyncMode() {
        this.syncMode = !this.syncMode;
        const syncBtn = document.getElementById('toggleSyncMode');
        syncBtn.classList.toggle('active', this.syncMode);
        
        // 显示/隐藏同步模式指示器（右上角的浮动提示）
        let indicator = document.querySelector('.sync-mode-indicator');
        if (this.syncMode) {
            // 创建或显示指示器
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.className = 'sync-mode-indicator';
                indicator.textContent = '🔗 Sync Mode Active';
                document.body.appendChild(indicator);
            }
            indicator.style.display = 'block';
            
            // 默认将第一个面板设为同步源
            if (this.panels.size > 0 && !this.syncSourcePanelId) {
                this.syncSourcePanelId = this.panels.keys().next().value;
            }
        } else {
            // 隐藏指示器
            if (indicator) indicator.style.display = 'none';
            this.syncSourcePanelId = null;
            // 移除所有面板的同步目标样式
            document.querySelectorAll('.split-panel.sync-target').forEach(el => {
                el.classList.remove('sync-target');
            });
        }
        
        this.updatePanelSyncState();  // 更新面板的同步状态显示
    }

    /**
     * 更新面板的同步状态视觉效果
     * 
     * 同步源面板：显示 "📤 Source" 标记
     * 同步目标面板：添加绿色边框（sync-target CSS 类）
     */
    updatePanelSyncState() {
        document.querySelectorAll('.split-panel').forEach(el => {
            const panelId = el.dataset.panelId;
            if (this.syncMode) {
                if (panelId === this.syncSourcePanelId) {
                    // ── 同步源面板 ──
                    el.classList.remove('sync-target');
                    // 添加 "📤 Source" 标记到面板头部
                    const header = el.querySelector('.panel-header');
                    if (header && !header.querySelector('.sync-source-badge')) {
                        const badge = document.createElement('span');
                        badge.className = 'sync-source-badge';
                        badge.textContent = '📤 Source';
                        badge.style.cssText = 'font-size:10px;background:var(--accent);color:white;padding:2px 6px;border-radius:4px;margin-left:4px;';
                        header.appendChild(badge);
                    }
                } else {
                    // ── 同步目标面板 ──
                    el.classList.add('sync-target');
                }
            } else {
                // ── 同步模式关闭 ──
                el.classList.remove('sync-target');
                el.querySelector('.sync-source-badge')?.remove();
            }
        });
    }

    /**
     * 广播消息到所有面板（同步模式）
     * 
     * 工作流程：
     * 1. 遍历所有面板
     * 2. 为每个面板的消息队列添加消息
     * 3. 使用 setTimeout 错开处理时间，避免同时发送
     * 
     * @param {string} message - 要广播的消息内容
     */
    broadcastMessage(message) {
        if (!this.syncMode) return;

        this.panels.forEach((panel, panelId) => {
            if (panel.sessionId) {
                if (!messageQueues.has(panel.sessionId)) {
                    messageQueues.set(panel.sessionId, []);
                }
                messageQueues.get(panel.sessionId).push(message);
                updateQueueUI(panel.sessionId);

                const panelIndex = [...this.panels.keys()].indexOf(panelId);
                setTimeout(() => processSessionQueue(panel.sessionId), 100 * panelIndex);
            }
        });
    }

    /**
     * 渲染网格布局
     * 
     * 工作流程：
     * 1. 根据 layout 设置 CSS 类（如 layout-2x2）
     * 2. 清空网格容器
     * 3. 渲染已存在的面板
     * 4. 用空面板填充剩余位置
     * 5. 更新同步状态显示
     */
    renderGrid() {
        const grid = document.getElementById('splitGrid');
        grid.className = `split-grid layout-${this.layout}`;  // 设置布局 CSS 类
        grid.innerHTML = '';

        const maxPanels = this.getMaxPanelsForLayout();

        // 按照 panelOrder 顺序渲染面板
        // panelOrder 中可能有 null（空位），需要渲染为空面板占位
        //
        // 例如 2x2 布局，panelOrder = ["panel-1", null, null, "panel-2"]:
        //   网格位置 0 (左上) → panel-1（有内容）
        //   网格位置 1 (右上) → 空面板
        //   网格位置 2 (左下) → 空面板
        //   网格位置 3 (右下) → panel-2（有内容）
        let gridPos = 0;
        for (let i = 0; i < this.panelOrder.length && gridPos < maxPanels; i++) {
            const panelId = this.panelOrder[i];

            if (panelId === null) {
                // ── 空位：渲染空面板占位 ──
                const emptyEl = this.createEmptyPanelElement(gridPos);
                grid.appendChild(emptyEl);
                gridPos++;
            } else {
                const panel = this.panels.get(panelId);
                if (!panel) {
                    // 面板数据不存在（异常），渲染空面板
                    const emptyEl = this.createEmptyPanelElement(gridPos);
                    grid.appendChild(emptyEl);
                    gridPos++;
                    continue;
                }
                const panelEl = this.createPanelElement(panelId, panel);
                grid.appendChild(panelEl);
                panel.element = panelEl;  // 保存 DOM 元素引用
                gridPos++;
            }
        }

        // 用空面板填充剩余位置（panelOrder 末尾没有 null 的情况）
        for (let i = gridPos; i < maxPanels; i++) {
            const emptyEl = this.createEmptyPanelElement(i);
            grid.appendChild(emptyEl);
        }

        // 清理 panelOrder 末尾的 null（避免数组无限增长）
        while (this.panelOrder.length > 0 && this.panelOrder[this.panelOrder.length - 1] === null) {
            this.panelOrder.pop();
        }

        this.updatePanelSyncState();  // 更新同步状态
    }

    /**
     * 创建面板 DOM 元素
     * 
     * 面板结构：
     * ┌─────────────────────────────┐
     * │ 面板头部 (panel-header)      │  <- 显示助手图标、标题、模型、状态、操作按钮
     * ├─────────────────────────────┤
     * │ 聊天区域 (panel-chat)        │  <- 显示消息历史和流式输出
     * ├─────────────────────────────┤
     * │ 输入区域 (panel-input)       │  <- 消息输入框和发送按钮
     * └─────────────────────────────┘
     * 
     * @param {string} panelId - 面板ID
     * @param {object} panel - 面板数据对象
     * @returns {HTMLElement} 面板 DOM 元素
     */
    createPanelElement(panelId, panel) {
        const div = document.createElement('div');
        div.className = `split-panel ${panelId === this.activePanelId ? 'active' : ''}`;
        div.dataset.panelId = panelId;
        
        // 获取会话信息
        const session = panel.sessionInfo || sessions.find(s => s.id === panel.sessionId);
        const assistant = session?.assistant || 'claude';
        const icon = ASSISTANT_ICONS[assistant] || ASSISTANT_ICONS.default;
        const title = session?.firstMessage?.slice(0, 30) || 'Untitled';
        const model = session?.model || '';
        const isStreaming = streamingSessions.has(panel.sessionId);
        
        // 构建面板 HTML 结构
        div.innerHTML = `
            <!-- 面板头部：显示助手信息和操作按钮 -->
            <div class="panel-header">
                <span class="panel-icon">${icon}</span>
                <span class="panel-title" title="${escapeHtml(session?.firstMessage || '')}">${escapeHtml(title)}</span>
                <span class="panel-model">${escapeHtml(model)}</span>
                <span class="panel-status ${isStreaming ? 'streaming' : 'idle'}"></span>
                <div class="panel-actions">
                    <button onclick="splitViewManager.setSyncSource('${panelId}')" title="Set as sync source">📤</button>
                    <button onclick="splitViewManager.removePanel('${panelId}')" title="Remove panel">✕</button>
                </div>
            </div>
            <!-- 聊天区域：显示消息 -->
            <div class="panel-chat" id="panel-chat-${panelId}">
                <div class="panel-loading">Loading...</div>
            </div>
            <!-- 输入区域 -->
            <div class="panel-input">
                <div class="panel-input-wrapper">
                    <textarea id="panel-input-${panelId}" placeholder="Message..." rows="1"></textarea>
                    <button class="send-btn" onclick="sendToPanel('${panelId}')">Send</button>
                    <button class="stop-btn" onclick="abortPanel('${panelId}')" ${isStreaming ? 'style="display:inline-flex"' : 'style="display:none"'}>⏹</button>
                </div>
            </div>
        `;
        
        // 异步加载消息（从 API 获取完整消息历史）
        const chatDiv = div.querySelector('.panel-chat');
        this.loadPanelMessages(panelId, panel.sessionId, chatDiv, assistant);
        
        // 设置 textarea 事件处理
        const textarea = div.querySelector('textarea');
        textarea.onkeydown = (e) => {
            // 按 Enter 发送消息（Shift+Enter 换行）
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendToPanel(panelId);
            }
        };
        textarea.oninput = () => {
            // 自动调整输入框高度
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
        };
        
        // 点击面板设置为活跃状态
        div.onclick = (e) => {
            // 排除点击按钮和操作区域的情况
            if (!e.target.closest('.panel-actions') && !e.target.closest('button')) {
                this.setActive(panelId);
            }
        };
        
        return div;
    }

    /**
     * 从 API 异步加载面板的消息历史
     * 
     * 注意：sessions 列表 API 只返回摘要信息（firstMessage, messageCount 等）
     * 完整的 messages 数组需要通过 /api/sessions/{id} 获取
     * 
     * @param {string} panelId - 面板ID
     * @param {string} sessionId - 会话ID
     * @param {HTMLElement} chatDiv - 聊天区域 DOM 元素
     * @param {string} assistant - 助手名称
     */
    async loadPanelMessages(panelId, sessionId, chatDiv, assistant) {
        try {
            // 调用 API 获取完整会话数据
            const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
            const data = await res.json();
            
            if (data.messages && data.messages.length > 0) {
                // 渲染消息到面板
                this.renderPanelMessages(chatDiv, data.messages, data.assistant || assistant);
            } else {
                chatDiv.innerHTML = '<div class="panel-empty-msg">No messages yet</div>';
            }
        } catch (e) {
            console.error('Failed to load panel messages:', e);
            chatDiv.innerHTML = '<div class="panel-empty-msg">Failed to load messages</div>';
        }
    }

    /**
     * 创建空面板占位元素
     * 当网格中没有足够的会话填充所有位置时，显示空面板
     * @param {number} position - 空面板在网格中的位置（0-based）
     * @returns {HTMLElement} 空面板 DOM 元素
     */
    createEmptyPanelElement(position) {
        const div = document.createElement('div');
        div.className = 'split-panel';
        div.innerHTML = `
            <div class="panel-empty">
                <span class="panel-empty-icon">⊞</span>
                <span>No Session</span>
                <button onclick="openAddPanelModalAtPosition(${position})">+ Add Session</button>
            </div>
        `;
        return div;
    }

    /**
     * 在面板中渲染消息列表
     * 
     * 支持的消息类型：
     * - thinking: 思考过程（可折叠显示）
     * - tool_use: 工具调用（可折叠显示输入参数）
     * - tool_result: 工具结果（自动注入到对应的工具调用块中）
     * - text: 普通文本（支持 Markdown 渲染）
     * 
     * @param {HTMLElement} container - 消息容器 DOM 元素
     * @param {Array} messages - 消息数组
     * @param {string} assistant - 助手名称
     */
    renderPanelMessages(container, messages, assistant) {
        container.innerHTML = '';
        messages.forEach(msg => {
            const div = document.createElement('div');
            div.className = `message ${msg.role}`;
            let html = '';
            
            // 助手消息显示助手标签
            if (msg.role === 'assistant') {
                const a = msg.assistant || assistant;
                html += `<div class="assistant-label">${ASSISTANT_ICONS[a] || ASSISTANT_ICONS.default} ${a || 'Assistant'}</div>`;
            }
            
            // 处理 content_blocks（包含思考、工具调用、文本等多种类型）
            if (msg.content_blocks && msg.content_blocks.length > 0) {
                html += '<div class="message-content">';
                // 第一轮：渲染除 tool_result 外的所有块
                msg.content_blocks.forEach(block => {
                    if (block.type === 'thinking') html += renderThinkingBlock(block.thinking);
                    else if (block.type === 'tool_use') html += renderToolCallBlock(block.id, block.name, block.input);
                    else if (block.type === 'text') html += `<div class="text-block">${renderMarkdown(block.text)}</div>`;
                });
                html += '</div>';
                div.innerHTML = html;
                
                // 第二轮：将 tool_result 注入到对应的 tool_use 块中
                msg.content_blocks.forEach(block => {
                    if (block.type === 'tool_result') {
                        const area = div.querySelector(`.tool-result-area[data-tool-id="${block.tool_use_id}"]`);
                        if (area) {
                            area.innerHTML = `<div class="tool-result-inline"><div class="tool-result-header"><span class="tool-result-icon">📋</span><span class="tool-result-label">Output</span></div><pre class="tool-result-content">${escapeHtml(block.content)}</pre></div>`;
                        }
                    }
                });
            } else {
                // 简单消息（无 content_blocks）
                html += `<div class="message-content">${msg.role === 'assistant' ? renderMarkdown(msg.content) : escapeHtml(msg.content)}</div>`;
                div.innerHTML = html;
            }
            
            container.appendChild(div);
        });
        // 滚动到底部显示最新消息
        container.scrollTop = container.scrollHeight;
    }

    /**
     * 更新面板的流式传输状态
     * 
     * 更新内容：
     * 1. 状态指示灯（streaming/idle）
     * 2. 停止按钮的显示/隐藏
     * 3. 发送按钮的样式
     * 
     * @param {string} panelId - 面板ID
     * @param {boolean} isStreaming - 是否正在流式传输
     */
    updatePanelStreaming(panelId, isStreaming) {
        const panel = this.panels.get(panelId);
        if (!panel) return;
        
        // 查找面板 DOM 元素
        const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
        if (!panelEl) return;
        
        // 获取相关元素
        const statusEl = panelEl.querySelector('.panel-status');  // 状态指示灯
        const stopBtn = panelEl.querySelector('.stop-btn');       // 停止按钮
        const sendBtn = panelEl.querySelector('.send-btn');       // 发送按钮
        
        // 更新状态指示灯样式
        if (statusEl) {
            statusEl.className = `panel-status ${isStreaming ? 'streaming' : 'idle'}`;
        }
        // 显示/隐藏停止按钮
        if (stopBtn) {
            stopBtn.style.display = isStreaming ? 'inline-flex' : 'none';
        }
        // 更新发送按钮样式（流式传输时显示为队列模式）
        if (sendBtn) {
            sendBtn.classList.toggle('streaming', isStreaming);
        }
    }

    /**
     * 设置同步源面板
     * 同步源面板的消息会广播到其他所有面板
     * @param {string} panelId - 面板ID
     */
    setSyncSource(panelId) {
        this.syncSourcePanelId = panelId;
        this.updatePanelSyncState();
    }
}

// ── 初始化分屏管理器 ──
const splitViewManager = new SplitViewManager();

/**
 * 根据 sessionId 查找对应的 panelId
 * @param {string} sessionId
 * @returns {string|null} panelId 或 null（不在面板中）
 */
function findPanelIdForSession(sessionId) {
    for (const [panelId, panel] of splitViewManager.panels) {
        if (panel.sessionId === sessionId) return panelId;
    }
    return null;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║                    分屏视图相关函数                               ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * 切换分屏视图模式
 * 点击顶部工具栏的 ⊞ 按钮时调用
 */
function toggleSplitView() {
    splitViewManager.toggle();
}

/**
 * 切换同步模式
 * 点击顶部工具栏的 🔗 Sync 按钮时调用
 */
function toggleSyncMode() {
    splitViewManager.toggleSyncMode();
}

/**
 * 向指定面板发送消息
 * 
 * 工作流程：
 * 1. 获取面板信息和输入框内容
 * 2. 如果是同步源面板，广播消息到所有面板
 * 3. 如果会话正在流式传输，将消息加入队列
 * 4. 否则，直接发送消息到后端并连接 SSE
 * 
 * @param {string} panelId - 面板ID
 */
async function sendToPanel(panelId) {
    const panel = splitViewManager.panels.get(panelId);
    if (!panel || !panel.sessionId) return;
    
    const textarea = document.getElementById(`panel-input-${panelId}`);
    if (!textarea) return;
    
    const message = textarea.value.trim();
    if (!message) return;
    
    textarea.value = '';
    textarea.style.height = 'auto';
    
    // ── 同步模式处理 ──
    // 如果当前面板是同步源，广播消息到所有面板
    if (splitViewManager.syncMode && panelId === splitViewManager.syncSourcePanelId) {
        splitViewManager.broadcastMessage(message);
        return;
    }
    
    // ── 队列模式处理 ──
    // 如果会话正在流式传输，将消息加入队列
    if (streamingSessions.has(panel.sessionId)) {
        if (!messageQueues.has(panel.sessionId)) {
            messageQueues.set(panel.sessionId, []);
        }
        messageQueues.get(panel.sessionId).push(message);
        updateQueueUI(panel.sessionId);
        return;
    }
    
    // ── 显示用户消息 ──
    const chatDiv = document.getElementById(`panel-chat-${panelId}`);
    if (chatDiv) {
        const div = document.createElement('div');
        div.className = 'message user';
        div.innerHTML = `<div class="message-content">${escapeHtml(message)}</div>`;
        chatDiv.appendChild(div);
        chatDiv.scrollTop = chatDiv.scrollHeight;
    }
    
    // ── 发送到后端 ──
    try {
        const res = await fetch(`${API_BASE}/api/agent/${panel.sessionId}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const data = await res.json();
        
        if (data.success) {
            // 连接 SSE 接收流式响应
            connectPanelSSE(panelId, panel.sessionId);
            // 更新面板流式状态
            splitViewManager.updatePanelStreaming(panelId, true);
        }
    } catch (e) {
        console.error('Failed to send to panel:', e);
    }
}

/**
 * 向指定面板发送指定消息（不从 textarea 读取）
 * 用于队列处理、同步模式广播等场景
 *
 * @param {string} panelId - 面板ID
 * @param {string} message - 要发送的消息
 */
async function sendToPanelWithMessage(panelId, message) {
    const panel = splitViewManager.panels.get(panelId);
    if (!panel || !panel.sessionId) return;

    // 显示用户消息
    const chatDiv = document.getElementById(`panel-chat-${panelId}`);
    if (chatDiv) {
        const div = document.createElement('div');
        div.className = 'message user';
        div.innerHTML = `<div class="message-content">${escapeHtml(message)}</div>`;
        chatDiv.appendChild(div);
        chatDiv.scrollTop = chatDiv.scrollHeight;
    }

    // 发送到后端
    try {
        const res = await fetch(`${API_BASE}/api/agent/${panel.sessionId}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (data.success) {
            connectPanelSSE(panelId, panel.sessionId);
            splitViewManager.updatePanelStreaming(panelId, true);
        }
    } catch (e) {
        console.error('Failed to send to panel:', e);
    }
}

/**
 * 为面板连接 SSE (Server-Sent Events) 接收流式响应
 * 
 * SSE 连接用于实时接收 AI 的响应，包括：
 * - thinking: 思考过程
 * - tool_call: 工具调用
 * - tool_result: 工具结果
 * - chunk: 文本片段
 * - result: 最终结果
 * - error: 错误信息
 * 
 * @param {string} panelId - 面板ID
 * @param {string} sessionId - 会话ID
 */
/**
 * 为面板连接 SSE — 复用 connectSSE，只传入 panelId
 *
 * @param {string} panelId - 面板ID
 * @param {string} sessionId - 会话ID
 */
function connectPanelSSE(panelId, sessionId) {
    connectSSE(sessionId, null, null, { panelId });
}

/**
 * 检查后端是否仍在流式传输
 * 如果后端已经完成流式传输，调用回调函数清理前端状态
 * 
 * @param {string} sessionId - 会话ID
 * @param {function} onNotStreaming - 后端不在流式传输时的回调
 */
async function checkBackendStreamingStatus(sessionId, onNotStreaming) {
    try {
        const res = await fetch(`${API_BASE}/api/agent/${sessionId}`);
        const data = await res.json();
        console.log(`[SSE] Backend status for ${sessionId}:`, data.state);

        if (!data.state?.isStreaming) {
            console.warn(`[SSE] Backend not streaming for ${sessionId}, cleaning up`);
            if (onNotStreaming) onNotStreaming();
        }
    } catch (e) {
        // 网络错误时不要杀掉 SSE 连接！
        // 临时的网络抖动（DNS 超时、服务器重启）不应终止正常的流式传输。
        // 安全超时（120 秒无活动）会作为最终兜底。
        console.warn('[SSE] Failed to check backend status (network error), keeping SSE alive:', e.message);
    }
}

/**
 * 完成面板的流式传输
 * 
 * 清理工作：
 * 1. 标记流式状态为已完成
 * 2. 清除安全超时定时器
 * 3. 关闭 SSE 连接
 * 4. 从 streamingSessions 中移除
 * 5. 更新侧边栏 LIVE 标志
 * 6. 更新面板 UI（移除流式样式）
 * 7. 刷新文件浏览器
 * 8. 处理消息队列
 * 
 * @param {string} panelId - 面板ID
 * @param {string} sessionId - 会话ID
 */

/**
 * 中止面板的会话
 * @param {string} panelId - 面板ID
 */
function abortPanel(panelId) {
    const panel = splitViewManager.panels.get(panelId);
    if (!panel || !panel.sessionId) return;

    // 清理面板中的 Thinking 指示器（abort 后不会被新流覆盖，必须手动移除）
    const chatDiv = document.getElementById(`panel-chat-${panelId}`);
    if (chatDiv) {
        chatDiv.querySelectorAll('.panel-thinking-indicator').forEach(el => el.remove());
    }

    abortSession(panel.sessionId);
    splitViewManager.updatePanelStreaming(panelId, false);
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║                    添加面板模态框                                ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * 打开添加面板模态框
 * 
 * 模态框功能：
 * 1. 选择已有会话，或创建新会话
 * 2. 创建新会话时需要选择助手、输入目录、选择模型
 */

/**
 * 在指定位置打开添加面板模态框
 * 当用户点击空面板的 "+ Add Session" 按钮时调用
 * @param {number} position - 面板位置（0-based）
 */
function openAddPanelModalAtPosition(position) {
    // 先打开模态框
    openAddPanelModal();
    
    // 设置位置选择器的值
    const positionSelect = document.getElementById('panelPositionSelect');
    if (positionSelect) {
        positionSelect.value = position.toString();
    }
}

function openAddPanelModal() {
    const modal = document.getElementById('addPanelModal');
    modal.style.display = 'flex';
    
    // ── 填充会话选择下拉框 ──
    // 过滤掉已经在面板中打开的 session，避免重复添加
    const sessionSelect = document.getElementById('panelSessionSelect');
    sessionSelect.innerHTML = '<option value="new">+ New Session</option>';
    const usedSessionIds = new Set(
        [...splitViewManager.panels.values()].map(p => p.sessionId)
    );
    sessions.forEach(s => {
        if (usedSessionIds.has(s.id)) return; // 已在面板中，跳过
        const icon = ASSISTANT_ICONS[s.assistant] || ASSISTANT_ICONS.default;
        const title = s.firstMessage?.slice(0, 30) || 'Untitled';
        sessionSelect.innerHTML += `<option value="${s.id}">${icon} ${escapeHtml(title)}</option>`;
    });
    
    // ── 填充位置选择下拉框 ──
    const positionSelect = document.getElementById('panelPositionSelect');
    if (positionSelect) {
        positionSelect.innerHTML = '<option value="-1">Auto (next available)</option>';
        const maxPanels = splitViewManager.getMaxPanelsForLayout();
        const [cols] = splitViewManager.layout.split('x').map(Number);
        for (let i = 0; i < maxPanels; i++) {
            const row = Math.floor(i / cols) + 1;
            const col = (i % cols) + 1;
            // panelOrder[i] 为 null 或 undefined 表示空位，非 null 表示已占用
            const isOccupied = i < splitViewManager.panelOrder.length && splitViewManager.panelOrder[i] !== null;
            const label = `Position ${i + 1} (${row},${col})${isOccupied ? ' - occupied' : ''}`;
            positionSelect.innerHTML += `<option value="${i}" ${isOccupied ? 'disabled' : ''}>${label}</option>`;
        }
    }
    
    // ── 填充助手选择下拉框 ──
    const assistantSelect = document.getElementById('panelAssistantSelect');
    assistantSelect.innerHTML = '';
    assistants.forEach(a => {
        const icon = ASSISTANT_ICONS[a.name] || ASSISTANT_ICONS.default;
        assistantSelect.innerHTML += `<option value="${a.name}">${icon} ${a.display_name}</option>`;
    });
    
    // ── 填充模型选择下拉框 ──
    const modelSelect = document.getElementById('panelModelSelect');
    modelSelect.innerHTML = '';
    models.forEach(m => {
        modelSelect.innerHTML += `<option value="${m.id}">${m.name}</option>`;
    });
    
    // 显示/隐藏新会话字段
    updateNewSessionFields();
    sessionSelect.onchange = updateNewSessionFields;
}

/**
 * 更新新会话字段的显示状态
 * 当选择 "+ New Session" 时显示助手、目录、模型字段
 * 当选择已有会话时隐藏这些字段
 */
function updateNewSessionFields() {
    const sessionSelect = document.getElementById('panelSessionSelect');
    const fields = document.getElementById('newSessionPanelFields');
    fields.style.display = sessionSelect.value === 'new' ? 'block' : 'none';
}

/**
 * 关闭添加面板模态框
 */
function closeAddPanelModal() {
    document.getElementById('addPanelModal').style.display = 'none';
}

/**
 * 确认添加面板
 * 
 * 工作流程：
 * 1. 获取用户选择的会话或新会话参数
 * 2. 如果是新会话，调用 API 创建会话
 * 3. 调用 splitViewManager.addPanel() 添加面板
 * 4. 关闭模态框
 */
async function confirmAddPanel() {
    const sessionSelect = document.getElementById('panelSessionSelect');
    const selectedValue = sessionSelect.value;
    
    // 获取选择的位置
    const positionSelect = document.getElementById('panelPositionSelect');
    const position = positionSelect ? parseInt(positionSelect.value) : -1;
    
    let sessionId;
    
    if (selectedValue === 'new') {
        // ── 创建新会话 ──
        const assistant = document.getElementById('panelAssistantSelect').value;
        const cwd = document.getElementById('panelCwdInput').value.trim();
        const model = document.getElementById('panelModelSelect').value;
        
        if (!cwd) {
            alert('Please enter a working directory');
            return;
        }
        
        try {
            const res = await fetch(`${API_BASE}/api/agent/new`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, model, assistant })
            });
            const data = await res.json();
            
            if (data.success) {
                sessionId = data.sessionId;
                await loadSessions();  // 刷新会话列表
            } else {
                alert('Failed to create session: ' + data.error);
                return;
            }
        } catch (e) {
            alert('Failed to create session: ' + e.message);
            return;
        }
    } else {
        // ── 使用已有会话 ──
        sessionId = selectedValue;
    }
    
    // 添加面板到指定位置
    const validPosition = position >= 0 ? position : null;
    splitViewManager.addPanel(sessionId, validPosition);
    closeAddPanelModal();
}

// ── 覆盖 sendMessage 函数以支持同步模式 ──
// 保存原始函数引用
const originalSendMessage = sendMessage;
sendMessage = async function() {
    const message = messageInput.value.trim();
    if (!message) return;
    
    // 如果分屏模式开启且同步模式激活，广播消息到所有面板
    if (splitViewManager.enabled && splitViewManager.syncMode) {
        messageInput.value = '';
        messageInput.style.height = 'auto';
        splitViewManager.broadcastMessage(message);
        return;
    }
    
    // 否则使用原始逻辑
    return originalSendMessage();
};
