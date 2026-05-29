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
let pendingCwd = null;  // Store cwd before session is created

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

// Assistant icons
const ASSISTANT_ICONS = {
    'claude': '🤖',
    'codex': '⚡',
    'pi': 'π',
    'cursor': '📝',
    'default': '🔧'
};

// Assistant descriptions
const ASSISTANT_DESCS = {
    'claude': 'Anthropic Claude Code CLI',
    'codex': 'OpenAI Codex CLI',
    'pi': 'Pi Coding Agent',
    'cursor': 'Cursor AI Editor',
    'default': 'AI Assistant'
};

// Initialize
async function init() {
    await loadAssistants();
    await loadModels();
    await loadSessions();
    setupEventListeners();
    renderAssistantCards();
    renderAssistantStatus();
}

// Load assistants
async function loadAssistants() {
    try {
        const res = await fetch(`${API_BASE}/api/assistants`);
        const data = await res.json();
        assistants = data.assistants || [];
        
        // Set default assistant
        const defaultAssistant = assistants.find(a => a.is_default);
        if (defaultAssistant) {
            currentAssistant = defaultAssistant.name;
        }
        
        updateAssistantSelectors();
    } catch (e) {
        console.error('Failed to load assistants:', e);
        // Fallback to claude
        assistants = [{ name: 'claude', display_name: 'Claude Code', is_default: true }];
        currentAssistant = 'claude';
        updateAssistantSelectors();
    }
}

// Load models for current assistant
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

// Load sessions
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

// Update assistant selectors
function updateAssistantSelectors() {
    const selectors = [assistantSelect, assistantSelector];
    
    selectors.forEach(select => {
        select.innerHTML = '';
        assistants.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.name;
            opt.textContent = `${ASSISTANT_ICONS[a.name] || ASSISTANT_ICONS.default} ${a.display_name}`;
            if (a.name === currentAssistant) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });
    });
}

// Update model selectors
function updateModelSelectors() {
    const selectors = [modelSelectNew, modelSelector];
    
    selectors.forEach(select => {
        select.innerHTML = '';
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            if (m.id === currentModel) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });
    });
    
    // Update status
    statusDisplay.textContent = currentModel || '';
}

// Render assistant cards on welcome screen
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

// Render assistant status in sidebar footer
function renderAssistantStatus() {
    assistantStatus.innerHTML = '';
    
    assistants.forEach(a => {
        const badge = document.createElement('span');
        badge.className = `assistant-badge-lg ${a.name === currentAssistant ? 'active' : ''}`;
        badge.innerHTML = `
            <span class="dot"></span>
            ${ASSISTANT_ICONS[a.name] || ASSISTANT_ICONS.default} ${a.name}
        `;
        badge.onclick = () => selectAssistant(a.name);
        assistantStatus.appendChild(badge);
    });
}

// Select assistant
function selectAssistant(name) {
    currentAssistant = name;
    
    // Update UI
    assistantSelect.value = name;
    assistantSelector.value = name;
    renderAssistantCards();
    renderAssistantStatus();
    
    // Reload models for this assistant
    loadModels();
}

// Render session list
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
            if (!e.target.classList.contains('delete-btn')) {
                selectSession(session.id);
            }
        };
        
        const deleteBtn = div.querySelector('.delete-btn');
        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            if (confirm('Delete this session?')) {
                await deleteSession(session.id);
            }
        };
        
        sessionList.appendChild(div);
    });
}

// Select session
async function selectSession(sessionId) {
    currentSessionId = sessionId;
    renderSessionList();
    
    try {
        const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
        const data = await res.json();
        
        if (data.messages) {
            renderMessages(data.messages, data.assistant);
        }
        
        // Update current assistant/model based on session
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
    } catch (e) {
        console.error('Failed to load session:', e);
    }
}

// Delete session
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

// Render messages
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
        html += `<div class="message-content">${escapeHtml(msg.content)}</div>`;
        
        div.innerHTML = html;
        messagesContainer.appendChild(div);
    });
    scrollToBottom();
}

