// ============================================================
//  node_core.js - 开发版与小白版共用的智能开发核心逻辑
//  包含：cc-web 同源接口、run 本地读写、SSE（先 connected 再 start）、
//        事件处理、收尾判定、上报、会话存档、提示词模板解析
//
//  依赖（先于本文件加载）：
//    common.js  —— patchRequest / patchToken / patchEscape / patchShowError
//
//  页面须在加载本文件后提供：
//    1. 全局 patchState，含 node 子对象：
//       { host, runs: [], current: null, es: null, streaming: false,
//         pendingPrompt: null, timing: null }
//       以及 patchState.user（登录用户，取 patch_user 用）
//    2. 全局 NODE_UI 钩子对象（页面相关行为，全部可选，未提供用默认空实现）：
//       - appendText(text)            流式输出文本（开发版流式输出已停用 → 空实现）
//       - renderRunPanel(run)         重画当前 run 面板
//       - renderRuns()                重画 run 列表
//       - reloadRuns(): Promise       重新拉取列表（开发版 = loadProblemRuns）
//       - report(run)                 一轮结束后的结论展示（fire-and-forget 上报）
//
//  edition 约定：run.edition === 'novice' 时——
//    - /resolve 请求带 edition=novice（只在小白版模板内降级）
//    - 上报 problem-runs 时带 client_edition='novice'
// ============================================================

// 日志超过这个长度就不进 node_runs.json（清单每次状态变化都整体落盘，塞不下长文本）。
// 提示词里始终带全文——日志是给 claude 定位问题用的输入，不要求它再抄一份落盘。
const PATCH_NODE_LOG_INLINE_LIMIT = 8192;
// claude 引擎/API 报错特征：这类报错 claude 常以**不带 is_error 的普通 result** 发出（如
// "API Error: 500 No available channel for the requested model"），不识别就会被当成正常结论，
// 落成「待判定 + 已解决/未解决」。命中就当「执行出错」处理（后端同步记为 error 状态）。
const PATCH_NODE_ERROR_RE = /API Error:|No available channel|^\s*Error:|^\s*error:|ClaudeCode .*(fail|error)/i;
// 合并说明.md 的判定：claude 按提示词在第一行写「结果：成功 / 结果：冲突」。
// 没读到文件或读不懂时一律按"未成功"处理——宁可让用户去核对 git，也不要谎报已解决。
const PATCH_NODE_MERGE_RE = /结果\s*[:：]\s*(成功|冲突)/;

// ── NODE_UI 默认空实现（页面可在加载本文件后整体覆盖 window.NODE_UI）──
window.NODE_UI = Object.assign({
    appendText() {},
    renderRunPanel() {},
    renderRuns() {},
    reloadRuns() { return Promise.resolve(); },
    report() {},
}, window.NODE_UI || {});

/* ── 状态与文案 ── */

// 本地 phase(+verdict/failure) → 服务器 status（取值见 schema/migration_problem_run.sql）
function patchNodeServerStatus(run) {
    if (run.phase === 'done') return run.verdict === 'solved' ? 'solved' : 'unsolved';
    // 执行出错 / 合并中断（failed）一律按「待判定」上报：非终态只有待判定一种，
    // 区分动作交给界面按钮（已解决/未解决/继续），不再细分 error/merge_failed/aborted
    if (run.phase === 'awaiting_decision' || run.phase === 'failed') return 'awaiting_decision';
    return 'running'; // analyzing / merging
}

function patchNodeStatusLabel(run) {
    if (run.phase === 'analyzing') return '执行中';
    if (run.phase === 'merging') return '合并中';
    // 执行出错 / 合并中断一律显示「待判定」（含 run.error / failed 等一切非终态停顿），
    // 待判定统一提供 已解决/未解决/继续 三个动作
    if (run.phase === 'awaiting_decision' || run.phase === 'failed') return '待判定';
    if (run.phase === 'done') return run.verdict === 'solved' ? '已解决' : '未解决';
    return '未知';
}

