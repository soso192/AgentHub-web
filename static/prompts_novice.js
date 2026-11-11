// ============================================================
//  prompts_novice.js - 小白版智能开发提示词
//  依赖：common.js、node_core.js（先加载）
//
//  流程（与待办清单「小白版提示词动态拼接」一致）：
//    1. nodeFetchResolvedPrompts(run)（run.edition='novice' → 自动带 edition=novice，
//       只在小白版模板内降级，不回落开发版模板）
//    2. 管理员配了模板 → renderNodeTemplate 渲染 {{var}}，再插 {{env_extra}}/{{constraints_extra}}
//       两个锚点（模板没写锚点就追加到末尾）
//    3. 没配模板 → 内置默认函数（同样拼好条件段）
//
//  条件段来源（管理页可配 seg_code_dir/seg_db/seg_debug，未配用内置文字）：
//    客开目录 / 数据库连接（口令掩码）/ 远程调试 / JDK / skill 库 / 录制接口摘要
// ============================================================

// 掩码连接串里的口令：拼进提示词的数据库连接一律过这一层，
// 避免真实口令随提示词进入 claude 会话、再随会话存档进服务器。
// 认识 jdbc:url 参数、key=value 对、url query 三种常见写法。
function noviceMaskDbPassword(text) {
    let out = String(text || '');
    // password=xxx / pwd=xxx / 口令=xxx（值止于分号、&、空白或串尾）
    out = out.replace(/((?:password|passwd|pwd)[=:])[^;&\s'"]+/gi, '$1******');
    // jdbc:...?user=x&password=y 由上一条覆盖；这里再兜一层 &password= 单独出现的场景
    out = out.replace(/([?&]password=)[^&\s]+/gi, '$1******');
    return out;
}

/* ── 条件段：信息段（{{env_extra}}）与约束段（{{constraints_extra}}）──
   每段独立：环境快照里有对应字段才拼。resolved 是 /resolve 的 seg_* 模板，
   模板内的 {{var}} 在这里先用变量字典渲染；db_connection 的值统一用**掩码后**的版本，
   防止管理员模板里的 {{db_connection}} 把明文口令带进会话存档。 */

async function noviceSegments(run, resolvedSegs) {
    const env = run.env_snapshot || {};
    const envLines = [];
    const constraintLines = [];
    // 片段模板渲染用变量字典（db_connection 用掩码版，防明文口令进会话存档）
    const segValues = buildNodePromptValues(run, {
        db_connection: noviceMaskDbPassword(env.db_connection || ''),
    });
    // 管理员配置的片段模板：先渲染 {{var}}；没配返回 null 由调用方用内置文字
    const segText = own => (own && String(own).trim())
        ? renderNodeTemplate(String(own), segValues)
        : null;

    // 客开代码目录：有才拼（小白多数没有；有就按「只读参考工程结构」处理）
    const codeDir = String(env.code_directory || '').trim();
    if (codeDir) {
        envLines.push(segText(resolvedSegs && resolvedSegs.seg_code_dir)
            || `客开工程路径：${codeDir}（**只读参考**：先用 Glob/Read 看工程结构、找同类既有文件的写法，不要改动工程里的任何文件；你的改动只写暂存目录。收尾时对它执行一次 git status 确认没有误改）`);
    }

    // 数据库连接：信息段给掩码连接串，约束段给「只读」
    const dbConn = String(env.db_connection || '').trim();
    if (dbConn) {
        envLines.push(`数据库连接：${noviceMaskDbPassword(dbConn)}`);
        constraintLines.push(segText(resolvedSegs && resolvedSegs.seg_db)
            || '数据库只允许查询（SELECT / SHOW / EXPLAIN），禁止 INSERT / UPDATE / DELETE / DROP / ALTER / TRUNCATE 等任何写操作和 DDL；查不到需要的数据就说明缺什么，不要尝试建表改表。');
    }

    // 远程调试地址：信息段给地址，约束段给「线程级调试」
    const debugAddr = String(env.debug_address || '').trim();
    if (debugAddr) {
        envLines.push(`远程调试地址：${debugAddr}`);
        constraintLines.push(segText(resolvedSegs && resolvedSegs.seg_debug)
            || '远程调试只做线程级观察（看线程栈、锁等待、运行状态），需要断点时用可恢复的临时断点，看完立即移除，不要长时间阻塞业务线程。');
    }

    // 本地 JDK：登记了就给路径；没登记给「home/war → cc-web 安装目录/jdk → 自动下载」的兜底链
    // FBIP 8.2 是 war 包形态，其他产品按工程 home 目录找
    const jdk = String(env.local_jdk_path || '').trim();
    const packagePath = String(env.package_path || '').trim();
    const isWarProduct = /^FBIP$/i.test(String(env.product_name || '').trim())
        && /^8\.2/i.test(String(env.product_version || '').trim());
    const jdkSearchDir = isWarProduct
        ? `war 包所在目录（本次为 ${packagePath || '未填'}）下目录名含 jdk 的文件夹`
        : `工程 home 目录（本次为 ${packagePath || '未填'}）下目录名含 jdk 的文件夹`;
    envLines.push(jdk
        ? `本地 JDK（java_home）：${jdk}`
        : `本地 JDK：未登记。编译前按顺序找 JDK：①${jdkSearchDir}；②cc-web 安装目录（本次运行目录往上找到包含 cc-web.exe 的目录）下的 jdk 目录；③都没有就先判断项目需要的 JDK 版本（参考工程 class 文件版本、编译目标或产品要求），下载对应版本的 JDK（Temurin/Adoptium 的 zip）解压到 cc-web 安装目录/jdk/ 并使用。下载失败就停下来，明确告诉用户需要登记 JDK 路径，不要用错版本硬编。`);

    // skill 库根目录
    const skillDir = String(env.local_skill_path || '').trim().replace(/[\\/]+$/, '');
    if (skillDir) envLines.push(`本机 skill 库（可按需只读）：${skillDir}`);

    // 触发项是录制 JSON 路径 → 读文件生成接口摘要，并要求先 find_action 定位处理类
    let triggerSummary = '';
    const trigger = String(run.trigger_url || '').trim();
    if (trigger && /\.json$/i.test(trigger)) {
        triggerSummary = await noviceRecordingSummary(trigger);
        if (triggerSummary) {
            envLines.push(`本次问题触发时录制的接口清单（文件：${trigger}）：\n${triggerSummary}`);
            constraintLines.push('对录制里每个 .do 接口，先调 patch_source MCP 的 find_action 定位入口处理类，再开始分析；完整录制数据在上述 JSON 文件里，需要细节就读它（只读）。');
        }
    }
    return { env: envLines, constraints: constraintLines };
}

// 读录制 JSON → 接口摘要：每个接口一行（方法、路径、状态码），报错接口附截断后的响应。
// 读不到文件（被删/路径不对）返回空串，提示词退回「只有问题描述」的写法。
async function noviceRecordingSummary(jsonPath) {
    let payload;
    try {
        const text = await patchNodeReadTextFile(jsonPath);
        payload = JSON.parse(text);
    } catch (error) {
        return '';
    }
    const list = Array.isArray(payload) ? payload
        : (Array.isArray(payload.requests) ? payload.requests
        : (Array.isArray(payload.interfaces) ? payload.interfaces : []));
    if (!list.length) return '';
    const lines = [];
    for (const item of list.slice(0, 50)) {   // 最多 50 条，防超长提示词
        const method = String(item.method || 'GET').toUpperCase();
        const path = String(item.url || item.path || '');
        const status = item.status == null ? '—' : String(item.status);
        const brief = `${method} ${path} → ${status}`;
        const bad = Number(item.status) >= 400 || item.error;
        if (bad) {
            const body = String((item.responseBody || item.response || item.error) || '').replace(/\s+/g, ' ').trim();
            lines.push(`  ✗ ${brief}${body ? `｜响应：${body.slice(0, 300)}${body.length > 300 ? '…' : ''}` : ''}`);
        } else {
            lines.push(`  · ${brief}`);
        }
    }
    if (list.length > 50) lines.push(`  …（共 ${list.length} 条，只列前 50 条，完整数据看文件）`);
    return lines.join('\n');
}

// 锚点插入：模板写了 {{env_extra}} / {{constraints_extra}} 就地替换；没写就追加到末尾
function noviceApplySegments(prompt, segments) {
    let out = prompt;
    const hasEnvAnchor = out.includes('{{env_extra}}');
    const hasConstraintAnchor = out.includes('{{constraints_extra}}');
    out = out.replace(/\{\{env_extra\}\}/g, segments.env.join('\n'));
    out = out.replace(/\{\{constraints_extra\}\}/g, segments.constraints.join('\n'));
    if (!hasEnvAnchor && segments.env.length) out += `\n\n【补充环境信息】\n${segments.env.join('\n')}`;
    if (!hasConstraintAnchor && segments.constraints.length) out += `\n\n【额外约束】\n${segments.constraints.join('\n')}`;
    return out;
}

/* ── 内置默认提示词（函数式：与开发版 patchNodePhaseOnePrompt 同级的小白简化版）── */

function noviceBuiltinPhaseOne(run, segments) {
    const env = run.env_snapshot || {};
    const hasRecording = /\.json$/i.test(String(run.trigger_url || '').trim());
    return [
        '你是一位资深的 Java 企业软件支持工程师，帮用户排查并解决产品问题。请用中文交流。',
        '',
        '【问题描述】',
        run.problem_desc || '',
        `触发入口：${run.trigger_url || '（未填写）'}${hasRecording ? '（这是一个接口录制文件的路径，见下方接口清单）' : '（可能是页面地址，也可能是 Java 入口类名，用于定位问题入口）'}`,
        '',
        '【环境信息】',
        `产品：${env.product_name || ''} ${env.product_version || ''}`.trim(),
        `产品源码：通过 patch_source MCP 检索（本次用 root=${patchNodeMcpRoot(env)}，path 写相对该 root 的包级路径；先 list_roots 确认，没有对应 root 就说明「该版本源码未挂载」并停手，不要反编译 jar）`,
        `工程 home / war 包（编译依赖根）：${env.package_path || ''}`,
        `本次运行目录（你的工作目录，产物都写这里）：${run.turn_dir || ''}`,
        `改动暂存目录（要改/新增的文件只写这里）：${run.stage_dir || ''}`,
        '',
        '【环境补充】',
        segments.env.join('\n') || '（无）',
        '',
        '【任务】',
        '1. 结合产品源码定位问题根因，先给出简短分析；证据不足时如实说明还缺什么信息。可行的方案有多个时，',
        '   **你自己挑一个最合适的往下做**，不要停下来等用户选；在结论里写一句你选了哪个、为什么。',
        '2. 动手前先用 java-compiler-mcp skill（编译补丁必做）：用 Skill 工具调用 `java-compiler-mcp`，',
        '   八个工具（java_compile / java_run / java_scan_home / java_clear_cache / java_generate_patch /',
        '   java_generate_webapp_patch / java_apply_patch / frontend_build_patch）的参数、路径映射与常见错误都在里面，',
        '   **照它调用，不要自己猜参数**。',
        `3. 修复改动写到暂存目录 ${run.stage_dir || ''}（按修复目标应有的相对路径组织）；`,
        '   如果【环境补充】里给了客开工程目录，可以只读参考它的结构和同类文件写法，但绝不改动它；没有客开目录就直接用 patch_source MCP 读产品源码确认包路径。',
        '   为排查加的日志（Logger.error 等）可以加，但要能整段剥掉。',
        `4. 编译用 java_compile（module_path=暂存目录，home=工程 home；java_home 见环境补充，未登记时按环境补充里的 JDK 查找顺序处理，不要猜），生成补丁 zip 用`,
        `   java_generate_patch（NC 客开模块）或 java_generate_webapp_patch（标准 war/web 工程），产物输出到 ${run.turn_dir || ''}；`,
        '   打包完把 zip 条目列出来自查一遍；补丁包里必须包含改动的 .java 源码（没有就用 zip/jar uf 补进去）。',
        `5. 把结论写到 ${patchNodeJoin(run.turn_dir || '', '结论.md')}：问题根因（一段话）、修复逻辑（具体怎么改的、本次改动的文件列表、每个文件改了些什么、有没有加排查日志）；`,
        `   若生成了补丁 zip，写清 zip 的完整路径。`,
        '6. 需要用户补充信息或做选择时，把问题列在结论末尾（每条一行、写清缺它会导致什么），等用户回复。',
        '',
        '【约束】',
        '改动只写暂存目录与本次运行目录，不动工程 home、不动客开工程（除非环境补充里明确允许）；',
        '禁止改变原文件的编码方式；',
        '绝不执行 git commit / push / merge / checkout 等改变仓库状态的操作；',
        '不在任何目录留下临时脚本文件；数据库、远程调试的额外约束见下方。',
        segments.constraints.length ? '\n【额外约束】\n' + segments.constraints.join('\n') : '',
    ].filter(line => line !== undefined).join('\n');
}

function noviceBuiltinPhaseTwo(run, segments) {
    const env = run.env_snapshot || {};
    const codeDir = String(env.code_directory || '').trim();
    const cleanDir = patchNodeJoin(run.turn_dir || '', 'clean');
    const patchPrefix = patchNodePatchPrefix(run);
    const patchUser = String((patchState.user && patchState.user.username) || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_') || 'user';
    return [
        '用户已确认问题已解决。现在整理并生成最终交付的「干净补丁包」。',
        '**绝对禁止使用 git 提交或合并代码**：不要执行 git commit / push / merge / checkout / rebase，也不要动 .git 目录。',
        '**不要在任何目录留下临时辅助脚本**（.py/.sh/.bat）：临时检查用内联命令做，确实需要脚本就写系统临时目录、用完立即删。',
        '',
        `1. 读取 ${patchNodeJoin(patchNodeStepDirOf(run), 'changes.txt')}（本步的改动清单；没有就读暂存目录自己列）。`,
        `2. 逐个文件把排查日志（为排查临时加的 Logger.error 输出、调试工具类调用等）剥掉，与基线对比：`,
        `   **只有日志、没有业务改动的文件**：整个排除，不进 clean、不进补丁；排除原因写进合并说明。`,
        `   **有业务改动的文件**：把去掉日志的版本放进 ${cleanDir}（保持相对路径），不要动暂存目录原始 work。`,
        codeDir
            ? `3. 把 ${cleanDir} 里清理后的文件同步回客开工程 ${codeDir} 的对应相对路径（覆盖；新增文件按相对路径建出，目录不存在就一并建出）；目标文件内容与基线不一致时**停止并报告，不要覆盖**。`
            : '3. 本环境没有登记客开工程目录，跳过「同步回工程」步骤，直接生成干净补丁包。',
        `4. 生成干净补丁 zip：用 java-compiler-mcp skill 的 java_generate_patch（或标准 war/web 工程用 java_generate_webapp_patch）：`,
        `   module_path = ${cleanDir}，home = ${env.package_path || ''}，java_home = ${env.local_jdk_path || '（见环境补充，未登记就在 home 下找，找不到停下提示）'}，`,
        `   files = clean 里过滤后的清单一次传入，产物输出到 ${run.turn_dir || ''}；`,
        `   补丁 zip **命名固定为 ${patchPrefix}<问题简述>_${patchUser}.zip**（<问题简述>由你结束时用 ~20 字概括，去掉 \\ / : * ? " < > |）；`,
        '   打包完 unzip -l 自查条目与层级，并抽查 zip 里是去日志版（unzip -p / zipgrep 不得再出现排查日志标记），不干净就清了重打；',
        '   补丁里必须包含业务改动文件的 .java 源码（只有 class 没有 java 就用 zip/jar uf 补进去）。',
        `5. 用 diff-report skill 重新生成 HTML 对比报告（对比 clean vs 基线）：`,
        `   基线在 ${patchNodeJoin(patchNodeStepDirOf(run), 'baseline')}（没有就从工程/源码重新取），复制到 ${patchNodeJoin(run.turn_dir || '', 'baseline')}，`,
        `   ROOT=${run.turn_dir || ''}，PROJECTS=[("diff","clean","baseline")]，A_LABEL=clean 业务改动，B_LABEL=基线，产物输出到 ${patchNodeJoin(patchNodeJoin(run.turn_dir || '', 'report'), 'diff.html')}。`,
        `6. 把结果写入 ${patchNodeJoin(run.turn_dir || '', '合并说明.md')}，**第一行固定写成**「结果：成功」或「结果：冲突」（有文件没同步/没打包成功就写冲突），后面写详细清单。`,
        `7. 生成总结写到 ${patchNodeJoin(run.turn_dir || '', '总结.md')}：根本原因 + 最终修复机制 + 关键文件清单，面向接手的人写，不要流水账。`,
        '',
        '【环境补充】',
        segments.env.join('\n') || '（无）',
        segments.constraints.length ? '\n【额外约束】\n' + segments.constraints.join('\n') : '',
    ].join('\n');
}

function noviceBuiltinRetry(run, segments, note, logText) {
    return [
        `【本次为第 ${run.phase1_step || 1} 次执行（新开 ${run.step_dir || ''}）】之前提示词里更早的目录一律作废：`,
        `产物（changes.txt / 结论.md / 补丁 zip / baseline / report）都写到 ${run.turn_dir || ''}，改动只写暂存目录 ${run.stage_dir || ''}。`,
        '',
        '【编译要求】用 java-compiler-mcp skill（Skill 工具调用 `java-compiler-mcp`），照它调用不要猜参数：',
        '编译 java_compile、打包 java_generate_patch（NC 客开模块）/ java_generate_webapp_patch（标准 war/web 工程）。',
        '【源码检索要求】走 patch_source MCP：root=' + patchNodeMcpRoot(run.env_snapshot || {}) + '，',
        'path 写相对该 root 的包级路径（如 nc/impl/tb），禁止根级/全树模式；先 list_roots 确认。',
        '',
        logText
            ? `【本次新提供的日志】\n${logText}\n\n请根据这份日志继续排查并解决问题。`
            : '本次重跑未上传新日志，请结合会话上下文已有的信息继续排查并解决问题。',
        note ? `\n【用户的补充说明】\n${note}` : '',
        '',
        '【环境补充】',
        segments.env.join('\n') || '（无）',
        segments.constraints.length ? '\n【额外约束】\n' + segments.constraints.join('\n') : '',
    ].join('\n');
}

/* ── 统一入口 ──
   stage ∈ phase1 / phase2 / retry。
   优先用管理员在小白版下配置的模板（含 seg_* 片段模板），渲染 {{var}} 并插锚点；
   没配置走内置默认函数。返回最终提示词文本。
   retry 载荷：{ note, logText, recordPath }——最后一项是重跑前重新录制的接口 JSON 路径，
   作为「本次新录制的现场」追加到提示词末尾（含接口摘要与 find_action 要求）。 */
async function noviceBuildPrompt(run, stage, retryPayload) {
    // 问题描述和截图合并成一个表单项：只传截图没写文字时，给提示词一个占位说明
    const imagePaths = Array.isArray(run.image_paths) ? run.image_paths.filter(Boolean) : [];
    const promptRun = (imagePaths.length && !String(run.problem_desc || '').trim())
        ? Object.assign({}, run, { problem_desc: '（用户没有填写文字描述，问题现象见附带的问题图片/文件）' })
        : run;
    const resolved = await nodeFetchResolvedPrompts(promptRun).catch(() => null);
    const segs = await noviceSegments(promptRun, resolved);
    const segments = { env: segs.env, constraints: segs.constraints };
    let prompt;
    if (resolved && resolved[stage] && String(resolved[stage]).trim()) {
        // 管理员模板：{{var}} 渲染 + 锚点占位（env_extra/constraints_extra 已在变量字典里展开）
        const env = promptRun.env_snapshot || {};
        const values = buildNodePromptValues(promptRun, {
            env_extra: segments.env.join('\n'),
            constraints_extra: segments.constraints.join('\n'),
            retry_n: String(promptRun.phase1_step || 1),
            note: (retryPayload && retryPayload.note) || '',
            // 主模板里用 {{db_connection}} 也只给掩码版（会话存档会带着提示词上传）
            db_connection: noviceMaskDbPassword(env.db_connection || ''),
        });
        prompt = renderNodeTemplate(resolved[stage], values);
    } else if (stage === 'phase2') {
        prompt = noviceBuiltinPhaseTwo(promptRun, segments);
    } else if (stage === 'retry') {
        prompt = noviceBuiltinRetry(promptRun, segments, retryPayload && retryPayload.note, retryPayload && retryPayload.logText);
    } else {
        prompt = noviceBuiltinPhaseOne(promptRun, segments);
    }
    // 重跑时新录制的接口数据：作为补充现场追加到重跑提示词后面
    if (stage === 'retry' && retryPayload && retryPayload.recordPath) {
        prompt += await noviceRecordingAppendix(String(retryPayload.recordPath));
    }
    // 用户附带的问题图片/文件：提示 AI 先用 Read 工具逐个查看
    if (imagePaths.length) {
        prompt += `\n\n【问题附件】用户附带了 ${imagePaths.length} 个问题附件（本机文件），请先用 Read 工具逐个查看：图片按图片理解，其他文件读取内容。结合里面的报错提示、字段和操作位置定位问题：\n`
            + imagePaths.map(path => `- ${path}`).join('\n');
    }
    // 用户提供的日志截图/文件
    const logPaths = Array.isArray(run.log_paths) ? run.log_paths.filter(Boolean) : [];
    if (logPaths.length) {
        prompt += `\n\n【日志附件】用户提供了 ${logPaths.length} 个日志截图/文件（本机文件），请用 Read 工具查看/读取，结合其中的报错信息分析：\n`
            + logPaths.map(path => `- ${path}`).join('\n');
    }
    return prompt;
}

// 重跑追加段：路径 + 接口摘要 + find_action 要求（读不到摘要时只给路径）
async function noviceRecordingAppendix(jsonPath) {
    const summary = await noviceRecordingSummary(jsonPath);
    let text = `\n\n【本次新录制的接口数据】文件：${jsonPath}`;
    if (summary) {
        text += `\n${summary}`;
        text += '\n对上面的每个 .do 接口，先调 patch_source MCP 的 find_action 定位入口处理类，再继续分析。';
    } else {
        text += '\n（摘要读取失败，请直接读该 JSON 文件了解本次复现涉及的接口。）';
    }
    return text;
}
