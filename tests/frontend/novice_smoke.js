// 小白版前端冒烟测试（DOM 桩）：node novice_smoke.js
// 覆盖：novice.js 的环境页渲染 + prompts_novice.js 的提示词拼接
const fs = require('fs');
const path = require('path');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function makeEl(id, isDiv) {
    const base = {
        id, _html: '', _text: '', value: '', hidden: false, disabled: false, placeholder: '',
        classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
        dataset: {}, style: {}, files: [],
        addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
        focus() {}, setAttribute() {}, removeAttribute() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        onclick: null, onchange: null, onkeydown: null, onsubmit: null,
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
    createElement(tag) { return makeEl('created-' + tag, tag === 'div'); },
    addEventListener() {}, body: { appendChild() {} },
};
global.window = { matchMedia: () => ({ matches: false }), addEventListener() {} };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.location = { reload() {}, search: '', href: '', replace() {} };
global.fetch = async () => ({ ok: true, json: async () => ({}) });
global.crypto = { randomUUID: () => 'x' };
global.requestAnimationFrame = fn => {};

const TEST = `
;(async () => {
let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : ' | ' + extra)); if (!cond) fails++; };

// 1. 环境列表渲染
patchState.envs = [{ id: 1, project_name: 'FBIP 8.2', package_path: 'D:/nchome/FBIP8.2', local_jdk_path: '' }];
noviceRenderEnvs();
const envHtml = document.getElementById('env-list').innerHTML;
check('环境列表渲染', envHtml.includes('FBIP 8.2') && envHtml.includes('D:/nchome'));
check('环境列表 XSS 转义', !noviceRenderEnvs || !envHtml.includes('<script>'));

// 1.5 补丁检索列表渲染
patchState.patchSearch = { keyword: '', page: 1, size: 20, total: 1, items: [
    { id: 'p1', name: '薪资补丁 <x>', file_name: 'salary.zip', product_name: 'FBIP', product_version: '8.2', file_format: 'zip', file_size: 2048, status: 2, analyzed_at: '2026-11-01T00:00:00Z' },
] };
noviceRenderPatches();
const patchHtml = document.getElementById('patchSearchList').innerHTML;
check('补丁列表渲染名称并转义', patchHtml.includes('salary.zip') && patchHtml.includes('薪资补丁 &lt;x&gt;'), patchHtml.slice(0, 120));
check('补丁列表有详情/下载按钮', patchHtml.includes('data-patch-detail="p1"') && patchHtml.includes('data-patch-download="p1"'));
check('分析结果只取 function_desc', novicePatchResultText({ extra: 1, function_desc: '修改了保存逻辑' }) === '修改了保存逻辑');
check('分析结果支持 JSON 字符串', novicePatchResultText('{"function_desc":"描述X"}') === '描述X');
check('分析结果无 function_desc 时占位', novicePatchResultText({ foo: 1 }) === '（暂无分析结果）');

// 2. 提示词拼接（与改前一致的核心断言）
const r = { edition: 'novice', problem_desc: '测试问题', trigger_url: '', turn_dir: 'C:/w/step01', stage_dir: 'C:/w/step01/work',
    env_snapshot: { product_name: 'FBIP', product_version: '8.2', package_path: 'D:/nchome', db_connection: 'jdbc:mysql://1.2.3.4:3306/db?user=u&password=Secret123', local_jdk_path: '' } };
const prompt = await noviceBuildPrompt(r, 'phase1');
check('提示词含问题描述', prompt.includes('测试问题'));
check('提示词口令掩码（无明文）', !prompt.includes('Secret123'));
check('提示词无残留占位符', !prompt.includes('{{'), String(prompt.match(/\\{\\{[^}]+\\}\\}/)));
check('JDK 空值→自动查找/下载指令', prompt.includes('cc-web 安装目录/jdk') && prompt.includes('项目需要的 JDK 版本'));
check('MCP root 拼接', prompt.includes('fbip-82'));
check('数据库只读约束', prompt.includes('只允许查询'));
const p2 = await noviceBuildPrompt(r, 'phase2');
check('phase2 无客开目录→跳过同步', p2.includes('跳过「同步回工程」'));
check('phase2 含打包指令', p2.includes('java_generate_patch'));
const r2 = JSON.parse(JSON.stringify(r)); r2.env_snapshot.code_directory = 'D:/proj';
const p2b = await noviceBuildPrompt(r2, 'phase2');
check('phase2 有客开目录→同步回工程', p2b.includes('同步回客开工程'));
const retry = await noviceBuildPrompt(r, 'retry', { note: '还是不行', logText: 'ERROR stack' });
check('retry 含新日志与补充说明', retry.includes('ERROR stack') && retry.includes('还是不行'));

// 问题截图：提示词里带绝对路径并要求先用 Read 查看
const imgRun = JSON.parse(JSON.stringify(r));
imgRun.image_paths = ['C:/ccweb/temp/node/x/images/a.png', 'C:/ccweb/temp/node/x/images/b.jpg'];
const imgPrompt = await noviceBuildPrompt(imgRun, 'phase1');
check('提示词含问题截图路径', imgPrompt.includes('a.png') && imgPrompt.includes('b.jpg'));
check('提示词要求 Read 查看附件', imgPrompt.includes('Read') && imgPrompt.includes('问题附件'));
// 只传截图、不写文字：提示词里要有占位说明
const imgOnly = JSON.parse(JSON.stringify(r));
imgOnly.problem_desc = '';
imgOnly.image_paths = ['C:/ccweb/temp/node/x/images/only.png'];
const imgOnlyPrompt = await noviceBuildPrompt(imgOnly, 'phase1');
check('只传附件时提示词有占位说明', imgOnlyPrompt.includes('见附带的问题图片/文件'));
// 日志附件：提示词里带路径并要求 Read 查看
const logRun = JSON.parse(JSON.stringify(r));
logRun.log_paths = ['C:/ccweb/temp/node/x/images/err.png', 'C:/ccweb/temp/node/x/images/server.log'];
const logPrompt = await noviceBuildPrompt(logRun, 'phase1');
check('提示词含日志附件路径', logPrompt.includes('err.png') && logPrompt.includes('server.log'));
check('提示词有日志附件段落', logPrompt.includes('【日志附件】'));

// 3. 管理员配置的片段模板：渲染 + 掩码
const segRun = JSON.parse(JSON.stringify(r));
segRun.env_snapshot.code_directory = 'D:/proj';
const segs = await noviceSegments(segRun, {
    seg_code_dir: '工程目录：{{code_directory}}（只读参考）',
    seg_db: '数据库连接：{{db_connection}}。只允许查询。',
    seg_debug: null,
});
check('片段模板 {{var}} 已渲染', segs.env.join('|').includes('工程目录：D:/proj'));
check('片段模板口令已掩码', !segs.constraints.join('|').includes('Secret123'));
check('片段模板约束生效', segs.constraints.join('|').includes('只允许查询'));

// 4. 主模板路径：{{db_connection}} 也必须掩码
const tplRun = JSON.parse(JSON.stringify(r));
tplRun.nodePrompts = { phase1: '描述：{{problem_desc}}\\n连接：{{db_connection}}\\n{{env_extra}}\\n{{constraints_extra}}' };
const tplPrompt = await noviceBuildPrompt(tplRun, 'phase1');
check('主模板路径无明文口令', !tplPrompt.includes('Secret123'));
check('主模板路径渲染问题描述', tplPrompt.includes('测试问题'));
check('主模板路径无残留占位符', !tplPrompt.includes('{{'));
console.log(fails ? ('共 ' + fails + ' 项 FAIL') : '全部 PASS');
})();
`;
const src = ['common.js', 'node_core.js', 'prompts_novice.js', 'novice.js']
    .map(f => fs.readFileSync(path.join(__dirname, '../../static', f), 'utf8')).join('\n;\n');
eval(src + TEST);
