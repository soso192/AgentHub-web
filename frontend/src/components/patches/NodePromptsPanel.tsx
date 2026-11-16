import { useEffect, useMemo, useState } from 'react';
import { Eye, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import type { NodePromptConfig } from '../../lib/types';
import { Button, ConfirmDialog, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { DataTable, type Column } from './DataTable';
import { ResultBox } from '../ResultBox';

const DEV_STAGES = [
  { value: 'phase1', label: '阶段一 · 排查' },
  { value: 'phase2', label: '阶段二 · 合并' },
  { value: 'retry', label: '重试' },
];
const NOVICE_STAGES = [
  ...DEV_STAGES,
  { value: 'seg_code_dir', label: '环境段 · 代码目录' },
  { value: 'seg_db', label: '环境段 · 数据库' },
  { value: 'seg_debug', label: '环境段 · 调试地址' },
];

const SAMPLE_VALUES: Record<string, string> = {
  product_name: '示例产品',
  product_version: '1.0.0',
  problem_desc: '页面保存时报空指针',
  trigger_url: 'http://127.0.0.1:8080/main',
  mcp_root: 'fbip-82',
  code_directory: 'D:/client/code',
  package_path: 'D:/client/home',
  patch_output_path: 'D:/patches',
  local_jdk_path: 'C:/Java/jdk17',
  local_skill_path: '',
  db_connection: 'jdbc:mysql://127.0.0.1:3306/demo',
  debug_address: '127.0.0.1:5005',
  stage_dir: 'D:/out/run01/step01/work',
  stage_dir_src: 'D:/out/run01/step01/work/src',
  step_dir: 'D:/out/run01/step01',
  turn_dir: 'D:/out/run01/step01',
  turn_dir_aisql: 'D:/out/run01/step01/aisql.sql',
  turn_dir_plan: 'D:/out/run01/step01/分析计划.md',
  turn_dir_changes: 'D:/out/run01/step01/changes.txt',
  turn_dir_conclusion: 'D:/out/run01/step01/结论.md',
  turn_dir_merge: 'D:/out/run01/step01/合并说明.md',
  turn_dir_summary: 'D:/out/run01/step01/总结.md',
  turn_dir_baseline: 'D:/out/run01/step01/baseline',
  turn_dir_report_index: 'D:/out/run01/step01/0_对比报告_首页.html',
  turn_dir_report_diff: 'D:/out/run01/step01/report/diff.html',
  clean_dir: 'D:/out/run01/result/clean',
  patch_prefix: 'patch_FBIP8.2_20261114_1530_',
  patch_user: 'admin',
  retry_n: '2',
  need_debug_log: '是',
  need_diff_report: '是',
  note: '已补充日志',
  log_info: '（日志内容）',
  log_file_name: 'ailog',
  env_extra: '（环境补充）',
  constraints_extra: '（额外约束）',
};

function renderPreview(template: string): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = SAMPLE_VALUES[key];
    if (value == null || value === '') missing.push(key);
    return value ?? '';
  });
  return { text, missing };
}

