const PATCH_PAGE_SIZE = 10;
const PATCH_TOKEN_KEY = 'patch-search-access-token';
const PATCH_REQUEST_TIMEOUT = 60000; // 单个服务地址单次请求超时（毫秒），超时视为该地址不可用并切换下一条

const patchState = { page: 1, keyword: '', files: [], theme: 'light', patchSearchServers: [], patchServerCursor: 0, user: null, dashboard: null, authInvalidated: false, searchGeneration: 0, products: null, advancedOpen: false, advanced: { name: '', product: '', version: '', keyword: '', description: '' }, searchItems: [], admin: { kind: '', id: null, flows: [], prompts: [], templates: [], directories: [], directoryId: null, menuConfig: { roleItems: [], defaults: {}, users: [], userId: '' }, analysisPatches: [], selectedAnalysisIds: new Set(), analysisTimer: null, products: [], productId: null }, workflow: { runId: '', steps: [], currentStep: 0, status: '', source: null, token: '', lastEventId: 0, localExecutions: new Set(), templates: [] }, workflowHistory: { page: 1, size: 10, total: 0, items: [] }, workflowDetail: { runId: '', snapshot: null }, mine: { page: 1, size: 10, total: 0, items: [], generation: 0 } };

// 服务地址由 cc-web 在代码内写死（可配多条），经 /api/patch-config 下发。
// 轮询策略：每个请求取一个起始地址（游标后移实现轮询），若连不上/超时则依次切换下一条，
// 直到全部地址都失败才报错。以下 patchServerBase/patchApiUrl 用于非 patchRequest 的直连场景。
function patchServerBase() {
    const servers = patchState.patchSearchServers;
    if (!servers.length) return '';
    const base = servers[patchState.patchServerCursor % servers.length];
    patchState.patchServerCursor += 1;
    return base;
}

function patchApiUrl(path) {
    return `${patchServerBase().replace(/\/+$/, '')}${path}`;
}

async function patchLoadConfig() {
    const message = '无法连接补丁中心：cc-web 未运行或 /api/patch-config 接口异常，请稍后重试。';
    let servers = [];
    try {
        const response = await fetch('/api/patch-config');
        if (response.ok) {
            const config = await response.json().catch(() => ({}));
            if (config && typeof config === 'object') {
                if (Array.isArray(config.patch_search_servers)) servers = config.patch_search_servers;
                else if (config.patch_search_api) servers = [config.patch_search_api]; // 兼容旧格式
            }
        }
    } catch {}
    servers = (servers || []).map(value => String(value).trim()).filter(Boolean);
    if (!servers.length) throw new Error(message);
    patchState.patchSearchServers = servers;
    patchState.patchServerCursor = 0;
}

// 单地址 fetch：叠加调用方 signal（若有）与超时；超时/连不上时 reject，由上层切换地址。
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