// 服务器 status → 中文（换机后本机没有这条 run，只能按服务器账本展示）
const PATCH_NODE_SERVER_STATUS_LABEL = {
    running: '执行中', awaiting_decision: '待判定', solved: '已解决',
    unsolved: '未解决', merge_failed: '合并失败', aborted: '已中断', error: '执行出错',
};

// MCP 检索 root：产品小写 + 版本去点（如 fbip-82）
function patchNodeMcpRoot(env) {
    return `${String(env.product_name || '').toLowerCase()}-${String(env.product_version || '').replace(/\./g, '')}`;
}

/* ── 路径工具 ── */

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

function patchNodeToolArgs(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try { return JSON.stringify(input); } catch { return String(input); }
}

/* ── cc-web 同源接口（/api/agent/*、/api/node/*、/api/files/* 都是本进程端口，无 CORS）── */

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

/* ── 提示词模板解析（/api/node-prompts/resolve + {{var}} 渲染）── */

// 渲染：把模板里的 {{key}} 替换成 values[key]（缺失的 key 替换为空串，避免遗留花括号）
function renderNodeTemplate(tpl, values) {
    const v = values || {};
    return String(tpl || '').replace(/\{\{([^}]+)\}\}/g, (_m, key) => {
        const val = v[key];
        return val == null ? '' : String(val);
    });
}

