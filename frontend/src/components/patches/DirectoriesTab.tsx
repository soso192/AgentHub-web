import { useEffect, useMemo, useState } from 'react';
import { Ban, FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { patchApi } from '../../lib/patch';
import type { WorkDirectory } from '../../lib/types';
import { Button, Checkbox, ConfirmDialog, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { useDirectories, useProducts } from './hooks';
import { DataTable, Pagination, type Column } from './DataTable';

const CATEGORIES = [
  { value: 'custom', label: '自定义' },
  { value: 'source', label: '源码' },
  { value: 'patch_library', label: '补丁库' },
  { value: 'workspace', label: '工作区' },
];

export function DirectoriesTab({ admin }: { admin: boolean }) {
  const toast = useToast();
  const { directories, loading, reload } = useDirectories();
  const { products } = useProducts();
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [editing, setEditing] = useState<WorkDirectory | 'new' | null>(null);
  const [form, setForm] = useState({
    code: '',
    name: '',
    path: '',
    category: 'custom',
    product_id: '',
    version_id: '',
    is_builtin: false,
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<WorkDirectory | null>(null);
  const [deletePermanent, setDeletePermanent] = useState(false);

  useEffect(() => {
    if (editing === 'new') {
      setForm({ code: '', name: '', path: '', category: 'custom', product_id: '', version_id: '', is_builtin: false });
    } else if (editing) {
      setForm({
        code: editing.code || '',
        name: editing.name || '',
        path: editing.path || '',
        category: editing.category || 'custom',
        product_id: editing.product_id != null ? String(editing.product_id) : '',
        version_id: editing.version_id != null ? String(editing.version_id) : '',
        is_builtin: Boolean(editing.is_builtin),
      });
    }
  }, [editing]);

  const sliced = useMemo(
    () => directories.slice((page - 1) * size, page * size),
    [directories, page, size]
  );

  const versions = useMemo(() => {
    const product = products.find((item) => String(item.id) === form.product_id);
    return (product?.versions || []).filter((item) => !item.is_deleted);
  }, [products, form.product_id]);

  const save = async () => {
    if (!form.code.trim() || !form.name.trim() || !form.path.trim()) {
      toast.error('编码、名称、路径为必填项');
      return;
    }
    if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(form.path.trim())) {
      toast.error('路径必须是绝对路径');
      return;
    }
    if (form.category === 'source' && (!form.product_id || !form.version_id)) {
      toast.error('源码目录需要选择产品和版本');
      return;
    }
    setSaving(true);
    try {
      await patchApi.saveDirectory(
        {
          code: form.code.trim(),
          name: form.name.trim(),
          path: form.path.trim(),
          category: form.category,
          product_id: form.product_id ? Number(form.product_id) : null,
          version_id: form.version_id ? Number(form.version_id) : null,
          is_builtin: form.is_builtin,
        },
        editing === 'new' ? undefined : editing?.id
      );
      toast.success('目录已保存');
      setEditing(null);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const columns: Array<Column<WorkDirectory>> = [
    {
      key: 'code',
      title: '编码',
      render: (row) => <span className="font-mono text-[11.5px] text-ink-2">{row.code}</span>,
    },
    {
      key: 'name',
      title: '名称',
      render: (row) => <span className="font-medium text-ink">{row.name}</span>,
    },
    {
      key: 'path',
      title: '路径',
      render: (row) => (
        <span className="block max-w-[280px] truncate font-mono text-[11px] text-ink-3" title={row.path}>
          {row.path}
        </span>
      ),
    },
    {
      key: 'category',
      title: '分类',
      align: 'center',
      render: (row) => (
        <span className="badge badge-muted">
          {CATEGORIES.find((item) => item.value === row.category)?.label || row.category || '—'}
        </span>
      ),
    },
    {
      key: 'owner',
      title: '归属',
      align: 'center',
      render: (row) => (
        <span className="text-[11.5px] text-ink-3">
          {row.is_builtin ? '内置' : '个人'}
        </span>
      ),
    },
    {
      key: 'status',
      title: '状态',
      align: 'center',
      render: (row) =>
        row.status === 0 ? (
          <span className="badge badge-danger">停用</span>
        ) : (
          <span className="badge badge-success">启用</span>
        ),
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      width: '200px',
      render: (row) => {
        const readOnly = Boolean(row.is_builtin) && !admin;
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              size="sm"
              disabled={readOnly}
              icon={<Pencil size={12} />}
              onClick={() => setEditing(row)}
            >
              编辑
            </Button>
            <Button
              size="sm"
              disabled={readOnly || row.status === 0}
              icon={<Ban size={12} />}
              onClick={async () => {
                try {
                  await patchApi.disableDirectory(row.id);
                  toast.success('目录已停用');
                  await reload();
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : '停用失败');
                }
              }}
            >
              停用
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnly}
              className="text-danger hover:text-danger"
              icon={<Trash2 size={12} />}
              onClick={() => {
                setDeletePermanent(true);
                setDeleting(row);
              }}
            />
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] text-ink-3">共 {directories.length} 个工作目录</div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
          新增目录
        </Button>
      </div>

      <DataTable columns={columns} rows={sliced} loading={loading} rowKey={(row) => String(row.id)} empty="暂无工作目录" />
      <Pagination page={page} size={size} total={directories.length} onPage={setPage} onSize={(next) => { setSize(next); setPage(1); }} />

      <Dialog
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '新增工作目录' : '编辑工作目录'}
        width="max-w-2xl"
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">编码 <span className="text-danger">*</span></label>
            <Input
              value={form.code}
              disabled={editing !== 'new'}
              onChange={(event) => setForm({ ...form, code: event.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">名称 <span className="text-danger">*</span></label>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[12px] font-medium text-ink-2">路径 <span className="text-danger">*</span></label>
            <div className="flex gap-2">
              <Input value={form.path} onChange={(event) => setForm({ ...form, path: event.target.value })} />
              <Button
                className="shrink-0"
                icon={<FolderOpen size={14} />}
                onClick={async () => {
                  const result = await api.pickFolder(form.path).catch(() => null);
                  if (result?.success && result.path) setForm({ ...form, path: result.path });
                }}
              >
                选择
              </Button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">分类</label>
            <select
              value={form.category}
              onChange={(event) => setForm({ ...form, category: event.target.value })}
              className="input"
            >
              {CATEGORIES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          {form.category === 'source' && (
            <>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">产品 <span className="text-danger">*</span></label>
                <select
                  value={form.product_id}
                  onChange={(event) => setForm({ ...form, product_id: event.target.value, version_id: '' })}
                  className="input"
                >
                  <option value="">选择产品</option>
                  {products.map((item) => (
                    <option key={String(item.id)} value={String(item.id)}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">版本 <span className="text-danger">*</span></label>
                <select
                  value={form.version_id}
                  onChange={(event) => setForm({ ...form, version_id: event.target.value })}
                  className="input"
                >
                  <option value="">选择版本</option>
                  {versions.map((item) => (
                    <option key={String(item.id)} value={String(item.id)}>
                      {item.version}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="flex items-end pb-1.5">
            <Checkbox
              checked={form.is_builtin}
              disabled={!admin}
              onChange={(checked) => setForm({ ...form, is_builtin: checked })}
              label="内置目录（管理员）"
            />
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            if (deletePermanent) await patchApi.deleteDirectory(deleting.id);
            else await patchApi.disableDirectory(deleting.id);
            toast.success(deletePermanent ? '目录已删除' : '目录已停用');
            setDeleting(null);
            await reload();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '操作失败');
          }
        }}
        title={deletePermanent ? '永久删除目录' : '停用目录'}
        description={
          deleting
            ? deletePermanent
              ? `确定永久删除「${deleting.name}」吗？引用它的流程模板将无法解析。`
              : `确定停用「${deleting.name}」吗？`
            : ''
        }
        confirmText={deletePermanent ? '永久删除' : '停用'}
        danger
      />
    </div>
  );
}