function patchEscape(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function patchFormatDateTime(value) {
    if (value == null || value === '') return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function patchFormatSize(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function patchSetTheme(theme) {
    patchState.theme = theme;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cc-web-theme', theme);
    document.getElementById('patchThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

function patchInitTheme() {
    const saved = localStorage.getItem('cc-web-theme');
    patchSetTheme(saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
}

/* ── 菜单可见性（与后端 menu_service.MENU_CATALOG 顺序一致） ── */
// 注意：管理端的 menus 页签不在此清单内，它是硬编码 admin-only，不受配置约束。
// 顺序即左侧导航/页签顺序，首个可见项也是登录后默认停留的页签（智能开发优先）
const PATCH_MENU_KEYS = ['smart', 'search', 'upload', 'mine', 'flow', 'prompt', 'template', 'analysis', 'product', 'directory'];

// 旧后端（/api/auth/me 无 menus 字段）时严格复刻改造前的显隐规则，保证前端可先于后端发布。
function legacyMenuKeys(user, isAdmin) {
    const base = ['search', 'upload', 'mine', 'smart', 'directory'];
    if (user) base.push('flow', 'prompt', 'template');
    if (isAdmin) base.push('analysis', 'product');
    return base;
}

function isTabVisible(tab) {
    const button = tab && document.querySelector(`.patch-tab[data-tab="${tab}"]`);
    return Boolean(button && !button.hidden);
}

// 按服务端下发的 menus 应用页签显隐，并同步左侧导航；返回当前可见键集合。
function applyMenuVisibility(user, isAdmin) {
    const keys = new Set(user && Array.isArray(user.menus) ? user.menus : legacyMenuKeys(user, isAdmin));
    PATCH_MENU_KEYS.forEach(key => {
        const tab = document.querySelector(`.patch-tab[data-tab="${key}"]`);
        if (tab) tab.hidden = !keys.has(key);
    });
    const configTab = document.querySelector('.patch-tab[data-tab="menus"]');
    if (configTab) configTab.hidden = !isAdmin;
    patchSyncSidenavVisibility();
    return keys;
}

/* ── 左侧固定导航（与顶部菜单一致） ── */
function patchSyncSidenavVisibility() {
    const nav = document.getElementById('patchSidenav');
    if (!nav) return;
    nav.querySelectorAll('.patch-sidenav-item').forEach(item => {
        const tabButton = item.dataset.sidenavTab && document.querySelector(`.patch-tab[data-tab="${item.dataset.sidenavTab}"]`);
        if (tabButton) item.hidden = tabButton.hidden;
    });
}
function patchSidenavSyncToggle() {
    const toggle = document.getElementById('patchSidenavToggle');
    if (!toggle) return;
    const collapsed = document.documentElement.classList.contains('sidenav-collapsed');
    toggle.textContent = collapsed ? '›' : '‹';
    toggle.title = collapsed ? '展开菜单' : '收起菜单';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(!collapsed));
}
function patchToggleSidenav() {
    const collapsed = document.documentElement.classList.toggle('sidenav-collapsed');
    try { localStorage.setItem('cc-web-patch-sidenav', collapsed ? '0' : '1'); } catch {}
    patchSidenavSyncToggle();
}
function patchSetSidenavActive(tab) {
    const nav = document.getElementById('patchSidenav');
    if (!nav) return;
    nav.querySelectorAll('.patch-sidenav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.sidenavTab === tab);
    });
}
function patchInitSidenav() {
    const toggle = document.getElementById('patchSidenavToggle');
    if (toggle) toggle.addEventListener('click', patchToggleSidenav);
    patchSidenavSyncToggle();
    const nav = document.getElementById('patchSidenav');
    if (nav) nav.addEventListener('click', (event) => {
        const item = event.target.closest('.patch-sidenav-item');
        if (!item || !item.dataset.sidenavTab) return;
        const tab = item.dataset.sidenavTab;
        const tabButton = document.querySelector(`.patch-tab[data-tab="${tab}"]`);
        // 本页存在且已登录时在页内切换；否则走链接跳转（如从流程详情页进入）
        if (tabButton && !tabButton.hidden && patchToken()) {
            event.preventDefault();
            if (document.querySelector('.patch-tab.active')?.dataset.tab !== tab) patchSwitchTab(tab);
            const url = new URL(location.href);
            url.searchParams.set('tab', tab);
            history.replaceState(null, '', url);
        }
    });
    const urlTab = new URLSearchParams(location.search).get('tab');
    const urlTabButton = urlTab && document.querySelector(`.patch-tab[data-tab="${urlTab}"]`);
    const activeTab = urlTabButton ? urlTab : (document.querySelector('.patch-tab.active')?.dataset.tab || '');
    patchSetSidenavActive(activeTab);
}

function patchShowError(message, title = '操作失败') {
    if (patchState.authInvalidated && title !== '登录已失效') return;
    const modal = document.getElementById('patchErrorModal');
    document.getElementById('patchErrorTitle').textContent = title;
    document.getElementById('patchErrorMessage').textContent = message || '发生未知错误，请稍后重试。';
    modal.hidden = false;
    requestAnimationFrame(() => document.getElementById('patchErrorConfirm').focus());
}

function patchCloseError() {
    document.getElementById('patchErrorModal').hidden = true;
}

function patchConfirm(message, title = '确认操作') {
    return new Promise(resolve => {
        const modal = document.getElementById('patchConfirmModal');
        const close = accepted => { modal.hidden = true; resolve(accepted); };
        document.getElementById('patchConfirmTitle').textContent = title;
        document.getElementById('patchConfirmMessage').textContent = message;
        document.getElementById('patchConfirmCancel').onclick = () => close(false);
        document.getElementById('patchConfirmAccept').onclick = () => close(true);
        modal.onclick = event => { if (event.target === modal) close(false); };
        modal.hidden = false;
        requestAnimationFrame(() => document.getElementById('patchConfirmAccept').focus());
    });
}

function patchSetMessage(message, error = false) {
    const element = document.getElementById('patchSearchMessage');
    element.textContent = error ? '' : (message || '');
    element.className = 'patch-message';
    if (error) patchShowError(message, '搜索失败');
}

function patchToken() { return localStorage.getItem(PATCH_TOKEN_KEY) || ''; }

function patchSetAuthenticated(user) {
    const login = document.getElementById('patchLoginCard');
    const layout = document.getElementById('patchAuthLayout');
    const userLabel = document.getElementById('patchCurrentUser');
    const logout = document.getElementById('patchLogout');
    const authenticated = Boolean(user);
    const isAdmin = authenticated && user.role === 'admin';
    // 左侧固定菜单仅在登录态展示（聊天页/未登录登录卡不展示）
    document.documentElement.classList.toggle('patch-auth', authenticated);
    document.documentElement.classList.remove('patch-auth-pending');
    const previousUserId = patchState.user?.id;
    const userChanged = previousUserId !== (user?.id ?? null);
    patchState.user = user || null;
    if (!authenticated || userChanged) resetWorkflowRunState();
    if (!authenticated) { patchState.dashboard = null; document.getElementById('patchUserMetrics').textContent = '请登录后查看'; document.getElementById('patchLeaderboard').textContent = '请登录后查看'; document.getElementById('patchActivityLeaderboard').textContent = '请登录后查看'; patchState.workflowHistory = {page: 1, size: 10, total: 0, items: []}; patchState.workflowDetail = {runId: '', snapshot: null}; document.getElementById('workflowHistoryBody').innerHTML = '<tr><td colspan="6" class="patch-empty">暂无流程运行记录</td></tr>'; patchState.mine = {page: 1, size: 10, total: 0, items: [], generation: 0}; const mineBody = document.getElementById('patchMineBody'); if (mineBody) mineBody.innerHTML = '<tr><td colspan="7" class="patch-empty">请登录后查看</td></tr>'; patchState.products = null; patchState.admin.products = []; patchState.admin.productId = null; const productBody = document.getElementById('patchProductBody'); if (productBody) productBody.innerHTML = '<tr><td colspan="4" class="patch-empty">请登录后查看</td></tr>'; }
    if (login) login.hidden = authenticated;
    if (layout) layout.hidden = !authenticated;
    applyMenuVisibility(user, isAdmin);
    // 安全网：已登录但一个菜单都不可见时强制显示第一个菜单（智能开发），避免登录后只剩空白界面
    if (authenticated && !PATCH_MENU_KEYS.some(isTabVisible)) {
        const searchTab = document.querySelector(`.patch-tab[data-tab="${PATCH_MENU_KEYS[0]}"]`);
        if (searchTab) searchTab.hidden = false;
        patchSyncSidenavVisibility();
    }
    const activeTab = document.querySelector('.patch-tab.active')?.dataset.tab;
    // 默认落在第一个可见菜单（智能开发）；菜单被隐藏时顺延到下一个可见项
    const fallbackTab = PATCH_MENU_KEYS.find(isTabVisible) || PATCH_MENU_KEYS[0];
    if (userChanged || !authenticated || !isTabVisible(activeTab)) patchSwitchTab(fallbackTab);
    if (userChanged) {
        patchState.admin.flows = [];
        patchState.admin.prompts = [];
        patchState.admin.templates = [];
        patchState.admin.directories = [];
        patchState.admin.directoryId = null;
        patchState.admin.menuConfig = { roleItems: [], defaults: {}, users: [], userId: '' };
        const menuRoleBody = document.getElementById('patchMenuRoleBody');
        if (menuRoleBody) menuRoleBody.innerHTML = '<tr><td colspan="4" class="patch-empty">正在加载...</td></tr>';
        const menuRoleMessage = document.getElementById('patchMenuRoleMessage');
        if (menuRoleMessage) menuRoleMessage.textContent = '';
        const menuUserBody = document.getElementById('patchMenuUserBody');
        if (menuUserBody) menuUserBody.innerHTML = '<tr><td colspan="4" class="patch-empty">请选择用户</td></tr>';
        const menuUserMessage = document.getElementById('patchMenuUserMessage');
        if (menuUserMessage) menuUserMessage.textContent = '';
        const menuUserSelect = document.getElementById('patchMenuUserSelect');
        if (menuUserSelect) menuUserSelect.innerHTML = '<option value="">选择用户</option>';
        const menuUserSearch = document.getElementById('patchMenuUserSearch');
        if (menuUserSearch) menuUserSearch.value = '';
        document.getElementById('patchDirectoryBody').innerHTML = '<tr><td colspan="6" class="patch-empty">暂无工作目录</td></tr>';
        document.getElementById('patchDirectoryMessage').textContent = '';
        patchState.mine = {page: 1, size: 10, total: 0, items: [], generation: 0};
        document.getElementById('patchMineBody').innerHTML = '<tr><td colspan="7" class="patch-empty">正在加载...</td></tr>';
        document.getElementById('patchMinePageInfo').textContent = '第 1 页';
        patchState.products = null;
        patchState.admin.products = [];
        patchState.admin.productId = null;
        const newProductBody = document.getElementById('patchProductBody');
        if (newProductBody) newProductBody.innerHTML = '<tr><td colspan="4" class="patch-empty">正在加载...</td></tr>';
    }
    if (!isAdmin) {
        if (patchState.admin.analysisTimer) clearTimeout(patchState.admin.analysisTimer);
        patchState.admin.analysisTimer = null;
        patchState.admin.analysisPatches = [];
        patchState.admin.selectedAnalysisIds.clear();
    }
    document.querySelectorAll('.modal-overlay').forEach(modal => { if (!authenticated) modal.hidden = true; });
    if (userLabel) userLabel.textContent = authenticated ? `${user.display_name || user.username} (${user.role})` : '';
    if (logout) logout.hidden = !authenticated;
    const userSettings = document.getElementById('patchUserSettings');
    if (userSettings) userSettings.hidden = !authenticated;
}

function patchHandleUnauthorized() {
    if (patchState.authInvalidated) return;
    patchState.authInvalidated = true;
    localStorage.removeItem(PATCH_TOKEN_KEY);
    closeWorkflowStream();
    patchSetAuthenticated(null);
    document.getElementById('patchLoginMessage').textContent = '登录已失效，请重新登录';
}

async function patchRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const requestToken = patchToken();
    if (requestToken) headers.set('Authorization', `Bearer ${requestToken}`);
    const servers = patchState.patchSearchServers;
    if (!servers.length) throw new Error('补丁服务地址尚未加载，请稍候重试。');
    const start = patchState.patchServerCursor % servers.length;
    patchState.patchServerCursor = start + 1;
    let lastError = null;
    for (let attempt = 0; attempt < servers.length; attempt += 1) {
        const base = servers[(start + attempt) % servers.length];
        const url = `${base.replace(/\/+$/, '')}${path}`;
        let response;
        try {
            response = await patchFetchTimeout(url, { ...options, headers }, PATCH_REQUEST_TIMEOUT);
        } catch (error) {
            if (options.signal && options.signal.aborted) throw error; // 调用方主动取消，不切换
            lastError = error;
            continue; // 连不上/超时：切换下一条地址
        }
        // 只要收到了 HTTP 响应（无论状态码）都视为该地址可达、应答权威，不再切换
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401) {
            if (patchToken() === requestToken) patchHandleUnauthorized();
            throw new Error('登录已失效，请重新登录');
        }
        if (response.status === 403) throw new Error('权限不足');
        if (!response.ok || payload.code !== 0) throw new Error(payload.message || payload.detail || '请求失败');
        return payload.data;
    }
    const timedOut = lastError && lastError.name === 'AbortError';
    const cause = lastError && lastError.message ? `（${lastError.message}）` : '';
    throw new Error(`无法连接补丁中心：${servers.length} 条服务地址${timedOut ? '均已请求超时' : '均无法连接'}${cause}，请稍后重试。`);
}

// 产品/版本字典：[{id,name,sort_order,versions:[{id,version}]}]
async function fetchProducts() {
    return await patchRequest('/api/products');
}

async function ensureProductOptions(force = false) {
    if (patchState.products && !force) return patchState.products;
    patchState.products = await fetchProducts();
    return patchState.products;
}

function productVersionOptions(product) {
    return (product?.versions || []).map(version => `<option value="${patchEscape(version.version)}">`).join('');
}

async function patchLogin() {
    if (!patchState.patchSearchServers.length) { patchShowError('补丁服务地址尚未加载，请稍候重试。', '配置缺失'); return; }
    const username = document.getElementById('patchLoginUsername').value.trim();
    const password = document.getElementById('patchLoginPassword').value;
    const message = document.getElementById('patchLoginMessage');
    try {
        const data = await patchRequest('/api/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username, password})});
        localStorage.setItem(PATCH_TOKEN_KEY, data.access_token);
        patchState.authInvalidated = false;
        patchSetAuthenticated(data.user);
        message.textContent = '';
        setPatchHelpPanel(true); // 登录后默认展开
        patchHelpSave(true);
        await Promise.all([loadPatches(), loadWorkflowTemplates(), loadDashboard()]);
    } catch (error) { message.textContent = ''; patchShowError(error.message, '登录失败'); }
}

async function patchRestoreAuth() {
    if (!patchToken()) { patchSetAuthenticated(null); return false; }
    try { patchSetAuthenticated(await patchRequest('/api/auth/me')); return true; }
    catch (error) {
        // 只有服务端明确返回 401（patchRequest 已置 authInvalidated 并清掉 token）才算登录失效；
        // 网络不通/超时等临时故障保留 token，停在 pending 提示上让用户重试，避免刷新时被误踢回登录页。
        if (patchState.authInvalidated) { patchHandleUnauthorized(); return false; }
        patchShowAuthRetry(error.message);
        return false;
    }
}

function patchShowAuthRetry(message) {
    const text = document.getElementById('patchAuthLoadingText');
    const retry = document.getElementById('patchAuthRetry');
    if (text) text.textContent = message || '无法连接补丁中心，请稍后重试。';
    if (retry) retry.hidden = false;
}

// 使用说明面板：登录时默认展开；刷新页面保留当前状态（同步应用，避免刷新时闪一下）
function setPatchHelpPanel(open) {
    document.documentElement.classList.toggle('help-panel-closed', !open);
    const panel = document.getElementById('patchHelpPanel');
    panel.classList.toggle('closed', !open);
    panel.setAttribute('aria-hidden', String(!open));
    document.getElementById('patchHelpToggle').setAttribute('aria-expanded', String(open));
    document.getElementById('patchHelpCollapse').setAttribute('aria-expanded', String(open));
    document.getElementById('patchHelpReopen').hidden = open;
}
function patchHelpSave(open) {
    try { localStorage.setItem('cc-web-help-panel', open ? 'open' : 'closed'); } catch {}
}
function patchHelpApplyStored() {
    let stored = '';
    try { stored = localStorage.getItem('cc-web-help-panel') || ''; } catch {}
    setPatchHelpPanel(stored !== 'closed');
}

function patchActivityLabel(level) {
    return ({high: '高活跃', medium: '中活跃', low: '低活跃', inactive: '未活跃'})[level] || '未活跃';
}

function renderDashboard(data) {
    const me = data?.me;
    document.getElementById('patchUserMetrics').innerHTML = me ? `<div class="patch-metric"><span>上传补丁</span><strong>${me.upload_count}</strong></div><div class="patch-metric"><span>贡献值</span><strong>${me.contribution_score}</strong></div><div class="patch-metric"><span>活跃度</span><strong class="patch-activity ${patchEscape(me.activity_level)}">${patchActivityLabel(me.activity_level)}</strong></div><p class="patch-muted">近 ${data.days} 天活跃 ${me.active_days_30d} 天，发起 ${me.workflow_run_count_30d} 次流程</p>` : '暂无统计数据';
    const ranking = data?.leaderboard || [];
    document.getElementById('patchLeaderboard').innerHTML = ranking.length ? ranking.map(item => `<div class="patch-rank-row"><span class="patch-rank">${item.rank}</span><span class="patch-rank-user"><span class="patch-rank-name">${patchEscape(item.display_name)}</span><em class="patch-activity ${patchEscape(item.activity_level)}">${patchActivityLabel(item.activity_level)}</em></span><strong>${item.contribution_score}</strong></div>`).join('') : '<span class="patch-muted">暂无贡献数据</span>';
    const activityRanking = data?.activity_leaderboard || [];
    document.getElementById('patchActivityLeaderboard').innerHTML = activityRanking.length ? activityRanking.map(item => `<div class="patch-rank-row"><span class="patch-rank">${item.rank}</span><span class="patch-rank-user"><span class="patch-rank-name">${patchEscape(item.display_name)}</span><em class="patch-activity ${patchEscape(item.activity_level)}">${patchActivityLabel(item.activity_level)}</em></span><strong>${item.active_days_30d} 天 / ${item.workflow_run_count_30d} 次</strong></div>`).join('') : '<span class="patch-muted">暂无活跃数据</span>';
}

async function loadDashboard() {
    if (!patchToken() || patchState.authInvalidated) return;
    try {
        patchState.dashboard = await patchRequest('/api/dashboard');
        renderDashboard(patchState.dashboard);
    } catch (error) {
        document.getElementById('patchUserMetrics').textContent = '个人统计加载失败';
        document.getElementById('patchLeaderboard').textContent = '贡献榜加载失败';
        document.getElementById('patchActivityLeaderboard').textContent = '活跃榜加载失败';
    }
}

async function loadPatches() {
    if (!patchToken() || patchState.authInvalidated) return;
    const generation = ++patchState.searchGeneration;
    const body = document.getElementById('patchTableBody');
    const searchButton = document.getElementById('patchSearchBtn');
    body.setAttribute('aria-busy', 'true');
    searchButton.disabled = true;
    body.innerHTML = '<tr><td colspan="7" class="patch-empty">正在加载...</td></tr>';
    try {
        const params = new URLSearchParams({ keyword: patchState.keyword, name: patchState.advanced.name, product_name: patchState.advanced.product, product_version: patchState.advanced.version, user_keyword: patchState.advanced.keyword, description: patchState.advanced.description, page: patchState.page, size: PATCH_PAGE_SIZE });
        const data = await patchRequest(`/api/patches?${params}`);
        if (generation !== patchState.searchGeneration) return;
        patchState.searchItems = data.items || [];
        document.getElementById('patchTotal').textContent = `共 ${data.total} 个`;
        document.getElementById('patchPageInfo').textContent = `第 ${data.page} 页`;
        document.getElementById('patchPrevBtn').disabled = data.page <= 1;
        document.getElementById('patchNextBtn').disabled = data.page * data.size >= data.total;
        body.innerHTML = data.items.length ? data.items.map(patchRow).join('') : '<tr><td colspan="7" class="patch-empty">暂无已分析补丁</td></tr>';
        document.getElementById('patchApiStatus').textContent = '已连接';
        document.getElementById('patchApiStatus').className = 'patch-api-status online';
    } catch (error) {
        if (generation !== patchState.searchGeneration) return;
        body.innerHTML = '<tr><td colspan="7" class="patch-empty">加载失败，请重试</td></tr>';
        if (!patchState.authInvalidated) patchShowError(error.message, '补丁列表加载失败');
        document.getElementById('patchApiStatus').textContent = '连接失败';
        document.getElementById('patchApiStatus').className = 'patch-api-status error';
    } finally {
        if (generation === patchState.searchGeneration) { body.setAttribute('aria-busy', 'false'); searchButton.disabled = false; }
    }
}

function patchRow(item) {
    let actions = `<button class="patch-link-btn" data-detail-id="${patchEscape(item.id)}">详情</button><button class="patch-link-btn" data-download-id="${patchEscape(item.id)}" data-download-name="${patchEscape(item.file_name || '')}">下载</button>`;
    // 编辑/删除仅管理员可见
    if (patchState.user && patchState.user.role === 'admin') {
        actions += `<button class="patch-link-btn" data-search-edit="${patchEscape(item.id)}">编辑</button><button class="patch-link-btn danger" data-search-delete="${patchEscape(item.id)}">删除</button>`;
    }
    return `<tr>
        <td class="patch-name-cell"><strong class="patch-truncated-name" title="${patchEscape(item.name)}">${patchEscape(item.name)}</strong><small class="patch-truncated-name" title="${patchEscape(item.file_name)}">${patchEscape(item.file_name)}</small></td>
        <td>${patchEscape(item.product_name || '-')}</td>
        <td>${patchEscape(item.product_version || '-')}</td>
        <td>${patchEscape(String(item.file_format || '').toUpperCase())}</td>
        <td>${patchFormatSize(item.file_size)}</td>
        <td>${patchFormatDateTime(item.analyzed_at)}</td>
        <td class="patch-actions-cell">${actions}</td>
    </tr>`;
}

async function populateAdvancedProductOptions() {
    const select = document.getElementById('patchAdvProduct');
    if (!select) return;
    let products;
    try { products = await ensureProductOptions(); } catch { products = []; }
    const current = select.value;
    select.innerHTML = '<option value="">全部产品</option>' + (products || []).map(product => `<option value="${patchEscape(product.name)}">${patchEscape(product.name)}</option>`).join('');
    if (current) select.value = current;
}

function openAdvancedSearch() {
    const panel = document.getElementById('patchAdvancedPanel');
    const toolbar = document.getElementById('patchSearchToolbar');
    const toggle = document.getElementById('patchAdvancedToggle');
    patchState.advancedOpen = true;
    // 进入高级搜索时清空普通搜索框，只使用高级搜索字段
    const keywordInput = document.getElementById('patchKeyword');
    if (keywordInput) keywordInput.value = '';
    patchState.keyword = '';
    if (panel) panel.hidden = false;
    if (toolbar) toolbar.hidden = true;
    toggle.classList.add('active');
    toggle.setAttribute('aria-expanded', 'true');
    populateAdvancedProductOptions();
}

function closeAdvancedSearch() {
    const panel = document.getElementById('patchAdvancedPanel');
    const toolbar = document.getElementById('patchSearchToolbar');
    const toggle = document.getElementById('patchAdvancedToggle');
    patchState.advancedOpen = false;
    if (panel) panel.hidden = true;
    if (toolbar) toolbar.hidden = false;
    toggle.classList.remove('active');
    toggle.setAttribute('aria-expanded', 'false');
    // 返回普通搜索：清除已应用的高级筛选，走普通搜索逻辑
    patchState.advanced = { name: '', product: '', version: '', keyword: '', description: '' };
    patchState.page = 1;
    loadPatches();
}

function applyAdvancedSearch() {
    patchState.advanced.name = document.getElementById('patchAdvName').value.trim();
    patchState.advanced.product = document.getElementById('patchAdvProduct').value.trim();
    patchState.advanced.version = document.getElementById('patchAdvVersion').value.trim();
    patchState.advanced.keyword = document.getElementById('patchAdvKeyword').value.trim();
    patchState.advanced.description = document.getElementById('patchAdvDescription').value.trim();
    patchState.page = 1;
    loadPatches();
}

function resetAdvancedSearch() {
    document.getElementById('patchAdvName').value = '';
    document.getElementById('patchAdvProduct').value = '';
    document.getElementById('patchAdvVersion').value = '';
    document.getElementById('patchAdvKeyword').value = '';
    document.getElementById('patchAdvDescription').value = '';
    patchState.advanced = { name: '', product: '', version: '', keyword: '', description: '' };
    patchState.page = 1;
    loadPatches();
}

// 我的补丁：加载当前登录用户上传的补丁列表
async function loadMyPatches() {
    if (!patchToken() || patchState.authInvalidated) return;
    const generation = ++patchState.mine.generation;
    const body = document.getElementById('patchMineBody');
    const refresh = document.getElementById('patchMineRefresh');
    if (body) body.setAttribute('aria-busy', 'true');
    if (refresh) refresh.disabled = true;
    if (body) body.innerHTML = '<tr><td colspan="7" class="patch-empty">正在加载...</td></tr>';
    try {
        const data = await patchRequest(`/api/patches/mine?page=${patchState.mine.page}&size=${patchState.mine.size}`);
        if (generation !== patchState.mine.generation) return;
        patchState.mine.total = data.total;
        patchState.mine.items = data.items || [];
        document.getElementById('patchMineTotal').textContent = `共 ${data.total} 个`;
        document.getElementById('patchMinePageInfo').textContent = `第 ${data.page} 页`;
        document.getElementById('patchMinePrev').disabled = data.page <= 1;
        document.getElementById('patchMineNext').disabled = data.page * data.size >= data.total;
        if (body) body.innerHTML = patchState.mine.items.length ? patchState.mine.items.map(patchMineRow).join('') : '<tr><td colspan="7" class="patch-empty">暂无补丁，请先上传</td></tr>';
    } catch (error) {
        if (generation !== patchState.mine.generation) return;
        if (body) body.innerHTML = '<tr><td colspan="7" class="patch-empty">加载失败，请重试</td></tr>';
        if (!patchState.authInvalidated) patchShowError(error.message, '我的补丁加载失败');
    } finally {
        if (generation === patchState.mine.generation && refresh) refresh.disabled = false;
    }
}

function patchMineRow(item) {
    let actions = `<button class="patch-link-btn" data-mine-edit="${patchEscape(item.id)}">编辑</button><button class="patch-link-btn danger" data-mine-delete="${patchEscape(item.id)}">删除</button>`;
    // 详情/下载接口要求 status=2，仅分析完成才显示
    if (Number(item.status) === 2) {
        actions = `<button class="patch-link-btn" data-detail-id="${patchEscape(item.id)}">详情</button><button class="patch-link-btn" data-download-id="${patchEscape(item.id)}" data-download-name="${patchEscape(item.file_name || '')}">下载</button>${actions}`;
    }
    return `<tr>
        <td class="patch-name-cell"><strong class="patch-truncated-name" title="${patchEscape(item.name)}">${patchEscape(item.name)}</strong><small class="patch-truncated-name" title="${patchEscape(item.file_name)}">${patchEscape(item.file_name)}</small></td>
        <td>${patchEscape(item.product_name || '-')}</td>
        <td>${patchEscape(item.product_version || '-')}</td>
        <td>${patchEscape(String(item.file_format || '').toUpperCase())}</td>
        <td>${patchFormatSize(item.file_size)}</td>
        <td><span class="patch-status analysis-${item.status}">${patchEscape(analysisStatusLabel(item.status))}</span></td>
        <td class="patch-actions-cell">${actions}</td>
    </tr>`;
}

async function openPatchEdit(id) {
    // 管理员可从检索页编辑任意补丁；普通用户仅"我的补丁"入口（本人补丁）
    const item = patchState.searchItems.find(value => String(value.id) === String(id)) || patchState.mine.items.find(value => String(value.id) === String(id));
    if (!item) return;
    const isAdmin = Boolean(patchState.user && patchState.user.role === 'admin');
    let products;
    try { products = await ensureProductOptions(); } catch (error) { patchShowError(error.message, '产品选项加载失败'); return; }
    const currentProduct = item.product_name || '';
    let productOptions = products.map(product => `<option value="${patchEscape(product.name)}">${patchEscape(product.name)}</option>`).join('');
    // 历史补丁可能存了字典之外的产品名，追加为选项避免编辑时丢失
    if (currentProduct && !products.some(product => product.name === currentProduct)) {
        productOptions += `<option value="${patchEscape(currentProduct)}">${patchEscape(currentProduct)}</option>`;
    }
    const productSelect = document.getElementById('patchEditProduct');
    productSelect.innerHTML = `<option value="">请选择产品</option>${productOptions}`;
    productSelect.value = currentProduct;
    document.getElementById('patchEditVersion').value = item.product_version || '';
    document.getElementById('patchEditVersionList').innerHTML = productVersionOptions(products.find(product => product.name === currentProduct));
    document.getElementById('patchEditId').value = item.id;
    document.getElementById('patchEditName').value = item.name || '';
    document.getElementById('patchEditDescription').value = item.description || '';
    document.getElementById('patchEditKeyword').value = item.user_keyword || '';
    // 状态仅管理员可见可改；保存时由后端判定权限
    const statusField = document.getElementById('patchEditStatusField');
    const resetNote = document.getElementById('patchEditResetNote');
    if (statusField) statusField.hidden = !isAdmin;
    if (resetNote) resetNote.hidden = isAdmin;
    if (isAdmin && document.getElementById('patchEditStatus')) {
        document.getElementById('patchEditStatus').value = String(Number(item.status) || 0);
    }
    ['patchEditName', 'patchEditProduct', 'patchEditVersion'].forEach(id => document.getElementById(id).removeAttribute('aria-invalid'));
    document.getElementById('patchEditModal').hidden = false;
}

async function savePatchEdit() {
    const id = document.getElementById('patchEditId').value;
    const fields = [['patchEditName', '名称'], ['patchEditProduct', '产品名称'], ['patchEditVersion', '版本号']];
    let firstInvalid = null;
    fields.forEach(([fieldId]) => {
        const input = document.getElementById(fieldId);
        const valid = input.value.trim().length > 0;
        input.setAttribute('aria-invalid', String(!valid));
        if (!valid && !firstInvalid) firstInvalid = input;
    });
    if (firstInvalid) { patchShowError('请填写名称、产品名称和版本号。', '修改补丁失败'); firstInvalid.focus(); return; }
    const button = document.getElementById('patchEditSave');
    button.disabled = true;
    const isAdmin = Boolean(patchState.user && patchState.user.role === 'admin');
    try {
        const body = {
            name: document.getElementById('patchEditName').value.trim(),
            product_name: document.getElementById('patchEditProduct').value.trim(),
            product_version: document.getElementById('patchEditVersion').value.trim(),
            description: document.getElementById('patchEditDescription').value.trim() || null,
            user_keyword: document.getElementById('patchEditKeyword').value.trim() || null,
        };
        if (isAdmin) body.status = Number(document.getElementById('patchEditStatus').value);
        await patchRequest(`/api/patches/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        document.getElementById('patchEditModal').hidden = true;
        // 管理员可能修改了状态，检索页与我的补丁都可能受影响，均刷新
        loadPatches();
        loadMyPatches();
    } catch (error) {
        patchShowError(error.message, '修改补丁失败');
    } finally {
        button.disabled = false;
    }
}

function deleteMinePatch(id) {
    patchConfirm('删除后无法恢复，磁盘上的补丁文件将一并删除。', '删除补丁').then(confirmed => {
        if (!confirmed) return;
        return patchRequest(`/api/patches/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(loadMyPatches);
    }).catch(error => patchShowError(error.message, '删除补丁失败'));
}

// 检索页删除：仅管理员可操作，删除后同时刷新检索页与我的补丁
function deleteSearchPatch(id) {
    patchConfirm('删除后无法恢复，磁盘上的补丁文件将一并删除。', '删除补丁').then(confirmed => {
        if (!confirmed) return;
        return patchRequest(`/api/patches/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => { loadPatches(); loadMyPatches(); });
    }).catch(error => patchShowError(error.message, '删除补丁失败'));
}

// 列表列宽可拖拽调整，宽度持久化到 localStorage；搜索表与我的补丁表各自独立存储
// actionMin：最后一列（操作列）的最小宽度。表格是 table-layout:fixed，单元格又带 overflow:hidden，
// 列宽一旦小于按钮所需的宽度，后面的「下载/编辑/删除」会被裁掉（看不见也点不到），
// 因此操作列不允许被压到 actionMin 以下（包含历史存下来的旧宽度）。
function initPatchColumnResize(selector, storageKey, defaults, actionMin = 48) {
    const table = document.querySelector(selector);
    if (!table) return;
    const headers = Array.from(table.querySelectorAll('thead th'));
    if (headers.length < 2) return;
    const minWidth = (i) => (i === headers.length - 1 ? actionMin : 48);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}
    headers.forEach((th, i) => {
        const width = Math.max(Number(saved[`col${i}`]) || defaults[i] || 100, minWidth(i));
        th.style.width = `${width}px`;
        const handle = document.createElement('div');
        handle.className = 'patch-resizer';
        handle.title = '拖拽调整列宽';
        th.appendChild(handle);
        let startX = 0;
        let startW = 0;
        const onMove = (e) => {
            th.style.width = `${Math.max(minWidth(i), Math.round(startW + e.clientX - startX))}px`;
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.classList.remove('patch-col-resizing');
            const widths = {};
            headers.forEach((h, j) => { widths[`col${j}`] = h.getBoundingClientRect().width; });
            try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch {}
        };
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startW = th.getBoundingClientRect().width;
            document.body.classList.add('patch-col-resizing');
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

async function showUploadModal(files) {
    patchState.files = Array.from(files);
    let products;
    try { products = await ensureProductOptions(); } catch (error) { patchShowError(error.message, '产品选项加载失败'); return; }
    const productOptions = products.map(product => `<option value="${patchEscape(product.name)}">${patchEscape(product.name)}</option>`).join('');
    const items = document.getElementById('patchUploadItems');
    items.innerHTML = patchState.files.map((file, index) => `<div class="patch-upload-item" data-file-index="${index}">
        <div class="patch-file-meta"><strong>${patchEscape(file.name)}</strong><span>${patchFormatSize(file.size)}</span></div>
        <label>名称<input class="patch-file-name" value="${patchEscape(file.name.replace(/\.(zip|rar)$/i, ''))}"></label>
        <label>产品名称<span class="patch-required">*</span><select class="patch-file-product"><option value="">请选择产品</option>${productOptions}</select></label>
        <label>版本号<span class="patch-required">*</span><input class="patch-file-version" list="patchProductVersions-${index}" placeholder="选择或输入版本号"><datalist id="patchProductVersions-${index}"></datalist></label>
        <label class="patch-file-description-label">描述<textarea class="patch-file-description" rows="3" placeholder="可选"></textarea></label>
        <label>关键词<input class="patch-file-keywords" placeholder="可选，逗号分隔"></label>
        <div class="patch-progress"><span></span><em>等待上传</em></div>
    </div>`).join('');
    document.getElementById('patchUploadModal').hidden = false;
}

function closeUploadModal() {
    document.getElementById('patchUploadModal').hidden = true;
    patchState.files = [];
}

function uploadOne(index, item, formData) {
    return new Promise((resolve) => {
        const servers = patchState.patchSearchServers;
        const progress = item.querySelector('.patch-progress span');
        const label = item.querySelector('.patch-progress em');
        if (!servers.length) {
            progress.style.width = '0%';
            label.textContent = '网络错误';
            item.classList.add('upload-failed');
            resolve(false);
            return;
        }
        const token = patchToken();
        const start = patchState.patchServerCursor % servers.length;
        patchState.patchServerCursor = start + 1;
        const startOne = (at) => {
            const base = servers[(start + at) % servers.length];
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${base.replace(/\/+$/, '')}/api/patches/upload`);
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.timeout = 1200000; // 上传单个文件的最长等待（20 分钟），超时视为该地址不可用并切换
            progress.style.width = '0%';
            if (at > 0) label.textContent = '检测到地址异常，正在切换重试…';
            xhr.upload.onprogress = (event) => {
                if (!event.lengthComputable) return;
                const percent = Math.round(event.loaded / event.total * 100);
                progress.style.width = `${percent}%`;
                label.textContent = `${percent}%`;
            };
            xhr.onload = () => {
                let payload;
                try { payload = JSON.parse(xhr.responseText); } catch { payload = {}; }
                const uploadData = payload.data || {};
                const success = xhr.status >= 200 && xhr.status < 300 && payload.code === 0 && uploadData.success && uploadData.success.length > 0 && (!uploadData.failed || uploadData.failed.length === 0);
                const errorMessage = uploadData.failed && uploadData.failed[0] ? uploadData.failed[0].error : (payload.message || '上传失败');
                label.textContent = success ? '上传完成，等待分析' : errorMessage;
                item.classList.toggle('upload-failed', !success);
                resolve(success);
            };
            // 收到任何 HTTP 响应都视为该地址可达、应答权威，不再切换；仅连不上/超时才换下一条
            const retryNext = () => {
                if (at + 1 >= servers.length) {
                    label.textContent = '上传失败：所有服务地址均无法连接';
                    item.classList.add('upload-failed');
                    resolve(false);
                    return;
                }
                startOne(at + 1);
            };
            xhr.onerror = retryNext;
            xhr.ontimeout = retryNext;
            xhr.send(formData);
        };
        startOne(0);
    });
}

async function startUpload() {
    const items = Array.from(document.querySelectorAll('.patch-upload-item'));
    // 必填校验：产品名称、版本号
    let firstInvalid = null;
    items.forEach(item => {
        const product = item.querySelector('.patch-file-product');
        const version = item.querySelector('.patch-file-version');
        const productOk = product.value.trim() !== '';
        const versionOk = version.value.trim() !== '';
        product.setAttribute('aria-invalid', String(!productOk));
        version.setAttribute('aria-invalid', String(!versionOk));
        const label = item.querySelector('.patch-progress em');
        if (!productOk || !versionOk) {
            item.classList.add('upload-failed');
            label.textContent = !productOk && !versionOk ? '产品名称和版本号必填' : !productOk ? '产品名称必填' : '版本号必填';
            if (!firstInvalid) firstInvalid = !productOk ? product : version;
        } else {
            item.classList.remove('upload-failed');
            label.textContent = '等待上传';
        }
    });
    if (firstInvalid) { firstInvalid.focus(); patchShowError('请先填写必填的产品名称和版本号。', '上传未完成'); return; }
    let failedCount = 0;
    document.getElementById('patchUploadStart').disabled = true;
    for (let index = 0; index < patchState.files.length; index += 1) {
        const item = items[index];
        const formData = new FormData();
        formData.append('files', patchState.files[index]);
        formData.append('file_names', item.querySelector('.patch-file-name').value.trim());
        formData.append('product_names', item.querySelector('.patch-file-product').value.trim());
        formData.append('product_versions', item.querySelector('.patch-file-version').value.trim());
        formData.append('descriptions', item.querySelector('.patch-file-description').value.trim());
        formData.append('user_keywords', item.querySelector('.patch-file-keywords').value.trim());
        if (!await uploadOne(index, item, formData)) failedCount += 1;
    }
    document.getElementById('patchUploadStart').disabled = false;
    document.getElementById('patchUploadCancel').textContent = '完成';
    try { patchState.products = await fetchProducts(); } catch {}
    if (failedCount) patchShowError(`${failedCount} 个补丁包上传失败，请检查文件状态后重试。`, '上传未完成');
}

async function showPatchDetail(id) {
    const content = document.getElementById('patchDetailContent');
    content.textContent = '正在加载...';
    document.getElementById('patchDetailModal').hidden = false;
    try {
        const patch = await patchRequest(`/api/patches/${encodeURIComponent(id)}`);
        const tags = (value) => (value || '').split(',').filter(Boolean).map(v => `<span class="patch-tag">${patchEscape(v)}</span>`).join('') || '<span class="patch-muted">-</span>';
        content.innerHTML = `<dl class="patch-detail-grid">
            <dt>名称</dt><dd>${patchEscape(patch.name)}</dd><dt>产品名称</dt><dd>${patchEscape(patch.product_name || '-')}</dd>
            <dt>版本号</dt><dd>${patchEscape(patch.product_version || '-')}</dd><dt>描述</dt><dd>${patchEscape(patch.description || '-')}</dd>
            <dt>格式</dt><dd>${patchEscape(patch.file_format)}</dd><dt>大小</dt><dd>${patchFormatSize(patch.file_size)}</dd>
            <dt>上传人</dt><dd>${patchEscape(patch.uploaded_by || '-')}</dd><dt>上传时间</dt><dd>${patchFormatDateTime(patch.uploaded_at)}</dd>
            <dt>用户关键词</dt><dd>${tags(patch.user_keyword)}</dd><dt>相关类</dt><dd>${tags(patch.class_name)}</dd>
            <dt>分析关键词</dt><dd>${tags(patch.keyword)}</dd>
        </dl><div class="patch-detail-analysis"><h4>分析结果</h4></div>
        <div class="patch-detail-output"><button id="patchAnalysisCopy" type="button" class="patch-secondary-btn patch-copy-btn">复制</button><pre id="patchAnalysisContent" class="patch-code-block">${patchEscape(patchDecodeResultText(patch.analysis_result || {}))}</pre></div>
        <div class="patch-detail-actions"><button class="patch-primary-btn" data-download-id="${patchEscape(patch.id)}" data-download-name="${patchEscape(patch.file_name || '')}">下载补丁包</button></div>`;
        const analysisCopy = document.getElementById('patchAnalysisCopy');
        if (analysisCopy) analysisCopy.onclick = () => copyWorkflowOutput(analysisCopy, document.getElementById('patchAnalysisContent'));
    } catch (error) { document.getElementById('patchDetailModal').hidden = true; patchShowError(error.message, '补丁详情加载失败'); }
}

async function loadWorkflowTemplates() {
    try {
        const templates = await patchRequest('/api/workflows/templates');
        patchState.workflow.templates = templates;
        const select = document.getElementById('workflowTemplateSelect');
        select.innerHTML = '<option value="">请选择流程模板</option>' + templates.filter(item => item.can_use).map(item => `<option value="${patchEscape(item.id)}">${patchEscape(item.name)} (${patchEscape(item.code)})</option>`).join('');
        updateWorkflowTemplateDesc();
    } catch (error) {
        document.getElementById('workflowTemplateSelect').innerHTML = '<option value="">流程模板加载失败</option>';
        patchShowError(error.message, '流程模板加载失败');
    }
}

function updateWorkflowTemplateDesc() {
    const select = document.getElementById('workflowTemplateSelect');
    const desc = document.getElementById('workflowTemplateDesc');
    if (!select || !desc) return;
    const id = Number(select.value);
    const template = (patchState.workflow.templates || []).find(item => Number(item.id) === id);
    const text = (template && (template.description || '')) ? template.description : '';
    desc.textContent = text;
    desc.hidden = !text;
}

function patchUnescapeString(value) {
    // 对 JSON 解析后的字符串值再做转义还原。Claude 常在 JSON 字符串值里二次转义
    // （如 \\uXXXX、\\n、\\"），解析一次后仍是 \uXXXX、\n、\" 的字面量，这里循环
    // 解码直到不再变化，覆盖多层转义；未知转义（如 \p）原样保留，避免破坏路径。
    const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', "'": "'", '/': '/', '\\': '\\' };
    let current = value;
    for (let round = 0; round < 5; round++) {
        let changed = false;
        const decoded = current.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (raw, code) => {
            if (code[0] === 'u' && code.length === 5) { changed = true; return String.fromCharCode(parseInt(code.slice(1), 16)); }
            if (Object.prototype.hasOwnProperty.call(map, code)) { changed = true; return map[code]; }
            return raw;
        });
        current = decoded;
        if (!changed) break;
    }
    return current;
}

function patchJsonReadable(value, depth) {
    // 把解析后的 JSON 渲染成可读文本：字符串值还原成真实内容（真实引号、单反斜杠
    // 路径、真实换行），不再用 JSON 转义，避免展示时满是 \"、\\、\n 之类字符。
    const pad = '  '.repeat(depth);
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return patchUnescapeString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return '[\n' + value.map((item, i) => `${pad}  ${i}: ${patchJsonReadable(item, depth + 1)}`).join('\n') + '\n' + pad + ']';
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        return '{\n' + keys.map(key => `${pad}  ${key}: ${patchJsonReadable(value[key], depth + 1)}`).join('\n') + '\n' + pad + '}';
    }
    return String(value);
}

