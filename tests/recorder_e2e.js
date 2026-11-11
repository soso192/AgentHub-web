// 接口录制端到端测试：node tests/recorder_e2e.js
//
// 流程：起一个假的 patch_search（提供产品环境 + 测试页 + .do 接口）→ 临时把
// target/release/patch_servers.json 指向它 → 启动小白版 cc-web → 调 /api/recorder/open
// → 测试页里的脚本自动"点"悬浮按钮（直接写 sessionStorage）并发出两条 .do 请求
// （一条 200、一条 500，带 Authorization 头与 password 字段）→ 停止后断言导出 JSON：
// 接口齐全、报错接口有响应体、凭据已脱敏。
//
// 需要：已构建 target/release/cc-web.exe（--features novice）、本机有 Chrome/Edge。
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'cc-web.exe');
const CONFIG_FILE = path.join(ROOT, 'target', 'release', 'patch_servers.json');
const FAKE_PORT = 3998;
const CCWEB_PORT = 3031;

const fails = [];
function check(name, cond, extra) {
    console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : ' | ' + extra));
    if (!cond) fails.push(name);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 假补丁中心 + 测试页 ──
const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h3>recorder e2e</h3>
<script>
function setReq(obj){ try { sessionStorage.setItem('__REC_TOOL_REQ__', JSON.stringify(obj)); } catch(e){} }
setTimeout(function(){ setReq({seq:Date.now(), on:true}); }, 1200);
setTimeout(function(){
  fetch('/api/foo.do?x=1', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer secret-token-123'},
    body: JSON.stringify({user:'u1', password:'p@ssw0rd', name:'张三', token:'tok-abc'})}).catch(function(){});
  fetch('/api/bar.do?y=2', {headers:{'Authorization':'Bearer secret-token-123'}}).catch(function(){});
}, 2500);
setTimeout(function(){ setReq({seq:Date.now(), on:false}); }, 6500);
</script></body></html>`;

const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const send = (code, body, type) => {
        res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.startsWith('/api/project-envs')) {
        return send(200, { code: 0, data: [{ id: 1, project_name: '测试环境', product_name: 'T', product_version: '1', record_url: `http://127.0.0.1:${FAKE_PORT}/testpage.html` }] });
    }
    if (url.startsWith('/testpage.html')) return send(200, TEST_PAGE, 'text/html; charset=utf-8');
    if (url.startsWith('/api/foo.do')) return send(200, { ok: true, token: 'server-tok-xyz', name: '张三' });
    if (url.startsWith('/api/bar.do')) return send(500, { error: 'boom', password: 'topsecret', detail: '保存失败：金额不能为空' });
    return send(404, { error: 'not found' });
});

