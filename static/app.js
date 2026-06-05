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
    await loadAssistants();
    await loadModels();
    await loadSessions();
    setupEventListeners();
    renderAssistantCards();
    renderAssistantStatus();
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
        div.innerHTML = `
            <div class="header">
                <div class="name">${icon} ${escapeHtml(session.firstMessage?.slice(0, 40) || 'Untitled')} ${live}</div>
                <button class="delete-btn" data-id="${session.id}">×</button>
            </div>
            <div class="meta">
                <span class="assistant-badge">${session.assistant || 'claude'}</span>
                <span>${session.messageCount || 0} msgs</span>
                <span class="cwd-label" title="${escapeHtml(session.cwd || '')}">📁 ${escapeHtml(session.cwd || '')}</span>
            </div>`;
        div.onclick = (e) => { if (!e.target.classList.contains('delete-btn')) selectSession(session.id); };
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
async function selectSession(sessionId) {
    currentSessionId = sessionId;

    // Reload sessions to get fresh isStreaming status from backend
    await loadSessions();
    renderSessionList();

    // Sync the topbar assistant/model selectors with this session's settings.
    // This runs EVERY time a session is selected (not just the first time),
    // so the dropdown always reflects the current session's assistant.
    const sessionInfo = sessions.find(s => s.id === sessionId);
    if (sessionInfo) {
        if (sessionInfo.assistant) { currentAssistant = sessionInfo.assistant; assistantSelector.value = sessionInfo.assistant; }
        if (sessionInfo.model) { currentModel = sessionInfo.model; modelSelector.value = sessionInfo.model; statusDisplay.textContent = sessionInfo.model; }
        // Reload model list for the selected assistant, then restore this session's model.
        // loadModels() sets currentModel to the assistant's default, so we restore
        // the session's actual model afterward.
        await loadModels();
        if (sessionInfo.model) { currentModel = sessionInfo.model; modelSelector.value = sessionInfo.model; statusDisplay.textContent = sessionInfo.model; }
    }

    // Get or create this session's DOM view
    const view = getSessionView(sessionId);

    // Load messages from backend if view is empty (first time viewing, e.g. after page refresh)
    if (view.children.length === 0) {
        try {
            const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
            const data = await res.json();
            if (data.messages) renderMessagesInto(view, data.messages, data.assistant);
            if (data.cwd) {
                currentBrowsePath = data.cwd;
                if (!fileBrowserExpanded) toggleFileBrowser();
                loadFiles(data.cwd);
            }
        } catch (e) { console.error('Failed to load session:', e); }
    }

    // Show this session's view, hide all others
    showSessionView(sessionId);
    welcomeScreen.style.display = 'none';
    chatContainer.style.display = 'flex'; chatContainer.style.flexDirection = 'column';
    inputArea.style.display = 'block';

    // If backend says this session is still streaming but frontend has no connection, reconnect
    if (sessionInfo?.isStreaming && !streamingSessions.has(sessionId)) {
        connectSSE(sessionId, null); // null message = don't send start prompt
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

    try {
        switchAssistantBtn.disabled = true;
        switchAssistantBtn.textContent = '⏳ Switching...';

        // Show a "switching" indicator immediately in the chat
        const view = getSessionView(currentSessionId);
        const switchingDiv = document.createElement('div');
        switchingDiv.className = 'message system switching-indicator';
        switchingDiv.id = 'switching-indicator';
        switchingDiv.innerHTML = `<div class="system-content">⏳ Switching to ${toIcon} <strong>${toDisplayName}</strong>...</div>`;
        view.appendChild(switchingDiv);
        scrollToBottom();

        // Step 1: Ask the backend to switch assistants.
        const res = await fetch(`${API_BASE}/api/agent/${currentSessionId}/switch`, {
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
            const indicator = document.getElementById('switching-indicator');
            if (indicator) {
                indicator.innerHTML = `<div class="system-content">⏳ ${toIcon} <strong>${toDisplayName}</strong> is starting...</div>`;
            }

            // Step 3: Connect to SSE to receive the new assistant's streamed response.
            connectSSE(currentSessionId, null, () => {
                // Step 4: After the new assistant responds, remove switching indicator and show switch message
                const indicator = document.getElementById('switching-indicator');
                if (indicator) indicator.remove();
                
                const sysDiv = document.createElement('div');
                sysDiv.className = 'message system';
                sysDiv.innerHTML = `<div class="system-content">🔄 Switched from <strong>${ASSISTANT_ICONS[fromName] || ASSISTANT_ICONS.default} ${fromName}</strong> to <strong>${toIcon} ${toDisplayName}</strong></div>`;
                view.appendChild(sysDiv);
                scrollToBottom();
            });

            // Refresh session list to reflect the new assistant
            await loadSessions(); renderSessionList(); updateSwitchButton();
        } else {
            // Remove switching indicator on failure
            const indicator = document.getElementById('switching-indicator');
            if (indicator) indicator.remove();
            alert('Switch failed: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        // Remove switching indicator on error
        const indicator = document.getElementById('switching-indicator');
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
            msg.content_blocks.forEach(block => {
                if (block.type === 'thinking') html += renderThinkingBlock(block.thinking);
                else if (block.type === 'tool_use') html += renderToolCallBlock(block.id, block.name, block.input);
                else if (block.type === 'tool_result') html += renderToolResultBlock(block.content);
                else if (block.type === 'text') html += `<div class="text-block">${renderMarkdown(block.text)}</div>`;
            });
            html += '</div>';
        } else {
            html += `<div class="message-content">${msg.role === 'assistant' ? renderMarkdown(msg.content) : escapeHtml(msg.content)}</div>`;
        }
        div.innerHTML = html;
        view.appendChild(div);
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
    if (name === 'Bash' || name === 'bash') return input.command || '';
    if (['Read','read','Write','write','Edit','edit'].includes(name)) return input.file_path || input.path || '';
    if (['Glob','glob'].includes(name)) return input.pattern || '';
    if (['Grep','grep'].includes(name)) return input.pattern || input.query || '';
    if (name === 'WebFetch') return input.url || '';
    if (name === 'WebSearch') return input.query || '';
    return input.command || input.path || input.file_path || input.pattern || input.query || '';
}

function renderToolCallBlock(id, name, input) {
    const icon = TOOL_ICONS[name] || TOOL_ICONS.default;
    let preview = getToolPreview(name, input);
    if (typeof preview === 'object') preview = JSON.stringify(preview);
    if (preview.length > 100) preview = preview.slice(0, 100) + '...';
    const inputDisplay = (name === 'Bash' || name === 'bash')
        ? (input.command ? escapeHtml(input.command) : escapeHtml(JSON.stringify(input, null, 2)))
        : escapeHtml(JSON.stringify(input, null, 2));
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

// ===== Per-Session SSE Streaming =====

function connectSSE(sessionId, message, onDone) {
    const state = {
        eventSource: null, streamingDiv: null, contentDiv: null,
        contentBlocks: [], toolCallMap: {},
        hasContent: false, finalResult: '', promptSent: false, finished: false, safetyTimeout: null,
        _message: message, _onDone: onDone,
        _startTime: Date.now(), lastHeartbeat: Date.now(), heartbeatCheck: null,
    };
    streamingSessions.set(sessionId, state);

    const es = new EventSource(`${API_BASE}/api/agent/${sessionId}/events`);
    state.eventSource = es;

    es.onmessage = (e) => {
        try { handleStreamEvent(sessionId, JSON.parse(e.data)); }
        catch (err) { console.error('SSE parse error:', err); }
    };

    es.onerror = () => {
        const st = streamingSessions.get(sessionId);
        if (!st || st.finished) return;
        if (!st.promptSent) {
            setTimeout(() => {
                const st2 = streamingSessions.get(sessionId);
                if (st2 && !st2.finished && es.readyState === EventSource.CLOSED && !st2.promptSent) {
                    connectSSE(sessionId, message, onDone);
                }
            }, 1000);
        }
    };

    state.safetyTimeout = setTimeout(() => {
        const st = streamingSessions.get(sessionId);
        if (st && !st.finished) { console.warn(`[SSE] Safety timeout for ${sessionId}`); finishStreaming(sessionId); }
    }, 120000);

    // Heartbeat timeout detection: if no heartbeat received for 30 seconds,
    // the connection might be dead. Check backend status.
    state.heartbeatCheck = setInterval(async () => {
        const st = streamingSessions.get(sessionId);
        if (!st || st.finished) {
            clearInterval(state.heartbeatCheck);
            return;
        }
        
        const now = Date.now();
        const lastHeartbeat = st.lastHeartbeat || st._startTime;
        const timeSinceHeartbeat = now - lastHeartbeat;
        
        // If no heartbeat for 30 seconds, check backend status
        if (timeSinceHeartbeat > 30000) {
            try {
                const res = await fetch(`${API_BASE}/api/agent/${sessionId}`);
                const data = await res.json();
                if (!data.state?.isStreaming) {
                    console.warn(`[SSE] Heartbeat timeout, backend not streaming for ${sessionId}`);
                    finishStreaming(sessionId);
                    clearInterval(state.heartbeatCheck);
                }
            } catch (e) {
                console.error('Heartbeat check failed:', e);
            }
        }
    }, 10000); // Check every 10 seconds

    renderSessionList(); // Update sidebar indicators

    return state;
}

function handleStreamEvent(sessionId, event) {
    const st = streamingSessions.get(sessionId);
    if (!st || st.finished) return;
    const isCurrent = sessionId === currentSessionId;

    function ensureDiv() {
        if (!st.streamingDiv) {
            st.streamingDiv = createStreamingMessage(sessionId);
            st.contentDiv = st.streamingDiv.querySelector('.message-content');
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
            
            if (isCurrent) {
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
            st.contentDiv.appendChild(te.firstElementChild);
            st.hasContent = true;
            st.contentBlocks.push({ type: 'thinking', thinking: event.thinking });
            if (isCurrent) scrollToBottom();
            break;
        case 'tool_call':
            ensureDiv();
            const tce = document.createElement('div');
            tce.innerHTML = renderToolCallBlock(event.id, event.name, event.input);
            st.contentDiv.appendChild(tce.firstElementChild);
            st.hasContent = true;
            st.toolCallMap[event.id] = { name: event.name, input: event.input };
            st.contentBlocks.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
            if (isCurrent) scrollToBottom();
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
            if (isCurrent) scrollToBottom();
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
            if (isCurrent) scrollToBottom();
            break;
        case 'result':
            ensureDiv();
            if (event.content && !st.hasContent) {
                let lt = st.contentDiv.querySelector('.text-block:last-child');
                if (!lt) { lt = document.createElement('div'); lt.className = 'text-block'; st.contentDiv.appendChild(lt); }
                lt.textContent = event.content; lt.dataset.finalized = 'true';
                st.finalResult = event.content;
                if (!st.contentBlocks.some(b => b.type === 'text')) st.contentBlocks.push({ type: 'text', text: event.content });
            } else if (event.content && !st.finalResult) { st.finalResult = event.content; }
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

/// Called when an SSE stream ends (result or error event).
/// Saves the AI response to the backend, cleans up UI state,
/// and triggers the onDone callback if set (used by assistant switching).
///
/// Note: loadSessions is delayed 300ms to avoid a race condition where
/// the frontend fetches isStreaming=true because the backend hasn't finished
/// cleaning up streaming_sessions yet.
function finishStreaming(sessionId) {
    const st = streamingSessions.get(sessionId);
    if (!st || st.finished) return;
    st.finished = true;
    if (st.safetyTimeout) clearTimeout(st.safetyTimeout);
    if (st.heartbeatCheck) clearInterval(st.heartbeatCheck);
    if (st.eventSource) st.eventSource.close();
    streamingSessions.delete(sessionId);

    // Update UI: remove streaming indicators
    const isCurrent = sessionId === currentSessionId;
    if (isCurrent) {
        sendBtn.classList.remove('streaming');
        stopBtn.style.display = 'none';
        typingIndicator.style.display = 'none';
    }
    if (st.streamingDiv) st.streamingDiv.classList.remove('streaming');

    // Save the AI's response to the backend (message + content_blocks)
    if ((st.finalResult || st.contentBlocks.length > 0) && sessionId) {
        fetch(`${API_BASE}/api/agent/${sessionId}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'save_message', message: st.finalResult || '', content_blocks: st.contentBlocks.length > 0 ? st.contentBlocks : undefined })
        }).catch(e => console.error('Failed to save response:', e));
    }

    // Delay loadSessions to let the backend clean up streaming_sessions first.
    // Race condition explanation:
    //   1. Backend sends 'result' SSE event
    //   2. Frontend receives it, calls finishStreaming
    //   3. Frontend fetches loadSessions → backend returns isStreaming=true
    //      because stream_session() hasn't returned yet
    //   4. Backend cleans up streaming_sessions (too late)
    // Use retry logic with exponential backoff for reliability across different networks.
    const retryLoadSessions = async () => {
        const delays = [100, 200, 400, 800, 1600]; // Exponential backoff
        let cleaned = false;
        
        for (const delay of delays) {
            await new Promise(r => setTimeout(r, delay));
            try {
                await loadSessions();
                const session = sessions.find(s => s.id === sessionId);
                if (!session?.isStreaming) {
                    cleaned = true;
                    break;
                }
            } catch (e) {
                console.warn('[finishStreaming] loadSessions failed:', e);
            }
        }
        
        if (!cleaned) {
            console.warn(`[finishStreaming] Backend still reports streaming for ${sessionId}, forcing local cleanup`);
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

function cleanupSessionStreaming(sessionId) {
    const st = streamingSessions.get(sessionId);
    if (st) {
        st.finished = true;
        if (st.safetyTimeout) clearTimeout(st.safetyTimeout);
        if (st.eventSource) st.eventSource.close();
        streamingSessions.delete(sessionId);
    }
}

// ===== Per-Session Queue =====

function processSessionQueue(sessionId) {
    const queue = messageQueues.get(sessionId);
    if (!queue || queue.length === 0) { messageQueues.delete(sessionId); updateQueueUI(); return; }
    if (streamingSessions.has(sessionId)) return;
    const nextMsg = queue.shift();
    updateQueueUI();
    if (sessionId === currentSessionId) { sendToSession(nextMsg); }
    else { sendToBackgroundSession(sessionId, nextMsg); }
}

async function sendToBackgroundSession(sessionId, message) {
    try {
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

function updateQueueUI() {
    const existing = document.getElementById('queueStatus');
    const queue = currentSessionId ? messageQueues.get(currentSessionId) : null;
    if (queue && queue.length > 0) {
        let html = `<div class="queue-header">📨 ${queue.length} message(s) queued <button class="queue-clear-btn" onclick="clearCurrentQueue()">Clear</button></div>`;
        queue.forEach((msg, i) => {
            const preview = msg.length > 50 ? msg.slice(0, 50) + '...' : msg;
            html += `<div class="queue-item" onclick="removeFromCurrentQueue(${i})" title="Click to remove"><span class="queue-item-text">${escapeHtml(preview)}</span><span class="queue-item-remove">×</span></div>`;
        });
        if (existing) { existing.innerHTML = html; }
        else {
            const div = document.createElement('div'); div.id = 'queueStatus'; div.className = 'queue-status'; div.innerHTML = html;
            chatContainer.appendChild(div);
        }
    } else if (existing) { existing.remove(); }
}

function removeFromCurrentQueue(index) {
    if (!currentSessionId) return;
    const queue = messageQueues.get(currentSessionId);
    if (queue) { queue.splice(index, 1); if (queue.length === 0) messageQueues.delete(currentSessionId); updateQueueUI(); }
}
function clearCurrentQueue() { if (currentSessionId) { messageQueues.delete(currentSessionId); updateQueueUI(); } }

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
    try { await fetch(`${API_BASE}/api/agent/${sessionId}/abort`, { method: 'POST' }); } catch (e) { console.error('Abort failed:', e); }
    cleanupSessionStreaming(sessionId);
    if (sessionId === currentSessionId) {
        sendBtn.classList.remove('streaming'); stopBtn.style.display = 'none'; typingIndicator.style.display = 'none';
        const sm = getSessionView(sessionId).querySelector('.message.streaming');
        if (sm) sm.classList.remove('streaming');
    }
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
    sendBtn.onclick = sendMessage;
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
}

init();
