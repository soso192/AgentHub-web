import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { patchApi } from '../../lib/patch';
import type { ProjectEnv } from '../../lib/types';
import { useAppStore } from '../../store/app';
import { Button, ConfirmDialog, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { useProducts } from './hooks';
import { DataTable, Pagination, type Column } from './DataTable';

interface EnvForm {
  project_name: string;
  product_id: string;
  version_id: string;
  db_connection: string;
  debug_address: string;
  code_directory: string;
  package_path: string;
  patch_output_path: string;
  local_skill_path: string;
  local_jdk_path: string;
}

const EMPTY_FORM: EnvForm = {
  project_name: '',
  product_id: '',
  version_id: '',
  db_connection: '',
  debug_address: '',
  code_directory: '',
  package_path: '',
  patch_output_path: '',
  local_skill_path: '',
  local_jdk_path: '',
};

export function ProjectEnvTab() {
  const toast = useToast();
  const edition = useAppStore((state) => state.edition);
  const novice = edition === 'novice';
  const { products } = useProducts();
  const [rows, setRows] = useState<ProjectEnv[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ProjectEnv | 'new' | null>(null);
  const [form, setForm] = useState<EnvForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<ProjectEnv | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const load = async (nextPage = page, nextSize = size) => {
    setLoading(true);
    try {
      const result = await patchApi.projectEnvsPaged(nextPage, nextSize);
      setRows(result.items || []);
      setTotal(result.total || 0);
      setPage(nextPage);
      setSize(nextSize);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载环境变量失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(1, size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setAdvancedOpen(false);
    if (editing === 'new') {
      setForm(EMPTY_FORM);
    } else if (editing) {
      setForm({
        project_name: editing.project_name || '',
        product_id: String(editing.product_id ?? ''),
        version_id: String(editing.version_id ?? ''),
        db_connection: editing.db_connection || '',
        debug_address: editing.debug_address || '',
        code_directory: editing.code_directory || '',
        package_path: editing.package_path || '',
        patch_output_path: editing.patch_output_path || '',
        local_skill_path: editing.local_skill_path || '',
        local_jdk_path: editing.local_jdk_path || '',
      });
    }
  }, [editing]);

  const versions = useMemo(() => {
    const product = products.find((item) => String(item.id) === form.product_id);
    return (product?.versions || []).filter((item) => !item.is_deleted);
  }, [products, form.product_id]);

  const pickFolder = async (key: keyof EnvForm) => {
    try {
      const result = await api.pickFolder(form[key]);
      if (result.success && result.path) setForm((current) => ({ ...current, [key]: result.path! }));
      else if (result.error) toast.error(result.error);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '打开目录选择器失败');
    }
  };

  const save = async () => {
    if (!form.project_name.trim() || !form.product_id || !form.version_id) {
      toast.error('项目名称、产品、版本为必填项');
      return;
    }
    if (edition === 'novice') {
      // 实施版新增/编辑只需要 home/war 目录；客开目录、JDK、数据库等均为可选
      if (!form.package_path.trim()) {
        toast.error('home / war 目录为必填项');
        return;
      }
    } else if (!form.code_directory.trim() || !form.package_path.trim()) {
      toast.error('客开代码目录和 home/war 目录为必填项');
      return;
    }
    setSaving(true);
    try {
      // 实施版表单没有「补丁输出路径」，保存时不要带上该字段，避免把开发版登记的值清空。
      const { patch_output_path, ...rest } = form;
      const body = {
        ...rest,
        ...(novice ? {} : { patch_output_path }),
        product_id: Number(form.product_id),
        version_id: Number(form.version_id),
      };
      await patchApi.saveProjectEnv(body, editing === 'new' ? undefined : editing?.id);
      toast.success('环境变量已保存');
      setEditing(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const pathField = (
    key: 'code_directory' | 'package_path' | 'patch_output_path' | 'local_jdk_path',
    label: string,
    required = false
  ) => (
    <div key={key} className="sm:col-span-2">
      <label className="mb-1 block text-[12px] font-medium text-ink-2">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      <div className="flex gap-2">
        <Input
          value={form[key]}
          onChange={(event) => setForm({ ...form, [key]: event.target.value })}
        />
        <Button className="shrink-0" icon={<FolderOpen size={14} />} onClick={() => pickFolder(key)}>
          选择
        </Button>
      </div>
    </div>
  );

  const columns: Array<Column<ProjectEnv>> = [
    {
      key: 'project',
      title: '项目',
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{row.project_name}</div>
          <div className="truncate text-[10.5px] text-ink-3">
            {row.product_name || ''} {row.product_version || ''}
          </div>
        </div>
      ),
    },
    {
      key: 'db',
      title: '数据库',
      render: (row) => (
        <span className="block max-w-[220px] truncate font-mono text-[11px] text-ink-3" title={row.db_connection || ''}>
          {row.db_connection || '—'}
        </span>
      ),
    },
    {
      key: 'debug',
      title: '调试地址',
      render: (row) => (
        <span className="block max-w-[160px] truncate text-[11.5px] text-ink-3" title={row.debug_address || ''}>
          {row.debug_address || '—'}
        </span>
      ),
    },
    {
      key: 'code',
      title: '客开代码目录',
      render: (row) => (
        <span className="block max-w-[220px] truncate font-mono text-[11px] text-ink-3" title={row.code_directory || ''}>
          {row.code_directory || '—'}
        </span>
      ),
    },
    {
      key: 'home',
      title: 'home / war',
      render: (row) => (
        <span className="block max-w-[200px] truncate font-mono text-[11px] text-ink-3" title={row.package_path || ''}>
          {row.package_path || '—'}
        </span>
      ),
    },
    {
      key: 'jdk',
      title: '本地 JDK',
      render: (row) => (
        <span className="block max-w-[200px] truncate font-mono text-[11px] text-ink-3" title={row.local_jdk_path || ''}>
          {row.local_jdk_path || '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      width: '150px',
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" icon={<Pencil size={12} />} onClick={() => setEditing(row)}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger hover:text-danger"
            icon={<Trash2 size={12} />}
            onClick={() => setDeleting(row)}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] text-ink-3">共 {total} 个项目环境</div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
          新增环境
        </Button>
      </div>

      <DataTable columns={columns} rows={rows} loading={loading} rowKey={(row) => String(row.id)} empty="暂无项目环境" />
      <Pagination page={page} size={size} total={total} onPage={(next) => void load(next, size)} onSize={(next) => void load(1, next)} />

      <Dialog
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '新增项目环境' : '编辑项目环境'}
        width="max-w-3xl"
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
            <label className="mb-1 block text-[12px] font-medium text-ink-2">项目名称 <span className="text-danger">*</span></label>
            <Input
              value={form.project_name}
              onChange={(event) => setForm({ ...form, project_name: event.target.value })}
            />
          </div>
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

          {novice ? (
            <>
              {pathField('package_path', 'home / war 目录', true)}
              <div className="sm:col-span-2">
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((value) => !value)}
                  className="flex w-full items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-[12px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                >
                  {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>高级选项</span>
                </button>
                {advancedOpen && (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-ink-2">数据库连接</label>
                      <Input
                        value={form.db_connection}
                        onChange={(event) => setForm({ ...form, db_connection: event.target.value })}
                        placeholder={novice ? undefined : 'jdbc:… 或 host:port/db'}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-ink-2">调试地址</label>
                      <Input
                        value={form.debug_address}
                        onChange={(event) => setForm({ ...form, debug_address: event.target.value })}
                        placeholder={novice ? undefined : 'host:port'}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[12px] font-medium text-ink-2">本机 skill 地址</label>
                      <Input
                        value={form.local_skill_path}
                        onChange={(event) => setForm({ ...form, local_skill_path: event.target.value })}
                      />
                    </div>
                    {pathField('code_directory', '客开代码目录')}
                    {pathField('local_jdk_path', '本地 JDK 路径')}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">数据库连接</label>
                <Input
                  value={form.db_connection}
                  onChange={(event) => setForm({ ...form, db_connection: event.target.value })}
                  placeholder={novice ? undefined : 'jdbc:… 或 host:port/db'}
                />
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">调试地址</label>
                <Input
                  value={form.debug_address}
                  onChange={(event) => setForm({ ...form, debug_address: event.target.value })}
                  placeholder={novice ? undefined : 'host:port'}
                />
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">本机 skill 地址</label>
                <Input
                  value={form.local_skill_path}
                  onChange={(event) => setForm({ ...form, local_skill_path: event.target.value })}
                />
              </div>
              {pathField('code_directory', '客开代码目录', !novice)}
              {pathField('package_path', 'home / war 目录', true)}
              {pathField('patch_output_path', '补丁输出路径（选填）')}
              {pathField('local_jdk_path', '本地 JDK 路径', !novice)}
            </>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          setDeleteBusy(true);
          try {
            await patchApi.deleteProjectEnv(deleting.id);
            setDeleting(null);
            toast.success('环境已删除');
            await load();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '删除失败');
          } finally {
            setDeleteBusy(false);
          }
        }}
        title="删除项目环境"
        description={deleting ? `确定删除「${deleting.project_name}」吗？` : ''}
        confirmText="删除"
        danger
        loading={deleteBusy}
      />
    </div>
  );
}
