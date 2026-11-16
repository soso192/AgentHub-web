import { create } from 'zustand';
import { api, openSessionStream } from '../lib/api';
import {
  applyEnvSupplement,
  applyPromptSwitches,
  envSupplementForPrompt,
  fbipSkillGuide,
  novicePreflight,
  noviceProblemTypeGuide,
} from '../lib/novicePrompt';
import { patchApi } from '../lib/patch';
import type { ProjectEnv, StreamEvent } from '../lib/types';
import { useAuthStore } from './auth';
import { useChatStore } from './chat';

export interface LocalNodeRun {
  id: string;
  edition?: 'dev' | 'novice';
  mode?: string;
  problem_desc: string;
  trigger_url?: string;
  env_id?: number | string;
  env_snapshot?: Record<string, unknown>;
  patch_output_path?: string;
  out_dir?: string;
  step_dir?: string;
  turn_dir?: string;
  stage_dir?: string;
  phase1_step?: number;
  stage?: number;
  phase: 'analyzing' | 'merging' | 'awaiting_decision' | 'done' | 'failed';
  verdict?: 'solved' | 'unsolved' | 'merge';
  failure?: string;
  retry_count?: number;
  report?: string;
  conclusion?: string;
  artifacts?: string[];
  log_info_inline?: string;
  log_file_name?: string;
  need_debug_log?: boolean;
  need_diff_report?: boolean;
  /** 阶段二合并表单：是否需要去除排查日志 / 是否需要生成差异报告。 */
  merge_strip_log?: boolean;
  merge_diff_report?: boolean;
  session_id?: string;
  agent_session_id?: string;
  client_host?: string;
  user_id?: number | string;
  reported?: boolean;
  created_at?: string;
  updated_at?: string;
  timings?: unknown[];
  [key: string]: unknown;
}

interface CreateOptions {
  edition: 'dev' | 'novice';
  env: ProjectEnv;
  problem_desc: string;
  trigger_url?: string;
  patch_output_path?: string;
  log_text?: string;
  log_file_name?: string;
  need_debug_log?: boolean;
  need_diff_report?: boolean;
  problem_files?: File[];
  log_files?: File[];
  user_id?: number | string;
}

interface NodeState {
  runs: LocalNodeRun[];
  host: string;
  loading: boolean;
  initialized: boolean;
  streaming: Record<string, boolean>;
  load: () => Promise<void>;
  create: (options: CreateOptions) => Promise<LocalNodeRun>;
  /** 实施版 NewTaskDialog 自己建会话/发提示词，这里把运行登记进清单并监听执行结束。 */
  registerExternal: (run: LocalNodeRun) => Promise<void>;
  save: (run: LocalNodeRun) => Promise<void>;
  solve: (id: string) => Promise<void>;
  /** 聊天页「合并」按钮：按合并表单的开关生成阶段二提示词，发到当前会话。 */
  mergeToSession: (
    id: string,
    options: { stripLog?: boolean; diffReport?: boolean }
  ) => Promise<void>;
  unsolve: (id: string, extra: { note?: string; log_text?: string; log_file_name?: string }) => Promise<void>;
  rerun: (id: string) => Promise<void>;
  abort: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const activeStreams = new Map<string, () => void>();

function newRunId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => variables[key] ?? '');
}

/** patch_source MCP 的 root：产品名小写 + 版本去点，中间短线（如 fbip-82）。 */
function mcpRoot(env: Record<string, unknown>): string {
  const name = String(env.product_name || '').trim().toLowerCase();
  const version = String(env.product_version || '').trim().replace(/\./g, '');
  return name ? `${name}-${version}` : '';
}

function timestampStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

