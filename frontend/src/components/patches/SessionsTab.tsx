import { useEffect, useState } from 'react';
import { Eye, Search } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import type { Message, SessionArchiveRow } from '../../lib/types';
import { relativeTime } from '../../lib/utils';
import { Button, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { MessageItem } from '../chat/MessageItem';
import { DataTable, Pagination, type Column } from './DataTable';

function parseConversation(json?: string): Message[] {
  if (!json) return [];
  try {
    const data = JSON.parse(json);
    if (Array.isArray(data)) return data as Message[];
    if (Array.isArray(data?.messages)) return data.messages as Message[];
    return [];
  } catch {
    return [];
  }
}

export function SessionsTab() {
  const toast = useToast();
  const [rows, setRows] = useState<SessionArchiveRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [userId, setUserId] = useState('');
  const [product, setProduct] = useState('');
  const [runId, setRunId] = useState('');
  const [viewing, setViewing] = useState<{ messages: Message[]; title: string } | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  const load = async (nextPage = page, nextSize = size) => {
    setLoading(true);
    try {
      const result = await patchApi.archiveSessions({
        user_id: userId.trim() || undefined,
        product: product.trim() || undefined,
        local_run_id: runId.trim() || undefined,
        page: nextPage,
        page_size: nextSize,
      });
      setRows(result.items || []);
      setTotal(result.total || 0);
      setPage(nextPage);
      setSize(nextSize);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载会话存档失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(1, size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = async (row: SessionArchiveRow) => {
    setViewLoading(true);
    try {
      const detail = await patchApi.archiveSession(row.local_run_id, row.step);
      const messages = parseConversation(detail.conversation_json || row.conversation_json);
      setViewing({
        messages,
        title: `${row.problem_desc || row.local_run_id} · ${
          row.step === 'm' ? '阶段二 · 合并' : `阶段一 · 第 ${String(row.step || '').replace(/^s/, '')} 次`
        }`,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取存档失败');
    } finally {
      setViewLoading(false);
    }
  };

  const columns: Array<Column<SessionArchiveRow>> = [
    {
      key: 'time',
      title: '归档时间',
      render: (row) => <span className="text-ink-3">{relativeTime(row.created_at)}</span>,
    },
    {
      key: 'step',
      title: '阶段',
      align: 'center',
      render: (row) => (
        <span className="badge badge-muted">
          {row.step === 'm' ? '阶段二 · 合并' : `阶段一 · 第 ${String(row.step || '').replace(/^s/, '')} 次`}
        </span>
      ),
    },
    {
      key: 'user',
      title: '用户',
      render: (row) => <span className="text-ink-3">{row.created_by_user_id ?? '—'}</span>,
    },
    {
      key: 'product',
      title: '产品 / 版本',
      render: (row) => (
        <span className="text-ink-2">
          {row.product_name || '—'} {row.product_version || ''}
        </span>
      ),
    },
    {
      key: 'problem',
      title: '问题',
      render: (row) => (
        <span className="block max-w-[280px] truncate text-ink-2" title={row.problem_desc}>
          {row.problem_desc || '—'}
        </span>
      ),
    },
    {
      key: 'messages',
      title: '消息数',
      align: 'center',
      render: (row) => <span className="text-ink-3">{row.message_count ?? '—'}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      width: '90px',
      render: (row) => (
        <Button size="sm" icon={<Eye size={12} />} disabled={viewLoading} onClick={() => void view(row)}>
          查看
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
        <Input className="w-[140px]" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="用户 ID" onKeyDown={(event) => event.key === 'Enter' && void load(1, size)} />
        <Input className="w-[160px]" value={product} onChange={(event) => setProduct(event.target.value)} placeholder="产品" onKeyDown={(event) => event.key === 'Enter' && void load(1, size)} />
        <Input className="w-[200px]" value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="运行 ID / 工单号" onKeyDown={(event) => event.key === 'Enter' && void load(1, size)} />
        <Button variant="primary" icon={<Search size={14} />} onClick={() => void load(1, size)}>
          查询
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setUserId('');
            setProduct('');
            setRunId('');
            void load(1, size);
          }}
        >
          重置
        </Button>
      </div>

      <DataTable columns={columns} rows={rows} loading={loading} rowKey={(row) => `${row.local_run_id}-${row.step}`} empty="暂无会话存档" />
      <Pagination page={page} size={size} total={total} onPage={(next) => void load(next, size)} onSize={(next) => void load(1, next)} sizes={[20, 50, 100]} />

      <Dialog
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={viewing?.title || '会话存档'}
        width="max-w-4xl"
        footer={
          <Button variant="ghost" onClick={() => setViewing(null)}>
            关闭
          </Button>
        }
      >
        <div className="scroll-area max-h-[65vh] space-y-1 rounded-xl border border-line bg-surface-2/50 p-3">
          {viewing?.messages.length ? (
            viewing.messages.map((message, index) => (
              <MessageItem key={index} message={message} assistant="claude" />
            ))
          ) : (
            <div className="py-10 text-center text-[12.5px] text-ink-3">没有可显示的消息</div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
