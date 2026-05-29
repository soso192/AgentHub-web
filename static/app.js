// CC-Web Frontend
const API_BASE = '';

// State
let currentSessionId = null;
let sessions = [];
let models = [];
let defaultModel = null;
let isStreaming = false;

// DOM Elements
const sidebar = document.getElementById('sidebar');
const toggleSidebar = document.getElementById('toggleSidebar');
const newSessionBtn = document.getElementById('newSessionBtn');
const newSessionForm = document.getElementById('newSessionForm');
const cwdInput = document.getElementById('cwdInput');
const createSessionBtn = document.getElementById('createSessionBtn');
const cancelSessionBtn = document.getElementById('cancelSessionBtn');
const sessionList = document.getElementById('sessionList');
const messagesContainer = document.getElementById('messages');
const welcomeScreen = document.getElementById('welcomeScreen');
const inputArea = document.getElementById('inputArea');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const modelSelect = document.getElementById('modelSelect');
const modelDisplay = document.getElementById('modelDisplay');
const typingIndicator = document.getElementById('typingIndicator');

// Initialize
async function init() {
    await loadModels();
    await loadSessions();
    setupEventListeners();
}

// Load models
async function loadModels() {
    try {
        const res = await fetch(`${API_BASE}/api/models`);
        const data = await res.json();
        models = data.model_list || [];
        defaultModel = data.default_model;
        
        updateModelSelect();
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

// Update model select
function updateModelSelect() {
    modelSelect.innerHTML = '';
    models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (defaultModel && m.id === defaultModel.model_id) {
            opt.selected = true;
        }
        modelSelect.appendChild(opt);
    });
    
    const selected = modelSelect.value;
    modelDisplay.textContent = selected || '';
}

// Render session list
function renderSessionList() {
    sessionList.innerHTML = '';
    sessions.forEach(session => {
        const div = document.createElement('div');
        div.className = `session-item ${session.id === currentSessionId ? 'active' : ''}`;
        div.innerHTML = `
            <div class="name">${session.firstMessage?.slice(0, 50) || 'Untitled'}</div>
            <div class="meta">${session.messageCount || 0} messages • ${session.model || ''}</div>
        `;
        div.onclick = () => selectSession(session.id);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '×';
        deleteBtn.style.cssText = 'float:right;background:none;border:none;cursor:pointer;font-size:16px;color:var(--text-dim);';
        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            if (confirm('Delete this session?')) {
                await deleteSession(session.id);
            }
        };
        div.querySelector('.name').appendChild(deleteBtn);
        
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
            renderMessages(data.messages);
        }
        
        welcomeScreen.style.display = 'none';
        messagesContainer.style.display = 'block';
        inputArea.style.display = 'block';
        typingIndicator.style.display = 'none';
        
        modelDisplay.textContent = data.model || '';
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
function renderMessages(messages) {
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
        const div = document.createElement('div');
        div.className = `message ${msg.role}`;
        div.innerHTML = `<div class="message-content">${escapeHtml(msg.content)}</div>`;
        messagesContainer.appendChild(div);
    });
    scrollToBottom();
}

// Add message to UI
function addMessage(role, content) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerHTML = `<div class="message-content">${escapeHtml(content)}</div>`;
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
        // Create new session
        const cwd = prompt('Enter working directory:', 'C:/Users/Administrator');
        if (!cwd) return;
        
        await createSession(cwd, message);
    } else {
        // Send to existing session
        await sendToSession(message);
    }
}

// Create new session
async function createSession(cwd, message) {
    const model = modelSelect.value;
    
    try {
        isStreaming = true;
        sendBtn.disabled = true;
        messageInput.value = '';
        
        addMessage('user', message);
        typingIndicator.style.display = 'block';
        
        const res = await fetch(`${API_BASE}/api/agent/new`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd, message, model })
        });
        
        const data = await res.json();
        
        if (data.success) {
            currentSessionId = data.sessionId;
            if (data.data?.response) {
                addMessage('assistant', data.data.response);
            }
            await loadSessions();
            selectSession(currentSessionId);
        } else {
            addMessage('assistant', `Error: ${data.error}`);
        }
    } catch (e) {
        addMessage('assistant', `Error: ${e.message}`);
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
        
        addMessage('user', message);
        typingIndicator.style.display = 'block';
        
        const res = await fetch(`${API_BASE}/api/agent/${currentSessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'prompt', message })
        });
        
        const data = await res.json();
        
        if (data.success && data.data?.response) {
            addMessage('assistant', data.data.response);
        } else {
            addMessage('assistant', `Error: ${data.error || 'Unknown error'}`);
        }
    } catch (e) {
        addMessage('assistant', `Error: ${e.message}`);
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
    
    createSessionBtn.onclick = async () => {
        const cwd = cwdInput.value.trim();
        if (!cwd) {
            alert('Please enter a working directory');
            return;
        }
        newSessionForm.style.display = 'none';
        cwdInput.value = '';
        
        // Create empty session and select it
        await createSession(cwd, 'Hello');
    };
    
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
    
    // Model change
    modelSelect.onchange = async () => {
        const model = modelSelect.value;
        modelDisplay.textContent = model;
        
        if (currentSessionId) {
            try {
                await fetch(`${API_BASE}/api/agent/${currentSessionId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'set_model', model })
                });
            } catch (e) {
                console.error('Failed to set model:', e);
            }
        }
    };
}

// Initialize on load
init();
