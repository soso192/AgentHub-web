import { useMemo, useRef, useState, type DragEvent } from 'react';
import { FileArchive, UploadCloud, X } from 'lucide-react';
import { patchApi, type UploadMeta } from '../../lib/patch';
import { formatBytes } from '../../lib/utils';
import { Button, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { useProducts } from './hooks';

interface UploadEntry extends UploadMeta {
  key: string;
  status?: 'idle' | 'success' | 'failed';
  error?: string;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export function UploadTab({ onUploaded }: { onUploaded?: () => void }) {
  const toast = useToast();
  const { products, reload } = useProducts();
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files).filter((file) => /\.(zip|rar)$/i.test(file.name));
    if (!list.length) {
      toast.error('请选择 .zip 或 .rar 补丁包');
      return;
    }
    setEntries((current) => [
      ...current,
      ...list.map((file) => ({
        key: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        file,
        name: stripExtension(file.name),
        product_name: '',
        product_version: '',
        description: '',
        user_keyword: '',
        status: 'idle' as const,
      })),
    ]);
    setOpen(true);
  };

  const validate = () => {
    for (const entry of entries) {
      if (!entry.product_name.trim() || !entry.product_version.trim()) {
        toast.error(`「${entry.file.name}」请填写产品和版本`);
        return false;
      }
    }
    return true;
  };

  const upload = async () => {
    if (!entries.length || !validate()) return;
    setUploading(true);
    try {
      const result = await patchApi.upload(entries);
      const failed = result.failed || [];
      const success = result.success || [];
      setEntries((current) =>
        current.map((entry, index) => ({
          ...entry,
          status: index < success.length ? 'success' : 'failed',
          error: failed[index - success.length]?.error || undefined,
        }))
      );
      await reload();
      onUploaded?.();
      if (failed.length === 0) {
        toast.success(`已上传 ${success.length} 个补丁`);
        setOpen(false);
        setEntries([]);
      } else {
        toast.error(`${failed.length} 个补丁上传失败，请检查后重试`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer?.files ?? null);
  };

  const productOptions = useMemo(() => products.map((item) => item.name), [products]);

  return (
    <div className="space-y-3">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
          dragging
            ? 'border-accent bg-accent-soft/40'
            : 'border-line bg-surface/60 hover:border-accent/40 hover:bg-surface-2/60'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".zip,.rar"
          className="hidden"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/25 bg-accent-soft text-accent">
          <UploadCloud size={22} />
        </div>
        <div className="text-[14px] font-medium text-ink">拖拽补丁包到这里，或点击选择文件</div>
        <div className="text-[12px] text-ink-3">支持 .zip / .rar，可多选，单个文件最大 20MB</div>
      </div>

      {entries.length > 0 && !open && (
        <Button variant="primary" onClick={() => setOpen(true)}>
          继续上传（{entries.length} 个待处理）
        </Button>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="补丁信息"
        description="每个补丁都需要选择产品并填写版本号，上传后可重新检索。"
        width="max-w-4xl"
        footer={
          <>
            <span className="mr-auto text-[11.5px] text-ink-3">共 {entries.length} 个文件</span>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={uploading} onClick={upload}>
              开始上传
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {entries.map((entry, index) => {
            const versions =
              products.find((item) => item.name === entry.product_name)?.versions || [];
            return (
              <div
                key={entry.key}
                className={`rounded-xl border p-3 ${
                  entry.status === 'failed'
                    ? 'border-danger/35 bg-danger-soft/40'
                    : entry.status === 'success'
                      ? 'border-success/30 bg-success-soft/30'
                      : 'border-line bg-surface-2/70'
                }`}
              >
                <div className="mb-2 flex items-center gap-2">
                  <FileArchive size={15} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink" title={entry.file.name}>
                    {entry.file.name}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-ink-3">{formatBytes(entry.file.size)}</span>
                  {entry.status === 'success' && <span className="badge badge-success">成功</span>}
                  {entry.status === 'failed' && (
                    <span className="badge badge-danger" title={entry.error}>
                      失败
                    </span>
                  )}
                  <button
                    type="button"
                    className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-danger"
                    onClick={() =>
                      setEntries((current) => current.filter((item) => item.key !== entry.key))
                    }
                    title="移除"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className="mb-1 block text-[10.5px] text-ink-3">补丁名称</label>
                    <Input
                      value={entry.name}
                      onChange={(event) =>
                        setEntries((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, name: event.target.value } : item
                          )
                        )
                      }
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10.5px] text-ink-3">产品 <span className="text-danger">*</span></label>
                    <select
                      value={entry.product_name}
                      onChange={(event) =>
                        setEntries((current) =>
                          current.map((item, i) =>
                            i === index
                              ? { ...item, product_name: event.target.value, product_version: '' }
                              : item
                          )
                        )
                      }
                      className="input"
                    >
                      <option value="">选择产品</option>
                      {productOptions.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[10.5px] text-ink-3">版本 <span className="text-danger">*</span></label>
                    <Input
                      value={entry.product_version}
                      list={`versions-${entry.key}`}
                      onChange={(event) =>
                        setEntries((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, product_version: event.target.value } : item
                          )
                        )
                      }
                      placeholder="例如 1.2.3"
                    />
                    <datalist id={`versions-${entry.key}`}>
                      {versions
                        .filter((item) => !item.is_deleted)
                        .map((item) => (
                          <option key={item.id} value={item.version} />
                        ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="mb-1 block text-[10.5px] text-ink-3">用户关键词</label>
                    <Input
                      value={entry.user_keyword}
                      onChange={(event) =>
                        setEntries((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, user_keyword: event.target.value } : item
                          )
                        )
                      }
                      placeholder="逗号分隔"
                    />
                  </div>
                </div>
                <div className="mt-2">
                  <label className="mb-1 block text-[10.5px] text-ink-3">描述</label>
                  <textarea
                    value={entry.description}
                    onChange={(event) =>
                      setEntries((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, description: event.target.value } : item
                        )
                      )
                    }
                    rows={2}
                    className="input h-auto py-2"
                    placeholder="这个补丁解决什么问题、涉及哪些类…"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Dialog>
    </div>
  );
}
