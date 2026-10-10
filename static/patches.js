const PATCH_TOKEN_KEY = 'patch-search-access-token';
const PATCH_REQUEST_TIMEOUT = 60000; // 单个服务地址单次请求超时（毫秒），超时视为该地址不可用并切换下一条

const patchState = { page: 1, search: { page: 1, size: 10, total: 0 }, searchStatus: '', keyword: '', files: [], adaptEntries: [], theme: 'light', patchSearchServers: [], patchServerCursor: 0, user: null, authInvalidated: false, searchGeneration: 0, products: null, advancedOpen: false, advanced: { name: '', product: '', version: '', keyword: '', description: '' }, searchItems: [], admin: { kind: '', id: null, flows: [], prompts: [], templates: [], directories: [], directoryId: null, projectEnvs: [], projectEnvId: null, menuConfig: { roleItems: [], roleVisible: {}, defaults: {}, users: [], userId: '', userItems: [], userOverrides: {} }, analysisPatches: [], selectedAnalysisIds: new Set(), analysisTimer: null, analysisPager: {page:1,size:20,total:0}, analysisStatus: '', analysisGeneration: 0, products: [], productId: null }, workflow: { runId: '', steps: [], currentStep: 0, status: '', source: null, token: '', lastEventId: 0, localExecutions: new Set(), templates: [] }, workflowHistory: { page: 1, size: 10, total: 0, items: [] }, workflowDetail: { runId: '', snapshot: null }, mine: { page: 1, size: 10, total: 0, items: [], generation: 0 }, node: { host: '', runs: [], current: null, es: null, streaming: false, pendingPrompt: null, liveTranscript: '', flushHandle: 0 }, projectEnv: { page: 1, size: 10, total: 0 }, clientPagers: {}, adapt: { current: null, runs: [] } };

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
const PATCH_MENU_KEYS = ['node', 'smart', 'search', 'upload', 'mine', 'adapt', 'flow', 'prompt', 'template', 'analysis', 'product', 'directory', 'project_env'];

// 旧后端（/api/auth/me 无 menus 字段）时严格复刻改造前的显隐规则，保证前端可先于后端发布。
function legacyMenuKeys(user, isAdmin) {
    const base = ['node', 'smart', 'search', 'upload', 'mine', 'adapt', 'directory'];
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
    const sessionsTab = document.querySelector('.patch-tab[data-tab="sessions"]');
    if (sessionsTab) sessionsTab.hidden = !isAdmin;
    // 版本发布：前端专属的管理员页签（与 menus / sessions 同款，不进服务器菜单配置表）
    const releaseTab = document.querySelector('.patch-tab[data-tab="release"]');
    if (releaseTab) releaseTab.hidden = !isAdmin;
    // 侧边栏不再跟着页签走：/sidenav.js 直接按同一份菜单权限渲染（四个页面共用一份定义）
    // 登录后自动查一次新版本（只查一次；失败静默不打扰）。
    // 注意这里能判断"已登录"的变量是 user（本函数没有 patchSetAuthenticated 里的
    // authenticated——上一个版本就是把它写错成了 authenticated，登录后在这里抛
    // ReferenceError，把后面的用户名/退出按钮/列表加载全部截断了）
    if (user && !patchUpdateState.checked) {
        patchUpdateState.checked = true;
        patchUpdateCheck(false).catch(() => {});
    }
    return keys;
}

// 左侧导航的折叠/展开、菜单显隐、当前页高亮统一由 /sidenav.js 负责（四个页面共用一份菜单定义），
// 本文件不再维护侧边栏——这里以前还有 patchSyncSidenavVisibility（镜像页签显隐）、
// patchSidenavSyncToggle / patchToggleSidenav（折叠），都随这次统一改造删掉了。
function patchSetSidenavActive(tab) {
    const nav = document.getElementById('patchSidenav');
    if (!nav) return;
    nav.querySelectorAll('.patch-sidenav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.sidenavTab === tab);
    });
}
function patchInitSidenav() {
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

/* ── 统一分页条 ──
   所有列表共用：显示「共 N 条 · 第 X/Y 页」+ 上/下页 + 跳转输入 + 每页条数下拉。
   DOM 约定：容器带 data-pager="<key>"，内部有 [data-pager-info]/[data-pager-prev]/[data-pager-next]/
   [data-pager-jump]/[data-pager-go]/[data-pager-size]。事件用 document 级委托统一处理（见 patchBindPagerEvents）。
   每页条数按 key 记在 localStorage，下次进页沿用。
   列表接线：patchRegisterPager(key, state, reload)，其中 state 为 {page,size,total}（组件会就地改 page/size），
   reload 为「重新取数或重渲染」的函数；每次加载完调 patchRenderPager(key) 刷新分页条。 */
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
// 给所有分页条宿主填充控件（进页时调一次；已填充的跳过）
// 给所有分页条宿主填充控件（进页时调一次；已填充的跳过）。
// 待分析补丁的大档位（1000/2000/3000/5000/20万）仅管理员可选，登录前不知道角色，
// 所以这里统一给默认档位，认证后由 patchSetAnalysisPagerSizes 按角色刷新。
function patchInitPagers() {
    document.querySelectorAll('.patch-pager[data-pager]').forEach(host => {
        if (!host.querySelector('[data-pager-info]')) host.innerHTML = patchPagerControlsHTML();
    });
}

// 待分析补丁分页条按角色刷新每页条数档位与上限：管理员多 1000/2000/3000/5000/200000 五档。
// 非管理员如果沿用上了超大档位（同一浏览器换账号），压回 100 并落盘。
function patchSetAnalysisPagerSizes(isAdmin) {
    const select = document.querySelector('[data-pager="analysis"] [data-pager-size]');
    if (!select) return;
    const sizes = isAdmin ? [10, 20, 50, 100, 1000, 2000, 3000, 5000, 200000] : [10, 20, 50, 100];
    const current = String(patchState.admin.analysisPager.size);
    select.innerHTML = sizes.map(size => `<option value="${size}"${String(size) === current ? ' selected' : ''}>${size} 条/页</option>`).join('');
    const entry = patchPagers['analysis'];
    if (entry) entry.maxSize = isAdmin ? 200000 : 100;
    if (!isAdmin && patchState.admin.analysisPager.size > 100) {
        patchState.admin.analysisPager.size = 100;
        patchPagerSaveSize('analysis', 100);
    }
}
// 前端分页切片：state={page,size,total}，items 为全量数组；返回当前页切片并回写 total。
function patchClientSlice(state, items) {
    const list = Array.isArray(items) ? items : [];
    state.total = list.length;
    const totalPages = patchPagerTotalPages(state);
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * state.size;
    return list.slice(start, start + state.size);
}
// 前端分页条状态（按 key 建 {page,size,total}，size 从 localStorage 恢复）
function patchClientPager(key, def = 10) {
    if (!patchState.clientPagers[key]) patchState.clientPagers[key] = { page: 1, size: patchPagerLoadSize(key, def), total: 0 };
    return patchState.clientPagers[key];
}
// 注册所有列表的分页条（进页时调一次）。服务端分页的直接用其分页状态对象；前端分页用 patchClientPager。
function patchInitListPagers() {
    // ── 服务端分页（接口带 page/size）──
    patchState.search.size = patchPagerLoadSize('search', 10);
    patchRegisterPager('search', patchState.search, () => loadPatches());
    patchState.mine.size = patchPagerLoadSize('mine', 10);
    patchRegisterPager('mine', patchState.mine, () => loadMyPatches());
    patchState.admin.analysisPager.size = patchPagerLoadSize('analysis', 20);
    patchRegisterPager('analysis', patchState.admin.analysisPager, () => loadAnalysisPatches());
    patchState.workflowHistory.size = patchPagerLoadSize('workflowHistory', 10);
    patchRegisterPager('workflowHistory', patchState.workflowHistory, () => loadWorkflowHistory());
    patchSessions.size = patchPagerLoadSize('sessions', 20);
    patchRegisterPager('sessions', patchSessions, () => loadRunSessions().catch(error => patchShowError(error.message, '会话存档加载失败')));
    patchState.projectEnv.size = patchPagerLoadSize('projectEnv', 10);
    patchRegisterPager('projectEnv', patchState.projectEnv, () => loadProjectEnvs());
    // ── 前端分页（数据全量在内存，切片渲染）──
    patchRegisterPager('nodeRuns', patchClientPager('nodeRuns', 10), () => patchNodeRenderRuns());
    patchRegisterPager('flow', patchClientPager('flow', 10), () => renderAdminFlowTable());
    patchRegisterPager('prompt', patchClientPager('prompt', 10), () => renderAdminPromptTable());
    patchRegisterPager('template', patchClientPager('template', 10), () => renderAdminTemplateTable());
    patchRegisterPager('product', patchClientPager('product', 10), () => renderProductTable());
    patchRegisterPager('directory', patchClientPager('directory', 10), () => renderDirectoryTable());
    patchRegisterPager('menuRole', patchClientPager('menuRole', 10), () => renderMenuRoleTable());
    patchRegisterPager('menuUser', patchClientPager('menuUser', 10), () => renderMenuUserTable());
    patchRegisterPager('adaptRuns', patchClientPager('adaptRuns', 10), () => loadAdaptRuns());
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

// 右上角「与补丁中心是否通」的状态。**由认证结果驱动**，不要只在列表加载时改：
//   - 登录成功 / /api/auth/me 校验成功 → 已连接（那一刻确实连通了）
//   - 退出登录 / 登录失效 → 未连接（以前没人改它，退出后还挂着"已连接"）
//   - /api/auth/me 网络失败 → 连接失败
// 列表加载（loadPatches）仍会按查询结果覆盖它，作为"数据能不能取到"的补充信号。
function patchSetApiStatus(state) {
    const el = document.getElementById('patchApiStatus');
    if (!el) return;
    if (state === 'online') { el.textContent = '已连接'; el.className = 'patch-api-status online'; }
    else if (state === 'error') { el.textContent = '连接失败'; el.className = 'patch-api-status error'; }
    else { el.textContent = '未连接'; el.className = 'patch-api-status'; }
}

function patchSetAuthenticated(user) {
    const login = document.getElementById('patchLoginCard');
    const layout = document.getElementById('patchAuthLayout');
    const userLabel = document.getElementById('patchCurrentUser');
    const logout = document.getElementById('patchLogout');
    const authenticated = Boolean(user);
    const isAdmin = authenticated && user.role === 'admin';
    // 认证结果一出就刷新连接状态：登录成功/校验成功=已连接，退出或失效=未连接。
    // 放在这里是为了不等 loadPatches（首次列表查询可能慢，以前要等它回来才变"已连接"）
    patchSetApiStatus(authenticated ? 'online' : 'offline');
    // 普通检索表：操作列宽度按角色定——普通用户 详情/下载/适配（3 个按钮 ≈ 102px），
    // 管理员多 编辑/删除（5 个按钮 ≈ 170px）。**宽度要含单元格左右内边距（各 18px）**，
    // 否则 fixed 布局 + td{overflow:hidden} 会把末尾的按钮裁掉。
    // 名称列（col0）留 auto 吸收富余宽度，操作列就停在自己配置的宽度上。
    // 角色不同用不同 storage key，避免同一浏览器切账号时列宽互相串。
    // key 从 v3 升到 v4：加了「适配」按钮后，旧存档会把操作列按旧宽度（180/110）锁死。
    initPatchColumnResize(
        '.patch-search-table',
        `cc-web-patch-col-widths-v4-${isAdmin ? 'admin' : 'user'}`,
        [280, 170, 96, 70, 90, 96, 160, isAdmin ? 216 : 150],
        isAdmin ? 216 : 150,
        0,
    );
    // 待分析补丁分页条：大档位仅管理员可选（登录后才知道角色，选项在这里刷新）
    patchSetAnalysisPagerSizes(isAdmin);
    // 左侧固定菜单仅在登录态展示（聊天页/未登录登录卡不展示）
    document.documentElement.classList.toggle('patch-auth', authenticated);
    document.documentElement.classList.remove('patch-auth-pending');
    const previousUserId = patchState.user?.id;
    const userChanged = previousUserId !== (user?.id ?? null);
    patchState.user = user || null;
    if (!authenticated || userChanged) resetWorkflowRunState();
    if (!authenticated) { patchState.workflowHistory = {page: 1, size: 10, total: 0, items: []}; patchState.workflowDetail = {runId: '', snapshot: null}; document.getElementById('workflowHistoryBody').innerHTML = '<tr><td colspan="6" class="patch-empty">暂无流程运行记录</td></tr>'; patchState.mine = {page: 1, size: 10, total: 0, items: [], generation: 0}; const mineBody = document.getElementById('patchMineBody'); if (mineBody) mineBody.innerHTML = '<tr><td colspan="7" class="patch-empty">请登录后查看</td></tr>'; patchState.products = null; patchState.admin.products = []; patchState.admin.productId = null; const productBody = document.getElementById('patchProductBody'); if (productBody) productBody.innerHTML = '<tr><td colspan="5" class="patch-empty">请登录后查看</td></tr>'; }
    if (login) login.hidden = authenticated;
    if (layout) layout.hidden = !authenticated;
    applyMenuVisibility(user, isAdmin);
    // 安全网：已登录但一个菜单都不可见时强制显示第一个菜单（智能开发），避免登录后只剩空白界面
    // （侧边栏同款兜底在 /sidenav.js 里）
    if (authenticated && !PATCH_MENU_KEYS.some(isTabVisible)) {
        const searchTab = document.querySelector(`.patch-tab[data-tab="${PATCH_MENU_KEYS[0]}"]`);
        if (searchTab) searchTab.hidden = false;
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
        patchState.admin.projectEnvs = [];
        patchState.admin.projectEnvId = null;
        const projectEnvBody = document.getElementById('patchProjectEnvBody');
        if (projectEnvBody) projectEnvBody.innerHTML = '<tr><td colspan="10" class="patch-empty">正在加载...</td></tr>';
        const projectEnvMessage = document.getElementById('patchProjectEnvMessage');
        if (projectEnvMessage) projectEnvMessage.textContent = '';
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
        patchState.mine = {page: 1, size: patchPagerLoadSize('mine', 10), total: 0, items: [], generation: 0};
        document.getElementById('patchMineBody').innerHTML = '<tr><td colspan="7" class="patch-empty">正在加载...</td></tr>';
        patchState.products = null;
        patchState.admin.products = [];
        patchState.admin.productId = null;
        const newProductBody = document.getElementById('patchProductBody');
        if (newProductBody) newProductBody.innerHTML = '<tr><td colspan="5" class="patch-empty">正在加载...</td></tr>';
        // 智能开发：换用户先掐掉流的 SSE（否则上一位用户的 token 拉的事件会继续往新界面里灌），
        // 再清空清单——本机清单是全机共享的，换用户后重进页签自己重拉。
        patchNodeCloseStream();
        patchState.node = { host: '', runs: [], current: null, es: null, streaming: false, pendingPrompt: null, liveTranscript: '', flushHandle: 0 };
        const nodeRunsBody = document.getElementById('patchNodeRunsBody');
        if (nodeRunsBody) nodeRunsBody.innerHTML = '<tr><td colspan="6" class="patch-empty">正在加载...</td></tr>';
        const nodeMessage = document.getElementById('patchNodeMessage');
        if (nodeMessage) nodeMessage.textContent = '';
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
    // 检查更新同样只在登录后显示：它要拿浏览器的 token 去问补丁中心，
    // 未登录时常显只会占着「退出」平时的位置，看起来像退出按钮丢了
    const updateCheck = document.getElementById('patchUpdateCheck');
    if (updateCheck) updateCheck.hidden = !authenticated;
    // 帮助文档同理：文档在补丁中心上，未登录拿不到
    const helpManual = document.getElementById('patchHelpManual');
    if (helpManual) helpManual.hidden = !authenticated;
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
            if (patchToken() === requestToken) patchHandleUnauthorized();
            throw new Error('登录已失效，请重新登录');
        }
        if (response.status === 403) throw new Error('权限不足');
        if (!response.ok || payload.code !== 0) throw new Error(payload.message || payload.detail || '请求失败');
        return payload.data;
    }
    throw new Error('无法连接服务器，请稍后重试或联系管理员');
}

// 产品/版本字典：[{id,name,sort_order,is_deleted,versions:[{id,version,is_deleted}]}]
// 下拉用：只含未逻辑删除的产品与版本，结果可进共享缓存 patchState.products
async function fetchProducts() {
    return await patchRequest('/api/products');
}

// 产品版本管理页用：含已逻辑删除的行（仅管理员可调），结果只能进 patchState.admin.products，
// 绝不能写进共享缓存，否则已删除的产品会漏进补丁上传/编辑和产品环境变量的下拉。
async function fetchAllProducts() {
    return await patchRequest('/api/products?include_deleted=1');
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
        await Promise.all([loadPatches(), loadWorkflowTemplates()]);
    } catch (error) {
        message.textContent = '';
        // 登录失败要弹窗；先把可能的"会话失效"标记清掉，否则 patchShowError 会被 authInvalidated 吞掉
        patchState.authInvalidated = false;
        const raw = String(error.message || '');
        const text = /invalid username or password/i.test(raw) ? '用户名或密码错误' : (raw || '登录失败，请稍后重试');
        patchShowError(text, '登录失败');
    }
}

async function patchRestoreAuth() {
    if (!patchToken()) { patchSetAuthenticated(null); return false; }
    try { patchSetAuthenticated(await patchRequest('/api/auth/me')); return true; }
    catch (error) {
        // 只有服务端明确返回 401（patchRequest 已置 authInvalidated 并清掉 token）才算登录失效；
        // 网络不通/超时等临时故障保留 token，停在 pending 提示上让用户重试，避免刷新时被误踢回登录页。
        if (patchState.authInvalidated) { patchHandleUnauthorized(); return false; }
        patchSetApiStatus('error');   // 连不上：状态别停在"已连接"
        patchShowAuthRetry(error.message);
        return false;
    }
}

function patchShowAuthRetry(message) {
    const text = document.getElementById('patchAuthLoadingText');
    const retry = document.getElementById('patchAuthRetry');
    if (text) text.textContent = message || '无法连接服务器，请稍后重试或联系管理员';
    if (retry) retry.hidden = false;
}

/* ── 获取新版本（cc-web 的 api/update.rs + patch_search 的 routes/ccweb_update.py）──
   - 判据是 **版本号**（本机 ≠ 服务器上的「最新版本号」）：本机版本号来自编译期 Cargo.toml，
     sha256 只用于下载完整性校验，不参与"要不要更新"的判断
   - 由后端代劳是因为 **cc-web 自己没有登录态**（token 只在浏览器里），前端带 token 调过去
   - 替换程序：Windows 靠后端生成的 .bat（运行中的 exe 被锁，自己覆盖不了自己）；
     macOS 由后端原地 rename 覆盖（Unix 没这个锁），再由 start.sh 的循环重启 */
const patchUpdateState = { checked: false, local: null, remote: null, available: false, dismissed: false, running: false };

async function patchUpdateCheck(manual = false) {
    if (!patchToken() || patchState.authInvalidated) {
        if (manual) patchShowError('请先登录后再检查更新', '检查更新');
        return;
    }
    try {
        const payload = await patchNodeCcWeb('/api/update/check', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ server_url: patchServerBase(), auth_token: patchToken() }),
        });
        const data = payload.data || {};
        patchUpdateState.local = data.local || null;
        patchUpdateState.remote = data.remote || null;
        patchUpdateState.available = Boolean(data.update_available);
        // 手动点「检查更新」= 用户主动要结果，先清掉"忽略"：
        // 忽略只该管"本次会话里别自动弹横幅"，不该让手动检查也报"已是最新"
        // （之前就是这里没清，点过忽略之后再查会误报"本机版本 x 已是最新"）
        if (manual) patchUpdateState.dismissed = false;
        patchUpdateRender(manual);
    } catch (error) {
        if (manual) patchShowError(error.message, '检查更新失败');
    }
}

// 三个平台槽位：与 patch_search 的发布目录、CI 的三个产物一一对应。
// 定义在使用点之前 —— 之前吃过"函数里引用了后面才定义的 const"的亏（登录后抛 ReferenceError）
const RELEASE_PLATFORMS = [
    {key: 'windows', label: 'Windows', field: 'windows'},
    {key: 'macos-arm64', label: 'macOS (Apple Silicon)', field: 'macos_arm64'},
    {key: 'macos-x64', label: 'macOS (Intel)', field: 'macos_x64'},
];

// 平台键 → 给人看的名字（平台键由 cc-web 在编译期决定，见 api/update.rs）
function patchPlatformLabel(key) {
    const found = RELEASE_PLATFORMS.find(item => item.key === key);
    if (found) return found.label;
    return key ? key : '未知平台';
}

function patchUpdateRender(manual) {
    const banner = document.getElementById('patchUpdateBanner');
    if (!banner) return;
    const remote = patchUpdateState.remote;
    const local = patchUpdateState.local || {};
    const mine = local.version || '';
    const platform = patchPlatformLabel(local.platform);
    const when = remote && remote.build_unix ? patchFormatDateTime(new Date(Number(remote.build_unix) * 1000)) : '';
    const applyBtn = document.getElementById('patchUpdateApply');

    // 没有可更新版本：横幅收起；只有"手动检查"才给一条明确答复
    if (!patchUpdateState.available) {
        banner.hidden = true;
        if (applyBtn) applyBtn.hidden = true;
        if (!manual) return;
        if (!remote) {
            patchShowError('补丁中心还没有发布 cc-web 新版本。', '检查更新');
        } else if (remote.has_package === false) {
            // 服务器上可能只发布了别的平台：把本机平台说出来，用户不用猜
            patchShowError(`最新版本 ${remote.version} 暂无 ${platform} 的安装包，请联系管理员。`, '检查更新');
        } else {
            patchShowError(`本机版本 ${mine} 与服务器上的 ${remote.version} 一致，已是最新。`, '检查更新');
        }
        return;
    }

    // 有新版：横幅只在"没被忽略"或"手动检查"时显示
    // （忽略只针对本次会话的自动提示；手动点检查 = 主动要结果，必须显示）
    if (patchUpdateState.dismissed && !manual) {
        banner.hidden = true;
        return;
    }
    const text = `发现新版本 ${remote.version || ''}（${platform}${when ? `，构建 ${when}` : ''}），本机当前 ${mine}。`;
    document.getElementById('patchUpdateText').textContent = text;
    if (applyBtn) applyBtn.hidden = false;
    banner.hidden = false;
    if (manual) patchShowError(`${text} 点横幅上的「立即更新」即可。`, '检查更新');
}

