// ============================================================
//  novice_chat.js - 小白版聊天页增强（把「智能开发」合并进聊天页）
//  依赖（先加载）：folderpick.js、common.js、node_core.js、prompts_novice.js、app.js
//
//  开发版加载本文件时直接 no-op（edition !== 'novice'），页面行为完全不变。
//
//  小白版行为：
//   - 左侧「会话」标题改为「智能开发」；标题栏加「🔍 新建排查」按钮（原来的 + 仍是普通新建会话）
//   - 新建排查 = 填表单（产品环境 / 问题描述 / 触发项+录制 / 日志文件）→ 建运行目录 →
//     建 claude 会话（cwd=运行目录）→ 直接选中该会话 → **只发一次阶段一提示词**；
//     之后完全由用户和 Claude Code 自由对话（不做状态跟踪、不做判定/打包、不写 run 记录）
//   - 侧边栏底部加「产品环境变量 / 环境检查」入口（/novice.html）
//   - 顶部「聊天/智能开发」切换按钮隐藏（合并成一个菜单）
// ============================================================
(function () {
    'use strict';

    // common.js / node_core.js 需要全局 patchState（本页没有 patches.js，自带一个最小版）
    if (typeof window.patchState === 'undefined') {
        window.patchState = {
            theme: 'light',
            patchSearchServers: [],
            patchServerCursor: 0,
            authInvalidated: false,
            user: null,
        };
    }

    const S = {
        envs: [],
        envId: '',
        recorderTimer: 0,
        recorderReady: false,
        images: [],       // 新建排查的问题附件：{ file, url }
        recordPath: '',   // 录制导出的 JSON 绝对路径（不回显，提交时带给提示词）
        busy: false,
    };

    let initialized = false;

    function el(id) { return document.getElementById(id); }

    function escape(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    // ── 登录态：新建排查需要 patch_search 的 token；未登录就弹统一外壳的登录层 ──
    function ensureLogin() {
        if (typeof noviceRequireLogin === 'function') return noviceRequireLogin();
        if (typeof patchToken === 'function' && patchToken()) return true;
        showNotice('请先登录（点左下角 ⏻）');
        return false;
    }

    function showNotice(text) {
        if (typeof showAppNotice === 'function') { try { showAppNotice(text); return; } catch (e) { /* fall through */ } }
        // 简易提示条（app.js 没有 toast 时兜底）
        let bar = el('noviceChatNotice');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'noviceChatNotice';
            bar.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;' +
                'background:#1f2430;color:#fff;padding:9px 18px;border-radius:8px;font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
                'box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:80vw;white-space:pre-wrap;';
            document.body.appendChild(bar);
        }
        bar.textContent = text;
        bar.style.display = 'block';
        clearTimeout(bar._timer);
        bar._timer = setTimeout(() => { bar.style.display = 'none'; }, 4000);
    }

    async function initPatchConfig() {
        try {
            const response = await fetch('/api/patch-config');
            if (!response.ok) return;
            const config = await response.json().catch(() => ({}));
            const servers = Array.isArray(config.patch_search_servers)
                ? config.patch_search_servers
                : (config.patch_search_api ? [config.patch_search_api] : []);
            window.patchState.patchSearchServers = servers.map(v => String(v).trim()).filter(Boolean);
            window.patchState.patchServerCursor = 0;
        } catch (e) { /* 拿不到就等具体请求时报错 */ }
    }

    // ══════════════════════════════════════════════════════════
    //  UI 挂接：新建排查按钮（统一外壳的右侧顶部）+ 排查表单弹窗
    //  菜单/会话列表都在 novice.html 外壳里，app.js 直接填充会话列表，本文件不再注入布局
    // ══════════════════════════════════════════════════════════

    function setupUI() {
        const btn = el('noviceNewRunBtn');
        if (btn) btn.onclick = () => openRunForm();
        buildRunForm();
    }

    function buildRunForm() {
        if (el('noviceRunModal')) return;
        const style = `
        #noviceRunModal{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9000;display:none;align-items:center;justify-content:center;padding:20px}
        #noviceRunModal .nrm-box{background:var(--card,#fff);color:var(--text,#1f2329);border-radius:14px;width:560px;max-width:96vw;max-height:92vh;overflow:auto;padding:24px 26px;position:relative;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
        #noviceRunModal h3{margin:0 0 14px;font-size:17px}
        #noviceRunModal label{display:block;margin-bottom:12px;font-size:13.5px}
        #noviceRunModal label>span{display:block;margin-bottom:5px;color:#8a9099}
        #noviceRunModal input[type=text],#noviceRunModal textarea,#noviceRunModal select{width:100%;padding:8px 11px;border:1px solid var(--border,#e0e4e9);border-radius:8px;font-size:14px;background:var(--card,#fff);color:inherit;box-sizing:border-box}
        #noviceRunModal textarea{resize:vertical}
        #noviceRunModal .nrm-req{color:#d84a3f}
        #noviceRunModal .nrm-row{display:flex;gap:6px}
        #noviceRunModal .nrm-row input{flex:1}
        #noviceRunModal .nrm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
        #noviceRunModal button{border-radius:8px;cursor:pointer;font-size:14px;padding:8px 16px;border:1px solid var(--border,#e0e4e9);background:var(--card,#fff);color:inherit}
        #noviceRunModal button.primary{background:#2b6cf6;border-color:#2b6cf6;color:#fff}
        #noviceRunModal button:disabled{opacity:.5;cursor:not-allowed}
        #noviceRunModal .nrm-close{position:absolute;top:12px;right:14px;border:none;background:none;font-size:20px;padding:2px 8px}
        #noviceRunModal .nrm-hint{font-size:12.5px;color:#8a9099;margin:-6px 0 10px}
        #noviceRecList{max-height:180px;overflow:auto;background:var(--code-bg,#f4f6f8);border-radius:8px;padding:8px 10px;font:12px/1.7 Consolas,monospace;white-space:pre-wrap;margin-top:8px;display:none}
        #noviceRunModal .nrm-attach{display:flex;align-items:center;gap:10px;margin:-6px 0 12px}
        #noviceRunModal .nrm-attach .nrm-hint{margin:0}
        #noviceRunModal .nrm-error{display:none;color:#d84a3f;font-size:13px;margin:0 0 10px}
        #noviceRunModal .nrm-file{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:4px 8px;border:1px solid var(--border,#e0e4e9);border-radius:8px;font-size:12px;background:rgba(0,0,0,.03)}
        #noviceRunModal .nrm-file button{border:none;background:none;color:inherit;padding:0 2px;font-size:14px;cursor:pointer}
        #noviceRunModal .nrm-images{display:flex;flex-wrap:wrap;gap:8px;margin:-4px 0 12px}
        #noviceRunModal .nrm-thumb{position:relative;width:72px;height:72px;border:1px solid var(--border,#e0e4e9);border-radius:8px;overflow:hidden;background:rgba(0,0,0,.04)}
        #noviceRunModal .nrm-thumb img{width:100%;height:100%;object-fit:cover;display:block}
        #noviceRunModal .nrm-thumb button{position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;border:none;background:rgba(0,0,0,.55);color:#fff;font-size:12px;line-height:1;cursor:pointer;padding:0}
        `;
        const wrap = document.createElement('div');
        wrap.innerHTML = `
        <style>${style}</style>
        <div id="noviceRunModal">
            <div class="nrm-box">
                <button class="nrm-close" id="noviceRunClose" type="button">×</button>
                <h3>新建排查</h3>
                <label><span>产品环境 <b class="nrm-req">*</b></span><select id="noviceRunEnv"></select></label>
                <label><span>问题描述 <b class="nrm-req">*</b></span>
                    <textarea id="noviceRunDesc" rows="4"></textarea></label>
                <div class="nrm-attach">
                    <button type="button" id="noviceRunImageBtn">📎 添加图片 / 文件</button>
                    <input type="file" id="noviceRunImages" multiple style="display:none">
                </div>
                <div id="noviceImageList" class="nrm-images"></div>
                <label><span>录制页面地址 <b class="nrm-req">*</b></span>
                    <div class="nrm-row">
                        <input type="text" id="noviceRunUrl">
                        <button type="button" id="noviceRunRecord">● 录制</button>
                    </div></label>
                <div class="nrm-hint" id="noviceRecStatus" style="display:none"></div>
                <div id="noviceRecList"></div>
                <div class="nrm-error" id="noviceRunError" style="display:none"></div>
                <div class="nrm-actions">
                    <button type="button" id="noviceRunCancel">取消</button>
                    <button type="button" class="primary" id="noviceRunSubmit">开始排查</button>
                </div>
            </div>
        </div>`;
        document.body.appendChild(wrap);
        el('noviceRunClose').onclick = closeRunForm;
        el('noviceRunCancel').onclick = closeRunForm;
        el('noviceRunSubmit').onclick = () => submitRun().catch(error => showRunError('创建失败：' + error.message));
        el('noviceRunEnv').onchange = syncRecordButton;
        el('noviceRunUrl').addEventListener('input', syncRecordButton);
        el('noviceRunImageBtn').onclick = () => el('noviceRunImages').click();
        el('noviceRunImages').onchange = event => { addImages(event.target.files); event.target.value = ''; };
        el('noviceRunDesc').addEventListener('paste', handlePaste);
        el('noviceRunRecord').onclick = () => openRecorder();
        ['noviceRunEnv', 'noviceRunUrl', 'noviceRunDesc'].forEach(id => {
            const node = el(id);
            node.addEventListener('input', hideRunError);
            node.addEventListener('change', hideRunError);
        });
    }

    async function openRunForm() {
        if (!ensureLogin()) return;
        el('noviceRunDesc').value = '';
        el('noviceRunUrl').value = '';
        S.recordPath = '';
        hideRunError();
        clearImages();
        el('noviceRecStatus').style.display = 'none';
        el('noviceRecList').style.display = 'none';
        el('noviceRecList').textContent = '';
        const select = el('noviceRunEnv');
        select.innerHTML = '<option value="">加载产品环境…</option>';
        el('noviceRunModal').style.display = 'flex';
        try {
            S.envs = (await patchRequest('/api/project-envs')) || [];
        } catch (error) {
            S.envs = [];
            showNotice('产品环境加载失败：' + error.message);
        }
        if (!S.envs.length) {
            select.innerHTML = '<option value="">（请先到「产品环境变量」新增一个环境）</option>';
            return;
        }
        select.innerHTML = ['<option value="">请选择产品环境</option>'].concat(
            S.envs.map(item => `<option value="${escape(item.id)}">${escape(`${item.project_name || ''}（${item.product_name || ''} ${item.product_version || ''}）`)}</option>`)
        ).join('');
        syncRecordButton();
    }

    function closeRunForm() {
        el('noviceRunModal').style.display = 'none';
        stopRecorderPolling();
        clearImages();
    }

    // ── 问题附件：图片显示缩略图，其他文件显示文件名；图片可直接 Ctrl+V 粘贴 ──
    function addImages(files) {
        Array.from(files || []).forEach(file => {
            if (!file) return;
            if (file.size > 20 * 1024 * 1024) { showNotice(`「${file.name || '附件'}」超过 20MB，已跳过`); return; }
            const isImage = /^image\//i.test(file.type || '');
            S.images.push({ file, url: isImage ? URL.createObjectURL(file) : '' });
        });
        renderImages();
        hideRunError();
    }

    // 通用附件列表（问题描述 / 相关日志共用）：图片缩略图，其他文件显示文件名
    function renderAttachmentList(listId, items, rerender) {
        const box = el(listId);
        if (!box) return;
        box.innerHTML = '';
        items.forEach((item, index) => {
            const name = item.file.name || (item.url ? '粘贴的图片' : '附件');
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = '移除';
            remove.onclick = () => {
                if (item.url) { try { URL.revokeObjectURL(item.url); } catch (e) {} }
                items.splice(index, 1);
                rerender();
            };
            if (item.url) {
                const thumb = document.createElement('div');
                thumb.className = 'nrm-thumb';
                thumb.title = name;
                const img = document.createElement('img');
                img.src = item.url;
                img.alt = name;
                thumb.appendChild(img);
                thumb.appendChild(remove);
                box.appendChild(thumb);
            } else {
                const chip = document.createElement('div');
                chip.className = 'nrm-file';
                const label = document.createElement('span');
                label.textContent = `📄 ${name}`;
                label.title = name;
                chip.appendChild(label);
                chip.appendChild(remove);
                box.appendChild(chip);
            }
        });
    }

    function renderImages() {
        renderAttachmentList('noviceImageList', S.images, renderImages);
    }

    function clearImages() {
        S.images.forEach(item => {
            if (item.url) { try { URL.revokeObjectURL(item.url); } catch (e) {} }
        });
        S.images = [];
        renderImages();
    }

    function handlePaste(event) {
        const items = event.clipboardData && event.clipboardData.items;
        if (!items) return;
        const files = [];
        for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            if (item.kind === 'file' && /^image\//i.test(item.type || '')) {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (!files.length) return;
        event.preventDefault();   // 有图片时不把图片的“文件名”文本粘进输入框
        addImages(files);
    }

    function currentEnv() {
        return S.envs.find(item => String(item.id) === String(el('noviceRunEnv').value)) || null;
    }

    function syncRecordButton() {
        const btn = el('noviceRunRecord');
        if (!btn) return;
        // 不置灰：点的时候再校验并提示（提示显示在弹窗内，能看到）
        btn.disabled = false;
        btn.title = '打开浏览器录制问题现场';
    }

    // ── 表单校验提示（弹窗内展示，避免提示层被弹窗盖住）──
    function showRunError(text, fieldId) {
        const box = el('noviceRunError');
        if (box) { box.textContent = text; box.style.display = 'block'; }
        const field = fieldId && el(fieldId);
        if (field) {
            field.focus();
            if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'nearest' });
        }
    }

    function hideRunError() {
        const box = el('noviceRunError');
        if (box) { box.textContent = ''; box.style.display = 'none'; }
    }

    // ══════════════════════════════════════════════════════════
    //  接口录制（与 patches.js 的录制面板一致，行为契约见 src/recorder.rs）
    // ══════════════════════════════════════════════════════════

    async function recorderApi(path, options) {
        const headers = { 'Content-Type': 'application/json' };
        const token = typeof patchToken === 'function' ? patchToken() : '';
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(path, Object.assign({ headers }, options));
        const payload = await response.json().catch(() => ({}));
        if (response.status === 404) throw new Error('录制组件未就绪');
        if (!response.ok || payload.success === false) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
        return payload;
    }

    async function openRecorder() {
        const url = String(el('noviceRunUrl').value || '').trim();
        if (!/^https?:\/\//i.test(url)) {
            showRunError('请先填写「录制页面地址」（http/https 开头）再录制', 'noviceRunUrl');
            return;
        }
        const env = currentEnv();
        S.recordPath = '';   // 重新录制时先清掉上一次的结果
        const status = el('noviceRecStatus');
        status.style.display = 'block';
        status.textContent = '正在启动浏览器…';
        el('noviceRecList').style.display = 'none';
        el('noviceRecList').textContent = '';
        el('noviceRunRecord').disabled = true;
        try {
            await recorderApi('/api/recorder/open', {
                method: 'POST',
                body: JSON.stringify({ record_url: url, env_id: env ? Number(env.id) : undefined }),
            });
        } catch (error) {
            status.textContent = error.message;
            el('noviceRunRecord').disabled = false;
            return;
        }
        startRecorderPolling();
    }

    function stopRecorderPolling() {
        if (S.recorderTimer) { clearInterval(S.recorderTimer); S.recorderTimer = 0; }
    }

    function startRecorderPolling() {
        stopRecorderPolling();
        const tick = async () => {
            const status = el('noviceRecStatus');
            let payload;
            try { payload = await recorderApi('/api/recorder/status', {}); }
            catch (error) { stopRecorderPolling(); status.textContent = error.message; return; }
            const st = payload.state || 'idle';
            if (st === 'browser_open') status.textContent = '浏览器已打开——请到浏览器页面右下角点「开始录制」，然后复现问题。';
            else if (st === 'recording') status.textContent = '录制中——请复现问题，复现结束后点浏览器上的「停止录制」。';
            else if (st === 'finished') {
                stopRecorderPolling();
                const file = String(payload.file || '');
                status.textContent = '录制已结束。';
                // 录制结果只在后台记录（S.recordPath），前端不回显接口清单/路径
                const box = el('noviceRecList');
                if (box) { box.style.display = 'none'; box.textContent = ''; }
                if (file) S.recordPath = file;
                el('noviceRunRecord').disabled = false;
                return;
            } else if (st === 'idle') {
                stopRecorderPolling();
                status.textContent = '浏览器已关闭（没点停止就没有导出结果，可以重新录制）。';
                el('noviceRunRecord').disabled = false;
            }
        };
        tick();
        S.recorderTimer = setInterval(tick, 1500);
    }

    // ══════════════════════════════════════════════════════════
    //  新建排查：建目录 → 建会话 → 发一次阶段一提示词 → 定位到会话
    // ══════════════════════════════════════════════════════════

    // 默认会话名：问题描述前 15 个字；没写文字时用 产品名+版本号+月日时分
    function noviceSessionName(desc, env) {
        const text = String(desc || '').replace(/\s+/g, ' ').trim();
        if (text) return Array.from(text).slice(0, 15).join('');
        const now = new Date();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const hour = now.getHours();
        const minute = String(now.getMinutes()).padStart(2, '0');
        const product = `${env.product_name || ''}${env.product_version || ''}`.trim() || '未命名产品';
        return `${product} ${month}月${day}日${hour}时${minute}分`.slice(0, 100);
    }

    // 把附件逐个存到本次运行目录，返回绝对路径
    async function uploadAttachments(runId, items, label) {
        const paths = [];
        for (const item of items) {
            const form = new FormData();
            form.append('file', item.file, item.file.name || 'attachment');
            const query = `run_id=${encodeURIComponent(runId)}&name=${encodeURIComponent(item.file.name || '')}`;
            const response = await fetch(`/api/node/problem-image?${query}`, { method: 'POST', body: form });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.success === false) {
                throw new Error(payload.error || `${label}保存失败`);
            }
            if (payload.path) paths.push(payload.path);
        }
        return paths;
    }

    async function submitRun() {
        if (S.busy) return;
        hideRunError();
        const env = currentEnv();
        const desc = String(el('noviceRunDesc').value || '').trim();
        const recordUrl = String(el('noviceRunUrl').value || '').trim();
        if (!env) { showRunError('请选择产品环境', 'noviceRunEnv'); return; }
        if (!desc && !S.images.length) { showRunError('请填写问题描述，或添加图片/文件附件', 'noviceRunDesc'); return; }
        if (!recordUrl) { showRunError('请填写「录制页面地址」', 'noviceRunUrl'); return; }
        if (!/^https?:\/\//i.test(recordUrl)) { showRunError('「录制页面地址」必须是 http/https 地址', 'noviceRunUrl'); return; }
        S.busy = true;
        el('noviceRunSubmit').disabled = true;
        el('noviceRunSubmit').textContent = '正在创建…';
        try {
            // 1. 运行工作目录（cc-web temp 下，作为 claude 的 cwd）
            const runId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, '');
            const wsRes = await fetch('/api/node/workspace', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: runId }),
            }).then(r => r.json());
            if (!wsRes.success) throw new Error(wsRes.error || '创建运行目录失败');
            const workspace = wsRes.path;

            // 1.5 问题附件存到运行目录（AI 用 Read 工具查看图片/读取文件）
            const imagePaths = await uploadAttachments(runId, S.images, '问题附件');

            // 2. JDK 未登记 → 在 home 下自动找一次
            let jdkPath = String(env.local_jdk_path || '').trim();
            if (!jdkPath && String(env.package_path || '').trim()) {
                try {
                    const checked = await (await fetch(`/api/env-check?home=${encodeURIComponent(String(env.package_path).trim())}`)).json();
                    if (checked && checked.success && checked.home_jdk && checked.home_jdk.ok && checked.home_jdk.path) jdkPath = checked.home_jdk.path;
                } catch (e) { /* 找不到就交给提示词里的兜底指令 */ }
            }

            // 3. 组装提示词用的运行快照（不落 run 记录，仅本次提示词使用）
            const stepDir = patchNodeJoin(workspace, 'step01');
            const trigger = S.recordPath || '';
            const pseudoRun = {
                edition: 'novice',
                id: runId,
                problem_desc: desc,
                trigger_url: trigger,
                image_paths: imagePaths,
                phase1_step: 1,
                turn_dir: stepDir,
                stage_dir: patchNodeJoin(stepDir, 'work'),
                env_snapshot: {
                    project_name: env.project_name,
                    product_id: env.product_id,
                    version_id: env.version_id,
                    product_name: env.product_name,
                    product_version: env.product_version,
                    code_directory: env.code_directory || '',
                    package_path: env.package_path || '',
                    local_jdk_path: jdkPath,
                    local_skill_path: env.local_skill_path || '',
                    db_connection: env.db_connection || '',
                    debug_address: env.debug_address || '',
                    record_url: recordUrl,
                },
            };
            const prompt = await noviceBuildPrompt(pseudoRun, 'phase1');

            // 4. 建 claude 会话（cwd = 运行目录）
            const created = await fetch('/api/agent/new', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd: workspace, assistant: 'claude' }),
            }).then(r => r.json());
            if (!created.sessionId) throw new Error(created.error || '后端未返回 sessionId');

            // 4.5 默认会话名：问题描述前 15 个字；只传了附件没写文字 → 产品+版本+月日时分
            try {
                const name = noviceSessionName(desc, env);
                await fetch(`/api/sessions/${encodeURIComponent(created.sessionId)}/name`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                });
            } catch (e) { /* 命名失败不影响排查 */ }

            // 5. 关弹窗 → 切回智能开发视图 → 刷新会话列表 → 选中新会话 → 发阶段一提示词
            closeRunForm();
            if (typeof noviceSetView === 'function') noviceSetView('node');
            await loadSessions();
            renderSessionList();
            await selectSession(created.sessionId);
            // 把用户的输入显示在会话里，并立刻进入流式状态（停止按钮不用等后端第一个事件）
            const preview = desc || `（已附带 ${imagePaths.length} 个附件，问题现象见附件）`;
            if (typeof addMessage === 'function') addMessage('user', preview, null, created.sessionId);
            if (typeof welcomeScreen !== 'undefined' && welcomeScreen) welcomeScreen.style.display = 'none';
            if (typeof chatContainer !== 'undefined' && chatContainer) {
                chatContainer.style.display = 'flex';
                chatContainer.style.flexDirection = 'column';
            }
            if (typeof showSessionView === 'function') showSessionView(created.sessionId);
            if (typeof typingIndicator !== 'undefined' && typingIndicator) {
                typingIndicator.style.display = 'block';
                const nameEl = typingIndicator.querySelector('.assistant-name');
                if (nameEl) nameEl.textContent = (typeof currentAssistant !== 'undefined' ? currentAssistant : 'claude');
            }
            connectSSE(created.sessionId, prompt);
            if (typeof updateSendButtonState === 'function') updateSendButtonState();
            showNotice('排查已开始：AI 正在分析，之后可以直接在下方输入框继续追问。');
        } finally {
            S.busy = false;
            el('noviceRunSubmit').disabled = false;
            el('noviceRunSubmit').textContent = '开始排查';
        }
    }

    // ══════════════════════════════════════════════════════════
    //  初始化
    // ══════════════════════════════════════════════════════════

    async function detectEdition() {
        try {
            const payload = await (await fetch('/api/version')).json();
            return payload && payload.data && payload.data.edition === 'novice' ? 'novice' : 'dev';
        } catch (e) { return 'dev'; }
    }

    function waitForChatReady() {
        return new Promise(resolve => {
            let tries = 0;
            const timer = setInterval(() => {
                tries += 1;
                if ((document.getElementById('sessionList') && typeof window.loadSessions === 'function')
                    || tries > 100) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    }

    (async function init() {
        if (initialized) return;
        initialized = true;
        if (await detectEdition() !== 'novice') return;   // 开发版：什么都不做
        await waitForChatReady();
        await initPatchConfig();
        setupUI();
        ensureLogin();
    })();
})();