export function NodePromptsPanel() {
  const toast = useToast();
  const [items, setItems] = useState<NodePromptConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [edition, setEdition] = useState<'dev' | 'novice'>('dev');
  const [editing, setEditing] = useState<NodePromptConfig | 'new' | null>(null);
  const [deleting, setDeleting] = useState<NodePromptConfig | null>(null);
  const [preview, setPreview] = useState<{ text: string; missing: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    product_name: '',
    version_scope: '*',
    stage: 'phase1',
    description: '',
    content: '',
    status: '1',
  });

  const stages = edition === 'novice' ? NOVICE_STAGES : DEV_STAGES;

  const load = async (targetEdition: 'dev' | 'novice' = edition) => {
    setLoading(true);
    try {
      // 带上 edition 参数，支持按版本过滤的服务端；旧服务端会忽略该参数并返回全部
      const payload = (await patchApi.nodePrompts(targetEdition)) as unknown;
      if (Array.isArray(payload)) setItems(payload as NodePromptConfig[]);
      else if (payload && Array.isArray((payload as { items?: unknown }).items)) {
        setItems((payload as { items: NodePromptConfig[] }).items);
      } else {
        setItems([]);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载提示词配置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load('dev');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换开发版/实施版：关闭跨版本弹窗，并重新拉取对应版本列表
  const switchEdition = (value: 'dev' | 'novice') => {
    if (value === edition) return;
    setEdition(value);
    setEditing(null);
    setDeleting(null);
    setPreview(null);
    void load(value);
  };

  const filtered = useMemo(() => {
    // 服务端已按 edition 过滤时行内可能没有 edition 字段，此时直接展示返回结果
    const hasEditionField = items.some((item) => Boolean(item.edition));
    if (!hasEditionField) return items;
    return items.filter((item) => (item.edition || 'dev') === edition);
  }, [items, edition]);

  const open = (item: NodePromptConfig | 'new') => {
    setEditing(item);
    if (item === 'new') {
      setForm({
        product_name: '',
        version_scope: '*',
        stage: stages[0].value,
        description: '',
        content: '',
        status: '1',
      });
    } else {
      setForm({
        product_name: item.product_name || '',
        version_scope: item.version_scope || '*',
        stage: item.stage || stages[0].value,
        description: item.description || '',
        content: item.content || '',
        status: String(item.status ?? 1),
      });
    }
  };

  const save = async () => {
    if (!form.product_name.trim()) {
      toast.error('请填写产品名称');
      return;
    }
    setSaving(true);
    try {
      await patchApi.saveNodePrompt(
        {
          edition,
          product_name: form.product_name.trim(),
          version_scope: form.version_scope.trim() || '*',
          stage: form.stage,
          description: form.description,
          content: form.content,
          status: Number(form.status),
        },
        editing === 'new' ? undefined : editing?.id
      );
      toast.success('已保存');
      setEditing(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (item: NodePromptConfig) => {
    try {
      await patchApi.saveNodePrompt(
        { ...item, status: Number(item.status ?? 1) === 1 ? 0 : 1 },
        item.id
      );
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败');
    }
  };

  const columns: Array<Column<NodePromptConfig>> = [
    {
      key: 'product',
      title: '产品',
      render: (row) => <span className="font-medium text-ink">{row.product_name}</span>,
    },
    {
      key: 'scope',
      title: '版本范围',
      align: 'center',
      render: (row) =>
        row.version_scope === '*' ? (
          <span className="badge badge-accent">所有版本</span>
        ) : (
          <span className="text-ink-3">{row.version_scope}</span>
        ),
    },
    {
      key: 'stage',
      title: '阶段',
      align: 'center',
      render: (row) => (
        <span className="badge badge-muted">
          {stages.find((item) => item.value === row.stage)?.label || row.stage}
        </span>
      ),
    },
    {
      key: 'description',
      title: '描述',
      render: (row) => <span className="text-ink-3">{row.description || '—'}</span>,
    },
    {
      key: 'status',
      title: '状态',
      align: 'center',
      render: (row) =>
        Number(row.status ?? 1) === 1 ? (
          <span className="badge badge-success">启用</span>
        ) : (
          <span className="badge badge-danger">停用</span>
        ),
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      width: '220px',
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" icon={<Eye size={12} />} onClick={() => setPreview(renderPreview(row.content || ''))}>
            预览
          </Button>
          <Button size="sm" icon={<Pencil size={12} />} onClick={() => open(row)}>
            编辑
          </Button>
          <Button size="sm" icon={<Power size={12} />} onClick={() => void toggle(row)}>
            {Number(row.status ?? 1) === 1 ? '停用' : '启用'}
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
            {(['dev', 'novice'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => switchEdition(value)}
                className={`rounded-md px-3 py-1 text-[11.5px] transition-colors ${
                  edition === value ? 'bg-accent text-white' : 'text-ink-3 hover:text-ink'
                }`}
              >
                {value === 'dev' ? '开发版' : '实施版'}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-ink-3">共 {filtered.length} 条配置</span>
        </div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => open('new')}>
          新增配置
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        loading={loading}
        rowKey={(row) => String(row.id)}
        empty={
          <span>
            暂无{edition === 'novice' ? '实施版' : '开发版'}提示词配置
            {items.length > 0 && filtered.length === 0
              ? '（接口返回的数据里没有该版本的记录）'
              : ''}
          </span>
        }
      />

      <Dialog
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '新增智能开发提示词' : '编辑智能开发提示词'}
        width="max-w-4xl"
        footer={
          <>
            <Button
              icon={<Eye size={14} />}
              onClick={() => setPreview(renderPreview(form.content))}
            >
              预览
            </Button>
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">产品名称 <span className="text-danger">*</span></label>
              <Input value={form.product_name} onChange={(event) => setForm({ ...form, product_name: event.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">版本范围</label>
              <Input value={form.version_scope} onChange={(event) => setForm({ ...form, version_scope: event.target.value })} placeholder="* 表示所有版本" />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">阶段</label>
              <select value={form.stage} onChange={(event) => setForm({ ...form, stage: event.target.value })} className="input">
                {stages.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">描述</label>
              <Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">状态</label>
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })} className="input">
                <option value="1">启用</option>
                <option value="0">停用</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">提示词内容</label>
            <textarea
              value={form.content}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
              rows={16}
              className="input h-auto py-2 font-mono text-[12px] leading-5"
              placeholder="支持 {{product_name}}、{{problem_desc}}、{{code_directory}} 等变量"
            />
          </div>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title="提示词预览"
        description="使用示例值渲染，空值占位符会列在下方。"
        width="max-w-3xl"
        footer={
          <Button variant="ghost" onClick={() => setPreview(null)}>
            关闭
          </Button>
        }
      >
        <ResultBox content={preview?.text || '（空）'} maxHeight="max-h-[60vh]" />
        {preview?.missing?.length ? (
          <div className="mt-2 text-[11.5px] text-warning">
            未解析的变量：{Array.from(new Set(preview.missing)).join('、')}
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await patchApi.deleteNodePrompt(deleting.id);
            toast.success('已删除');
            setDeleting(null);
            await load();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '删除失败');
          }
        }}
        title="删除提示词配置"
        description={deleting ? `确定删除「${deleting.product_name} · ${deleting.stage}」吗？` : ''}
        confirmText="删除"
        danger
      />
    </div>
  );
}
