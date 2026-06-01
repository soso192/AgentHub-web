// CC-Web Frontend - AI Coding Assistant Hub
const API_BASE = '';

// State
let currentSessionId = null;
let sessions = [];
let assistants = [];
let models = [];
let currentAssistant = 'claude';
let currentModel = null;
let isStreaming = false;
let pendingCwd = null;
let currentEventSource = null;

// DOM Elements
const sidebar = document.getElementById('sidebar');
const toggleSidebar = document.getElementById('toggleSidebar');
const newSessionBtn = document.getElementById('newSessionBtn');
const newSessionForm = document.getElementById('newSessionForm');
const assistantSelect = document.getElementById('assistantSelect');
const cwdInput = document.getElementById('cwdInput');
const modelSelectNew = document.getElementById('modelSelectNew');
const createSessionBtn = document.getElementById('createSessionBtn');
const cancelSessionBtn = document.getElementById('cancelSessionBtn');
const sessionList = document.getElementById('sessionList');
const messagesContainer = document.getElementById('messages');
const welcomeScreen = document.getElementById('welcomeScreen');
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

// Assistant icons
const ASSISTANT_ICONS = {
    'claude': '🤖',
    'codex': '⚡',
    'pi': 'π',
    'cursor': '📝',
    'default': '🔧'
};

const ASSISTANT_DESCS = {
    'claude': 'Anthropic Claude Code CLI',
    'codex': 'OpenAI Codex CLI',
    'pi': 'Pi Coding Agent',
    'cursor': 'Cursor AI Editor',
    'default': 'AI Assistant'
};

// Streaming state
let streamingMessages = {};

// Initialize
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
        const defaultAssistant = assistants.find(a => a.is_default);
        if (defaultAssistant) currentAssistant = defaultAssistant.name;
        updateAssistantSelectors();
    } catch (e) {
        console.error('Failed to load assistants:', e);
        assistants = [{ name: 'claude', display_name: 'Claude Code', is_default: true }];
        currentAssistant = 'claude';
        updateAssistantSelectors();
    }
}

async function loadModels() {
    try {
        const res = await fetch(`${API_BASE}/api/models`);
        const data = await res.json();
        models = data.model_list || [];
        currentModel = data.default_model?.model_id;
        updateModelSelectors();
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

function updateAssistantSelectors() {
    const selectors = [assistantSelect, assistantSelector];
    selectors.forEach(select => {
        select.innerHTML = '';
        assistants.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.name;
            opt.textContent = `${ASSISTANT_ICONS[a.name] || ASSISTANT_ICONS.default} ${a.display_name}`;
            if (a.name === currentAssistant) opt.selected = true;
            select.appendChild(opt);
        });
    });
}

