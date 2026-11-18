import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileText,
  FolderOpen,
  MessageSquare,
  MessagesSquare,
  RotateCcw,
  Search,
  Square,
  Wand2,
} from 'lucide-react';
import { AppShell, SidebarToggle, type NavItem } from '../components/layout/AppShell';
import { Button, Dialog, Spinner } from '../components/ui';
import { useToast } from '../components/ui/toast';
import { api, hasAuthSession } from '../lib/api';
import {
  buildDevTabs,
  readCachedCodeSearchUrl,
  rememberCodeSearchUrl,
} from '../lib/devTabs';
import {
  downloadWorkflowArtifact,
  patchApi,
  saveBlob,
} from '../lib/patch';
import { relativeTime, truncate } from '../lib/utils';
import {
  cancelWorkflowLocal,
  runWorkflowLocal,
  type WorkflowSnapshot,
  type WorkflowStep,
} from '../lib/workflowLocal';
import { useAppStore } from '../store/app';
import { useAuthStore } from '../store/auth';
import { useChatStore } from '../store/chat';
import { useWorkflowSessionStore } from '../store/workflowSessions';
import { Markdown } from '../components/Markdown';
import { ResultBox } from '../components/ResultBox';

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
    dir?: string;
    items: Array<{ name: string; local_path?: string; [key: string]: unknown }>;
  } | null>(null);
  const [artifactsBusy, setArtifactsBusy] = useState(false);
  const mountedRef = useRef(true);

  // 工作台菜单与聊天页/补丁中心共用同一份配置，避免直接打开流程详情时左侧只剩「智能开发」。
  const edition = useAppStore((state) => state.edition);
  const authUser = useAuthStore((state) => state.user);
  const restoreAuth = useAuthStore((state) => state.restore);
  const loggedIn = Boolean(authUser) || hasAuthSession();
  const admin = /admin|super/i.test(String(authUser?.role || ''));
  const menus = Array.isArray(authUser?.menus) ? authUser!.menus : null;
  // 先用上次缓存渲染，配置回来后再校准：避免「源码搜索」菜单项刷新时先隐藏再出现。
  const [codeSearchUrl, setCodeSearchUrl] = useState<string | null>(() =>
    readCachedCodeSearchUrl()
  );

  useEffect(() => {
    api
      .patchConfig()
      .then((config) => {
        const url = config.code_search_url || '';
        rememberCodeSearchUrl(url);
        setCodeSearchUrl(url);
      })
      .catch(() => {});
  }, []);

  // 直接打开详情页时补齐登录用户信息，菜单权限才与补丁中心一致。
  useEffect(() => {
    if (hasAuthSession() && !authUser) restoreAuth().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser]);

  const nav: NavItem[] =
    edition === 'novice'
      ? [
          {
            key: 'patch',
            label: '补丁检索',
            icon: <Search size={15} />,
            onClick: () => {
              if (!loggedIn) {
                navigate(`/login?next=${encodeURIComponent('/?view=patch')}`);
                return;
              }
              navigate('/?view=patch');
            },
          },
          {
            key: 'chat',
            label: '智能开发',
            icon: <MessagesSquare size={15} />,
            active: true,
            onClick: () => navigate('/'),
          },
        ]
      : loggedIn
        ? buildDevTabs({ edition, admin, menus, codeSearchUrl })
            .filter((tab) => tab.visible)
            .map((tab) => ({
              key: tab.key,
              label: tab.label,
              icon: tab.icon,
              active: tab.key === 'smart',
              onClick: () => navigate(`/?tab=${tab.key}`),
            }))
        : [
            {
              key: 'dev',
              label: '智能开发',
              icon: <Wand2 size={15} />,
              onClick: () => navigate('/'),
            },
          ];

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

  // 本地步骤的执行器在 lib/workflowLocal 模块级运行：
  // 自动跳到聊天页后本页面会卸载，SSE 收尾仍要继续，不能绑在组件生命周期上。
  const executeLocal = useCallback(
    async (data: WorkflowSnapshot) => {
      await runWorkflowLocal(runId, data, {
        onSessionReady: (sessionId) => {
          if (!mountedRef.current) return;
          void useChatStore.getState().refreshSessions().catch(() => {});
          const edition = useAppStore.getState().edition;
          if (edition === 'novice') {
            // 实施版没有 ChatPage 的 ?session= 解析，直接选中会话再回聊天页。
            useChatStore.getState().selectSession(sessionId);
            navigate('/chat.html');
            return;
          }
          navigate(`/chat.html?session=${encodeURIComponent(sessionId)}`);
        },
        onFinished: () => {
          if (mountedRef.current) void load().catch(() => {});
        },
        onError: (message) => {
          if (mountedRef.current) toast.error(message);
        },
      });
    },
    [load, navigate, runId, toast]
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
    mountedRef.current = true;
    return () => {
      // 只标记卸载，不关闭本地执行流：自动跳聊天页后步骤还要继续收尾。
      mountedRef.current = false;
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
      const data = await load();
      if (data) void executeLocal(data);
      toast.success('已确认，流程继续');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  const doCancel = async () => {
    setBusy('cancel');
    // 先停本地 ClaudeCode（关闭 SSE + 杀掉会话进程），再通知服务端结束流程；
    // 否则本地步骤要等服务端请求返回后才停，表现为“点了结束流程但会话还在跑”。
    // 页面刷新后模块级 active 映射可能已丢失，所以再从当前快照里补一次 abort。
    for (const step of snapshot?.steps || []) {
      if (step.status === 'running' && step.local_ccweb_session_id) {
        void api.agent.abort(step.local_ccweb_session_id).catch(() => {});
      }
    }
    cancelWorkflowLocal(runId);
    try {
      await patchApi.workflowCancel(runId);
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
      // 重新执行前先停掉旧的本地执行流，避免旧会话的收尾覆盖新步骤状态。
      cancelWorkflowLocal(runId);
      await patchApi.workflowRerun(runId, 1);
      const data = await load();
      if (data) void executeLocal(data);
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
      void useChatStore.getState().refreshSessions().catch(() => {});
      navigate(`/chat.html?session=${encodeURIComponent(step.local_ccweb_session_id)}`);
    } else if (step.local_session_id) {
      navigate(`/chat.html?history=${encodeURIComponent(step.local_session_id)}`);
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

  // 本地步骤的产物目录：优先用快照里的 local_output_dir；步骤还在执行、
  // 服务端尚未回写 resolved_directory 时，退回执行器登记的会话映射。
  const artifactDirFor = (step: WorkflowStep): string => {
    const sessionId = String(step.local_ccweb_session_id || '').trim();
    const fromSession = sessionId
      ? useWorkflowSessionStore.getState().artifacts[sessionId]?.dir || ''
      : '';
    return String(step.local_output_dir || step.resolved_directory || fromSession || '').trim();
  };

  const openArtifactFolder = async (step: WorkflowStep) => {
    const dir = artifactDirFor(step);
    if (!dir) {
      toast.info('该步骤还没有生成产物目录');
      return;
    }
    try {
      await api.files.openFolder(dir);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '打开产物目录失败');
    }
  };

  const openArtifacts = async (step: WorkflowStep) => {
    setArtifactsBusy(true);
    try {
      // local 步骤的产物在客户端本机，补丁中心列不到；走 cc-web 的本机文件接口。
      const localDir = artifactDirFor(step);
      if (step.claude_target === 'local') {
        if (!localDir) {
          toast.info('该步骤还没有生成产物目录');
          return;
        }
        const listing = await api.files.list(localDir);
        if (!listing.success) throw new Error('读取本地产物目录失败');
        setArtifacts({
          step: step.step_order,
          dir: localDir,
          items: (listing.files || [])
            .filter((file) => !file.is_dir)
            .map((file) => ({ name: file.name, size: file.size, local_path: file.path })),
        });
        return;
      }
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
    <AppShell nav={nav} showSessions showFiles={false}>
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
                      {target === 'local' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<FolderOpen size={12} />}
                          onClick={() => void openArtifactFolder(step)}
                        >
                          打开产物位置
                        </Button>
                      )}
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
          <div className="flex w-full items-center justify-end gap-2">
            {artifacts?.dir && (
              <Button
                variant="ghost"
                icon={<FolderOpen size={12} />}
                onClick={() => {
                  void api.files
                    .openFolder(artifacts.dir as string)
                    .catch((error) =>
                      toast.error(error instanceof Error ? error.message : '打开目录失败')
                    );
                }}
              >
                打开目录
              </Button>
            )}
            <Button variant="ghost" onClick={() => setArtifacts(null)}>
              关闭
            </Button>
          </div>
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
                    if (item.local_path) {
                      const read = await api.files.read(item.local_path);
                      if (!read.success) throw new Error('读取文件失败');
                      setOutputOpen({ title: item.name, content: read.content || '' });
                      return;
                    }
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