function patchPrefix(run: LocalNodeRun): string {
  const env = (run.env_snapshot || {}) as Record<string, unknown>;
  const productTag = `${String(env.product_name || 'unknown')}${String(env.product_version || '')}`
    .replace(/[\\/:*?"<>|\s]+/g, '_');
  return `patch_${productTag}_${timestampStamp()}_`;
}

function patchUser(): string {
  const username = String(useAuthStore.getState().user?.username || '').trim();
  return username.replace(/[\\/:*?"<>|\s]+/g, '_') || 'user';
}

function variablesFor(run: LocalNodeRun, extra: Record<string, string> = {}): Record<string, string> {
  const env = (run.env_snapshot || {}) as Record<string, unknown>;
  const str = (value: unknown) => (value == null ? '' : String(value));
  const turnDir = str(run.turn_dir);
  const stageDir = str(run.stage_dir);
  const vars: Record<string, string> = {
    product_name: str(env.product_name),
    product_version: str(env.product_version),
    project_name: str(env.project_name),
    mcp_root: mcpRoot(env),
    problem_desc: run.problem_desc || '',
    trigger_url: run.trigger_url || '',
    code_directory: str(env.code_directory),
    package_path: str(env.package_path),
    patch_output_path: str(env.patch_output_path),
    local_jdk_path: str(env.local_jdk_path),
    local_skill_path: str(env.local_skill_path),
    db_connection: str(env.db_connection),
    debug_address: str(env.debug_address),
    record_url: str(env.record_url),
    out_dir: str(run.out_dir),
    step_dir: str(run.step_dir),
    turn_dir: turnDir,
    stage_dir: stageDir,
    stage_dir_src: joinPath(stageDir, 'src'),
    retry_n: String(run.retry_count ?? 0),
    step_n: String(run.phase1_step ?? 1),
    log_info: str(run.log_info_inline),
    log_file_name: run.log_file_name || 'ailog',
    need_debug_log: run.need_debug_log === false ? '否' : '是',
    need_diff_report: run.need_diff_report === false ? '否' : '是',
    turn_dir_aisql: joinPath(turnDir, 'aisql.sql'),
    turn_dir_plan: joinPath(turnDir, '分析计划.md'),
    turn_dir_changes: joinPath(turnDir, 'changes.txt'),
    turn_dir_conclusion: joinPath(turnDir, '结论.md'),
    turn_dir_merge: joinPath(turnDir, '合并说明.md'),
    turn_dir_summary: joinPath(turnDir, '总结.md'),
    turn_dir_baseline: joinPath(turnDir, 'baseline'),
    turn_dir_report_index: joinPath(turnDir, '0_对比报告_首页.html'),
    turn_dir_report_diff: joinPath(joinPath(turnDir, 'report'), 'diff.html'),
    patch_prefix: patchPrefix(run),
    patch_user: patchUser(),
    clean_dir: joinPath(str(run.out_dir), 'result', 'clean'),
    ...extra,
  };
  return vars;
}

function builtinPrompt(run: LocalNodeRun, stage: 'phase1' | 'phase2' | 'retry', extra: Record<string, string>): string {
  const env = (run.env_snapshot || {}) as Record<string, unknown>;
  const s = (value: unknown) => (value == null ? '' : String(value));
  const header = [
    '你是一个 Java 企业应用问题排查与补丁生成助手。',
    '',
    '【环境】',
    `产品：${s(env.product_name)} ${s(env.product_version)}`,
    `产品源码：通过 patch_source MCP 检索（root=${mcpRoot(env)}；path 写相对该 root 的包级路径）`,
    `客开代码目录：${s(env.code_directory)}`,
    `home/war 目录：${s(env.package_path)}`,
    s(env.local_jdk_path) ? `本地 JDK：${s(env.local_jdk_path)}` : '',
    `补丁输出根目录：${s(run.out_dir)}`,
    `本次步骤目录：${s(run.step_dir)}`,
    `工作目录：${s(run.stage_dir)}`,
    `问题描述：${run.problem_desc}`,
    run.trigger_url ? `触发入口：${run.trigger_url}` : '',
    run.log_info_inline ? `日志片段：\n${String(run.log_info_inline).slice(0, 8000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (stage === 'phase1' || stage === 'retry') {
    return `${header}

请在不修改客开源码目录的前提下完成排查：
1. 阅读客开代码与运行日志，定位问题根因。
2. 将分析过程写入 ${joinPath(s(run.turn_dir), '分析计划.md')}。
3. 将需要执行的 SQL 写入 ${joinPath(s(run.turn_dir), 'aisql.sql')}，配置/数据类问题的实现方案写入 ${joinPath(s(run.turn_dir), '方案.txt')}。
4. 将结论写入 ${joinPath(s(run.turn_dir), '结论.md')}，写明问题属于配置/数据类还是代码缺陷类。
5. 将建议的源码改动写入 ${joinPath(s(run.turn_dir), 'changes.txt')}（文件路径 + 修改前/后片段）。
6. 如需编译验证，使用 java-compiler-mcp，不要直接修改客户工程。
${extra.note ? `补充说明：${extra.note}` : ''}
${extra.log_text ? `补充日志：\n${extra.log_text.slice(0, 8000)}` : ''}
完成后请用一句话总结结论。`;
  }

  const noStrip = run.merge_strip_log === false;
  return `${header}

阶段二：合并补丁。
1. 阅读 ${joinPath(s(run.turn_dir), 'changes.txt')} 中的改动建议。
2. ${
    noStrip
      ? `把 ${joinPath(s(run.step_dir), 'work')} 中的业务改动文件原样复制到 ${joinPath(s(run.out_dir), 'result', 'clean')}（本次没有增加排查日志，不需要去日志）。`
      : `在 ${joinPath(s(run.out_dir), 'result', 'clean')} 生成干净补丁源码（去掉诊断日志）。`
  }
3. 将改动同步到客开工程 ${s(env.code_directory)}。
4. ${
    noStrip
      ? `本次不重新打包：阶段一在 ${s(run.step_dir)} 下生成的补丁 zip 就是最终补丁，确认它存在且条目完整即可。`
      : `生成补丁 zip，文件名以 patch_${s(env.product_name)}${s(env.product_version)}_ 开头。`
  }
5. 写入 ${joinPath(s(run.turn_dir), '合并说明.md')}，第一行必须是「结果：成功」或「结果：冲突」。
6. 写入 ${joinPath(s(run.turn_dir), '总结.md')}，说明改动内容与验证结果。
请确保第一行结论准确，系统依赖它判断合并结果。`;
}

async function resolvePrompt(
  run: LocalNodeRun,
  stage: 'phase1' | 'phase2' | 'retry',
  extra: Record<string, string> = {}
): Promise<string> {
  const env = (run.env_snapshot || {}) as Record<string, unknown>;
  let templates: Record<string, string> = {};
  try {
    templates = await patchApi.resolveNodePrompts(
      String(env.product_name ?? ''),
      String(env.product_version ?? ''),
      run.edition || 'dev'
    );
  } catch {
    templates = {};
  }
  const template = templates[stage];
  // 模板里的 {{env_extra}} 锚点：放入模板没有直接引用的环境字段。
  const promptExtra = {
    ...extra,
    env_extra: envSupplementForPrompt(template || '', env).join('\n'),
  };
  let prompt =
    template && template.trim()
      ? renderTemplate(template, variablesFor(run, promptExtra))
      : builtinPrompt(run, stage, promptExtra);

  // 分析/重试阶段固定先读 FBIP Skills：开发版、实施版共用同一套 skill 库。
  // 模板与内置默认提示词都要带上，管理员改模板不会漏掉这段。
  if (stage !== 'phase2') {
    prompt =
      run.edition === 'novice'
        ? `${novicePreflight(env, String(run.turn_dir || ''))}\n\n${prompt}`
        : `${fbipSkillGuide(env, 'dev')}\n\n${noviceProblemTypeGuide(env, String(run.turn_dir || ''))}\n\n${prompt}`;
  }

  // 模板没引用的环境字段补进【环境】段（数据库连接、调试地址、录制页面等）。
  prompt = applyEnvSupplement(prompt, env);

  // 「是否需要排查日志 / 是否生成差异报告」关掉时，直接裁掉模板里对应整段。
  return applyPromptSwitches(prompt, run);
}

async function readText(path?: string): Promise<string> {
  if (!path) return '';
  try {
    const result = await api.files.read(path);
    return result.success ? result.content : '';
  } catch {
    return '';
  }
}

async function listArtifacts(dir?: string): Promise<string[]> {
  if (!dir) return [];
  try {
    const result = await api.files.list(dir);
    if (!result.success) return [];
    return (result.files || []).filter((file) => !file.is_dir).map((file) => file.path);
  } catch {
    return [];
  }
}

export const useNodeStore = create<NodeState>((set, get) => {
  const update = (id: string, patch: Partial<LocalNodeRun>) => {
    let next: LocalNodeRun | null = null;
    set((state) => ({
      runs: state.runs.map((run) => {
        if (run.id !== id) return run;
        next = { ...run, ...patch, updated_at: new Date().toISOString() };
        return next;
      }),
    }));
    return next;
  };

  const persist = async (run: LocalNodeRun | null) => {
    if (!run) return;
    try {
      await api.nodeRuns.put(run.id, run as unknown as import('../lib/types').NodeRun);
    } catch {
      /* ignore */
    }
  };

  const report = (run: LocalNodeRun) => {
    const env = (run.env_snapshot || {}) as Record<string, unknown>;
    const payload = {
      local_run_id: run.id,
      problem_desc: run.problem_desc,
      status:
        run.phase === 'done'
          ? run.verdict === 'solved'
            ? 'solved'
            : 'unsolved'
          : run.phase === 'failed'
            ? 'error'
            : run.phase === 'awaiting_decision'
              ? 'awaiting_decision'
              : 'running',
      env_id: run.env_id,
      env_project_name: env.project_name,
      product_id: env.product_id,
      version_id: env.version_id,
      code_directory: env.code_directory,
      patch_output_path: run.out_dir,
      conclusion: (run.report || run.conclusion || '').slice(0, 4000),
      claude_session_id: run.agent_session_id,
      client_host: run.client_host || get().host,
      client_edition: run.edition || 'dev',
      started_at: run.created_at,
      finished_at: run.phase === 'done' || run.phase === 'failed' ? new Date().toISOString() : null,
    };
    patchApi
      .reportProblemRun(payload)
      .then(() => {
        const next = update(run.id, { reported: true });
        void persist(next);
      })
      .catch(() => {});
  };

  const finish = async (runId: string, isError: string | null) => {
    const closer = activeStreams.get(runId);
    if (closer) {
      closer();
      activeStreams.delete(runId);
    }
    set((state) => ({ streaming: { ...state.streaming, [runId]: false } }));

    const current = get().runs.find((run) => run.id === runId);
    if (!current) return;

    if (isError) {
      const next = update(runId, {
        phase: 'failed',
        failure: isError.slice(0, 2000),
      });
      void persist(next);
      if (next) report(next);
      return;
    }

    const artifacts = await listArtifacts(current.turn_dir);
    let patch: Partial<LocalNodeRun> = {
      artifacts,
      phase: 'awaiting_decision',
    };

    if ((current.stage || 1) >= 2) {
      const merge = await readText(joinPath(String(current.turn_dir || ''), '合并说明.md'));
      const summary =
        (await readText(joinPath(String(current.turn_dir || ''), '总结.md'))) ||
        (await readText(joinPath(String(current.turn_dir || ''), '结论.md')));
      const success = /^\s*结果\s*[:：]\s*成功/m.test(merge);
      patch = {
        artifacts,
        phase: success ? 'done' : 'failed',
        verdict: success ? 'solved' : 'merge',
        report: summary || merge || current.report,
        conclusion: merge || summary || current.conclusion,
      };
    } else {
      const conclusion =
        (await readText(joinPath(String(current.turn_dir || ''), '结论.md'))) ||
        (await readText(joinPath(String(current.turn_dir || ''), 'changes.txt')));
      patch.conclusion = conclusion;
      patch.report = conclusion ? conclusion.slice(0, 4000) : current.report;
    }

    const next = update(runId, patch);
    void persist(next);
    if (next) report(next);
  };

  const startPrompt = async (run: LocalNodeRun, prompt: string) => {
    if (!run.session_id) throw new Error('会话尚未创建');
    const existing = activeStreams.get(run.id);
    if (existing) {
      existing();
      activeStreams.delete(run.id);
    }
    set((state) => ({ streaming: { ...state.streaming, [run.id]: true } }));

    let promptSent = false;
    const close = openSessionStream(run.session_id, {
      onEvent: (event: StreamEvent) => {
        if (event.type === 'connected' && !promptSent) {
          promptSent = true;
          api.agent
            .start(run.session_id!, prompt)
            .then((result) => {
              if (result && (result as { success?: boolean }).success === false) {
                void finish(run.id, (result as { error?: string }).error || '启动失败');
              }
            })
            .catch((error) => {
              void finish(run.id, error instanceof Error ? error.message : '启动失败');
            });
        } else if (event.type === 'start') {
          const agentSessionId =
            typeof event.agentSessionId === 'string' ? event.agentSessionId : undefined;
          if (agentSessionId) {
            const next = update(run.id, { agent_session_id: agentSessionId });
            void persist(next);
          }
        } else if (event.type === 'stream_end') {
          // 进程退出后的真正终态；result 可能只是一次中途收尾。
          void finish(run.id, null);
        } else if (event.type === 'error') {
          void finish(run.id, typeof event.message === 'string' ? event.message : '执行出错');
        }
      },
      onError: () => {
        if (!promptSent) {
          // 连接失败：交给用户重试，避免无限重连
          void finish(run.id, '无法连接执行流，请稍后重试');
        }
      },
    });
    activeStreams.set(run.id, close);
  };

  return {
    runs: [],
    host: '',
    loading: false,
    initialized: false,
    streaming: {},

    load: async () => {
      set({ loading: true });
      try {
        const result = await api.nodeRuns.list();
        set({
          runs: (result.data || []).sort((a, b) =>
            String((b as LocalNodeRun).created_at || '').localeCompare(
              String((a as LocalNodeRun).created_at || '')
            )
          ) as unknown as LocalNodeRun[],
          host: result.host || '',
          initialized: true,
        });
      } finally {
        set({ loading: false });
      }
    },

    create: async (options) => {
      const id = newRunId();
      const env = options.env;
      const envSnapshot = {
        project_name: env.project_name,
        product_id: env.product_id,
        version_id: env.version_id,
        product_name: env.product_name,
        product_version: env.product_version,
        code_directory: env.code_directory,
        package_path: env.package_path,
        patch_output_path: env.patch_output_path,
        local_skill_path: env.local_skill_path,
        local_jdk_path: env.local_jdk_path,
        db_connection: env.db_connection,
        debug_address: env.debug_address,
        record_url: env.record_url,
      };

      let outDir = '';
      if (options.edition === 'novice') {
        const workspace = await api.nodeRuns.workspace(id);
        outDir = String((workspace as unknown as { path?: string }).path || (workspace as unknown as { data?: { path?: string } }).data?.path || '');
        if (!outDir) throw new Error('创建运行工作目录失败');
      } else {
        // 表单没填就回落到产品环境变量；两者都没有才提示。
        const patchOutput =
          options.patch_output_path?.trim() || String(env.patch_output_path || '').trim();
        if (!patchOutput) {
          throw new Error('当前产品环境变量中未填写补丁输出路径，请在此处填写');
        }
        outDir = joinPath(patchOutput, id);
      }

      const stepDir = joinPath(outDir, 'step01');
      const stageDir = joinPath(stepDir, 'work');
      const now = new Date().toISOString();
      const run: LocalNodeRun = {
        id,
        edition: options.edition,
        mode: options.edition === 'novice' ? 'investigate' : undefined,
        problem_desc: options.problem_desc.trim(),
        trigger_url: options.trigger_url?.trim(),
        env_id: env.id,
        env_snapshot: envSnapshot,
        patch_output_path: outDir,
        out_dir: outDir,
        step_dir: stepDir,
        turn_dir: stepDir,
        stage_dir: stageDir,
        phase1_step: 1,
        stage: 1,
        phase: 'analyzing',
        retry_count: 0,
        log_info_inline: (options.log_text || '').slice(0, 8192),
        log_file_name: (options.log_file_name || '').trim().replace(/\.(log|txt)$/i, ''),
        need_debug_log: options.need_debug_log !== false,
        need_diff_report: options.need_diff_report !== false,
        client_host: get().host,
        user_id: options.user_id,
        reported: false,
        created_at: now,
        updated_at: now,
      };

      set((state) => ({ runs: [run, ...state.runs] }));
      await api.nodeRuns.put(id, run as unknown as import('../lib/types').NodeRun);
      // 提前建好本步的产物目录，聊天页「打开产物所在位置」不会指向一个不存在的文件夹。
      await api.nodeRuns.ensureDir(id, stepDir).catch(() => {});

      try {
        // 问题附件 / 日志附件先保存到 temp/node/<runId>/images，再把绝对路径写进提示词
        const uploadFiles = async (files: File[] | undefined, label: string) => {
          const paths: string[] = [];
          for (const file of files || []) {
            const form = new FormData();
            form.append('file', file, file.name || 'attachment');
            const result = await api.nodeProblemImage(id, form, file.name);
            if (!result.success) {
              throw new Error(`${label}上传失败：${result.error || ''}`);
            }
            if (result.path) paths.push(result.path);
          }
          return paths;
        };
        const problemPaths = await uploadFiles(options.problem_files, '问题附件');
        const logPaths = await uploadFiles(options.log_files, '日志附件');
        if (problemPaths.length || logPaths.length) {
          const withFiles = update(id, { image_paths: problemPaths, log_paths: logPaths });
          await persist(withFiles);
        }

        const created = await api.agent.create({ cwd: env.code_directory || outDir, assistant: 'claude' });
        if (!created.success || !created.sessionId) {
          throw new Error(created.error || '创建 Claude 会话失败');
        }
        const withSession = update(id, { session_id: created.sessionId });
        await persist(withSession);
        let prompt = await resolvePrompt(withSession || run, 'phase1');
        const attachmentLines = [...problemPaths, ...logPaths];
        if (attachmentLines.length) {
          prompt +=
            '\n\n【附件】用户上传了以下文件，请先用 Read 工具查看（图片可看图，其他文件读取内容）：\n' +
            attachmentLines.map((path) => `- ${path}`).join('\n');
        }
        await startPrompt(withSession || run, prompt);
        return withSession || run;
      } catch (error) {
        const failed = update(id, {
          phase: 'failed',
          failure: error instanceof Error ? error.message : String(error),
        });
        await persist(failed);
        throw error;
      }
    },

    registerExternal: async (run) => {
      set((state) => ({
        runs: [run, ...state.runs.filter((item) => item.id !== run.id)],
      }));
      await api.nodeRuns.put(run.id, run as unknown as import('../lib/types').NodeRun);
      if (run.step_dir) {
        await api.nodeRuns.ensureDir(run.id, run.step_dir).catch(() => {});
      }
      // 上报 problem_run（client_edition=novice），实施版的使用统计靠这条记录。
      report(run);
      if (!run.session_id) return;

      // NewTaskDialog 的提示词由聊天页发送，这里只监听执行流，结束时把状态/结论落回。
      const existing = activeStreams.get(run.id);
      if (existing) {
        existing();
        activeStreams.delete(run.id);
      }
      set((state) => ({ streaming: { ...state.streaming, [run.id]: true } }));
      const close = openSessionStream(run.session_id, {
        onEvent: (event) => {
          if (event.type === 'start') {
            const sid =
              typeof event.agentSessionId === 'string' ? event.agentSessionId : undefined;
            if (sid) {
              const next = update(run.id, { agent_session_id: sid });
              void persist(next);
            }
          } else if (event.type === 'stream_end') {
            void finish(run.id, null);
          } else if (event.type === 'error') {
            void finish(run.id, typeof event.message === 'string' ? event.message : '执行出错');
          }
        },
        // 断线由聊天页自己的流负责，这里不误判失败。
        onError: () => {},
      });
      activeStreams.set(run.id, close);
    },

    save: async (run) => {
      await persist(run);
    },

    solve: async (id) => {
      const run = get().runs.find((item) => item.id === id);
      if (!run) return;
      const resultDir = joinPath(String(run.out_dir || ''), 'result');
      const next = update(id, {
        phase: 'merging',
        stage: 2,
        turn_dir: resultDir,
        stage_dir: resultDir,
        artifacts: [],
        report: '',
        // 列表里直接点「已解决」没有开关表单：沿用阶段一的选择（与聊天页合并表单的默认值一致）。
        merge_strip_log: run.need_debug_log !== false,
        merge_diff_report: run.need_diff_report !== false,
      });
      await persist(next);
      if (!next) return;
      await api.nodeRuns.ensureDir(id, resultDir).catch(() => {});
      const changes = await readText(joinPath(String(run.step_dir || ''), 'changes.txt'));
      const prompt = await resolvePrompt(next, 'phase2', {
        changes: changes.slice(0, 20000),
      });
      await startPrompt(next, prompt);
    },

    mergeToSession: async (id, options) => {
      const run = get().runs.find((item) => item.id === id);
      if (!run) throw new Error('未找到本次开发任务');
      if (!run.session_id) throw new Error('该任务还没有会话，无法合并');
      const sessionForMerge = run.session_id;
      const resultDir = joinPath(String(run.out_dir || ''), 'result');
      const next = update(id, {
        phase: 'merging',
        stage: 2,
        turn_dir: resultDir,
        stage_dir: resultDir,
        artifacts: [],
        report: '',
        merge_strip_log: options.stripLog !== false,
        merge_diff_report: options.diffReport !== false,
      });
      await persist(next);
      if (!next) return;
      await api.nodeRuns.ensureDir(id, resultDir).catch(() => {});
      const changes = await readText(joinPath(String(run.step_dir || ''), 'changes.txt'));
      const prompt = await resolvePrompt(next, 'phase2', {
        changes: changes.slice(0, 20000),
      });

      // 提示词由聊天页的普通发送流程发出（这样用户消息和流式输出会出现在聊天记录里）；
      // 这里只额外挂一个执行流监听，用来在结束时把 run 的状态/结论落回来。
      const existing = activeStreams.get(id);
      if (existing) {
        existing();
        activeStreams.delete(id);
      }
      set((state) => ({ streaming: { ...state.streaming, [id]: true } }));
      const close = openSessionStream(sessionForMerge, {
        onEvent: (event) => {
          if (event.type === 'stream_end') {
            void finish(id, null);
          } else if (event.type === 'error') {
            void finish(id, typeof event.message === 'string' ? event.message : '执行出错');
          }
        },
        // 真正的连接状态由聊天页自己的流负责，这里断线不误判为失败。
        onError: () => {},
      });
      activeStreams.set(id, close);

      try {
        await useChatStore.getState().sendMessage(prompt, sessionForMerge);
      } catch (error) {
        close();
        activeStreams.delete(id);
        void finish(id, error instanceof Error ? error.message : '发送阶段二提示词失败');
        throw error;
      }
    },

    unsolve: async (id, extra) => {
      const run = get().runs.find((item) => item.id === id);
      if (!run) return;
      const stepNumber = (run.phase1_step || 1) + 1;
      const padded = String(stepNumber).padStart(2, '0');
      const stepDir = joinPath(String(run.out_dir || ''), `step${padded}`);
      const next = update(id, {
        phase: 'analyzing',
        stage: 1,
        phase1_step: stepNumber,
        step_dir: stepDir,
        turn_dir: stepDir,
        stage_dir: joinPath(stepDir, 'work'),
        retry_count: (run.retry_count || 0) + 1,
        verdict: undefined,
        failure: undefined,
        report: '',
        artifacts: [],
        log_info_inline: (extra.log_text || '').slice(0, 8192),
      });
      await persist(next);
      if (!next) return;
      await api.nodeRuns.ensureDir(id, stepDir).catch(() => {});
      const prompt = await resolvePrompt(next, 'retry', {
        note: extra.note || '',
        log_text: extra.log_text || '',
      });
      await startPrompt(next, prompt);
    },

    rerun: async (id) => {
      const run = get().runs.find((item) => item.id === id);
      if (!run) return;
      const next = update(id, {
        phase: (run.stage || 1) >= 2 ? 'merging' : 'analyzing',
        failure: undefined,
        verdict: undefined,
        retry_count: (run.retry_count || 0) + 1,
      });
      await persist(next);
      if (next) await startPrompt(next, '继续');
    },

    abort: async (id) => {
      const run = get().runs.find((item) => item.id === id);
      if (!run) return;
      const closer = activeStreams.get(id);
      if (closer) {
        closer();
        activeStreams.delete(id);
      }
      set((state) => ({ streaming: { ...state.streaming, [id]: false } }));
      if (run.session_id) {
        await api.agent.abort(run.session_id).catch(() => {});
      }
      const next = update(id, { phase: 'failed', failure: '已由用户中断' });
      await persist(next);
      if (next) report(next);
    },

    remove: async (id) => {
      const closer = activeStreams.get(id);
      if (closer) {
        closer();
        activeStreams.delete(id);
      }
      await api.nodeRuns.remove(id).catch(() => {});
      set((state) => ({ runs: state.runs.filter((run) => run.id !== id) }));
    },
  };
});
