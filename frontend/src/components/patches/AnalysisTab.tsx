import { useEffect, useRef, useState } from 'react';
import { Play, RefreshCw } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import type { PatchRow } from '../../lib/types';
import { Button, Checkbox } from '../ui';
import { useToast } from '../ui/toast';
import { DataTable, PatchStatusBadge, Pagination, type Column } from './DataTable';

export function AnalysisTab() {
  const toast = useToast();
  const [rows, setRows] = useState<PatchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [liveStatus, setLiveStatus] = useState<Record<string, number>>({});
  const [task, setTask] = useState<{
    running: boolean;
    completed: number;
    total: number;
    success: number;
    failed: number;
  } | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const [firstN, setFirstN] = useState('10');
  const pollRef = useRef<number | null>(null);

  const load = async (nextPage = page, nextSize = size) => {
    setLoading(true);
    try {
      const result = await patchApi.pendingAnalysis(nextPage, nextSize, status || undefined);
      setRows(result.items || []);
      setTotal(result.total || 0);
      setPage(nextPage);
      setSize(nextSize);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载待分析补丁失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(1, size);
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const togglePage = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of rows) {
        if (checked) next.add(String(row.id));
        else next.delete(String(row.id));
      }
      return next;
    });
  };

  const start = async () => {
    if (!selected.size) return;
    setStartBusy(true);
    try {
      const result = await patchApi.analyze(Array.from(selected));
      setTask({ running: true, completed: 0, total: selected.size, success: 0, failed: 0 });
      const poll = async () => {
        try {
          const statusResult = await patchApi.analyzeStatus(result.id);
          setTask({
            running: !['completed', 'failed', 'cancelled'].includes(statusResult.status),
            completed: statusResult.completed || 0,
            total: statusResult.total || 0,
            success: statusResult.success || 0,
            failed: statusResult.failed || 0,
          });
          if (statusResult.patches) {
            setLiveStatus((current) => {
              const next = { ...current };
              for (const patch of statusResult.patches!) next[String(patch.patch_id)] = patch.status;
              return next;
            });
          }
          if (!['completed', 'failed', 'cancelled'].includes(statusResult.status)) {
            pollRef.current = window.setTimeout(poll, 1500);
          } else {
            setSelected(new Set());
            await load(page, size);
          }
        } catch {
          setTask((current) => (current ? { ...current, running: false } : current));
        }
      };
      pollRef.current = window.setTimeout(poll, 800);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '启动分析失败');
      setTask(null);
    } finally {
      setStartBusy(false);
    }
  };

  const pageAllSelected = rows.length > 0 && rows.every((row) => selected.has(String(row.id)));

  const columns: Array<Column<PatchRow>> = [
    {
      key: 'check',
      title: (
        <Checkbox
          checked={pageAllSelected}
          onChange={togglePage}
          disabled={Boolean(task?.running)}
        />
      ),
      width: '44px',
      align: 'center',
      render: (row) => (
        <Checkbox
          checked={selected.has(String(row.id))}
          onChange={(checked) => toggle(String(row.id), checked)}
          disabled={Boolean(task?.running)}
        />
      ),
    },
    {
      key: 'name',
      title: '名称',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{row.name}</div>
          <div className="truncate font-mono text-[10.5px] text-ink-3">{row.file_name}</div>
        </div>
      ),
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
      key: 'status',
      title: '状态',
      align: 'center',
      render: (row) => (
        <PatchStatusBadge status={liveStatus[String(row.id)] ?? row.status} />
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setSelected(new Set());
          }}
          className="h-9 rounded-lg border border-line bg-surface-2 px-2.5 text-[12.5px] text-ink-2 outline-none"
        >
          <option value="">全部待分析</option>
          <option value="0">待分析</option>
          <option value="1">分析中</option>
          <option value="3">分析失败</option>
        </select>
        <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
          <span>前</span>
          <input
            value={firstN}
            onChange={(event) => setFirstN(event.target.value)}
            type="number"
            min={1}
            max={1000}
            className="h-8 w-20 rounded-md border border-line bg-surface-2 px-2 text-[12px] outline-none"
          />
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => {
              const count = Math.min(Number(firstN) || 0, rows.length);
              setSelected(new Set(rows.slice(0, count).map((row) => String(row.id))));
            }}
          >
            选择
          </button>
        </div>
        <div className="flex-1" />
        <span className="text-[12px] text-ink-3">已选择 {selected.size} 个</span>
        <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => void load(page, size)}>
          刷新
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Play size={13} />}
          disabled={!selected.size || Boolean(task?.running)}
          loading={startBusy}
          onClick={start}
        >
          开始分析
        </Button>
      </div>

      {task && (
        <div className="flex items-center gap-3 rounded-xl border border-accent/25 bg-accent-soft/40 px-4 py-2.5 text-[12px] text-ink-2">
          <span className="font-medium text-accent">
            {task.running ? '分析中' : '分析结束'}
          </span>
          <span>
            {task.completed} / {task.total}
          </span>
          <span className="text-success">成功 {task.success}</span>
          <span className="text-danger">失败 {task.failed}</span>
          {task.running && (
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
              <span
                className="block h-full rounded-full bg-accent transition-all"
                style={{
                  width: `${task.total ? Math.round((task.completed / task.total) * 100) : 0}%`,
                }}
              />
            </span>
          )}
        </div>
      )}

      <DataTable columns={columns} rows={rows} loading={loading} rowKey={(row) => String(row.id)} empty="没有待分析的补丁" />
      <Pagination page={page} size={size} total={total} onPage={(next) => void load(next, size)} onSize={(next) => void load(1, next)} sizes={[10, 20, 50, 100, 500, 1000]} />
    </div>
  );
}