function updateModelSelectors() {
    const selectors = [modelSelectNew, modelSelector];
    selectors.forEach(select => {
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
        card.className = `assistant-card ${a.name === currentAssistant ? 'selected' : ''}`;
        card.innerHTML = `
            <div class="icon">${ASSISTANT_ICONS[a.name] || ASSISTANT_ICONS.default}</div>
            <div class="name">${a.display_name}</div>
            <div class="desc">${ASSISTANT_DESCS[a.name] || ASSISTANT_DESCS.default}</div>
        `;
        card.onclick = () => selectAssistant(a.name);
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
    assistantSelect.value = name;
    assistantSelector.value = name;
    renderAssistantCards();
    renderAssistantStatus();
    loadModels();
    updateSwitchButton();
}

// Show/hide switch button based on whether session assistant differs from selector
function updateSwitchButton() {
    if (!currentSessionId) {
        switchAssistantBtn.style.display = 'none';
        return;
    }
    // Find current session's assistant
    const session = sessions.find(s => s.id === currentSessionId);
    if (session && session.assistant !== currentAssistant) {
        switchAssistantBtn.style.display = 'inline-flex';
    } else {
        switchAssistantBtn.style.display = 'none';
    }
}

// Switch assistant while preserving context
async function switchAssistant() {
    if (!currentSessionId || isStreaming) return;

    const newAssistant = assistantSelector.value;
    const session = sessions.find(s => s.id === currentSessionId);
    if (!session || session.assistant === newAssistant) return;

    const newModel = modelSelector.value;

    try {
        switchAssistantBtn.disabled = true;
        switchAssistantBtn.textContent = '⏳ Switching...';

        const res = await fetch(`${API_BASE}/api/agent/${currentSessionId}/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistant: newAssistant, model: newModel })
        });

        const data = await res.json();

        if (data.success) {
            currentAssistant = data.assistant;
            currentModel = data.model;
            assistantSelector.value = data.assistant;
            modelSelector.value = data.model;
            statusDisplay.textContent = data.model;

            // Add system message to chat
            const sysDiv = document.createElement('div');
            sysDiv.className = 'message system';
            sysDiv.innerHTML = `<div class="system-content">🔄 Switched to <strong>${ASSISTANT_ICONS[data.assistant] || ASSISTANT_ICONS.default} ${data.assistant}</strong> — conversation history preserved</div>`;
            messagesContainer.appendChild(sysDiv);
            scrollToBottom();

            // Reload sessions to update sidebar
            await loadSessions();
            renderSessionList();
            updateSwitchButton();
        } else {
            alert('Switch failed: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Switch error: ' + e.message);
    } finally {
        switchAssistantBtn.disabled = false;
        switchAssistantBtn.textContent = '🔄 Switch';
    }
}

function renderSessionList() {
    sessionList.innerHTML = '';
    sessions.forEach(session => {
        const div = document.createElement('div');
        div.className = `session-item ${session.id === currentSessionId ? 'active' : ''}`;
        const icon = ASSISTANT_ICONS[session.assistant] || ASSISTANT_ICONS.default;
        div.innerHTML = `
            <div class="header">
                <div class="name">${icon} ${escapeHtml(session.firstMessage?.slice(0, 40) || 'Untitled')}</div>
                <button class="delete-btn" data-id="${session.id}">×</button>
            </div>
            <div class="meta">
                <span class="assistant-badge">${session.assistant || 'claude'}</span>
                <span>${session.messageCount || 0} msgs</span>
                <span>${session.model || ''}</span>
            </div>
        `;
        div.onclick = (e) => {
            if (!e.target.classList.contains('delete-btn')) selectSession(session.id);
        };
        const deleteBtn = div.querySelector('.delete-btn');
        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            if (confirm('Delete this session?')) await deleteSession(session.id);
        };
        sessionList.appendChild(div);
    });
}

async function selectSession(sessionId) {
    currentSessionId = sessionId;
    renderSessionList();
    try {
        const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
        const data = await res.json();
        if (data.messages) renderMessages(data.messages, data.assistant);
        if (data.assistant) {
            currentAssistant = data.assistant;
            assistantSelector.value = data.assistant;
        }
        if (data.model) {
            currentModel = data.model;
            modelSelector.value = data.model;
            statusDisplay.textContent = data.model;
        }
        welcomeScreen.style.display = 'none';
        messagesContainer.style.display = 'block';
        inputArea.style.display = 'block';
        typingIndicator.style.display = 'none';
        updateSwitchButton();
    } catch (e) {
        console.error('Failed to load session:', e);
    }
}

async function deleteSession(sessionId) {
    try {
        await fetch(`${API_BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });
        if (currentSessionId === sessionId) {
            currentSessionId = null;
            welcomeScreen.style.display = 'flex';
            messagesContainer.style.display = 'none';
            inputArea.style.display = 'none';
        }
        await loadSessions();
    } catch (e) {
        console.error('Failed to delete session:', e);
    }
}

function renderMessages(messages, assistant) {
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
        const div = document.createElement('div');
        div.className = `message ${msg.role}`;
        let html = '';
        if (msg.role === 'assistant') {
            const icon = ASSISTANT_ICONS[assistant] || ASSISTANT_ICONS.default;
            html += `<div class="assistant-label">${icon} ${assistant || 'Assistant'}</div>`;
        }
        // Render content blocks if available, otherwise plain content
        if (msg.content_blocks && msg.content_blocks.length > 0) {
            html += '<div class="message-content">';
            msg.content_blocks.forEach(block => {
                if (block.type === 'thinking') {
                    html += renderThinkingBlock(block.thinking);
                } else if (block.type === 'tool_use') {
                    html += renderToolCallBlock(block.id, block.name, block.input);
                } else if (block.type === 'tool_result') {
                    html += renderToolResultBlock(block.content);
                } else if (block.type === 'text') {
                    html += `<div class="text-block">${escapeHtml(block.text)}</div>`;
                }
            });
            html += '</div>';
        } else {
            html += `<div class="message-content">${escapeHtml(msg.content)}</div>`;
        }
        div.innerHTML = html;
        messagesContainer.appendChild(div);
    });
    scrollToBottom();
}