// 下载新版本并自替换：读后端流式响应（progress/ok/error），完成后本进程会退出、脚本接手重启
async function patchUpdateApply() {
    if (patchUpdateState.running) return;
    patchUpdateState.running = true;
    const modal = document.getElementById('patchUpdateModal');
    const message = document.getElementById('patchUpdateMessage');
    const progress = document.getElementById('patchUpdateProgress');
    const bar = progress.querySelector('span');
    const label = progress.querySelector('em');
    const okBtn = document.getElementById('patchUpdateModalOk');
    message.textContent = '正在下载新版本…';
    progress.style.display = 'flex';
    bar.style.width = '0%';
    label.textContent = '';
    okBtn.hidden = true;
    modal.hidden = false;
    try {
        const response = await fetch('/api/update/apply', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ server_url: patchServerBase(), auth_token: patchToken() }),
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `更新失败（HTTP ${response.status}）`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let failure = '';
        let done = '';
        while (true) {
            const {done: finished, value} = await reader.read();
            if (finished) break;
            buffer += decoder.decode(value, {stream: true});
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                if (line.startsWith('progress ')) {
                    const [, downloaded, total] = line.split(' ');
                    const got = Number(downloaded) || 0;
                    const all = Number(total) || 0;
                    const percent = all > 0 ? Math.min(100, Math.round(got / all * 100)) : 0;
                    bar.style.width = `${percent}%`;
                    label.textContent = all > 0 ? `${patchFormatSize(got)} / ${patchFormatSize(all)}（${percent}%）` : patchFormatSize(got);
                } else if (line.startsWith('ok ')) {
                    try { done = JSON.parse(line.slice(3)); } catch (error) { done = { message: '更新完成' }; }
                } else if (line.startsWith('error ')) {
                    failure = line.slice(6);
                }
            }
        }
        if (failure) throw new Error(failure);
        bar.style.width = '100%';
        const result = done && typeof done === 'object' ? done : {};
        if (result.replaced && !result.restarted) {
            // macOS 且不是 start.sh 拉起的：程序已经换成新版，但**不自动重启**
            // （主动重启会把进程从终端剥离，以后 Ctrl+C 停不掉，见 api/update.rs）。
            // 文件已经是新的了，用户重启一下就生效。
            message.textContent = `${result.message || '新版本已就位'}。`
                + ' 在运行 cc-web 的那个终端里按 Ctrl+C 停掉，再执行 ./start.sh 就是新版本了。';
        } else if (result.replaced) {
            // macOS + start.sh：后端换完文件就退出，start.sh 的 while 循环立刻用新程序重启
            message.textContent = `${result.message || '更新完成'}。稍后请刷新页面（cc-web 正在重启，连接会断开几秒）。`;
        } else {
            // Windows：后端退出后由 update-cc-web.bat 替换并重启
            message.textContent = `${result.message || '更新完成'}。稍后请刷新页面（cc-web 正在重启，连接会断开几秒）。`
                + ' 若 10 秒后仍打不开，看 cc-web 所在目录里的 update-cc-web.log（记着脚本走到哪一步了）。';
        }
        document.getElementById('patchUpdateBanner').hidden = true;
        okBtn.hidden = false;
    } catch (error) {
        message.textContent = `更新失败：${error.message}`;
        okBtn.hidden = false;
    } finally {
        patchUpdateState.running = false;
    }
}

/* ── 帮助文档：下载补丁中心上的 userManual.docx（见 patch_search 的 routes/ccweb_update.py）──
   为什么走 fetch + blob 而不是直接 <a href>：要带 Bearer token，而且要多地址回退
   （与补丁下载同一套：每个请求取一个起始地址，连不上/超时就换下一条）。
   进度弹窗直接复用补丁下载那个 —— 文档有几 MB，不给进度条的话点了像没反应。 */
async function patchHelpDownload() {
    const button = document.getElementById('patchHelpManual');
    const servers = patchState.patchSearchServers;
    if (!patchToken()) { patchShowError('请先登录后再下载帮助文档', '帮助文档'); return; }
    if (!servers.length) { patchShowError('补丁服务地址尚未加载，请稍候重试。', '帮助文档'); return; }

    const modal = document.getElementById('patchDownloadModal');
    const closeBtn = document.getElementById('patchDownloadClose');
    const cancelBtn = document.getElementById('patchDownloadCancel');
    const urlEl = document.getElementById('patchDownloadUrl');
    const fileEl = document.getElementById('patchDownloadFile');
    const bar = document.getElementById('patchDownloadBar');
    const percentEl = document.getElementById('patchDownloadPercent');
    const sizeEl = document.getElementById('patchDownloadSize');

    // 先弹进度，再探测地址开始下载（弹窗是共用的，标题按当前任务改）
    document.getElementById('patchDownloadTitle').textContent = '下载帮助文档';
    urlEl.textContent = '正在检测可用地址…';
    fileEl.textContent = 'userManual.docx';
    bar.style.width = '0%'; percentEl.textContent = '0%'; sizeEl.textContent = '正在连接...';
    cancelBtn.textContent = '取消';
    modal.hidden = false;

    const controller = new AbortController();
    const close = () => { controller.abort(); modal.hidden = true; };
    cancelBtn.onclick = close;
    closeBtn.onclick = close;
    modal.onclick = event => { if (event.target === modal) close(); };

    if (button) button.disabled = true;
    try {
        const start = patchState.patchServerCursor % servers.length;
        patchState.patchServerCursor = start + 1;
        let response = null;
        for (let attempt = 0; attempt < servers.length; attempt += 1) {
            const base = servers[(start + attempt) % servers.length].replace(/\/+$/, '');
            urlEl.textContent = `${base}/api/ccweb/manual`;
            try {
                response = await patchFetchTimeout(`${base}/api/ccweb/manual`,
                    {headers: {Authorization: `Bearer ${patchToken()}`}, signal: controller.signal}, PATCH_REQUEST_TIMEOUT);
            } catch (error) {
                if (controller.signal.aborted) throw error;   // 用户取消，不切换地址
                response = null;
                continue;                                     // 连不上/超时：换下一条
            }
            break;
        }
        if (!response) throw new Error('无法连接补丁中心，请稍后重试或联系管理员');
        if (response.status === 401) { patchHandleUnauthorized(); throw new Error('请先登录'); }
        if (response.status === 404) {
            // 后端 404 的 detail 是写给用户看的一句话（"服务器上还没有帮助文档…"），直接用
            let detail = '';
            try { detail = (await response.json()).detail || ''; } catch (error) { detail = ''; }
            throw new Error(detail || '服务器上还没有帮助文档（userManual.docx），请联系管理员');
        }
        if (!response.ok) throw new Error(`下载帮助文档失败（HTTP ${response.status}）`);

        // 边下边报进度：这是本页最容易让人以为"点了没反应"的地方
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
                const percent = Math.min(100, Math.round(received / total * 100));
                bar.style.width = `${percent}%`; percentEl.textContent = `${percent}%`;
                sizeEl.textContent = `${patchFormatSize(received)} / ${patchFormatSize(total)}`;
            } else {
                percentEl.textContent = patchFormatSize(received);
            }
        }

        // 优先用响应 Content-Disposition 里的文件名；拿不到就退回默认名
        let filename = '';
        const disposition = response.headers.get('Content-Disposition') || '';
        const starMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (starMatch) filename = decodeURIComponent(starMatch[1]);
        else {
            const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
            if (plainMatch) filename = plainMatch[1];
        }
        if (!filename) filename = 'userManual.docx';

        // 与补丁下载同款：显式 octet-stream，避免浏览器/扩展按 MIME 做别的处理
        const blob = new Blob(chunks, {type: 'application/octet-stream'});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // 立刻 revoke 会让部分浏览器拿到空文件，留一秒再释放
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);

        fileEl.textContent = filename;
        bar.style.width = '100%'; percentEl.textContent = '100%';
        sizeEl.textContent = `${patchFormatSize(received)} · 下载完成`;
        cancelBtn.textContent = '关闭';
        cancelBtn.onclick = () => { modal.hidden = true; };
        closeBtn.onclick = () => { modal.hidden = true; };
        modal.onclick = event => { if (event.target === modal) modal.hidden = true; };
    } catch (error) {
        if (error.name === 'AbortError') return;
        modal.hidden = true;
        patchShowError(error.message, '帮助文档');
    } finally {
        if (button) button.disabled = false;
    }
}

/* ── 版本发布（管理员）：把各平台的 cc-web 新程序上传到补丁中心 ──
   见 patch_search 的 routes/ccweb_update.py：**服务器自己写进发布目录**，
   所以只要"浏览器能打开本页"就能发版，不需要 U 盘 / 共享盘 / 本地工具。
   只更新选了文件的平台（可以今天只发 Windows，明天补 macOS）。 */
// 拉全部已发布版本渲染表格（每个版本一行，标出各平台有无与是否最新）
async function loadReleaseInfo() {
    const body = document.getElementById('patchReleaseBody');
    const versionEl = document.getElementById('patchReleaseVersion');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="7" class="patch-empty">正在加载...</td></tr>';
    try {
        const rows = (await patchRequest('/api/ccweb/versions')) || [];
        if (versionEl) {
            const latest = rows.find(item => item.is_latest);
            versionEl.textContent = latest
                ? `当前最新版本：${latest.version}（发布于 ${patchFormatDateTime(latest.published_at)}）`
                : '还没有发布过任何版本，或未设置最新版本。';
        }
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="7" class="patch-empty">还没有发布过任何版本</td></tr>';
            return;
        }
        body.innerHTML = rows.map(item => {
            const has = key => Boolean((item.platforms || {})[key]);
            const mark = key => has(key) ? '✓' : '—';
            const notes = item.notes
                ? `<span class="patch-truncated-name" title="${patchEscape(item.notes)}">${patchEscape(patchNodeInline(item.notes, 24))}</span>`
                : '—';
            const latestTag = item.is_latest
                ? '<span class="patch-release-latest">最新</span>'
                : `<button class="patch-link-btn" data-release-set-latest="${patchEscape(item.version)}">设为最新</button>`;
            return `<tr><td><b>${patchEscape(item.version)}</b></td>` +
                `<td>${mark('windows')}</td><td>${mark('macos-arm64')}</td><td>${mark('macos-x64')}</td>` +
                `<td>${notes}</td><td>${patchEscape(patchFormatDateTime(item.published_at))}</td>` +
                `<td>${latestTag}</td></tr>`;
        }).join('');
    } catch (error) {
        body.innerHTML = `<tr><td colspan="7" class="patch-empty">加载失败：${patchEscape(error.message)}</td></tr>`;
        if (versionEl) versionEl.textContent = '';
    }
}

// 把某个已发布版本设为最新（提升或回滚都走这里）
async function setReleaseLatest(version) {
    const ok = await patchConfirm(
        `把版本 ${version} 设为最新？\n\n所有版本号不是 ${version} 的开发机都会提示有新版本；缺平台的机器会提示"暂无本平台安装包"。`,
        '设为最新版本',
    );
    if (!ok) return;
    try {
        await patchRequest('/api/ccweb/latest', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({version}),
        });
        const pageMessage = document.getElementById('patchReleaseMessage');
        if (pageMessage) {
            pageMessage.classList.remove('error');
            pageMessage.textContent = `已把 ${version} 设为最新版本。`;
        }
        loadReleaseInfo();
    } catch (error) {
        patchShowError(error.message, '设置失败');
    }
}

// 打开/关闭发布弹窗（表单在弹窗里，见 patches.html 的 #patchReleaseModal）
function openReleaseModal() {
    const modal = document.getElementById('patchReleaseModal');
    const form = document.getElementById('patchReleaseForm');
    if (!modal || !form) return;
    form.reset();
    RELEASE_PLATFORMS.forEach(item => {
        const note = document.querySelector(`[data-release-note="${item.field}"]`);
        if (note) note.textContent = '未选择';
    });
    document.getElementById('patchReleaseModalMessage').textContent = '';
    document.getElementById('patchReleaseProgress').style.display = 'none';
    modal.hidden = false;
}

function closeReleaseModal() {
    const modal = document.getElementById('patchReleaseModal');
    if (modal) modal.hidden = true;
}

function submitRelease() {
    const form = document.getElementById('patchReleaseForm');
    const message = document.getElementById('patchReleaseModalMessage');
    const progress = document.getElementById('patchReleaseProgress');
    const submit = document.getElementById('patchReleaseSubmit');
    if (!form || !message || !progress || !submit) return;
    const bar = progress.querySelector('span');
    const label = progress.querySelector('em');

    // 版本号可以留空：服务器会沿用该平台上次的版本号（都没有才按时间生成）
    const version = String(form.elements.version.value || '').trim();
    const picked = RELEASE_PLATFORMS
        .map(item => ({...item, file: (form.elements[item.field].files || [])[0]}))
        .filter(item => item.file);
    if (!picked.length) { patchShowError('至少要选一个平台的可执行文件', '版本发布'); return; }

    const servers = patchState.patchSearchServers;
    const token = patchToken();
    if (!servers.length || !token) { patchShowError('补丁中心地址或登录凭据缺失，请刷新页面重试', '版本发布'); return; }

    const formData = new FormData();
    formData.append('version', version);
    formData.append('notes', String(form.elements.notes.value || '').trim());
    formData.append('set_latest', form.elements.set_latest && form.elements.set_latest.checked ? '1' : '0');
    picked.forEach(item => {
        formData.append(item.field, item.file, item.file.name);
        // 浏览器知道文件的修改时间（≈构建时间），比服务器收到的时间更准
        formData.append(`${item.field}_build_unix`, String(Math.floor((item.file.lastModified || Date.now()) / 1000)));
    });

    const start = patchState.patchServerCursor % servers.length;
    patchState.patchServerCursor = start + 1;
    submit.disabled = true;
    message.classList.remove('error');
    message.textContent = `正在上传 ${picked.length} 个文件…`;
    progress.style.display = 'flex';
    bar.style.width = '0%';
    label.textContent = '';

    const finish = (text, failed) => {
        message.textContent = text;
        message.classList.toggle('error', Boolean(failed));
        progress.style.display = 'none';
        submit.disabled = false;
    };
    // 多地址回退：连不上/超时才换下一条；拿到 HTTP 响应就以它为准（与补丁上传同口径）
    const attempt = (at) => {
        if (at >= servers.length) { finish('发布失败：所有服务地址都无法连接', true); return; }
        const base = servers[(start + at) % servers.length].replace(/\/+$/, '');
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${base}/api/ccweb/publish`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.timeout = 1800000;
        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return;
            const percent = Math.round(event.loaded / event.total * 100);
            bar.style.width = `${percent}%`;
            label.textContent = `上传中 ${percent}%`;
        };
        xhr.onload = () => {
            let payload = {};
            try { payload = JSON.parse(xhr.responseText); } catch (error) { payload = {}; }
            if (xhr.status === 401) { patchHandleUnauthorized(); finish('登录已失效，请重新登录', true); return; }
            if (xhr.status >= 200 && xhr.status < 300 && payload.code === 0) {
                const data = payload.data || {};
                const labels = picked.map(item => item.label).join('、');
                closeReleaseModal();
                const pageMessage = document.getElementById('patchReleaseMessage');
                if (pageMessage) {
                    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
                    pageMessage.classList.toggle('error', warnings.length > 0);
                    pageMessage.textContent = warnings.length
                        ? `已发布 ${version}（${labels}），但有需要注意的地方： ${warnings.join(' ')}`
                        : `发布完成：版本 ${data.version || version}（${labels}）${data.is_latest ? '，已设为最新版本' : ''}。开发机下次「检查更新」即可看到。`;
                }
                loadReleaseInfo();
                return;
            }
            finish(`发布失败：${payload.detail || payload.message || `HTTP ${xhr.status}`}`, true);
        };
        xhr.onerror = () => attempt(at + 1);
        xhr.ontimeout = () => attempt(at + 1);
        xhr.send(formData);
    };
    attempt(0);
}

async function loadPatches() {
    if (!patchToken() || patchState.authInvalidated) return;
    const generation = ++patchState.searchGeneration;
    const body = document.getElementById('patchTableBody');
    const searchButton = document.getElementById('patchSearchBtn');
    body.setAttribute('aria-busy', 'true');
    searchButton.disabled = true;
    body.innerHTML = '<tr><td colspan="8" class="patch-empty">正在加载...</td></tr>';
    try {
        const params = new URLSearchParams({ keyword: patchState.keyword, name: patchState.advanced.name, product_name: patchState.advanced.product, product_version: patchState.advanced.version, user_keyword: patchState.advanced.keyword, description: patchState.advanced.description, page: patchState.search.page, size: patchState.search.size });
        if (patchState.searchStatus !== '') params.set('status', patchState.searchStatus);
        const data = await patchRequest(`/api/patches?${params}`);
        if (generation !== patchState.searchGeneration) return;
        patchState.searchItems = data.items || [];
        patchState.search.page = data.page;
        patchState.search.size = data.size;
        patchState.search.total = data.total;
        document.getElementById('patchTotal').textContent = `共 ${data.total} 个`;
        patchRenderPager('search');
        body.innerHTML = data.items.length ? data.items.map(patchRow).join('') : '<tr><td colspan="8" class="patch-empty">暂无补丁</td></tr>';
        patchSetApiStatus('online');
    } catch (error) {
        if (generation !== patchState.searchGeneration) return;
        body.innerHTML = '<tr><td colspan="8" class="patch-empty">加载失败，请重试</td></tr>';
        if (!patchState.authInvalidated) patchShowError(error.message, '补丁列表加载失败');
        patchSetApiStatus('error');
    } finally {
        if (generation === patchState.searchGeneration) { body.setAttribute('aria-busy', 'false'); searchButton.disabled = false; }
    }
}

function patchRow(item) {
    let actions = `<button class="patch-link-btn" data-detail-id="${patchEscape(item.id)}">详情</button><button class="patch-link-btn" data-download-id="${patchEscape(item.id)}" data-download-name="${patchEscape(item.file_name || '')}">下载</button>`;
    // 「适配」：把库里这个补丁直接适配进客开工程（补丁包由 cc-web 从补丁中心取到本机）。
    // 与页签可见性一致——用户看不到「补丁适配」页签时，这里也不给入口。
    if (isTabVisible('adapt')) actions += `<button class="patch-link-btn" data-adapt-id="${patchEscape(item.id)}">适配</button>`;
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
        <td><span class="patch-status analysis-${Number(item.status)}">${patchEscape(analysisStatusLabel(item.status))}</span></td>
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
    patchState.search.page = 1;
    loadPatches();
}

function applyAdvancedSearch() {
    patchState.advanced.name = document.getElementById('patchAdvName').value.trim();
    patchState.advanced.product = document.getElementById('patchAdvProduct').value.trim();
    patchState.advanced.version = document.getElementById('patchAdvVersion').value.trim();
    patchState.advanced.keyword = document.getElementById('patchAdvKeyword').value.trim();
    patchState.advanced.description = document.getElementById('patchAdvDescription').value.trim();
    patchState.search.page = 1;
    loadPatches();
}

function resetAdvancedSearch() {
    document.getElementById('patchAdvName').value = '';
    document.getElementById('patchAdvProduct').value = '';
    document.getElementById('patchAdvVersion').value = '';
    document.getElementById('patchAdvKeyword').value = '';
    document.getElementById('patchAdvDescription').value = '';
    patchState.advanced = { name: '', product: '', version: '', keyword: '', description: '' };
    patchState.search.page = 1;
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
        patchState.mine.page = data.page;
        patchState.mine.size = data.size;
        patchState.mine.items = data.items || [];
        document.getElementById('patchMineTotal').textContent = `共 ${data.total} 个`;
        patchRenderPager('mine');
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
function initPatchColumnResize(selector, storageKey, defaults, actionMin = 48, freeColumn = -1) {
    const table = document.querySelector(selector);
    if (!table) return;
    const headers = Array.from(table.querySelectorAll('thead th'));
    if (headers.length < 2) return;
    // 允许重复调用（登录拿到角色后按新宽度重排）：先清掉上一次挂的拖拽把手，避免叠加
    table.querySelectorAll('thead th .patch-resizer').forEach(el => el.remove());
    const minWidth = (i) => (i === headers.length - 1 ? actionMin : 48);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}
    headers.forEach((th, i) => {
        const width = Math.max(Number(saved[`col${i}`]) || defaults[i] || 100, minWidth(i));
        // freeColumn 这一列保持 auto：fixed 布局下「表格宽度 - 其它列之和」的余量全给 auto 列，
        // 其余列（尤其操作列）就不会被多余宽度摊宽，能停在配置的宽度上。
        th.style.width = i === freeColumn ? 'auto' : `${width}px`;
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

// 适配弹窗的环境变量下拉（选择后自动带出该环境的客开工程目录）
// preset（可选）：{product_name, product_version} —— 从普通检索点「适配」时，
// 按该补丁的产品/版本自动选中对应环境变量，并把客开工程目录一并带出来。
async function loadProjectEnvsForAdapt(preset) {
    const select = document.getElementById('patchAdaptEnv');
    if (!select) return;
    if (!(patchState.admin.projectEnvs || []).length) {
        try { patchState.admin.projectEnvs = (await patchRequest('/api/project-envs')) || []; } catch (error) { /* 读不到就留空 */ }
    }
    const current = select.value;
    select.innerHTML = '<option value="">请选择</option>' + (patchState.admin.projectEnvs || []).map(env =>
        `<option value="${patchEscape(env.id)}">${patchEscape(env.project_name || '')}（${patchEscape(env.product_name || '')} ${patchEscape(env.product_version || '')}）</option>`).join('');
    select.value = current;
    if (!preset) return;
    const match = (patchState.admin.projectEnvs || []).find(env =>
        String(env.product_name || '') === String(preset.product_name || '')
        && String(env.product_version || '') === String(preset.product_version || ''));
    if (!match) return;   // 没有匹配的环境变量就留空，让用户自己选
    select.value = String(match.id);
    document.getElementById('patchAdaptProjectDir').value = match.code_directory || '';
}

// ── 补丁适配：条目来自两个地方，但后续完全一样 ──
//   {file}                     本地选/拖进来的补丁包 → 走 /api/adapt/upload（multipart）
//   {patch_id, name, size}     补丁库里已有的补丁（普通检索列表点「适配」）→ 走 /api/adapt/import
// 卡片只用 {name, size} 渲染，所以两条路径共用同一个弹窗、同一套校验与启动流程。
function normalizeAdaptEntries(input) {
    return Array.from(input).map(item => item instanceof File
        ? {file: item, name: item.name, size: item.size}
        : {patch_id: item.patch_id, name: item.name || '', size: item.size || 0});
}

function showAdaptModal(entries, preset) {
    patchState.adaptEntries = normalizeAdaptEntries(entries);
    document.getElementById('patchAdaptItems').innerHTML = patchState.adaptEntries.map((entry, index) => `<div class="patch-upload-item" data-adapt-index="${index}">
        <div class="patch-file-meta"><strong>${patchEscape(entry.name)}</strong><span>${patchFormatSize(entry.size)}</span></div>
        <label class="patch-file-description-label">问题描述<span class="patch-required">*</span><textarea class="patch-adapt-desc" rows="3" placeholder="描述该补丁要解决的问题/需求"></textarea></label>
    </div>`).join('');
    document.getElementById('patchAdaptProjectDir').value = '';
    document.getElementById('patchAdaptModalMessage').textContent = patchState.adaptEntries.some(entry => entry.patch_id)
        ? '补丁包将在开始适配时从补丁中心取到本机。'
        : '';
    loadProjectEnvsForAdapt(preset).catch(() => {});
    document.getElementById('patchAdaptModal').hidden = false;
}

function closeAdaptModal() {
    document.getElementById('patchAdaptModal').hidden = true;
    patchState.adaptEntries = [];
    document.getElementById('patchAdaptItems').innerHTML = '';
    document.getElementById('patchAdaptModalMessage').textContent = '';
}

// 普通检索列表点「适配」：补丁已经在补丁库里，本机没有文件 —— 以「来自补丁中心」的条目打开弹窗，
// 并按该行的产品/版本预选环境变量（顺带带出客开工程目录）
function openAdaptFromSearch(patchId) {
    const item = patchState.searchItems.find(value => String(value.id) === String(patchId));
    if (!item) { patchShowError('找不到该补丁，请刷新列表后重试', '补丁适配'); return; }
    showAdaptModal(
        [{patch_id: item.id, name: item.file_name || item.name || '', size: item.file_size || 0}],
        {product_name: item.product_name, product_version: item.product_version},
    );
}

// 让 cc-web 从补丁中心把补丁包取到本机并解压（下载与解压都在 cc-web 侧，不经过浏览器内存）。
//
// cc-web 用**一行一条的流式响应**回报进度（见 adapt.rs 的 import_patch），所以这里读流而不是等 JSON：
//   progress <已下载> <总字节>   → 更新进度条
//   extracting                  → 下载完，正在解压
//   ok <结果 JSON>               → 成功，结果与 /api/adapt/upload 同形
//   error <原因>                 → 失败（下载/解压的失败只能走这里，HTTP 状态早就是 200）
async function patchAdaptImport(patchId, patchName, runId, seq) {
    const progressEl = document.getElementById('patchAdaptProgress');
    const barEl = progressEl ? progressEl.querySelector('span') : null;
    const labelEl = progressEl ? progressEl.querySelector('em') : null;
    const showProgress = (downloaded, total) => {
        if (!progressEl) return;
        progressEl.style.display = 'flex';
        const percent = total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : 0;
        barEl.style.width = `${percent}%`;
        labelEl.textContent = total > 0
            ? `正在从补丁中心下载补丁包… ${patchFormatSize(downloaded)} / ${patchFormatSize(total)}（${percent}%）`
            : `正在从补丁中心下载补丁包… ${patchFormatSize(downloaded)}`;
    };
    const hideProgress = () => {
        if (!progressEl) return;
        progressEl.style.display = 'none';
        barEl.style.width = '0%';
        labelEl.textContent = '';
    };

    try {
        const response = await fetch('/api/adapt/import', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                run_id: runId, seq, patch_id: patchId, patch_name: patchName || null,
                server_url: patchServerBase(), auth_token: patchToken(),
            }),
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `取补丁包失败（HTTP ${response.status}）`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;
        let failure = '';
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                if (line.startsWith('progress ')) {
                    const [, downloaded, total] = line.split(' ');
                    showProgress(Number(downloaded) || 0, Number(total) || 0);
                } else if (line === 'extracting') {
                    if (progressEl) { progressEl.style.display = 'flex'; barEl.style.width = '100%'; labelEl.textContent = '下载完成，正在解压补丁包…'; }
                } else if (line.startsWith('ok ')) {
                    try { result = JSON.parse(line.slice(3)); } catch (error) { failure = '补丁包信息解析失败'; }
                } else if (line.startsWith('error ')) {
                    failure = line.slice(6);
                }
            }
        }
        if (failure) throw new Error(failure);
        if (!result) throw new Error('取补丁包失败：连接中断');
        return result;
    } finally {
        hideProgress();
    }
}

// 收集并校验表单：每个补丁的问题描述 + 客开工程目录都是必填，缺一个就报错并聚焦
function collectAdaptForm() {
    const items = Array.from(document.querySelectorAll('#patchAdaptItems .patch-upload-item'));
    const entries = items.map((item, index) => {
        const entry = patchState.adaptEntries[index] || {};
        return {
            file: entry.file || null,
            patch_id: entry.patch_id || null,
            patch_name: entry.name || '',
            problem_desc: String(item.querySelector('.patch-adapt-desc')?.value || '').trim(),
        };
    });
    const missingIndex = entries.findIndex(entry => !entry.problem_desc);
    if (missingIndex >= 0) {
        patchShowError(`第 ${missingIndex + 1} 个补丁的问题描述为必填项`, '补丁适配');
        items[missingIndex].querySelector('.patch-adapt-desc').focus();
        return null;
    }
    const projectDir = String(document.getElementById('patchAdaptProjectDir').value || '').trim();
    if (!projectDir) {
        patchShowError('客开工程目录为必填项', '补丁适配');
        document.getElementById('patchAdaptProjectDir').focus();
        return null;
    }
    const envId = String(document.getElementById('patchAdaptEnv')?.value || '');
    return { entries, project_dir: projectDir, env_id: envId };
}

function startAdapt() {
    const payload = collectAdaptForm();
    if (!payload) return;
    adaptPatches(payload);
}

// ── 补丁适配：执行（在用户端 cc-web 跑 claude，把补丁合并进客开工程）──
// 把补丁包上传到 cc-web（存 temp\adapt\<runId>\<seq>\ 并解压），返回 {success, dir, entries}
async function patchAdaptUpload(file, runId, seq) {
    const form = new FormData();
    form.append('file', file, file.name);
    const response = await fetch(`/api/adapt/upload?run_id=${encodeURIComponent(runId)}&seq=${seq}`, {method: 'POST', body: form});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `上传失败（HTTP ${response.status}）`);
    return payload;
}

// 给共用会话发一条消息，等本轮结束（result/error），返回 {ok, text|error}
async function adaptPatches(payload) {
    const message = document.getElementById('patchAdaptModalMessage');
    const startBtn = document.getElementById('patchAdaptStart');
    message.textContent = '';
    // 1) git 检查：适配是「直接改工程、无法自动恢复」，据结果给不同确认文案
    let git = { is_git: false, has_changes: false };
    try { git = await patchNodeCcWeb(`/api/adapt/git-status?path=${encodeURIComponent(payload.project_dir)}`); } catch (error) { git = { is_git: false, has_changes: false, reason: error.message }; }
    const confirmText = git.is_git
        ? `适配将【直接修改】客开工程目录：\n${payload.project_dir}\n\n该工程已使用 git 版本控制${git.has_changes ? '，且当前有未提交的改动（建议先提交一次再适配）' : ''}。\n\n适配后无法自动恢复，确认开始？`
        : `⚠ 该目录下未检测到 .git（无版本控制）：\n${payload.project_dir}\n\n适配会直接修改源码且【无法自动恢复】。强烈建议先初始化并提交 git 再适配。\n\n仍要继续吗？`;
    if (!(await patchConfirm(confirmText, '开始适配'))) return;
    startBtn.disabled = true;
    try {
        // 2) 逐个把补丁包弄到本机（存 temp\adapt\<runId>\<seq>\ 并解压）：
        //    本地文件走上传，来自补丁库的走 /api/adapt/import（cc-web 直连补丁中心下载）
        const runId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
        const items = [];
        for (let index = 0; index < payload.entries.length; index++) {
            const entry = payload.entries[index];
            const progress = `${index + 1}/${payload.entries.length}`;
            message.textContent = entry.file
                ? `正在上传补丁 ${progress}：${entry.file.name}`
                : `正在从补丁中心取补丁包 ${progress}：${entry.patch_name}`;
            const got = entry.file
                ? await patchAdaptUpload(entry.file, runId, index + 1)
                : await patchAdaptImport(entry.patch_id, entry.patch_name, runId, index + 1);
            items.push({ seq: index + 1, patch_name: got.name || entry.patch_name || (entry.file ? entry.file.name : ''), problem_desc: entry.problem_desc, dir: got.dir || '' });
        }
        // 3) 一次 POST 交给后台执行 → 立即返回，可关窗口
        const env = (patchState.admin.projectEnvs || []).find(item => String(item.id) === String(payload.env_id)) || {};
        message.textContent = '正在启动后台适配…';
        const started = await patchNodeCcWeb('/api/adapt/start', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
            project_dir: payload.project_dir,
            product_name: env.product_name || null,
            product_version: env.product_version || null,
            server_url: (patchState.patchSearchServers[0] || '').replace(/\/+$/, ''),
            auth_token: patchToken(),
            items,
        })});
        message.textContent = started.message || '适配已在后台执行，可关闭页面。';
        closeAdaptModal();
        // 从普通检索点「适配」进来的：启动成功就直接进这次适配的详情页看进度。
        // （拖拽本地补丁那条路径保持原样：停在适配记录列表。）
        if (payload.entries.some(entry => entry.patch_id)) {
            location.href = `/adapt_run.html?run_id=${encodeURIComponent(started.run_id || runId)}`;
            return;
        }
        // 后台线程首次上报有延迟（第一个补丁开始跑时才报），等 1 秒再拉
        setTimeout(() => loadAdaptRuns().catch(() => {}), 1000);
    } catch (error) {
        message.textContent = `启动适配失败：${error.message}`;
    } finally {
        startBtn.disabled = false;
    }
}

// ── 补丁适配：记录列表与详情（读服务器账本，跨机器可查）──
// 刷新时机只有两处：① 点「开始适配」成功后等 1 秒 ② 关闭详情浮层时。不做定时轮询。
// 任务级状态：多补丁任务跑完一个补丁会停在「待确认」，等用户到详情页点「继续下一步」。
const PATCH_ADAPT_STATUS_LABEL = { running: '适配中', awaiting_confirmation: '待确认', done: '已完成', failed: '失败', aborted: '已中止' };

// 本机清单与服务器账本是否已经对不上（状态 / 补丁数 / 四类计数）。
// 对不上说明服务器那份停在旧状态——多半是适配跑久了 JWT 过期、cc-web 后台上报一直 401。
// 服务器上**根本没有**这条时不算对不上：那说明用户把库清了/删过记录，不复活它
// （要清就真清得掉；本机记录用「删除记录」一起删）。
function patchAdaptNeedsReReport(local, server) {
    if (!server) return false;
    const items = local.items || [];
    const counts = { done: 0, conflict: 0, nosource: 0, failed: 0 };
    items.forEach(item => { if (counts[item.status] !== undefined) counts[item.status] += 1; });
    return String(server.status || '') !== String(local.status || '')
        || Number(server.patch_count || 0) !== items.length
        || Number(server.succeeded_count || 0) !== counts.done
        || Number(server.conflict_count || 0) !== counts.conflict
        || Number(server.nosource_count || 0) !== counts.nosource
        || Number(server.failed_count || 0) !== counts.failed;
}

// 发现服务器账本落后时，用当前 token 让 cc-web 把本机这份重推一遍（顺带刷新它手里的旧 token），
// 然后重拉一次列表。每次进页只补一轮；补不动（比如服务器还是不通）就按现有数据渲染。
async function patchAdaptRepair(rows) {
    let locals = [];
    try { locals = (await patchNodeCcWeb('/api/adapt/runs')).data || []; } catch (error) { return rows; }
    const stale = locals
        .filter(local => patchAdaptNeedsReReport(local, rows.find(row => String(row.local_run_id) === String(local.id))))
        .slice(0, 10);
    if (!stale.length) return rows;
    await Promise.all(stale.map(local => patchNodeCcWeb(`/api/adapt/runs/${encodeURIComponent(local.id)}/re-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_url: patchServerBase(), auth_token: patchToken() }),
    }).catch(() => null)));
    try { return (await patchRequest('/api/patch-adapt/runs')) || rows; } catch (error) { return rows; }
}

