/* ══════════════════════════════════════════════════════════════════
   补丁中心左侧导航 —— 四个页面共用（patches / node_run / adapt_run / workflow_run）
   ──────────────────────────────────────────────────────────────────
   为什么共用一份：**菜单在登录时就定了**——服务器 /api/auth/me 返回 visible_keys()
   （admin 直接给全集；普通用户按「用户覆盖 → 角色配置 → 代码默认」）。以前三个详情页
   各自硬编码了一份静态副本，各少几项、还会互相漂移（适配详情页只有 8 项就是这来的）。
   现在四个页面都只留一个空容器（<nav id="patchSidenav"> 里的 .patch-sidenav-items），
   由这里统一渲染 + 显隐 + 高亮 + 折叠。

   改菜单只改这里一处：ITEMS 的顺序与服务器 MENU_CATALOG 一致；
   末尾 menus / sessions 是前端专属、仅管理员可见。

   兜底：未登录或取不到用户时，按服务器 DEFAULT_VISIBLE 的等价规则
   （隐藏 analysis / product 与两项管理员项），不把菜单留空。
   ══════════════════════════════════════════════════════════════════ */
(function () {
    const TOKEN_KEY = 'patch-search-access-token';
    const COLLAPSE_KEY = 'cc-web-patch-sidenav';
    // 前端专属的管理员项（不在服务器 MENU_KEYS 里，admin 也不会由 /api/auth/me 下发）
    const ADMIN_ONLY = ['menus', 'sessions'];
    // 取不到用户时的兜底：等价于服务器 DEFAULT_VISIBLE（analysis / product 默认对普通用户隐藏）
    const DEFAULT_HIDDEN = ['analysis', 'product'];

    const SVG_ATTRS = 'class="patch-sidenav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

    const ITEMS = [
        {key: 'node', label: '智能开发', icon: '<circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line>'},
        {key: 'smart', label: '智能分析', icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>'},
        {key: 'search', label: '普通检索', icon: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'},
        {key: 'upload', label: '补丁上传', icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line>'},
        {key: 'mine', label: '我的补丁', icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>'},
        {key: 'adapt', label: '补丁适配', icon: '<circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M6 21V9a9 9 0 0 0 9 9"></path>'},
        {key: 'flow', label: '流程设置', icon: '<line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>'},
        {key: 'prompt', label: '提示词设置', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'},
        {key: 'template', label: '流程模板设置', icon: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'},
        {key: 'analysis', label: '待分析补丁', icon: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>'},
        {key: 'product', label: '产品版本管理', icon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line>'},
        {key: 'directory', label: '工作目录', icon: '<path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path>'},
        {key: 'project_env', label: '产品环境变量', icon: '<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"></path><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"></path>'},
        {key: 'menus', label: '菜单可见性', icon: '<line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line>'},
        {key: 'sessions', label: '会话存档', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'},
    ];

    // 当前页对应哪个菜单项：三个详情页按页面名，主页面按 ?tab=
    function currentKey() {
        const path = location.pathname;
        if (path.endsWith('/adapt_run.html')) return 'adapt';
        if (path.endsWith('/node_run.html')) return 'node';
        if (path.endsWith('/workflow_run.html')) return 'smart';
        return new URLSearchParams(location.search).get('tab') || '';
    }

    function render() {
        const host = document.querySelector('#patchSidenav .patch-sidenav-items');
        if (!host) return;
        const active = currentKey();
        host.innerHTML = ITEMS.map(item =>
            `<a class="patch-sidenav-item${item.key === active ? ' active' : ''}" data-sidenav-tab="${item.key}" href="/patches.html?tab=${item.key}" title="${item.label}">` +
            `<svg ${SVG_ATTRS}>${item.icon}</svg><span class="patch-sidenav-label">${item.label}</span></a>`
        ).join('');
    }

    function applyVisibility(user) {
        const isAdmin = Boolean(user && user.role === 'admin');
        const keys = user && Array.isArray(user.menus) ? user.menus : null;
        document.querySelectorAll('#patchSidenav .patch-sidenav-item').forEach(item => {
            const key = item.dataset.sidenavTab;
            if (ADMIN_ONLY.includes(key)) { item.hidden = !isAdmin; return; }
            if (isAdmin) { item.hidden = false; return; }        // admin：全集
            if (keys) { item.hidden = !keys.includes(key); return; }
            item.hidden = DEFAULT_HIDDEN.includes(key);          // 兜底（旧后端 / 未登录）
        });
        // 与主页面同款安全网：一个菜单都不可见时至少留第一项，别给一个空侧边栏
        const items = Array.from(document.querySelectorAll('#patchSidenav .patch-sidenav-item'));
        if (items.length && !items.some(item => !item.hidden)) items[0].hidden = false;
    }

    // 逐条地址试 /api/auth/me（与详情页取当前用户同款），拿不到就返回 null 走兜底
    async function fetchUser() {
        const token = localStorage.getItem(TOKEN_KEY) || '';
        if (!token) return null;
        let servers = [];
        try {
            const response = await fetch('/api/patch-config');
            if (response.ok) {
                const config = await response.json();
                servers = (config.patch_search_servers || []).map(value => String(value).trim().replace(/\/+$/, '')).filter(Boolean);
            }
        } catch (error) { /* 拿不到地址就只走兜底 */ }
        for (const base of servers) {
            try {
                const response = await fetch(`${base}/api/auth/me`, {headers: {Authorization: `Bearer ${token}`}});
                if (!response.ok) continue;
                const payload = await response.json().catch(() => ({}));
                if (payload && payload.code === 0 && payload.data) return payload.data;
            } catch (error) { /* 换下一条地址 */ }
        }
        return null;
    }

    // 折叠/展开：与改造前同一套（class + localStorage key + 按钮文案）
    function bindToggle() {
        const toggle = document.getElementById('patchSidenavToggle');
        if (!toggle) return;
        const sync = () => {
            const collapsed = document.documentElement.classList.contains('sidenav-collapsed');
            toggle.textContent = collapsed ? '›' : '‹';
            toggle.title = collapsed ? '展开菜单' : '收起菜单';
            toggle.setAttribute('aria-label', toggle.title);
            toggle.setAttribute('aria-expanded', String(!collapsed));
        };
        toggle.addEventListener('click', () => {
            const collapsed = document.documentElement.classList.toggle('sidenav-collapsed');
            try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '0' : '1'); } catch (error) { /* 隐私模式等 */ }
            sync();
        });
        sync();
    }

    render();
    bindToggle();
    fetchUser().then(applyVisibility).catch(() => applyVisibility(null));
})();