function patchDecodeResultText(value) {
    // 步骤结果是 markdown 文本，其中嵌入了 ```json 代码块；Claude 输出 JSON 时把
    // 字符串值里的引号/反斜杠/换行转义（\"、\\、\n，甚至二次转义 \uXXXX），直接
    // 展示看起来满是转义字符。这里把能解析的 JSON（整段或代码块内）解析后按可读
    // 格式渲染；解析失败的部分保持原样，不影响 markdown 其余内容。
    if (value == null) return '';
    let text = value;
    if (typeof text !== 'string') { try { text = JSON.stringify(text, null, 2); } catch { text = String(text); } }
    const trimmed = text.trim();
    try { return patchJsonReadable(JSON.parse(trimmed), 0); } catch {}
    return text.replace(/```json\s*([\s\S]*?)```/gi, (match, inner) => {
        try { return '```json\n' + patchJsonReadable(JSON.parse(inner.trim()), 0) + '\n```'; }
        catch { return match; }
    });
}

function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy') ? resolve() : reject(new Error('复制失败')); }
        catch (err) { reject(err); }
        finally { document.body.removeChild(ta); }
    });
}

function copyWorkflowOutput(btn, source) {
    const text = typeof source === 'string' ? source : (source && source.textContent) || '';
    if (!text) return;
    const original = btn.textContent;
    copyTextToClipboard(text).then(() => { btn.textContent = '已复制'; btn.classList.add('copied'); }).catch(() => { btn.textContent = '复制失败'; });
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1500);
}

