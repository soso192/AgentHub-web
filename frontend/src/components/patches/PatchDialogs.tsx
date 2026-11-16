import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  Download,
  FileArchive,
  Loader2,
  Tag,
  User,
} from 'lucide-react';
import { patchApi, downloadPatchArchive, saveBlob } from '../../lib/patch';
import type { PatchRow, Product } from '../../lib/types';
import { formatBytes, relativeTime } from '../../lib/utils';
import { ResultBox } from '../ResultBox';
import { Button, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { PatchStatusBadge } from './DataTable';

/** 从 analysis_result 的任意层级/嵌套 JSON 字符串里提取 function_desc。 */
export function extractFunctionDesc(value: unknown): string {
  const seen = new Set<unknown>();

  const visit = (input: unknown, depth: number): string => {
    if (input == null || depth > 8) return '';
    if (typeof input === 'string') {
      const text = input.trim();
      if (!text) return '';
      const match = /"function_desc"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text);
      if (match) {
        try {
          return JSON.parse(`"${match[1]}"`) as string;
        } catch {
          return match[1];
        }
      }
      const fenced = /```json\s*([\s\S]*?)```/i.exec(text);
      if (fenced) return visit(fenced[1], depth + 1);
      if (
        (text.startsWith('{') && text.endsWith('}')) ||
        (text.startsWith('[') && text.endsWith(']'))
      ) {
        try {
          return visit(JSON.parse(text), depth + 1);
        } catch {
          /* ignore */
        }
      }
      return '';
    }
    if (typeof input !== 'object') return '';
    if (seen.has(input)) return '';
    seen.add(input);

    if (Array.isArray(input)) {
      for (const item of input) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return '';
    }

    const obj = input as Record<string, unknown>;
    const direct = obj.function_desc;
    if (typeof direct === 'string' && direct.trim()) return direct;

    for (const key of ['data', 'result', 'analysis_result', 'function', 'functions', 'items']) {
      if (key in obj) {
        const found = visit(obj[key], depth + 1);
        if (found) return found;
      }
    }
    for (const item of Object.values(obj)) {
      const found = visit(item, depth + 1);
      if (found) return found;
    }
    return '';
  };

  return visit(value, 0);
}

export function useDownloadPatch() {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | number | null>(null);
  const download = async (row: PatchRow) => {
    setBusyId(row.id);
    try {
      const { blob, filename } = await downloadPatchArchive(
        row.id,
        row.file_name || `${row.name || 'patch'}.zip`
      );
      saveBlob(blob, filename);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载失败');
    } finally {
      setBusyId(null);
    }
  };
  return { download, busyId };
}