function addMessage(role, content, assistant) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    let html = '';
    if (role === 'assistant') {
        const icon = ASSISTANT_ICONS[assistant] || ASSISTANT_ICONS.default;
        html += `<div class="assistant-label">${icon} ${assistant || currentAssistant}</div>`;
    }
    html += `<div class="message-content">${escapeHtml(content)}</div>`;
    div.innerHTML = html;
    messagesContainer.appendChild(div);
    scrollToBottom();
}

// Create streaming assistant message container
function createStreamingMessage() {
    const div = document.createElement('div');
    div.className = 'message assistant streaming';
    const icon = ASSISTANT_ICONS[currentAssistant] || ASSISTANT_ICONS.default;
    div.innerHTML = `
        <div class="assistant-label">${icon} ${currentAssistant}</div>
        <div class="message-content"></div>
    `;
    messagesContainer.appendChild(div);
    scrollToBottom();
    return div;
}

// Render thinking block (collapsible)
function renderThinkingBlock(thinking) {
    return `<div class="thinking-block">
        <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="thinking-icon">💭</span>
            <span class="thinking-label">Thinking</span>
            <span class="thinking-toggle">▶</span>
        </div>
        <div class="thinking-content">${escapeHtml(thinking)}</div>
    </div>`;
}

// Render tool call block (collapsible)
function renderToolCallBlock(id, name, input) {
    let preview = '';
    if (input && typeof input === 'object') {
        preview = input.command || input.path || input.file_path || input.pattern || input.query || '';
        if (typeof preview === 'object') preview = JSON.stringify(preview);
        if (preview.length > 80) preview = preview.slice(0, 80) + '...';
    }
    return `<div class="tool-call-block" data-tool-id="${id}">
        <div class="tool-call-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="tool-icon">🔧</span>
            <span class="tool-name">${escapeHtml(name)}</span>
            <span class="tool-preview">${escapeHtml(preview)}</span>
            <span class="tool-toggle">▶</span>
        </div>
        <div class="tool-call-content">
            <pre class="tool-input">${escapeHtml(JSON.stringify(input, null, 2))}</pre>
            <div class="tool-result-area" data-tool-id="${id}"></div>
        </div>
    </div>`;
}

// Render tool result block
function renderToolResultBlock(content) {
    return `<div class="tool-result-block">
        <div class="tool-result-header">
            <span class="tool-result-icon">📋</span>
            <span class="tool-result-label">Result</span>
        </div>
        <pre class="tool-result-content">${escapeHtml(content)}</pre>
    </div>`;
}