function closeWorkflowStream() { if (patchState.workflow.source) { patchState.workflow.source.abort(); patchState.workflow.source = null; } }

function resetWorkflowRunState() {
    closeWorkflowStream();
    patchState.workflow.runId = '';
    patchState.workflow.steps = [];
    patchState.workflow.currentStep = 0;
    patchState.workflow.status = '';
    patchState.workflow.token = '';
    patchState.workflow.lastEventId = 0;
    patchState.workflow.localExecutions.clear();
    const templateSelect = document.getElementById('workflowTemplateSelect');
    if (templateSelect) templateSelect.removeAttribute('aria-invalid');
    const businessInput = document.getElementById('workflowBusinessInput');
    if (businessInput) businessInput.removeAttribute('aria-invalid');
}

async function restoreWorkflowRun() {
    // 流程执行视图已迁移到独立的「流程运行详情」页面，运行记录列表页无需自动连接或展示。
    resetWorkflowRunState();
}

async function createWorkflowRun(templateId, businessInput, directoryBindings) {
    const data = await patchRequest('/api/workflows/runs', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({template_id: templateId, business_input: businessInput, directory_bindings: directoryBindings || []}) });
    const runId = data.run_id || data.id;
    if (!runId) throw new Error('流程创建成功但未返回运行 ID');
    patchState.workflow.lastEventId = 0;
    // 创建成功后直接跳转到独立的「流程运行详情」页面查看执行
    location.href = `/workflow_run.html?run_id=${encodeURIComponent(runId)}`;
}

// 记忆用户为某模板某步骤选择的本地工作目录：id:12 或 path:D:\proj
function workflowDirStorageKey(templateId, stepOrder) { return `cc-web-wf-dir:${templateId}:${stepOrder}`; }

// 渲染「选择本地工作目录」对话框：每个本地步骤一行。
// 当前用户有可用目录时展示「已有目录」下拉 + 手动填写切换；没有任何可用目录时只展示手动路径输入。
function renderWorkflowDirRows(container, templateId, requirements) {
    const options = requirements.options || [];
    const hasOptions = options.length > 0;
    container.innerHTML = (requirements.steps || []).map(step => {
        const saved = localStorage.getItem(workflowDirStorageKey(templateId, step.step_order)) || '';
        const savedId = saved.startsWith('id:') ? saved.slice(3) : '';
        const savedPath = saved.startsWith('path:') ? saved.slice(5) : '';
        const legend = `<legend>步骤 ${step.step_order} · ${patchEscape(step.flow_name)}</legend>`;
        if (!hasOptions) {
            return `<fieldset class="template-step-card" data-dir-step="${step.step_order}">${legend}<label>手动填写本机路径<input data-dir-path value="${patchEscape(savedPath)}" placeholder="例如：D:\\project\\my-app"></label></fieldset>`;
        }
        const manual = Boolean(savedPath);
        const defaultId = savedId || (step.default_directory_id != null ? String(step.default_directory_id) : '');
        const dirOptions = options.map(item => `<option value="${patchEscape(item.id)}" ${String(item.id) === defaultId ? 'selected' : ''}>${patchEscape(item.name)} (${patchEscape(item.code)})</option>`).join('');
        return `<fieldset class="template-step-card" data-dir-step="${step.step_order}">${legend}<label>已有目录<select data-dir-existing ${manual ? 'disabled' : ''}>${dirOptions}</select></label><label>手动填写本机路径<input data-dir-path value="${patchEscape(savedPath)}" ${manual ? '' : 'disabled'} placeholder="例如：D:\\project\\my-app"></label><label class="template-context-option"><input type="checkbox" data-dir-manual ${manual ? 'checked' : ''}> 改用手动填写的路径</label></fieldset>`;
    }).join('');
}

let workflowDirPending = null;

function openWorkflowDirDialog(templateId, businessInput, requirements) {
    workflowDirPending = { templateId, businessInput, requirements };
    renderWorkflowDirRows(document.getElementById('patchWorkflowDirBody'), templateId, requirements);
    document.getElementById('patchWorkflowDirModal').hidden = false;
}

function closeWorkflowDirDialog() {
    workflowDirPending = null;
    document.getElementById('patchWorkflowDirModal').hidden = true;
}

async function confirmWorkflowDirDialog() {
    if (!workflowDirPending) return;
    const { templateId, businessInput } = workflowDirPending;
    const rows = Array.from(document.querySelectorAll('#patchWorkflowDirBody [data-dir-step]'));
    const bindings = [];
    for (const row of rows) {
        const order = Number(row.dataset.dirStep);
        const key = workflowDirStorageKey(templateId, order);
        const manualToggle = row.querySelector('[data-dir-manual]');
        const existingSelect = row.querySelector('[data-dir-existing]');
        // 没有可用目录时只渲染手动输入（无下拉、无切换控件），此时一律按手动路径处理。
        const manual = manualToggle ? manualToggle.checked : !existingSelect;
        if (manual) {
            const path = row.querySelector('[data-dir-path]').value.trim();
            if (!path) { patchShowError(`请填写步骤 ${order} 的本机工作目录路径`, '工作目录未填写'); return; }
            bindings.push({ step_order: order, path });
            localStorage.setItem(key, `path:${path}`);
        } else {
            const directoryId = Number(existingSelect.value);
            if (!directoryId) { patchShowError(`请为步骤 ${order} 选择工作目录，或改用手动填写路径`, '工作目录未选择'); return; }
            bindings.push({ step_order: order, directory_id: directoryId });
            localStorage.setItem(key, `id:${directoryId}`);
        }
    }
    const confirmButton = document.getElementById('patchWorkflowDirConfirm');
    confirmButton.disabled = true; confirmButton.textContent = '正在创建流程…';
    try {
        await createWorkflowRun(templateId, businessInput, bindings);
        closeWorkflowDirDialog();
    } catch (error) {
        patchShowError(error.message || '流程创建失败', '流程创建失败');
    } finally {
        confirmButton.disabled = false; confirmButton.textContent = '开始流程';
    }
}

async function startWorkflow() {
    const templateSelect = document.getElementById('workflowTemplateSelect');
    const input = document.getElementById('workflowBusinessInput');
    const startButton = document.getElementById('workflowStart');
    const templateId = Number(templateSelect.value);
    const businessInput = input.value.trim();
    templateSelect.removeAttribute('aria-invalid'); input.removeAttribute('aria-invalid');
    if (!templateId) { templateSelect.setAttribute('aria-invalid', 'true'); templateSelect.focus(); patchShowError('请选择流程模板', '流程创建失败'); return; }
    if (!businessInput) { input.setAttribute('aria-invalid', 'true'); input.focus(); patchShowError('请输入业务需求或问题', '流程创建失败'); return; }
    startButton.disabled = true; startButton.textContent = '正在创建流程…';
    try {
        // 先查询模板中的本地 ClaudeCode 步骤：存在则先让使用者逐步骤指定工作目录。
        const requirements = await patchRequest(`/api/workflows/templates/${templateId}/directory-requirements`);
        if ((requirements.steps || []).length) { openWorkflowDirDialog(templateId, businessInput, requirements); return; }
        await createWorkflowRun(templateId, businessInput, []);
    } catch (error) {
        patchShowError(error.message || '流程创建失败', '流程创建失败');
    } finally {
        startButton.disabled = false; startButton.textContent = '开始流程';
    }
}

async function downloadPatch(id, fallbackName) {
    const servers = patchState.patchSearchServers;
    const modal = document.getElementById('patchDownloadModal');
    const closeBtn = document.getElementById('patchDownloadClose');
    const cancelBtn = document.getElementById('patchDownloadCancel');
    const urlEl = document.getElementById('patchDownloadUrl');
    const fileEl = document.getElementById('patchDownloadFile');
    const bar = document.getElementById('patchDownloadBar');
    const percentEl = document.getElementById('patchDownloadPercent');
    const sizeEl = document.getElementById('patchDownloadSize');

    // 先弹出下载进度，再探测可用地址并开始下载
    urlEl.textContent = '正在检测可用地址…';
    fileEl.textContent = fallbackName || id;
    bar.style.width = '0%'; percentEl.textContent = '0%'; sizeEl.textContent = '正在连接...';
    cancelBtn.textContent = '取消';
    modal.hidden = false;

    const controller = new AbortController();
    const close = () => { controller.abort(); modal.hidden = true; };
    cancelBtn.onclick = close;
    closeBtn.onclick = close;
    modal.onclick = event => { if (event.target === modal) close(); };

    try {
        if (!servers.length) throw new Error('补丁服务地址尚未加载，请稍候重试。');
        const start = patchState.patchServerCursor % servers.length;
        patchState.patchServerCursor = start + 1;
        let response = null;
        for (let attempt = 0; attempt < servers.length; attempt += 1) {
            const base = servers[(start + attempt) % servers.length];
            const url = `${base.replace(/\/+$/, '')}/api/patches/${encodeURIComponent(id)}/download`;
            urlEl.textContent = url;
            try {
                response = await patchFetchTimeout(url, {headers: {Authorization: `Bearer ${patchToken()}`}}, PATCH_REQUEST_TIMEOUT);
            } catch (error) {
                if (controller.signal.aborted) throw error; // 用户取消，不切换
                continue; // 连不上/超时：尝试下一条
            }
            break;
        }
        if (!response) throw new Error('无法连接补丁中心：所有服务地址均无法连接，请稍后重试。');
        if (response.status === 401) { patchHandleUnauthorized(); throw new Error('请先登录'); }
        if (!response.ok) throw new Error('下载失败');
        const total = Number(response.headers.get('Content-Length') || 0);
        sizeEl.textContent = total > 0 ? `${patchFormatSize(total)} · 下载中` : '下载中';
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            if (value && value.length) { chunks.push(value); received += value.length; }
            if (total > 0) {
                const p = Math.min(100, Math.round(received / total * 100));
                bar.style.width = `${p}%`; percentEl.textContent = `${p}%`;
                sizeEl.textContent = `${patchFormatSize(received)} / ${patchFormatSize(total)}`;
            } else {
                percentEl.textContent = patchFormatSize(received);
            }
        }
        // 优先用响应 Content-Disposition 里的文件名（后端已确保带扩展名）；拿不到时退回列表里的原始文件名
        let filename = '';
        const disposition = response.headers.get('Content-Disposition') || '';
        const starMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (starMatch) filename = decodeURIComponent(starMatch[1]);
        else {
            const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
            if (plainMatch) filename = plainMatch[1];
        }
        if (!filename) filename = fallbackName || '';
        const blob = new Blob(chunks, {type: response.headers.get('Content-Type') || 'application/octet-stream'});
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); if (filename) link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        fileEl.textContent = filename;
        bar.style.width = '100%'; percentEl.textContent = '100%';
        sizeEl.textContent = `${patchFormatSize(received)} · 下载完成`;
        cancelBtn.textContent = '关闭';
        cancelBtn.onclick = () => { modal.hidden = true; };
        closeBtn.onclick = () => { modal.hidden = true; };
        modal.onclick = event => { if (event.target === modal) modal.hidden = true; };
    } catch (err) {
        if (err.name === 'AbortError') return;
        modal.hidden = true;
        patchShowError(err.message || '下载失败', '下载失败');
    }
}

function patchSetupTabs() {
    const tabs = Array.from(document.querySelectorAll('.patch-tab'));
    tabs.forEach(button => {
        const tab = button.dataset.tab;
        const panel = document.getElementById(`patchTab${tab[0].toUpperCase()}${tab.slice(1)}`);
        button.id = `patchTabButton${tab[0].toUpperCase()}${tab.slice(1)}`;
        button.setAttribute('role', 'tab');
        if (panel) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); }
    });
}

