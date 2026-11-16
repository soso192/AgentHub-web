/**
 * 开发版 / 实施版提示词的固定前后置段。
 *
 * - 分析前：两版都先读同一套 FBIP Skills（FBIP 所有版本 + NC Cloud/NC 客开）；
 *   两版都先判断问题属于「配置/数据类」还是「代码缺陷类」，配置类优先用 SQL 解决。
 * - 执行开关：开发版的「是否需要排查日志 / 是否生成差异报告」关掉时，追加优先指令。
 *
 * 这段内容独立于管理员配置的模板：无论走模板还是内置默认提示词都会带上。
 */

type EnvSnapshot = Record<string, unknown>;

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

function skillLocation(env: EnvSnapshot): string {
  const dir = text(env.local_skill_path).trim().replace(/[\\/]+$/, '');
  if (dir) {
    return [
      `skill 库位置：**优先**使用产品环境里配置的「本机 skill 地址」：${dir}`,
      '  - 该目录下直接有 `SKILL.md`：它本身就是一个 skill，按需读取；',
      `  - 该目录下有 \`.claude/skills\`：它是 skill 库根目录，技能在 ${dir}/.claude/skills 下；`,
      `  - 该目录下是多个含 \`SKILL.md\` 的子目录：把它当作 skills 目录，技能路径为 ${dir}/<skill>/SKILL.md。`,
      '  - 如果该地址下找不到 fbip-* 技能，再回落到 cc-web 安装目录下的 `fbip_claude_skills_V82`。',
    ].join('\n');
  }
  return [
    'skill 库位置：产品环境里登记了「本机 skill 地址」时以它为准；未登记时按顺序查找：',
    '  ① 从本次运行目录向上找到包含 cc-web.exe 的安装目录，其下的 `fbip_claude_skills_V82`（或 `fbip_claude_skills_V*`）；',
    '  ② 用户目录 `~/.claude/skills` 下的 `fbip-*` 技能。',
    '  找到库根后，技能在 `<库根>/.claude/skills` 下。',
  ].join('\n');
}

/**
 * 分析前必读：FBIP Skills 路由说明。
 * 开发版、实施版共用同一套 skill；FBIP 所有版本和 NC Cloud（NCC）/ NC 客开版本都适用。
 */
export function fbipSkillGuide(env: EnvSnapshot, edition: 'dev' | 'novice'): string {
  const entry =
    edition === 'dev'
      ? '0. 入口判定：按问题来源选择入口——有 JIRA 单号走 `fbip-jira-solver`，没有 JIRA 单号走 `fbip-problem-solver`；再按 L1→L2→L3 路由。'
      : '0. 入口判定：本任务是实施现场问题（通常没有 JIRA 单号），优先从 `fbip-problem-solver` 进入；如果用户给了 JIRA 单号，则走 `fbip-jira-solver`。';
  const lines = [
    '【开始前必读：FBIP Skills 知识库】',
    '解决问题之前，先读下面这套 skill，再动手分析；不要跳过这一步直接看代码或猜结论。',
    skillLocation(env),
    '适用范围：FBIP 所有版本，以及 NC Cloud（NCC）/ NC 客开版本。NC 问题同样使用这套 skill（按业务模块映射到对应域），不要因为不是 FBIP 就跳过。',
    '阅读顺序：',
    entry,
    '1. 先读 skill 库根目录的 `fbip-skills-guide.md` 和 `AGENTS.md`（没有就读 `README.md` 的「Skill 路由体系」），了解入口、强制规则与输出要求；',
    '2. 用 `fbip-skill-router` 做 L1 路由，确定业务域（如 erm/gl/arap/cmp/am/fa/aim/epmp/arcp/invoice/ssc/vtax/wf/ufoe/tm/fct/leaseme/ewm/pd/mdd/other），再读对应的 `fbip-<域>-router`（L2），最后读命中的 1~3 个 L3 `SKILL.md`；',
    '3. 用 skill 里的业务链路、数据模型（表/字段/表间关系）、问题模式和排查路径指导本次分析，并在结论里注明参考了哪些 skill。',
    '读取方式：直接用 Read / Glob 按上面的路径读 `SKILL.md`；skill 库不在用户级 `~/.claude/skills` 时，Skill 工具可能看不到它，不要因为 Skill 列表里没有就跳过。',
    '约束：skill 库只读，不要修改；目录不存在或没有对应域时，如实说明「未找到对应 skill」，按现有证据继续分析，禁止编造 skill 内容。',
  ];
  if (edition === 'dev') {
    const readIndex = lines.findIndex((line) => line.startsWith('读取方式：'));
    lines.splice(
      readIndex >= 0 ? readIndex : lines.length,
      0,
      '说明：skill 用于业务链路、数据模型和问题模式；产品源码检索仍按本提示词后面的 patch_source MCP 要求执行，两者不冲突。'
    );
  }
  return lines.join('\n');
}