function scrollToBottom() {
    const container = document.getElementById('chatContainer');
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
    if (typeof text !== 'string') text = String(text || '');
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Connect to SSE and handle streaming events
function connectSSE(sessionId, message, onDone) {
    const es = new EventSource(`${API_BASE}/api/agent/${sessionId}/events`);
    currentEventSource = es;

    let streamingDiv = null;
    let contentDiv = null;
    let hasContent = false;
    let finalResult = '';

    es.onmessage = (e) => {
        try {
            const event = JSON.parse(e.data);
            handleStreamEvent(event);
        } catch (err) {
            console.error('SSE parse error:', err);
        }
    };

    es.onerror = () => {
        // Reconnect after a short delay if still streaming
        if (isStreaming) {
            setTimeout(() => {
                if (isStreaming && es.readyState === EventSource.CLOSED) {
                    // Connection closed, try to reconnect
                    connectSSE(sessionId, null, onDone);
                }
            }, 1000);
        }
    };

    function handleStreamEvent(event) {
        switch (event.type) {
            case 'connected':
                // SSE connected, now send the prompt if we have one
                if (message) {
                    sendStartPrompt(sessionId, message);
                }
                break;

            case 'start':
                typingIndicator.style.display = 'block';
                typingIndicator.querySelector('.assistant-name').textContent = currentAssistant;
                break;

            case 'thinking':
                if (!streamingDiv) {
                    streamingDiv = createStreamingMessage();
                    contentDiv = streamingDiv.querySelector('.message-content');
                }
                // Append thinking block
                const thinkingEl = document.createElement('div');
                thinkingEl.innerHTML = renderThinkingBlock(event.thinking);
                contentDiv.appendChild(thinkingEl.firstElementChild);
                hasContent = true;
                scrollToBottom();
                break;

            case 'tool_call':
                if (!streamingDiv) {
                    streamingDiv = createStreamingMessage();
                    contentDiv = streamingDiv.querySelector('.message-content');
                }
                const toolEl = document.createElement('div');
                toolEl.innerHTML = renderToolCallBlock(event.id, event.name, event.input);
                contentDiv.appendChild(toolEl.firstElementChild);
                hasContent = true;
                scrollToBottom();
                break;

            case 'tool_result':
                // Find the tool call block and add result
                const toolResultArea = contentDiv?.querySelector(`.tool-result-area[data-tool-id="${event.id}"]`);
                if (toolResultArea) {
                    toolResultArea.innerHTML = `<div class="tool-result-inline">
                        <div class="tool-result-header">
                            <span class="tool-result-icon">📋</span>
                            <span class="tool-result-label">Output</span>
                        </div>
                        <pre class="tool-result-content">${escapeHtml(event.output)}</pre>
                    </div>`;
                } else {
                    // If no matching tool call, add as standalone result
                    if (!streamingDiv) {
                        streamingDiv = createStreamingMessage();
                        contentDiv = streamingDiv.querySelector('.message-content');
                    }
                    const resultEl = document.createElement('div');
                    resultEl.innerHTML = renderToolResultBlock(event.output);
                    contentDiv.appendChild(resultEl.firstElementChild);
                }
                scrollToBottom();
                break;

            case 'chunk':
                if (!streamingDiv) {
                    streamingDiv = createStreamingMessage();
                    contentDiv = streamingDiv.querySelector('.message-content');
                }
                // Append or update text content
                let textBlock = contentDiv.querySelector('.text-block:last-child');
                if (!textBlock || textBlock.dataset.finalized === 'true') {
                    textBlock = document.createElement('div');
                    textBlock.className = 'text-block';
                    contentDiv.appendChild(textBlock);
                }
                textBlock.textContent = (textBlock.textContent || '') + event.content;
                hasContent = true;
                finalResult = event.content;
                scrollToBottom();
                break;

            case 'result':
                // Final result
                if (!streamingDiv) {
                    streamingDiv = createStreamingMessage();
                    contentDiv = streamingDiv.querySelector('.message-content');
                }
                // If there's a result and no text content yet, show it
                if (event.content && !hasContent) {
                    let lastText = contentDiv.querySelector('.text-block:last-child');
                    if (!lastText) {
                        lastText = document.createElement('div');
                        lastText.className = 'text-block';
                        contentDiv.appendChild(lastText);
                    }
                    lastText.textContent = event.content;
                    lastText.dataset.finalized = 'true';
                }
                // Mark streaming as done
                finishStreaming();
                break;

            case 'error':
                if (!streamingDiv) {
                    streamingDiv = createStreamingMessage();
                    contentDiv = streamingDiv.querySelector('.message-content');
                }
                const errorEl = document.createElement('div');
                errorEl.className = 'error-block';
                errorEl.textContent = `Error: ${event.message}`;
                contentDiv.appendChild(errorEl);
                finishStreaming();
                break;
        }
    }

    function finishStreaming() {
        es.close();
        currentEventSource = null;
        isStreaming = false;
        sendBtn.disabled = false;
        typingIndicator.style.display = 'none';
        if (streamingDiv) {
            streamingDiv.classList.remove('streaming');
        }
        loadSessions().then(() => renderSessionList());
        if (onDone) onDone();
    }
}

// Send start prompt request
async function sendStartPrompt(sessionId, message) {
    try {
        const res = await fetch(`${API_BASE}/api/agent/${sessionId}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (!data.success) {
            console.error('Start prompt failed:', data.error);
        }
    } catch (e) {
        console.error('Start prompt error:', e);
    }
}

async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message || isStreaming) return;

    if (!currentSessionId) {
        if (pendingCwd) {
            await createSessionWithMessage(pendingCwd, message);
        } else {
            newSessionForm.style.display = 'block';
            cwdInput.focus();
        }
    } else {
        await sendToSession(message);
    }
}

async function createSession() {
    const cwd = cwdInput.value.trim();
    if (!cwd) {
        alert('Please enter a working directory');
        return;
    }
    const assistant = assistantSelect.value;
    const model = modelSelectNew.value;
    newSessionForm.style.display = 'none';
    cwdInput.value = '';

    try {
        welcomeScreen.style.display = 'none';
        messagesContainer.style.display = 'block';
        inputArea.style.display = 'block';
        currentAssistant = assistant;
        currentModel = model;
        pendingCwd = cwd;
        assistantSelector.value = assistant;
        modelSelector.value = model;
        statusDisplay.textContent = model;
        messageInput.focus();
    } catch (e) {
        console.error('Failed to create session:', e);
        alert('Failed to create session: ' + e.message);
    }
}

async function createSessionWithMessage(cwd, message) {
    const assistant = currentAssistant || assistantSelect.value;
    const model = currentModel || modelSelectNew.value;

    try {
        isStreaming = true;
        sendBtn.disabled = true;
        messageInput.value = '';
        messageInput.style.height = 'auto';

        addMessage('user', message, assistant);
        typingIndicator.style.display = 'block';
        typingIndicator.querySelector('.assistant-name').textContent = assistant;

        // Step 1: Create session (no message sent yet)
        const res = await fetch(`${API_BASE}/api/agent/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd, model, assistant })
        });

        const data = await res.json();

        if (data.success) {
            currentSessionId = data.sessionId;
            currentAssistant = data.assistant || assistant;
            pendingCwd = null;

            // Step 2: Connect SSE, which will trigger step 3 (start prompt) on connect
            connectSSE(data.sessionId, message);
        } else {
            addMessage('assistant', `Error: ${data.error}`, assistant);
            isStreaming = false;
            sendBtn.disabled = false;
            typingIndicator.style.display = 'none';
        }
    } catch (e) {
        addMessage('assistant', `Error: ${e.message}`, assistant);
        isStreaming = false;
        sendBtn.disabled = false;
        typingIndicator.style.display = 'none';
    }
}

