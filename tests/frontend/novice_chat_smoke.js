// 小白版统一外壳（novice_chat.js 部分）冒烟测试：node tests/frontend/novice_chat_smoke.js
// 用 DOM 桩 + fetch 桩验证：新建排查按钮挂接、表单构建、提交链路（建目录→建会话→发一次阶段一提示词）
const fs = require('fs');
const path = require('path');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function makeEl(id, isDiv) {
    const base = {
        id, _html: '', _text: '', value: '', disabled: false, placeholder: '', type: '',
        style: {}, files: [], _parent: null,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        dataset: {},
        addEventListener() {}, removeEventListener() {}, remove() {},
        focus() {}, setAttribute() {}, removeAttribute() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        parentNode: { insertBefore() {} },
        appendChild() {},
        onclick: null, onchange: null,
    };
    Object.defineProperty(base, 'innerHTML', { get() { return base._html; }, set(v) { base._html = String(v); base._text = String(v).replace(/<[^>]*>/g, ''); } });
    Object.defineProperty(base, 'textContent', { get() { return base._text; }, set(v) { base._text = String(v); base._html = isDiv ? esc(v) : String(v); } });
    const proxy = new Proxy(base, {
        get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && !['then', 'toJSON'].includes(k)) { t[k] = makeEl(id + '.' + k); return t[k]; } return undefined; },
        set(t, k, v) {
            if (k === 'id' && typeof v === 'string' && !els.has(v)) els.set(v, proxy);
            if (k === 'innerHTML') parseIds(v);
            t[k] = v;
            return true;
        },
    });
    return proxy;
}

const els = new Map();
function parseIds(html) {
    for (const m of String(html).matchAll(/id="([^"]+)"/g)) {
        if (!els.has(m[1])) els.set(m[1], makeEl(m[1]));
    }
}

// 外壳里已有的元素（对应 novice.html 的静态标记）
for (const id of ['sessionList', 'noviceNewRunBtn', 'nv-view-chat', 'nv-view-env', 'nv-view-check', 'nav-node', 'nav-env', 'nav-check']) {
    els.set(id, makeEl(id));
}

global.document = {
    documentElement: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } },
    getElementById(id) { return els.get(id) || null; },
    createElement(tag) { return makeEl('created-' + tag, tag === 'div'); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, body: { appendChild() {} },
};

global.window = global;   // 浏览器里 window 就是全局对象
global.matchMedia = () => ({ matches: false });
global.addEventListener = () => {};
global.localStorage = { getItem: () => 'fake-token', setItem() {}, removeItem() {} };
global.location = { href: '', reload() {}, search: '' };
global.requestAnimationFrame = fn => {};
global.crypto = { randomUUID: () => 'test-run-id' };
global.AbortController = class { constructor() { this.signal = { aborted: false, addEventListener() {} }; } abort() {} };
global.Headers = class { constructor() { this.map = {}; } set(k, v) { this.map[k.toLowerCase()] = v; } get(k) { return this.map[k.toLowerCase()] || null; } has(k) { return k.toLowerCase() in this.map; } };
global.URL.createObjectURL = () => 'blob:test';
global.URL.revokeObjectURL = () => {};
global.FormData = class { constructor() { this.entries = []; } append(k, v, name) { this.entries.push([k, v, name]); } };

// app.js 的全局函数桩
const calls = { sessions: 0, selected: null, sse: null, view: null, requests: [] };
global.loadSessions = async () => { calls.sessions += 1; };
global.renderSessionList = () => {};
global.selectSession = async id => { calls.selected = id; };
global.connectSSE = (id, prompt) => { calls.sse = { id, prompt }; return {}; };
global.showAppNotice = () => {};
global.patchToken = () => 'fake-token';
global.noviceSetView = view => { calls.view = view; };
global.noviceRequireLogin = () => true;

// fetch 桩
global.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.requests.push({ url: u, method: options.method || 'GET', body: options.body || '' });
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (u.includes('/api/version')) return json({ success: true, data: { edition: 'novice' } });
    if (u.includes('/api/patch-config')) return json({ patch_search_servers: ['http://patch.local'] });
    if (u.includes('/api/project-envs')) return json({ code: 0, data: [{ id: 1, project_name: '环境A', product_name: 'FBIP', product_version: '8.2', package_path: 'D:/home', record_url: 'http://demo/app' }] });
    if (u.includes('/api/node-prompts/resolve')) return json({ code: 0, data: { phase1: null, source: 'default' } });
    if (u.includes('/api/node/workspace')) return json({ success: true, path: 'C:/ccweb/temp/node/test-run-id' });
    if (u.includes('/api/env-check')) return json({ success: true, home_jdk: { ok: false } });
    if (u.includes('/api/agent/new')) return json({ success: true, sessionId: 'sess-123', assistant: 'claude' });
    return json({ success: true, code: 0, data: [] });
};