// 统一变量字典（任一 stage 可用子集）：来自 env_snapshot 的产品环境 + 运行期 run 字段。
function buildNodePromptValues(run, extra) {
    const env = (run && run.env_snapshot) || {};
    const turnDir = patchNodeTurnDir(run || {});
    const values = {
        // 环境（env_snapshot）
        product_name: env.product_name || '',
        product_version: env.product_version || '',
        mcp_root: patchNodeMcpRoot(env),
        code_directory: env.code_directory || '',
        package_path: env.package_path || '',
        local_jdk_path: env.local_jdk_path || '',
        local_skill_path: String(env.local_skill_path || '').trim().replace(/[\\/]+$/, ''),
        db_connection: env.db_connection || '',
        debug_address: env.debug_address || '',
        record_url: env.record_url || '',
        // 运行期
        problem_desc: run && run.problem_desc != null ? run.problem_desc : '',
        trigger_url: run && run.trigger_url != null ? run.trigger_url : '',
        log_info: run && run.log_info != null ? run.log_info : '',
        log_file_name: (run && run.log_file_name) || 'ailog',
        step_dir: (run && run.step_dir) || '',
        turn_dir: turnDir,
        stage_dir: (run && run.stage_dir) || '',
        clean_dir: patchNodeJoin(turnDir, 'clean'),
        retry_n: '',
        note: '',
        // 派生路径
        stage_dir_src: patchNodeJoin((run && run.stage_dir) || '', 'src'),
        turn_dir_aisql: patchNodeJoin(turnDir, 'aisql.sql'),
        turn_dir_plan: patchNodeJoin(turnDir, '方案.txt'),
        turn_dir_changes: patchNodeJoin(turnDir, 'changes.txt'),
        turn_dir_conclusion: patchNodeJoin(turnDir, '结论.md'),
        turn_dir_baseline: patchNodeJoin(turnDir, 'baseline'),
        turn_dir_report_index: patchNodeJoin(turnDir, '0_对比报告_首页.html'),
        turn_dir_report_diff: patchNodeJoin(patchNodeJoin(turnDir, 'report'), 'diff.html'),
        turn_dir_merge: patchNodeJoin(turnDir, '合并说明.md'),
        turn_dir_summary: patchNodeJoin(turnDir, '总结.md'),
        patch_prefix: patchNodePatchPrefix(run || {}),
        patch_user: String((patchState.user && patchState.user.username) || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_') || 'user',
    };
    if (extra) Object.assign(values, extra);
    return values;
}

// 取一次运行各阶段的已解析模板（服务器降级解析 + 本机缓存），失败置空走内置默认。
// 小白版 run（run.edition==='novice'）带 edition=novice，只在小白版模板内降级，不回落开发版。
async function nodeFetchResolvedPrompts(run) {
    if (run && run.nodePrompts) return run.nodePrompts;
    if (run && run.nodePrompts === null) return null;
    let resolved = null;
    try {
        const env = (run && run.env_snapshot) || {};
        const q = new URLSearchParams({ product_name: env.product_name || '', product_version: env.product_version || '' });
        if (run && run.edition === 'novice') q.set('edition', 'novice');
        resolved = await patchRequest(`/api/node-prompts/resolve?${q.toString()}`);
    } catch (error) {
        resolved = null;
    }
    if (run) run.nodePrompts = resolved;
    return resolved;
}

// 已配置(stage 有非空模板)→ 渲染占位符返回；否则走 builtinFn()（内置默认，现版行为）
async function nodeResolveStagePrompt(run, stage, builtinFn) {
    const resolved = await nodeFetchResolvedPrompts(run);
    if (resolved) {
        const tpl = resolved[stage];
        if (tpl && String(tpl).trim()) {
            return renderNodeTemplate(tpl, buildNodePromptValues(run));
        }
    }
    return typeof builtinFn === 'function' ? builtinFn() : '';
}

/* ── SSE 流（先 connected 再 start）── */

// 流式输出：由页面的 NODE_UI.appendText 接管（开发版流式输出已停用 → 默认静默）
function patchNodeAppendText(text) { NODE_UI.appendText(text); }
function patchNodeScheduleFlush() {}
function patchNodeFlushOutput() {}

function patchNodeCloseStream() {
    const state = patchState.node;
    if (state.es) { state.es.close(); state.es = null; }
    state.streaming = false;
    state.pendingPrompt = null;
}

async function patchNodeSendPrompt(run, prompt) {
    try {
        await patchNodeCcWeb(`/api/agent/${encodeURIComponent(run.session_id)}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: prompt }),
        });
    } catch (error) {
        run.error = true;
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
            NODE_UI.renderRunPanel(run);
            NODE_UI.renderRuns();
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
            // claude 的 API/CLI 报错常以**不带 is_error 的普通 result** 发出（如
            // "API Error: 500 No available channel..."），不识别就会被当成正常结论进「待判定」。
            // 命中引擎报错特征就按报错收尾（结论带上报错文本），状态仍是「待判定」，
            // 用户可用「继续」按钮在原会话里发「继续」重试。
            if (PATCH_NODE_ERROR_RE.test(event.content || '')) {
                run.error = true;
                patchNodeAfterTurn(run, `执行出错：${event.content || '未知错误'}`);
                break;
            }
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

/* ── 收尾与对账 ── */

// 收尾：定 phase（阶段一 → 待判定；阶段二 → 按「合并说明.md」第一行定成败）+ 读产物清单。
// 两条路共用：实时收到 result 事件、以及事后对账（见页面各自的 reconcile 实现）。
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
        // 结论文件也没有（claude 没跑完就死了）：查本 run 的 claude 会话，最后一条
        // assistant 文本命中引擎报错特征（如"API Error: 503 未配置供应商"）就按「执行出错」收尾。
        // Why：claude 重试期间不产生输出事件，SSE 静默几分钟后半死，终态 error 事件经常
        // 送到不了浏览器；对账（reconcile）这条路一定会走，把兜底放这里才可靠。
        if (!run.report && !run.error) {
            const errText = await patchNodeDetectSessionError(run);
            if (errText) {
                run.error = true;
                run.report = `执行出错：${errText}`;
            }
        }
    }
}

// 取本 run 的 claude 会话（--resume 同一条），看最后一条 assistant 文本是否为引擎报错。
// 只看最后一条：正常收尾的最后一条是结论性文本，不会以 API Error 开头；报错场景 claude
// 死前的最后一句正是错误信息本身。拉不到会话（接口挂了/会话不存在）返回 null，不影响收尾。
async function patchNodeDetectSessionError(run) {
    const sid = run.agent_session_id;
    if (!sid) return null;
    const payload = await patchNodeCcWeb(`/api/claude-sessions/${encodeURIComponent(sid)}?full=1`).catch(() => null);
    if (!payload || !Array.isArray(payload.messages)) return null;
    for (let i = payload.messages.length - 1; i >= 0; i -= 1) {
        const message = payload.messages[i];
        if (!message || message.role !== 'assistant') continue;
        const content = message.content;
        const text = typeof content === 'string' ? content
            : (Array.isArray(content) ? content.filter(block => block && block.type === 'text').map(block => block.text || '').join('\n') : '');
        if (text && PATCH_NODE_ERROR_RE.test(text)) return text;
        return null;   // 最后一条 assistant 不是报错文案 → 这轮不是引擎报错收尾
    }
    return null;
}

// 一轮执行结束（阶段一或阶段二都会走到这里）：把该步骤边界的完整会话内容存档到服务器（管理员可查）。
// 不再只在「已解决」时存——每个回合结束都打一个快照（s1/s2/…=阶段一第N次，m=阶段二合并），
// 进行中 / 未解决 / 中途放弃的 run 也能看每步会话。fire-and-forget，失败静默，按 step 去重。
// 内容源 = 本机 claude 会话 jsonl（经 /api/claude-sessions 解析出的完整会话，user/assistant/tool_use/tool_result）。
async function patchNodeArchiveSession(run) {
    // 老 run 已经按「已解决」整体存过（session_archived=true）：保持原样，不重复补造 per-step 行
    if (run.session_archived === true) return;
    const step = run.stage === 2 ? 'm' : `s${run.phase1_step || 1}`;
    const archivedSteps = Array.isArray(run.session_archived_steps) ? run.session_archived_steps : [];
    if (archivedSteps.includes(step)) return;            // 该步骤已存过不重复
    const sid = run.agent_session_id;
    if (!sid) return;                                   // 拿不到 claude 会话 id 就跳过
    const payload = await patchNodeCcWeb(`/api/claude-sessions/${encodeURIComponent(sid)}?full=1`).catch(() => null);
    if (!payload || !Array.isArray(payload.messages)) return;
    const env = run.env_snapshot || {};
    // 该快照所在步骤的状态：阶段二按终态（solved / merge_failed），阶段一统一记 pending（待判定）
    const isPhase2 = run.stage === 2;
    const verdict = isPhase2 ? (run.verdict === 'solved' ? 'solved' : 'merge_failed') : 'pending';
    const body = {
        local_run_id: run.id,
        step,
        product_name: env.product_name || null,
        product_version: env.product_version || null,
        module_name: null,
        problem_desc: run.problem_desc || null,
        session_id: run.session_id || null,
        agent_session_id: sid,
        message_count: payload.messages.length,
        conversation_json: JSON.stringify(payload.messages),
        verdict,
        solved_at: run.verdict === 'solved' ? new Date().toISOString() : null,
    };
    await patchRequest('/api/problem-run-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    run.session_archived_steps = archivedSteps.concat(step);
    patchNodeSaveRun(run).catch(() => {});
}

async function patchNodeAfterTurn(run, report) {
    patchNodeCloseStream();
    if (report) run.report = report;
    run.finished_at = new Date().toISOString();
    await patchNodeSettleRun(run);
    await patchNodeSaveRun(run).catch(() => {});
    NODE_UI.report(run);
    // 每个回合结束（阶段一某次 / 阶段二合并）都把该步骤会话存档到服务器（管理员可查），
    // 不再等「已解决」——进行中/未解决/放弃的 run 也能看每步会话（内部按 step 去重）
    patchNodeArchiveSession(run).catch(() => {});
    NODE_UI.renderRunPanel(run);
    await NODE_UI.reloadRuns();
}

/* ── 上报（只写账本，失败静默）── */

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
            client_edition: run.edition === 'novice' ? 'novice' : 'dev',
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
