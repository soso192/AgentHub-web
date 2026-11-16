import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  FastForward,
  MessageSquare,
  RotateCcw,
  Square,
} from 'lucide-react';
import { AppShell, SidebarToggle } from '../components/layout/AppShell';
import { Button, Dialog, Spinner } from '../components/ui';
import { useToast } from '../components/ui/toast';
import { api, getPatchServers } from '../lib/api';
import { patchApi } from '../lib/patch';
import type { AdaptItem, AdaptRun } from '../lib/types';
import { relativeTime } from '../lib/utils';
import { ResultBox } from '../components/ResultBox';

const RUN_STATUS: Record<string, string> = {
  running: '执行中',
  awaiting_confirmation: '待确认',
  done: '已完成',
  failed: '失败',
  aborted: '已中止',
};

const ITEM_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: '待执行', tone: 'badge-muted' },
  running: { label: '执行中', tone: 'badge-warning' },
  done: { label: '已完成', tone: 'badge-success' },
  conflict: { label: '冲突', tone: 'badge-warning' },
  nosource: { label: '无源码', tone: 'badge-warning' },
  failed: { label: '失败', tone: 'badge-danger' },
  skipped: { label: '已跳过', tone: 'badge-muted' },
};

function statusTone(status?: string): string {
  if (status === 'done') return 'badge-success';
  if (status === 'failed' || status === 'aborted') return 'badge-danger';
  if (status === 'running' || status === 'awaiting_confirmation') return 'badge-warning';
  return 'badge-muted';
}

