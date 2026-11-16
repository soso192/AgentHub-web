import { useEffect, useState } from 'react';
import { Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import type { Product, ProductVersion } from '../../lib/types';
import { Button, ConfirmDialog, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { DataTable, type Column } from './DataTable';

export function ProductsTab() {
  const toast = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [versionProduct, setVersionProduct] = useState<Product | null>(null);
  const [versionText, setVersionText] = useState('');
  const [versionBusy, setVersionBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setProducts(await patchApi.products(true));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载产品失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (editing === 'new') {
      setName('');
      setSortOrder('0');
    } else if (editing) {
      setName(editing.name);
      setSortOrder(String(editing.sort_order ?? 0));
    }
  }, [editing]);

  const save = async () => {
    if (!name.trim()) {
      toast.error('请填写产品名称');
      return;
    }
    setSaving(true);
    try {
      const body = { name: name.trim(), sort_order: Number(sortOrder) || 0 };
      if (editing === 'new') await patchApi.createProduct(body);
      else if (editing) await patchApi.updateProduct(editing.id, body);
      toast.success('已保存');
      setEditing(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const columns: Array<Column<Product>> = [
    {
      key: 'name',
      title: '产品名称',
      render: (row) => (
        <span className={row.is_deleted ? 'text-ink-3 line-through' : 'font-medium text-ink'}>
          {row.name}
        </span>
      ),
    },
    {
      key: 'sort',
      title: '排序',
      align: 'center',
      render: (row) => <span className="text-ink-3">{row.sort_order ?? 0}</span>,
    },
    {
      key: 'versions',
      title: '版本数',
      align: 'center',
      render: (row) => (
        <span className="badge badge-muted">
          {(row.versions || []).filter((item) => !item.is_deleted).length}
        </span>
      ),
    },
    {
      key: 'deleted',
      title: '状态',
      align: 'center',
      render: (row) =>
        row.is_deleted ? (
          <span className="badge badge-danger">已删除</span>
        ) : (
          <span className="badge badge-success">正常</span>
        ),
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      width: '220px',
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" icon={<Layers size={12} />} onClick={() => setVersionProduct(row)}>
            版本
          </Button>
          {!row.is_deleted && (
            <Button size="sm" icon={<Pencil size={12} />} onClick={() => setEditing(row)}>
              编辑
            </Button>
          )}
          {!row.is_deleted && (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:text-danger"
              icon={<Trash2 size={12} />}
              onClick={() => setDeleting(row)}
            >
              删除
            </Button>
          )}
        </div>
      ),
    },
  ];

  const addVersion = async () => {
    if (!versionProduct || !versionText.trim()) return;
    setVersionBusy(true);
    try {
      await patchApi.addVersion(versionProduct.id, versionText.trim());
      setVersionText('');
      const next = await patchApi.products(true);
      setProducts(next);
      setVersionProduct(next.find((item) => String(item.id) === String(versionProduct.id)) || null);
      toast.success('版本已添加');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加版本失败');
    } finally {
      setVersionBusy(false);
    }
  };

  const deleteVersion = async (version: ProductVersion) => {
    if (!versionProduct) return;
    try {
      await patchApi.deleteVersion(versionProduct.id, version.id);
      const next = await patchApi.products(true);
      setProducts(next);
      setVersionProduct(next.find((item) => String(item.id) === String(versionProduct.id)) || null);
      toast.success('版本已删除');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除版本失败');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] text-ink-3">共 {products.length} 个产品（含已删除）</div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
          新增产品
        </Button>
      </div>

      <DataTable columns={columns} rows={products} loading={loading} rowKey={(row) => String(row.id)} empty="暂无产品" />

      <Dialog
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '新增产品' : '编辑产品'}
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">产品名称 <span className="text-danger">*</span></label>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">排序</label>
            <Input
              type="number"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </div>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(versionProduct)}
        onClose={() => setVersionProduct(null)}
        title={`版本管理 · ${versionProduct?.name || ''}`}
        width="max-w-lg"
        footer={
          <Button variant="ghost" onClick={() => setVersionProduct(null)}>
            关闭
          </Button>
        }
      >
        {!versionProduct?.is_deleted && (
          <div className="mb-3 flex gap-2">
            <Input
              value={versionText}
              onChange={(event) => setVersionText(event.target.value)}
              placeholder="新版本号，例如 1.2.3"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addVersion();
              }}
            />
            <Button variant="primary" loading={versionBusy} onClick={addVersion}>
              添加
            </Button>
          </div>
        )}
        <div className="space-y-1.5">
          {(versionProduct?.versions || []).length === 0 ? (
            <div className="py-6 text-center text-[12.5px] text-ink-3">暂无版本</div>
          ) : (
            versionProduct?.versions?.map((version) => (
              <div
                key={String(version.id)}
                className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2"
              >
                <span
                  className={`min-w-0 flex-1 truncate text-[12.5px] ${
                    version.is_deleted ? 'text-ink-3 line-through' : 'text-ink-2'
                  }`}
                >
                  {version.version}
                </span>
                {version.is_deleted ? (
                  <span className="badge badge-danger">已删除</span>
                ) : (
                  <button
                    type="button"
                    className="rounded p-1 text-ink-3 hover:bg-danger-soft hover:text-danger"
                    title="删除版本"
                    onClick={() => void deleteVersion(version)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await patchApi.deleteProduct(deleting.id);
            setDeleting(null);
            toast.success('产品已删除');
            await load();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '删除失败');
          }
        }}
        title="删除产品"
        description={deleting ? `确定删除「${deleting.name}」吗？已上传的补丁不受影响。` : ''}
        confirmText="删除"
        danger
      />
    </div>
  );
}