/** 实施版分析前必读段（保留原导出名，内部走通用实现）。 */
export function noviceSkillGuide(env: EnvSnapshot): string {
  return fbipSkillGuide(env, 'novice');
}

/**
 * 环境补充：把产品环境里配置、但提示词模板没有引用的字段补进【环境】段。
 *
 * 模板是数据库里配置的，字段不一定齐全（例如模板只有产品/目录/JDK，没有数据库连接、
 * 调试地址、录制页面）。这里按「值非空且模板还没有对应标签」补一行，避免漏信息。
 */
interface EnvLineSpec {
  line: string;
  label: RegExp;
}

function envLineSpecs(env: EnvSnapshot): EnvLineSpec[] {
  const specs: EnvLineSpec[] = [];
  const add = (value: unknown, line: (value: string) => string, label: RegExp) => {
    const textValue = text(value).trim();
    if (textValue) specs.push({ line: line(textValue), label });
  };

  add(env.project_name, (v) => `项目：${v}`, /(^|\n)\s*项目[：:]/);
  add(
    env.db_connection,
    (v) => `数据库连接：${v}（仅用于本次排查；结论和回复里不要输出明文口令）`,
    /(^|\n)\s*数据库连接[：:]/
  );
  add(
    env.debug_address,
    (v) => `远程调试地址：${v}（只做线程级观察，临时断点用完立即移除）`,
    /(^|\n)\s*(远程)?调试地址[：:]/
  );
  add(env.record_url, (v) => `录制页面：${v}`, /(^|\n)\s*录制页面[：:]/);
  add(
    env.patch_output_path,
    (v) => `补丁输出根目录（环境变量）：${v}`,
    /(^|\n)\s*补丁输出根目录（环境变量）[：:]/
  );
  add(env.local_jdk_path, (v) => `本地 JDK：${v}`, /(^|\n)\s*(本地\s*)?JDK[：:]/i);
  add(
    env.code_directory,
    (v) => `客开代码目录：${v}`,
    /(^|\n)\s*(客开|web).*(工程|代码目录|工程根).*[：:]/
  );
  add(
    env.package_path,
    (v) => `工程 home / war 包地址：${v}`,
    /(^|\n)\s*.*(home|war).*(包|目录|地址).*[：:]/i
  );
  return specs;
}

/** 提示词里还没有对应标签的环境行（模板 {{env_extra}} 锚点与最终补环境段共用）。 */
export function envSupplementForPrompt(prompt: string, env: EnvSnapshot): string[] {
  return envLineSpecs(env)
    .filter((spec) => !spec.label.test(prompt))
    .map((spec) => spec.line);
}

export function applyEnvSupplement(prompt: string, env: EnvSnapshot): string {
  const lines = envSupplementForPrompt(prompt, env);

  if (!lines.length) return prompt;

  const parts = prompt.split(/\r?\n/);
  const start = parts.findIndex((line) => /^【环境(信息)?】\s*$/.test(line));
  if (start < 0) {
    return `${prompt.replace(/\s+$/, '')}\n\n【环境补充】\n${lines.join('\n')}`;
  }
  // 环境段在下一个空行或下一个【段落】处结束，避免没有【任务】标题时插到全文末尾。
  let end = start + 1;
  while (end < parts.length && parts[end].trim() !== '' && !/^【/.test(parts[end])) end += 1;
  parts.splice(end, 0, ...lines);
  return parts.join('\n');
}

function joinPath(base: string, ...parts: string[]): string {
  const clean = String(base || '').replace(/[\\/]+$/, '');
  if (!clean) return '';
  const sep = clean.includes('\\') && !clean.includes('/') ? '\\' : '/';
  return [clean, ...parts].join(sep);
}

/**
 * 阶段二「不需要去除排查日志」时：第 2 条改为把 work 里的业务改动原样放进 clean。
 * 阶段一没加日志，所以这里不能再出现“剥掉日志”的说法。
 */
