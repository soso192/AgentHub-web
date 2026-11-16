import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import type { PatchRow } from '../../lib/types';
import { Button, ConfirmDialog } from '../ui';
import { useToast } from '../ui/toast';
import { useProducts } from './hooks';
import { PatchTable } from './PatchTable';
import { PatchDetailDialog, PatchEditDialog, useDownloadPatch } from './PatchDialogs';

export function MineTab({ admin }: { admin: boolean }) {
  const toast = useToast();
  const { products } = useProducts();
  const { download, busyId } = useDownloadPatch();
  const [rows, setRows] = useState<PatchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const generationRef = useRef(0);
  const [detailId, setDetailId] = useState<string | number | null>(null);
  const [editing, setEditing] = useState<PatchRow | null>(null);
  const [deleting, setDeleting] = useState<PatchRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(
    async (nextPage = page, nextSize = size) => {
      const generation = ++generationRef.current;
      setLoading(true);
      try {
        const result = await patchApi.mine(nextPage, nextSize);
        if (generation !== generationRef.current) return;
        setRows(result.items || []);
        setTotal(result.total || 0);
        setPage(nextPage);
        setSize(nextSize);
      } catch (error) {
        if (generation !== generationRef.current) return;
        toast.error(error instanceof Error ? error.message : '加载失败');
      } finally {
        if (generation === generationRef.current) setLoading(false);
      }
    },
    [page, size, toast]
  );

  useEffect(() => {
    void load(1, size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await patchApi.remove(deleting.id);
      toast.success('已删除');
      setDeleting(null);
      void load(page, size);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] text-ink-3">共 {total} 个我上传的补丁</div>
        <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => void load(page, size)}>
          刷新
        </Button>
      </div>

      <PatchTable
        rows={rows}
        loading={loading}
        page={page}
        size={size}
        total={total}
        onPage={(next) => void load(next, size)}
        onSize={(next) => void load(1, next)}
        admin={admin}
        showAnalysisTime={false}
        onDetail={(row) => setDetailId(row.id)}
        onDownload={download}
        downloadingId={busyId}
        onEdit={(row) => setEditing(row)}
        onDelete={(row) => setDeleting(row)}
      />

      <PatchDetailDialog patchId={detailId} onClose={() => setDetailId(null)} onDownload={download} />
      <PatchEditDialog
        patch={editing}
        products={products}
        admin={admin}
        onClose={() => setEditing(null)}
        onSaved={() => void load(page, size)}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="删除补丁"
        description={deleting ? `确定删除「${deleting.name}」吗？` : ''}
        confirmText="删除"
        danger
        loading={deleteBusy}
      />
    </div>
  );
}
