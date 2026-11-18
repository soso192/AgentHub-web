import { useEffect, useMemo, useState } from 'react';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import type { FlowConfig, PromptConfig, WorkflowTemplate } from '../../lib/types';
import { Button, Checkbox, ConfirmDialog, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { DataTable, Pagination, type Column } from './DataTable';

type Kind = 'flow' | 'prompt' | 'template';

interface StepForm {
  step_order: number;
  flow_id: string;
  prompt_id: string;
  user_prompt: string;
  save_context_override: string;
}

const KIND_LABEL: Record<Kind, string> = {
  flow: '流程',
  prompt: '提示词',
  template: '流程模板',
};

const TARGETS = [
  { value: 'local', label: '本机 Claude' },
  { value: 'server', label: '服务端' },
];
const DIRECTORY_MODES = [
  { value: 'fixed', label: '固定目录' },
  { value: 'by_product', label: '按产品' },
  { value: 'local_temp', label: '本地临时目录（MCP）' },
];
const RUNTIME_CATEGORIES = [
  { value: 'source', label: '源码' },
  { value: 'patch_library', label: '补丁库' },
  { value: 'workspace', label: '工作区' },
];

function ownership(row: { ownership_scope?: string; is_shared?: boolean }): string {
  if (row.ownership_scope) return row.ownership_scope === 'shared' ? '管理员共享' : row.ownership_scope;
  return row.is_shared ? '管理员共享' : '我的配置';
}

export function AdminConfigTab({ kind }: { kind: Kind }) {
  const toast = useToast();
  const [flows, setFlows] = useState<FlowConfig[]>([]);
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [editing, setEditing] = useState<Record<string, unknown> | 'new' | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string | number; name: string } | null>(null);

  const [form, setForm] = useState({
    code: '',
    name: '',
    description: '',
    status: '1',
    content: '',
    claude_target: 'local',
    directory_mode: 'fixed',
    runtime_category: '',
    directory_code: '',
    save_context: true,
  });
  const [steps, setSteps] = useState<StepForm[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      if (kind === 'flow') setFlows(await patchApi.flows());
      if (kind === 'prompt') setPrompts(await patchApi.prompts());
      if (kind === 'template') {
        const [tpl, flowList, promptList] = await Promise.all([
          patchApi.templates(),
          patchApi.flows(),
          patchApi.prompts(),
        ]);
        setTemplates(tpl);
        setFlows(flowList);
        setPrompts(promptList);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPage(1);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const rows = kind === 'flow' ? flows : kind === 'prompt' ? prompts : templates;
  const sliced = useMemo(() => rows.slice((page - 1) * size, page * size), [rows, page, size]);

  const openNew = () => {
    setEditing('new');
    setReadOnly(false);
    setForm({
      code: '',
      name: '',
      description: '',
      status: '1',
      content: '',
      claude_target: 'local',
      directory_mode: 'fixed',
      runtime_category: '',
      directory_code: '',
      save_context: true,
    });
    setSteps([{ step_order: 1, flow_id: '', prompt_id: '', user_prompt: '', save_context_override: '' }]);
  };

  const openEdit = async (row: unknown, viewOnly = false) => {
    const item = row as Record<string, unknown>;
    setEditing(item);
    setReadOnly(viewOnly);
    setForm({
      code: String(item.code || ''),
      name: String(item.name || ''),
      description: String(item.description || ''),
      status: String(item.status ?? 1),
      content: String(item.content || ''),
      claude_target: String(item.claude_target || 'local'),
      directory_mode: String(item.directory_mode || 'fixed'),
      runtime_category: String(item.runtime_category || ''),
      directory_code: String(item.directory_code || ''),
      save_context: Boolean(item.save_context ?? true),
    });
    if (kind === 'template') {
      try {
        const detail = await patchApi.template(item.id as string | number);
        setSteps(
          (detail.steps || []).map((step) => ({
            step_order: step.step_order,
            flow_id: String(step.flow_id ?? ''),
            prompt_id: String(step.prompt_id ?? ''),
            user_prompt: step.user_prompt || '',
            save_context_override:
              step.save_context_override == null ? '' : String(step.save_context_override),
          }))
        );
      } catch {
        setSteps([]);
      }
    }
  };

  const cloneTemplate = async (row: WorkflowTemplate) => {
    await openEdit(row, false);
    setEditing('new');
    setForm((current) => ({
      ...current,
      code: `${row.code}-copy`,
      name: `${row.name}（副本）`,
    }));
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error('请填写名称');
      return;
    }
    setSaving(true);
    try {
      if (kind === 'flow') {
        if (!form.code.trim()) throw new Error('请填写流程编码');
        await patchApi.saveFlow(
          {
            code: form.code.trim(),
            name: form.name.trim(),
            description: form.description,
            status: Number(form.status),
            claude_target: form.claude_target,
            directory_mode: form.directory_mode,
            runtime_category: form.runtime_category || null,
            directory_code: form.directory_code || null,
            save_context: form.save_context,
          },
          editing === 'new' ? undefined : (editing?.id as string | number)
        );
      } else if (kind === 'prompt') {
        await patchApi.savePrompt(
          {
            name: form.name.trim(),
            description: form.description,
            content: form.content,
            status: Number(form.status),
          },
          editing === 'new' ? undefined : (editing?.id as string | number)
        );
      } else {
        if (!form.code.trim()) throw new Error('请填写模板编码');
        if (steps.some((step) => !step.flow_id)) throw new Error('每个步骤都需要选择流程');
        await patchApi.saveTemplate(
          {
            code: form.code.trim(),
            name: form.name.trim(),
            description: form.description,
            status: Number(form.status),
            steps: steps.map((step, index) => ({
              step_order: index + 1,
              flow_id: Number(step.flow_id),
              prompt_id: step.prompt_id ? Number(step.prompt_id) : null,
              user_prompt: step.user_prompt || null,
              save_context_override:
                step.save_context_override === '' ? null : Number(step.save_context_override),
            })),
          },
          editing === 'new' ? undefined : (editing?.id as string | number)
        );
      }
      toast.success('已保存');
      setEditing(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const columns: Array<Column<Record<string, unknown>>> =
    kind === 'flow'
      ? [
          { key: 'code', title: '编码', render: (row) => <span className="font-mono text-[11.5px]">{String(row.code)}</span> },
          { key: 'name', title: '名称', render: (row) => <span className="font-medium text-ink">{String(row.name)}</span> },
          { key: 'target', title: '执行目标', align: 'center', render: (row) => <span className="badge badge-muted">{String(row.claude_target || '—')}</span> },
          { key: 'mode', title: '目录模式', align: 'center', render: (row) => <span className="text-ink-3">{String(row.directory_mode || '—')}</span> },
          { key: 'scope', title: '归属', align: 'center', render: (row) => <span className="text-[11.5px] text-ink-3">{ownership(row as FlowConfig)}</span> },
        ]
      : kind === 'prompt'
        ? [
            { key: 'name', title: '名称', render: (row) => <span className="font-medium text-ink">{String(row.name)}</span> },
            { key: 'desc', title: '描述', render: (row) => <span className="text-ink-3">{String(row.description || '—')}</span> },
            { key: 'scope', title: '归属', align: 'center', render: (row) => <span className="text-[11.5px] text-ink-3">{ownership(row as PromptConfig)}</span> },
            { key: 'status', title: '状态', align: 'center', render: (row) => (Number(row.status ?? 1) === 0 ? <span className="badge badge-danger">停用</span> : <span className="badge badge-success">启用</span>) },
          ]
        : [
            { key: 'code', title: '编码', render: (row) => <span className="font-mono text-[11.5px]">{String(row.code)}</span> },
            { key: 'name', title: '名称', render: (row) => <span className="font-medium text-ink">{String(row.name)}</span> },
            { key: 'steps', title: '步骤数', align: 'center', render: (row) => <span className="badge badge-muted">{(row.steps as unknown[] | undefined)?.length ?? '—'}</span> },
            { key: 'scope', title: '归属', align: 'center', render: (row) => <span className="text-[11.5px] text-ink-3">{ownership(row as WorkflowTemplate)}</span> },
          ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] text-ink-3">共 {rows.length} 个{KIND_LABEL[kind]}</div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={openNew}>
          新增{KIND_LABEL[kind]}
        </Button>
      </div>

      <DataTable
        columns={[
          ...columns,
          {
            key: 'actions',
            title: '操作',
            align: 'right',
            width: '220px',
            render: (row) => {
              const canEdit = row.can_edit !== false;
              const canDelete = row.can_delete !== false;
              return (
                <div className="flex items-center justify-end gap-1">
                  <Button
                    size="sm"
                    icon={<Pencil size={12} />}
                    onClick={() => void openEdit(row, !canEdit)}
                  >
                    {canEdit ? '编辑' : '查看'}
                  </Button>
                  {kind === 'template' && (
                    <Button size="sm" icon={<Copy size={12} />} onClick={() => void cloneTemplate(row as unknown as WorkflowTemplate)}>
                      复制
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger hover:text-danger"
                      icon={<Trash2 size={12} />}
                      onClick={() => setDeleting({ id: row.id as string | number, name: String(row.name) })}
                    />
                  )}
                </div>
              );
            },
          },
        ]}
        rows={sliced}
        loading={loading}
        rowKey={(row) => String(row.id)}
        empty={`暂无${KIND_LABEL[kind]}`}
      />
      <Pagination page={page} size={size} total={rows.length} onPage={setPage} onSize={(next) => { setSize(next); setPage(1); }} />

      <Dialog
        open={editing != null}
        onClose={() => setEditing(null)}
        title={`${readOnly ? '查看' : editing === 'new' ? '新增' : '编辑'}${KIND_LABEL[kind]}`}
        width="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {readOnly ? '关闭' : '取消'}
            </Button>
            {!readOnly && (
              <Button variant="primary" loading={saving} onClick={save}>
                保存
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-3">
          {(kind === 'flow' || kind === 'template') && (
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">编码 <span className="text-danger">*</span></label>
              <Input
                value={form.code}
                disabled={readOnly || (kind === 'flow' && editing !== 'new')}
                onChange={(event) => setForm({ ...form, code: event.target.value })}
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">名称 <span className="text-danger">*</span></label>
            <Input
              value={form.name}
              disabled={readOnly}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">描述</label>
            <Input
              value={form.description}
              disabled={readOnly}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </div>

          {kind === 'flow' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">执行目标</label>
                <select
                  value={form.claude_target}
                  disabled={readOnly}
                  onChange={(event) => setForm({ ...form, claude_target: event.target.value })}
                  className="input"
                >
                  {TARGETS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">目录模式</label>
                <select
                  value={form.directory_mode}
                  disabled={readOnly}
                  onChange={(event) => setForm({ ...form, directory_mode: event.target.value })}
                  className="input"
                >
                  {DIRECTORY_MODES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              {form.directory_mode === 'by_product' && (
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-ink-2">运行目录类型</label>
                  <select
                    value={form.runtime_category}
                    disabled={readOnly}
                    onChange={(event) => setForm({ ...form, runtime_category: event.target.value })}
                    className="input"
                  >
                    <option value="">选择类型</option>
                    {RUNTIME_CATEGORIES.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">目录编码</label>
                <Input
                  value={form.directory_code}
                  disabled={readOnly}
                  onChange={(event) => setForm({ ...form, directory_code: event.target.value })}
                />
              </div>
              <div className="flex items-end pb-1.5">
                <Checkbox
                  checked={form.save_context}
                  disabled={readOnly}
                  onChange={(checked) => setForm({ ...form, save_context: checked })}
                  label="保存上下文"
                />
              </div>
            </div>
          )}

          {kind === 'prompt' && (
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">提示词内容</label>
              <textarea
                value={form.content}
                disabled={readOnly}
                onChange={(event) => setForm({ ...form, content: event.target.value })}
                rows={12}
                className="input h-auto py-2 font-mono text-[12px]"
              />
            </div>
          )}

          {kind === 'template' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-ink-2">步骤</span>
                {!readOnly && (
                  <Button
                    size="sm"
                    icon={<Plus size={12} />}
                    onClick={() =>
                      setSteps((current) => [
                        ...current,
                        { step_order: current.length + 1, flow_id: '', prompt_id: '', user_prompt: '', save_context_override: '' },
                      ])
                    }
                  >
                    添加步骤
                  </Button>
                )}
              </div>
              {steps.map((step, index) => (
                <div key={index} className="rounded-xl border border-line bg-surface-2 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[12px] font-medium text-ink-2">步骤 {index + 1}</span>
                    {!readOnly && steps.length > 1 && (
                      <button
                        type="button"
                        className="text-ink-3 hover:text-danger"
                        onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <select
                      value={step.flow_id}
                      disabled={readOnly}
                      onChange={(event) =>
                        setSteps((current) =>
                          current.map((item, i) => (i === index ? { ...item, flow_id: event.target.value } : item))
                        )
                      }
                      className="input"
                    >
                      <option value="">选择流程 *</option>
                      {flows.map((flow) => (
                        <option key={String(flow.id)} value={String(flow.id)}>
                          {flow.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={step.prompt_id}
                      disabled={readOnly}
                      onChange={(event) =>
                        setSteps((current) =>
                          current.map((item, i) => (i === index ? { ...item, prompt_id: event.target.value } : item))
                        )
                      }
                      className="input"
                    >
                      <option value="">选择提示词</option>
                      {prompts.map((prompt) => (
                        <option key={String(prompt.id)} value={String(prompt.id)}>
                          {prompt.name}
                        </option>
                      ))}
                    </select>
                    <textarea
                      value={step.user_prompt}
                      disabled={readOnly}
                      onChange={(event) =>
                        setSteps((current) =>
                          current.map((item, i) => (i === index ? { ...item, user_prompt: event.target.value } : item))
                        )
                      }
                      rows={2}
                      placeholder="用户提示词（第 2 步起必填，可用 {{business_input}}、{{step.1.result}}）"
                      className="input h-auto py-2 sm:col-span-2"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            const endpoint = kind === 'flow' ? 'flows' : kind === 'prompt' ? 'prompts' : 'templates';
            await patchApi.deleteConfig(endpoint, deleting.id);
            toast.success('已删除');
            setDeleting(null);
            await load();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '删除失败');
          }
        }}
        title={`删除${KIND_LABEL[kind]}`}
        description={deleting ? `确定删除「${deleting.name}」吗？` : ''}
        confirmText="删除"
        danger
      />
    </div>
  );
}
