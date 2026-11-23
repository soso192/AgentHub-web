import { api, openSessionStream } from './api';
import { patchApi } from './patch';
import { firstChars, joinPath } from './utils';
import { useChatStore } from '../store/chat';
import { useWorkflowSessionStore } from '../store/workflowSessions';

export interface WorkflowStep {
  step_order: number;
  flow_code?: string;
  flow_name?: string;
  status?: string;
  claude_target?: string;
  target?: string;
  local_ccweb_session_id?: string;
  local_session_id?: string;
  server_session_id?: string;
  output_summary?: string;
  output_conclusion?: string;
  output_result?: string;
  output_context?: string;
  error_message?: string;
  local_output_dir?: string | null;
  resolved_directory?: string | null;
  started_at?: string;
  finished_at?: string;
  [key: string]: unknown;
}

export interface WorkflowSnapshot {
  id?: string | number;
  steps?: WorkflowStep[];
  status?: string;
  current_step?: number;
  can_confirm?: boolean;
  result?: string;
  error_message?: string;
  template_name?: string;
  template_id?: string | number;
  created_at?: string;
  updated_at?: string;
  business_input?: string;
  last_event_id?: number;
  local_waiting?: { step_order: number };
  [key: string]: unknown;
}

export interface WorkflowLocalCallbacks {
  /** 本地会话已经建好/复用并开始发送提示词，页面可以跳到该会话。 */
  onSessionReady?: (sessionId: string, step: number) => void;
  /** 本步骤已回传结果（成功/失败），仍挂载的流程页可以刷新快照。 */
  onFinished?: (step: number) => void;
  /** 认领/建目录/建会话等启动阶段失败。 */
  onError?: (message: string) => void;
}

interface ActiveLocal {
  runId: string;
  step: number;
  sessionId?: string;
  close: (() => void) | null;
  cancelled: boolean;
}

// 工作流本地步骤的执行器放在模块级，而不是页面组件里：
// 自动跳到聊天页后 WorkflowRunPage 会卸载，如果 SSE 收尾仍绑在组件上，
// 步骤会永远停在「执行中」，结论/摘要也回传不到 patch_search。
const active = new Map<string, ActiveLocal>();

function keyOf(runId: string, step: number): string {
  return `${runId}:${step}`;
}

function activeKeyForRun(runId: string): string | null {
  for (const [key, value] of active) {
    if (value.runId === runId) return key;
  }
  return null;
}

/** 结束流程/重新执行时关闭当前 run 的本地执行流，不再回传结果。 */
export function cancelWorkflowLocal(runId: string): void {
  for (const [key, value] of active) {
    if (value.runId !== runId) continue;
    value.cancelled = true;
    value.close?.();
    // 仅关 SSE 不会停 ClaudeCode 进程：显式 abort 该 cc-web 会话，
    // 否则“结束流程”后本地会话仍会继续跑完。
    // 这里直接调 API，不走 chat store 的 abort（那条路径会继续发送排队消息）。
    if (value.sessionId) {
      void api.agent.abort(value.sessionId).catch(() => {});
      void useChatStore.getState().refreshSessions().catch(() => {});
    }
    active.delete(key);
  }
}

/**
 * 认领并执行一个 workflow 本地步骤。
 *
 * 调用方可重复调用（初次加载 + 3 秒轮询）；同一 run/step 只会执行一次。
 * 启动成功后立即返回，后续 SSE 收尾在模块级继续执行，不受页面卸载影响。
 */