function patchSwitchTab(tab) {
    document.querySelectorAll('.patch-tab').forEach(button => {
        const active = button.dataset.tab === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('.patch-tab-panel').forEach(panel => {
        const active = panel.id === `patchTab${tab[0].toUpperCase()}${tab.slice(1)}`;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
    });
    if (tab === 'search' && patchToken() && !patchState.authInvalidated) loadPatches();
    if (tab === 'smart' && patchToken() && !patchState.authInvalidated) { loadWorkflowTemplates(); restoreWorkflowRun(); loadWorkflowHistory(); }
    if ((tab === 'flow' || tab === 'prompt' || tab === 'template') && patchToken() && !patchState.authInvalidated) loadAdminSettings(tab);
    if (tab === 'analysis' && patchToken() && !patchState.authInvalidated) loadAnalysisPatches();
    if (tab === 'product' && patchToken() && !patchState.authInvalidated) loadProducts();
    if (tab === 'mine' && patchToken() && !patchState.authInvalidated) loadMyPatches();
    if (tab === 'directory' && patchToken() && !patchState.authInvalidated) loadDirectories();
    if (tab === 'menus' && patchToken() && !patchState.authInvalidated && patchState.user?.role === 'admin') { loadMenuRoleConfig(); loadMenuUsers(); }
    patchSetSidenavActive(tab);
}

async function loadDirectories() {
    try {
        patchState.admin.directories = await patchRequest('/api/workflows/directories');
        document.getElementById('patchDirectoryBody').innerHTML = patchState.admin.directories.map(item => `<tr><td>${patchEscape(item.code)}</td><td>${patchEscape(item.name)}</td><td>${patchEscape(item.path)}</td><td>${item.is_builtin ? '内置' : '个人'}</td><td>${item.status ? '启用' : '停用'}</td><td>${item.is_builtin && patchState.user.role !== 'admin' ? '只读' : `<button class="patch-link-btn" data-directory-edit="${patchEscape(item.id)}">编辑</button><button class="patch-link-btn" data-directory-delete="${patchEscape(item.id)}">停用</button><button class="patch-link-btn danger" data-directory-remove="${patchEscape(item.id)}">删除</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="patch-empty">暂无工作目录</td></tr>';
    } catch (error) { document.getElementById('patchDirectoryMessage').textContent = ''; patchShowError(error.message, '工作目录加载失败'); }
}

function openDirectoryForm(item = {}) {
    patchState.admin.directoryId = item.id || null;
    const form = document.getElementById('patchDirectoryForm');
    form.code.value = item.code || ''; form.name.value = item.name || ''; form.path.value = item.path || ''; form.is_builtin.checked = Boolean(item.is_builtin); form.is_builtin.disabled = patchState.user.role !== 'admin';
    document.getElementById('patchDirectoryModal').hidden = false;
}

async function saveDirectory(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target).entries());
    const id = patchState.admin.directoryId;
    const path = id ? `/api/workflows/directories/${id}` : '/api/workflows/directories';
    const body = {code: values.code, name: values.name, path: values.path, is_builtin: event.target.is_builtin.checked};
    // 个人目录指向运行 cc-web 的客户端机器，服务端不校验存在性；这里先拦住相对路径，避免拖到执行阶段才报错。
    if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(String(values.path || '').trim())) {
        patchShowError('工作目录路径必须是绝对路径，例如 D:\\project\\my-app', '工作目录保存失败');
        return;
    }
    try { await patchRequest(path, {method: id ? 'PUT' : 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}); document.getElementById('patchDirectoryModal').hidden = true; await loadDirectories(); }
    catch (error) { document.getElementById('patchDirectoryMessage').textContent = ''; patchShowError(error.message, '工作目录保存失败'); }
}

// 产品/版本字典管理（管理员）
async function loadProducts() {
    if (!patchState.user || patchState.user.role !== 'admin') return;
    const body = document.getElementById('patchProductBody');
    body.innerHTML = '<tr><td colspan="4" class="patch-empty">正在加载...</td></tr>';
    try {
        patchState.admin.products = await fetchProducts();
        body.innerHTML = patchState.admin.products.length ? patchState.admin.products.map(productRow).join('') : '<tr><td colspan="4" class="patch-empty">暂无产品，请先新增</td></tr>';
    } catch (error) {
        body.innerHTML = '<tr><td colspan="4" class="patch-empty">加载失败，请重试</td></tr>';
        document.getElementById('patchProductMessage').textContent = '';
        patchShowError(error.message, '产品列表加载失败');
    }
}

function productRow(item) {
    return `<tr>
        <td><strong class="patch-truncated-name" title="${patchEscape(item.name)}">${patchEscape(item.name)}</strong></td>
        <td>${item.sort_order}</td>
        <td>${item.versions.length}</td>
        <td class="patch-actions-cell"><button class="patch-link-btn" data-product-versions="${patchEscape(item.id)}">版本</button><button class="patch-link-btn" data-product-edit="${patchEscape(item.id)}">编辑</button><button class="patch-link-btn danger" data-product-delete="${patchEscape(item.id)}">删除</button></td>
    </tr>`;
}

function openProductForm(item = {}) {
    patchState.admin.productId = item.id || null;
    const form = document.getElementById('patchProductForm');
    form.name.value = item.name || '';
    form.sort_order.value = item.sort_order ?? 0;
    document.getElementById('patchProductModal').hidden = false;
    form.name.focus();
}

async function saveProduct(event) {
    event.preventDefault();
    const form = event.target;
    const name = form.name.value.trim();
    if (!name) { patchShowError('请填写产品名称。', '产品保存失败'); form.name.focus(); return; }
    const id = patchState.admin.productId;
    const path = id ? `/api/products/${id}` : '/api/products';
    try {
        await patchRequest(path, {method: id ? 'PUT' : 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, sort_order: Number(form.sort_order.value) || 0})});
        document.getElementById('patchProductModal').hidden = true;
        patchState.products = null;
        await loadProducts();
    } catch (error) { document.getElementById('patchProductMessage').textContent = ''; patchShowError(error.message, '产品保存失败'); }
}

function deleteProduct(id) {
    const product = patchState.admin.products.find(value => String(value.id) === String(id));
    patchConfirm(`删除产品“${product ? product.name : ''}”将同时移除其所有版本；历史补丁数据不受影响。`, '删除产品').then(confirmed => {
        if (!confirmed) return;
        return patchRequest(`/api/products/${encodeURIComponent(id)}`, {method: 'DELETE'}).then(() => { patchState.products = null; loadProducts(); });
    }).catch(error => patchShowError(error.message, '删除产品失败'));
}

function openProductVersions(id) {
    const product = patchState.admin.products.find(value => String(value.id) === String(id));
    if (!product) return;
    patchState.admin.productId = id;
    document.getElementById('patchProductVersionTitle').textContent = `版本管理：${product.name}`;
    renderVersionList(product);
    document.getElementById('patchNewVersionInput').value = '';
    document.getElementById('patchProductVersionModal').hidden = false;
}

function renderVersionList(product) {
    const list = document.getElementById('patchVersionList');
    if (!product) { list.innerHTML = ''; return; }
    list.innerHTML = product.versions.length ? product.versions.map(version => `<div class="patch-version-row"><span>${patchEscape(version.version)}</span><button class="patch-link-btn danger" data-version-delete="${patchEscape(version.id)}">删除</button></div>`).join('') : '<p class="patch-muted">暂无版本，请在下方添加</p>';
}

async function reloadVersionList() {
    patchState.admin.products = await fetchProducts();
    renderVersionList(patchState.admin.products.find(value => String(value.id) === String(patchState.admin.productId)));
}

async function addProductVersion() {
    const input = document.getElementById('patchNewVersionInput');
    const version = input.value.trim();
    if (!version) { patchShowError('请填写版本号。', '添加版本失败'); input.focus(); return; }
    try {
        await patchRequest(`/api/products/${encodeURIComponent(patchState.admin.productId)}/versions`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version})});
        input.value = '';
        patchState.products = null;
        await reloadVersionList();
    } catch (error) { patchShowError(error.message, '添加版本失败'); }
}

function deleteProductVersion(id) {
    patchConfirm('删除后无法恢复此版本。', '删除版本').then(confirmed => {
        if (!confirmed) return;
        return patchRequest(`/api/products/${encodeURIComponent(patchState.admin.productId)}/versions/${encodeURIComponent(id)}`, {method: 'DELETE'}).then(() => { patchState.products = null; reloadVersionList(); });
    }).catch(error => patchShowError(error.message, '删除版本失败'));
}

function analysisStatusLabel(status) {
    return {0: '待分析', 1: '分析中', 2: '分析完成', 3: '分析失败'}[Number(status)] || `状态 ${status}`;
}

function updateAnalysisSelectionUI() {
    const items = patchState.admin.analysisPatches;
    const selected = patchState.admin.selectedAnalysisIds;
    const count = selected.size;
    document.getElementById('patchAnalysisSelected').textContent = `已选择 ${count} 个`;
    document.getElementById('patchAnalysisStart').disabled = count === 0 || Boolean(patchState.admin.analysisTimer);
    const allSelected = items.length > 0 && items.every(item => selected.has(String(item.id)));
    document.getElementById('patchAnalysisSelectAll').checked = allSelected;
    document.getElementById('patchAnalysisHeaderSelect').checked = allSelected;
}

function selectAnalysisCount() {
    const raw = Number(document.getElementById('patchAnalysisSelectCount').value);
    const count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    const items = patchState.admin.analysisPatches;
    patchState.admin.selectedAnalysisIds.clear();
    items.slice(0, count).forEach(item => patchState.admin.selectedAnalysisIds.add(String(item.id)));
    renderAnalysisPatches();
}

function renderAnalysisPatches() {
    const items = patchState.admin.analysisPatches;
    const selected = patchState.admin.selectedAnalysisIds;
    const body = document.getElementById('patchAnalysisBody');
    body.innerHTML = items.length ? items.map(item => `<tr><td><input class="patch-analysis-check" type="checkbox" data-analysis-id="${patchEscape(item.id)}" ${selected.has(String(item.id)) ? 'checked' : ''}></td><td class="patch-name-cell"><strong class="patch-truncated-name" title="${patchEscape(item.name)}">${patchEscape(item.name)}</strong><small class="patch-truncated-name" title="${patchEscape(item.file_name)}">${patchEscape(item.file_name)}</small></td><td>${patchEscape(String(item.file_format || '').toUpperCase())}</td><td>${patchFormatSize(item.file_size)}</td><td><span class="patch-status analysis-${Number(item.status)}">${analysisStatusLabel(item.status)}</span></td><td>${patchFormatDateTime(item.uploaded_at)}</td><td>${patchFormatDateTime(item.updated_at)}</td></tr>`).join('') : '<tr><td colspan="7" class="patch-empty">暂无待分析补丁</td></tr>';
    updateAnalysisSelectionUI();
}

async function loadAnalysisPatches() {
    if (!patchState.user || patchState.user.role !== 'admin') return;
    const body = document.getElementById('patchAnalysisBody');
    body.innerHTML = '<tr><td colspan="7" class="patch-empty">正在加载...</td></tr>';
    try { patchState.admin.analysisPatches = await patchRequest('/api/patches/pending-analysis'); renderAnalysisPatches(); }
    catch (error) { body.innerHTML = '<tr><td colspan="7" class="patch-empty">加载失败</td></tr>'; patchShowError(error.message, '待分析补丁加载失败'); }
}

async function startPatchAnalysis() {
    const ids = Array.from(patchState.admin.selectedAnalysisIds);
    if (!ids.length) return;
    const progress = document.getElementById('patchAnalysisProgress');
    document.getElementById('patchAnalysisStart').disabled = true;
    document.getElementById('patchAnalysisMessage').textContent = '正在创建分析任务...';
    try {
        const task = await patchRequest('/api/patches/analyze', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({patch_ids: ids})});
        const poll = async () => {
            const current = await patchRequest(`/api/patches/analyze/${encodeURIComponent(task.id)}`);
            progress.textContent = `${current.completed}/${current.total}`;
            // 实时同步每行补丁的状态徽标
            if (Array.isArray(current.patches)) {
                const statusMap = new Map(current.patches.map(p => [String(p.patch_id), p.status]));
                document.querySelectorAll('#patchAnalysisBody tr').forEach(row => {
                    const check = row.querySelector('input[data-analysis-id]');
                    const badge = row.querySelector('.patch-status');
                    if (!check || !badge) return;
                    const st = statusMap.get(String(check.dataset.analysisId));
                    if (!st) return;
                    const code = st === 'success' ? 2 : st === 'failed' ? 3 : st === 'running' ? 1 : 0;
                    badge.className = `patch-status analysis-${code}`;
                    badge.textContent = analysisStatusLabel(code);
                });
            }
            if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
                patchState.admin.analysisTimer = null;
                document.getElementById('patchAnalysisMessage').textContent = `分析结束：成功 ${current.success} 个，失败 ${current.failed} 个。`;
                patchState.admin.selectedAnalysisIds.clear();
                await loadAnalysisPatches();
                return;
            }
            patchState.admin.analysisTimer = setTimeout(poll, 1500);
        };
        await poll();
    } catch (error) { patchState.admin.analysisTimer = null; document.getElementById('patchAnalysisMessage').textContent = ''; patchShowError(error.message, '补丁分析失败'); renderAnalysisPatches(); }
}

function adminMessage(kind, text, error = false) {
    const element = document.getElementById(`patch${kind[0].toUpperCase()}${kind.slice(1)}Message`);
    element.textContent = error ? '' : (text || '');
    element.className = 'patch-message';
    if (error) patchShowError(text, '配置操作失败');
}

function configSource(item) {
    const scope = item.ownership_scope || (item.is_shared ? 'admin_shared' : 'mine');
    return scope === 'admin_shared' ? '<span class="config-owner-badge shared">管理员共享</span>' : '<span class="config-owner-badge mine">我的配置</span>';
}

function configActions(kind, item) {
    const actions = [];
    if (item.can_edit) actions.push(`<button class="patch-link-btn" data-admin-edit="${kind}:${item.id}">编辑</button>`);
    if (item.can_delete) actions.push(`<button class="patch-link-btn" data-admin-delete="${kind}:${item.id}">删除</button>`);
    if (!item.can_edit) actions.push(`<button class="patch-link-btn" data-admin-view="${kind}:${item.id}">查看</button><span class="config-readonly-label">只读</span>`);
    if (kind === 'template') actions.push(`<button class="patch-link-btn" data-admin-clone="${kind}:${item.id}">复制为新模板</button>`);
    return actions.join('');
}

