// 管理页（版本切换 / 变量下拉 / 预览渲染 / 发布通道）冒烟测试：node admin_smoke.js
const fs = require('fs');
const path = require('path');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function makeEl(id, isDiv) {
    const base = {
        id, _html: '', _text: '', value: '', hidden: false, disabled: false, placeholder: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        dataset: {}, style: {}, files: [], selectionStart: 0, selectionEnd: 0, _q: {},
        addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
        focus() {}, setAttribute() {}, removeAttribute() {},
        querySelector(sel) { if (!this._q[sel]) this._q[sel] = makeEl(id + ' ' + sel); return this._q[sel]; },
        querySelectorAll() { return []; },
    };
    Object.defineProperty(base, 'innerHTML', {
        get() { return base._html; },
        set(v) { base._html = String(v); base._text = String(v).replace(/<[^>]*>/g, ''); },
    });
    Object.defineProperty(base, 'textContent', {
        get() { return base._text; },
        set(v) { base._text = String(v); base._html = isDiv ? esc(v) : String(v); },
    });
    return new Proxy(base, {
        get(t, k) {
            if (k in t) return t[k];
            if (typeof k === 'string' && !['then', 'toJSON', 'nodeType', 'tagName'].includes(k)) { t[k] = makeEl(id + '.' + k); return t[k]; }
            return undefined;
        },
        set(t, k, v) { t[k] = v; return true; },
    });
}

const els = new Map();
global.document = {
    documentElement: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } },
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    createElement(t) { return makeEl('created-' + t, t === 'div'); },
    addEventListener() {}, body: { appendChild() {} },
    querySelector() { return makeEl('qs'); }, querySelectorAll() { return []; },
};
global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, prompt: () => null, confirm: () => true };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.location = { reload() {}, href: '', search: '', pathname: '/' };
global.fetch = async () => ({ ok: true, json: async () => ({ data: [], success: true }) });
global.crypto = { randomUUID: () => 'x' };
global.requestAnimationFrame = fn => {};

