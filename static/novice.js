// ============================================================
//  novice.js - 小白版「产品环境变量 / 环境检查」页
//  依赖（先加载）：common.js、folderpick.js
//
//  智能开发/聊天不在本页：它们是独立页面（与开发版同一份实现，
//  新建表单/提示词按 edition 分支，见 patches.js / prompts_novice.js）。
// ============================================================

const patchState = {
    theme: 'light',
    patchSearchServers: [],
    patchServerCursor: 0,
    authInvalidated: false,
    user: null,
    products: null,          // 产品/版本字典缓存
    envs: [],                // 产品环境列表（/api/project-envs 全量）
    envCheck: null,          // /api/env-check 结果
    envEditId: null,
    view: 'node',            // node(智能开发=聊天) | env | check
};

function el(id) { return document.getElementById(id); }

// 视图切换（左侧菜单三项，右侧内容区切换；不整页跳转）
function noviceSetView(view) {
    patchState.view = view;
    const views = { node: 'nv-view-chat', env: 'nv-view-env', check: 'nv-view-check', patch: 'nv-view-patch' };
    Object.entries(views).forEach(([key, id]) => {
        const node = el(id);
        if (node) node.classList.toggle('nv-hidden', key !== view);
    });
    ['node', 'env', 'check', 'patch'].forEach(key => {
        const nav = el(`nav-${key}`);
        if (nav) nav.classList.toggle('active', key === view);
    });
    if (view === 'env' && noviceRequireLogin()) {
        noviceLoadEnvs().catch(error => patchShowError(error.message, '产品环境加载失败'));
    }
    if (view === 'check' && noviceRequireLogin()) {
        noviceRunEnvCheck();
    }
    if (view === 'patch' && noviceRequireLogin()) {
        noviceSearchPatches();
    }
}

// 需要登录才能用的功能（环境变量/环境检查/新建排查）：没有 token 就整页跳到 /login
function noviceRequireLogin() {
    if (patchToken()) return true;
    window.location.replace('/login');
    return false;
}

/* ── 登录 / 认证 ── */

async function noviceLoadConfig() {
    let servers = [];
    try {
        const response = await fetch('/api/patch-config');
        if (response.ok) {
            const config = await response.json().catch(() => ({}));
            if (config && typeof config === 'object') {
                if (Array.isArray(config.patch_search_servers)) servers = config.patch_search_servers;
                else if (config.patch_search_api) servers = [config.patch_search_api];
            }
        }
    } catch {}
    servers = (servers || []).map(v => String(v).trim()).filter(Boolean);
    if (!servers.length) throw new Error('无法连接补丁中心：cc-web 未运行或 /api/patch-config 接口异常。');
    patchState.patchSearchServers = servers;
    patchState.patchServerCursor = 0;
}

function patchSetApiStatus(state) {
    const e = el('api-status');
    if (!e) return;
    if (state === 'online') { e.textContent = '已连接'; e.className = 'api-status online'; }
    else if (state === 'error') { e.textContent = '连接失败'; e.className = 'api-status error'; }
    else { e.textContent = '未连接'; e.className = 'api-status'; }
}

// common.js 的 patchRestoreAuth 通过这个钩子把登录用户接回本页
// （登录页是独立页面 /login，登录成功后才整页跳到主界面）
function patchSetAuthenticated(user) {
    patchState.user = user || null;
    patchSetApiStatus(user ? 'online' : 'offline');
    const userEl = el('nv-user');
    if (userEl) userEl.textContent = user ? `${user.display_name || user.username || ''}` : '';
}

function patchHandleUnauthorized() {
    if (patchState.authInvalidated) return;
    patchState.authInvalidated = true;
    localStorage.removeItem(PATCH_TOKEN_KEY);
    // 登录页是独立页面：token 失效直接整页跳过去（不会先闪主界面）
    window.location.replace('/login?reason=expired');
}

function patchShowAuthRetry(message) {
    const e = el('auth-loading-text');
    if (e) e.textContent = message || '无法连接服务器，请稍后重试或联系管理员';
    const retry = el('auth-retry');
    if (retry) retry.hidden = false;
}