function mergeNoStripStep(run: {
  turn_dir?: string;
  step_dir?: string;
  out_dir?: string;
}): string {
  const changes = joinPath(String(run.turn_dir || ''), 'changes.txt');
  const baseline = joinPath(String(run.turn_dir || ''), 'baseline');
  const workDir = joinPath(String(run.step_dir || ''), 'work');
  const cleanDir = joinPath(String(run.out_dir || ''), 'result', 'clean');
  return [
    `2. 本次阶段一没有增加排查日志，不需要去除日志。读取 ${changes}（本步的改动清单），逐个文件与基线 ${baseline} 对比：`,
    `   有业务改动的文件，从 ${workDir}（本步 work）**原样**复制到 ${cleanDir}（同相对路径，不改内容，不做编码或行尾转换；按工程布局保留原有目录层级）；`,
    `   与基线完全相同的文件不进 clean，并在合并说明里列出文件名和排除原因。`,
  ].join('\n');
}

/**
 * 阶段二「不需要去除排查日志」时：不需要重新打包，阶段一生成的补丁就是最终补丁。
 */
function mergeNoRepackStep(run: { step_dir?: string }): string {
  const stepDir = String(run.step_dir || '');
  return [
    `5. 本次不重新打包补丁：阶段一在 ${stepDir} 下生成的补丁 zip 已经是最终干净补丁（阶段一没有增加排查日志），`,
    `   保持原样，不要重新生成或覆盖；只用 unzip -l 确认该 zip 存在、条目完整（含本次业务改动文件的 .java 源码），把它作为最终交付补丁。`,
  ].join('\n');
}

/**
 * 按任务开关删除模板里对应的整段内容（不是追加一句“不要做”）。
 * 模板存在数据库里，开关为否时必须把日志段/差异报告段真正裁掉。
 */