export async function runWorkflowLocal(
  runId: string,
  data: WorkflowSnapshot,
  callbacks: WorkflowLocalCallbacks = {}
): Promise<void> {
  const waiting = Number(data.local_waiting?.step_order || 0);
  if (!waiting) return;

  const key = keyOf(runId, waiting);
  if (active.has(key) || activeKeyForRun(runId)) return;

  let claim: Awaited<ReturnType<typeof patchApi.claimLocal>>;
  try {
    claim = await patchApi.claimLocal(runId, waiting);
  } catch {
    // 网络抖动：下一轮轮询会重试，不在这里报错。
    return;
  }
  if (!claim.claimed || !claim.pending_local) return;

  const pending = claim.pending_local;
  const holder: ActiveLocal = { runId, step: waiting, close: null, cancelled: false };
  active.set(key, holder);

  const release = async () => {
    active.delete(key);
    await patchApi.releaseLocal(runId, waiting).catch(() => {});
  };

  let workDir = pending.cwd || '';
  let artifactDir = pending.output_dir || workDir;
  let isTemp = false;

  try {
    if (pending.cwd_mode === 'temp') {
      const prepared = await api.workflowTemp(runId, waiting).catch((error) => ({
        success: false,
        path: '',
        error: error instanceof Error ? error.message : '创建临时工作目录失败',
      }));
      if (!prepared.success || !prepared.path) {
        await release();
        callbacks.onError?.(prepared.error || '创建临时工作目录失败');
        return;
      }
      workDir = prepared.path;
      artifactDir = prepared.path;
      isTemp = true;
    } else if (pending.cwd_mode === 'reuse') {
      // 复用步骤的产物目录由服务端下发；失败不阻塞，Claude 写文件时会自行创建。
      await api.workflowTemp(runId, waiting).catch(() => null);
    }

    // 建目录/建会话期间用户可能已点“结束流程”：此时 active 已被移除，
    // 但 holder 还在继续往下走，必须在这里主动退出，避免又建出会话继续跑。
    if (holder.cancelled) {
      await release();
      return;
    }

    const continueSessionId = (pending.continue_session_id || '').trim();
    let sessionId = continueSessionId;
    if (!sessionId) {
      if (!workDir) {
        await release();
        callbacks.onError?.('本步骤没有可用的工作目录');
        return;
      }
      const session = await api.agent.create({ cwd: workDir, assistant: 'claude' });
      if (!session.success || !session.sessionId) {
        await release();
        callbacks.onError?.(session.error || '创建本地会话失败');
        return;
      }
      sessionId = session.sessionId;
      // 智能分析的会话名取表单「业务需求 / 问题」的前 10 个字。
      const name = firstChars(String(data.business_input || ''), 10) || '智能分析';
      await api.sessions.rename(sessionId, name).catch(() => {});
      void useChatStore.getState().refreshSessions().catch(() => {});
    }
    // 结束流程时据此 abort 对应的本地 ClaudeCode 会话。
    holder.sessionId = sessionId;

    if (holder.cancelled) {
      void api.agent.abort(sessionId).catch(() => {});
      await release();
      return;
    }

    if (!artifactDir) {
      await release();
      callbacks.onError?.('本步骤没有可用的产物目录');
      return;
    }

    await patchApi.sessionCcweb(runId, waiting, pending.execution_token, sessionId).catch(() => {});

    // 聊天页据此显示「打开产物所在位置」；复用会话的步骤会覆盖成当前 step 的目录。
    useWorkflowSessionStore.getState().setArtifact(sessionId, {
      dir: artifactDir,
      runId,
      step: waiting,
      display_prompt: String(data.business_input || '').trim(),
    });

    if (holder.cancelled) {
      void api.agent.abort(sessionId).catch(() => {});
      await release();
      return;
    }

    let text = '';
    let promptSent = false;
    let settled = false;

    const finish = async (error: string | null) => {
      if (settled) return;
      settled = true;
      holder.close?.();
      // 用户主动结束/重新执行时不再写回结果，避免把已取消的步骤重新收尾。
      if (holder.cancelled) {
        active.delete(key);
        return;
      }

      try {
        const conclusion = await api.files
          .read(joinPath(artifactDir, '结论.md'))
          .then((result) => (result.success ? result.content : ''))
          .catch(() => '');
        const summary = await api.files
          .read(joinPath(artifactDir, '摘要.md'))
          .then((result) => (result.success ? result.content : ''))
          .catch(() => '');
        await patchApi.localResult(runId, waiting, {
          execution_token: pending.execution_token,
          text,
          error,
          session_id: null,
          ccweb_session_id: sessionId,
          conclusion,
          summary,
          // 只有 local_temp 的 cwd 是客户端自己创建的，需要回写真实临时目录；
          // 复用会话/固定目录步骤的 resolved_directory 是客开工程，保留不动。
          ...(isTemp ? { cwd: artifactDir, output_dir: artifactDir } : {}),
        });
      } catch {
        /* 回传失败时保留会话产物；流程页刷新后可人工重试 */
      } finally {
        active.delete(key);
        callbacks.onFinished?.(waiting);
      }
    };

    holder.close = openSessionStream(sessionId, {
      onEvent: (event) => {
        if (event.type === 'connected' && !promptSent) {
          if (holder.cancelled) return;
          promptSent = true;
          void api.agent
            .start(sessionId, pending.prompt, String(data.business_input || '').trim())
            .then((result) => {
              if (result && result.success === false) {
                void finish(result.error || '启动失败');
                return;
              }
              // 提示词已被接受后再跳到会话，用户一进来就能看到实时输出。
              callbacks.onSessionReady?.(sessionId, waiting);
            })
            .catch((error) => {
              void finish(error instanceof Error ? error.message : '启动失败');
            });
        } else if (event.type === 'chunk' && typeof event.content === 'string') {
          text += event.content;
        } else if (event.type === 'result') {
          // result 可能只是中途收尾，真正的终态是进程退出后的 stream_end。
          if (typeof event.content === 'string' && event.content) text = event.content;
        } else if (event.type === 'stream_end' || event.type === 'end') {
          void finish(null);
        } else if (event.type === 'error') {
          void finish(typeof event.message === 'string' ? event.message : '执行出错');
        }
      },
      onError: () => {
        if (!promptSent) void finish('无法连接本地执行流');
      },
    });
  } catch (error) {
    await release();
    callbacks.onError?.(error instanceof Error ? error.message : '执行本地步骤失败');
  }
}