// Add message to UI
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

// Scroll to bottom
function scrollToBottom() {
    const container = document.getElementById('chatContainer');
    container.scrollTop = container.scrollHeight;
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Send message
async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message || isStreaming) return;
    
    if (!currentSessionId) {
        // Need to create a session first
        if (pendingCwd) {
            // We have a pending cwd from createSession()
            await createSessionWithMessage(pendingCwd, message);
        } else {
            // Show new session form
            newSessionForm.style.display = 'block';
            cwdInput.focus();
        }
    } else {
        await sendToSession(message);
    }
}

// Create new session (without sending message)
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
        // Show chat UI without creating backend session
        welcomeScreen.style.display = 'none';
        messagesContainer.style.display = 'block';
        inputArea.style.display = 'block';
        
        // Store session info locally (will be created on first message)
        currentAssistant = assistant;
        currentModel = model;
        pendingCwd = cwd;  // Store for later use
        
        // Update UI
        assistantSelector.value = assistant;
        modelSelector.value = model;
        statusDisplay.textContent = model;
        
        // Focus on message input
        messageInput.focus();
        
    } catch (e) {
        console.error('Failed to create session:', e);
        alert('Failed to create session: ' + e.message);
    }
}

// Create session and send first message
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
        
        const res = await fetch(`${API_BASE}/api/agent/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                cwd, 
                message, 
                model,
                assistant 
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            currentSessionId = data.sessionId;
            currentAssistant = data.assistant || assistant;
            pendingCwd = null;  // Clear pending cwd
            
            if (data.data?.response) {
                addMessage('assistant', data.data.response, currentAssistant);
            }
            
            await loadSessions();
            renderSessionList();
        } else {
            addMessage('assistant', `Error: ${data.error}`, assistant);
        }
    } catch (e) {
        addMessage('assistant', `Error: ${e.message}`, assistant);
    } finally {
        isStreaming = false;
        sendBtn.disabled = false;
        typingIndicator.style.display = 'none';
    }
}

// Send to existing session
async function sendToSession(message) {
    try {
        isStreaming = true;
        sendBtn.disabled = true;
        messageInput.value = '';
        messageInput.style.height = 'auto';
        
        addMessage('user', message);
        typingIndicator.style.display = 'block';
        typingIndicator.querySelector('.assistant-name').textContent = currentAssistant;
        
        const res = await fetch(`${API_BASE}/api/agent/${currentSessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'prompt', message })
        });
        
        const data = await res.json();
        
        if (data.success && data.data?.response) {
            addMessage('assistant', data.data.response, currentAssistant);
        } else {
            addMessage('assistant', `Error: ${data.error || 'Unknown error'}`, currentAssistant);
        }
    } catch (e) {
        addMessage('assistant', `Error: ${e.message}`, currentAssistant);
    } finally {
        isStreaming = false;
        sendBtn.disabled = false;
        typingIndicator.style.display = 'none';
    }
}

// Setup event listeners
function setupEventListeners() {
    // Toggle sidebar
    toggleSidebar.onclick = () => {
        sidebar.classList.toggle('closed');
    };
    
    // New session form
    newSessionBtn.onclick = () => {
        newSessionForm.style.display = newSessionForm.style.display === 'none' ? 'block' : 'none';
    };
    
    cancelSessionBtn.onclick = () => {
        newSessionForm.style.display = 'none';
        cwdInput.value = '';
    };
    
    createSessionBtn.onclick = createSession;
    
    // Send message
    sendBtn.onclick = sendMessage;
    
    messageInput.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };
    
    // Auto-resize textarea
    messageInput.oninput = () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
    };
    
    // Assistant selector change
    assistantSelector.onchange = (e) => {
        selectAssistant(e.target.value);
    };
    
    // Model selector change
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
    
    // Enter key in cwd input
    cwdInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            createSession();
        }
    };
}

// Initialize on load
init();