async function loadAdminSettings(tab = 'flow') {
    if (!patchState.user) return;
    try {
        if (tab === 'flow') {
            const flows = await patchRequest('/api/workflows/flows');
            patchState.admin.flows = flows;
            await loadDirectories();
            document.getElementById('patchFlowBody').innerHTML = flows.map(item => `<tr><td>${patchEscape(item.code)}</td><td>${patchEscape(item.name)}</td><td>${patchEscape(item.claude_target)}</td><td>${item.save_context ? '是' : '否'}</td><td>${configSource(item)}</td><td>${configActions('flow', item)}</td></tr>`).join('') || '<tr><td colspan="6" class="patch-empty">暂无流程</td></tr>';
        } else if (tab === 'prompt') {
            const prompts = await patchRequest('/api/workflows/prompts');
            patchState.admin.prompts = prompts;
            document.getElementById('patchPromptBody').innerHTML = prompts.map(item => `<tr><td>${patchEscape(item.name)}</td><td>${patchEscape(item.description || '')}</td><td>${item.status ? '启用' : '停用'}</td><td>${configSource(item)}</td><td>${configActions('prompt', item)}</td></tr>`).join('') || '<tr><td colspan="5" class="patch-empty">暂无提示词</td></tr>';
        } else {
            const [templates, flows, prompts] = await Promise.all([patchRequest('/api/workflows/templates'), patchRequest('/api/workflows/flows'), patchRequest('/api/workflows/prompts')]);
            patchState.admin.templates = templates;
            patchState.admin.flows = flows; patchState.admin.prompts = prompts;
            document.getElementById('patchTemplateBody').innerHTML = templates.map(item => `<tr><td>${patchEscape(item.code)}</td><td>${patchEscape(item.name)}</td><td>${item.status ? '启用' : '停用'}</td><td>${configSource(item)}</td><td>${configActions('template', item)}</td></tr>`).join('') || '<tr><td colspan="5" class="patch-empty">暂无模板</td></tr>';
        }
    } catch (error) {
        adminMessage(tab, error.message, true);
    }
}

/* ── 菜单可见性配置（管理员） ── */
function menuRoleRows(items) {
    return (items || []).map(item => `<tr><td>${patchEscape(item.name)}</td><td>${patchEscape(item.key)}</td><td><input type="checkbox" data-menu-role-key="${patchEscape(item.key)}" ${item.visible ? 'checked' : ''}></td><td>${item.source === 'explicit' ? '已自定义' : '默认'}</td></tr>`).join('') || '<tr><td colspan="4" class="patch-empty">暂无菜单</td></tr>';
}

async function loadMenuRoleConfig() {
    try {
        const data = await patchRequest('/api/menus/config');
        patchState.admin.menuConfig.roleItems = data.items || [];
        patchState.admin.menuConfig.defaults = data.defaults || {};
        document.getElementById('patchMenuRoleBody').innerHTML = menuRoleRows(data.items);
    } catch (error) {
        document.getElementById('patchMenuRoleMessage').textContent = '';
        patchShowError(error.message, '菜单可见性加载失败');
    }
}

async function saveMenuRoleConfig() {
    const visible = {};
    document.querySelectorAll('#patchMenuRoleBody [data-menu-role-key]').forEach(input => { visible[input.dataset.menuRoleKey] = input.checked; });
    try {
        await patchRequest('/api/menus/config', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({visible})});
        document.getElementById('patchMenuRoleMessage').textContent = '已保存，普通用户下次进入即生效';
        await loadMenuRoleConfig();
        // 角色默认变了，已展开的用户例外需要重算「角色默认 / 实际可见」两列
        if (patchState.admin.menuConfig.userId) await loadMenuUserOverrides(patchState.admin.menuConfig.userId);
    } catch (error) {
        document.getElementById('patchMenuRoleMessage').textContent = '';
        patchShowError(error.message, '菜单可见性保存失败');
    }
}

async function loadMenuUsers(keyword = '') {
    try {
        const data = await patchRequest(`/api/menus/users?size=200&keyword=${encodeURIComponent(keyword)}`);
        patchState.admin.menuConfig.users = data.items || [];
        const options = patchState.admin.menuConfig.users.map(item => `<option value="${patchEscape(item.id)}">${patchEscape(item.display_name || item.username)} (${patchEscape(item.username)})</option>`).join('');
        // 用户量大（上千），下拉只列出前 200 个并提示总数，用筛选框缩小范围
        const placeholder = data.total > patchState.admin.menuConfig.users.length ? `选择用户（共 ${data.total} 个，列出前 ${patchState.admin.menuConfig.users.length} 个）` : `选择用户（共 ${data.total} 个）`;
        document.getElementById('patchMenuUserSelect').innerHTML = `<option value="">${patchEscape(placeholder)}</option>${options}`;
        document.getElementById('patchMenuUserSelect').value = patchState.admin.menuConfig.userId || '';
    } catch (error) {
        document.getElementById('patchMenuUserMessage').textContent = '';
        patchShowError(error.message, '用户列表加载失败');
    }
}