async function sendToSession(message) {
    try {
        isStreaming = true;
        sendBtn.disabled = true;
        messageInput.value = '';
        messageInput.style.height = 'auto';

        addMessage('user', message);
        typingIndicator.style.display = 'block';
        typingIndicator.querySelector('.assistant-name').textContent = currentAssistant;

        // Connect SSE, which will trigger start prompt on connect
        connectSSE(currentSessionId, message);
    } catch (e) {
        addMessage('assistant', `Error: ${e.message}`, currentAssistant);
        isStreaming = false;
        sendBtn.disabled = false;
        typingIndicator.style.display = 'none';
    }
}

function setupEventListeners() {
    toggleSidebar.onclick = () => sidebar.classList.toggle('closed');

    newSessionBtn.onclick = () => {
        newSessionForm.style.display = newSessionForm.style.display === 'none' ? 'block' : 'none';
    };

    cancelSessionBtn.onclick = () => {
        newSessionForm.style.display = 'none';
        cwdInput.value = '';
    };

    createSessionBtn.onclick = createSession;
    sendBtn.onclick = sendMessage;

    messageInput.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    messageInput.oninput = () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
    };

    assistantSelector.onchange = (e) => selectAssistant(e.target.value);
    switchAssistantBtn.onclick = switchAssistant;

    modelSelector.onchange = async (e) => {
        currentModel = e.target.value;
        statusDisplay.textContent = currentModel;
        if (currentSessionId) {
            try {
                await fetch(`${API_BASE}/api/agent/${currentSessionId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'set_model', model: currentModel })
                });
            } catch (e) {
                console.error('Failed to set model:', e);
            }
        }
    };

    cwdInput.onkeydown = (e) => {
        if (e.key === 'Enter') createSession();
    };
}

init();