const TEST = `
;(async () => {
// Node 桩环境：window 是普通对象而非全局对象；浏览器里 window.NODE_UI 就是全局 NODE_UI。
// 桥一下，让 node_core 里的 NODE_UI.xxx 标识符可解析。
if (typeof global !== 'undefined' && window.NODE_UI) global.NODE_UI = window.NODE_UI;
let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : ' | ' + extra)); if (!cond) fails++; };

// 1. 变量下拉按版本过滤
const devVars = nodePromptVarOptions('phase1', 'dev');
const noviceVars = nodePromptVarOptions('phase1', 'novice');
check('dev 阶段一不含 env_extra', !devVars.includes('env_extra'));
check('novice 阶段一含 env_extra/constraints_extra', noviceVars.includes('env_extra') && noviceVars.includes('constraints_extra'));
check('novice 阶段一含 record_url', noviceVars.includes('record_url'));
check('seg_db 含 db_connection', nodePromptVarOptions('seg_db', 'novice').includes('db_connection'));
check('seg_code_dir 含 code_directory', nodePromptVarOptions('seg_code_dir', 'novice').includes('code_directory'));
check('dev 变量下拉不含片段专属变量', !nodePromptVarOptions('phase1', 'dev').includes('constraints_extra'));

// 2. 阶段清单按版本
check('dev 阶段数=3', NODE_PROMPT_STAGES_BY_EDITION.dev.length === 3);
check('novice 含 3 个片段阶段', NODE_PROMPT_STAGES_BY_EDITION.novice.filter(x => x[0].startsWith('seg_')).length === 3);

// 3. 小白默认模板
const nt = NODE_PROMPT_NOVICE_DEFAULT_TEMPLATES;
check('小白默认含 6 个阶段', ['phase1', 'phase2', 'retry', 'seg_code_dir', 'seg_db', 'seg_debug'].every(k => nt[k] && nt[k].trim()));
check('phase1 带两个锚点', nt.phase1.includes('{{env_extra}}') && nt.phase1.includes('{{constraints_extra}}'));
check('开发版默认模板未变', !!NODE_PROMPT_DEFAULT_TEMPLATES.phase1);
check('开发版默认不含 env_extra', !NODE_PROMPT_DEFAULT_TEMPLATES.phase1.includes('{{env_extra}}'));

// 4. 预览渲染
patchState.admin.npEdition = 'novice';
const values = npPreviewSampleValues('novice', 'phase1');
const rendered = renderNodeTemplate(nt.phase1, values);
check('预览无残留占位符', !rendered.includes('{{'), String(rendered.match(/\\{\\{[^}]+\\}\\}/)));
check('预览含示例问题描述', rendered.includes('应收单'));
check('预览含锚点内容', rendered.includes('环境补充段') && rendered.includes('额外约束段'));
check('预览含 MCP root', rendered.includes('fbip-82'));

// 5. 阶段标签
check('片段阶段有中文名', nodeStageLabel('seg_db').includes('数据库'));

// 6. 发布通道
check('发布通道默认 dev', patchState.admin.releaseEdition === 'dev');
releaseSwitchEdition('novice');
check('切换到 novice', patchState.admin.releaseEdition === 'novice');

// 7. 提示词切换后消息与列表过滤（用桩 fetch 返回两个版本的行）
check('npEdition 状态可切换', (npSwitchEdition('dev'), patchState.admin.npEdition === 'dev'));

// 8. NODE_UI 钩子齐全（patches.js 会整体覆盖 node_core.js 的默认钩子，漏一个就会跑挂）
check('NODE_UI 五个钩子齐全', ['appendText', 'renderRunPanel', 'renderRuns', 'reloadRuns', 'report']
    .every(k => typeof window.NODE_UI[k] === 'function'),
    Object.keys(window.NODE_UI).map(k => k + ':' + typeof window.NODE_UI[k]).join(','));
check('patchNodeAppendText 可调用', (patchNodeAppendText('x'), true));

// 9. 接口录制交互（stub fetch 模拟后端 open/status/close + 文件读取）
patchState.edition = 'novice';
patchState.admin.projectEnvs = [{ id: 1, project_name: 'E1', record_url: 'http://demo/app' }];
const runForm = document.getElementById('patchNodeRunForm');
runForm.env_id.value = '1';
const recordedJson = JSON.stringify([{ method: 'POST', url: '/arap/bill.do', status: 500 }, { method: 'GET', url: '/common/load.do', status: 200 }]);
global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/recorder/open')) return { ok: true, status: 200, json: async () => ({ success: true }) };
    if (u.includes('/api/recorder/status')) return { ok: true, status: 200, json: async () => ({ success: true, state: 'finished', file: 'C:/rec/r1.json', interfaces: JSON.parse(recordedJson) }) };
    if (u.includes('/api/recorder/close')) return { ok: true, status: 200, json: async () => ({ success: true }) };
    if (u.includes('/api/files/')) return { ok: true, status: 200, json: async () => ({ success: true, content: recordedJson }) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
};
await patchRecordOpen('form');
await patchRecordPollOnce();
patchRecordStopPolling();
const triggerEl = runForm.querySelector('[name="trigger_url"]');
check('录制结束→路径回显到触发项', triggerEl.value === 'C:/rec/r1.json', triggerEl.value);
const recList = document.getElementById('patchRecordList').textContent;
check('录制接口列表（报错标 ✗）', recList.includes('✗ POST /arap/bill.do → 500') && recList.includes('· GET /common/load.do → 200'), recList);
check('已导出提示', document.getElementById('patchRecordFile').textContent.includes('已导出：C:/rec/r1.json'));
// 环境没配录制地址 → 按钮置灰
patchState.admin.projectEnvs = [{ id: 2, project_name: 'E2', record_url: '' }];
runForm.env_id.value = '2';
patchNodeEnvHint();
check('无录制地址→录制按钮置灰', document.getElementById('patchNodeRecordBtn').disabled === true);
// 重跑时新录制的接口数据拼进 retry 提示词（路径 + 摘要 + find_action）
const recRun = { edition: 'novice', problem_desc: 'x', turn_dir: 'C:/w/s1', stage_dir: 'C:/w/s1/work', phase1_step: 2,
    env_snapshot: { product_name: 'FBIP', product_version: '8.2', package_path: 'D:/home' } };
const retryWithRec = await noviceBuildPrompt(recRun, 'retry', { note: '', logText: '', recordPath: 'C:/rec/r1.json' });
check('重跑拼接新录制数据', retryWithRec.includes('本次新录制的接口数据') && retryWithRec.includes('C:/rec/r1.json'), retryWithRec.slice(-200));
check('重跑录制数据含 find_action 要求', retryWithRec.includes('find_action'));

console.log(fails ? ('共 ' + fails + ' 项 FAIL') : '全部 PASS');
})();
`;
const src = ['common.js', 'node_core.js', 'prompts_novice.js', 'patches.js']
    .map(f => fs.readFileSync(path.join(__dirname, '../../static', f), 'utf8')).join('\n;\n');
eval(src + TEST);
