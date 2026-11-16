import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageSquare, Play } from 'lucide-react';
import { AppShell, SidebarToggle } from '../components/layout/AppShell';
import { MessageItem } from '../components/chat/MessageItem';
import { Button, Spinner } from '../components/ui';
import { patchApi } from '../lib/patch';
import type { Message } from '../lib/types';

const TERMINAL = new Set(['success', 'failed', 'cancelled']);

export function ServerReplayPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const history = searchParams.get('history') || '';
  const run = searchParams.get('run') || '';
  const step = Number(searchParams.get('step') || 0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [stepStatus, setStepStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sizeRef = useRef(0);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!run || !step) return null;
    try {
      const result = await patchApi.workflowSession(run, step, sizeRef.current);
      if (result.unchanged) return result;
      if (result.size != null) sizeRef.current = result.size;
      setMessages(result.messages || []);
      setStepStatus(String(result.step_status || ''));
      setError('');
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载会话失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, [run, step]);

  useEffect(() => {
    if (!run || !step) {
      setLoading(false);
      setError('缺少会话参数');
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, step]);

  useEffect(() => {
    if (!run || !step) return;
    if (TERMINAL.has(stepStatus)) return;
    const timer = window.setInterval(() => {
      void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [run, step, stepStatus, load]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const live = stepStatus && !TERMINAL.has(stepStatus);

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
      showSessions={false}
      showFiles={false}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <SidebarToggle />
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>
          返回
        </Button>
        <span className="text-[14px] font-semibold text-ink">服务器会话回放</span>
        <span className="truncate font-mono text-[10.5px] text-ink-3">
          步骤 {step} · {history.slice(0, 12)}
        </span>
        <div className="flex-1" />
        {live ? (
          <span className="badge badge-success">
            <span className="live-dot" /> 实时更新中
          </span>
        ) : (
          <span className="badge badge-muted">只读查看</span>
        )}
      </div>

      <div ref={scrollerRef} className="scroll-area min-h-0 flex-1 px-4 py-4">
        <div className="mx-auto max-w-4xl space-y-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-ink-3">
              <Spinner size={16} /> 正在加载会话…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[12.5px] text-danger">
              {error}
            </div>
          ) : messages.length === 0 ? (
            <div className="py-16 text-center text-[12.5px] text-ink-3">
              该会话暂无内容或尚未开始输出
            </div>
          ) : (
            messages.map((message, index) => (
              <MessageItem key={`${message.timestamp}-${index}`} message={message} assistant="claude" />
            ))
          )}
        </div>
      </div>

      {live && (
        <div className="border-t border-line bg-surface-2/70 px-4 py-2 text-center text-[11.5px] text-ink-3">
          服务器会话执行中 · 每 5 秒自动刷新
        </div>
      )}
    </AppShell>
  );
}
