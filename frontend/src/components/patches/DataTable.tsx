import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Inbox, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface Column<T> {
  key: string;
  title: ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  render: (row: T, index: number) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  empty,
  onRowClick,
  className,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative overflow-auto rounded-xl border border-line bg-surface',
        className
      )}
    >
      <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-surface-2/95 backdrop-blur">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={{ width: column.width }}
                className={cn(
                  'whitespace-nowrap border-b border-line px-3 py-2.5 text-left text-[11.5px] font-semibold text-ink-3',
                  column.align === 'right' && 'text-right',
                  column.align === 'center' && 'text-center',
                  column.className
                )}
              >
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-16 text-center">
                <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-3">
                  <Loader2 size={15} className="animate-spin" /> 加载中…
                </span>
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-14 text-center">
                <div className="flex flex-col items-center gap-2 text-ink-3">
                  <Inbox size={22} className="opacity-60" />
                  <span className="text-[12.5px]">{empty ?? '暂无数据'}</span>
                </div>
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-b border-line-soft last:border-0',
                  onRowClick && 'cursor-pointer',
                  'transition-colors hover:bg-surface-2/70'
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'px-3 py-2.5 align-middle text-ink-2',
                      column.align === 'right' && 'text-right',
                      column.align === 'center' && 'text-center',
                      column.className
                    )}
                  >
                    {column.render(row, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({
  page,
  size,
  total,
  onPage,
  onSize,
  sizes = [10, 20, 50, 100],
  className,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (page: number) => void;
  onSize?: (size: number) => void;
  sizes?: number[];
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, size)));
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 px-1 py-2.5 text-[11.5px] text-ink-3',
        className
      )}
    >
      <span>
        共 {total} 条 · 第 {page} / {pages} 页
      </span>
      <div className="flex items-center gap-1.5">
        {onSize && (
          <select
            value={size}
            onChange={(event) => onSize(Number(event.target.value))}
            className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-[11.5px] text-ink-2 outline-none"
          >
            {sizes.map((value) => (
              <option key={value} value={value}>
                {value} 条/页
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface-2 text-ink-2 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface-2 text-ink-2 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

export function PatchStatusBadge({ status }: { status?: number | null }) {
  const map: Record<number, { text: string; tone: string }> = {
    0: { text: '待分析', tone: 'badge-muted' },
    1: { text: '分析中', tone: 'badge-warning' },
    2: { text: '已分析', tone: 'badge-success' },
    3: { text: '分析失败', tone: 'badge-danger' },
  };
  const item = map[status ?? 0] || map[0];
  return <span className={cn('badge', item.tone)}>{item.text}</span>;
}

export function StatusDot({ status }: { status?: string }) {
  const colors: Record<string, string> = {
    running: 'bg-warning',
    awaiting_confirmation: 'bg-warning',
    awaiting_decision: 'bg-warning',
    success: 'bg-success',
    solved: 'bg-success',
    done: 'bg-success',
    completed: 'bg-success',
    failed: 'bg-danger',
    error: 'bg-danger',
    aborted: 'bg-ink-3',
    cancelled: 'bg-ink-3',
    pending: 'bg-ink-3',
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-1.5 w-1.5 rounded-full', colors[status || ''] || 'bg-ink-3')} />
      <span>{status || '—'}</span>
    </span>
  );
}
