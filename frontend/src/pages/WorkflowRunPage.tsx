import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileText,
  MessageSquare,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';
import { AppShell, SidebarToggle } from '../components/layout/AppShell';
import { Button, Dialog, Spinner } from '../components/ui';
import { useToast } from '../components/ui/toast';
import { api, openSessionStream } from '../lib/api';
import {
  downloadWorkflowArtifact,
  patchApi,
  saveBlob,
} from '../lib/patch';
import { relativeTime, truncate } from '../lib/utils';
import { Markdown } from '../components/Markdown';
import { ResultBox } from '../components/ResultBox';

interface WorkflowStep {
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
  started_at?: string;
  finished_at?: string;
  [key: string]: unknown;
}

interface WorkflowSnapshot {
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

const STATUS_LABEL: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  waiting_confirmation: '待确认',
  success: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function statusTone(status?: string): string {
  if (status === 'success') return 'badge-success';
  if (status === 'failed') return 'badge-danger';
  if (status === 'cancelled') return 'badge-muted';
  if (status === 'running' || status === 'waiting_confirmation') return 'badge-warning';
  return 'badge-muted';
}

function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

export function WorkflowRunPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get('run_id') || '';
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [outputOpen, setOutputOpen] = useState<{ title: string; content: string } | null>(null);
  const [artifacts, setArtifacts] = useState<{
    step: number;
    items: Array<{ name: string; [key: string]: unknown }>;
  } | null>(null);
  const [artifactsBusy, setArtifactsBusy] = useState(false);
  const activeLocal = useRef<{ step: number; close: (() => void) | null } | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const data = (await patchApi.workflowRun(runId)) as WorkflowSnapshot;
      setSnapshot(data);
      return data;
    } catch (error) {
      throw error;
    } finally {
      setLoading(false);
    }
  }, [runId]);

  const executeLocal = useCallback(
    async (data: WorkflowSnapshot) => {
      const waiting = data.local_waiting?.step_order;
      if (!waiting || activeLocal.current?.step === waiting) return;
      if (activeLocal.current) return;
      try {
        const claim = await patchApi.claimLocal(runId, waiting);
        if (!claim.claimed || !claim.pending_local) return;
        const pending = claim.pending_local;
        const holder = { step: waiting, close: null as (() => void) | null };
        activeLocal.current = holder;

        const session = await api.agent.create({ cwd: pending.cwd, assistant: 'claude' });
        if (!session.success || !session.sessionId) {
          await patchApi.releaseLocal(runId, waiting).catch(() => {});
          activeLocal.current = null;
          toast.error(session.error || '创建本地会话失败');
          return;
        }
        await patchApi
          .sessionCcweb(runId, waiting, pending.execution_token, session.sessionId)
          .catch(() => {});
        await load().catch(() => {});

        let text = '';
        let promptSent = false;
        let settled = false;
        const finish = async (error: string | null) => {
          if (settled) return;
          settled = true;
          holder.close?.();
          activeLocal.current = null;
          try {
            const outputDir = pending.output_dir || pending.cwd;
            const conclusion = await api.files
              .read(joinPath(outputDir, '结论.md'))
              .then((result) => (result.success ? result.content : ''))
              .catch(() => '');
            const summary = await api.files
              .read(joinPath(outputDir, '摘要.md'))
              .then((result) => (result.success ? result.content : ''))
              .catch(() => '');
            await patchApi.localResult(runId, waiting, {
              execution_token: pending.execution_token,
              text,
              error,
              session_id: null,
              ccweb_session_id: session.sessionId,
              conclusion,
              summary,
            });
          } catch {
            /* ignore */
          }
          await load().catch(() => {});
        };

        holder.close = openSessionStream(session.sessionId, {
          onEvent: (event) => {
            if (event.type === 'connected' && !promptSent) {
              promptSent = true;
              api.agent.start(session.sessionId!, pending.prompt).then((result) => {
                if ((result as { success?: boolean }).success === false) {
                  void finish((result as { error?: string }).error || '启动失败');
                }
              });
            } else if (event.type === 'chunk' && typeof event.content === 'string') {
              text += event.content;
            } else if (event.type === 'result') {
              if (typeof event.content === 'string' && event.content) text = event.content;
              void finish(null);
            } else if (event.type === 'error') {
              void finish(typeof event.message === 'string' ? event.message : '执行出错');
            }
          },
          onError: () => {
            if (!promptSent) void finish('无法连接本地执行流');
          },
        });
      } catch {
        activeLocal.current = null;
      }
    },
    [load, runId, toast]
  );

  useEffect(() => {
    if (!runId) {
      setLoading(false);
      return;
    }
    load()
      .then((data) => data && void executeLocal(data))
      .catch((error) => toast.error(error instanceof Error ? error.message : '加载流程失败'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    return () => {
      activeLocal.current?.close?.();
      activeLocal.current = null;
    };
  }, []);

  const terminal = snapshot && ['success', 'failed', 'cancelled'].includes(String(snapshot.status));

  useEffect(() => {
    if (!runId || terminal) return;
    const timer = window.setInterval(() => {
      load()
        .then((data) => data && void executeLocal(data))
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [runId, terminal, load, executeLocal]);

  const doNext = async () => {
    if (!snapshot) return;
    setBusy('next');
    try {
      await patchApi.workflowNext(runId, Number(snapshot.current_step || 1));
      await load();
      toast.success('已确认，流程继续');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  const doCancel = async () => {
    setBusy('cancel');
    try {
      await patchApi.workflowCancel(runId);
      activeLocal.current?.close?.();
      await load();
      toast.success('流程已结束');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消失败');
    } finally {
      setBusy('');
    }
  };

  const doRerun = async () => {
    setBusy('rerun');
    try {
      await patchApi.workflowRerun(runId, 1);
      await load();
      toast.success('流程已重新执行');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重新执行失败');
    } finally {
      setBusy('');
    }
  };

  const viewResult = async (step: WorkflowStep, mode: 'result' | 'summary') => {
    try {
      const result = await patchApi.workflowStepResult(runId, step.step_order);
      const content =
        mode === 'summary'
          ? result.output_summary || ''
          : result.output_conclusion || result.output_result || result.output_context || '';
      setOutputOpen({
        title: `${step.flow_name || `步骤 ${step.step_order}`} · ${
          mode === 'summary' ? '摘要' : '结果'
        }`,
        content: content || '（暂无输出）',
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取结果失败');
    }
  };

  const viewSession = (step: WorkflowStep) => {
    if (step.local_ccweb_session_id) {
      window.open(`/chat.html?session=${encodeURIComponent(step.local_ccweb_session_id)}`, '_blank');
    } else if (step.local_session_id) {
      window.open(`/chat.html?history=${encodeURIComponent(step.local_session_id)}`, '_blank');
    } else if (step.server_session_id) {
      navigate(
        `/server_replay.html?history=${encodeURIComponent(step.server_session_id)}&run=${encodeURIComponent(
          runId
        )}&step=${step.step_order}`
      );
    } else {
      toast.info('该步骤还没有可查看的会话');
    }
  };

  const openArtifacts = async (step: WorkflowStep) => {
    setArtifactsBusy(true);
    try {
      const result = await patchApi.workflowArtifacts(runId, step.step_order);
      setArtifacts({ step: step.step_order, items: result.items || [] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取产物失败');
    } finally {
      setArtifactsBusy(false);
    }
  };

  const steps = snapshot?.steps || [];
  const currentStep =
    steps.find((step) => step.step_order === snapshot?.current_step) ||
    steps.find((step) => step.status === 'running') ||
    steps[steps.length - 1];
  const output =
    currentStep?.output_summary ||
    currentStep?.output_conclusion ||
    currentStep?.output_result ||
    String(snapshot?.result || '') ||
    '当前流程暂无输出。';

  return (
    <AppShell
      nav={[
        {
          key: 'dev',
          label: '智能开发',
          icon: <Play size={15} />,
          active: true,
          onClick: () => navigate('/?tab=smart'),
        },
      ]}
      showSessions
      showFiles={false}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <SidebarToggle />
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate('/?tab=smart')}>
          返回
        </Button>
        <span className="text-[14px] font-semibold text-ink">流程运行详情</span>
        {snapshot && <span className={`badge ${statusTone(snapshot.status)}`}>{STATUS_LABEL[String(snapshot.status)] || snapshot.status}</span>}
        <span className="max-w-[220px] truncate font-mono text-[10.5px] text-ink-3" title={runId}>
          {runId}
        </span>
        <div className="flex-1" />
        {snapshot && !terminal && (
          <>
            <Button
              size="sm"
              variant="primary"
              icon={<CheckCircle2 size={13} />}
              disabled={!snapshot.can_confirm}
              loading={busy === 'next'}
              onClick={doNext}
            >
              确认下一步
            </Button>
            <Button size="sm" variant="danger" icon={<Square size={12} />} loading={busy === 'cancel'} onClick={doCancel}>
              结束流程
            </Button>
          </>
        )}
        {snapshot && terminal && (
          <Button size="sm" icon={<RotateCcw size={13} />} loading={busy === 'rerun'} onClick={doRerun}>
            重新执行
          </Button>
        )}
      </div>

      <div className="scroll-area min-h-0 flex-1 p-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-ink-3">
            <Spinner size={16} /> 正在加载流程…
          </div>
        ) : snapshot ? (
          <div className="mx-auto max-w-5xl space-y-3">
            <div className="panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold text-ink">
                  {String(snapshot.template_name || '流程运行')}
                </span>
                <span className={`badge ${statusTone(snapshot.status)}`}>
                  {STATUS_LABEL[String(snapshot.status)] || snapshot.status}
                </span>
                <span className="text-[11.5px] text-ink-3">
                  当前 {snapshot.current_step ?? '—'} / {steps.length} 步 · 更新于{' '}
                  {relativeTime(snapshot.updated_at)}
                </span>
              </div>
              {snapshot.business_input && (
                <div className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12px] leading-6 text-ink-2">
                  {snapshot.business_input}
                </div>
              )}
              {snapshot.error_message && (
                <div className="mt-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12px] text-danger">
                  {snapshot.error_message}
                </div>
              )}
            </div>

            <div className="space-y-2">
              {steps.map((step) => {
                const target = step.claude_target || step.target || '';
                return (
                  <div key={step.step_order} className="panel p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-3 text-[11px] font-medium text-ink-3">
                        {step.step_order}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                        {step.flow_name || step.flow_code || `步骤 ${step.step_order}`}
                      </span>
                      {target && <span className="badge badge-muted">{target === 'local' ? '本机' : '服务器'}</span>}
                      <span className={`badge ${statusTone(step.status)}`}>
                        {STATUS_LABEL[String(step.status)] || step.status || '—'}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<MessageSquare size={12} />}
                        onClick={() => viewSession(step)}
                      >
                        会话
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<FileText size={12} />}
                        onClick={() => void viewResult(step, 'result')}
                      >
                        结果
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<FileText size={12} />}
                        onClick={() => void viewResult(step, 'summary')}
                      >
                        摘要
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Download size={12} />}
                        loading={artifactsBusy}
                        onClick={() => void openArtifacts(step)}
                      >
                        产物
                      </Button>
                    </div>
                    {step.output_summary && (
                      <div className="mt-1.5 line-clamp-2 whitespace-pre-wrap text-[11.5px] leading-5 text-ink-3">
                        {truncate(step.output_summary, 240)}
                      </div>
                    )}
                    {step.error_message && (
                      <div className="mt-1.5 rounded-md bg-danger-soft px-2 py-1 text-[11px] text-danger">
                        {step.error_message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="panel p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12.5px] font-medium text-ink-2">当前输出</span>
              </div>
              <ResultBox content={output} maxHeight="max-h-[40vh]" />
            </div>
          </div>
        ) : (
          <div className="py-16 text-center text-[12.5px] text-ink-3">流程不存在或无权访问</div>
        )}
      </div>

      <Dialog
        open={Boolean(outputOpen)}
        onClose={() => setOutputOpen(null)}
        title={outputOpen?.title || '输出'}
        width="max-w-4xl"
        footer={
          <Button variant="ghost" onClick={() => setOutputOpen(null)}>
            关闭
          </Button>
        }
      >
        <div className="max-h-[65vh] overflow-auto">
          <Markdown text={outputOpen?.content || '（空）'} />
        </div>
      </Dialog>

      <Dialog
        open={Boolean(artifacts)}
        onClose={() => setArtifacts(null)}
        title={`步骤 ${artifacts?.step ?? ''} 产物`}
        width="max-w-lg"
        footer={
          <Button variant="ghost" onClick={() => setArtifacts(null)}>
            关闭
          </Button>
        }
      >
        {artifacts?.items.length ? (
          <div className="space-y-1.5">
            {artifacts.items.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={async () => {
                  if (!artifacts) return;
                  try {
                    const { blob, filename } = await downloadWorkflowArtifact(
                      runId,
                      artifacts.step,
                      item.name
                    );
                    saveBlob(blob, filename);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : '下载失败');
                  }
                }}
                className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-[12px] text-ink-2 hover:border-accent/40 hover:text-accent"
              >
                <Download size={13} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-[12px] text-ink-3">该步骤暂无产物</div>
        )}
      </Dialog>
    </AppShell>
  );
}
