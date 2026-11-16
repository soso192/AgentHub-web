import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import type { PatchRow } from '../../lib/types';
import { Button, ConfirmDialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { useProducts } from './hooks';
import { PatchTable } from './PatchTable';
import { ProductPicker } from './ProductPicker';
import {
  PatchDetailDialog,
  PatchEditDialog,
  useDownloadPatch,
} from './PatchDialogs';

export function SearchTab({
  admin,
  canAdapt,
  onAdapt,
}: {
  admin: boolean;
  canAdapt?: boolean;
  onAdapt?: (row: PatchRow) => void;
}) {
  const toast = useToast();
  const { products } = useProducts();
  const { download, busyId } = useDownloadPatch();
  const [advanced, setAdvanced] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [name, setName] = useState('');
  const [product, setProduct] = useState('');
  const [version, setVersion] = useState('');
  const [userKeyword, setUserKeyword] = useState('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<PatchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const [detailId, setDetailId] = useState<string | number | null>(null);
  const [editing, setEditing] = useState<PatchRow | null>(null);
  const [deleting, setDeleting] = useState<PatchRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const versionOptions = useMemo(() => {
    const found = products.find((item) => item.name === product);
    return (found?.versions || [])
      .filter((item) => !item.is_deleted)
      .map((item) => item.version);
  }, [products, product]);

  const load = useCallback(
    async (
      nextPage = page,
      nextSize = size,
      useAdvanced = advanced,
      override: {
        keyword?: string;
        name?: string;
        product?: string;
        version?: string;
        userKeyword?: string;
        description?: string;
      } = {}
    ) => {
      const generation = ++requestRef.current;
      const values = {
        keyword,
        name,
        product,
        version,
        userKeyword,
        description,
        ...override,
      };
      setLoading(true);
      try {
        const result = await patchApi.search({
          page: nextPage,
          size: nextSize,
          keyword: useAdvanced ? undefined : values.keyword.trim(),
          name: useAdvanced ? values.name.trim() : undefined,
          product_name: values.product.trim() || undefined,
          product_version: values.version.trim() || undefined,
          user_keyword: useAdvanced ? values.userKeyword.trim() : undefined,
          description: useAdvanced ? values.description.trim() : undefined,
        });
        if (generation !== requestRef.current) return;
        setRows(result.items || []);
        setTotal(result.total || 0);
        setPage(nextPage);
        setSize(nextSize);
      } catch (error) {
        if (generation !== requestRef.current) return;
        toast.error(error instanceof Error ? error.message : '检索失败');
        setRows([]);
        setTotal(0);
      } finally {
        if (generation === requestRef.current) setLoading(false);
      }
    },
    [advanced, description, keyword, name, page, product, size, userKeyword, version, toast]
  );

  useEffect(() => {
    void load(1, size, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setKeyword('');
    setName('');
    setProduct('');
    setVersion('');
    setUserKeyword('');
    setDescription('');
    setPage(1);
    void load(1, size, advanced, {
      keyword: '',
      name: '',
      product: '',
      version: '',
      userKeyword: '',
      description: '',
    });
  };

  const remove = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await patchApi.remove(deleting.id);
      toast.success('补丁已删除');
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
      <div className="rounded-xl border border-line bg-surface p-3">
        <datalist id="patch-search-versions">
          {versionOptions.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>

        <div className="flex flex-wrap items-center gap-2">
          {!advanced && (
            <>
              <ProductPicker
                className="w-[150px]"
                value={product}
                products={products}
                placeholder="产品名称"
                onChange={(value) => {
                  if (value !== product) setVersion('');
                  setProduct(value);
                }}
              />
              <Input
                className="w-[120px]"
                value={version}
                list="patch-search-versions"
                onChange={(event) => setVersion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void load(1, size, false);
                }}
                placeholder="版本号"
              />
              <div className="relative min-w-[220px] flex-1">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
                />
                <Input
                  className="pl-9"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void load(1, size, false);
                  }}
                  placeholder="搜索补丁名称、描述、关键词…"
                />
              </div>
              <Button variant="primary" icon={<Search size={14} />} onClick={() => void load(1, size, false)}>
                搜索
              </Button>
            </>
          )}
          <Button
            variant={advanced ? 'primary' : 'default'}
            icon={<SlidersHorizontal size={14} />}
            onClick={() => {
              setAdvanced((value) => !value);
              setKeyword('');
            }}
          >
            {advanced ? '收起高级' : '高级搜索'}
          </Button>
          <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={reset}>
            重置
          </Button>
        </div>

        {advanced && (
          <div className="mt-3 grid grid-cols-1 gap-2 border-t border-line-soft pt-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="补丁名称" />
            <ProductPicker
              value={product}
              products={products}
              placeholder="产品名称"
              onChange={(value) => {
                if (value !== product) setVersion('');
                setProduct(value);
              }}
            />
            <Input
              value={version}
              list="patch-search-versions"
              onChange={(event) => setVersion(event.target.value)}
              placeholder="版本号"
            />
            <Input
              value={userKeyword}
              onChange={(event) => setUserKeyword(event.target.value)}
              placeholder="用户关键词"
            />
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="描述"
            />
            <Button variant="primary" icon={<Search size={14} />} onClick={() => void load(1, size, true)}>
              高级搜索
            </Button>
          </div>
        )}
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
        onDetail={(row) => setDetailId(row.id)}
        onDownload={download}
        downloadingId={busyId}
        onEdit={admin ? (row) => setEditing(row) : undefined}
        onDelete={admin ? (row) => setDeleting(row) : undefined}
        onAdapt={canAdapt ? (row) => onAdapt?.(row) : undefined}
      />

      <PatchDetailDialog
        patchId={detailId}
        onClose={() => setDetailId(null)}
        onDownload={download}
      />
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
        description={deleting ? `确定删除「${deleting.name}」吗？此操作不可恢复。` : ''}
        confirmText="删除"
        danger
        loading={deleteBusy}
      />
    </div>
  );
}