async function loadAdaptRuns() {
    const body = document.getElementById('patchAdaptRunsBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="8" class="patch-empty">正在加载...</td></tr>';
    try {
        let rows = (await patchRequest('/api/patch-adapt/runs')) || [];
        rows = await patchAdaptRepair(rows);
        if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="patch-empty">暂无适配记录</td></tr>'; patchRenderPager('adaptRuns'); return; }
        // 前端分页：服务器一次最多给 200 条，这里按统一分页条切片
        const pageRows = patchClientSlice(patchClientPager('adaptRuns'), rows);
        body.innerHTML = pageRows.map(row => `<tr>
            <td>${patchEscape(patchFormatDateTime(row.created_at))}</td>
            <td>${patchEscape(`${row.product_name || '—'} ${row.product_version || ''}`.trim())}</td>
            <td><span class="patch-truncated-name" title="${patchEscape(row.code_directory || '')}">${patchEscape(patchNodeInline(row.code_directory || '—', 40))}</span></td>
            <td>${patchEscape(PATCH_ADAPT_STATUS_LABEL[row.status] || row.status || '—')}</td>
            <td>${Number(row.patch_count) || 0}</td>
            <td>${Number(row.succeeded_count) || 0} / ${Number(row.conflict_count) || 0} / ${Number(row.nosource_count) || 0} / ${Number(row.failed_count) || 0}</td>
            <td>${patchEscape(row.client_host || '—')}</td>
            <td><button class="patch-link-btn" data-adapt-view="${patchEscape(row.local_run_id)}">详情</button>
                <button class="patch-link-btn danger" data-adapt-delete="${patchEscape(row.local_run_id)}">删除记录</button></td>
        </tr>`).join('');
        patchRenderPager('adaptRuns');
    } catch (error) {
        body.innerHTML = `<tr><td colspan="8" class="patch-empty">加载失败：${patchEscape(error.message)}</td></tr>`;
        patchRenderPager('adaptRuns');
    }
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
        <div class="patch-detail-output"><pre id="patchAnalysisContent" class="patch-code-block">${patchEscape(patchDecodeResultText(patch.analysis_result || {}))}</pre></div>
        <div class="patch-detail-actions"><button class="patch-primary-btn" data-download-id="${patchEscape(patch.id)}" data-download-name="${patchEscape(patch.file_name || '')}">下载补丁包</button></div>`;
        // 复制按钮不在这里手工挂了：/copybox.js 会给这块内容统一挂右上角的复制图标（全站同一套）
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

// 复制按钮统一由 /copybox.js 提供（图标挂在只读内容框的右上角）。
// 这里原来的 copyTextToClipboard / copyWorkflowOutput 只服务于补丁详情弹窗那个手工按钮，
// 已随统一改造删掉；同款实现现在在 copybox.js 里。

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
            return `<fieldset class="template-step-card" data-dir-step="${step.step_order}">${legend}<label>手动填写本机路径<button type="button" class="patch-folder-pick" data-folder-pick title="从本机选择目录">📁</button><input data-dir-path value="${patchEscape(savedPath)}" placeholder="例如：D:\\project\\my-app"></label></fieldset>`;
        }
        const manual = Boolean(savedPath);
        const defaultId = savedId || (step.default_directory_id != null ? String(step.default_directory_id) : '');
        const dirOptions = options.map(item => `<option value="${patchEscape(item.id)}" ${String(item.id) === defaultId ? 'selected' : ''}>${patchEscape(item.name)} (${patchEscape(item.code)})</option>`).join('');
        return `<fieldset class="template-step-card" data-dir-step="${step.step_order}">${legend}<label>已有目录<select data-dir-existing ${manual ? 'disabled' : ''}>${dirOptions}</select></label><label>手动填写本机路径<button type="button" class="patch-folder-pick" data-folder-pick title="从本机选择目录">📁</button><input data-dir-path value="${patchEscape(savedPath)}" ${manual ? '' : 'disabled'} placeholder="例如：D:\\project\\my-app"></label><label class="template-context-option"><input type="checkbox" data-dir-manual ${manual ? 'checked' : ''}> 改用手动填写的路径</label></fieldset>`;
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
    // （弹窗与「帮助文档」共用，标题按当前任务改回来）
    document.getElementById('patchDownloadTitle').textContent = '下载补丁包';
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
        if (!response) throw new Error('无法连接服务器，请稍后重试或联系管理员');
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
    if (tab === 'project_env' && patchToken() && !patchState.authInvalidated) loadProjectEnvs();
    // 智能开发：每次进页签都重拉（本机清单 + 服务器账本，两边都可能在别处被改过）
    if (tab === 'node' && patchToken() && !patchState.authInvalidated) loadProblemRuns();
    // 补丁适配：进页签拉一次适配记录（服务器账本，跨机器可查）
    if (tab === 'adapt' && patchToken() && !patchState.authInvalidated) { loadAdaptRuns(); loadProjectEnvsForAdapt(); }
    if (tab === 'menus' && patchToken() && !patchState.authInvalidated && patchState.user?.role === 'admin') { loadMenuRoleConfig(); loadMenuUsers(); }
    // 会话存档（管理员专属）
    if (tab === 'sessions' && patchToken() && !patchState.authInvalidated && patchState.user?.role === 'admin') loadRunSessions();
    // 版本发布（管理员专属）：进页签拉一次当前已发布的清单
    if (tab === 'release' && patchToken() && !patchState.authInvalidated && patchState.user?.role === 'admin') loadReleaseInfo();
    patchSetSidenavActive(tab);
}

async function loadDirectories() {
    try {
        patchState.admin.directories = await patchRequest('/api/workflows/directories');
        renderDirectoryTable();
    } catch (error) { document.getElementById('patchDirectoryMessage').textContent = ''; patchShowError(error.message, '工作目录加载失败'); }
}

// 工作目录：前端分页渲染
function renderDirectoryTable() {
    const items = patchClientSlice(patchClientPager('directory'), patchState.admin.directories || []);
    document.getElementById('patchDirectoryBody').innerHTML = items.map(item => `<tr><td>${patchEscape(item.code)}</td><td>${patchEscape(item.name)}</td><td>${patchEscape(item.path)}</td><td>${item.is_builtin ? '内置' : '个人'}</td><td>${item.status ? '启用' : '停用'}</td><td>${item.is_builtin && patchState.user.role !== 'admin' ? '只读' : `<button class="patch-link-btn" data-directory-edit="${patchEscape(item.id)}">编辑</button><button class="patch-link-btn" data-directory-delete="${patchEscape(item.id)}">停用</button><button class="patch-link-btn danger" data-directory-remove="${patchEscape(item.id)}">删除</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="patch-empty">暂无工作目录</td></tr>';
    patchRenderPager('directory');
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

// 产品环境变量：每人一份，后端按 created_by_user_id 严格隔离（admin 也一样），前端不做权限判断
async function loadProjectEnvs() {
    const body = document.getElementById('patchProjectEnvBody');
    body.innerHTML = '<tr><td colspan="10" class="patch-empty">正在加载...</td></tr>';
    try {
        // 管理页走分页接口（/api/project-envs 仍返回全量，给新建运行的环境下拉用）
        const data = await patchRequest(`/api/project-envs/paged?page=${patchState.projectEnv.page}&size=${patchState.projectEnv.size}`);
        patchState.admin.projectEnvs = (data && data.items) || [];
        patchState.projectEnv.page = (data && data.page) || patchState.projectEnv.page;
        patchState.projectEnv.size = (data && data.size) || patchState.projectEnv.size;
        patchState.projectEnv.total = (data && data.total) || 0;
        patchRenderPager('projectEnv');
        body.innerHTML = patchState.admin.projectEnvs.length ? patchState.admin.projectEnvs.map(projectEnvRow).join('') : '<tr><td colspan="10" class="patch-empty">暂无产品环境，请先新增</td></tr>';
    } catch (error) {
        body.innerHTML = '<tr><td colspan="10" class="patch-empty">加载失败，请重试</td></tr>';
        document.getElementById('patchProjectEnvMessage').textContent = '';
        patchShowError(error.message, '产品环境加载失败');
    }
}

function projectEnvRow(item) {
    // 连接串与路径都很长：单元格内截断，title 里给全文（patch-truncated-name 是既有截断样式）
    const cell = value => `<td><span class="patch-truncated-name" title="${patchEscape(value || '')}">${patchEscape(value || '—')}</span></td>`;
    return `<tr>
        <td>${patchEscape(item.project_name)}</td>
        ${cell(item.product_name)}
        ${cell(item.product_version)}
        ${cell(item.db_connection)}
        ${cell(item.debug_address)}
        ${cell(item.code_directory)}
        ${cell(item.package_path)}
        ${cell(item.local_skill_path)}
        ${cell(item.local_jdk_path)}
        <td class="patch-actions-cell"><button class="patch-link-btn" data-project-env-edit="${patchEscape(item.id)}">编辑</button><button class="patch-link-btn danger" data-project-env-delete="${patchEscape(item.id)}">删除</button></td>
    </tr>`;
}

// 产品下拉只列未逻辑删除的产品（patchState.products 就是 /api/products 的默认结果）。
// 旧记录的产品若已被管理员逻辑删除，字典里查不到它，下拉自然落回「请选择」占位，
// 用户必须重选一个当前可用的产品才能保存——这正是后端 ensure_dictionary_choice 的要求。
function fillProjectEnvProducts(form, item) {
    const products = patchState.products || [];
    form.product_id.innerHTML = '<option value="">请选择产品</option>' + products.map(product => `<option value="${patchEscape(product.id)}">${patchEscape(product.name)}</option>`).join('');
    form.product_id.value = item.product_id == null ? '' : String(item.product_id);
}

// 版本下拉跟随产品；value 用版本字典 ID，显示版本号文本。返回该产品可用的版本数组。
function fillProjectEnvVersions(form, productId, currentVersionId) {
    const product = (patchState.products || []).find(value => String(value.id) === String(productId));
    const versions = product ? (product.versions || []) : [];
    form.version_id.innerHTML = '<option value="">请选择版本号</option>' + versions.map(version => `<option value="${patchEscape(version.id)}">${patchEscape(version.version)}</option>`).join('');
    form.version_id.value = versions.some(version => String(version.id) === String(currentVersionId)) ? String(currentVersionId) : '';
    return versions;
}

async function openProjectEnvForm(item = {}) {
    patchState.admin.projectEnvId = item.id || null;
    const form = document.getElementById('patchProjectEnvForm');
    let products;
    try { products = await ensureProductOptions(); }
    catch (error) { patchShowError(error.message, '产品字典加载失败'); return; }
    if (!products.length) { patchShowError('管理员尚未配置产品字典，请先在「产品版本管理」中添加产品与版本。', '无法维护产品环境'); return; }
    form.project_name.value = item.project_name || '';
    fillProjectEnvProducts(form, item);
    fillProjectEnvVersions(form, form.product_id.value, item.version_id);
    form.db_connection.value = item.db_connection || '';
    form.debug_address.value = item.debug_address || '';
    form.code_directory.value = item.code_directory || '';
    form.package_path.value = item.package_path || '';
    form.local_skill_path.value = item.local_skill_path || '';
    form.local_jdk_path.value = item.local_jdk_path || '';
    document.getElementById('patchProjectEnvModal').hidden = false;
    form.project_name.focus();
}

async function saveProjectEnv(event) {
    event.preventDefault();
    const form = event.target;
    const payload = Object.fromEntries(new FormData(form).entries());
    // 必填校验前端先拦一遍（后端同样会校验），空值时不发请求
    const required = [['project_name', '项目名称'], ['product_id', '产品名称'], ['version_id', '版本号'], ['code_directory', '客开代码目录'], ['package_path', 'home/war包地址'], ['local_jdk_path', '本地jdk路径']];
    for (const [field, label] of required) {
        if (!String(payload[field] || '').trim()) { patchShowError(`${label}为必填项`, '产品环境保存失败'); form[field].focus(); return; }
    }
    const id = patchState.admin.projectEnvId;
    // 下拉的 value 是字符串，转成数字再发（后端是 int，gt=0）
    payload.product_id = Number(payload.product_id);
    payload.version_id = Number(payload.version_id);
    try {
        await patchRequest(id ? `/api/project-envs/${id}` : '/api/project-envs', {method: id ? 'PUT' : 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
        document.getElementById('patchProjectEnvModal').hidden = true;
        await loadProjectEnvs();
    } catch (error) {
        document.getElementById('patchProjectEnvMessage').textContent = '';
        patchShowError(error.message, '产品环境保存失败');
    }
}

// 产品/版本字典管理（管理员）
async function loadProducts() {
    if (!patchState.user || patchState.user.role !== 'admin') return;
    const body = document.getElementById('patchProductBody');
    body.innerHTML = '<tr><td colspan="5" class="patch-empty">正在加载...</td></tr>';
    try {
        patchState.admin.products = await fetchAllProducts();
        renderProductTable();
    } catch (error) {
        body.innerHTML = '<tr><td colspan="5" class="patch-empty">加载失败，请重试</td></tr>';
        document.getElementById('patchProductMessage').textContent = '';
        patchShowError(error.message, '产品列表加载失败');
    }
}

// 产品版本管理：前端分页渲染
function renderProductTable() {
    const items = patchClientSlice(patchClientPager('product'), patchState.admin.products || []);
    document.getElementById('patchProductBody').innerHTML = items.length ? items.map(productRow).join('') : '<tr><td colspan="5" class="patch-empty">暂无产品，请先新增</td></tr>';
    patchRenderPager('product');
}

function productRow(item) {
    // 已逻辑删除的产品是只读的：后端也拒绝改它，前端只留「版本」查看入口
    const actions = item.is_deleted
        ? `<button class="patch-link-btn" data-product-versions="${patchEscape(item.id)}">版本</button>`
        : `<button class="patch-link-btn" data-product-versions="${patchEscape(item.id)}">版本</button><button class="patch-link-btn" data-product-edit="${patchEscape(item.id)}">编辑</button><button class="patch-link-btn danger" data-product-delete="${patchEscape(item.id)}">删除</button>`;
    const liveVersions = item.versions.filter(version => !version.is_deleted).length;
    return `<tr>
        <td><strong class="patch-truncated-name" title="${patchEscape(item.name)}">${patchEscape(item.name)}</strong></td>
        <td>${item.sort_order}</td>
        <td>${liveVersions}</td>
        <td>${item.is_deleted ? '是' : '否'}</td>
        <td class="patch-actions-cell">${actions}</td>
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
    patchConfirm(`产品“${product ? product.name : ''}”及其版本将从选择列表中移除（逻辑删除）；历史补丁与产品环境记录不受影响。`, '删除产品').then(confirmed => {
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
    // 已删除的产品不能再加版本（后端也会拒），直接收起新增区
    document.getElementById('patchVersionAdd').hidden = Boolean(product.is_deleted);
    document.getElementById('patchProductVersionModal').hidden = false;
}

function renderVersionList(product) {
    const list = document.getElementById('patchVersionList');
    if (!product) { list.innerHTML = ''; return; }
    // 弹窗是列表不是表格，没有表头，"是否删除"直接写成自解释的「已删除/未删除」
    list.innerHTML = product.versions.length ? product.versions.map(version => `<div class="patch-version-row"><span class="patch-version-name">${patchEscape(version.version)}</span><span class="patch-muted">${version.is_deleted ? '已删除' : '未删除'}</span>${version.is_deleted ? '' : `<button class="patch-link-btn danger" data-version-delete="${patchEscape(version.id)}">删除</button>`}</div>`).join('') : '<p class="patch-muted">暂无版本，请在下方添加</p>';
}

async function reloadVersionList() {
    patchState.admin.products = await fetchAllProducts();
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
    patchConfirm('该版本将从选择列表中移除（逻辑删除）；历史记录不受影响。', '删除版本').then(confirmed => {
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
    const generation = ++patchState.admin.analysisGeneration;
    const body = document.getElementById('patchAnalysisBody');
    const refresh = document.getElementById('patchAnalysisRefresh');
    if (body) body.innerHTML = '<tr><td colspan="7" class="patch-empty">正在加载...</td></tr>';
    if (refresh) refresh.disabled = true;
    try {
        const statusQuery = patchState.admin.analysisStatus === '' ? '' : `&status=${patchState.admin.analysisStatus}`;
        const data = await patchRequest(`/api/patches/pending-analysis?page=${patchState.admin.analysisPager.page}&size=${patchState.admin.analysisPager.size}${statusQuery}`);
        if (generation !== patchState.admin.analysisGeneration) return;
        patchState.admin.analysisPager.total = data.total;
        patchState.admin.analysisPager.page = data.page;
        patchState.admin.analysisPager.size = data.size;
        patchState.admin.analysisPatches = data.items || [];
        patchRenderPager('analysis');
        renderAnalysisPatches();
    } catch (error) {
        if (generation !== patchState.admin.analysisGeneration) return;
        if (body) body.innerHTML = '<tr><td colspan="7" class="patch-empty">加载失败</td></tr>';
        patchShowError(error.message, '待分析补丁加载失败');
    } finally {
        if (generation === patchState.admin.analysisGeneration && refresh) refresh.disabled = false;
    }
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
            renderAdminFlowTable();
        } else if (tab === 'prompt') {
            const prompts = await patchRequest('/api/workflows/prompts');
            patchState.admin.prompts = prompts;
            renderAdminPromptTable();
        } else {
            const [templates, flows, prompts] = await Promise.all([patchRequest('/api/workflows/templates'), patchRequest('/api/workflows/flows'), patchRequest('/api/workflows/prompts')]);
            patchState.admin.templates = templates;
            patchState.admin.flows = flows; patchState.admin.prompts = prompts;
            renderAdminTemplateTable();
        }
    } catch (error) {
        adminMessage(tab, error.message, true);
    }
}

// 流程/提示词/模板：前端分页渲染（数据全量在 patchState.admin.* 里，按分页条切片）
function renderAdminFlowTable() {
    const items = patchClientSlice(patchClientPager('flow'), patchState.admin.flows || []);
    document.getElementById('patchFlowBody').innerHTML = items.map(item => `<tr><td>${patchEscape(item.code)}</td><td>${patchEscape(item.name)}</td><td>${patchEscape(item.claude_target)}</td><td>${item.save_context ? '是' : '否'}</td><td>${configSource(item)}</td><td>${configActions('flow', item)}</td></tr>`).join('') || '<tr><td colspan="6" class="patch-empty">暂无流程</td></tr>';
    patchRenderPager('flow');
}
function renderAdminPromptTable() {
    const items = patchClientSlice(patchClientPager('prompt'), patchState.admin.prompts || []);
    document.getElementById('patchPromptBody').innerHTML = items.map(item => `<tr><td>${patchEscape(item.name)}</td><td>${patchEscape(item.description || '')}</td><td>${item.status ? '启用' : '停用'}</td><td>${configSource(item)}</td><td>${configActions('prompt', item)}</td></tr>`).join('') || '<tr><td colspan="5" class="patch-empty">暂无提示词</td></tr>';
    patchRenderPager('prompt');
}
function renderAdminTemplateTable() {
    const items = patchClientSlice(patchClientPager('template'), patchState.admin.templates || []);
    document.getElementById('patchTemplateBody').innerHTML = items.map(item => `<tr><td>${patchEscape(item.code)}</td><td>${patchEscape(item.name)}</td><td>${item.status ? '启用' : '停用'}</td><td>${configSource(item)}</td><td>${configActions('template', item)}</td></tr>`).join('') || '<tr><td colspan="5" class="patch-empty">暂无模板</td></tr>';
    patchRenderPager('template');
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
        // 勾选状态以 state 为准（分页后 DOM 只有当前页，不能靠 DOM 收集）
        patchState.admin.menuConfig.roleVisible = {};
        (data.items || []).forEach(item => { patchState.admin.menuConfig.roleVisible[item.key] = !!item.visible; });
        renderMenuRoleTable();
    } catch (error) {
        document.getElementById('patchMenuRoleMessage').textContent = '';
        patchShowError(error.message, '菜单可见性加载失败');
    }
}

// 菜单可见性（角色默认）：前端分页渲染；勾选值取 state（roleVisible），不取 DOM
function renderMenuRoleTable() {
    const cfg = patchState.admin.menuConfig;
    const items = patchClientSlice(patchClientPager('menuRole'), cfg.roleItems || [])
        .map(item => ({ ...item, visible: item.key in cfg.roleVisible ? cfg.roleVisible[item.key] : !!item.visible }));
    document.getElementById('patchMenuRoleBody').innerHTML = menuRoleRows(items);
    patchRenderPager('menuRole');
}

async function saveMenuRoleConfig() {
    // 全量提交 state 里记的勾选（分页后 DOM 只有当前页，必须用 state）
    const visible = {};
    Object.keys(patchState.admin.menuConfig.roleVisible).forEach(key => { visible[key] = patchState.admin.menuConfig.roleVisible[key]; });
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
    const cfg = patchState.admin.menuConfig;
    if (!userId) {
        cfg.userId = '';
        cfg.userItems = [];
        cfg.userOverrides = {};
        document.getElementById('patchMenuUserBody').innerHTML = '<tr><td colspan="4" class="patch-empty">请选择用户</td></tr>';
        return;
    }
    try {
        const data = await patchRequest(`/api/menus/users/${encodeURIComponent(userId)}`);
        cfg.userId = String(userId);
        cfg.userItems = data.items || [];
        // 下拉值以 state 为准（分页后 DOM 只有当前页，不能靠 DOM 收集）
        cfg.userOverrides = {};
        cfg.userItems.forEach(item => { cfg.userOverrides[item.key] = item.override === true ? true : item.override === false ? false : null; });
        renderMenuUserTable();
    } catch (error) {
        document.getElementById('patchMenuUserMessage').textContent = '';
        patchShowError(error.message, '用户例外加载失败');
    }
}

// 用户例外：前端分页渲染；下拉值取 state（userOverrides）
function renderMenuUserTable() {
    const cfg = patchState.admin.menuConfig;
    const items = patchClientSlice(patchClientPager('menuUser'), cfg.userItems || [])
        .map(item => ({ ...item, override: item.key in cfg.userOverrides ? cfg.userOverrides[item.key] : (item.override === true ? true : item.override === false ? false : null) }));
    document.getElementById('patchMenuUserBody').innerHTML = menuUserRows(items);
    patchRenderPager('menuUser');
}

async function saveMenuUserOverrides() {
    const cfg = patchState.admin.menuConfig;
    const userId = cfg.userId;
    if (!userId) { document.getElementById('patchMenuUserMessage').textContent = '请先选择用户'; return; }
    // 全量提交 state 里的下拉值（分页后 DOM 只有当前页，必须用 state）。
    // 空字符串 → null（删除覆盖行、跟随角色默认），接口对 null 做 DELETE，重复提交幂等。
    const overrides = {};
    (cfg.userItems || []).forEach(item => {
        overrides[item.key] = item.key in cfg.userOverrides ? cfg.userOverrides[item.key] : (item.override === true ? true : item.override === false ? false : null);
    });
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
    container.innerHTML = steps.map((step, index) => `<fieldset class="template-step-card" data-step-index="${index}"><legend><span class="template-step-number">步骤 ${index + 1}</span><span class="template-step-actions"><button type="button" class="patch-link-btn" data-step-up ${index === 0 ? 'disabled' : ''}>上移</button><button type="button" class="patch-link-btn" data-step-down ${index === steps.length - 1 ? 'disabled' : ''}>下移</button>${steps.length > 1 ? '<button type="button" class="patch-link-btn danger" data-step-remove>删除</button>' : ''}</span></legend><div class="template-step-grid"><label>流程<select name="flow_id" required><option value="">请选择流程</option>${flowOptions}</select></label><label>提示词<select name="prompt_id">${promptOptions}</select></label></div>${index === 0 ? '<div class="template-first-step-note">首步骤执行时自动使用本次智能分析输入的业务需求或问题。</div>' : `<label>用户提示词<textarea name="user_prompt" required placeholder="可使用 {{business_input}} 或前置流程结果"></textarea><span class="template-variable-row">插入变量：<select data-step-variable><option value="">选择变量</option>${workflowStepVariableOptions(index)}</select><button type="button" class="patch-secondary-btn" data-insert-step-variable>插入</button></span></label>`}<label class="template-context-option"><input type="checkbox" name="save_context_override"> 保存本步骤输出供后续步骤使用</label></fieldset>`).join('');
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
            // 模板改动会牵动多处界面（本页模板列表、智能分析页的模板下拉、运行详情里的步骤），
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
    patchRenderPager('workflowHistory');
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

/* ══════════════════════════════════════════════════════════════════
   智能开发节点（patchTabNode）——方案文档第二十章
   ──────────────────────────────────────────────────────────────────
   三条决定了整段代码形状的约束：

   1. **本机清单是事实来源**。run 存 ~/.cc-web/node_runs.json（cc-web 只透明存取，
      不解释字段），产物存用户填的补丁输出目录。服务器 problem_run 只是只写账本：
      上报 fire-and-forget，失败静默、本地留 reported=false 待补报。
   2. **两阶段跑在同一个 claude 会话里，cwd 都是 code_directory**。阶段一在客开工程里
      只读分析、改动写进 <outDir>/work 暂存目录；用户点「问题已解决」后才发阶段二提示词
      把暂存目录同步回客开工程。cwd 不能换——`--resume` 与 cwd 强绑定，换目录就
      `No conversation found`（见方案 20.5）。
   3. **SSE 没有历史回放**：`/api/agent/{id}/events` 只做 subscribe，所以顺序必须是
      先建 EventSource、等到 connected，再 start，否则开头的事件会丢（见方案 20.13）。
   ══════════════════════════════════════════════════════════════════ */

// 日志超过这个长度就不进 node_runs.json（清单每次状态变化都整体落盘，塞不下长文本）。
// 提示词里始终带全文——日志是给 claude 定位问题用的输入，不要求它再抄一份落盘。
const PATCH_NODE_LOG_INLINE_LIMIT = 8192;
// 合并说明.md 的判定：claude 按提示词在第一行写「结果：成功 / 结果：冲突」。
// 没读到文件或读不懂时一律按"未成功"处理——宁可让用户去核对 git，也不要谎报已解决。
const PATCH_NODE_MERGE_RE = /结果\s*[:：]\s*(成功|冲突)/;

// 本地 phase(+verdict/failure) → 服务器 status（取值见 schema/migration_problem_run.sql）
function patchNodeServerStatus(run) {
    if (run.phase === 'done') return run.verdict === 'solved' ? 'solved' : 'unsolved';
    if (run.phase === 'failed') return run.failure === 'aborted' ? 'aborted' : 'merge_failed';
    if (run.phase === 'awaiting_decision') return 'awaiting_decision';
    return 'running'; // analyzing / merging
}

function patchNodeStatusLabel(run) {
    if (run.phase === 'analyzing') return '执行中';
    if (run.phase === 'merging') return '合并中';
    // 阶段一执行出错：仍停在待判定（按钮保留），但状态单独标成「执行出错」以便一眼区分
    if (run.phase === 'awaiting_decision') return run.error ? '执行出错' : '待判定';
    if (run.phase === 'done') return run.verdict === 'solved' ? '已解决' : '未解决';
    if (run.phase === 'failed') return run.failure === 'aborted' ? '已中断' : '合并失败';
    return '未知';
}

// 服务器 status → 中文（换机后本机没有这条 run，只能按服务器账本展示）
const PATCH_NODE_SERVER_STATUS_LABEL = {
    running: '执行中', awaiting_decision: '待判定', solved: '已解决',
    unsolved: '未解决', merge_failed: '合并失败', aborted: '已中断',
};

// 与 saveDirectory 同一条正则：cc-web 就在本机，路径存在性交给它判断，
// 前端只拦住相对路径这种"必然错"的输入。
function patchNodeIsAbsolutePath(value) {
    return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(String(value || '').trim());
}

// 按 base 自己的分隔符风格拼接（用户可能填 D:\a 也可能填 /home/a）
function patchNodeJoin(base, name) {
    const text = String(base || '');
    const sep = text.includes('\\') && !text.includes('/') ? '\\' : '/';
    return `${text.replace(/[\\/]+$/, '')}${sep}${name}`;
}

// —— 每「步」一个产物子目录，重跑不互相覆盖 ——
// 用户填 `out_dir`（补丁输出根）后按步骤隔离：
//   阶段一 N 次 → outDir\step01、step02…；阶段二（合并）→ outDir\result。
// 老记录没有 step_dir/turn_dir 字段时回退到平铺在老 outDir（向后兼容）。
function patchNodePad(n) { return String(n || 1).padStart(2, '0'); }
function patchNodeStepDir(outDir, n) { return patchNodeJoin(outDir, `step${patchNodePad(n)}`); }
function patchNodeTurnDir(run) { return run.turn_dir || run.out_dir; }    // 本步产物目录
function patchNodeStepDirOf(run) { return run.step_dir || run.out_dir; }  // 阶段一当前/最近一步目录

// 阶段二干净补丁的命名前缀：patch_<产品名><版本>_<yyyymmddHHmm>_。
// 前缀（产品名版本 + 时间）用固定值，避免非法字符；「问题简述」那段由 claude 在阶段二结束时
// 自己用一句话概括填在 _ 与 _znkf.zip 之间（做成占位符，见阶段二提示词第 5 步）。
function patchNodeTimestampStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
function patchNodePatchPrefix(run) {
    const env = run.env_snapshot || {};
    const productTag = `${env.product_name || 'unknown'}${env.product_version || ''}`
        .replace(/[\\/:*?"<>|\s]+/g, '_');
    return `patch_${productTag}_${patchNodeTimestampStamp()}_`;
}

function patchNodeInline(value, limit) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// ── cc-web 同源接口（/api/agent/*、/api/node/*、/api/files/* 都是本进程的 3030 端口，无 CORS）──
async function patchNodeCcWeb(path, options = {}) {
    const response = await fetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    }
    return payload;
}

// /api/files/{path:.*} 直接吃绝对路径。Windows 的反斜杠在 URL 里很别扭，统一换成正斜杠，
// 其余字符（空格等）交给 URL 解析器自己编码。
function patchNodeFileUrl(absPath) {
    return `/api/files/${String(absPath || '').replace(/\\/g, '/')}`;
}

// 列目录必须走 **query 形式** `/api/files?path=`（list_files）；路径形式 `/api/files/<path>` 是读文件的，
// 传目录进去会直接报 `Path is a directory`（files.rs:100）。
async function patchNodeReadDir(absDir) {
    const payload = await patchNodeCcWeb(`/api/files?path=${encodeURIComponent(absDir)}`);
    return payload.files || [];
}

async function patchNodeReadTextFile(absFile) {
    const payload = await patchNodeCcWeb(patchNodeFileUrl(absFile));
    return payload.content == null ? '' : String(payload.content);
}

// ── run 的本地读写（cc-web 的 node_runs.json）──
async function patchNodeSaveRun(run) {
    run.updated_at = new Date().toISOString();
    await patchNodeCcWeb(`/api/node/runs/${encodeURIComponent(run.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(run),
    });
}

// ── 流式输出区（已停用）──
// 实时输出不再在列表页面板展示——查看已移到「详情」页和聊天页的「查看会话」。
// 保留空实现让既有调用点（开始/阶段二/重跑/中断等）不报错；run.report 仍由 result 事件写入。
function patchNodeAppendText() {}
function patchNodeScheduleFlush() {}
function patchNodeFlushOutput() {}

function patchNodeCloseStream() {
    const state = patchState.node;
    if (state.es) { state.es.close(); state.es = null; }
    state.streaming = false;
    state.pendingPrompt = null;
}

// ── 运行列表：本机清单 ∪ 服务器账本（本地优先）──
function patchNodeRunTime(entry) {
    const raw = (entry.local && entry.local.created_at) || (entry.server && entry.server.created_at) || '';
    const ms = new Date(raw).getTime();
    return Number.isNaN(ms) ? 0 : ms;
}

// 去重键是 local_run_id：本机有就覆盖服务器那条（本机能动、服务器那条只是影子）；
// 只有服务器有的标 archived=true —— 表示"这条是别的机器上跑的，只能看"。
function patchNodeMergeRuns(localRuns, serverRuns) {
    const byId = new Map();
    (serverRuns || []).forEach(row => {
        const id = String(row.local_run_id || '');
        if (id) byId.set(id, { id, archived: true, local: null, server: row });
    });
    (localRuns || []).forEach(run => {
        const id = String(run.id || '');
        if (!id) return;
        const existing = byId.get(id);
        byId.set(id, { id, archived: false, local: run, server: existing ? existing.server : null });
    });
    return Array.from(byId.values()).sort((a, b) => patchNodeRunTime(b) - patchNodeRunTime(a));
}

// 面板与列表「真正在渲染的那一份对象」。
// loadProblemRuns() 会把 patchState.node.current 换成从磁盘重新解析出来的新对象（见它末尾那段
// 「刷新当前打开的那条」），而事件回调闭包里抓的还是启动那一刻的旧副本 —— 直接改旧副本会没人看：
// 按钮显隐渲染的是一份、onclick 读的又是另一份。凡是要改 run、或要把 run 交给回调，都先过这里。
function patchNodeLiveRun(run) {
    if (!run) return run;
    const entry = (patchState.node.runs || []).find(item => item.id === run.id);
    if (entry && entry.local) return entry.local;
    const current = patchState.node.current;
    if (current && current.id === run.id) return current;
    return run;
}

// 「已解决/未解决/重新执行/重新合并」按状态拆分（都作用于当前 run，动作见 patchNodeRunAction）：
//   待判定   → 已解决（进合并）+ 未解决（补信息重跑阶段一）
//   执行出错 → 重新执行（补信息重跑阶段一）
//   合并失败 → 重新合并（补信息重跑阶段二）
//   已中断   → 按当时阶段给「重新执行 / 重新合并」
function patchNodeActionButtons(run) {
    const btn = (action, label) => `<button class="patch-link-btn" data-node-action="${action}" data-node-id="${patchEscape(run.id)}">${label}</button>`;
    if (run.phase === 'awaiting_decision' && !run.error) {
        return [btn('solved', '已解决'), btn('unsolved', '未解决')];
    }
    if (run.phase === 'awaiting_decision' && run.error) {
        return [btn('rerun', '重新执行')];
    }
    if (run.phase === 'failed' && run.failure === 'merge') {
        return [btn('rerun', '重新合并')];
    }
    if (run.phase === 'failed' && run.failure === 'aborted') {
        return [btn('rerun', run.stage === 2 ? '重新合并' : '重新执行')];
    }
    return [];
}

function patchNodeRunActions(run) {
    const parts = [`<button class="patch-link-btn" data-node-action="detail" data-node-id="${patchEscape(run.id)}">详情</button>`];
    parts.push(...patchNodeActionButtons(run));
    // 「查看会话」只要有个 id 能定位到那次 claude 会话就显示：session_id 直接选中 cc-web 会话，
    // 只剩 agent_session_id 时退到只读回放（见 patchNodeResumeSession）。
    if (run.session_id || run.agent_session_id) {
        parts.push(`<button class="patch-link-btn" data-node-action="resume" data-node-id="${patchEscape(run.id)}">查看会话</button>`);
    }
    parts.push(`<button class="patch-link-btn danger" data-node-action="remove" data-node-id="${patchEscape(run.id)}">删除记录</button>`);
    return parts.join('');
}

function patchNodeRunRow(entry) {
    const run = entry.local;
    const server = entry.server;
    const source = run || server;
    const env = (run && run.env_snapshot) || {};
    const product = run
        ? `${env.product_name || ''} ${env.product_version || ''}`.trim()
        : `${server.product_name || ''} ${server.product_version || ''}`.trim();
    const status = run ? patchNodeStatusLabel(run) : (PATCH_NODE_SERVER_STATUS_LABEL[server.status] || server.status || '');
    const conclusion = patchNodeInline((run && run.report) || (server && server.conclusion) || '—', 60);
    // 只在服务器有的行：本机不能继续操作，但可看账本详情（数据就在 entry.server 里，不用再请求）。
    const actions = run
        ? patchNodeRunActions(run)
        : `<button class="patch-link-btn" data-node-action="archived-detail" data-node-id="${patchEscape(String((server && server.local_run_id) || ''))}">详情</button> <span class="patch-node-archived" title="这条运行是在另一台机器（${patchEscape((server && server.client_host) || '未知机器')}）上执行的，本机的会话、暂存目录与产物都不在这里，无法继续">仅存档 · ${patchEscape((server && server.client_host) || '未知机器')}</span>`;
    return `<tr>
        <td>${patchEscape(patchFormatDateTime(new Date(patchNodeRunTime(entry))))}</td>
        <td><span class="patch-truncated-name" title="${patchEscape(source.problem_desc || '')}">${patchEscape(patchNodeInline(source.problem_desc || '—', 40))}</span></td>
        <td>${patchEscape(product || '—')}</td>
        <td>${patchEscape(status)}</td>
        <td><span class="patch-truncated-name" title="${patchEscape(conclusion)}">${patchEscape(conclusion)}</span></td>
        <td class="patch-actions-cell">${actions}</td>
    </tr>`;
}

function patchNodeRenderRuns() {
    const body = document.getElementById('patchNodeRunsBody');
    const rows = patchState.node.runs || [];
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6" class="patch-empty">暂无运行记录，点右上角「新建智能开发」开始</td></tr>';
        patchRenderPager('nodeRuns');
        return;
    }
    // 前端分页：本机清单 ∪ 服务器账本合并后的列表按分页条切片
    const pageRows = patchClientSlice(patchClientPager('nodeRuns'), rows);
    body.innerHTML = pageRows.map(patchNodeRunRow).join('');
    patchRenderPager('nodeRuns');
}

// 找回丢失的会话绑定：run 缺 session_id/claude 会话 id，但本机 cc-web 会话还在时，
// 按「同 cwd + 创建时间最接近（±2 分钟内）」匹配回填并落盘。
// 只处理本机清单里缺会话 id 的 run；/api/sessions 拉不到就不动。
async function patchNodeBackfillSessionIds(localRuns) {
    const need = localRuns.filter(run => !run.session_id || !run.agent_session_id);
    if (!need.length) return;
    let sessions = [];
    try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        sessions = Array.isArray(data.sessions) ? data.sessions : [];
    } catch (error) { return; }
    for (const run of need) {
        const cwd = (run.env_snapshot || {}).code_directory;
        const createdMs = new Date(run.created_at || 0).getTime();
        if (!cwd || !createdMs) continue;
        let best = null, bestDiff = 120000;
        for (const s of sessions) {
            if (s.assistant !== 'claude' || s.cwd !== cwd) continue;
            const diff = Math.abs(new Date(s.created).getTime() - createdMs);
            if (diff < bestDiff) { bestDiff = diff; best = s; }
        }
        if (!best) continue;
        let changed = false;
        if (!run.session_id && best.id) { run.session_id = best.id; changed = true; }
        if (!run.agent_session_id && best.agent_session_id) { run.agent_session_id = best.agent_session_id; changed = true; }
        if (changed) patchNodeSaveRun(run).catch(error => console.error('[node] 回填会话 id 失败：', error));
    }
}

async function loadProblemRuns(opts = {}) {
    // opts.skipReconcile = true 时跳过对账：已解决/未解决/重新执行刚改了 phase、下一轮流式还没起，
    // 此刻对账会看到该会话 isStreaming=false，可能把刚改的状态误判/回退。流式起来后对账会正常跳过它。
    const skipReconcile = Boolean(opts.skipReconcile);
    const body = document.getElementById('patchNodeRunsBody');
    body.innerHTML = '<tr><td colspan="6" class="patch-empty">正在加载...</td></tr>';
    let localRuns = [];
    try {
        const local = await patchNodeCcWeb('/api/node/runs');
        localRuns = Array.isArray(local.data) ? local.data : [];
        patchState.node.host = local.host || '';
    } catch (error) {
        // 本机清单挂了，这条页签就没有"能动"的部分了——服务器账本单独列出来也没用，直接报错返回
        body.innerHTML = `<tr><td colspan="6" class="patch-empty">本机运行清单读取失败：${patchEscape(error.message)}</td></tr>`;
        patchShowError(error.message, '本机运行清单读取失败');
        return;
    }
    let serverRuns = [];
    try {
        serverRuns = (await patchRequest('/api/problem-runs')) || [];
    } catch (error) {
        // 刻意不弹错误框：服务器只是账本，读不到不影响本机干活（方案 20.10）
        console.warn('[node] 服务器运行摘要读取失败（不影响本机使用）：', error.message);
    }
    // 本机运行记录是机器级（node_runs.json 不分账号），只列当前登录账号自己的。
    // 老记录（本功能上线前建的，没有 user_id）：服务器账本查询时已按当前用户过滤，
    // 所以本地 run 能对上账本里同一条 local_run_id 就说明是当前用户的 → 回填归属并落盘，
    // 让它恢复成「本机运行」而不是降级成「仅存档」；对不上的一律不展示（无法确权，防跨账号泄露）。
    const currentUserId = patchState.user && patchState.user.id;
    if (currentUserId != null) {
        const serverById = new Map(serverRuns.map(row => [String(row.local_run_id), row]));
        for (const run of localRuns) {
            if (run.user_id == null && serverById.has(String(run.id))) {
                run.user_id = currentUserId;
                patchNodeSaveRun(run).catch(() => {});
            }
        }
        localRuns = localRuns.filter(run => String(run.user_id) === String(currentUserId));
    } else {
        localRuns = [];
    }
    // 找回丢失的会话绑定：run 没有 session_id / claude 会话 id 但对应 cc-web 会话还在时，
    // 按「同 cwd + 创建时间接近」回填并落盘（比如换了机器/旧包跑丢了会话 id 的 run）。
    await patchNodeBackfillSessionIds(localRuns);
    patchState.node.runs = patchNodeMergeRuns(localRuns, serverRuns);
    // 先把"其实早跑完、但收尾那一刻页面不在"的 run 纠正过来，再渲染
    if (!skipReconcile) await patchNodeReconcileRuns();
    patchNodeRenderRuns();
    // 刷新当前打开的那条（状态可能刚变过，按钮显隐要跟着走）
    if (patchState.node.current) {
        const fresh = patchState.node.runs.find(item => item.id === patchState.node.current.id);
        if (fresh && fresh.local) {
            patchState.node.current = fresh.local;
            patchNodeRenderRunPanel(fresh.local);
        }
    }
    patchNodeReportPending();
    // 从详情页右侧判定区跳过来的「已解决/未解决」动作：详情页不重复实现合并/流式逻辑，
    // 带着 node_action + run 回列表页，这里原地执行（复用下面的 patchNodeSolved / patchNodeRerun）。
    await patchNodeHandleUrlAction();
}

// 详情页「已解决/未解决」按钮通过这个 query 回到列表页执行。跑完即清掉参数，
// 防止刷新重复触发；找不到 run 或动作不识别就静默跳过。
async function patchNodeHandleUrlAction() {
    const params = new URLSearchParams(location.search);
    const action = params.get('node_action');
    const runId = params.get('run');
    if (!action || !runId) return;
    params.delete('node_action');
    params.delete('run');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
    const run = patchNodeFindRun(runId);
    if (!run) return;
    if (action === 'solved') patchNodeSolved(run).catch(error => patchShowError(error.message, '操作失败'));
    else if (action === 'unsolved') patchNodeUnsolved(run).catch(error => patchShowError(error.message, '操作失败'));
    else if (action === 'rerun') patchNodeRerun(run);
}

// ── 上报（只写账本，失败静默）──
async function patchNodePushReport(run) {
    const env = run.env_snapshot || {};
    await patchRequest('/api/problem-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            local_run_id: run.id,
            problem_desc: run.problem_desc,
            status: patchNodeServerStatus(run),
            env_id: run.env_id == null ? null : Number(run.env_id),
            env_project_name: env.project_name || null,
            product_id: env.product_id == null ? null : Number(env.product_id),
            version_id: env.version_id == null ? null : Number(env.version_id),
            code_directory: env.code_directory || null,
            patch_output_path: run.out_dir || null,
            // 结论是"摘要"：完整结论文本在 outDir/结论.md，账本里塞全文没意义
            conclusion: patchNodeInline(run.report || '', 4000) || null,
            claude_session_id: run.agent_session_id || null,
            client_host: run.client_host || null,
            started_at: run.created_at || null,
            finished_at: run.finished_at || null,
        }),
    });
    return true;
}

// fire-and-forget：服务器挂了不能阻塞干活；成功后把 reported 落成本地 true
function patchNodeReport(run) {
    patchNodePushReport(run).then(() => {
        if (run.reported === true) return;
        run.reported = true;
        patchNodeSaveRun(run).catch(() => {});
    }).catch(error => {
        console.warn('[node] 运行摘要上报失败（将在下次进入页签时补报）：', error.message);
    });
}

// 补报：本地有、reported 还不是 true 的，进入页签时再推一次（方案 20.10）
function patchNodeReportPending() {
    (patchState.node.runs || []).forEach(entry => {
        if (!entry.local || entry.local.reported === true) return;
        patchNodeReport(entry.local);
    });
}

// ── 流程区渲染 ──
function patchNodeRenderArtifacts(run) {
    const box = document.getElementById('patchNodeArtifacts');
    const items = run.artifacts || [];
    if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = items.map(path => {
        const name = String(path).split(/[\\/]/).pop();
        return `<button type="button" class="patch-link-btn" data-node-file="${patchEscape(path)}" title="${patchEscape(path)}">${patchEscape(name)}</button>`;
    }).join('');
}

function patchNodeRenderRunPanel(run) {
    const streaming = run.phase === 'analyzing' || run.phase === 'merging';
    const env = run.env_snapshot || {};
    document.getElementById('patchNodeRunPanel').hidden = false;
    document.getElementById('patchNodeRunTitle').textContent = patchNodeInline(run.problem_desc, 80) || '当前运行';
    document.getElementById('patchNodeRunStatus').textContent = [
        patchNodeStatusLabel(run),
        `${env.product_name || ''} ${env.product_version || ''}`.trim(),
        `客开工程：${env.code_directory || '—'}`,
        `补丁输出：${patchNodeTurnDir(run) || '—'}`,
    ].filter(Boolean).join(' · ');
    document.getElementById('patchNodeAbort').hidden = !streaming;
    // 面板的判定/重跑按钮与列表操作列同一套语义（见 patchNodeActionButtons）：
    // 已解决只出现在待判定；未解决/重新执行/重新合并按状态显示。
    const panel = patchNodePanelActions(run);
    const solvedBtn = document.getElementById('patchNodeSolved');
    const unsolvedBtn = document.getElementById('patchNodeUnsolved');
    solvedBtn.hidden = !panel.solved;
    unsolvedBtn.hidden = !panel.unsolved;
    if (panel.unsolved) unsolvedBtn.textContent = panel.unsolvedLabel;
    // 有 id 就能跳：session_id 直选 cc-web 会话（执行中也能进去看实时输出），
    // 只剩 agent_session_id 时退到只读回放。不再要求 cwd。
    document.getElementById('patchNodeResumeSession').hidden = !(run.session_id || run.agent_session_id);
    patchNodeRenderArtifacts(run);
}

// 面板两个按钮的显隐与文案（与列表操作列 patchNodeActionButtons 同一套状态语义）
function patchNodePanelActions(run) {
    if (run.phase === 'awaiting_decision' && !run.error) return { solved: true, unsolved: true, unsolvedLabel: '未解决' };
    if (run.phase === 'awaiting_decision' && run.error) return { solved: false, unsolved: true, unsolvedLabel: '重新执行' };
    if (run.phase === 'failed' && run.failure === 'merge') return { solved: false, unsolved: true, unsolvedLabel: '重新合并' };
    if (run.phase === 'failed' && run.failure === 'aborted') return { solved: false, unsolved: true, unsolvedLabel: run.stage === 2 ? '重新合并' : '重新执行' };
    return { solved: false, unsolved: false, unsolvedLabel: '未解决' };
}

// 运行详情已搬到独立页（node_run.html，「详情」按钮跳转）；面板只负责执行中的实时输出。

// ── 提示词 ──

// 本次产品的 MCP root：产品名小写 + 版本号去点（FBIP 8.1 → fbip81，FBIP 8.2 → fbip82，FDIP 8.1 → fdip81），
// 与服务器 mcp.roots 的命名规则一致（按产品+版本各挂一个 root）
function patchNodeMcpRoot(env) {
    return `${String(env.product_name || '').toLowerCase()}${String(env.product_version || '').replace(/\./g, '')}`;
}

// 未解决重跑时附带的「编译要求 + 源码检索要求」：与阶段一同一套规范（抽出来共用，避免两处漂移）
function patchNodeUnsolvedGuidance(run) {
    const env = run.env_snapshot || {};
    const mcpRoot = patchNodeMcpRoot(env);
    return [
        '【编译要求】用 java-compiler-mcp skill（Skill 工具调用 `java-compiler-mcp`），八个工具：',
        'java_compile / java_run / java_scan_home / java_clear_cache / java_generate_patch /',
        'java_generate_webapp_patch / java_apply_patch / frontend_build_patch。照它调用，不要自己猜参数。',
        'NC 客开模块补丁用 java_generate_patch（参数：module_path=暂存目录、home=工程 home、',
        'files=所有改动文件一次传入（不要逐文件调）、java_home=JDK）；标准 war/web 工程用 java_generate_webapp_patch。',
        '打包完把 zip 条目列出来自查一遍，层级不对就重打包。',
        '',
        '【源码检索要求】分析源码走 patch_source MCP：',
        `本次产品 ${env.product_name || ''} ${env.product_version || ''} → root=${mcpRoot}；`,
        'path 写相对该 root 的包级路径（如 nc/impl/tb），禁止根级/全树模式；先 list_roots 确认，',
        '没有对应 root 就说明「该版本源码未挂载」并停手。',
        '不要反编译 jar 包：客开工程找不到就用 MCP 找标品源码，源码也没有就说明「产品无此源码」，不要再找。',
    ].join('\n');
}

function patchNodePhaseOnePrompt(run, logInfo) {
    const env = run.env_snapshot || {};
    const mcpRoot = patchNodeMcpRoot(env);
    // 数据库与远程调试口都是选填的：没登记就整行不出现，免得 claude 去追问一个本来就没有的东西
    const envLines = [
        `产品：${env.product_name || ''} ${env.product_version || ''}`.trim(),
        `产品源码：通过 patch_source MCP 检索（本次用 root=${mcpRoot}，path 写相对该 root 的路径）`,
        `客开工程根（你现在的工作目录）：${env.code_directory}`,
        `暂存目录（改动只能写到这里）：${run.stage_dir}`,
        `补丁输出目录：${patchNodeTurnDir(run)}`,
        `工程 home / war 包地址（编译依赖根）：${env.package_path}`,
        `JDK：${env.local_jdk_path || '（该产品环境变量里没登记本地 JDK 路径，编译前先向用户确认）'}`,
    ];
    // skill 库根目录（产品环境变量里登记了才有）。只作信息登记：不再用于"直读 SKILL.md 兜底"——
    // java-compiler-mcp 保证每台开发机都装，走 Skill 工具按名字调用即可，不需要这条兜底路径。
    const skillDir = String(env.local_skill_path || '').trim().replace(/[\\/]+$/, '');
    if (skillDir) envLines.push(`本机 skill 库（FBIP 领域 skill 库根目录，可按需读取）：${skillDir}`);
    if (env.db_connection) envLines.push(`数据库连接：${env.db_connection}（**只读**，见【约束】里关于数据库的那条）`);
    if (env.debug_address) envLines.push(`远程调试端口：${env.debug_address}（**只做线程级调试**，见【约束】里关于远程调试的那条）`);
    // java-compiler-mcp 是每台开发机都会装的 skill（用户级 ~/.claude/skills）：这条任务**无条件**出现，
    // 且只有"用 Skill 工具按名字调用"这一条路，不再给 skill 库根目录直读的兜底。
    const skillTask = [
        '2. 动手前先用 java-compiler-mcp skill（编译补丁必做）：用 Skill 工具调用 `java-compiler-mcp`——',
        '   编译 MCP 八个工具（java_compile / java_run / java_scan_home / java_clear_cache / java_generate_patch /',
        '   java_generate_webapp_patch / java_apply_patch / frontend_build_patch）的参数、路径映射表、GBK 回退与常见错误都在里面。',
        '   **照它调用，不要自己猜参数**。java_generate_webapp_patch 用于标准 war/web 工程（WEB-INF/classes 结构），',
        '   NC 客开模块补丁用 java_generate_patch（见第 3e 步）。',
    ];
    const lines = [
        '【问题 / 需求】',
        run.problem_desc,
        `触发时的url为：${run.trigger_url || '（未填写）'}`,
        '',
        '【相关日志】',
        logInfo || '（未提供）',
        '',
        '【环境】',
        ...envLines,
        '',
        '【任务】',
        '1. 结合产品源码与客开代码定位问题根因，先给出简短分析；如果证据不足以下结论，如实说明还缺什么，',
        '   并按第 4 条先补日志。可行的方案有多个时，**你自己挑一个你认为最合适的往下做**，不要停下来等用户选；',
        '   在结论里写一句你选的是哪个、为什么选它，以及被你放弃的方案是什么。',
        ...skillTask,
        '3. 代码类问题。**改代码或新增代码前，必须先参考客开工程自己的结构**：照同类既有文件决定放哪一层、',
        '   叫什么名、用哪套写法，不要按通用 Java 习惯或别的项目的样子来。具体做法：',
        `   a) **先只读地看清工程结构，再决定文件放哪一层**：不要预设工程长什么样 —— 先用 Glob/Read 在`,
        `      ${env.code_directory} 里看清「模块根」（含 src/ 的那一层，不是客开工程根、也不是模块下的某个`,
        '      子目录）、src 下实际有哪些 source 目录、同类既有文件都摆在哪个包下；要改/新增的每个文件放哪一层、',
        '      叫什么名、用哪套写法，全照这个工程自己的既有结构来。把模块根的绝对路径 + module_name +',
        '      每个文件所属的 source 目录写进结论.md。**层级不要猜**：补丁 zip 里每个 class 的目标路径完全由',
        '      暂存目录里的相对路径推出来，映射规则见 java-compiler-mcp skill 的 references/path-mapping.md',
        '      （如 src/client/*.java → hotwebs/fbip/WEB-INF/classes/…、src/private →',
        '      modules/<module_name>/META-INF/classes/…、src/public → modules/<module_name>/classes/…）。',
        '      工程结构与这套标准不一致时，以工程实际结构为准，并把你的判断依据写进结论。',
        '      写错一层，class 就会被打进补丁里错误的位置，部署后加载不到，等于白改。',
        `   b) 要改的文件已在客开工程里：从 ${env.code_directory} 只读地读出它，在 ${run.stage_dir} 下按**与工程逐层一致**的`,
        `      相对路径建副本（工程里 src/… 这几层怎么写就怎么保留，不要自创、不要省掉、不要改名）`,
        `      （例如 ${env.code_directory}/src/client/ncbs/x/Foo.java → ${patchNodeJoin(run.stage_dir, 'src')}\\client\\ncbs\\x\\Foo.java）；`,
        '      若工程里同一个类有多份同名文件，以和本次问题同一条调用链上的那份为准，并在结论里说明你选的是哪一份。',
        `   c) 要改的文件在客开工程里**并不存在**（你在新增类/新增文件）：不要去 ${env.code_directory} 找它，`,
        `      直接在 ${run.stage_dir} 下按它将来在工程里的相对路径新建（目录不存在就一并建出）`,
        `      （例如新增 ${patchNodeJoin(run.stage_dir, 'src')}\\client\\ncbs\\x\\NewHandler.java）；`,
        '      相对路径要与工程里**同类既有文件**逐层一致（先去只读地看一眼同类文件摆在哪个包下），',
        '      Java 文件的 package 声明必须与这条路径匹配（javac 与补丁目标路径都看它）。',
        '      若工程里找不到同类先例：把你要放的那一层和判断依据写进结论，不要换一个"看起来更合理"的层级。',
        `   d) 无论改还是新建，都只往 ${run.stage_dir} 里写，不要动 ${env.code_directory} 下的任何东西；`,
        '   e) 编译与打包一律走 java-compiler-mcp skill（见第 2 条）：编译用 java_compile、生成补丁 zip 用',
        '      java_generate_patch，参数如下（用法与常见错误以 skill 里的说明为准）：',
        `      module_path = ${run.stage_dir}`,
        '      module_name = <你在第 3a 步确定的模块名>',
        `      home        = ${env.package_path}`,
        '      files       = 你改过或新建的那些文件（相对 module_path 的路径），**所有改动文件一次传入**，',
        '                  不要逐文件调 java_compile（每次调用都会冷启动 MCP 并重新扫 home classpath，很慢）',
        `      java_home   = ${env.local_jdk_path}`,
        `      产物输出到 ${patchNodeTurnDir(run)}。打包完**把 zip 里的条目列出来自查一遍**（对照第 3a 条的目标路径），`,
        '      发现层级不对就重打包，不要带着错路径交付。',
        '4. 在你认为所有可能相关的类中补上特别详细的日志，日志必须尽可能全面。',
        '   把下次复现时要看的信息打全；这时第 1 步的结论就写"已补日志、待复现反馈"，不要猜一个根因糊弄过去。',
        '   补日志的具体要求：',
        '   a) **日志写到固定文件**：`nc.bs.framework.common.RuntimeEnv.getInstance().getNCHome() + "/nclogs"`，',
        `      日志文件名固定为 \`${run.log_file_name || 'ailog'}.log\`（运行期取 NCHome、不要写死绝对路径）。`,
        '      **不要为此新建独立类/工具类**（不新增文件、不新增类）；需要的话，直接在要加日志的类里写一个**私有静态辅助方法**',
        '      （如 `aiLog(String msg)`），方法内**同时**：调工程既有 `Logger.error` 输出到标准日志，并用 `FileWriter` 追加写 `nclogs/<文件名>.log`',
        '      （自建目录、写换行、`try/catch/finally` 确保关流、异常不抛出影响业务），业务代码里就调这个私有方法，',
        '      不要在每个位置裸写一遍文件 I/O，也不要为它单开一个类。',
        '   b) **日志必须非常详细**：用户打一次补丁不容易，要尽量靠**一次**日志就定位到问题。关键入参/返回值、',
        '      分支走向、循环里的每次迭代、条件判断的实际取值、耗时、异常栈、以及能串起上下文的东西',
        '      （单据号/主键/组织/线程名/调用方标识）都要打出来；宁可多打，不要只打一句"进入方法"。',
        '   c) 日志用工程自己已有的 logger 与级别约定，不要引入新的日志框架或依赖。',
        '   d) 加日志同样算本次改动：文件照 3b/3c 落到暂存目录、并写进 changes.txt，之后会随补丁同步回客开工程。',
        '   e) 可以在日志中执行数据库查询语句（只允许查询），**严禁执行增删改操作**，日志本身不能影响原有业务逻辑。',
        `5. 数据库/配置类问题：把需要用户执行的 SQL 写进 ${patchNodeJoin(patchNodeTurnDir(run), 'aisql.sql')}，实现方案写进 ${patchNodeJoin(patchNodeTurnDir(run), '方案.txt')}。`,
        `6. 把本次改动的文件清单（每行一个，相对 ${env.code_directory} 的路径；新增的文件同样要列）写进 ${patchNodeJoin(patchNodeTurnDir(run), 'changes.txt')}。`,
        `7. 把结论、模块根路径、module_name、每个文件所属的 source 目录，以及补丁 zip 的条目清单，`,
        `   写进 ${patchNodeJoin(patchNodeTurnDir(run), '结论.md')}。`,
        `8. 生成 HTML 对比报告：用 Skill 工具调用本机已安装的 \`diff-report\`，按它的工作流生成（需要本机装有 python）：`,
        `   a) 建合并基线目录 ${patchNodeJoin(patchNodeTurnDir(run), 'baseline')}，对 changes.txt 每一行相对路径：`,
        `      - ${env.code_directory} 下存在原文件 → 原样复制到 baseline\\<相对路径>（基线=客开工程原文件）；`,
        `      - 否则用 patch_source MCP 的 read_file 读标品源码：用 root=${mcpRoot}，path 写相对该 root 的路径`,
        `        （如 nc/impl/tb/plugin/ClockPluginImpl.java；相对路径 = work 里去掉 src 前缀后的路径）；先 list_roots 确认有该 root，`,
        '        没有就说明「该版本源码未挂载」并停手，不要猜路径；',
        '        读到的内容存到 baseline\\<相对路径>（基线=标品源码）；',
        '      - 客开、标品都没有 → 不建该文件（纯新增类）。',
        `   b) 用 diff-report skill 生成报告，配 config.py、写 analysis、跑 build_report.py 都按 skill 说明来；`,
        `      节点参数：ROOT=${patchNodeTurnDir(run)}，PROJECTS=[("diff","work","baseline")]，A_LABEL=生成代码，B_LABEL=基线，`,
        '      analysis 里纯新增类单独标「纯新增类（客开、标品均无）」；',
        `      产物：${patchNodeJoin(patchNodeTurnDir(run), '0_对比报告_首页.html')} 与 ${patchNodeTurnDir(run)}\\report\\diff.html。`,
        '      （若本机没有 python 或 diff-report skill，跳过报告生成并在结论.md 里说明，不得因此中断。）',
    ];
    lines.push(
        '',
        '【约束】',
        `- 绝对不要修改 ${env.code_directory} 下的任何文件，也不要新建或删除它下面的任何东西。`,
        '  （新增的类也一样先建在暂存目录里；用户点「问题已解决」后才会由你执行同步。）',
        '- 不要改动 .git 目录，不要执行 git commit / push / checkout。',
        '- 分析源码走 patch_source MCP，不要试图遍历整棵源码树（性能原因）。root 按产品版本选：',
        `  本次产品 ${env.product_name || ''} ${env.product_version || ''} → root=${mcpRoot}；path 写相对该 root 的包级路径`,
        '  （如 nc/impl/tb），禁止根级或宽泛模式（path=""、只写 root 名、或 **/X.java 全树模式）；先 list_roots 确认，',
        '  没有对应 root 就在结论里说明「该版本源码未挂载」并停手；一次检索只查一个包，宁可多查几次精确的，也不要一次全树扫。',
        '- **不要反编译 jar 包**：类在客开工程里找不到时，用 patch_source MCP 去产品源码（标品）里找；',
        '  源码里也没有，就在结论里说明「产品无此源码」，不要再继续找、更不要反编译 jar/class。',
        '- **不要在任何目录留下临时辅助脚本**（_check_clean_zip.py / _normalize_eol.py 或其它 .py/.sh/.bat）：',
        '  要临时检查/处理用现成命令内联做（unzip -l / jar tf / sed 等），不要生成脚本文件；确实要脚本的写到系统临时目录、用完即删，',
        '  绝不能留在补丁输出目录或客开工程里，也不计入 changes.txt / 结论。',
        '- 日志必须详细，尽量靠一次日志结果就能解决问题。',
        `- 收尾前在 ${env.code_directory} 执行 git status --porcelain：若输出非空，`,
        '  说明这个工程被改动过（可能是你、也可能是别的进程），把输出原样贴进结论并说明，不要自行回滚。',
    );
    if (env.db_connection) {
        lines.push(
            '- 数据库**只允许执行查询语句**（SELECT / SHOW / DESC / EXPLAIN 之类只读语句）。',
            '  INSERT / UPDATE / DELETE / DDL / 存储过程 / 加解锁语句**一律禁止**；拿不准算不算写操作就不要执行。',
            '  能开只读事务就用 START TRANSACTION READ ONLY 把查询包起来，多一层保险。',
            '  连库优先用本机已有的客户端或驱动（mysql 客户端、带 pymysql 的 python 等）；**不要为此安装任何依赖**，',
            '  连不上就停手，把你要跑的 SQL 原样写进结论，让用户自己执行。',
            '  连接串里通常带账号口令：**不要**把它抄进结论.md / changes.txt / 方案.txt 或任何要上报的文字里。',
        );
    }
    if (env.debug_address) {
        lines.push(
            '- 远程调试**只允许线程级**：只挂起/单步你正在看的那一个线程（jdb 用 `suspend <thread-id>`，',
            '  IDE 里把断点的挂起策略设成 Thread / 事件线程），**绝不要挂起整个进程**',
            '  （裸 `suspend`、Suspend All 策略、或不带 suspend=n 重启目标服务）。',
            '  看完就 resume 并断开连接，不要把调试器挂着不放——那台环境可能有人在用。',
        );
    }
    return lines.join('\n');
}

function patchNodePhaseTwoPrompt(run) {
    const env = run.env_snapshot || {};
    // 干净补丁命名：前缀（产品名版本+yyyymmddHHmm+_）前台算好；「问题简述」由 claude 自己概括填入。
    // patch_<产品名><版本>_<yyyymmddHHmm>_<问题简述>_znkf.zip
    const patchPrefix = patchNodePatchPrefix(run);
    return [
        '用户已确认问题已解决。',
        '**绝对禁止使用 git 提交或合并代码**：不要执行 git commit / push / merge / checkout / rebase，',
        '   也不要改动 .git 目录——只做文件级同步（复制/覆盖/新建），不要走 git。',
        '**不要在任何目录留下临时辅助脚本**（如 _check_clean_zip.py / _normalize_eol.py 或其它 .py/.sh/.bat）：',
        '   要临时检查补丁 zip 条目用现成命令（unzip -l / jar tf）内联做即可，不要生成脚本文件；',
        '   确实需要脚本的，写到系统临时目录、用完立即删除，绝不能留在补丁输出目录或客开工程里；',
        '   复制回客开工程或生成补丁时保持文件内容原样（不额外做行尾规范化），这些临时脚本也不计入 changes.txt / 合并说明。',
        `1. 读取 ${patchNodeJoin(patchNodeStepDirOf(run), 'changes.txt')}（本步的改动清单）。`,
        '2. 逐个文件先把排查日志（TbClockDebugLog 调用、为排查加的 Logger.error 输出等）全剥掉，再与基线 diff，判断相对基线到底改了什么：',
        '   **只改过日志、没有业务改动的文件**（排查日志全剥掉后，内容与基线完全相同）：整个文件不进 clean，',
        '   不同步回客开工程、不进最终补丁；纯新增的排查工具类（如 TbClockDebugLog）也按无业务改动处理，不进 clean。',
        `   **有业务改动的文件**：把『去掉了排查日志』的版本放进 ${patchNodeJoin(patchNodeTurnDir(run), 'clean')}（同相对路径），而不是把 ${run.stage_dir}（本步 work）原样拷过去；`,
        '   clean 里只留这些「去掉日志后相对基线仍有业务差异」的文件。要看带日志的原版就看 work；不要改动原始 work（补丁 zip 保持不动）。',
        '   被排除的纯日志文件，在合并说明里列一下文件名和排除原因。',
        `3. 把 ${patchNodeJoin(patchNodeTurnDir(run), 'clean')} 里清理后的文件，从 ${patchNodeJoin(patchNodeTurnDir(run), 'clean')} 复制回 ${env.code_directory} 的对应相对路径（覆盖）；`,
        '   清单里在客开工程中还不存在的（新增的类/文件）同样按相对路径建出来，目录不存在就一并建出。',
        '4. 若某个**已存在**的目标文件在此期间被改动，导致内容与暂存目录里的基线不一致，停止并报告，不要覆盖，也不要尝试自动合并；',
        '   新增文件若该路径已被别人创建出来，同样停止并报告。',
        `5. 重新生成「干净版补丁 zip」（能走到这一步说明第 4 步没有冲突）：用 java-compiler-mcp skill 的`,
        `   java_generate_patch，对 ${patchNodeJoin(patchNodeTurnDir(run), 'clean')} 里清理后的文件重新打包（做法同阶段一第 3e 步）：`,
        `   module_path = ${patchNodeJoin(patchNodeTurnDir(run), 'clean')}`,
        '   module_name = <阶段一第 3a 步确定的模块名>（必须与阶段一一致，class 目标路径才对得上）',
        `   home        = ${env.package_path}`,
        '   files       = clean 里实际存在的相对路径（相对 module_path=clean；按第 2 步过滤后的清单，**不是 changes.txt 的全部行**，纯日志文件已被排除不在 clean 里），一次传入',
        `   java_home   = ${env.local_jdk_path}`,
        `   产物输出到 ${patchNodeTurnDir(run)}，补丁 zip **命名格式固定为 ${patchPrefix}<问题简述>_znkf.zip**；`,
        '   其中 <问题简述> 由你结束时自己用最简短的话概括「这次到底解决了什么问题」（从最终修复的角度，',
        '   不要照抄用户原始描述的前几个字），控制在 ~20 字内，去掉 \\ / : * ? " < > |，空格用 _ 或直接省略；',
        `   例如 ${patchPrefix}回单查询报错查询数据为空_znkf.zip。`,
        '   打包完**把 zip 里的条目列出来自查一遍**（对照第 2 步 clean 里的相对路径），层级不对就重打包；',
        '   **再抽查 zip 里是去日志版**：用 unzip -p / zipgrep 查补丁里的新改源码，不得再出现本次阶段一加的排查日志标记',
        '   （TbClockDebugLog 调用、为排查加的 Logger.error 输出等）；发现有，就在 clean 里清干净后重新打包，直到 zip 干净为止。',
        '   **这个 clean 补丁才是最终要部署的补丁**（不含排查日志）；阶段一那个 zip 保留作对照，不要覆盖。',
        `6. 用 diff-report skill 重新生成 HTML 对比报告：对比的是**去日志后的 clean 版（只业务改动）** vs 基线——`,
        `   先把 ${patchNodeStepDirOf(run)}\\baseline 原样复制到 ${patchNodeTurnDir(run)}\\baseline`,
        '   （基线 = 客开工程原文件 / 标品源码，阶段一建的，没被本次同步污染），保证 clean 与 baseline 同根便于 diff-report；',
        `   ROOT=${patchNodeTurnDir(run)}，PROJECTS=[("diff","clean","baseline")]，A_LABEL=clean 业务改动，B_LABEL=基线，`,
        `   产物输出到 ${patchNodeTurnDir(run)}\\report\\diff.html；`,
        '   这份报告必须只反映「去掉排查日志后的业务改动」与基线的差异，确认 clean 与 clean 补丁里都不含排查日志。',
        `7. 把同步结果写入 ${patchNodeJoin(patchNodeTurnDir(run), '合并说明.md')}，并且**第一行固定写成**`,
        '   「结果：成功」或「结果：冲突」，后面再写详细清单。',
        `8. 生成总结：写到 ${patchNodeJoin(patchNodeTurnDir(run), '总结.md')}——`,
        '   用几段话总结这次问题的**根本原因**和**最终解决逻辑（机制）**：这次同步回客开工程、并打进 clean 补丁的改动',
        '   具体是怎么修的、触发条件与修复后的行为是什么；最后列一下本次改动的关键文件。',
        '   面向后续接手的人写，不要流水账式罗列排查过程。',
    ].join('\n');
}

// ── SSE：先 connected 再 start ──
async function patchNodeSendPrompt(run, prompt) {
    try {
        await patchNodeCcWeb(`/api/agent/${encodeURIComponent(run.session_id)}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: prompt }),
        });
    } catch (error) {
        patchNodeAppendText(`\n[启动失败] ${error.message}\n`);
        await patchNodeAfterTurn(run, `启动失败：${error.message}`);
    }
}

function patchNodeConnect(run, prompt) {
    patchNodeCloseStream();
    const state = patchState.node;
    const es = new EventSource(`/api/agent/${encodeURIComponent(run.session_id)}/events`);
    state.es = es;
    state.streaming = true;
    state.pendingPrompt = prompt;
    // 本轮耗时打点：start 事件填 startedAt；首个 thinking/chunk 填 firstTokenAt（首字延迟=思考耗时）；
    // tool_call→tool_result 的时间差即该工具耗时（java_compile=编译、java_generate_patch=打包、Bash/Skill=差异分析…）。
    state.timing = { startedAt: 0, firstTokenAt: 0, tools: {}, toolList: [] };
    es.onmessage = event => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        patchNodeHandleEvent(run, payload);
    };
    es.onerror = () => {
        // EventSource 自己会重连；只有这一轮已经收尾（es 已被换掉/清掉）时才不该刷屏
        if (patchState.node.es !== es) return;
        patchNodeAppendText('\n[与后端的连接中断，浏览器会自动重连…]\n');
    };
}

// 一轮结束：把本轮耗时汇总写进 run.timings（数组，阶段一/二各一条），并打日志（控制台 + 输出区）。
function patchNodeFinalizeTiming(run) {
    const t = patchState.node.timing;
    patchState.node.timing = null;
    if (!t || !t.startedAt) return;
    const now = Date.now();
    const entry = {
        stage: run.stage || 1,
        started_at: new Date(t.startedAt).toISOString(),
        total_ms: now - t.startedAt,
        first_token_ms: t.firstTokenAt ? t.firstTokenAt - t.startedAt : null,
        tools: t.toolList.slice(),
    };
    run.timings = Array.isArray(run.timings) ? run.timings : [];
    run.timings.push(entry);
    if (run.timings.length > 20) run.timings = run.timings.slice(-20);   // 防无限增长
    const sec = ms => (ms / 1000).toFixed(1) + 's';
    const lines = [`【耗时】阶段${entry.stage} 总耗时 ${sec(entry.total_ms)}` + (entry.first_token_ms != null ? `，首字延迟(思考) ${sec(entry.first_token_ms)}` : '')];
    entry.tools.forEach(x => lines.push(`  · ${x.name} ${sec(x.ms)}`));
    try { console.log('[node-timing]', lines.join('\n')); } catch (e) {}
    patchNodeAppendText('\n' + lines.join('\n') + '\n');
}

function patchNodeHandleEvent(run, event) {
    // 回调闭包里的 run 可能已经和面板/列表渲染的那一份脱钩（loadProblemRuns 会换对象），
    // 一律改「正在显示的那一份」，否则改了没人看。
    run = patchNodeLiveRun(run);
    switch (event.type) {
        case 'connected':
            // 必须等 connected：SSE 没有历史回放，先 start 会丢开头的事件（方案 20.13）
            if (patchState.node.pendingPrompt) {
                const prompt = patchState.node.pendingPrompt;
                patchState.node.pendingPrompt = null;
                patchNodeSendPrompt(run, prompt);
            }
            break;
        case 'start':
            if (patchState.node.timing) patchState.node.timing.startedAt = Date.now();  // 本轮计时起点
            // claude 的真实会话 id：上报 claude_session_id、拼「查看会话」链接都要它
            if (event.agentSessionId && run.agent_session_id !== event.agentSessionId) {
                run.agent_session_id = event.agentSessionId;
                patchNodeSaveRun(run).catch(() => {});
            }
            // 立刻重渲染：run.session_id 早在建会话时就写好了，「查看会话」这时就该能点，
            // 不必等这次跑完（以前只有收尾的 loadProblemRuns 才会重画按钮，执行期间点不到）。
            patchNodeRenderRunPanel(run);
            patchNodeRenderRuns();
            patchNodeAppendText('会话已就绪，开始执行。\n\n');
            break;
        case 'chunk':
            if (patchState.node.timing && !patchState.node.timing.firstTokenAt) patchState.node.timing.firstTokenAt = Date.now();
            patchNodeAppendText(event.content || '');
            break;
        case 'thinking':
            if (patchState.node.timing && !patchState.node.timing.firstTokenAt) patchState.node.timing.firstTokenAt = Date.now();
            patchNodeAppendText(`\n💭 ${patchNodeInline(event.thinking, 240)}\n`);
            break;
        case 'tool_call':
            if (patchState.node.timing && event.id) patchState.node.timing.tools[event.id] = { name: event.name || 'tool', at: Date.now() };
            patchNodeAppendText(`\n▶ ${event.name || 'tool'} ${patchNodeInline(patchNodeToolArgs(event.input), 240)}\n`);
            break;
        case 'tool_result': {
            const timing = patchState.node.timing;
            if (timing && event.id && timing.tools[event.id]) {
                const started = timing.tools[event.id];
                timing.toolList.push({ name: started.name, ms: Date.now() - started.at });
                delete timing.tools[event.id];
            }
            patchNodeAppendText(`  ↳ ${patchNodeInline(event.output, 320)}\n`);
            break;
        }
        case 'result':
            patchNodeAppendText(`\n\n${event.content || ''}\n`);
            patchNodeFinalizeTiming(run);
            patchNodeAfterTurn(run, event.content || '');
            break;
        case 'error':
            // 标记执行出错：settle 后 phase 仍是 awaiting_decision，状态靠这个标记显示「执行出错」
            run.error = true;
            patchNodeAppendText(`\n[出错了] ${event.message || '未知错误'}\n`);
            patchNodeFinalizeTiming(run);
            patchNodeAfterTurn(run, `执行出错：${event.message || '未知错误'}`);
            break;
        default:
            break;
    }
}

function patchNodeToolArgs(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try { return JSON.stringify(input); } catch { return String(input); }
}

// 一轮执行结束（阶段一或阶段二都会走到这里）
// 已解决后把完整会话内容存档到服务器（管理员可查）。fire-and-forget，失败静默，session_archived 去重。
// 内容源 = 本机 claude 会话 jsonl（经 /api/claude-sessions 解析出的完整会话，user/assistant/tool_use/tool_result）。
async function patchNodeArchiveSession(run) {
    if (run.session_archived === true) return;          // 已存过不重复
    const sid = run.agent_session_id;
    if (!sid) return;                                   // 拿不到 claude 会话 id 就跳过
    const payload = await patchNodeCcWeb(`/api/claude-sessions/${encodeURIComponent(sid)}?full=1`).catch(() => null);
    if (!payload || !Array.isArray(payload.messages)) return;
    const env = run.env_snapshot || {};
    const body = {
        local_run_id: run.id,
        product_name: env.product_name || null,
        product_version: env.product_version || null,
        module_name: null,
        problem_desc: run.problem_desc || null,
        session_id: run.session_id || null,
        agent_session_id: sid,
        message_count: payload.messages.length,
        conversation_json: JSON.stringify(payload.messages),
        verdict: run.verdict || 'solved',
        solved_at: new Date().toISOString(),
    };
    await patchRequest('/api/problem-run-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    run.session_archived = true;
    patchNodeSaveRun(run).catch(() => {});
}

async function patchNodeAfterTurn(run, report) {
    patchNodeCloseStream();
    if (report) run.report = report;
    run.finished_at = new Date().toISOString();
    await patchNodeSettleRun(run);
    await patchNodeSaveRun(run).catch(() => {});
    patchNodeReport(run);
    // 真正已解决（阶段二成功落终态）→ 把完整会话内容存档到服务器（管理员可查）
    if (run.verdict === 'solved') patchNodeArchiveSession(run).catch(() => {});
    patchNodeRenderRunPanel(run);
    await loadProblemRuns();
}

// 收尾：定 phase（阶段一 → 待判定；阶段二 → 按「合并说明.md」第一行定成败）+ 读产物清单。
// 两条路共用：实时收到 result 事件、以及事后对账（见 patchNodeReconcileRuns）。
async function patchNodeSettleRun(run) {
    if (run.phase === 'merging') {
        // 阶段二收尾：唯一可靠的判据是 claude 写的「合并说明.md」第一行
        let verdict = 'merge_failed';
        try {
            const note = await patchNodeReadTextFile(patchNodeJoin(patchNodeTurnDir(run), '合并说明.md'));
            const matched = PATCH_NODE_MERGE_RE.exec(note);
            if (matched) verdict = matched[1] === '成功' ? 'solved' : 'merge_failed';
        } catch (error) {
            // 文件读不到 → 一律按未成功，让用户用 git 核对，不谎报已解决
        }
        if (verdict === 'solved') {
            // 合并成功：终态已解决
            run.failure = null;
            run.phase = 'done';
            run.verdict = 'solved';
        } else {
            // 合并失败/出错：落成 failed+merge（显示「合并失败」），操作列保留「重新合并」入口
            run.failure = 'merge';
            run.phase = 'failed';
            run.verdict = null;
        }
        // 阶段二产物是 总结.md（最终逻辑与原因），用它作为结论展示（优先于 claude 的收尾短消息）
        try {
            const summary = (await patchNodeReadTextFile(patchNodeJoin(patchNodeTurnDir(run), '总结.md'))).trim();
            if (summary) run.report = summary;
        } catch (error) { /* 没有 总结.md 就不覆盖 */ }
    } else {
        // 阶段一结束（含中途出错）→ 交给用户判定；真正的"失败"只留给合并失败与中断
        run.phase = 'awaiting_decision';
    }
    try {
        run.artifacts = (await patchNodeReadDir(patchNodeTurnDir(run))).filter(item => !item.is_dir).map(item => item.path);
    } catch (error) {
        // 产物目录读不到（claude 没建成/路径不对）不影响判定，产物清单留空
    }
    if (!run.report) {
        // 对账这条路上没有 result 事件的正文：依次尝试 claude 按提示词写的结论文件
        // （阶段一=结论.md，阶段二=总结.md），谁在就用谁。
        for (const name of ['结论.md', '总结.md']) {
            try {
                const text = (await patchNodeReadTextFile(patchNodeJoin(patchNodeTurnDir(run), name))).trim();
                if (text) { run.report = text; break; }
            } catch (error) { /* 该文件不存在，试下一个 */ }
        }
    }
}

// 与后端对账：把"其实早就跑完、但浏览器没收到 result 事件"的 run 收尾。
//
// Why：一轮结束的判定只发生在浏览器里（收到 SSE 的 result 事件才把 phase 从 analyzing
// 改掉），而 cc-web 的 /api/agent/{id}/events **没有历史回放**（只做 subscribe）。所以只要
// 收尾那一刻这个页面不在——点了「查看会话」跳走、刷新、关掉标签页、或者 cc-web 中途重启过
// ——事件就永远收不到，run 会一直显示"执行中"，而且没有任何东西会来纠正它（「详情」
// 只读账本，不重连、也不对账）。后端其实一直知道真相：/api/sessions 的 isStreaming 就是
// "这个会话还有没有一次流式输出在跑"。所以列清单时问一次，不在跑了就按磁盘产物收尾。
//
// 两道保险，避免把"刚要开始跑"的一轮误判成结束：
//   - 没有 session_id 的（cc-web 会话还没建出来）不碰；
//   - 建出来不到 60 秒的不碰（/api/agent/new 返回后到真正 start 之间有一小段窗口）。
async function patchNodeReconcileRuns() {
    const pending = (patchState.node.runs || []).map(entry => entry.local).filter(run =>
        run && (run.phase === 'analyzing' || run.phase === 'merging') && run.session_id &&
        Date.now() - new Date(run.created_at).getTime() > 60000);
    if (!pending.length) return;
    let live;
    try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        live = new Set((data.sessions || []).filter(session => session.isStreaming).map(session => session.id));
    } catch (error) {
        // 问不到后端就什么都不做：宁可暂时显示执行中，也不要误判还在跑的一轮
        return;
    }
    for (const run of pending) {
        if (live.has(run.session_id)) continue;
        console.warn('[node] 对账：run', run.id, '后端已不在执行，按磁盘产物收尾');
        run.finished_at = new Date().toISOString();
        await patchNodeSettleRun(run);
        await patchNodeSaveRun(run).catch(() => {});
        patchNodeReport(run);
        // 收尾那一刻页面不在的已解决 run，也要把会话存档补上
        if (run.verdict === 'solved') patchNodeArchiveSession(run).catch(() => {});
    }
}

// 从详情页点「返回」回到智能开发页时，保证重新查询一次本机运行记录。
// 详情页的返回按钮是跳 /patches.html?tab=node（整页重载，init 会走 loadProblemRuns）；
// 但若从详情页用浏览器返回 / bfcache 恢复回来（不会重新执行页面 init，列表停在旧 DOM），
// 用 pageshow.persisted 兜底再查一次，避免列表状态/按钮停在旧值。
window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;   // 常规首次加载：init 已经查过，不用重复
    const nodePanel = document.getElementById('patchTabNode');
    if (nodePanel && !nodePanel.hidden && patchToken() && !patchState.authInvalidated) {
        loadProblemRuns().catch(() => {});
    }
});

// ── 会话存档（管理员）：已解决 run 的完整会话内容，按账号/产品/工单过滤 + 分页 ──
// 分页状态用 {page,size,total} 以对接统一分页条（size 即 page_size）。
const patchSessions = { page: 1, size: 20, total: 0, filters: { user_id: '', product: '', local_run_id: '' } };

function patchSessionsQueryString() {
    const q = new URLSearchParams();
    if (patchSessions.filters.user_id) q.set('user_id', patchSessions.filters.user_id);
    if (patchSessions.filters.product) q.set('product', patchSessions.filters.product);
    if (patchSessions.filters.local_run_id) q.set('local_run_id', patchSessions.filters.local_run_id);
    q.set('page', String(patchSessions.page));
    q.set('page_size', String(patchSessions.size));
    return q.toString();
}

async function loadRunSessions() {
    const body = document.getElementById('patchSessionsBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="7" class="patch-empty">正在加载...</td></tr>';
    try {
        // patchRequest 已拆 {code,data} 直接返回 data（= {total,page,page_size,items}），不要再 .data
        const payload = (await patchRequest(`/api/problem-run-sessions?${patchSessionsQueryString()}`)) || {};
        patchSessions.total = Number(payload.total) || 0;
        patchSessions.page = Number(payload.page) || patchSessions.page;
        patchSessions.size = Number(payload.page_size) || patchSessions.size;
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (!items.length) {
            body.innerHTML = '<tr><td colspan="7" class="patch-empty">暂无存档</td></tr>';
        } else {
            body.innerHTML = items.map(row => `<tr>
                <td>${patchEscape(patchFormatDateTime(row.solved_at ? new Date(row.solved_at) : new Date(row.created_at)))}</td>
                <td>${patchEscape(String(row.created_by_user_id ?? '—'))}</td>
                <td>${patchEscape(`${row.product_name || '—'} ${row.product_version || ''}`.trim())}</td>
                <td><span class="patch-truncated-name" title="${patchEscape(row.problem_desc || '')}">${patchEscape(patchNodeInline(row.problem_desc || '—', 50))}</span></td>
                <td>${patchEscape(String(row.message_count ?? 0))}</td>
                <td><span class="patch-muted">${patchEscape(String(row.agent_session_id || '—').slice(0, 8))}</span></td>
                <td><button class="patch-link-btn" data-session-view="${patchEscape(row.local_run_id)}">查看</button></td>
            </tr>`).join('');
        }
        const totalPages = Math.max(1, Math.ceil(patchSessions.total / patchSessions.size));
        patchRenderPager('sessions');
    } catch (error) {
        body.innerHTML = `<tr><td colspan="7" class="patch-empty">加载失败：${patchEscape(error.message)}</td></tr>`;
        patchShowError(error.message, '会话存档加载失败');
    }
}

// 把存档的会话 messages（cc-web Message，含 content_blocks）渲染成可读 HTML。
function renderSessionMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return '<p class="patch-muted">（无内容）</p>';
    return messages.map(msg => {
        const role = msg.role === 'user' ? '用户' : '助手';
        const blocks = Array.isArray(msg.content_blocks) ? msg.content_blocks : [];
        const extras = blocks.map(block => {
            const type = block.type;
            if (type === 'thinking') {
                return `<details class="session-block session-think"><summary>💭 思考</summary><pre class="session-pre">${patchEscape(String(block.thinking ?? ''))}</pre></details>`;
            }
            if (type === 'tool_use') {
                const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
                return `<details class="session-block session-tool"><summary>🛠 ${patchEscape(String(block.name || 'tool'))}</summary><pre class="session-pre">${patchEscape(input)}</pre></details>`;
            }
            if (type === 'tool_result') {
                return `<details class="session-block session-tool"><summary>↳ 工具结果</summary><pre class="session-pre">${patchEscape(String(block.content ?? ''))}</pre></details>`;
            }
            return '';
        }).join('');
        const text = String(msg.content || '');
        const body = text ? `<div class="session-text">${patchEscape(text).replace(/\n/g, '<br>')}</div>` : '';
        return `<div class="session-msg"><span class="session-role">${role}</span>${body}${extras}</div>`;
    }).join('');
}

async function openRunSession(localRunId) {
    let row;
    try {
        // patchRequest 已拆 {code,data} 直接返回 data（= 单条存档行），不要再 .data
        row = (await patchRequest(`/api/problem-run-sessions/${encodeURIComponent(localRunId)}`)) || {};
    } catch (error) { patchShowError(error.message, '查看会话失败'); return; }
    let messages = [];
    try { messages = JSON.parse(row.conversation_json || '[]'); } catch (err) { messages = []; }
    const overlay = document.createElement('div');
    overlay.className = 'file-overlay';
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    const title = `${row.product_name || ''} ${row.product_version || ''}`.trim() || '会话存档';
    overlay.innerHTML = `<div class="file-viewer session-viewer">
        <div class="file-viewer-header"><span class="file-viewer-name">📋 ${patchEscape(title)} · 已解决会话</span><button class="file-viewer-close" type="button">×</button></div>
        <div class="file-viewer-content session-scroll">${renderSessionMessages(messages)}</div>
    </div>`;
    overlay.querySelector('.file-viewer-close').onclick = () => overlay.remove();
    document.body.appendChild(overlay);
}


// ── 新建 run ──
async function patchNodeOpenForm() {
    const form = document.getElementById('patchNodeRunForm');
    form.reset();
    document.getElementById('patchNodeEnvHint').textContent = '';
    const select = form.env_id;
    select.innerHTML = '<option value="">加载产品环境变量中...</option>';
    document.getElementById('patchNodeFormModal').hidden = false;
    let envs = [];
    try {
        envs = (await patchRequest('/api/project-envs')) || [];
    } catch (error) {
        select.innerHTML = '<option value="">加载失败</option>';
        patchShowError(error.message, '产品环境变量加载失败');
        return;
    }
    patchState.admin.projectEnvs = envs;
    if (!envs.length) {
        select.innerHTML = '<option value="">（还没有产品环境变量）</option>';
        return;
    }
    select.innerHTML = ['<option value="">请选择产品环境</option>'].concat(
        envs.map(item => `<option value="${patchEscape(item.id)}">${patchEscape(`${item.project_name}（${item.product_name} ${item.product_version}）`)}</option>`)
    ).join('');
}

function patchNodeEnvHint() {
    const form = document.getElementById('patchNodeRunForm');
    const hint = document.getElementById('patchNodeEnvHint');
    const env = (patchState.admin.projectEnvs || []).find(item => String(item.id) === String(form.env_id.value));
    if (!env) { hint.textContent = ''; return; }
    const jdk = env.local_jdk_path ? env.local_jdk_path : '未登记（编译前需要补）';
    hint.textContent = `客开代码目录：${env.code_directory || '—'}　|　home/war：${env.package_path || '—'}　|　JDK：${jdk}`;
}

async function patchNodeStartRun(event) {
    event.preventDefault();
    const form = event.target;
    const values = Object.fromEntries(new FormData(form).entries());
    document.getElementById('patchNodeMessage').textContent = '';
    const problemDesc = String(values.problem_desc || '').trim();
    if (!problemDesc) { patchShowError('问题/需求描述为必填项', '智能开发创建失败'); form.problem_desc.focus(); return; }
    const triggerUrl = String(values.trigger_url || '').trim();
    if (!triggerUrl) { patchShowError('触发的url为必填项', '智能开发创建失败'); form.trigger_url.focus(); return; }
    const env = (patchState.admin.projectEnvs || []).find(item => String(item.id) === String(values.env_id));
    if (!env) { patchShowError('请选择关联的产品环境变量', '智能开发创建失败'); return; }
    if (!patchNodeIsAbsolutePath(env.code_directory)) {
        patchShowError('该产品环境变量里的「客开代码目录」不是绝对路径，请先到「产品环境变量」页签改正。', '智能开发创建失败');
        return;
    }
    const outParent = String(values.patch_output_path || '').trim();
    if (!outParent) { patchShowError('补丁输出路径为必填项（没有默认值，每次自己填）', '智能开发创建失败'); form.patch_output_path.focus(); return; }
    if (!patchNodeIsAbsolutePath(outParent)) { patchShowError('补丁输出路径必须是绝对路径，例如 D:\\patch-runs\\crm-20260920', '智能开发创建失败'); form.patch_output_path.focus(); return; }
    const logInfo = String(values.log_info || '');
    // 日志文件名称（不带后缀）：去尾缀、去非法字符，空则默认 ailog。提示词第 4a 步用它拼 <名字>.log。
    const logFileName = String(values.log_file_name || '')
        .trim().replace(/\.(log|txt)$/i, '').replace(/[\\/:*?"<>|\s]+/g, '_') || 'ailog';
    // code_directory 是 claude 的工作目录，不存在的话后面 spawn 阶段才会报错，提示会很难懂
    try {
        await patchNodeCcWeb(`/api/files?path=${encodeURIComponent(env.code_directory)}`);
    } catch (error) {
        patchShowError(`客开代码目录读不到：${env.code_directory}（${error.message}）`, '智能开发创建失败');
        return;
    }

    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const outDir = patchNodeJoin(outParent, id);
    const run = {
        id,
        problem_desc: problemDesc,
        trigger_url: triggerUrl,
        env_id: env.id,
        // 存快照而不是只存 env_id：环境条目事后再被编辑/删除，这条 run 仍然自解释
        env_snapshot: {
            project_name: env.project_name,
            product_id: env.product_id,
            version_id: env.version_id,
            product_name: env.product_name,
            product_version: env.product_version,
            code_directory: env.code_directory,
            package_path: env.package_path,
            local_jdk_path: env.local_jdk_path || '',
            // skill 库根目录：阶段一提示词按它点名要读的 SKILL.md（java-compiler-mcp / fbip-skill-router）。
            // 只在本机用，不上报（patchNodePushReport 是白名单）。
            local_skill_path: env.local_skill_path || '',
            // 数据库连接串与远程调试口都给 claude 用（阶段一提示词的【环境】段）。
            // 注意 db_connection 通常含账号口令 → 会随本机 node_runs.json 落盘一份，别再上报/展示。
            db_connection: env.db_connection || '',
            debug_address: env.debug_address || '',
        },
        patch_output_path: outParent,
        out_dir: outDir,
        // 每「步」一个子目录，重跑不覆盖：新建 run 阶段一第 1 次 → outDir\step01；
        // 之后「未解决」重跑会前进到 step02…；「已解决」进入阶段二时 turn_dir 换成 outDir\result。
        phase1_step: 1,
        step_dir: patchNodeStepDir(outDir, 1),                     // 阶段一当前步目录 outDir\step01
        turn_dir: patchNodeStepDir(outDir, 1),                     // 本步产物目录（阶段一=step01）
        stage_dir: patchNodeJoin(patchNodeStepDir(outDir, 1), 'work'),
        // 日志是"给 claude 定位问题"的输入：全文进提示词，这里只留一份短的行内副本备查，
        // 不再让 claude 抄到 outDir（原 logs.txt 那步已去掉）。
        log_info_inline: logInfo.length <= PATCH_NODE_LOG_INLINE_LIMIT ? logInfo : '',
        // 本次排查日志文件名（不带后缀），提示词第 4a 步拼成 <name>.log 写到 NCHome/nclogs
        log_file_name: logFileName,
        session_id: '',
        agent_session_id: '',
        phase: 'analyzing',
        verdict: null,
        failure: null,
        // 当前/最近执行的阶段：1=问题分析，2=合并。重跑与「重新执行/重新合并」按钮都靠它定位。
        stage: 1,
        retry_count: 0,
        report: '',
        artifacts: [],
        client_host: patchState.node.host || '',
        // 归属：本机运行记录是机器级（node_runs.json 不分账号），必须打上当前登录用户，
        // 列表/详情按它过滤，否则切账号还能看到别人在本机跑的运行。
        user_id: (patchState.user && patchState.user.id) || null,
        reported: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    try {
        await patchNodeSaveRun(run);
    } catch (error) {
        patchShowError(error.message, '本机运行清单写入失败');
        return;
    }
    form.reset();
    document.getElementById('patchNodeEnvHint').textContent = '';
    document.getElementById('patchNodeFormModal').hidden = true;
    patchState.node.current = run;
    patchState.node.liveTranscript = '';
    patchNodeAppendText(`【阶段一】在客开工程里只读分析，改动只写暂存目录。\n客开工程：${env.code_directory}\n暂存目录：${run.stage_dir}\n\n正在创建 cc-web 会话…\n`);
    patchNodeFlushOutput();
    patchNodeRenderRunPanel(run);
    patchNodeReport(run);
    await loadProblemRuns();
    // loadProblemRuns 把 patchState.node.current 换成了从磁盘重新解析的那一份，
    // 后面一律用「现在正显示的那一份」，否则 session_id 写进了没人看的副本。
    const live = patchNodeLiveRun(run);
    try {
        const created = await patchNodeCcWeb('/api/agent/new', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd: env.code_directory, assistant: 'claude' }),
        });
        live.session_id = created.sessionId;
        // 后端必须回 sessionId，否则就是个"没会话的执行中"，按钮/详情全会是空的——宁可明确报错也别静默
        if (!live.session_id) {
            patchNodeAppendText(`\n创建会话失败：后端未返回 sessionId（${created.error || '未知原因'}）\n`);
            await patchNodeAfterTurn(live, '创建会话失败：后端未返回 sessionId');
            return;
        }
        await patchNodeSaveRun(live).catch(error => console.error('[node] 保存 session_id 失败：', error));
    } catch (error) {
        patchNodeAppendText(`\n创建会话失败：${error.message}\n`);
        await patchNodeAfterTurn(live, `创建会话失败：${error.message}`);
        return;
    }
    // session_id 一有就该能点「查看会话」
    patchNodeRenderRunPanel(live);
    patchNodeRenderRuns();
    patchNodeConnect(live, patchNodePhaseOnePrompt(live, logInfo));
}

// ── 判定与收尾 ──
async function patchNodeSolved(run) {
    // 合并由 claude 执行，而 changes.txt 是 claude 自己写的，理论上可能漏写/写错
    // （方案 20.14 的已知风险），所以先把它摆给用户看，再二次确认。
    let changes = '';
    try {
        changes = await patchNodeReadTextFile(patchNodeJoin(patchNodeStepDirOf(run), 'changes.txt'));
    } catch (error) {
        changes = `（读不到 changes.txt：${error.message}）`;
    }
    const shown = changes.length > 2000 ? `${changes.slice(0, 2000)}\n…（已截断）` : changes;
    const ok = await patchConfirm(
        `将从暂存目录同步回客开工程：${(run.env_snapshot || {}).code_directory || ''}\n\n${shown}`,
        '确认问题已解决'
    );
    if (!ok) return;
    run.phase = 'merging';
    run.stage = 2; // 进入合并阶段：重跑/状态区分按阶段二算
    // 阶段二产物统一收进 outDir\result（重新合并沿用同一 result，不新增步骤）
    run.turn_dir = patchNodeJoin(run.out_dir, 'result');
    // 进入阶段二：本段产物/结论清零——阶段二的 result 目录刚开始还没产出，让详情页的资源管理器（已指向 result）、
    // 产物栏、结论保持一致，不再显示上一阶段（阶段一）的旧成果；阶段二收尾时 settle 再写入新结果。
    run.artifacts = [];
    run.report = '';
    patchNodeRenderRunPanel(run);
    patchNodeAppendText(`\n\n【阶段二】用户已确认已解决，开始把 ${run.stage_dir} 同步回客开工程…\n`);
    patchNodeFlushOutput();
    await patchNodeSaveRun(run).catch(() => {});
    patchNodeReport(run);
    // 已解决/未解决等状态变化后重新拉取列表，让状态列即时更新（不再依赖手动刷新按钮）
    await loadProblemRuns({ skipReconcile: true });
    // 阶段二复用同一个 cc-web 会话 → 同一个 claude 会话（上下文延续），cwd 也没变
    patchNodeConnect(run, patchNodePhaseTwoPrompt(run));
}

// ── 未解决 / 重新执行 / 重新合并：两种续跑 ──
// 未解决（待判定）→ 弹框上传日志 → 阶段一提示词 + 日志一起发给 claude；
// 重新执行 / 重新合并（执行出错 / 合并失败 / 已中断）→ 直接发「继续」，靠 --resume 上下文延续。

// 重新执行 / 重新合并（执行出错 / 合并失败 / 已中断）：直接发「继续」，靠 --resume 上下文延续
function patchNodeRerun(run) {
    run.phase = run.stage === 2 ? 'merging' : 'analyzing';
    run.error = false;
    run.failure = null;
    run.verdict = null;
    run.report = '';
    run.retry_count = (run.retry_count || 0) + 1;
    patchNodeAppendText(`\n\n【重跑】第 ${run.retry_count} 次执行${run.stage === 2 ? '合并' : '阶段一'}（发「继续」）…\n`);
    patchNodeFlushOutput();
    patchNodeSaveRun(run).catch(() => {});
    patchNodeReport(run);
    patchNodeRenderRunPanel(run);
    // 重新执行/重新合并后也重新拉取列表，状态列即时更新
    loadProblemRuns({ skipReconcile: true }).catch(() => {});
    patchNodeConnect(run, '继续');
}

// 未解决（待判定）：弹框上传日志文件（必填）→ 拼到阶段一提示词后面一起交给 claude
let patchNodeRerunTarget = null;

function patchNodeUnsolved(run) {
    patchNodeRerunTarget = run;
    const retry = (run.retry_count || 0) + 1;
    document.getElementById('patchNodeRerunMeta').textContent =
        `将重跑：阶段一 · 问题分析（第 ${retry} 次）。请上传本次复现的日志文件（必填），会拼到阶段一提示词后面一起交给 claude，上下文延续。`;
    document.getElementById('patchNodeRerunFile').value = '';
    document.getElementById('patchNodeRerunSql').value = '';
    document.getElementById('patchNodeRerunModal').hidden = false;
}

// 读上传的日志文件：UTF-8 优先，出现乱码替换符则按 GBK 重解；超过 1MB 截断
function patchNodeReadLogFile(file, maxBytes) {
    const slice = file.size > maxBytes ? file.slice(0, maxBytes) : file;
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const buf = reader.result;
                let text = new TextDecoder('utf-8').decode(buf);
                if (text.includes('\uFFFD')) text = new TextDecoder('gbk').decode(buf);
                if (file.size > maxBytes) text += '\n…（日志过大，已截断，只保留前 1MB）';
                resolve(text);
            } catch (error) {
                reject(new Error('解析日志文件编码失败'));
            }
        };
        reader.onerror = () => reject(new Error('读取日志文件失败'));
        reader.readAsArrayBuffer(slice);
    });
}

async function patchNodeUnsolvedConfirm() {
    const run = patchNodeRerunTarget;
    if (!run) return;
    // 日志文件必填
    const fileInput = document.getElementById('patchNodeRerunFile');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) {
        patchShowError('请先选择要上传的日志文件', '未解决');
        return;
    }
    let content;
    try {
        content = await patchNodeReadLogFile(file, 1000000);
    } catch (error) {
        patchShowError(error.message, '未解决');
        return;
    }
    patchNodeRerunTarget = null;
    document.getElementById('patchNodeRerunModal').hidden = true;
    const retry = (run.retry_count || 0) + 1;
    // 未解决 = 开一个新「步」：阶段一产物/暂存目录前进一步（step01→step02…），旧步保留不覆盖
    run.phase1_step = (run.phase1_step || 0) + 1;
    run.step_dir = patchNodeStepDir(run.out_dir, run.phase1_step);
    run.turn_dir = run.step_dir;
    run.stage_dir = patchNodeJoin(run.step_dir, 'work');
    // 明说新 step：阶段一提示词在之前的上下文里还指向旧 step 目录，必须先覆盖它
    let prompt = `【本次为第 ${run.phase1_step} 次执行（新开 ${run.step_dir}）】所有产物（changes.txt / 结论.md / 补丁 zip / baseline / report / aisql.sql）都写到 ${run.turn_dir}；改动只写暂存目录 ${run.stage_dir}。之前提示词里更早的目录一律作废。\n\n${patchNodeUnsolvedGuidance(run)}\n\n${content}\n\n以上是详细的日志信息，请你根据这个日志信息帮我解决问题`;
    const sqlText = (document.getElementById('patchNodeRerunSql').value || '').trim();
    if (sqlText) prompt += `\n\n【用户提供的 SQL 结果集】\n${sqlText}`;
    // 重置运行态，回到阶段一；同一会话续跑
    run.phase = 'analyzing';
    run.error = false;
    run.failure = null;
    run.verdict = null;
    run.report = '';
    run.retry_count = (run.retry_count || 0) + 1;
    patchNodeAppendText(`\n\n【重跑】已上传日志 ${file.name}（${(file.size / 1024).toFixed(0)}KB），第 ${run.retry_count} 次执行阶段一…\n`);
    patchNodeFlushOutput();
    await patchNodeSaveRun(run).catch(() => {});
    patchNodeReport(run);
    patchNodeRenderRunPanel(run);
    // 未解决确认后重新拉取列表，让状态列即时更新（不再依赖手动刷新按钮）
    await loadProblemRuns({ skipReconcile: true });
    patchNodeConnect(run, prompt);
}

// 面板按钮统一分发：待判定（未解决）→ 上传日志；其余（重新执行/重新合并/已中断）→ 发「继续」
function patchNodeRerunOrUnsolved(run) {
    if (run.phase === 'awaiting_decision' && !run.error) return patchNodeUnsolved(run);
    return patchNodeRerun(run);
}

async function patchNodeAbort(run) {
    if (!run.session_id) return;
    try {
        await patchNodeCcWeb(`/api/agent/${encodeURIComponent(run.session_id)}/abort`, { method: 'POST' });
    } catch (error) {
        // 中断失败也照样把本地状态落成"已中断"，免得会话永远停在"执行中"
        console.warn('[node] 中断请求失败：', error.message);
    }
    patchNodeCloseStream();
    run.phase = 'failed';
    run.failure = 'aborted';
    run.report = run.report || '已由用户中断。';
    run.finished_at = new Date().toISOString();
    patchNodeAppendText('\n[已中断]\n');
    patchNodeFlushOutput();
    await patchNodeSaveRun(run).catch(() => {});
    patchNodeReport(run);
    patchNodeRenderRunPanel(run);
    await loadProblemRuns();
}

// 「查看会话」复用第十八章的跳转协议。cwd 必须传 code_directory ——
// --resume 与 cwd 强绑定，传成 stageDir/outDir 会直接 No conversation found。
// 「查看会话」：只是去聊天页看这次 claude 会话，**不新建会话**。
// 带两个 id：session（cc-web 会话 id）用来选中会话并挂 SSE 看实时输出；
// history（claude 的会话 id）兜底 —— 万一那个 cc-web 会话已被删，就按它读本机
// ~/.claude/projects/*/<sid>.jsonl 做只读回放（见 app.js 的 resumeSessionFromUrl）。
function patchNodeResumeSession(run) {
    const query = new URLSearchParams();
    if (run.session_id) query.set('session', run.session_id);
    if (run.agent_session_id) query.set('history', run.agent_session_id);
    // 两个 id 都没有（老记录、或别的机器上跑的 run）——按钮本来就不显示，这里只是兜一层
    if (![...query].length) return;
    location.href = `/chat.html?${query}`;
}

async function patchNodeRemoveRun(run) {
    const ok = await patchConfirm(
        `从本机运行清单里删除这条记录？\n\n不会删除补丁输出目录里的产物（${run.out_dir || '—'}），也不会删除 cc-web 会话。`,
        '删除运行记录'
    );
    if (!ok) return;
    try {
        await patchNodeCcWeb(`/api/node/runs/${encodeURIComponent(run.id)}`, { method: 'DELETE' });
    } catch (error) {
        patchShowError(error.message, '删除运行记录失败');
        return;
    }
    // 服务器那份只是影子，删不掉不该挡住本地操作
    patchRequest(`/api/problem-runs/${encodeURIComponent(run.id)}`, { method: 'DELETE' }).catch(() => {});
    if (patchState.node.current && patchState.node.current.id === run.id) {
        patchNodeCloseStream();
        patchState.node.current = null;
        patchState.node.liveTranscript = '';
        patchNodeFlushOutput();
        document.getElementById('patchNodeRunPanel').hidden = true;
    }
    await loadProblemRuns();
}

function patchNodeFindRun(id) {
    const entry = (patchState.node.runs || []).find(item => item.id === id);
    return entry && entry.local ? entry.local : null;
}

async function patchNodeRunAction(action, id) {
    // 仅存档行（本机没有）：跳独立详情页，由 node_run.html 从服务器账本取数渲染（与正常详情同一个页面）
    if (action === 'archived-detail') { location.href = `/node_run.html?run_id=${encodeURIComponent(id)}`; return; }
    const run = patchNodeFindRun(id);
    if (!run) return;
    if (action === 'detail') {
        // 运行详情独立页：仿智能分析的查看详情（workflow_run.html），展示该次运行的完整数据
        location.href = `/node_run.html?run_id=${encodeURIComponent(run.id)}`;
        return;
    }
    if (action === 'resume') return patchNodeResumeSession(run);
    if (action === 'solved') return patchNodeSolved(run);
    // 未解决 / 重新执行 / 重新合并 → 同一个「补信息重跑」流程（目标阶段由 run.stage 决定）
    if (action === 'unsolved') return patchNodeUnsolved(run); // 未解决：上传日志 → 阶段一提示词+日志
    if (action === 'rerun') return patchNodeRerun(run); // 重新执行/重新合并：直接「继续」
    if (action === 'remove') return patchNodeRemoveRun(run);
}

// 产物按钮：读文本产物直接摆进输出区（changes.txt / 结论.md / 合并说明.md 都是要在地看的）
async function patchNodeViewArtifact(path) {
    patchState.node.liveTranscript = `【产物】${path}\n\n`;
    patchNodeFlushOutput();
    try {
        const content = await patchNodeReadTextFile(path);
        patchNodeAppendText(content);
    } catch (error) {
        patchNodeAppendText(`（读不到内容：${error.message}。zip 之类的二进制产物请到该路径自行打开。）`);
    }
    patchNodeFlushOutput();
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
    document.getElementById('patchNewProjectEnv').onclick = () => openProjectEnvForm().catch(error => patchShowError(error.message, '产品环境打开失败'));
    document.getElementById('patchProjectEnvForm').onsubmit = saveProjectEnv;
    // 换产品就重列版本；fillProjectEnvVersions 会重建 options，旧版本号自动清空
    document.getElementById('patchProjectEnvForm').product_id.addEventListener('change', event => {
        fillProjectEnvVersions(event.target.form, event.target.value, null);
    });
    document.getElementById('patchProjectEnvClose').onclick = () => { document.getElementById('patchProjectEnvModal').hidden = true; };
    document.getElementById('patchProjectEnvCancel').onclick = () => { document.getElementById('patchProjectEnvModal').hidden = true; };
    document.getElementById('patchProjectEnvModal').onclick = event => { if (event.target.id === 'patchProjectEnvModal') event.currentTarget.hidden = true; };
    // ── 智能开发节点（方案文档第二十章）──
    document.getElementById('patchNewNodeRun').onclick = () => patchNodeOpenForm().catch(error => patchShowError(error.message, '智能开发打开失败'));
    document.getElementById('patchNodeRunForm').onsubmit = event => patchNodeStartRun(event).catch(error => patchShowError(error.message, '智能开发启动失败'));
    // 绑在 form 上而不是 select 上：patchNodeOpenForm 每次重建 options
    document.getElementById('patchNodeRunForm').addEventListener('change', event => { if (event.target.name === 'env_id') patchNodeEnvHint(); });
    document.getElementById('patchNodeFormClose').onclick = () => { document.getElementById('patchNodeFormModal').hidden = true; };
    document.getElementById('patchNodeFormCancel').onclick = () => { document.getElementById('patchNodeFormModal').hidden = true; };
    document.getElementById('patchNodeFormModal').onclick = event => { if (event.target.id === 'patchNodeFormModal') event.currentTarget.hidden = true; };
    document.getElementById('patchNodeRunsRefresh').onclick = () => loadProblemRuns().catch(error => patchShowError(error.message, '运行清单刷新失败'));
    // 顶部动作按钮都作用于「当前打开的那一次运行」；没打开时直接忽略（按钮本身也是 hidden 的）
    document.getElementById('patchNodeAbort').onclick = () => { if (patchState.node.current) patchNodeAbort(patchState.node.current); };
    document.getElementById('patchNodeSolved').onclick = () => { if (patchState.node.current) patchNodeSolved(patchState.node.current); };
    document.getElementById('patchNodeUnsolved').onclick = () => { if (patchState.node.current) patchNodeRerunOrUnsolved(patchState.node.current); };
    // 未解决/重新执行/重新合并的补充信息弹框
    document.getElementById('patchNodeRerunClose').onclick = () => { document.getElementById('patchNodeRerunModal').hidden = true; patchNodeRerunTarget = null; };
    document.getElementById('patchNodeRerunCancel').onclick = () => { document.getElementById('patchNodeRerunModal').hidden = true; patchNodeRerunTarget = null; };
    document.getElementById('patchNodeRerunConfirm').onclick = () => patchNodeUnsolvedConfirm().catch(error => patchShowError(error.message, '重跑失败'));
    document.getElementById('patchNodeRerunModal').onclick = event => { if (event.target.id === 'patchNodeRerunModal') { event.currentTarget.hidden = true; patchNodeRerunTarget = null; } };
    document.getElementById('patchNodeResumeSession').onclick = () => { if (patchState.node.current) patchNodeResumeSession(patchState.node.current); };
    // 列表里的行内动作与产物按钮都是动态重建的，用事件委托
    document.getElementById('patchNodeRunsBody').addEventListener('click', event => {
        const button = event.target.closest('button[data-node-action]');
        if (!button) return;
        patchNodeRunAction(button.dataset.nodeAction, button.dataset.nodeId).catch(error => patchShowError(error.message, '操作失败'));
    });
    document.getElementById('patchNodeArtifacts').addEventListener('click', event => {
        const button = event.target.closest('button[data-node-file]');
        if (!button) return;
        patchNodeViewArtifact(button.dataset.nodeFile).catch(error => patchShowError(error.message, '产物读取失败'));
    });
    document.getElementById('patchDirectoryClose').onclick = () => { document.getElementById('patchDirectoryModal').hidden = true; };
    document.getElementById('patchDirectoryCancel').onclick = () => { document.getElementById('patchDirectoryModal').hidden = true; };
    document.getElementById('patchMenuRoleSave').onclick = saveMenuRoleConfig;
    document.getElementById('patchMenuUserSave').onclick = saveMenuUserOverrides;
    // 菜单两张表的勾选/下拉改动写进 state（分页后 DOM 只有当前页，保存必须用 state）
    document.getElementById('patchMenuRoleBody').addEventListener('change', event => {
        const input = event.target.closest('[data-menu-role-key]');
        if (input) patchState.admin.menuConfig.roleVisible[input.dataset.menuRoleKey] = input.checked;
    });
    document.getElementById('patchMenuUserBody').addEventListener('change', event => {
        const select = event.target.closest('[data-menu-user-key]');
        if (select) patchState.admin.menuConfig.userOverrides[select.dataset.menuUserKey] = select.value === '' ? null : select.value === 'true';
    });
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
    document.getElementById('patchAnalysisStatus').onchange = event => { patchState.admin.analysisStatus = event.target.value; patchState.admin.analysisPager.page = 1; loadAnalysisPatches(); };
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
    document.getElementById('patchSearchBtn').onclick = () => { patchState.keyword = document.getElementById('patchKeyword').value.trim(); patchState.search.page = 1; loadPatches(); };
    document.getElementById('patchSearchStatus').onchange = event => { patchState.searchStatus = event.target.value; patchState.search.page = 1; loadPatches(); };
    document.getElementById('patchKeyword').onkeydown = (event) => { if (event.key === 'Enter') document.getElementById('patchSearchBtn').click(); };
    document.getElementById('patchAdvancedToggle').onclick = openAdvancedSearch;
    document.getElementById('patchAdvSearch').onclick = applyAdvancedSearch;
    document.getElementById('patchAdvReset').onclick = resetAdvancedSearch;
    document.getElementById('patchAdvBack').onclick = closeAdvancedSearch;
    ['patchAdvName', 'patchAdvVersion', 'patchAdvKeyword', 'patchAdvDescription'].forEach(id => {
        document.getElementById(id).onkeydown = (event) => { if (event.key === 'Enter') applyAdvancedSearch(); };
    });
    document.getElementById('patchChooseBtn').onclick = () => document.getElementById('patchFileInput').click();
    document.getElementById('patchFileInput').onchange = (event) => { if (event.target.files.length) showUploadModal(event.target.files); };
    const dropZone = document.getElementById('patchDropZone');
    dropZone.ondragover = (event) => { event.preventDefault(); dropZone.classList.add('dragging'); };
    dropZone.ondragleave = () => dropZone.classList.remove('dragging');
    dropZone.ondrop = (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); if (event.dataTransfer.files.length) showUploadModal(event.dataTransfer.files); };
    document.getElementById('patchUploadStart').onclick = startUpload;
    document.getElementById('patchUploadClose').onclick = closeUploadModal;
    document.getElementById('patchUploadCancel').onclick = () => document.getElementById('patchUploadStart').disabled ? null : closeUploadModal();
    // ── 补丁适配 ──
    document.getElementById('patchAdaptChooseBtn').onclick = () => document.getElementById('patchAdaptFileInput').click();
    document.getElementById('patchAdaptFileInput').onchange = (event) => { if (event.target.files.length) showAdaptModal(event.target.files); event.target.value = ''; };
    const adaptZone = document.getElementById('patchAdaptDropZone');
    adaptZone.ondragover = (event) => { event.preventDefault(); adaptZone.classList.add('dragging'); };
    adaptZone.ondragleave = () => adaptZone.classList.remove('dragging');
    adaptZone.ondrop = (event) => { event.preventDefault(); adaptZone.classList.remove('dragging'); if (event.dataTransfer.files.length) showAdaptModal(event.dataTransfer.files); };
    document.getElementById('patchAdaptStart').onclick = startAdapt;
    document.getElementById('patchAdaptRefresh').onclick = () => loadAdaptRuns();
    document.getElementById('patchAdaptEnv').onchange = event => {
        const env = (patchState.admin.projectEnvs || []).find(item => String(item.id) === String(event.target.value));
        if (env && env.code_directory) document.getElementById('patchAdaptProjectDir').value = env.code_directory;
    };
    document.getElementById('patchAdaptRunsBody').addEventListener('click', async event => {
        const view = event.target.closest('button[data-adapt-view]');
        if (view) { location.href = `/adapt_run.html?run_id=${encodeURIComponent(view.dataset.adaptView)}`; return; }
        const del = event.target.closest('button[data-adapt-delete]');
        if (!del) return;
        const runId = del.dataset.adaptDelete;
        const ok = await patchConfirm(
            '删除后这条适配记录就没了（本机清单 + 服务器账本一起删）。\n\n不会删除补丁解压目录（<cc-web目录>\\temp\\adapt\\' + runId + '）和 cc-web 会话。',
            '删除适配记录'
        );
        if (!ok) return;
        del.disabled = true;
        try {
            // 带上当前 token：cc-web 用它把服务器那份也删掉（跑久了的 run 手里可能是过期 token）
            await patchNodeCcWeb(`/api/adapt/runs/${encodeURIComponent(runId)}/delete`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server_url: patchServerBase(), auth_token: patchToken() }),
            });
            await loadAdaptRuns();
        } catch (error) {
            del.disabled = false;
            patchShowError(error.message, '删除失败');
        }
    });
    document.getElementById('patchAdaptClose').onclick = closeAdaptModal;
    document.getElementById('patchAdaptCancel').onclick = closeAdaptModal;
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
    document.addEventListener('click', (event) => {
        const workflowView = event.target.closest('[data-workflow-view-id]');
        if (workflowView) { openWorkflowHistory(workflowView.dataset.workflowViewId); return; }
        const workflowDelete = event.target.closest('[data-workflow-delete-id]');
        if (workflowDelete) { deleteWorkflowRun(workflowDelete.dataset.workflowDeleteId); return; }
        const detail = event.target.closest('[data-detail-id]');
        if (detail) showPatchDetail(detail.dataset.detailId);
        const download = event.target.closest('[data-download-id]');
        if (download) downloadPatch(download.dataset.downloadId, download.dataset.downloadName);
        const adaptFromList = event.target.closest('[data-adapt-id]');
        if (adaptFromList) { openAdaptFromSearch(adaptFromList.dataset.adaptId); return; }
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
        const projectEnvEdit = event.target.closest('[data-project-env-edit]');
        if (projectEnvEdit) {
            const item = patchState.admin.projectEnvs.find(value => String(value.id) === projectEnvEdit.dataset.projectEnvEdit);
            if (item) openProjectEnvForm(item).catch(error => patchShowError(error.message, '产品环境打开失败'));
        }
        const projectEnvDelete = event.target.closest('[data-project-env-delete]');
        if (projectEnvDelete) {
            const item = patchState.admin.projectEnvs.find(value => String(value.id) === projectEnvDelete.dataset.projectEnvDelete);
            const name = item ? `${item.project_name || ''}` : '';
            patchConfirm(`删除后无法恢复。确认删除产品环境「${name}」？`, '删除产品环境').then(confirmed => {
                if (!confirmed) return;
                return patchRequest(`/api/project-envs/${projectEnvDelete.dataset.projectEnvDelete}`, {method: 'DELETE'}).then(() => loadProjectEnvs()).catch(error => patchShowError(error.message, '产品环境删除失败'));
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

    // 登录态校验失败（网络故障）时的重试入口：直接重新加载页面重新走一遍启动流程
    document.getElementById('patchAuthRetry').onclick = () => location.reload();

    // 获取新版本：手动按钮 + 横幅上的动作
    document.getElementById('patchUpdateCheck').onclick = () => patchUpdateCheck(true);
    // 帮助文档：从补丁中心下载 userManual.docx
    document.getElementById('patchHelpManual').onclick = () => patchHelpDownload();
    document.getElementById('patchUpdateApply').onclick = () => patchUpdateApply();
    document.getElementById('patchUpdateDismiss').onclick = () => {
        patchUpdateState.dismissed = true;   // 只记本次会话：刷新后还会再提示
        document.getElementById('patchUpdateBanner').hidden = true;
    };
    document.getElementById('patchUpdateNotes').onclick = () => {
        const remote = patchUpdateState.remote || {};
        patchShowError(remote.notes || '（本次更新没有写说明）', `更新说明${remote.version ? ' · ' + remote.version : ''}`);
    };
    document.getElementById('patchUpdateModalClose').onclick = () => { document.getElementById('patchUpdateModal').hidden = true; };
    document.getElementById('patchUpdateModalOk').onclick = () => { document.getElementById('patchUpdateModal').hidden = true; };

    // 版本发布（管理员）：刷新现状 + 提交上传 + 选中文件后显示文件名与大小
    document.getElementById('patchReleaseRefresh').onclick = () => loadReleaseInfo();
    document.getElementById('patchReleaseNew').onclick = () => openReleaseModal();
    document.getElementById('patchReleaseClose').onclick = () => closeReleaseModal();
    document.getElementById('patchReleaseCancel').onclick = () => closeReleaseModal();
    document.getElementById('patchReleaseModal').onclick = event => { if (event.target.id === 'patchReleaseModal') closeReleaseModal(); };
    document.getElementById('patchReleaseSubmit').onclick = () => submitRelease();
    // 版本表格里的「设为最新」（提升或回滚）
    document.getElementById('patchReleaseBody').addEventListener('click', event => {
        const button = event.target.closest('button[data-release-set-latest]');
        if (button) setReleaseLatest(button.dataset.releaseSetLatest);
    });
    document.getElementById('patchReleaseForm').addEventListener('change', event => {
        const input = event.target.closest('input[type="file"]');
        if (!input) return;
        const note = document.querySelector(`[data-release-note="${input.name}"]`);
        const file = input.files && input.files[0];
        if (note) note.textContent = file ? `${file.name}（${patchFormatSize(file.size)}）` : '未选择';
    });

    // 「我的补丁」表列宽（与角色无关）：操作列 190px 容纳 详情/下载/编辑/删除 四个按钮
    initPatchColumnResize('.patch-mine-table', 'cc-web-patch-mine-col-widths-v2', [280, 170, 96, 70, 90, 96, 190], 190);
    // 「普通检索」表列宽按角色定，放在 patchSetAuthenticated 里（那里才知道角色）

    // ── 会话存档（管理员）──
    document.getElementById('patchSessionsQuery').onclick = () => {
        patchSessions.page = 1;
        patchSessions.filters.user_id = document.getElementById('patchSessionsUser').value.trim();
        patchSessions.filters.product = document.getElementById('patchSessionsProduct').value.trim();
        patchSessions.filters.local_run_id = document.getElementById('patchSessionsKeyword').value.trim();
        loadRunSessions().catch(error => patchShowError(error.message, '会话存档加载失败'));
    };
    document.getElementById('patchSessionsReset').onclick = () => {
        patchSessions.page = 1;
        patchSessions.filters = { user_id: '', product: '', local_run_id: '' };
        ['patchSessionsUser', 'patchSessionsProduct', 'patchSessionsKeyword'].forEach(id => { document.getElementById(id).value = ''; });
        loadRunSessions().catch(error => patchShowError(error.message, '会话存档加载失败'));
    };
    ['patchSessionsUser', 'patchSessionsProduct', 'patchSessionsKeyword'].forEach(id => {
        document.getElementById(id).onkeydown = (event) => { if (event.key === 'Enter') document.getElementById('patchSessionsQuery').click(); };
    });
    document.getElementById('patchSessionsBody').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-session-view]');
        if (!button) return;
        openRunSession(button.dataset.sessionView).catch(error => patchShowError(error.message, '查看会话失败'));
    });
}

patchInitTheme();
patchBindEvents();
patchBindPagerEvents();
patchInitPagers();
patchInitListPagers();
patchInitSidenav();
// 先读取服务端 /api/patch-config（地址在 cc-web 代码内写死），异常时直接报错并中止后续请求
patchLoadConfig().then(() => {
    patchRestoreAuth().then(authenticated => {
        if (!authenticated) return;
        // 从流程运行详情页返回时带 ?tab=smart，直接切到智能分析页签
        const returnTab = new URLSearchParams(location.search).get('tab');
        const tabButton = returnTab && document.querySelector(`.patch-tab[data-tab="${returnTab}"]`);
        // 深链守卫：?tab=X 只在 X 当前可见（未被菜单可见性隐藏）时才切过去，否则回落到默认页签
        if (tabButton && !tabButton.hidden) { patchSwitchTab(returnTab); loadPatches(); }
        else { loadPatches(); loadWorkflowTemplates(); restoreWorkflowRun(); loadWorkflowHistory(); }
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