function menuUserRows(items) {
    return (items || []).map(item => {
        const override = item.override === true ? 'true' : item.override === false ? 'false' : '';
        return `<tr><td>${patchEscape(item.name)}</td><td>${item.role_visible ? '可见' : '隐藏'}</td><td><select data-menu-user-key="${patchEscape(item.key)}"><option value="" ${override === '' ? 'selected' : ''}>跟随角色默认</option><option value="true" ${override === 'true' ? 'selected' : ''}>强制可见</option><option value="false" ${override === 'false' ? 'selected' : ''}>强制隐藏</option></select></td><td>${item.visible ? '可见' : '隐藏'}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="patch-empty">暂无菜单</td></tr>';
}

async function loadMenuUserOverrides(userId) {
    if (!userId) {
        patchState.admin.menuConfig.userId = '';
        document.getElementById('patchMenuUserBody').innerHTML = '<tr><td colspan="4" class="patch-empty">请选择用户</td></tr>';
        return;
    }
    try {
        const data = await patchRequest(`/api/menus/users/${encodeURIComponent(userId)}`);
        patchState.admin.menuConfig.userId = String(userId);
        document.getElementById('patchMenuUserBody').innerHTML = menuUserRows(data.items);
    } catch (error) {
        document.getElementById('patchMenuUserMessage').textContent = '';
        patchShowError(error.message, '用户例外加载失败');
    }
}

async function saveMenuUserOverrides() {
    const userId = patchState.admin.menuConfig.userId;
    if (!userId) { document.getElementById('patchMenuUserMessage').textContent = '请先选择用户'; return; }
    // 全量提交：空字符串 → null（删除覆盖行、跟随角色默认），接口对 null 做 DELETE，重复提交幂等。
    const overrides = {};
    document.querySelectorAll('#patchMenuUserBody [data-menu-user-key]').forEach(select => { overrides[select.dataset.menuUserKey] = select.value === '' ? null : select.value === 'true'; });
    if (!Object.keys(overrides).length) { document.getElementById('patchMenuUserMessage').textContent = '请先选择用户'; return; }
    try {
        await patchRequest(`/api/menus/users/${encodeURIComponent(userId)}`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({overrides})});
        document.getElementById('patchMenuUserMessage').textContent = '已保存';
        await loadMenuUserOverrides(userId);
    } catch (error) {
        document.getElementById('patchMenuUserMessage').textContent = '';
        patchShowError(error.message, '用户例外保存失败');
    }
}

function flowDirectoryOptions(target, selectedCode) {
    const options = patchState.admin.directories
        .filter(directory => target !== 'server' || directory.is_builtin)
        .map(directory => `<option value="${patchEscape(directory.code)}" ${directory.code === selectedCode ? 'selected' : ''}>${patchEscape(directory.name)} (${patchEscape(directory.code)})</option>`)
        .join('');
    if (target === 'server') return options;
    // 本地 ClaudeCode：目录可在启动流程时由使用者逐步骤选择或手动填写，因此允许留空。
    return `<option value="" ${selectedCode ? '' : 'selected'}>（运行时由使用者选择）</option>${options}`;
}

function openAdminForm(kind, data = {}, readOnly = false) {
    patchState.admin.kind = kind; patchState.admin.id = data.id || null; patchState.admin.readOnly = readOnly;
    const form = document.getElementById('patchAdminForm');
    const modal = document.querySelector('#patchAdminModal .patch-admin-modal');
    const title = document.getElementById('patchAdminModalTitle');
    form.classList.toggle('template-admin-form', kind === 'template');
    modal.classList.toggle('template-admin-modal', kind === 'template');
    if (kind === 'flow') {
        title.textContent = data.id ? '编辑流程' : '新增流程';
        const target = data.claude_target || 'server';
        form.innerHTML = `<label>编码<input name="code" value="${patchEscape(data.code || '')}" ${data.id ? 'readonly' : ''} required></label><label>名称<input name="name" value="${patchEscape(data.name || '')}" required></label><label>描述<textarea name="description">${patchEscape(data.description || '')}</textarea></label><label>调用位置<select name="claude_target"><option value="local" ${target === 'local' ? 'selected' : ''}>本地 ClaudeCode</option><option value="server" ${target === 'server' ? 'selected' : ''}>服务器 ClaudeCode</option></select></label><label>工作目录<select name="directory_code" ${target === 'server' ? 'required' : ''}>${flowDirectoryOptions(target, data.directory_code)}</select><small class="patch-muted">本地 ClaudeCode 可留空，启动流程时由使用者逐步骤选择或手动填写本机路径。</small></label><label><input type="checkbox" name="save_context" ${data.save_context !== false ? 'checked' : ''}> 保存上下文</label>`;
    } else if (kind === 'prompt') {
        title.textContent = data.id ? '编辑提示词' : '新增提示词';
        form.innerHTML = `<label>名称<input name="name" value="${patchEscape(data.name || '')}" required></label><label>描述<input name="description" value="${patchEscape(data.description || '')}"></label><label>内容<textarea name="content" required placeholder="请输入可复用提示词内容">${patchEscape(data.content || '')}</textarea></label><label>状态<select name="status"><option value="1" ${data.status !== 0 ? 'selected' : ''}>启用</option><option value="0" ${data.status === 0 ? 'selected' : ''}>停用</option></select></label>`;
    } else {
        title.textContent = data.id ? '编辑流程模板' : '新增流程模板';
        const flowOptions = patchState.admin.flows.filter(item => item.can_use).map(item => `<option value="${patchEscape(item.id)}">${patchEscape(item.name)} (${patchEscape(item.code)})</option>`).join('');
        const promptOptions = '<option value="">不使用提示词</option>' + patchState.admin.prompts.filter(item => item.can_use).map(item => `<option value="${patchEscape(item.id)}">${patchEscape(item.name)}</option>`).join('');
        form.innerHTML = `<section class="template-form-section"><div class="template-section-heading"><div><h4>基本信息</h4><p>设置模板标识、名称和使用状态</p></div></div><div class="template-basic-fields"><label>编码<input name="code" value="${patchEscape(data.code || '')}" required placeholder="例如：patch_search"></label><label>名称<input name="name" value="${patchEscape(data.name || '')}" required placeholder="请输入模板名称"></label><label class="template-description-field">描述<textarea name="description" placeholder="简要说明模板的用途和适用场景">${patchEscape(data.description || '')}</textarea></label><label>状态<select name="status"><option value="1" ${data.status !== 0 ? 'selected' : ''}>启用</option><option value="0" ${data.status === 0 ? 'selected' : ''}>停用</option></select></label></div></section><section class="template-form-section template-workflow-section"><div class="template-steps-header"><div><h4>流程步骤</h4><p>按执行顺序组合流程与提示词</p><span id="patchTemplateStepCount" class="template-step-count"></span></div><button type="button" id="patchAddTemplateStep" class="patch-secondary-btn">新增步骤</button></div><div id="patchTemplateSteps" class="template-steps"></div></section>`;
        renderTemplateSteps(Array.isArray(data.steps) && data.steps.length ? data.steps : [{}], flowOptions, promptOptions);
    }
    form.querySelectorAll('input, textarea, select, button').forEach(control => { if (readOnly) control.disabled = true; });
    document.getElementById('patchAdminSave').hidden = readOnly;
    document.getElementById('patchAdminCancel').textContent = readOnly ? '关闭' : '取消';
    if (readOnly) title.textContent = title.textContent.replace('编辑', '查看');
    document.getElementById('patchAdminModal').hidden = false;
}

// 复制模板：为新模板建议一个"当前用户可见范围内"不冲突的编码
// （patchState.admin.templates 就是服务端返回的可见列表；最终仍以服务端创建时校验为准）
function cloneCodeSuggestion(baseCode) {
    const base = `${String(baseCode || 'template').slice(0, 100)}-copy`;
    const used = new Set((patchState.admin.templates || []).map(item => String(item.code)));
    let code = base;
    let suffix = 2;
    while (used.has(code)) { code = `${base}-${suffix}`; suffix += 1; }
    return code;
}

function workflowStepVariableOptions(stepIndex) {
    return `<option value="business_input">原始业务需求</option>` + Array.from({length: stepIndex}, (_, index) => `<option value="step.${index + 1}.context">步骤 ${index + 1} 上下文</option><option value="step.${index + 1}.result">步骤 ${index + 1} 结果</option>`).join('');
}

function renderTemplateSteps(steps, flowOptions, promptOptions) {
    const container = document.getElementById('patchTemplateSteps');
    container.innerHTML = steps.map((step, index) => `<fieldset class="template-step-card" data-step-index="${index}"><legend><span class="template-step-number">步骤 ${index + 1}</span><span class="template-step-actions"><button type="button" class="patch-link-btn" data-step-up ${index === 0 ? 'disabled' : ''}>上移</button><button type="button" class="patch-link-btn" data-step-down ${index === steps.length - 1 ? 'disabled' : ''}>下移</button>${steps.length > 1 ? '<button type="button" class="patch-link-btn danger" data-step-remove>删除</button>' : ''}</span></legend><div class="template-step-grid"><label>流程<select name="flow_id" required><option value="">请选择流程</option>${flowOptions}</select></label><label>提示词<select name="prompt_id">${promptOptions}</select></label></div>${index === 0 ? '<div class="template-first-step-note">首步骤执行时自动使用本次智能开发输入的业务需求或问题。</div>' : `<label>用户提示词<textarea name="user_prompt" required placeholder="可使用 {{business_input}} 或前置流程结果"></textarea><span class="template-variable-row">插入变量：<select data-step-variable><option value="">选择变量</option>${workflowStepVariableOptions(index)}</select><button type="button" class="patch-secondary-btn" data-insert-step-variable>插入</button></span></label>`}<label class="template-context-option"><input type="checkbox" name="save_context_override"> 保存本步骤输出供后续步骤使用</label></fieldset>`).join('');
    steps.forEach((step, index) => {
        const card = container.children[index];
        card.querySelector('[name="flow_id"]').value = step.flow_id == null ? '' : String(step.flow_id);
        card.querySelector('[name="prompt_id"]').value = step.prompt_id == null ? '' : String(step.prompt_id);
        const prompt = card.querySelector('[name="user_prompt"]');
        if (prompt) prompt.value = step.user_prompt || '';
        const override = card.querySelector('[name="save_context_override"]');
        override.checked = step.save_context_override === 1 || step.save_context_override === true;
        override.indeterminate = step.save_context_override == null;
    });
    document.getElementById('patchTemplateStepCount').textContent = `${steps.length} 个步骤`;
}

function collectTemplateSteps() {
    return Array.from(document.querySelectorAll('#patchTemplateSteps .template-step-card')).map((card, index) => ({
        step_order: index + 1,
        flow_id: Number(card.querySelector('[name="flow_id"]').value),
        prompt_id: card.querySelector('[name="prompt_id"]').value ? Number(card.querySelector('[name="prompt_id"]').value) : null,
        user_prompt: card.querySelector('[name="user_prompt"]')?.value.trim() || null,
        save_context_override: card.querySelector('[name="save_context_override"]').indeterminate ? null : (card.querySelector('[name="save_context_override"]').checked ? 1 : 0)
    }));
}

function reorderTemplateStepCards(cards) {
    const container = document.getElementById('patchTemplateSteps');
    cards.forEach((card, index) => {
        container.appendChild(card);
        card.querySelector('.template-step-number').textContent = `步骤 ${index + 1}`;
        card.querySelector('[data-step-up]').disabled = index === 0;
        card.querySelector('[data-step-down]').disabled = index === cards.length - 1;
    });
    document.getElementById('patchTemplateStepCount').textContent = `${cards.length} 个步骤`;
}

async function saveAdminForm(event) {
    event.preventDefault();
    if (patchState.admin.readOnly) return;
    const kind = patchState.admin.kind; const id = patchState.admin.id;
    const values = Object.fromEntries(new FormData(event.target).entries());
    let path; let body;
    if (kind === 'flow') { path = id ? `/api/workflows/flows/${id}` : '/api/workflows/flows'; body = {code: values.code, name: values.name, description: values.description || null, claude_target: values.claude_target, directory_code: values.directory_code || null, save_context: event.target.save_context.checked}; }
    else if (kind === 'prompt') { path = id ? `/api/workflows/prompts/${id}` : '/api/workflows/prompts'; body = {name: values.name, content: values.content, description: values.description || null, status: Number(values.status)}; }
    else {
        const steps = collectTemplateSteps();
        const invalidStep = steps.findIndex(step => !step.flow_id || (step.step_order > 1 && !step.user_prompt));
        if (invalidStep >= 0) { adminMessage('template', `请完善第 ${invalidStep + 1} 步的流程和用户提示词`, true); return; }
        const invalidReferenceStep = steps.find(step => Array.from((step.user_prompt || '').matchAll(/\{\{\s*step\.(\d+)\.(?:context|result)\s*\}\}/g)).some(match => Number(match[1]) >= step.step_order));
        if (invalidReferenceStep) { adminMessage('template', `第 ${invalidReferenceStep.step_order} 步只能引用此前步骤的输出`, true); return; }
        path = id ? `/api/workflows/templates/${id}` : '/api/workflows/templates';
        body = {code: values.code, name: values.name, description: values.description || null, status: Number(values.status), steps};
    }
    try {
        await patchRequest(path, {method: id ? 'PUT' : 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        document.getElementById('patchAdminModal').hidden = true;
        if (kind === 'template') {
            // 模板改动会牵动多处界面（本页模板列表、智能开发页的模板下拉、运行详情里的步骤），
            // 保存后直接整页刷新，确保全部取到最新数据；先把当前页签写进 ?tab=，刷新后仍停在原页签。
            const activeTab = document.querySelector('.patch-tab.active')?.dataset.tab;
            if (activeTab) { const url = new URL(location.href); url.searchParams.set('tab', activeTab); history.replaceState(null, '', url); }
            location.reload();
            return;
        }
        await loadAdminSettings(kind === 'flow' ? 'flow' : kind === 'prompt' ? 'prompt' : 'template');
    } catch (error) { adminMessage(kind === 'template' ? 'template' : kind, error.message, true); }
}

function workflowStatusLabel(status) {
    return {pending: '待执行', running: '执行中', waiting_confirmation: '待确认', success: '已完成', failed: '失败', cancelled: '已取消'}[status] || status || '未知';
}

function renderWorkflowHistory() {
    const state = patchState.workflowHistory;
    const body = document.getElementById('workflowHistoryBody');
    body.innerHTML = state.items.length ? state.items.map(item => {
        const deletable = ['success', 'failed', 'cancelled'].includes(item.status);
        const actions = `<button type="button" class="patch-secondary-btn workflow-view-btn" data-workflow-view-id="${patchEscape(item.id)}">查看</button>${deletable ? `<button type="button" class="patch-secondary-btn workflow-delete-btn" data-workflow-delete-id="${patchEscape(item.id)}">删除</button>` : ''}`;
        return `<tr><td><strong>${patchEscape(item.template_name || '-')}</strong><small>${patchEscape(item.template_code || '')}</small></td><td class="workflow-history-input-cell" title="${patchEscape(item.business_input || '')}">${patchEscape(item.business_input || '-')}</td><td><span class="patch-status workflow-status-${patchEscape(item.status)}">${patchEscape(workflowStatusLabel(item.status))}</span></td><td>${Number(item.current_step || 0)} / ${Number(item.step_count || 0)}</td><td>${patchFormatDateTime(item.updated_at || item.created_at)}</td><td>${actions}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="patch-empty">暂无流程运行记录</td></tr>';
    document.getElementById('workflowHistoryPageInfo').textContent = `第 ${state.page} 页 · 共 ${state.total} 条`;
    document.getElementById('workflowHistoryPrev').disabled = state.page <= 1;
    document.getElementById('workflowHistoryNext').disabled = state.page * state.size >= state.total;
}

function deleteWorkflowRun(id) {
    patchConfirm('删除后无法恢复，该流程运行的记录与各步骤输出将一并删除。', '删除流程记录').then(confirmed => {
        if (!confirmed) return;
        return patchRequest(`/api/workflows/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(loadWorkflowHistory);
    }).catch(error => patchShowError(error.message, '删除流程记录失败'));
}

async function loadWorkflowHistory() {
    const body = document.getElementById('workflowHistoryBody');
    body.innerHTML = '<tr><td colspan="6" class="patch-empty">正在加载...</td></tr>';
    try {
        const state = patchState.workflowHistory;
        const data = await patchRequest(`/api/workflows/runs?page=${state.page}&size=${state.size}`);
        state.items = data.items || []; state.total = Number(data.total || 0); state.page = Number(data.page || state.page); state.size = Number(data.size || state.size);
        renderWorkflowHistory();
    } catch (error) { body.innerHTML = '<tr><td colspan="6" class="patch-empty">加载失败</td></tr>'; patchShowError(error.message, '流程运行记录加载失败'); }
}

function openWorkflowHistory(runId) {
    // 流程运行详情已迁移到独立的「流程运行详情」页面，跳转过去查看
    location.href = `/workflow_run.html?run_id=${encodeURIComponent(runId)}`;
}

async function openUserSettings() {
    const modal = document.getElementById('patchUserSettingsModal');
    modal.hidden = false;
    document.getElementById('patchUserProfile').textContent = '正在加载...';
    document.getElementById('patchChangePasswordMessage').textContent = '';
    try {
        const profile = await patchRequest('/api/auth/profile');
        document.getElementById('patchUserProfile').innerHTML = `<dt>用户名</dt><dd>${patchEscape(profile.username)}</dd><dt>显示名称</dt><dd>${patchEscape(profile.display_name)}</dd><dt>角色</dt><dd>${patchEscape(profile.role)}</dd><dt>注册时间</dt><dd>${patchFormatDateTime(profile.created_at)}</dd><dt>最近登录</dt><dd>${patchFormatDateTime(profile.last_login_at)}</dd>`;
    } catch (error) {
        modal.hidden = true;
        patchShowError(error.message, '个人信息加载失败');
    }
}

async function changePassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    const message = document.getElementById('patchChangePasswordMessage');
    if (values.new_password !== values.confirm_password) {
        message.textContent = '两次输入的新密码不一致';
        return;
    }
    try {
        await patchRequest('/api/auth/change-password', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(values)});
        document.getElementById('patchUserSettingsModal').hidden = true;
        patchHandleUnauthorized();
        document.getElementById('patchLoginMessage').textContent = '密码修改成功，请使用新密码重新登录';
        form.reset();
    } catch (error) {
        message.textContent = error.message;
    }
}

function patchBindEvents() {
    patchSetupTabs();
    document.querySelectorAll('.patch-tab').forEach(button => button.addEventListener('click', () => patchSwitchTab(button.dataset.tab)));
    document.querySelector('.patch-tabs').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(document.querySelectorAll('.patch-tab')).filter(tab => !tab.hidden);
        const current = tabs.indexOf(document.activeElement);
        if (current < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].focus();
        patchSwitchTab(tabs[next].dataset.tab);
    });
    document.getElementById('patchThemeToggle').onclick = () => patchSetTheme(patchState.theme === 'dark' ? 'light' : 'dark');
    document.getElementById('patchLoginBtn').onclick = patchLogin;
    document.getElementById('patchUserSettings').onclick = openUserSettings;
    document.getElementById('patchUserSettingsClose').onclick = () => { document.getElementById('patchUserSettingsModal').hidden = true; };
    document.getElementById('patchUserSettingsCancel').onclick = () => { document.getElementById('patchUserSettingsModal').hidden = true; };
    document.getElementById('patchUserSettingsModal').onclick = event => { if (event.target.id === 'patchUserSettingsModal') event.currentTarget.hidden = true; };
    document.getElementById('patchChangePasswordForm').onsubmit = changePassword;
    document.getElementById('patchLoginPassword').onkeydown = (event) => { if (event.key === 'Enter') patchLogin(); };
    document.getElementById('patchLogout').onclick = async () => {
        const logoutToken = patchToken();
        patchHandleUnauthorized();
        setPatchHelpPanel(true); // 切换账号前也复位为展开
        patchHelpSave(true);
        if (!logoutToken) return;
        try {
            await fetch(patchApiUrl('/api/auth/logout'), {method: 'POST', headers: {Authorization: `Bearer ${logoutToken}`}});
        } catch {}
    };
    document.getElementById('patchNewFlow').onclick = () => openAdminForm('flow');
    document.getElementById('patchNewPrompt').onclick = () => openAdminForm('prompt');
    document.getElementById('patchNewTemplate').onclick = () => openAdminForm('template');
    document.getElementById('patchNewDirectory').onclick = () => openDirectoryForm();
    document.getElementById('patchDirectoryForm').onsubmit = saveDirectory;
    document.getElementById('patchDirectoryClose').onclick = () => { document.getElementById('patchDirectoryModal').hidden = true; };
    document.getElementById('patchDirectoryCancel').onclick = () => { document.getElementById('patchDirectoryModal').hidden = true; };
    document.getElementById('patchMenuRoleSave').onclick = saveMenuRoleConfig;
    document.getElementById('patchMenuUserSave').onclick = saveMenuUserOverrides;
    document.getElementById('patchMenuUserSelect').onchange = event => { document.getElementById('patchMenuUserMessage').textContent = ''; loadMenuUserOverrides(event.target.value); };
    document.getElementById('patchMenuUserSearch').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); loadMenuUsers(event.target.value.trim()); } };
    document.getElementById('patchNewProduct').onclick = () => openProductForm();
    document.getElementById('patchProductForm').onsubmit = saveProduct;
    document.getElementById('patchProductClose').onclick = () => { document.getElementById('patchProductModal').hidden = true; };
    document.getElementById('patchProductCancel').onclick = () => { document.getElementById('patchProductModal').hidden = true; };
    document.getElementById('patchProductModal').onclick = event => { if (event.target.id === 'patchProductModal') event.currentTarget.hidden = true; };
    document.getElementById('patchNewVersionAdd').onclick = () => addProductVersion();
    document.getElementById('patchNewVersionInput').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addProductVersion(); } };
    document.getElementById('patchProductVersionClose').onclick = () => { document.getElementById('patchProductVersionModal').hidden = true; };
    document.getElementById('patchProductVersionDone').onclick = () => { document.getElementById('patchProductVersionModal').hidden = true; };
    document.getElementById('patchProductVersionModal').onclick = event => { if (event.target.id === 'patchProductVersionModal') event.currentTarget.hidden = true; };
    document.getElementById('patchAnalysisRefresh').onclick = () => loadAnalysisPatches();
    document.getElementById('patchAnalysisStart').onclick = () => startPatchAnalysis().catch(error => patchShowError(error.message, '补丁分析失败'));
    const toggleAnalysisSelection = (checked) => {
        patchState.admin.analysisPatches.forEach(item => { if (checked) patchState.admin.selectedAnalysisIds.add(String(item.id)); else patchState.admin.selectedAnalysisIds.delete(String(item.id)); });
        renderAnalysisPatches();
    };
    document.getElementById('patchAnalysisSelectAll').onchange = event => toggleAnalysisSelection(event.target.checked);
    document.getElementById('patchAnalysisHeaderSelect').onchange = event => toggleAnalysisSelection(event.target.checked);
    document.getElementById('patchAnalysisSelectCount').onkeydown = event => { if (event.key === 'Enter') selectAnalysisCount(); };
    document.getElementById('patchAdminForm').onsubmit = saveAdminForm;
    document.getElementById('patchAdminForm').addEventListener('change', event => {
        if (patchState.admin.kind !== 'flow' || event.target.name !== 'claude_target') return;
        const directory = event.currentTarget.querySelector('[name="directory_code"]');
        directory.innerHTML = flowDirectoryOptions(event.target.value, directory.value);
        // server 必须选择内置目录；local 允许留空（运行时再指定）
        if (event.target.value === 'server') directory.setAttribute('required', '');
        else directory.removeAttribute('required');
    });
    document.getElementById('patchAdminClose').onclick = () => { document.getElementById('patchAdminModal').hidden = true; };
    document.getElementById('patchAdminCancel').onclick = () => { document.getElementById('patchAdminModal').hidden = true; };
    document.getElementById('patchAdminForm').addEventListener('click', (event) => {
        if (patchState.admin.kind !== 'template') return;
        const steps = document.getElementById('patchTemplateSteps');
        if (event.target.id === 'patchAddTemplateStep') {
            const current = collectTemplateSteps();
            current.push({});
            const flows = patchState.admin.flows.map(item => `<option value="${patchEscape(item.id)}">${patchEscape(item.name)} (${patchEscape(item.code)})</option>`).join('');
            const prompts = '<option value="">不使用提示词</option>' + patchState.admin.prompts.filter(item => item.status).map(item => `<option value="${patchEscape(item.id)}">${patchEscape(item.name)}</option>`).join('');
            renderTemplateSteps(current, flows, prompts);
        }
        const card = event.target.closest('.template-step-card');
        if (!card) return;
        if (event.target.closest('[data-insert-step-variable]')) {
            const variable = card.querySelector('[data-step-variable]').value;
            const prompt = card.querySelector('[name="user_prompt"]');
            if (variable && prompt) {
                const token = `{{${variable}}}`;
                const start = prompt.selectionStart;
                prompt.value = `${prompt.value.slice(0, start)}${token}${prompt.value.slice(prompt.selectionEnd)}`;
                prompt.focus();
                prompt.selectionStart = prompt.selectionEnd = start + token.length;
            }
            return;
        }
        const cards = Array.from(steps.children);
        const index = cards.indexOf(card);
        if (event.target.closest('[data-step-remove]')) {
            if (cards.length <= 1) return;
            cards.splice(index, 1);
            renderTemplateSteps(cards.map(item => ({flow_id: item.querySelector('[name="flow_id"]').value, prompt_id: item.querySelector('[name="prompt_id"]').value || null, user_prompt: item.querySelector('[name="user_prompt"]')?.value.trim() || null, save_context_override: item.querySelector('[name="save_context_override"]').indeterminate ? null : (item.querySelector('[name="save_context_override"]').checked ? 1 : 0)})), patchState.admin.flows.map(item => `<option value="${patchEscape(item.id)}">${patchEscape(item.name)} (${patchEscape(item.code)})</option>`).join(''), '<option value="">不使用提示词</option>' + patchState.admin.prompts.filter(item => item.status).map(item => `<option value="${patchEscape(item.id)}">${patchEscape(item.name)}</option>`).join(''));
        } else if (event.target.closest('[data-step-up]') && index > 0) {
            [cards[index - 1], cards[index]] = [cards[index], cards[index - 1]];
            reorderTemplateStepCards(cards);
        } else if (event.target.closest('[data-step-down]') && index < cards.length - 1) {
            [cards[index], cards[index + 1]] = [cards[index + 1], cards[index]];
            reorderTemplateStepCards(cards);
        }
    });
    document.getElementById('patchSearchBtn').onclick = () => { patchState.keyword = document.getElementById('patchKeyword').value.trim(); patchState.page = 1; loadPatches(); };
    document.getElementById('patchKeyword').onkeydown = (event) => { if (event.key === 'Enter') document.getElementById('patchSearchBtn').click(); };
    document.getElementById('patchAdvancedToggle').onclick = openAdvancedSearch;
    document.getElementById('patchAdvSearch').onclick = applyAdvancedSearch;
    document.getElementById('patchAdvReset').onclick = resetAdvancedSearch;
    document.getElementById('patchAdvBack').onclick = closeAdvancedSearch;
    ['patchAdvName', 'patchAdvVersion', 'patchAdvKeyword', 'patchAdvDescription'].forEach(id => {
        document.getElementById(id).onkeydown = (event) => { if (event.key === 'Enter') applyAdvancedSearch(); };
    });
    document.getElementById('patchPrevBtn').onclick = () => { if (patchState.page > 1) { patchState.page -= 1; loadPatches(); } };
    document.getElementById('patchNextBtn').onclick = () => { patchState.page += 1; loadPatches(); };
    document.getElementById('patchChooseBtn').onclick = () => document.getElementById('patchFileInput').click();
    document.getElementById('patchFileInput').onchange = (event) => { if (event.target.files.length) showUploadModal(event.target.files); };
    const dropZone = document.getElementById('patchDropZone');
    dropZone.ondragover = (event) => { event.preventDefault(); dropZone.classList.add('dragging'); };
    dropZone.ondragleave = () => dropZone.classList.remove('dragging');
    dropZone.ondrop = (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); if (event.dataTransfer.files.length) showUploadModal(event.dataTransfer.files); };
    document.getElementById('patchUploadStart').onclick = startUpload;
    document.getElementById('patchUploadClose').onclick = closeUploadModal;
    document.getElementById('patchUploadCancel').onclick = () => document.getElementById('patchUploadStart').disabled ? null : closeUploadModal();
    document.getElementById('patchUploadItems').addEventListener('change', (event) => {
        const select = event.target.closest('.patch-file-product');
        if (!select) return;
        const versionInput = select.closest('.patch-upload-item').querySelector('.patch-file-version');
        const list = versionInput.list;
        const product = (patchState.products || []).find(value => value.name === select.value);
        if (list) list.innerHTML = productVersionOptions(product);
        if (versionInput.value && !(product?.versions || []).some(value => value.version === versionInput.value)) versionInput.value = '';
    });
    document.getElementById('patchMineRefresh').onclick = () => loadMyPatches();
    document.getElementById('patchMinePrev').onclick = () => { if (patchState.mine.page > 1) { patchState.mine.page -= 1; loadMyPatches(); } };
    document.getElementById('patchMineNext').onclick = () => { if (patchState.mine.page * patchState.mine.size < patchState.mine.total) { patchState.mine.page += 1; loadMyPatches(); } };
    document.getElementById('patchEditClose').onclick = () => { document.getElementById('patchEditModal').hidden = true; };
    document.getElementById('patchEditCancel').onclick = () => { document.getElementById('patchEditModal').hidden = true; };
    document.getElementById('patchEditModal').onclick = event => { if (event.target.id === 'patchEditModal') event.currentTarget.hidden = true; };
    document.getElementById('patchEditForm').onsubmit = event => { event.preventDefault(); savePatchEdit(); };
    document.getElementById('patchEditProduct').addEventListener('change', (event) => {
        const product = (patchState.products || []).find(value => value.name === event.target.value);
        const versionInput = document.getElementById('patchEditVersion');
        document.getElementById('patchEditVersionList').innerHTML = productVersionOptions(product);
        if (versionInput.value && !(product?.versions || []).some(value => value.version === versionInput.value)) versionInput.value = '';
    });
    document.getElementById('patchDetailClose').onclick = () => { document.getElementById('patchDetailModal').hidden = true; };
    document.getElementById('patchErrorClose').onclick = patchCloseError;
    document.getElementById('patchErrorConfirm').onclick = patchCloseError;
    document.getElementById('patchErrorModal').onclick = event => { if (event.target.id === 'patchErrorModal') patchCloseError(); };
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.getElementById('patchErrorModal').hidden) patchCloseError(); });
    document.getElementById('workflowStart').onclick = () => startWorkflow().catch(error => patchShowError(error.message, '流程启动失败'));
    document.getElementById('patchWorkflowDirClose').onclick = closeWorkflowDirDialog;
    document.getElementById('patchWorkflowDirCancel').onclick = closeWorkflowDirDialog;
    document.getElementById('patchWorkflowDirConfirm').onclick = () => confirmWorkflowDirDialog().catch(error => patchShowError(error.message, '流程启动失败'));
    document.getElementById('patchWorkflowDirModal').onclick = event => { if (event.target.id === 'patchWorkflowDirModal') closeWorkflowDirDialog(); };
    document.getElementById('patchWorkflowDirBody').addEventListener('change', event => {
        if (!event.target.matches('[data-dir-manual]')) return;
        const row = event.target.closest('[data-dir-step]');
        if (!row) return;
        row.querySelector('[data-dir-existing]').disabled = event.target.checked;
        row.querySelector('[data-dir-path]').disabled = !event.target.checked;
    });
    document.getElementById('workflowTemplateSelect').addEventListener('change', updateWorkflowTemplateDesc);
    document.getElementById('workflowHistoryRefresh').onclick = () => loadWorkflowHistory();
    document.getElementById('workflowHistoryPrev').onclick = () => { if (patchState.workflowHistory.page > 1) { patchState.workflowHistory.page -= 1; loadWorkflowHistory(); } };
    document.getElementById('workflowHistoryNext').onclick = () => { if (patchState.workflowHistory.page * patchState.workflowHistory.size < patchState.workflowHistory.total) { patchState.workflowHistory.page += 1; loadWorkflowHistory(); } };
    document.addEventListener('click', (event) => {
        const workflowView = event.target.closest('[data-workflow-view-id]');
        if (workflowView) { openWorkflowHistory(workflowView.dataset.workflowViewId); return; }
        const workflowDelete = event.target.closest('[data-workflow-delete-id]');
        if (workflowDelete) { deleteWorkflowRun(workflowDelete.dataset.workflowDeleteId); return; }
        const detail = event.target.closest('[data-detail-id]');
        if (detail) showPatchDetail(detail.dataset.detailId);
        const download = event.target.closest('[data-download-id]');
        if (download) downloadPatch(download.dataset.downloadId, download.dataset.downloadName);
        const mineEdit = event.target.closest('[data-mine-edit]');
        if (mineEdit) { openPatchEdit(mineEdit.dataset.mineEdit); return; }
        const mineDelete = event.target.closest('[data-mine-delete]');
        if (mineDelete) { deleteMinePatch(mineDelete.dataset.mineDelete); return; }
        const searchEdit = event.target.closest('[data-search-edit]');
        if (searchEdit) { openPatchEdit(searchEdit.dataset.searchEdit); return; }
        const searchDelete = event.target.closest('[data-search-delete]');
        if (searchDelete) { deleteSearchPatch(searchDelete.dataset.searchDelete); return; }
        const view = event.target.closest('[data-admin-view]');
        if (view) {
            const [kind, id] = view.dataset.adminView.split(':');
            const source = kind === 'flow' ? patchState.admin.flows : kind === 'prompt' ? patchState.admin.prompts : patchState.admin.templates;
            const item = source.find(value => String(value.id) === id);
            if (item && kind === 'template') patchRequest(`/api/workflows/templates/${id}`).then(detail => openAdminForm(kind, detail, true)).catch(error => adminMessage('template', error.message, true));
            else if (item) openAdminForm(kind, item, true);
            return;
        }
        const edit = event.target.closest('[data-admin-edit]');
        if (edit) {
            const [kind, id] = edit.dataset.adminEdit.split(':');
            const source = kind === 'flow' ? patchState.admin.flows : kind === 'prompt' ? patchState.admin.prompts : patchState.admin.templates;
            const item = source.find(value => String(value.id) === id);
            if (item && kind === 'template') patchRequest(`/api/workflows/templates/${id}`).then(detail => openAdminForm(kind, detail)).catch(error => adminMessage('template', error.message, true));
            else if (item) openAdminForm(kind, item);
        }
        const adminClone = event.target.closest('[data-admin-clone]');
        if (adminClone) {
            const [kind, id] = adminClone.dataset.adminClone.split(':');
            if (kind !== 'template') return;
            // 复制模板：以副本内容打开「新增流程模板」表单，编码可编辑，保存后才真正创建。
            // 不再直接调用后端 clone 接口，否则打开的是编辑表单、编码被置为只读而无法修改。
            patchRequest(`/api/workflows/templates/${encodeURIComponent(id)}`)
                .then(detail => openAdminForm('template', {
                    ...detail,
                    id: null,
                    code: cloneCodeSuggestion(detail.code),
                    name: `${detail.name || ''}（副本）`.slice(0, 255),
                }))
                .catch(error => adminMessage('template', error.message, true));
            return;
        }
        const directoryEdit = event.target.closest('[data-directory-edit]');
        if (directoryEdit) { const item = patchState.admin.directories.find(value => String(value.id) === directoryEdit.dataset.directoryEdit); if (item) openDirectoryForm(item); }
        const directoryDelete = event.target.closest('[data-directory-delete]');
        if (directoryDelete) { patchRequest(`/api/workflows/directories/${directoryDelete.dataset.directoryDelete}`, {method: 'DELETE'}).then(loadDirectories).catch(error => patchShowError(error.message, '工作目录停用失败')); }
        const directoryRemove = event.target.closest('[data-directory-remove]');
        if (directoryRemove) {
            const item = patchState.admin.directories.find(value => String(value.id) === directoryRemove.dataset.directoryRemove);
            const name = item ? `${item.name || item.code}（${item.code}）` : '';
            patchConfirm(`删除后无法恢复。若有流程模板或运行记录引用该目录「${name}」，相关流程将无法再解析此工作目录。`, '删除工作目录').then(confirmed => {
                if (!confirmed) return;
                return patchRequest(`/api/workflows/directories/${directoryRemove.dataset.directoryRemove}/permanent`, {method: 'DELETE'}).then(() => loadDirectories()).catch(error => patchShowError(error.message, '工作目录删除失败'));
            });
        }
        const productVersions = event.target.closest('[data-product-versions]');
        if (productVersions) { openProductVersions(productVersions.dataset.productVersions); return; }
        const productEdit = event.target.closest('[data-product-edit]');
        if (productEdit) { const item = patchState.admin.products.find(value => String(value.id) === productEdit.dataset.productEdit); if (item) openProductForm(item); return; }
        const productDelete = event.target.closest('[data-product-delete]');
        if (productDelete) { deleteProduct(productDelete.dataset.productDelete); return; }
        const versionDelete = event.target.closest('[data-version-delete]');
        if (versionDelete) { deleteProductVersion(versionDelete.dataset.versionDelete); return; }
        const analysisCheck = event.target.closest('[data-analysis-id]');
        if (analysisCheck) {
            const id = String(analysisCheck.dataset.analysisId);
            if (analysisCheck.checked) patchState.admin.selectedAnalysisIds.add(id); else patchState.admin.selectedAnalysisIds.delete(id);
            // 只更新计数/按钮/全选，不重建整表，避免点击延迟
            updateAnalysisSelectionUI();
        }
        const remove = event.target.closest('[data-admin-delete]');
        if (remove) {
            const [kind, id] = remove.dataset.adminDelete.split(':');
            patchConfirm('删除后无法恢复此配置。', '删除配置').then(confirmed => { if (confirmed) return patchRequest(`/api/workflows/${kind}s/${id}`, {method: 'DELETE'}).then(() => loadAdminSettings(kind)); }).catch(error => adminMessage(kind === 'template' ? 'template' : kind, error.message, true));
        }
    });

    // 使用说明面板：登录时默认展开；刷新时同步恢复收起状态，避免闪一下
    document.getElementById('patchHelpToggle').onclick = () => { setPatchHelpPanel(true); patchHelpSave(true); };
    document.getElementById('patchHelpReopen').onclick = () => { setPatchHelpPanel(true); patchHelpSave(true); };
    // 登录态校验失败（网络故障）时的重试入口：直接重新加载页面重新走一遍启动流程
    document.getElementById('patchAuthRetry').onclick = () => location.reload();
    document.getElementById('patchHelpCollapse').onclick = () => { setPatchHelpPanel(false); patchHelpSave(false); };
    patchHelpApplyStored();

    // 操作列固定 190px：详情/下载/编辑/删除 四个按钮共需约 172px（含单元格左右内边距），
    // 小于这个宽度时按钮会被裁掉点不到
    initPatchColumnResize('.patch-search-table', 'cc-web-patch-col-widths', [280, 170, 96, 70, 90, 160, 190], 190);
    initPatchColumnResize('.patch-mine-table', 'cc-web-patch-mine-col-widths-v2', [280, 170, 96, 70, 90, 96, 190], 190);
}

patchInitTheme();
patchBindEvents();
patchInitSidenav();
// 先读取服务端 /api/patch-config（地址在 cc-web 代码内写死），异常时直接报错并中止后续请求
patchLoadConfig().then(() => {
    patchRestoreAuth().then(authenticated => {
        if (!authenticated) return;
        // 从流程运行详情页返回时带 ?tab=smart，直接切到智能开发页签
        const returnTab = new URLSearchParams(location.search).get('tab');
        const tabButton = returnTab && document.querySelector(`.patch-tab[data-tab="${returnTab}"]`);
        // 深链守卫：?tab=X 只在 X 当前可见（未被菜单可见性隐藏）时才切过去，否则回落到默认页签
        if (tabButton && !tabButton.hidden) { patchSwitchTab(returnTab); loadPatches(); loadDashboard(); }
        else { loadPatches(); loadWorkflowTemplates(); loadDashboard(); restoreWorkflowRun(); loadWorkflowHistory(); }
    });
}).catch(error => {
    document.documentElement.classList.remove('patch-auth-pending');
    const status = document.getElementById('patchApiStatus');
    if (status) { status.textContent = '配置缺失'; status.className = 'patch-api-status error'; }
    patchShowError(error.message, '补丁中心配置错误');
});

// 从流程运行详情页用浏览器「后退」回来时，可能命中 bfcache：页面直接从内存恢复，
// 启动流程不会重跑，流程运行记录等列表会停在打开详情页之前的旧数据上。
// 这里在恢复时按当前页签重新拉一次数据（详情页的「返回」按钮走正常导航，本就会重新加载）。
window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    if (!patchToken() || patchState.authInvalidated) return;
    const activeTab = document.querySelector('.patch-tab.active')?.dataset.tab;
    if (activeTab) patchSwitchTab(activeTab);
});