async function noviceLogout() {
    const token = patchToken();
    const servers = patchState.patchSearchServers || [];
    if (token && servers.length) {
        const base = servers[patchState.patchServerCursor++ % servers.length];
        try { await fetch(`${base.replace(/\/+$/, '')}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch {}
    }
    try { localStorage.removeItem(PATCH_TOKEN_KEY); } catch {}
    // 退出后整页回登录页
    window.location.replace('/login');
}

/* ── 环境检查页 ── */

async function noviceRunEnvCheck() {
    const box = el('envcheck-list');
    box.innerHTML = '<div class="nv-check-card"><div class="nv-check-title">正在检查，请稍候…</div></div>';
    // home 取第一个登记了 home 的产品环境（顺手把 home 下的 JDK 也查了）
    if (!(patchState.envs || []).some(item => String(item.package_path || '').trim())) {
        try { await noviceLoadEnvs(); } catch {}
    }
    const env = (patchState.envs || []).find(item => String(item.package_path || '').trim());
    const home = env ? String(env.package_path).trim() : '';
    let data = null;
    try {
        const q = home ? `?home=${encodeURIComponent(home)}` : '';
        const payload = await (await fetch(`/api/env-check${q}`)).json();
        if (payload && payload.success) data = payload;
    } catch {}
    if (!data) {
        box.innerHTML = '<div class="nv-check-card"><div class="nv-check-title">检查失败，请稍后重试</div></div>';
        return;
    }
    patchState.envCheck = data;
    localStorage.setItem('cc-web-novice-envcheck-done', '1');
    const cards = [];
    const card = (ok, title, detail, hint) => `
        <div class="nv-check-card ${ok ? 'ok' : 'bad'}">
            <div class="nv-check-title">${ok ? '✅' : '❌'} ${title}</div>
            <div class="nv-check-detail">${patchEscape(detail || '')}</div>
            ${ok || !hint ? '' : `<div class="nv-check-hint">💡 ${patchEscape(hint)}</div>`}
        </div>`;
    cards.push(card(data.claude && data.claude.ok, 'Claude Code（AI 引擎）', data.claude && data.claude.detail,
        '未检测到 claude 命令。请先安装 Claude Code 并重新打开本页面，否则智能开发无法运行。'));
    cards.push(card(data.java && data.java.ok, 'Java / JDK（编译补丁用）', data.java && data.java.detail,
        data.home_jdk && data.home_jdk.ok
            ? `未在系统里找到 java，但在产品 home 下发现了 JDK：${data.home_jdk.path}。可以把这个路径填到产品环境变量的「本地 JDK」里（点「高级」展开）。`
            : 'PATH 和 JAVA_HOME 都没有可用的 java。AI 编译时会依次在工程 home/war 包下、cc-web 安装目录的 jdk 目录下查找，仍没有会自动下载所需版本的 JDK 到 cc-web 安装目录/jdk/；也可以在产品环境变量里直接登记本地 JDK 路径（点「高级」展开）。'));
    cards.push(card(data.python && data.python.ok, 'Python（生成对比报告用，缺了也能用）', data.python && data.python.detail,
        '未检测到可用的 python。不影响补丁排查，只是没有 HTML 对比报告。可安装 Python 3 后刷新本页。'));
    cards.push(card(data.git_bash && data.git_bash.ok, 'Git Bash（Claude Code 执行命令需要）', data.git_bash && data.git_bash.detail,
        '未找到 Git Bash。Windows 下请安装 Git for Windows；如果安装在非默认目录，把 bash.exe 的完整路径填到系统环境变量 CLAUDE_CODE_GIT_BASH_PATH 里，然后重启 cc-web 再刷新本页。'));
    box.innerHTML = cards.join('');
}

/* ── 产品环境变量页 ── */

async function noviceLoadEnvs() {
    const body = el('env-list');
    body.innerHTML = '<div class="nv-empty">正在加载…</div>';
    patchState.envs = (await patchRequest('/api/project-envs')) || [];
    noviceRenderEnvs();
    return patchState.envs;
}

function noviceRenderEnvs() {
    const body = el('env-list');
    const envs = patchState.envs || [];
    if (!envs.length) {
        body.innerHTML = '<div class="nv-empty">还没有产品环境。点右上角「新增」填好产品、版本和 home/war 路径即可开始使用智能开发。</div>';
        return;
    }
    body.innerHTML = envs.map(env => `
        <div class="nv-env-item">
            <div class="nv-env-main">
                <div class="nv-env-name">${patchEscape(env.project_name || `${env.product_name || ''} ${env.product_version || ''}`.trim())}</div>
                <div class="nv-env-sub" title="${patchEscape(env.package_path || '')}">home/war：${patchEscape(env.package_path || '—')}</div>
                <div class="nv-env-sub">${patchEscape(env.local_jdk_path ? 'JDK：' + env.local_jdk_path : 'JDK：未登记（AI 会尝试在 home 下自动找）')}</div>
            </div>
            <div class="nv-env-actions">
                <button class="nv-link-btn" data-env-edit="${patchEscape(env.id)}">编辑</button>
                <button class="nv-link-btn nv-danger" data-env-del="${patchEscape(env.id)}">删除</button>
            </div>
        </div>`).join('');
}

async function noviceOpenEnvForm(item = {}) {
    let products;
    try { products = await noviceEnsureProducts(); }
    catch (error) { patchShowError(error.message, '产品字典加载失败'); return; }
    if (!products.length) {
        patchShowError('管理员还没有配置产品字典。请联系管理员先在管理端添加产品与版本。', '无法维护产品环境');
        return;
    }
    patchState.envEditId = item.id || null;
    const form = el('env-form');
    form.product_id.innerHTML = '<option value="">请选择产品</option>' + products.map(p =>
        `<option value="${patchEscape(p.id)}">${patchEscape(p.name)}</option>`).join('');
    form.product_id.value = item.product_id == null ? '' : String(item.product_id);
    noviceFillVersions(form, form.product_id.value, item.version_id);
    form.package_path.value = item.package_path || '';
    form.code_directory.value = item.code_directory || '';
    form.local_jdk_path.value = item.local_jdk_path || '';
    form.db_connection.value = item.db_connection || '';
    form.debug_address.value = item.debug_address || '';
    form.local_skill_path.value = item.local_skill_path || '';
    el('env-advanced').classList.add('nv-hidden');
    el('env-advanced-toggle').textContent = '▸ 高级设置（选填）';
    el('env-form-modal').classList.remove('nv-hidden');
    form.product_id.focus();
}

function noviceFillVersions(form, productId, currentVersionId) {
    const product = (patchState.products || []).find(p => String(p.id) === String(productId));
    const versions = product ? (product.versions || []) : [];
    form.version_id.innerHTML = '<option value="">请选择版本号</option>' + versions.map(v =>
        `<option value="${patchEscape(v.id)}">${patchEscape(v.version)}</option>`).join('');
    form.version_id.value = versions.some(v => String(v.id) === String(currentVersionId)) ? String(currentVersionId) : '';
}

async function noviceEnsureProducts() {
    if (patchState.products) return patchState.products;
    patchState.products = await patchRequest('/api/products');
    return patchState.products;
}

async function noviceSaveEnv(event) {
    event.preventDefault();
    const form = event.target;
    const payload = Object.fromEntries(new FormData(form).entries());
    for (const [field, label] of [['product_id', '产品名称'], ['version_id', '版本号'], ['package_path', 'home/war包地址']]) {
        if (!String(payload[field] || '').trim()) { patchShowError(`${label}为必填项`, '保存失败'); form[field].focus(); return; }
    }
    payload.product_id = Number(payload.product_id);
    payload.version_id = Number(payload.version_id);
    const id = patchState.envEditId;
    try {
        await patchRequest(id ? `/api/project-envs/${id}` : '/api/project-envs', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        el('env-form-modal').classList.add('nv-hidden');
        await noviceLoadEnvs();
    } catch (error) {
        patchShowError(error.message, '保存失败');
    }
}

async function noviceDeleteEnv(id) {
    const ok = typeof confirmAppAction === 'function'
        ? await confirmAppAction('删除后无法恢复，但已创建的智能开发运行不受影响。', '删除产品环境')
        : window.confirm('确定删除这个产品环境？已创建的智能开发运行不受影响。');
    if (!ok) return;
    try {
        await patchRequest(`/api/project-envs/${id}`, { method: 'DELETE' });
        await noviceLoadEnvs();
    } catch (error) { patchShowError(error.message, '删除失败'); }
}

/* ── 会话列表增强：多选批量删除 + 重命名 ── */
const noviceSelectedSessions = new Set();
let noviceRenameTarget = null;

function noviceSessionData() {
    return (typeof sessions !== 'undefined' && Array.isArray(sessions)) ? sessions : null;
}

function noviceSyncSelection() {
    const list = noviceSessionData();
    if (!list) return;
    const ids = new Set(list.map(s => s.id));
    Array.from(noviceSelectedSessions).forEach(id => { if (!ids.has(id)) noviceSelectedSessions.delete(id); });
    const count = noviceSelectedSessions.size;
    const del = el('btn-delete-selected');
    if (del) {
        del.hidden = count === 0;
        del.textContent = count ? `删除 (${count})` : '删除';
    }
    const all = el('sessionSelectAll');
    if (all) {
        all.checked = list.length > 0 && count === list.length;
        all.indeterminate = count > 0 && count < list.length;
    }
}

// app.js 重绘会话列表后调用：给每个会话加多选框和「✏️」重命名按钮
function noviceDecorateSessionList() {
    const list = noviceSessionData();
    const box = el('sessionList');
    if (!list || !box) return;
    Array.from(box.querySelectorAll('.session-item')).forEach((item, index) => {
        const session = list[index];
        if (!session) return;
        const header = item.querySelector('.header');
        if (!header) return;
        let checkWrap = header.querySelector('.session-check');
        if (!checkWrap) {
            checkWrap = document.createElement('label');
            checkWrap.className = 'session-check';
            checkWrap.title = '选择会话';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.addEventListener('click', event => event.stopPropagation());
            input.addEventListener('change', () => {
                if (input.checked) noviceSelectedSessions.add(session.id);
                else noviceSelectedSessions.delete(session.id);
                noviceSyncSelection();
            });
            checkWrap.appendChild(input);
            checkWrap.addEventListener('click', event => event.stopPropagation());
            header.insertBefore(checkWrap, header.firstChild);
        }
        const input = checkWrap.querySelector('input');
        if (input) input.checked = noviceSelectedSessions.has(session.id);

        if (!header.querySelector('.edit-btn')) {
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'edit-btn';
            editBtn.textContent = '✏️';
            editBtn.title = '修改会话名称';
            editBtn.addEventListener('click', event => { event.stopPropagation(); noviceOpenRename(session.id); });
            const deleteBtn = header.querySelector('.delete-btn');
            header.insertBefore(editBtn, deleteBtn || null);
        }

        // 用户自定义过名称时覆盖 firstMessage 的显示
        if (session.name) {
            const nameEl = header.querySelector('.name');
            if (nameEl) {
                const icon = (typeof ASSISTANT_ICONS !== 'undefined' && ASSISTANT_ICONS[session.assistant]) || '🔧';
                nameEl.textContent = `${icon} ${session.name}`;
                nameEl.title = session.name;
            }
        }
    });
    noviceSyncSelection();
}

function noviceOpenRename(sessionId) {
    const list = noviceSessionData() || [];
    const session = list.find(item => item.id === sessionId);
    if (!session) return;
    noviceRenameTarget = sessionId;
    const input = el('rename-session-input');
    input.value = session.name || String(session.firstMessage || '').slice(0, 100);
    const msg = el('rename-session-msg');
    if (msg) msg.textContent = '';
    el('rename-session-modal').classList.remove('nv-hidden');
    input.focus();
    input.select();
}

async function noviceSaveRename() {
    const id = noviceRenameTarget;
    if (!id) return;
    const input = el('rename-session-input');
    const msg = el('rename-session-msg');
    const name = String(input.value || '').trim();
    if (!name) {
        if (msg) msg.textContent = '请输入会话名称';
        input.focus();
        return;
    }
    try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/name`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `保存失败（HTTP ${response.status}）`);
        const session = (noviceSessionData() || []).find(item => item.id === id);
        if (session) session.name = name;
        el('rename-session-modal').classList.add('nv-hidden');
        renderSessionList();
    } catch (error) {
        if (msg) msg.textContent = error.message;
    }
}

async function noviceDeleteSelectedSessions() {
    const list = noviceSessionData() || [];
    const ids = Array.from(noviceSelectedSessions).filter(id => list.some(item => item.id === id));
    if (!ids.length) return;
    const text = `确定删除选中的 ${ids.length} 个会话？删除后无法恢复。`;
    const ok = typeof confirmAppAction === 'function'
        ? await confirmAppAction(text, '删除会话')
        : window.confirm(text);
    if (!ok) return;
    for (const id of ids) {
        try { await deleteSession(id); } catch {}
    }
    noviceSelectedSessions.clear();
    await loadSessions();
    noviceSyncSelection();
}

// app.js 每次重绘会话列表后追加选择框 / 重命名按钮（开发版没有 novice.js，不受影响）
(function wrapRenderSessionList() {
    if (typeof renderSessionList !== 'function') return;
    const base = renderSessionList;
    renderSessionList = function () {
        base.apply(this, arguments);
        noviceDecorateSessionList();
    };
})();

/* ── 补丁检索（走补丁中心的 /api/patches，与开发版「普通检索」同一接口）── */

function novicePatchSearchState() {
    if (!patchState.patchSearch) {
        patchState.patchSearch = { keyword: '', page: 1, size: 20, total: 0, items: [] };
    }
    return patchState.patchSearch;
}

async function noviceSearchPatches(page) {
    const state = novicePatchSearchState();
    const input = el('patchSearchInput');
    if (input) state.keyword = String(input.value || '').trim();
    if (page) state.page = page;
    const box = el('patchSearchList');
    if (box) box.innerHTML = '<div class="nv-empty">正在检索…</div>';
    try {
        const params = new URLSearchParams({
            keyword: state.keyword,
            page: String(state.page),
            size: String(state.size),
        });
        const data = await patchRequest(`/api/patches?${params}`);
        state.items = Array.isArray(data.items) ? data.items : [];
        state.total = Number(data.total || 0);
        state.page = Number(data.page || state.page);
        state.size = Number(data.size || state.size);
        noviceRenderPatches();
    } catch (error) {
        if (box) box.innerHTML = '<div class="nv-empty">检索失败，请稍后重试</div>';
        patchShowError(error.message, '补丁检索失败');
    }
}

function novicePatchStatusLabel(status) {
    return ({ 0: '待分析', 1: '分析中', 2: '分析完成', 3: '分析失败' })[Number(status)] || '—';
}

function noviceRenderPatches() {
    const state = novicePatchSearchState();
    const box = el('patchSearchList');
    if (!box) return;
    const totalEl = el('patchSearchTotal');
    if (totalEl) totalEl.textContent = `共 ${state.total} 个`;
    if (!state.items.length) {
        box.innerHTML = '<div class="nv-empty">没有找到匹配的补丁</div>';
    } else {
        box.innerHTML = state.items.map(item => {
            const meta = [
                `${item.product_name || '-'} ${item.product_version || ''}`.trim(),
                String(item.file_format || '').toUpperCase(),
                patchFormatSize(item.file_size),
                novicePatchStatusLabel(item.status),
                patchFormatDateTime(item.analyzed_at || item.uploaded_at),
            ].filter(Boolean).map(patchEscape).join(' · ');
            return `<div class="nv-patch-item">
                <div class="nv-patch-main">
                    <div class="nv-patch-name" title="${patchEscape(item.name || '')}">${patchEscape(item.name || '(未命名补丁)')}</div>
                    <div class="nv-patch-meta" title="${patchEscape(item.file_name || '')}">${patchEscape(item.file_name || '')}</div>
                    <div class="nv-patch-meta">${meta}</div>
                </div>
                <div class="nv-patch-actions">
                    <button class="nv-link-btn" type="button" data-patch-detail="${patchEscape(item.id)}">详情</button>
                    <button class="nv-link-btn" type="button" data-patch-download="${patchEscape(item.id)}" data-patch-name="${patchEscape(item.file_name || item.name || '')}">下载</button>
                </div>
            </div>`;
        }).join('');
    }
    const pager = el('patchSearchPager');
    const info = el('patchSearchPageInfo');
    const pages = Math.max(1, Math.ceil(state.total / Math.max(1, state.size)));
    if (pager) pager.style.display = state.total > state.size ? 'flex' : 'none';
    if (info) info.textContent = `第 ${state.page} / ${pages} 页`;
    const prev = el('patchSearchPrev');
    const next = el('patchSearchNext');
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= pages;
}

async function noviceDownloadPatch(id, name) {
    if (!noviceRequireLogin()) return;
    const servers = patchState.patchSearchServers || [];
    if (!servers.length) { patchShowError('服务地址尚未加载，请稍后重试', '下载补丁'); return; }
    try {
        let response = null;
        for (let attempt = 0; attempt < servers.length && !response; attempt += 1) {
            const base = servers[(patchState.patchServerCursor + attempt) % servers.length].replace(/\/+$/, '');
            try {
                response = await patchFetchTimeout(`${base}/api/patches/${encodeURIComponent(id)}/download`,
                    { headers: { Authorization: `Bearer ${patchToken()}` } }, PATCH_REQUEST_TIMEOUT);
            } catch {
                response = null;
            }
        }
        if (!response) throw new Error('无法连接服务器，请稍后重试');
        if (response.status === 401) { patchHandleUnauthorized(); return; }
        if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name || `patch-${id}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (error) {
        patchShowError(error.message, '下载补丁失败');
    }
}

let novicePatchDetail = null;

function novicePatchTags(value) {
    const list = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    if (!list.length) return '-';
    return `<span class="nv-tags">${list.map(item => `<span class="nv-tag">${patchEscape(item)}</span>`).join('')}</span>`;
}

// 分析结果只展示 function_desc（可能是对象里的字段，也可能是 JSON 字符串/代码块里的字段）
function noviceFindFunctionDesc(node, depth) {
    if (node == null || depth > 5) return '';
    if (typeof node === 'string') {
        const text = node.trim();
        if (!text) return '';
        try { return noviceFindFunctionDesc(JSON.parse(text), depth + 1); } catch (e) { /* 不是 JSON，继续往下 */ }
        const block = text.match(/```json\s*([\s\S]*?)```/i);
        if (block) {
            try { return noviceFindFunctionDesc(JSON.parse(block[1].trim()), depth + 1); } catch (e) { /* 忽略 */ }
        }
        const match = text.match(/"function_desc"\s*:\s*"([\s\S]*?)"\s*[,}]/);
        if (match) {
            try { return JSON.parse(`"${match[1]}"`); } catch (e) { return match[1]; }
        }
        return '';
    }
    if (typeof node !== 'object') return '';
    if (typeof node.function_desc === 'string' && node.function_desc.trim()) return node.function_desc.trim();
    for (const value of Object.values(node)) {
        const found = noviceFindFunctionDesc(value, depth + 1);
        if (found) return found;
    }
    return '';
}

function novicePatchResultText(value) {
    return noviceFindFunctionDesc(value, 0) || '（暂无分析结果）';
}

async function noviceShowPatchDetail(id) {
    if (!noviceRequireLogin()) return;
    const modal = el('patch-detail-modal');
    const body = el('patch-detail-body');
    const result = el('patch-detail-result');
    body.innerHTML = '<dt>状态</dt><dd>正在加载…</dd>';
    result.textContent = '—';
    modal.classList.remove('nv-hidden');
    try {
        const patch = await patchRequest(`/api/patches/${encodeURIComponent(id)}`);
        novicePatchDetail = patch;
        body.innerHTML = `
            <dt>名称</dt><dd>${patchEscape(patch.name || '-')}</dd>
            <dt>产品名称</dt><dd>${patchEscape(patch.product_name || '-')}</dd>
            <dt>版本号</dt><dd>${patchEscape(patch.product_version || '-')}</dd>
            <dt>描述</dt><dd>${patchEscape(patch.description || '-')}</dd>
            <dt>格式</dt><dd>${patchEscape(String(patch.file_format || '').toUpperCase() || '-')}</dd>
            <dt>大小</dt><dd>${patchEscape(patchFormatSize(patch.file_size))}</dd>
            <dt>上传人</dt><dd>${patchEscape(patch.uploaded_by || '-')}</dd>
            <dt>上传时间</dt><dd>${patchEscape(patchFormatDateTime(patch.uploaded_at))}</dd>
            <dt>用户关键词</dt><dd>${novicePatchTags(patch.user_keyword)}</dd>
            <dt>相关类</dt><dd>${novicePatchTags(patch.class_name)}</dd>
            <dt>分析关键词</dt><dd>${novicePatchTags(patch.keyword)}</dd>`;
        result.textContent = novicePatchResultText(patch.analysis_result);
    } catch (error) {
        modal.classList.add('nv-hidden');
        patchShowError(error.message, '补丁详情加载失败');
    }
}

/* ── 设置：用户设置 + 检查更新 ── */

// 补丁中心地址轮询（与 patches.js 的 patchServerBase 同一策略）
function noviceServerBase() {
    const servers = patchState.patchSearchServers;
    if (!servers.length) return '';
    return servers[patchState.patchServerCursor++ % servers.length];
}

function novicePlatformLabel(key) {
    return ({ windows: 'Windows', 'macos-arm64': 'macOS (Apple Silicon)', 'macos-x64': 'macOS (Intel)' })[key] || key || '未知平台';
}

async function noviceOpenUserSettings() {
    if (!noviceRequireLogin()) return;
    const modal = el('user-settings-modal');
    const profile = el('user-profile');
    profile.innerHTML = '<dt>状态</dt><dd>正在加载…</dd>';
    const message = el('change-password-msg');
    if (message) message.textContent = '';
    modal.classList.remove('nv-hidden');
    try {
        const data = await patchRequest('/api/auth/profile');
        profile.innerHTML = `
            <dt>用户名</dt><dd>${patchEscape(data.username || '')}</dd>
            <dt>显示名称</dt><dd>${patchEscape(data.display_name || '')}</dd>
            <dt>角色</dt><dd>${patchEscape(data.role || '')}</dd>
            <dt>注册时间</dt><dd>${patchEscape(patchFormatDateTime(data.created_at))}</dd>
            <dt>最近登录</dt><dd>${patchEscape(patchFormatDateTime(data.last_login_at))}</dd>`;
    } catch (error) {
        modal.classList.add('nv-hidden');
        patchShowError(error.message, '个人信息加载失败');
    }
}

async function noviceChangePassword(event) {
    event.preventDefault();
    const form = event.target;
    const values = Object.fromEntries(new FormData(form).entries());
    const message = el('change-password-msg');
    if (values.new_password !== values.confirm_password) {
        if (message) message.textContent = '两次输入的新密码不一致';
        return;
    }
    try {
        await patchRequest('/api/auth/change-password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values),
        });
        form.reset();
        el('user-settings-modal').classList.add('nv-hidden');
        // 密码改完旧 token 失效：清掉登录态，整页回登录页并提示用新密码登录
        try { localStorage.removeItem(PATCH_TOKEN_KEY); } catch {}
        window.location.replace('/login?reason=password');
    } catch (error) {
        if (message) message.textContent = error.message;
    }
}

// 检查更新：cc-web 后端代问补丁中心（本机版本号来自编译期），有新版时确认后再下载自替换
async function noviceCheckUpdate() {
    if (!noviceRequireLogin()) return;
    try {
        const payload = await patchNodeCcWeb('/api/update/check', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server_url: noviceServerBase(), auth_token: patchToken() }),
        });
        const data = payload.data || {};
        const local = data.local || {};
        const remote = data.remote || null;
        const mine = local.version || '';
        const platform = novicePlatformLabel(local.platform);
        if (!data.update_available) {
            if (!remote) patchShowError(`本机当前版本 ${mine}。补丁中心还没有发布小白版新版本。`, '检查更新');
            else if (remote.has_package === false) patchShowError(`本机当前版本 ${mine}；最新版本 ${remote.version} 暂无 ${platform} 的安装包，请联系管理员。`, '检查更新');
            else patchShowError(`本机版本 ${mine} 与服务器上的 ${remote.version} 一致，已是最新。`, '检查更新');
            return;
        }
        const when = remote.build_unix ? patchFormatDateTime(new Date(Number(remote.build_unix) * 1000)) : '';
        const text = `发现新版本 ${remote.version}（${platform}${when ? `，构建 ${when}` : ''}），本机当前 ${mine}。是否立即下载并更新？更新完成后 cc-web 会自动重启。`;
        if (await confirmAppAction(text, '发现新版本')) await noviceApplyUpdate();
    } catch (error) {
        patchShowError(error.message, '检查更新失败');
    }
}

async function noviceApplyUpdate() {
    const modal = el('update-modal');
    const message = el('update-message');
    const progress = el('update-progress');
    const bar = progress.querySelector('span');
    const label = progress.querySelector('em');
    const okBtn = el('update-modal-ok');
    message.textContent = '正在下载新版本…';
    progress.style.display = 'block';
    bar.style.width = '0%';
    label.textContent = '';
    okBtn.hidden = true;
    modal.classList.remove('nv-hidden');
    try {
        const response = await fetch('/api/update/apply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server_url: noviceServerBase(), auth_token: patchToken() }),
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
            const { done: finished, value } = await reader.read();
            if (finished) break;
            buffer += decoder.decode(value, { stream: true });
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
            message.textContent = `${result.message || '新版本已就位'}。在运行 cc-web 的终端里按 Ctrl+C 停掉，再执行 ./start.sh 就是新版本了。`;
        } else if (result.replaced) {
            message.textContent = `${result.message || '更新完成'}。稍后请刷新页面（cc-web 正在重启，连接会断开几秒）。`;
        } else {
            message.textContent = `${result.message || '更新完成'}。稍后请刷新页面（cc-web 正在重启，连接会断开几秒）。若 10 秒后仍打不开，看 cc-web 所在目录里的 update-cc-web.log。`;
        }
        okBtn.hidden = false;
    } catch (error) {
        message.textContent = `更新失败：${error.message}`;
        okBtn.hidden = false;
    }
}

/* ── 帮助文档（patch_search 的 manual 接口，带 edition=novice）── */

async function noviceDownloadManual() {
    if (!patchToken()) { patchShowError('请先登录', '帮助文档'); return; }
    const servers = patchState.patchSearchServers;
    if (!servers.length) { patchShowError('服务地址尚未加载，请稍后重试', '帮助文档'); return; }
    const btn = el('btn-help');
    if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
    try {
        let response = null;
        for (let attempt = 0; attempt < servers.length && !response; attempt += 1) {
            const base = servers[(patchState.patchServerCursor + attempt) % servers.length].replace(/\/+$/, '');
            try {
                response = await patchFetchTimeout(`${base}/api/ccweb/manual?edition=novice`,
                    { headers: { Authorization: `Bearer ${patchToken()}` } }, PATCH_REQUEST_TIMEOUT);
            } catch { response = null; continue; }
        }
        if (!response) throw new Error('无法连接服务器，请稍后重试');
        if (response.status === 404) {
            let detail = '';
            try { detail = (await response.json()).detail || ''; } catch {}
            throw new Error(detail || '服务器上还没有小白版帮助文档，请联系管理员');
        }
        if (response.status === 401) { patchHandleUnauthorized(); throw new Error('请先登录'); }
        if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cc-web小白版使用说明.docx';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (error) {
        patchShowError(error.message, '帮助文档');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '❓ 帮助'; }
    }
}

/* ── 主题 ── */
// 统一外壳里主题按钮（#themeToggle）由 app.js 管理，同一 cc-web-theme 键；
// 这里只在按钮存在时同步图标，避免 null 崩溃。
function noviceSetTheme(theme) {
    patchState.theme = theme;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cc-web-theme', theme);
    const btn = el('theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

/* ── 初始化 ── */

function noviceBindEvents() {
    // 左侧菜单：三项都是页内视图切换（不整页跳转）
    const bindNav = (id, view) => { const node = el(id); if (node) node.onclick = e => { e.preventDefault(); noviceSetView(view); }; };
    bindNav('nav-node', 'node');
    bindNav('nav-patch', 'patch');
    // 右上角：产品环境变量 / 新建排查
    const envBtn = el('noviceEnvBtn');
    if (envBtn) envBtn.onclick = () => noviceSetView('env');
    // 补丁检索：搜索 / 分页 / 下载
    el('patchSearchBtn').onclick = () => noviceSearchPatches(1);
    el('patchSearchInput').onkeydown = event => { if (event.key === 'Enter') noviceSearchPatches(1); };
    el('patchSearchPrev').onclick = () => noviceSearchPatches(Math.max(1, novicePatchSearchState().page - 1));
    el('patchSearchNext').onclick = () => noviceSearchPatches(novicePatchSearchState().page + 1);
    el('patchSearchList').addEventListener('click', event => {
        const detailBtn = event.target.closest('button[data-patch-detail]');
        if (detailBtn) { noviceShowPatchDetail(detailBtn.dataset.patchDetail); return; }
        const downloadBtn = event.target.closest('button[data-patch-download]');
        if (downloadBtn) noviceDownloadPatch(downloadBtn.dataset.patchDownload, downloadBtn.dataset.patchName);
    });
    const closePatchDetail = () => el('patch-detail-modal').classList.add('nv-hidden');
    el('patch-detail-close').onclick = closePatchDetail;
    el('patch-detail-download').onclick = () => {
        if (!novicePatchDetail) return;
        const patch = novicePatchDetail;
        noviceDownloadPatch(patch.id, patch.file_name || patch.name || '');
    };
    // 不论当前在哪个视图，点左侧会话都切回「智能开发」视图（会话窗口在右侧聊天区）
    const sessionListNode = el('sessionList');
    if (sessionListNode) {
        sessionListNode.addEventListener('click', event => {
            if (event.target.closest('.session-item') && !event.target.closest('.delete-btn')) noviceSetView('node');
        });
    }
    // 会话多选 / 批量删除 / 重命名
    el('sessionSelectAll').addEventListener('change', event => {
        noviceSelectedSessions.clear();
        if (event.target.checked) (noviceSessionData() || []).forEach(item => noviceSelectedSessions.add(item.id));
        renderSessionList();
    });
    el('btn-delete-selected').onclick = () => noviceDeleteSelectedSessions();
    const closeRename = () => el('rename-session-modal').classList.add('nv-hidden');
    el('rename-session-close').onclick = closeRename;
    el('rename-session-cancel').onclick = closeRename;
    el('rename-session-save').onclick = noviceSaveRename;
    el('rename-session-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); noviceSaveRename(); } };
    // 主题按钮：app.js 切换时会重写 textContent（只剩图标），这里补回「主题」文字
    const syncThemeLabel = () => {
        const btn = el('themeToggle');
        if (btn) btn.textContent = document.documentElement.dataset.theme === 'dark' ? '☀️ 主题' : '🌙 主题';
    };
    syncThemeLabel();
    // app.js 的 onclick 可能在更晚的 init 里才挂上，用 setTimeout 保证切完主题再改文字
    el('themeToggle').addEventListener('click', () => setTimeout(syncThemeLabel, 0));

    // 底部两个下拉：帮助（使用手册/环境检查）、设置（退出登录/用户设置/检查更新）
    const menuClosers = [];
    const bindMenu = (btnId, menuId) => {
        const btn = el(btnId);
        const menu = el(menuId);
        const close = () => {
            if (menu) menu.classList.add('nv-hidden');
            if (btn) btn.setAttribute('aria-expanded', 'false');
        };
        if (btn && menu) btn.onclick = () => {
            const opening = menu.classList.contains('nv-hidden');
            menuClosers.forEach(fn => fn());     // 同一时间只展开一个下拉
            if (opening) {
                menu.classList.remove('nv-hidden');
                btn.setAttribute('aria-expanded', 'true');
            }
        };
        menuClosers.push(close);
        return close;
    };
    const closeHelpMenu = bindMenu('btn-help', 'help-menu');
    const closeSettingsMenu = bindMenu('btn-settings', 'settings-menu');
    el('btn-help-manual').onclick = () => { closeHelpMenu(); noviceDownloadManual(); };
    el('btn-help-check').onclick = () => { closeHelpMenu(); noviceSetView('check'); };
    el('btn-settings-logout').onclick = () => { closeSettingsMenu(); noviceLogout(); };
    el('btn-settings-user').onclick = () => { closeSettingsMenu(); noviceOpenUserSettings(); };
    el('btn-settings-update').onclick = () => { closeSettingsMenu(); noviceCheckUpdate(); };
    // 点页面其他地方收起下拉
    document.addEventListener('click', event => {
        if (event.target && event.target.closest && !event.target.closest('.nv-help-wrap')) menuClosers.forEach(fn => fn());
    });
    // 用户设置 / 更新弹窗
    const closeUserSettings = () => el('user-settings-modal').classList.add('nv-hidden');
    el('user-settings-close').onclick = closeUserSettings;
    el('user-settings-cancel').onclick = closeUserSettings;
    el('change-password-form').onsubmit = noviceChangePassword;
    el('update-modal-close').onclick = () => el('update-modal').classList.add('nv-hidden');
    el('update-modal-ok').onclick = () => el('update-modal').classList.add('nv-hidden');
    el('btn-envcheck-refresh').onclick = () => noviceRunEnvCheck();
    // 登录在独立页面 /login 完成（见 novice_login.js），这里不再有登录弹窗
    // 产品环境
    el('btn-env-back').onclick = () => noviceSetView('node');
    el('btn-new-env').onclick = () => noviceOpenEnvForm().catch(error => patchShowError(error.message, '打开失败'));
    el('env-form').onsubmit = noviceSaveEnv;
    el('env-form').product_id.addEventListener('change', event => noviceFillVersions(event.target.form, event.target.value, null));
    el('env-advanced-toggle').onclick = () => {
        const adv = el('env-advanced');
        const hidden = adv.classList.toggle('nv-hidden');
        el('env-advanced-toggle').textContent = hidden ? '▸ 高级设置（选填）' : '▾ 高级设置（收起）';
    };
    const closeEnvForm = () => el('env-form-modal').classList.add('nv-hidden');
    el('env-form-close').onclick = closeEnvForm;
    el('env-form-cancel').onclick = closeEnvForm;
    el('env-list').addEventListener('click', event => {
        const editBtn = event.target.closest('button[data-env-edit]');
        if (editBtn) {
            const env = (patchState.envs || []).find(item => String(item.id) === String(editBtn.dataset.envEdit));
            if (env) noviceOpenEnvForm(env).catch(error => patchShowError(error.message, '打开失败'));
            return;
        }
        const delBtn = event.target.closest('button[data-env-del]');
        if (delBtn) noviceDeleteEnv(delBtn.dataset.envDel);
    });
    // 错误弹窗
    el('patchErrorConfirm').onclick = patchCloseError;
    el('patchErrorClose').onclick = patchCloseError;
}

(function init() {
    // 主题由 app.js（聊天页逻辑）管理（同一个 cc-web-theme 键、同一个 #themeToggle）
    noviceBindEvents();
    // 认证链：配置 → 恢复登录（common.js）。聊天不需要登录；环境相关视图按需弹登录层。
    noviceLoadConfig()
        .then(() => patchRestoreAuth())
        .catch(error => {
            // 连不上补丁中心不影响本地聊天：只在控制台提示
            console.warn('[novice] 补丁中心连接失败：', error.message);
        });
})();
