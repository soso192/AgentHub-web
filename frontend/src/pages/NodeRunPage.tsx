import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  MessageSquare,
  RotateCcw,
  Square,
  XCircle,
} from 'lucide-react';
import { AppShell, SidebarToggle } from '../components/layout/AppShell';
import { Explorer } from '../components/files/Explorer';
import { Button, ConfirmDialog, Dialog, Spinner } from '../components/ui';
import { useToast } from '../components/ui/toast';
import { api } from '../lib/api';
import { patchApi } from '../lib/patch';
import { relativeTime } from '../lib/utils';
import { useChatStore } from '../store/chat';
import { useNodeStore, type LocalNodeRun } from '../store/nodeRuns';
import { Markdown } from '../components/Markdown';
import { ResultBox } from '../components/ResultBox';

const PHASE_LABEL: Record<string, string> = {
  analyzing: '执行中',
  merging: '合并中',
  awaiting_decision: '待判定',
  done: '已完成',
  failed: '失败',
};

export function NodeRunPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get('run_id') || '';
  const runs = useNodeStore((state) => state.runs);
  const load = useNodeStore((state) => state.load);
  const solve = useNodeStore((state) => state.solve);
  const unsolve = useNodeStore((state) => state.unsolve);
  const rerun = useNodeStore((state) => state.rerun);
  const abort = useNodeStore((state) => state.abort);
  const streaming = useNodeStore((state) => state.streaming);
  const [archived, setArchived] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [solveOpen, setSolveOpen] = useState(false);
  const [solveChanges, setSolveChanges] = useState('');
  const [unsolvedOpen, setUnsolvedOpen] = useState(false);
  const [unsolvedForm, setUnsolvedForm] = useState({ note: '', log_text: '' });
  const [artifact, setArtifact] = useState<{ name: string; content: string } | null>(null);

  useEffect(() => {
    if (!runId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    load()
      .then(async () => {
        const found = useNodeStore.getState().runs.find((run) => run.id === runId);
        if (!found) {
          try {
            const ledger = await patchApi.problemRun(runId);
            setArchived(ledger as Record<string, unknown>);
          } catch {
            setArchived(null);
          }
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const run = useMemo(() => runs.find((item) => item.id === runId), [runs, runId]);

  const openSolve = async () => {
    if (!run) return;
    try {
      const result = await api.files.read(`${String(run.step_dir || '').replace(/\\/g, '/')}/changes.txt`);
      setSolveChanges(result.success ? result.content : '');
    } catch {
      setSolveChanges('');
    }
    setSolveOpen(true);
  };

  const openArtifact = async (path: string) => {
    try {
      const result = await api.files.read(path);
      setArtifact({
        name: path.split(/[\\/]/).pop() || path,
        content: result.success ? result.content : '无法读取',
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取产物失败');
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-ink-3">
        <Spinner size={16} /> 正在加载运行详情…
      </div>
    );
  }

  if (!run && !archived) {
    return (
      <AppShell
        nav={[
          { key: 'dev', label: '智能开发', icon: <Eye size={15} />, onClick: () => navigate('/?tab=node') },
        ]}
        showSessions={false}
        showFiles={false}
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="text-[14px] font-medium text-ink-2">本机没有这条运行记录</div>
          <div className="text-[12px] text-ink-3">运行 {runId}</div>
          <Button onClick={() => navigate('/?tab=node')}>返回运行列表</Button>
        </div>
      </AppShell>
    );
  }

  const env = ((run?.env_snapshot || {}) as Record<string, unknown>) || {};
  const phase = run ? PHASE_LABEL[run.phase] || run.phase : String(archived?.status || '存档');

  return (
    <AppShell
      nav={[
        {
          key: 'chat',
          label: '聊天',
          icon: <MessageSquare size={15} />,
          onClick: () => navigate('/chat.html'),
        },
        {
          key: 'dev',
          label: '智能开发',
          icon: <Eye size={15} />,
          active: true,
          onClick: () => navigate('/?tab=node'),
        },
      ]}
      showSessions
      showFiles={false}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <SidebarToggle />
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate('/?tab=node')}>
          返回
        </Button>
        <span className="text-[14px] font-semibold text-ink">运行详情</span>
        <span className="badge badge-muted">{phase}</span>
        {streaming[runId] && (
          <span className="badge badge-success">
            <span className="live-dot" /> LIVE
          </span>
        )}
        <div className="flex-1" />
        {run?.session_id && (
          <Button
            size="sm"
            icon={<MessageSquare size={13} />}
            onClick={() => {
              void useChatStore.getState().refreshSessions().catch(() => {});
              navigate(`/chat.html?session=${encodeURIComponent(run.session_id!)}`);
            }}
          >
            查看会话
          </Button>
        )}
      </div>

      <div className="scroll-area min-h-0 flex-1 p-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
          <div className="space-y-3">
            <div className="panel p-4">
              <div className="text-[15px] font-semibold text-ink">
                {String(run?.problem_desc || archived?.problem_desc || '—')}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1.5 text-[11.5px] sm:grid-cols-2">
                {[
                  ['产品', `${env.product_name || archived?.product_name || ''} ${env.product_version || archived?.product_version || ''}`],
                  ['项目', env.project_name || archived?.env_project_name || '—'],
                  ['触发入口', run?.trigger_url || '—'],
                  ['创建时间', relativeTime(run?.created_at || (archived?.started_at as string))],
                  ['更新时间', relativeTime(run?.updated_at || (archived?.finished_at as string))],
                  ['执行机器', run?.client_host || archived?.client_host || '—'],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex gap-1.5">
                    <span className="shrink-0 text-ink-3">{String(label)}：</span>
                    <span className="min-w-0 break-all text-ink-2">{String(value || '—')}</span>
                  </div>
                ))}
              </div>
            </div>

            {run?.failure && (
              <div className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[12.5px] text-danger">
                失败原因：{run.failure}
              </div>
            )}

            {Boolean(run?.report || run?.conclusion || archived?.conclusion) && (
              <div className="panel p-4">
                <div className="mb-2 text-[12.5px] font-medium text-ink-2">结论 / 报告</div>
                <div className="max-h-[50vh] overflow-auto">
                  <Markdown text={String(run?.report || run?.conclusion || archived?.conclusion || '')} />
                </div>
              </div>
            )}

            {run?.log_info_inline && (
              <div className="panel p-4">
                <div className="mb-2 text-[12.5px] font-medium text-ink-2">相关日志</div>
                <ResultBox content={run.log_info_inline} maxHeight="max-h-60" />
              </div>
            )}

            {run?.artifacts?.length ? (
              <div className="panel p-4">
                <div className="mb-2 text-[12.5px] font-medium text-ink-2">产物</div>
                <div className="flex flex-wrap gap-1.5">
                  {run.artifacts.map((path) => (
                    <button
                      key={path}
                      type="button"
                      onClick={() => void openArtifact(path)}
                      className="rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-ink-2 hover:border-accent/40 hover:text-accent"
                      title={path}
                    >
                      {path.split(/[\\/]/).pop()}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {archived && !run && (
              <div className="panel p-4 text-[12.5px] text-ink-3">
                这是服务器上的存档记录，本机没有对应的运行目录与产物。
              </div>
            )}
          </div>

          <div className="space-y-3">
            {run && (
              <div className="panel p-4">
                <div className="mb-2 text-[12.5px] font-medium text-ink-2">决策</div>
                <div className="space-y-2">
                  {(run.phase === 'awaiting_decision' || run.phase === 'failed') && (
                    <>
                      <Button
                        variant="primary"
                        className="w-full"
                        icon={<CheckCircle2 size={14} />}
                        onClick={() => void openSolve()}
                      >
                        问题已解决
                      </Button>
                      <Button
                        className="w-full"
                        icon={<XCircle size={14} />}
                        onClick={() => {
                          setUnsolvedForm({ note: '', log_text: '' });
                          setUnsolvedOpen(true);
                        }}
                      >
                        问题未解决
                      </Button>
                      <Button className="w-full" icon={<RotateCcw size={14} />} onClick={() => void rerun(run.id)}>
                        继续
                      </Button>
                    </>
                  )}
                  {(run.phase === 'analyzing' || run.phase === 'merging') && (
                    <Button variant="danger" className="w-full" icon={<Square size={13} />} onClick={() => void abort(run.id)}>
                      中断执行
                    </Button>
                  )}
                  {run.phase === 'done' && (
                    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink-3">
                      该任务已结束。可以继续追问或查看会话。
                    </div>
                  )}
                </div>
              </div>
            )}

            {run && (
              <div className="panel p-4">
                <Explorer
                  root={String(run.turn_dir || run.out_dir || run.stage_dir || '')}
                  title="运行目录"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={solveOpen}
        onClose={() => setSolveOpen(false)}
        onConfirm={async () => {
          if (!run) return;
          try {
            await solve(run.id);
            setSolveOpen(false);
            toast.success('已进入合并阶段');
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '操作失败');
          }
        }}
        title="确认问题已解决？"
        description={
          <div className="space-y-2">
            <div>将进入阶段二：合并改动并生成补丁。</div>
            {solveChanges && (
              <ResultBox content={solveChanges.slice(0, 2000)} maxHeight="max-h-40" />
            )}
          </div>
        }
        confirmText="开始合并"
      />

      <Dialog
        open={unsolvedOpen}
        onClose={() => setUnsolvedOpen(false)}
        title="问题未解决 · 补充信息"
        width="max-w-xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setUnsolvedOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (!run) return;
                try {
                  await unsolve(run.id, unsolvedForm);
                  setUnsolvedOpen(false);
                  toast.success('已重新开始排查');
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : '操作失败');
                }
              }}
            >
              继续排查
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">补充说明</label>
            <textarea
              value={unsolvedForm.note}
              onChange={(event) => setUnsolvedForm({ ...unsolvedForm, note: event.target.value })}
              rows={3}
              className="input h-auto py-2"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">补充日志</label>
            <textarea
              value={unsolvedForm.log_text}
              onChange={(event) => setUnsolvedForm({ ...unsolvedForm, log_text: event.target.value })}
              rows={5}
              className="input h-auto py-2 font-mono text-[11.5px]"
            />
          </div>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(artifact)}
        onClose={() => setArtifact(null)}
        title={artifact?.name || '产物'}
        width="max-w-4xl"
        footer={
          <Button variant="ghost" onClick={() => setArtifact(null)}>
            关闭
          </Button>
        }
      >
        <ResultBox content={artifact?.content || '（空）'} maxHeight="max-h-[65vh]" />
      </Dialog>
    </AppShell>
  );
}
