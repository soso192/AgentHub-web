// ============================================================
//  common.js - 开发版与小白版共用的通用工具函数
//  包含：登录/token、patchRequest、分页、转义、错误弹框
// ============================================================

const PATCH_TOKEN_KEY = 'patch-search-access-token';
const PATCH_REQUEST_TIMEOUT = 60000; // 单个服务地址单次请求超时（毫秒），超时视为该地址不可用并切换下一条

// ── 单地址 fetch：叠加调用方 signal（若有）与超时；超时/连不上时 reject，由上层切换地址 ──
function patchFetchTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const callerSignal = init && init.signal;
    if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, Object.assign({}, init, { signal: controller.signal }))
        .then(response => { clearTimeout(timer); return response; }, error => { clearTimeout(timer); throw error; });
}

// ── HTML 转义 ──
function patchEscape(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

// ── 日期时间格式化 ──
function patchFormatDateTime(value) {
    if (value == null || value === '') return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// ── 文件大小格式化 ──
function patchFormatSize(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// ── Token 操作 ──
function patchToken() { return localStorage.getItem(PATCH_TOKEN_KEY) || ''; }

function patchSetToken(token) {
    if (token) localStorage.setItem(PATCH_TOKEN_KEY, token);
    else localStorage.removeItem(PATCH_TOKEN_KEY);
}

function patchClearToken() {
    localStorage.removeItem(PATCH_TOKEN_KEY);
}

// ── 错误弹窗 ──
// 使用方需要在 HTML 里提供：
//   <div id="patchErrorModal" hidden>
//     <div><h3 id="patchErrorTitle">操作失败</h3></div>
//     <div id="patchErrorMessage"></div>
//     <button id="patchErrorConfirm" onclick="patchCloseError()">确定</button>
//   </div>
function patchShowError(message, title = '操作失败') {
    // authInvalidated 标记由使用方管理，这里只检查全局 patchState.authInvalidated（若存在）
    if (typeof patchState !== 'undefined' && patchState.authInvalidated && title !== '登录已失效') return;
    const modal = document.getElementById('patchErrorModal');
    if (!modal) { console.error('patchErrorModal not found:', message); return; }
    const titleEl = document.getElementById('patchErrorTitle');
    const msgEl = document.getElementById('patchErrorMessage');
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message || '发生未知错误，请稍后重试。';
    modal.hidden = false;
    requestAnimationFrame(() => {
        const confirm = document.getElementById('patchErrorConfirm');
        if (confirm) confirm.focus();
    });
}

function patchCloseError() {
    const modal = document.getElementById('patchErrorModal');
    if (modal) modal.hidden = true;
}

// ── patchRequest：多服务地址轮询、自动重试、401/403 处理 ──
// 调用方需在全局 patchState 提供：
//   - patchSearchServers: string[]
//   - patchServerCursor: number（会被修改）
//   - authInvalidated: boolean（由 patchHandleUnauthorized 置位）
// 并提供 patchHandleUnauthorized() 函数用于处理 401
async function patchRequest(path, options = {}) {
    if (typeof patchState === 'undefined' || !patchState.patchSearchServers) {
        throw new Error('patchState 或 patchSearchServers 未初始化');
    }
    const headers = new Headers(options.headers || {});
    const requestToken = patchToken();
    if (requestToken) headers.set('Authorization', `Bearer ${requestToken}`);
    const servers = patchState.patchSearchServers;
    if (!servers.length) throw new Error('补丁服务地址尚未加载，请稍候重试。');
    const start = patchState.patchServerCursor % servers.length;
    patchState.patchServerCursor = start + 1;
    for (let attempt = 0; attempt < servers.length; attempt += 1) {
        const base = servers[(start + attempt) % servers.length];
        const url = `${base.replace(/\/+$/, '')}${path}`;
        let response;
        try {
            response = await patchFetchTimeout(url, { ...options, headers }, PATCH_REQUEST_TIMEOUT);
        } catch (error) {
            if (options.signal && options.signal.aborted) throw error; // 调用方主动取消，不切换
            continue; // 连不上/超时：切换下一条地址
        }
        // 只要收到了 HTTP 响应（无论状态码）都视为该地址可达、应答权威，不再切换
        const payload = await response.json().catch(() => ({}));
        // 登录接口的 401 = 账号或密码不对，不是"会话失效"：按普通错误抛出（保留服务端 message/detail），
        // 也不能走 patchHandleUnauthorized（它会把 authInvalidated 置 true，导致错误弹窗被 patchShowError 吞掉）。
        const isLoginRequest = path.indexOf('/api/auth/login') === 0;
        if (response.status === 401 && !isLoginRequest) {
            if (patchToken() === requestToken && typeof patchHandleUnauthorized === 'function') {
                patchHandleUnauthorized();
            }
            throw new Error('登录已失效，请重新登录');
        }
        if (response.status === 403) throw new Error('权限不足');
        if (!response.ok || payload.code !== 0) throw new Error(payload.message || payload.detail || '请求失败');
        return payload.data;
    }
    throw new Error('无法连接服务器，请稍后重试或联系管理员');
}

// ── 登录 ──
// 调用方需在 HTML 提供：#patchLoginUsername、#patchLoginPassword、#patchLoginMessage
// 并提供 patchSetAuthenticated(user) 函数用于设置登录状态
async function patchLogin() {
    if (typeof patchState === 'undefined' || !patchState.patchSearchServers || !patchState.patchSearchServers.length) {
        patchShowError('补丁服务地址尚未加载，请稍候重试。', '配置缺失');
        return;
    }
    const usernameEl = document.getElementById('patchLoginUsername');
    const passwordEl = document.getElementById('patchLoginPassword');
    const messageEl = document.getElementById('patchLoginMessage');
    if (!usernameEl || !passwordEl) {
        patchShowError('登录表单元素缺失', '初始化错误');
        return;
    }
    const username = usernameEl.value.trim();
    const password = passwordEl.value;
    try {
        const data = await patchRequest('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        patchSetToken(data.access_token);
        if (typeof patchState !== 'undefined') patchState.authInvalidated = false;
        if (typeof patchSetAuthenticated === 'function') patchSetAuthenticated(data.user);
        if (messageEl) messageEl.textContent = '';
    } catch (error) {
        if (messageEl) messageEl.textContent = '';
        // 登录失败要弹窗；先把可能的"会话失效"标记清掉，否则 patchShowError 会被 authInvalidated 吞掉
        if (typeof patchState !== 'undefined') patchState.authInvalidated = false;
        const raw = String(error.message || '');
        const text = /invalid username or password/i.test(raw) ? '用户名或密码错误' : (raw || '登录失败，请稍后重试');
        patchShowError(text, '登录失败');
    }
}

// ── 恢复登录态 ──
// 调用方需提供 patchSetAuthenticated(user)、patchHandleUnauthorized()、patchSetApiStatus(status)、patchShowAuthRetry(message)
async function patchRestoreAuth() {
    if (!patchToken()) {
        if (typeof patchSetAuthenticated === 'function') patchSetAuthenticated(null);
        return false;
    }
    try {
        const user = await patchRequest('/api/auth/me');
        if (typeof patchSetAuthenticated === 'function') patchSetAuthenticated(user);
        return true;
    } catch (error) {
        // 只有服务端明确返回 401（patchRequest 已置 authInvalidated 并清掉 token）才算登录失效；
        // 网络不通/超时等临时故障保留 token，停在 pending 提示上让用户重试，避免刷新时被误踢回登录页。
        if (typeof patchState !== 'undefined' && patchState.authInvalidated) {
            if (typeof patchHandleUnauthorized === 'function') patchHandleUnauthorized();
            return false;
        }
        if (typeof patchSetApiStatus === 'function') patchSetApiStatus('error');
        if (typeof patchShowAuthRetry === 'function') patchShowAuthRetry(error.message);
        return false;
    }
}

// ── 统一分页条 ──
// 所有列表共用：显示「共 N 条 · 第 X/Y 页」+ 上/下页 + 跳转输入 + 每页条数下拉。
// DOM 约定：容器带 data-pager="<key>"，内部有 [data-pager-info]/[data-pager-prev]/[data-pager-next]/
// [data-pager-jump]/[data-pager-go]/[data-pager-size]。事件用 document 级委托统一处理（见 patchBindPagerEvents）。
// 每页条数按 key 记在 localStorage，下次进页沿用。
// 列表接线：patchRegisterPager(key, state, reload)，其中 state 为 {page,size,total}（组件会就地改 page/size），
// reload 为「重新取数或重渲染」的函数；每次加载完调 patchRenderPager(key) 刷新分页条。
const patchPagers = {};

function patchPagerTotalPages(state) {
    return Math.max(1, Math.ceil((state.total || 0) / (state.size || 10)));
}

function patchPagerLoadSize(key, def = 10) {
    const v = parseInt(localStorage.getItem(`cc-web-pager-size-${key}`) || '', 10);
    return Number.isFinite(v) && v > 0 ? v : def;
}

function patchPagerSaveSize(key, size) {
    try { localStorage.setItem(`cc-web-pager-size-${key}`, String(size)); } catch {}
}

function patchRegisterPager(key, state, reload, maxSize = 100) {
    patchPagers[key] = { state, reload, maxSize };
}

function patchRenderPager(key) {
    const entry = patchPagers[key];
    const host = document.querySelector(`[data-pager="${key}"]`);
    if (!entry || !host) return;
    const state = entry.state;
    const totalPages = patchPagerTotalPages(state);
    if (state.page > totalPages) state.page = totalPages;
    const info = host.querySelector('[data-pager-info]');
    if (info) info.textContent = `共 ${state.total || 0} 条 · 第 ${state.page} / ${totalPages} 页`;
    const prev = host.querySelector('[data-pager-prev]');
    const next = host.querySelector('[data-pager-next]');
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= totalPages;
    const sizeSel = host.querySelector('[data-pager-size]');
    if (sizeSel && String(sizeSel.value) !== String(state.size)) sizeSel.value = String(state.size);
    const jump = host.querySelector('[data-pager-jump]');
    if (jump) jump.max = String(totalPages);
}

function patchPagerJump(key) {
    const entry = patchPagers[key];
    const host = document.querySelector(`[data-pager="${key}"]`);
    if (!entry || !host) return;
    const input = host.querySelector('[data-pager-jump]');
    let page = parseInt((input && input.value) || '', 10);
    if (!Number.isFinite(page)) return;
    page = Math.min(Math.max(1, page), patchPagerTotalPages(entry.state));
    entry.state.page = page;
    if (input) input.value = '';
    entry.reload();
}

// 事件委托只绑一次：上一页/下一页/跳转/每页条数
function patchBindPagerEvents() {
    document.addEventListener('click', event => {
        const host = event.target.closest('[data-pager]');
        if (!host) return;
        const entry = patchPagers[host.dataset.pager];
        if (!entry) return;
        if (event.target.closest('[data-pager-prev]')) {
            if (entry.state.page > 1) { entry.state.page -= 1; entry.reload(); }
            return;
        }
        if (event.target.closest('[data-pager-next]')) {
            if (entry.state.page < patchPagerTotalPages(entry.state)) { entry.state.page += 1; entry.reload(); }
            return;
        }
        if (event.target.closest('[data-pager-go]')) patchPagerJump(host.dataset.pager);
    });
    document.addEventListener('keydown', event => {
        if (!event.target.matches || !event.target.matches('[data-pager-jump]')) return;
        if (event.key !== 'Enter') return;
        const host = event.target.closest('[data-pager]');
        if (host) { event.preventDefault(); patchPagerJump(host.dataset.pager); }
    });
    document.addEventListener('change', event => {
        if (!event.target.matches || !event.target.matches('[data-pager-size]')) return;
        const host = event.target.closest('[data-pager]');
        if (!host) return;
        const entry = patchPagers[host.dataset.pager];
        if (!entry) return;
        const size = Math.max(1, Math.min(entry.maxSize || 100, parseInt(event.target.value, 10) || 10));
        entry.state.size = size;
        entry.state.page = 1;
        patchPagerSaveSize(host.dataset.pager, size);
        entry.reload();
    });
}

// 分页条内部控件（宿主 div 由 HTML 提供：<div class="patch-pager" data-pager="key"></div>）
function patchPagerControlsHTML(sizes = [10, 20, 50, 100]) {
    return `<span class="patch-pager-info" data-pager-info>共 0 条</span>
        <select class="patch-pager-select" data-pager-size aria-label="每页条数">
            ${sizes.map(size => `<option value="${size}">${size} 条/页</option>`).join('\n            ')}
        </select>
        <button type="button" class="patch-link-btn" data-pager-prev>上一页</button>
        <button type="button" class="patch-link-btn" data-pager-next>下一页</button>
        <input class="patch-pager-jump" data-pager-jump type="number" min="1" placeholder="页码" aria-label="跳转到页码">
        <button type="button" class="patch-link-btn" data-pager-go>跳转</button>`;
}