export function PatchDetailDialog({
  patchId,
  onClose,
  onDownload,
}: {
  patchId: string | number | null;
  onClose: () => void;
  onDownload?: (row: PatchRow) => void;
}) {
  const [row, setRow] = useState<PatchRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (patchId == null) return;
    setLoading(true);
    setError('');
    setRow(null);
    patchApi
      .detail(patchId)
      .then((result) => setRow(result))
      .catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [patchId]);

  const analysis = useMemo(
    () => extractFunctionDesc(row?.analysis_result),
    [row?.analysis_result]
  );

  return (
    <Dialog
      open={patchId != null}
      onClose={onClose}
      title={row?.name || '补丁详情'}
      description={row?.file_name}
      width="max-w-3xl"
      footer={
        row && (
          <>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            {row.status === 2 && onDownload && (
              <Button variant="primary" icon={<Download size={14} />} onClick={() => onDownload(row)}>
                下载补丁包
              </Button>
            )}
          </>
        )
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-14 text-[12.5px] text-ink-3">
          <Loader2 size={15} className="animate-spin" /> 正在加载…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-danger/25 bg-danger-soft px-4 py-3 text-[12.5px] text-danger">
          {error}
        </div>
      ) : row ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <PatchStatusBadge status={row.status} />
            {row.product_name && (
              <span className="badge badge-accent">
                {row.product_name} {row.product_version || ''}
              </span>
            )}
            {row.file_format && <span className="badge badge-muted">{String(row.file_format).toUpperCase()}</span>}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              { label: '补丁名称', value: row.name, icon: <Tag size={12} /> },
              { label: '产品', value: row.product_name || '—', icon: null },
              { label: '版本', value: row.product_version || '—', icon: null },
              {
                label: '格式 / 大小',
                value: `${row.file_format || '—'} · ${formatBytes(row.file_size ?? 0)}`,
                icon: <FileArchive size={12} />,
              },
              { label: '上传人', value: row.uploaded_by || '—', icon: <User size={12} /> },
              {
                label: '上传时间',
                value: row.uploaded_at ? relativeTime(row.uploaded_at) : '—',
                icon: <CalendarDays size={12} />,
              },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-lg border border-line bg-surface-2 px-3 py-2"
              >
                <div className="flex items-center gap-1 text-[10.5px] text-ink-3">
                  {item.icon}
                  {item.label}
                </div>
                <div className="mt-0.5 break-all text-[12.5px] text-ink-2">
                  {String(item.value ?? '—')}
                </div>
              </div>
            ))}
          </div>

          {row.description && (
            <section className="rounded-xl border border-line bg-surface-2 p-3">
              <div className="mb-1 text-[11.5px] font-medium text-ink-3">描述</div>
              <div className="whitespace-pre-wrap text-[12.5px] leading-6 text-ink-2">
                {row.description}
              </div>
            </section>
          )}

          {(row.user_keyword || row.class_name || row.keyword) && (
            <section className="flex flex-wrap gap-2 text-[11.5px]">
              {row.user_keyword && (
                <span className="rounded-md bg-surface-3 px-2 py-1 text-ink-2">
                  用户关键词：{row.user_keyword}
                </span>
              )}
              {row.class_name && (
                <span className="rounded-md bg-surface-3 px-2 py-1 text-ink-2">
                  类名：{row.class_name}
                </span>
              )}
              {row.keyword && (
                <span className="rounded-md bg-surface-3 px-2 py-1 text-ink-2">
                  关键词：{row.keyword}
                </span>
              )}
            </section>
          )}

          {analysis && (
            <section>
              <div className="mb-1.5 text-[11.5px] font-medium text-ink-3">分析结果</div>
              <ResultBox content={analysis} maxHeight="max-h-[46vh]">
                <div className="result-box max-h-[46vh] overflow-auto whitespace-pre-wrap rounded-lg p-3 text-[12.5px] leading-6">
                  {analysis}
                </div>
              </ResultBox>
            </section>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

export function PatchEditDialog({
  patch,
  products,
  admin,
  onClose,
  onSaved,
}: {
  patch: PatchRow | null;
  products: Product[];
  admin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [product, setProduct] = useState('');
  const [version, setVersion] = useState('');
  const [description, setDescription] = useState('');
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('0');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!patch) return;
    setName(patch.name || '');
    setProduct(patch.product_name || '');
    setVersion(patch.product_version || '');
    setDescription(patch.description || '');
    setKeyword(patch.user_keyword || '');
    setStatus(String(patch.status ?? 0));
  }, [patch]);

  const productOptions = useMemo(() => {
    const names = products.map((item) => item.name);
    if (patch?.product_name && !names.includes(patch.product_name)) names.push(patch.product_name);
    return names;
  }, [products, patch?.product_name]);

  const versions = useMemo(() => {
    const found = products.find((item) => item.name === product);
    return (found?.versions || []).filter((item) => !item.is_deleted).map((item) => item.version);
  }, [products, product]);

  const save = async () => {
    if (!patch) return;
    if (!name.trim() || !product.trim() || !version.trim()) {
      toast.error('名称、产品、版本为必填项');
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        product_name: product.trim(),
        product_version: version.trim(),
        description: description.trim() || null,
        user_keyword: keyword.trim() || null,
      };
      if (admin) body.status = Number(status);
      await patchApi.update(patch.id, body);
      toast.success('补丁信息已保存');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={Boolean(patch)}
      onClose={onClose}
      title="编辑补丁信息"
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-ink-2">补丁名称 <span className="text-danger">*</span></label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">产品 <span className="text-danger">*</span></label>
            <Input
              value={product}
              list="patch-edit-products"
              onChange={(event) => {
                setProduct(event.target.value);
                if (!products.some((item) => item.name === event.target.value)) setVersion('');
              }}
            />
            <datalist id="patch-edit-products">
              {productOptions.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">版本 <span className="text-danger">*</span></label>
            <Input value={version} list="patch-edit-versions" onChange={(event) => setVersion(event.target.value)} />
            <datalist id="patch-edit-versions">
              {versions.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </div>
        </div>
        {admin && (
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">状态</label>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="input"
            >
              <option value="0">待分析</option>
              <option value="1">分析中</option>
              <option value="2">已分析</option>
              <option value="3">分析失败</option>
            </select>
          </div>
        )}
        <div>
          <label className="mb-1 block text-[12px] font-medium text-ink-2">描述</label>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            className="input h-auto py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-ink-2">用户关键词</label>
          <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="多个关键词用逗号分隔" />
        </div>
        {!admin && (
          <div className="rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-[11.5px] text-warning">
            保存后补丁将重置为待分析状态。
          </div>
        )}
      </div>
    </Dialog>
  );
}
