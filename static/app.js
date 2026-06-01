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
let messageQueue = [];
let currentBrowsePath = null;
let fileBrowserExpanded = false;

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
const stopBtn = document.getElementById('stopBtn');

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
                <span class="cwd-label">📁 ${escapeHtml(session.cwd?.split(/[/\\]/).pop() || '')}</span>
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
    // Reset any ongoing streaming state
    resetStreamingState();
    messageQueue = [];
    updateQueueStatus();

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

        // Load file browser for this session's cwd
        if (data.cwd) {
            currentBrowsePath = data.cwd;
            // Auto-expand file browser
            if (!fileBrowserExpanded) {
                toggleFileBrowser();
            }
            loadFiles(data.cwd);
        }
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
            // Use the message's own assistant label, fallback to session's assistant
            const msgAssistant = msg.assistant || assistant;
            const icon = ASSISTANT_ICONS[msgAssistant] || ASSISTANT_ICONS.default;
            html += `<div class="assistant-label">${icon} ${msgAssistant || 'Assistant'}</div>`;
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
                    html += `<div class="text-block">${renderMarkdown(block.text)}</div>`;
                }
            });
            html += '</div>';
        } else {
            html += `<div class="message-content">${msg.role === 'assistant' ? renderMarkdown(msg.content) : escapeHtml(msg.content)}</div>`;
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
    // Use the session's actual assistant, not the dropdown selection
    const session = sessions.find(s => s.id === currentSessionId);
    const streamAssistant = session ? session.assistant : currentAssistant;
    const icon = ASSISTANT_ICONS[streamAssistant] || ASSISTANT_ICONS.default;
    div.innerHTML = `
        <div class="assistant-label">${icon} ${streamAssistant}</div>
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

// Tool type icons
const TOOL_ICONS = {
    'Bash': '💻', 'bash': '💻',
    'Read': '📖', 'read': '📖',
    'Write': '✏️', 'write': '✏️',
    'Edit': '📝', 'edit': '📝',
    'Glob': '🔍', 'glob': '🔍',
    'Grep': '🔎', 'grep': '🔎',
    'WebFetch': '🌐', 'WebSearch': '🔎',
    'Agent': '🤖',
    'default': '🔧'
};

// Get tool preview text
function getToolPreview(name, input) {
    if (!input || typeof input !== 'object') return '';
    if (name === 'Bash' || name === 'bash') return input.command || '';
    if (name === 'Read' || name === 'read') return input.file_path || input.path || '';
    if (name === 'Write' || name === 'write') return input.file_path || input.path || '';
    if (name === 'Edit' || name === 'edit') return input.file_path || input.path || '';
    if (name === 'Glob' || name === 'glob') return input.pattern || '';
    if (name === 'Grep' || name === 'grep') return input.pattern || input.query || '';
    if (name === 'WebFetch') return input.url || '';
    if (name === 'WebSearch') return input.query || '';
    return input.command || input.path || input.file_path || input.pattern || input.query || '';
}

// Render tool call block (collapsible)
function renderToolCallBlock(id, name, input) {
    const icon = TOOL_ICONS[name] || TOOL_ICONS.default;
    let preview = getToolPreview(name, input);
    if (typeof preview === 'object') preview = JSON.stringify(preview);
    if (preview.length > 100) preview = preview.slice(0, 100) + '...';

    // Format input for display
    let inputDisplay;
    if (name === 'Bash' || name === 'bash') {
        // For Bash, show just the command prominently
        inputDisplay = input.command ? escapeHtml(input.command) : escapeHtml(JSON.stringify(input, null, 2));
    } else {
        inputDisplay = escapeHtml(JSON.stringify(input, null, 2));
    }

    return `<div class="tool-call-block" data-tool-id="${id}">
        <div class="tool-call-header" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="tool-icon">${icon}</span>
            <span class="tool-name">${escapeHtml(name)}</span>
            <span class="tool-preview">${escapeHtml(preview)}</span>
            <span class="tool-toggle">▶</span>
        </div>
        <div class="tool-call-content">
            <pre class="tool-input">${inputDisplay}</pre>
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

// Basic markdown rendering for text blocks
function renderMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);

    // Code blocks (```...```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code>${code}</code></pre>`;
    });

    // Inline code (`...`)
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Bold (**...**)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic (*...*)
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

    // Headings (### ... at start of line)
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Blockquote (> ...)
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Horizontal rule (---)
    html = html.replace(/^---$/gm, '<hr>');

    // Unordered list (- ... or * ...)
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');

    // Ordered list (1. ...)
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Wrap consecutive <li> in <ul>
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Paragraphs: double newline → paragraph break
    html = html.replace(/\n\n/g, '</p><p>');
    // Single newline → <br>
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraph if not already structured
    if (!html.startsWith('<')) {
        html = '<p>' + html + '</p>';
    }

    return html;
}