const src = ['common.js', 'node_core.js', 'prompts_novice.js', 'novice_chat.js']
    .map(f => fs.readFileSync(path.join(__dirname, '../../static', f), 'utf8')).join('\n;\n');
global.__calls = calls;
const TEST = `
;(async () => {
let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : ' | ' + extra)); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

await sleep(500); // init：版本探测 + 等页面就绪 + 挂接按钮/建弹窗

check('新建排查按钮已挂接', typeof document.getElementById('noviceNewRunBtn').onclick === 'function');
check('排查弹窗已构建', Boolean(document.getElementById('noviceRunModal')) && Boolean(document.getElementById('noviceRunDesc')));

// 提交链路：打开表单 → 选环境 → 填描述 → 提交
await document.getElementById('noviceNewRunBtn').onclick();
await sleep(150);
// 必填项为空时点「开始排查」：应显示校验提示，且不创建会话
await document.getElementById('noviceRunSubmit').onclick();
await sleep(100);
check('必填项为空时有校验提示', String(document.getElementById('noviceRunError').textContent).includes('产品环境'));
check('校验失败不创建会话', !global.__calls.sse);

const envSelect = document.getElementById('noviceRunEnv');
check('环境下拉已填充', String(envSelect.innerHTML).includes('环境A'), String(envSelect.innerHTML).slice(0, 100));
envSelect.value = '1';
document.getElementById('noviceRunDesc').value = '一二三四五六七八九十一二三四五六七八九十';
// 只填了环境和问题描述、没填录制页面地址：仍然不能提交
await document.getElementById('noviceRunSubmit').onclick();
await sleep(100);
check('缺少录制页面地址时有校验提示', String(document.getElementById('noviceRunError').textContent).includes('录制页面地址'));
check('缺少录制页面地址不创建会话', !global.__calls.sse);

document.getElementById('noviceRunUrl').value = 'http://demo/app';
await document.getElementById('noviceRunSubmit').onclick();
await sleep(400);
check('会话已创建并选中', global.__calls.selected === 'sess-123', JSON.stringify(global.__calls.selected));
check('提交后切回智能开发视图', global.__calls.view === 'node');
check('阶段一提示词已发出（一次）', Boolean(global.__calls.sse) && global.__calls.sse.id === 'sess-123');
const prompt = global.__calls.sse && global.__calls.sse.prompt || '';
check('提示词含问题描述', prompt.includes('一二三四五六七八九十'), prompt.slice(0, 100));
check('提示词含产品环境', prompt.includes('FBIP') && prompt.includes('8.2'));
const nameRequest = global.__calls.requests.find(item => item.method === 'PATCH' && item.url.includes('/api/sessions/sess-123/name'));
let nameBody = {};
try { nameBody = JSON.parse(nameRequest && nameRequest.body || '{}'); } catch (e) {}
check('默认会话名取问题描述前15字', nameBody.name === '一二三四五六七八九十一二三四五', JSON.stringify(nameBody));
check('弹窗已关闭', document.getElementById('noviceRunModal').style.display === 'none');

// 只传附件、不写文字：默认会话名 = 产品名+版本号+月日时分
await document.getElementById('noviceNewRunBtn').onclick();
await sleep(150);
document.getElementById('noviceRunEnv').value = '1';
document.getElementById('noviceRunImages').onchange({ target: { files: [{ name: 'shot.png', size: 10, type: 'image/png' }], value: '' } });
document.getElementById('noviceRunUrl').value = 'http://demo/app';
await document.getElementById('noviceRunSubmit').onclick();
await sleep(400);
const nameRequests = global.__calls.requests.filter(item => item.method === 'PATCH' && item.url.includes('/api/sessions/sess-123/name'));
const fallbackBody = JSON.parse(nameRequests[nameRequests.length - 1].body || '{}');
check('无文字时会话名为 产品+版本+月日时分', /^FBIP8\\.2 \\d+月\\d+日\\d+时\\d{2}分$/.test(fallbackBody.name || ''), String(fallbackBody.name));
console.log(fails ? ('共 ' + fails + ' 项 FAIL') : '全部 PASS');
})();
`;
eval(src + TEST);