// Node 14 没有全局 fetch，直接用 http.request
function ccweb(method, apiPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body == null ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port: CCWEB_PORT, path: apiPath, method,
            headers: Object.assign({ 'Content-Type': 'application/json' }, payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}, headers),
            timeout: 10000,
        }, res => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { buf += chunk; });
            res.on('end', () => {
                let parsed = {};
                try { parsed = JSON.parse(buf); } catch { /* ignore */ }
                resolve({ status: res.statusCode, payload: parsed });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

(async () => {
    if (!fs.existsSync(EXE)) { console.error('缺少 ' + EXE + '，先 cargo build --release --features novice'); process.exit(1); }
    let configBackup = null;
    let ccwebProc = null;
    try {
        // 1. 假补丁中心
        await new Promise(resolve => fake.listen(FAKE_PORT, '127.0.0.1', resolve));
        console.log('[fake] patch_search on', FAKE_PORT);

        // 2. 临时配置（指向假服务器）
        if (fs.existsSync(CONFIG_FILE)) configBackup = fs.readFileSync(CONFIG_FILE);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ patch_search_servers: [`http://127.0.0.1:${FAKE_PORT}`], code_search_url: '' }));

        // 3. 启动 cc-web（小白版）
        ccwebProc = spawn(EXE, [], { cwd: path.join(ROOT, 'target', 'release'), stdio: 'ignore' });
        let up = false;
        for (let i = 0; i < 40 && !up; i += 1) {
            await sleep(500);
            try { up = (await ccweb('GET', '/api/version')).status === 200; } catch { /* not yet */ }
        }
        check('cc-web 启动', up);
        if (!up) throw new Error('cc-web 没有起来');

        // 4. 没有凭据 → 400
        const noAuth = await ccweb('POST', '/api/recorder/open', { env_id: 1 });
        check('无凭据被拒', noAuth.status === 400 && String(noAuth.payload.error || '').includes('凭据'), JSON.stringify(noAuth));

        // 5. 打开录制浏览器（页面脚本会自己点"开始"→发请求→点"停止"）
        const opened = await ccweb('POST', '/api/recorder/open', { env_id: 1 }, { Authorization: 'Bearer fake-token-ok' });
        check('录制浏览器已打开', opened.status === 200 && opened.payload.success === true, JSON.stringify(opened.payload));

        // 6. 轮询到 finished（页面里的自动时序约 7s，留足余量）
        let status = null;
        let sawRecording = false;
        for (let i = 0; i < 90; i += 1) {
            await sleep(500);
            const res = await ccweb('GET', '/api/recorder/status');
            status = res.payload;
            if (status.state === 'recording') sawRecording = true;
            if (status.state === 'finished') break;
        }
        check('录制过程中检测到 recording 状态', sawRecording, '（页面脚本可能被 CSP 挡住，但导出仍可能成功）');
        check('状态变为 finished', status && status.state === 'finished', JSON.stringify(status));
        const file = status && status.file;
        check('导出文件路径回传', Boolean(file && fs.existsSync(file)), String(file));

        if (file && fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf8');
            let data = {};
            try { data = JSON.parse(raw); } catch { /* ignore */ }
            const list = Array.isArray(data.interfaces) ? data.interfaces : [];
            const foo = list.find(item => String(item.url || '').includes('/api/foo.do'));
            const bar = list.find(item => String(item.url || '').includes('/api/bar.do'));
            check('录到 foo.do（200）', Boolean(foo) && Number(foo.status) === 200, JSON.stringify(list.map(i => i.url)));
            check('录到 bar.do（500，报错接口）', Boolean(bar) && Number(bar.status) === 500);
            check('报错接口带截断响应体', Boolean(bar && String(bar.responseBody || '').includes('金额不能为空')), bar && String(bar.responseBody || '').slice(0, 120));
            check('请求头 Authorization 已移除', Boolean(foo && foo.requestHeaders && foo.requestHeaders.Authorization === '[已移除]'),
                foo && JSON.stringify(foo.requestHeaders).slice(0, 200));
            check('请求体 password 已掩码', Boolean(foo && String(foo.requestBody || '').includes('{**}') === false && !String(foo.requestBody || '').includes('p@ssw0rd'))
                || Boolean(foo && String(foo.requestBody || '') === ''), foo && String(foo.requestBody || '').slice(0, 200));
            check('请求体 token 已掩码', !String(foo && foo.requestBody || '').includes('tok-abc'));
            check('响应体 password 已掩码', !raw.includes('topsecret'));
            check('响应体 token 已掩码', !raw.includes('server-tok-xyz'));
            check('非敏感中文内容保留', raw.includes('金额不能为空') && raw.includes('张三'));
            check('文件整体不含明文凭据', !raw.includes('secret-token-123'));
            console.log('[file] ' + file);
        }

        // 7. 完成后浏览器应已关闭：再开一次并直接 close（close 不带录制 → 直接关）
        const reopened = await ccweb('POST', '/api/recorder/open', { env_id: 1 }, { Authorization: 'Bearer fake-token-ok' });
        check('重新打开（重录）', reopened.status === 200);
        await sleep(1500);
        const closed = await ccweb('POST', '/api/recorder/close');
        check('close 接口可用', closed.status === 200);
    } catch (error) {
        console.error('测试异常：', error.message);
        fails.push('exception: ' + error.message);
    } finally {
        // 清理：关录制浏览器 → 杀 cc-web → 还原配置 → 关假服务器
        try { await ccweb('POST', '/api/recorder/close'); } catch { /* ignore */ }
        try { if (ccwebProc) ccwebProc.kill(); } catch { /* ignore */ }
        try { execSync('taskkill /IM cc-web.exe /F', { stdio: 'ignore' }); } catch { /* ignore */ }
        try {
            if (configBackup != null) fs.writeFileSync(CONFIG_FILE, configBackup);
            else if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
        } catch { /* ignore */ }
        fake.close();
        await sleep(500);
        console.log(fails.length ? ('共 ' + fails.length + ' 项 FAIL：' + fails.join('；')) : '全部 PASS');
        process.exit(fails.length ? 1 : 0);
    }
})();