export function AdaptRunPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get('run_id') || '';
  const [run, setRun] = useState<AdaptRun | null>(null);
  const [ledger, setLedger] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [detail, setDetail] = useState<AdaptItem | null>(null);
  const [viewDetail, setViewDetail] = useState<{ title: string; content: string } | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const result = await api.adapt.get(runId);
      if (result.code === 0 && result.data) {
        setRun(result.data);
        setLedger(null);
      } else {
        throw new Error('not local');
      }
    } catch {
      try {
        const remote = await patchApi.adaptLedgerDetail(runId);
        setLedger(remote as unknown as Record<string, unknown>);
        setRun(null);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '加载适配任务失败');
      }
    } finally {
      setLoading(false);
    }
  }, [runId, toast]);

  useEffect(() => {
    if (!runId) {
      setLoading(false);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (!run || !['running', 'awaiting_confirmation'].includes(String(run.status))) return;
    pollRef.current = window.setInterval(() => void load(), 3000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [run?.status, load]);

  const action = async (name: string, label: string) => {
    if (!run) return;
    setBusy(name);
    try {
      const { servers, token } = await getPatchServers();
      const result = await api.adapt.action(run.id, name, {
        server_url: servers[0] || '',
        auth_token: token,
      });
      const success = (result as { success?: boolean }).success;
      if (success === false) throw new Error((result as { error?: string }).error || `${label}失败`);
      toast.success((result as { message?: string }).message || `${label}已提交`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${label}失败`);
    } finally {
      setBusy('');
    }
  };

  const counts = run
    ? {
        done: (run.items || []).filter((item) => item.status === 'done').length,
        conflict: (run.items || []).filter((item) => item.status === 'conflict').length,
        nosource: (run.items || []).filter((item) => item.status === 'nosource').length,
        failed: (run.items || []).filter((item) => item.status === 'failed').length,
      }
    : null;

  const terminal = run && ['done', 'failed', 'aborted'].includes(String(run.status));

  return (
    <AppShell
      nav={[
        {
          key: 'dev',
          label: '智能开发',
          icon: <Eye size={15} />,
          active: true,
          onClick: () => navigate('/?tab=adapt'),
        },
      ]}
      showSessions
      showFiles={false}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <SidebarToggle />
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate('/?tab=adapt')}>
          返回
        </Button>
        <span className="text-[14px] font-semibold text-ink">补丁适配详情</span>
        {run && (
          <span className={`badge ${statusTone(run.status)}`}>
            {RUN_STATUS[run.status || ''] || run.status}
          </span>
        )}
        <div className="flex-1" />
        {run?.status === 'awaiting_confirmation' && (
          <>
            <Button
              size="sm"
              icon={<FastForward size={13} />}
              loading={busy === 'next-all'}
              onClick={() => void action('next-all', '继续全部')}
            >
              继续全部
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<ArrowRight size={13} />}
              loading={busy === 'next'}
              onClick={() => void action('next', '继续下一个')}
            >
              继续下一个
            </Button>
          </>
        )}
        {run && counts && (counts.failed || counts.conflict || counts.nosource) > 0 && !terminal && (
          <Button
            size="sm"
            icon={<RotateCcw size={13} />}
            loading={busy === 'retry-failed'}
            onClick={() => void action('retry-failed', '重试失败补丁')}
          >
            重试失败补丁
          </Button>
        )}
        {run && ['running', 'awaiting_confirmation'].includes(String(run.status)) && (
          <Button
            size="sm"
            variant="danger"
            icon={<Square size={12} />}
            loading={busy === 'abort'}
            onClick={() => void action('abort', '中止')}
          >
            中止
          </Button>
        )}
      </div>

      <div className="scroll-area min-h-0 flex-1 p-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-ink-3">
            <Spinner size={16} /> 正在加载适配任务…
          </div>
        ) : run ? (
          <div className="mx-auto max-w-5xl space-y-3">
            <div className="panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold text-ink">
                  {run.product_name || '—'} {run.product_version || ''}
                </span>
                <span className={`badge ${statusTone(run.status)}`}>
                  {RUN_STATUS[run.status || ''] || run.status}
                </span>
                <span className="text-[11.5px] text-ink-3">
                  {relativeTime(run.started_at)} · 共 {run.items?.length || 0} 个补丁
                </span>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1.5 text-[11.5px] sm:grid-cols-2">
                <div className="flex gap-1.5">
                  <span className="shrink-0 text-ink-3">客开工程目录：</span>
                  <span className="min-w-0 break-all font-mono text-ink-2">{run.project_dir || '—'}</span>
                </div>
                <div className="flex flex-wrap gap-3">
                  <span className="text-success">成功 {counts?.done || 0}</span>
                  <span className="text-warning">冲突 {counts?.conflict || 0}</span>
                  <span className="text-warning">无源码 {counts?.nosource || 0}</span>
                  <span className="text-danger">失败 {counts?.failed || 0}</span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              {(run.items || []).map((item) => {
                const info = ITEM_STATUS[item.status || 'pending'] || ITEM_STATUS.pending;
                return (
                  <div key={item.seq ?? item.id ?? item.patch_name} className="panel p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-3 text-[11px] text-ink-3">
                        {item.seq}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink" title={item.patch_name}>
                        {item.patch_name}
                      </span>
                      <span className={`badge ${info.tone}`}>{info.label}</span>
                      {(item.output_conclusion || item.output_summary) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Eye size={12} />}
                          onClick={() =>
                            setViewDetail({
                              title: item.patch_name || '补丁',
                              content: item.output_conclusion || item.output_summary || '',
                            })
                          }
                        >
                          查看结论
                        </Button>
                      )}
                    </div>
                    {item.problem_desc && (
                      <div className="mt-1.5 whitespace-pre-wrap text-[11.5px] leading-5 text-ink-3">
                        {item.problem_desc}
                      </div>
                    )}
                    {item.note && (
                      <div className="mt-1.5 rounded-md bg-surface-2 px-2 py-1 text-[11px] text-ink-3">
                        {item.note}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : ledger ? (
          <div className="mx-auto max-w-3xl">
            <div className="panel p-4">
              <div className="text-[15px] font-semibold text-ink">服务器适配记录</div>
              <div className="mt-2 text-[12px] leading-6 text-ink-2">
                本机没有这次适配的完整记录，下面是从补丁中心读取的汇总信息。
              </div>
              <ResultBox
                content={JSON.stringify(ledger, null, 2)}
                maxHeight="max-h-[60vh]"
                className="mt-3"
              />
            </div>
          </div>
        ) : (
          <div className="py-16 text-center text-[12.5px] text-ink-3">适配任务不存在</div>
        )}
      </div>

      <Dialog
        open={Boolean(viewDetail)}
        onClose={() => setViewDetail(null)}
        title={viewDetail?.title || '结论'}
        width="max-w-3xl"
        footer={
          <Button variant="ghost" onClick={() => setViewDetail(null)}>
            关闭
          </Button>
        }
      >
        <ResultBox
          content={viewDetail?.content || '（暂无结论）'}
          maxHeight="max-h-[62vh]"
        />
      </Dialog>

      <Dialog
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.patch_name || '补丁详情'}
        width="max-w-3xl"
        footer={
          <Button variant="ghost" onClick={() => setDetail(null)}>
            关闭
          </Button>
        }
      >
        <ResultBox
          content={JSON.stringify(detail, null, 2)}
          maxHeight="max-h-[60vh]"
        />
      </Dialog>
    </AppShell>
  );
}