function removeNumberedSection(prompt: string, startPattern: RegExp): string {
  const parts = prompt.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of parts) {
    if (!skipping && startPattern.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // 下一个顶层任务（1. / 2. …）或下一个【段落】时结束
      if (/^\s*\d+\.\s/.test(line) || /^【/.test(line)) {
        skipping = false;
        kept.push(line);
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** 把一条编号任务整段替换成新的编号任务（保留 2. / 5. 的编号不变）。 */
function replaceNumberedSection(prompt: string, startPattern: RegExp, replacement: string): string {
  const parts = prompt.split(/\r?\n/);
  const kept: string[] = [];
  let replaced = false;
  let skipping = false;
  for (const line of parts) {
    if (!skipping && !replaced && startPattern.test(line)) {
      kept.push(...replacement.split('\n'));
      replaced = true;
      skipping = true;
      continue;
    }
    if (skipping) {
      // 下一个顶层任务（1. / 2. …）或下一个【段落】时结束
      if (/^\s*\d+\.\s/.test(line) || /^【/.test(line)) {
        skipping = false;
        kept.push(line);
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** 删掉整段后把顶层编号重新排成 1..N（阶段二模板没有嵌套编号）。 */
function renumberTopLevelSteps(prompt: string): string {
  let index = 0;
  return prompt
    .split(/\r?\n/)
    .map((line) => {
      const matched = /^(\d+)\.\s+(.*)$/.exec(line);
      if (!matched) return line;
      index += 1;
      return `${index}. ${matched[2]}`;
    })
    .join('\n');
}

type PromptSwitchRun = {
  need_debug_log?: boolean;
  need_diff_report?: boolean;
  merge_strip_log?: boolean;
  merge_diff_report?: boolean;
  stage?: number;
  turn_dir?: string;
  step_dir?: string;
  out_dir?: string;
};

export function applyPromptSwitches(prompt: string, run: PromptSwitchRun): string {
  let out = prompt;
  // 阶段一用创建表单的开关；阶段二用合并表单的开关（没传时按“是”处理）。
  const isMerge = (run.stage ?? 1) >= 2;
  const stripLogOff = isMerge ? run.merge_strip_log === false : run.need_debug_log === false;
  const reportOff = isMerge ? run.merge_diff_report === false : run.need_diff_report === false;

  if (stripLogOff) {
    if (isMerge) {
      // 阶段一没加日志：不剥日志、不重新打包，阶段一的 zip 就是最终补丁。
      out = replaceNumberedSection(out, /^\s*\d+\.\s*逐个文件先把排查日志/, mergeNoStripStep(run));
      out = replaceNumberedSection(
        out,
        /^\s*\d+\.\s*重新生成「干净版补丁 zip」/,
        mergeNoRepackStep(run)
      );
      out = out
        .replace(/去日志后的 clean 版（只业务改动）/g, 'clean 版（本次业务改动）')
        .replace(/去掉排查日志后的业务改动/g, '本次业务改动')
        .replace(/确认 clean 与 clean 补丁里都不含排查日志/g, '确认 clean 与最终补丁的内容一致')
        // 第 3 步不再说「清理后的文件」——本次没有日志要清理。
        .replace(/里清理后的文件/g, '里的业务改动文件');
    } else {
      // 「4. 在你认为所有可能相关的类中补上特别详细的日志」整段
      out = removeNumberedSection(
        out,
        /^\s*\d+\.\s*在你认为所有可能相关的类中补上特别详细的日志/
      );
      // 任务 1 里对第 4 条的引用
      out = out.replace(/\s*并按第\s*\d+\s*条先补日志[。.]?/g, '');
      // 约束里的日志要求
      out = out.replace(/^-\s*日志必须详细[，,].*$/gm, '');
    }
  }

  if (reportOff) {
    // 阶段一「8. 生成 HTML 对比报告」/ 阶段二「6. 用 diff-report skill 重新生成…」
    out = removeNumberedSection(
      out,
      /^\s*\d+\.\s*(用\s*diff-report\s*skill\s*)?(重新)?生成\s*HTML\s*对比报告/
    );
    // 重试提示词里的产物清单不再提 baseline / report
    out = out.replace(
      /changes\.txt\s*\/\s*结论\.md\s*\/\s*补丁\s*zip\s*\/\s*baseline\s*\/\s*report\s*\/\s*aisql\.sql/g,
      'changes.txt / 结论.md / 补丁 zip / aisql.sql'
    );
  }

  if (isMerge) out = renumberTopLevelSteps(out);

  return out.replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * 问题类型判断 + SQL 执行规范。
 * 明确配置/数据类问题优先用 SQL 修，而不是下意识改代码。
 */
export function noviceProblemTypeGuide(env: EnvSnapshot, turnDir: string): string {
  const hasDb = Boolean(text(env.db_connection).trim());
  const dir = turnDir.replace(/[\\/]+$/, '');
  const lines = [
    '【重要：先判断问题类型，不是所有问题都需要改代码】',
    '动手改代码或生成补丁前，先判断属于哪一类，并把判断依据写进结论：',
    '1. 配置/数据类（优先）：产品参数、基础数据、权限、流程/审批、编码规则、单据模板、打印/预警、后台/定时任务等配置缺失或不正确。这类问题通常不需要改代码，应通过执行数据库 SQL 修正配置或数据。',
    '2. 代码缺陷类：确认是程序逻辑错误，且配置/SQL 无法解决时，才修改代码、生成补丁。',
    '两类都可能时，先验证成本低、可回滚的配置/SQL 方案；配置方案无效，再走代码修复。',
    '',
    '【SQL 规范】',
    '- 写 SQL 前先用 skill 里的数据模型确认表名、字段、表间关系，再配合 SELECT / SHOW / DESC 查现状，不要猜表名和字段。',
    '- 变更 SQL 必须成组给出：① 查询现状 SQL；② 变更 SQL（WHERE 条件精确，禁止无条件 UPDATE/DELETE）；③ 影响行数预估（先用同条件 SELECT COUNT(*)）；④ 备份/记录原值 SQL；⑤ 回滚 SQL。',
    '- 多条变更用事务包起来（BEGIN/COMMIT，异常 ROLLBACK），并说明锁和影响范围。',
    '- 只读查询可以直接执行；写操作（INSERT/UPDATE/DELETE/DDL）必须先说明影响并把脚本交给用户确认；只有用户明确授权在当前环境执行时才执行，执行前先备份原值。',
    `- SQL 写入 ${dir || '<本次运行目录>'}/aisql.sql，配置/数据方案写入 ${dir || '<本次运行目录>'}/方案.txt；结论里写明问题类型、依据、执行或待执行的 SQL、影响范围与回滚方式。`,
    '- 任何回复和文件里都不要输出明文数据库口令。',
  ];
  if (!hasDb) {
    lines.push('- 本次未登记数据库连接：只交付 SQL 脚本供用户执行，不要假设自己能连库。');
  }
  return lines.join('\n');
}

/** 实施版分析阶段（phase1 / retry）统一加在提示词最前面的固定段。 */
export function novicePreflight(env: EnvSnapshot, turnDir: string): string {
  return `${noviceSkillGuide(env)}\n\n${noviceProblemTypeGuide(env, turnDir)}`;
}
