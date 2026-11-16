import {
  ArrowRightLeft,
  Download,
  Eye,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { PatchRow } from '../../lib/types';
import { formatBytes, relativeTime, truncate } from '../../lib/utils';
import { DataTable, PatchStatusBadge, Pagination, type Column } from './DataTable';

function ActionButton({
  label,
  icon,
  onClick,
  danger,
  loading,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: (event: React.MouseEvent) => void;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={
        danger
          ? 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger'
          : 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink'
      }
    >
      {loading ? <Loader2 size={12} className="animate-spin" /> : icon}
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

export function PatchTable({
  rows,
  loading,
  page,
  size,
  total,
  onPage,
  onSize,
  admin,
  showAnalysisTime = true,
  onDetail,
  onDownload,
  onEdit,
  onDelete,
  onAdapt,
  downloadingId,
}: {
  rows: PatchRow[];
  loading?: boolean;
  page?: number;
  size?: number;
  total?: number;
  onPage?: (page: number) => void;
  onSize?: (size: number) => void;
  admin?: boolean;
  showAnalysisTime?: boolean;
  onDetail: (row: PatchRow) => void;
  onDownload: (row: PatchRow) => void;
  onEdit?: (row: PatchRow) => void;
  onDelete?: (row: PatchRow) => void;
  onAdapt?: (row: PatchRow) => void;
  downloadingId?: string | number | null;
}) {
  const columns: Array<Column<PatchRow>> = [
    {
      key: 'name',
      title: '名称',
      width: '26%',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink" title={row.name}>
            {row.name}
          </div>
          {row.file_name && (
            <div className="truncate font-mono text-[10.5px] text-ink-3" title={row.file_name}>
              {row.file_name}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'product',
      title: '产品 / 版本',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-ink-2">{row.product_name || '—'}</div>
          <div className="truncate text-[10.5px] text-ink-3">{row.product_version || ''}</div>
        </div>
      ),
    },
    {
      key: 'format',
      title: '格式',
      align: 'center',
      render: (row) => (
        <span className="badge badge-muted">{String(row.file_format || '—').toUpperCase()}</span>
      ),
    },
    {
      key: 'size',
      title: '大小',
      align: 'right',
      render: (row) => <span className="text-ink-3">{formatBytes(row.file_size ?? 0)}</span>,
    },
    {
      key: 'status',
      title: '状态',
      align: 'center',
      render: (row) => <PatchStatusBadge status={row.status} />,
    },
    ...(showAnalysisTime
      ? [
          {
            key: 'analyzed',
            title: '分析时间',
            render: (row: PatchRow) => (
              <span className="text-ink-3">{row.analyzed_at ? relativeTime(row.analyzed_at) : '—'}</span>
            ),
          },
        ]
      : []),
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      width: '190px',
      render: (row) => (
        <div className="flex items-center justify-end gap-0.5">
          {row.status === 2 && (
            <>
              <ActionButton
                label="详情"
                icon={<Eye size={12} />}
                onClick={(event) => {
                  event.stopPropagation();
                  onDetail(row);
                }}
              />
              <ActionButton
                label="下载"
                icon={<Download size={12} />}
                loading={downloadingId === row.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onDownload(row);
                }}
              />
            </>
          )}
          {onAdapt && (
            <ActionButton
              label="适配"
              icon={<ArrowRightLeft size={12} />}
              onClick={(event) => {
                event.stopPropagation();
                onAdapt(row);
              }}
            />
          )}
          {onEdit && (
            <ActionButton
              label="编辑"
              icon={<Pencil size={12} />}
              onClick={(event) => {
                event.stopPropagation();
                onEdit(row);
              }}
            />
          )}
          {onDelete && (
            <ActionButton
              label="删除"
              icon={<Trash2 size={12} />}
              danger
              onClick={(event) => {
                event.stopPropagation();
                onDelete(row);
              }}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        rowKey={(row) => String(row.id)}
        empty="没有找到补丁"
        onRowClick={(row) => onDetail(row)}
        className="max-h-[calc(100vh-300px)]"
      />
      {page != null && size != null && total != null && onPage && (
        <Pagination page={page} size={size} total={total} onPage={onPage} onSize={onSize} />
      )}
    </div>
  );
}

export function patchSubtitle(row: PatchRow): string {
  return truncate(row.description || row.file_name || '', 60);
}
