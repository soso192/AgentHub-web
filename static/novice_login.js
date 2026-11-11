// ============================================================
//  novice_login.js - 小白版独立登录页（/login）
//  依赖（先加载）：common.js（patchLogin / patchRequest / patchToken）
//  登录成功后整页跳到主界面 "/"；主界面发现没有 token 时也会整页跳回这里，
//  所以刷新登录页不会先闪出主界面。
// ============================================================

const patchState = {
    patchSearchServers: [],
    patchServerCursor: 0,
    authInvalidated: false,
};

function el(id) { return document.getElementById(id); }

function setLoginMessage(text) {
    const node = el('patchLoginMessage');
    if (node) node.textContent = text || '';
}

/* ── common.js 需要的回调 ── */
// 登录页没有主界面的错误弹窗，错误直接显示在卡片里
function patchShowError(message) { setLoginMessage(message); }
function patchShowAuthRetry(message) { setLoginMessage(message); }
function patchSetApiStatus() {}

// 登录成功：整页进入主界面
function patchSetAuthenticated(user) {
    if (user) window.location.replace('/');
}

// token 失效：清掉本地 token，停在登录页提示重新登录
function patchHandleUnauthorized() {
    if (patchState.authInvalidated) return;
    patchState.authInvalidated = true;
    try { localStorage.removeItem(PATCH_TOKEN_KEY); } catch (e) {}
    setLoginMessage('登录已失效，请重新登录');
}

/* ── 初始化 ── */

async function loginLoadConfig() {
    const response = await fetch('/api/patch-config');
    const config = response.ok ? await response.json().catch(() => ({})) : {};
    let servers = Array.isArray(config.patch_search_servers)
        ? config.patch_search_servers
        : (config.patch_search_api ? [config.patch_search_api] : []);
    servers = servers.map(value => String(value).trim()).filter(Boolean);
    if (!servers.length) throw new Error('无法连接补丁中心，请稍后重试或联系管理员');
    patchState.patchSearchServers = servers;
    patchState.patchServerCursor = 0;
}

async function submitLogin() {
    const button = el('btn-login');
    if (button) button.disabled = true;
    setLoginMessage('');
    try {
        await patchLogin();   // 成功时 patchSetAuthenticated → 跳到 "/"
    } finally {
        // 成功会整页跳走；失败/配置异常时把按钮恢复可点
        if (button && !document.hidden) button.disabled = false;
    }
}

(function init() {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get('reason');
    if (reason === 'password') setLoginMessage('密码修改成功，请使用新密码重新登录');
    else if (reason === 'expired') setLoginMessage('登录已失效，请重新登录');

    const button = el('btn-login');
    if (button) button.onclick = submitLogin;
    const password = el('patchLoginPassword');
    if (password) password.onkeydown = event => { if (event.key === 'Enter') submitLogin(); };
    const username = el('patchLoginUsername');
    if (username) username.focus();

    loginLoadConfig()
        .then(() => {
            if (!patchToken()) return null;
            // 已经有 token：验证有效就直接进主界面，无效就停在登录页
            return patchRequest('/api/auth/me')
                .then(user => { patchSetAuthenticated(user); return user; })
                .catch(error => { if (!patchState.authInvalidated) setLoginMessage(error.message); });
        })
        .catch(error => setLoginMessage(error.message));
})();