// Connect to SSE and handle streaming events
function connectSSE(sessionId, message, onDone) {
    // Close any existing SSE connection first
    if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
    }
    const es = new EventSource(`${API_BASE}/api/agent/${sessionId}/events`);
    currentEventSource = es;

    let streamingDiv = null;
    let contentDiv = null;
    let hasContent = false;
    let finalResult = '';

    // Collect content blocks for persistence
    const contentBlocks = [];
    const toolCallMap = {}; // id -> {name, input} for matching results
    let promptSent = false;
    let finished = false; // Guard against double-finish

    es.onmessage = (e) => {
        try {
            const event = JSON.parse(e.data);
            handleStreamEvent(event);
        } catch (err) {
            console.error('SSE parse error:', err);
        }
    };

    es.onerror = () => {
        if (!isStreaming || finished) return;
        if (!promptSent) {
            // First connection failed, retry once
            setTimeout(() => {
                if (isStreaming && !finished && es.readyState === EventSource.CLOSED && !promptSent) {
                    connectSSE(sessionId, message, onDone);
                }
            }, 1000);
        }
        // Note: if prompt was sent, we wait for the stream to end naturally
        // The safety timeout below will handle the case where it never ends
    };

    // Safety timeout: if streaming doesn't finish in 120 seconds, force finish
    const safetyTimeout = setTimeout(() => {
        if (!finished) {
            console.warn('[SSE] Safety timeout reached, forcing finish');
            finishStreaming();
        }
    }, 120000);

    function handleStreamEvent(event) {
        switch (event.type) {
            case 'connected':
                if (message && !promptSent) {
                    promptSent = true;
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
                const thinkingEl = document.createElement('div');
                thinkingEl.innerHTML = renderThinkingBlock(event.thinking);
                contentDiv.appendChild(thinkingEl.firstElementChild);
                hasContent = true;
                // Collect for persistence
                contentBlocks.push({ type: 'thinking', thinking: event.thinking });
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
                // Track tool call and collect for persistence
                toolCallMap[event.id] = { name: event.name, input: event.input };
                contentBlocks.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
                scrollToBottom();
                break;

            case 'tool_result':
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
                    if (!streamingDiv) {
                        streamingDiv = createStreamingMessage();
                        contentDiv = streamingDiv.querySelector('.message-content');
                    }
                    const resultEl = document.createElement('div');
                    resultEl.innerHTML = renderToolResultBlock(event.output);
                    contentDiv.appendChild(resultEl.firstElementChild);
                }
                // Collect for persistence
                contentBlocks.push({ type: 'tool_result', tool_use_id: event.id, content: event.output });
                scrollToBottom();
                break;

            case 'chunk':
                if (!streamingDiv) {
                    streamingDiv = createStreamingMessage();
                    contentDiv = streamingDiv.querySelector('.message-content');
                }
                let textBlock = contentDiv.querySelector('.text-block:last-child');
                if (!textBlock || textBlock.dataset.finalized === 'true') {
                    textBlock = document.createElement('div');
                    textBlock.className = 'text-block';
                    contentDiv.appendChild(textBlock);
                }
                textBlock.textContent = (textBlock.textContent || '') + event.content;
                hasContent = true;
                finalResult += event.content;
                // Collect text chunk
                const lastBlock = contentBlocks[contentBlocks.length - 1];
                if (lastBlock && lastBlock.type === 'text') {
                    lastBlock.text += event.content;
                } else {
                    contentBlocks.push({ type: 'text', text: event.content });
                }
                scrollToBottom();
                break;

            case 'result':
                if (!streamingDiv) {
                    streamingDiv = createStreamingMessage();
                    contentDiv = streamingDiv.querySelector('.message-content');
                }
                if (event.content && !hasContent) {
                    let lastText = contentDiv.querySelector('.text-block:last-child');
                    if (!lastText) {
                        lastText = document.createElement('div');
                        lastText.className = 'text-block';
                        contentDiv.appendChild(lastText);
                    }
                    lastText.textContent = event.content;
                    lastText.dataset.finalized = 'true';
                    finalResult = event.content;
                    // If no text blocks collected yet, add this
                    if (!contentBlocks.some(b => b.type === 'text')) {
                        contentBlocks.push({ type: 'text', text: event.content });
                    }
                } else if (event.content && !finalResult) {
                    finalResult = event.content;
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
        if (finished) return;
        finished = true;
        clearTimeout(safetyTimeout);

        es.close();
        currentEventSource = null;
        isStreaming = false;
        // Always re-enable send button
        setTimeout(() => {
            document.getElementById('sendBtn').disabled = false;
        }, 0);
        stopBtn.style.display = 'none';
        typingIndicator.style.display = 'none';
        if (streamingDiv) {
            streamingDiv.classList.remove('streaming');
        }

        // Save assistant response to backend for persistence
        if ((finalResult || contentBlocks.length > 0) && sessionId) {
            fetch(`${API_BASE}/api/agent/${sessionId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'save_message',
                    message: finalResult || '',
                    content_blocks: contentBlocks.length > 0 ? contentBlocks : undefined
                })
            }).catch(e => console.error('Failed to save response:', e));
        }

        loadSessions().then(() => renderSessionList());
        if (onDone) onDone();

        // Process next queued message
        setTimeout(processQueue, 500);
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
    if (!message) return;

    // If streaming, queue the message
    if (isStreaming) {
        messageQueue.push(message);
        messageInput.value = '';
        messageInput.style.height = 'auto';
        updateQueueStatus();
        return;
    }

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

// Force reset streaming state (when connection drops or session switches)
function resetStreamingState() {
    if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
    }
    isStreaming = false;
    // Always re-enable send button - use setTimeout to ensure DOM update
    setTimeout(() => {
        document.getElementById('sendBtn').disabled = false;
    }, 0);
    stopBtn.style.display = 'none';
    stopBtn.disabled = false;
    typingIndicator.style.display = 'none';
    const streamingMsg = document.querySelector('.message.streaming');
    if (streamingMsg) streamingMsg.classList.remove('streaming');
}

// Abort running session
async function abortSession() {
    if (!currentSessionId) return;
    try {
        await fetch(`${API_BASE}/api/agent/${currentSessionId}/abort`, {
            method: 'POST'
        });
    } catch (e) {
        console.error('Abort failed:', e);
    }
    resetStreamingState();
    loadSessions().then(() => renderSessionList());
    setTimeout(processQueue, 500);
}

// Update queue status display
function updateQueueStatus() {
    const existing = document.getElementById('queueStatus');
    if (messageQueue.length > 0) {
        if (!existing) {
            const div = document.createElement('div');
            div.id = 'queueStatus';
            div.className = 'queue-status';
            typingIndicator.parentNode.insertBefore(div, typingIndicator);
        }
        document.getElementById('queueStatus').textContent = `📨 ${messageQueue.length} message(s) queued`;
    } else if (existing) {
        existing.remove();
    }
}

// Process next message from queue
function processQueue() {
    if (messageQueue.length > 0 && !isStreaming && currentSessionId) {
        const nextMsg = messageQueue.shift();
        updateQueueStatus();
        sendToSession(nextMsg);
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
        // Clear previous messages and reset session state
        messagesContainer.innerHTML = '';
        currentSessionId = null;  // Detach from any old session
        currentAssistant = assistant;
        currentModel = model;
        pendingCwd = cwd;
        assistantSelector.value = assistant;
        modelSelector.value = model;
        statusDisplay.textContent = model;
        // Update sidebar highlight
        renderSessionList();
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

        // Clear previous messages for the new session
        messagesContainer.innerHTML = '';

        addMessage('user', message, assistant);
        stopBtn.style.display = 'inline-flex';
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

            // Refresh session list to show the new session in sidebar
            await loadSessions();
            renderSessionList();

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
        stopBtn.style.display = 'inline-flex';

        // Refresh sessions to update message count in sidebar
        await loadSessions();

        // Connect SSE, which will trigger start prompt on connect
        connectSSE(currentSessionId, message);
    } catch (e) {
        addMessage('assistant', `Error: ${e.message}`, currentAssistant);
        isStreaming = false;
        sendBtn.disabled = false;
        typingIndicator.style.display = 'none';
    }
}

// File Browser
function toggleFileBrowser() {
    fileBrowserExpanded = !fileBrowserExpanded;
    const content = document.getElementById('fileBrowserContent');
    const toggle = document.getElementById('fileBrowserToggle');
    content.style.display = fileBrowserExpanded ? 'block' : 'none';
    toggle.textContent = fileBrowserExpanded ? '▼' : '▶';
    if (fileBrowserExpanded && currentBrowsePath) {
        loadFiles(currentBrowsePath);
    }
}

async function loadFiles(dirPath) {
    currentBrowsePath = dirPath;
    const fileList = document.getElementById('fileList');
    const pathDisplay = document.getElementById('fileBrowserPath');

    // Show short path
    const shortPath = dirPath.split(/[/\\]/).slice(-2).join('/');
    pathDisplay.textContent = shortPath;

    try {
        const res = await fetch(`${API_BASE}/api/files?path=${encodeURIComponent(dirPath)}`);
        const data = await res.json();

        if (!data.success) {
            fileList.innerHTML = `<div class="file-error">${escapeHtml(data.error)}</div>`;
            return;
        }

        // Clear and rebuild using DOM (not innerHTML with onclick)
        fileList.innerHTML = '';

        // Parent directory link
        if (data.parent) {
            const parentItem = createFileItem('⬆️', '..', '', true);
            parentItem.onclick = () => loadFiles(data.parent);
            parentItem.classList.add('file-parent');
            fileList.appendChild(parentItem);
        }

        // Files and directories
        data.files.forEach(f => {
            const icon = f.is_dir ? '📁' : getFileIcon(f.name);
            const sizeStr = f.is_dir ? '' : formatFileSize(f.size);
            const item = createFileItem(icon, f.name, sizeStr, f.is_dir);
            item.onclick = () => {
                if (f.is_dir) {
                    loadFiles(f.path);
                } else {
                    viewFile(f.path);
                }
            };
            fileList.appendChild(item);
        });

        if (fileList.children.length === 0) {
            fileList.innerHTML = '<div class="file-empty">Empty directory</div>';
        }
    } catch (e) {
        fileList.innerHTML = `<div class="file-error">Failed to load</div>`;
    }
}

function createFileItem(icon, name, size, isDir) {
    const div = document.createElement('div');
    div.className = `file-item ${isDir ? 'is-dir' : 'is-file'}`;
    div.innerHTML = `
        <span class="file-icon">${icon}</span>
        <span class="file-name">${escapeHtml(name)}</span>
        <span class="file-size">${size}</span>
    `;
    return div;
}

function getFileIcon(name) {
    const ext = name.split('.').pop()?.toLowerCase();
    const icons = {
        'rs': '🦀', 'js': '📜', 'ts': '📘', 'py': '🐍', 'go': '🔵',
        'html': '🌐', 'css': '🎨', 'json': '📋', 'toml': '⚙️', 'yaml': '⚙️',
        'yml': '⚙️', 'md': '📝', 'txt': '📄', 'log': '📃',
        'png': '🖼️', 'jpg': '🖼️', 'gif': '🖼️', 'svg': '🖼️',
        'sh': '💻', 'bat': '💻', 'cmd': '💻', 'ps1': '💻',
        'exe': '⚙️', 'dll': '⚙️', 'so': '⚙️',
        'zip': '📦', 'tar': '📦', 'gz': '📦',
        'lock': '🔒', 'env': '🔐',
    };
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
        if (data.success) {
            // Show file content in a simple overlay or in the chat area
            showFileContent(filePath, data.content);
        } else {
            alert(data.error);
        }
    } catch (e) {
        alert('Failed to read file');
    }
}

function showFileContent(filePath, content) {
    const fileName = filePath.split(/[/\\]/).pop();
    const overlay = document.createElement('div');
    overlay.className = 'file-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="file-viewer">
            <div class="file-viewer-header">
                <span class="file-viewer-name">📄 ${escapeHtml(fileName)}</span>
                <button class="file-viewer-close" onclick="this.closest('.file-overlay').remove()">×</button>
            </div>
            <pre class="file-viewer-content">${escapeHtml(content)}</pre>
        </div>
    `;
    document.body.appendChild(overlay);
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
    stopBtn.onclick = abortSession;

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

// Safety net: re-enable send button if not streaming
setInterval(() => {
    if (!isStreaming && document.getElementById('sendBtn').disabled) {
        document.getElementById('sendBtn').disabled = false;
        stopBtn.style.display = 'none';
    }
}, 2000);

init();
