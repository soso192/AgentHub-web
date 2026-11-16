import { useEffect, useMemo, useState } from 'react';
import { Eye, FolderOpen, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { patchApi } from '../../lib/patch';
import type { WorkflowRunRow, WorkflowTemplate } from '../../lib/types';
import { relativeTime } from '../../lib/utils';
import { AttachmentField } from '../AttachmentField';
import { Button, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { useProducts } from './hooks';
import { DataTable, Pagination, type Column } from './DataTable';

interface DirBinding {
  step_order: number;
  directory_id?: number;
  path?: string;
}

interface DirRowState {
  order: number;
  flowName: string;
  manual: boolean;
  directoryId: string;
  path: string;
}

const STATUS_LABEL: Record<string, string> = {
  running: '执行中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  pending: '待执行',
};

export function SmartTab() {
  const toast = useToast();
  const navigate = useNavigate();
  const { products } = useProducts();
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [businessInput, setBusinessInput] = useState('');
  const [problemFiles, setProblemFiles] = useState<File[]>([]);
  const [productId, setProductId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [starting, setStarting] = useState(false);
  const [dirOpen, setDirOpen] = useState(false);
  const [dirRows, setDirRows] = useState<DirRowState[]>([]);
  const [dirOptions, setDirOptions] = useState<Array<{ id: number | string; name: string; code: string }>>([]);
  const [pendingStart, setPendingStart] = useState<{ templateId: string; input: string } | null>(null);
  const [history, setHistory] = useState<WorkflowRunRow[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [loading, setLoading] = useState(false);

  const loadTemplates = async () => {
    try {
      const list = await patchApi.templates();
      setTemplates((list || []).filter((item) => item.can_use !== false));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载流程模板失败');
    }
  };

  const loadHistory = async (nextPage = page, nextSize = size) => {
    setLoading(true);
    try {
      const result = await patchApi.workflowRuns(nextPage, nextSize);
      setHistory(result.items || []);
      setHistoryTotal(result.total || 0);
      setPage(nextPage);
      setSize(nextSize);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载流程历史失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTemplates();
    void loadHistory(1, size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = templates.find((item) => String(item.id) === templateId);
  const versions = useMemo(() => {
    const product = products.find((item) => String(item.id) === productId);
    return (product?.versions || []).filter((item) => !item.is_deleted);
  }, [products, productId]);

  const create = async (tplId: string, input: string, bindings: DirBinding[]) => {
    const result = await patchApi.createWorkflowRun({
      template_id: Number(tplId),
      business_input: input,
      directory_bindings: bindings,
      product_id: selected?.requires_product && productId ? Number(productId) : undefined,
      version_id: selected?.requires_product && versionId ? Number(versionId) : undefined,
    });
    const runId = result.run_id || result.id;
    if (!runId) throw new Error('创建响应缺少 run_id');
    navigate(`/workflow_run.html?run_id=${encodeURIComponent(String(runId))}`);
  };

  const composeInput = async (raw: string) => {
    if (!problemFiles.length) return raw;
    const cryptoObj = globalThis.crypto as Crypto | undefined;
    const runId = (
      cryptoObj?.randomUUID?.() ||
      `smart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    ).replace(/[^A-Za-z0-9_-]/g, '');
    const paths: string[] = [];
    for (const file of problemFiles) {
      const form = new FormData();
      form.append('file', file, file.name || 'attachment');
      const result = await api.nodeProblemImage(runId, form, file.name);
      if (!result.success) {
        throw new Error(`附件上传失败：${result.error || ''}`);
      }
      if (result.path) paths.push(result.path);
    }
    if (!paths.length) return raw;
    return `${raw}\n\n【附件】用户上传了以下文件，请先用 Read 工具查看（图片可看图，其他文件读取内容）：\n${paths
      .map((path) => `- ${path}`)
      .join('\n')}`;
  };

  const start = async () => {
    if (!templateId) {
      toast.error('请选择流程模板');
      return;
    }
    if (!businessInput.trim() && !problemFiles.length) {
      toast.error('请输入业务需求或上传附件');
      return;
    }
    if (selected?.requires_product && (!productId || !versionId)) {
      toast.error('该模板需要选择产品和版本');
      return;
    }
    setStarting(true);
    try {
      const composedInput = await composeInput(
        businessInput.trim() ||
          `（用户上传了 ${problemFiles.length} 个附件，请先查看）`
      );
      const requirements = await patchApi.directoryRequirements(templateId);
      if ((requirements.steps || []).length) {
        const rows: DirRowState[] = (requirements.steps || []).map((step) => {
          const key = `cc-web-wf-dir:${templateId}:${step.step_order}`;
          let saved = '';
          try {
            saved = localStorage.getItem(key) || '';
          } catch {
            /* ignore */
          }
          const savedId = saved.startsWith('id:') ? saved.slice(3) : '';
          const savedPath = saved.startsWith('path:') ? saved.slice(5) : '';
          return {
            order: step.step_order,
            flowName: step.flow_name || `步骤 ${step.step_order}`,
            manual: Boolean(savedPath) || !(requirements.options || []).length,
            directoryId:
              savedId || (step.default_directory_id != null ? String(step.default_directory_id) : ''),
            path: savedPath,
          };
        });
        setDirRows(rows);
        setDirOptions(requirements.options || []);
        setPendingStart({ templateId, input: composedInput });
        setDirOpen(true);
      } else {
        await create(templateId, composedInput, []);
        setProblemFiles([]);
        toast.success('流程已创建');
        await loadHistory(1, size);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建流程失败');
    } finally {
      setStarting(false);
    }
  };

  const confirmDirs = async () => {
    if (!pendingStart) return;
    const bindings: DirBinding[] = [];
    for (const row of dirRows) {
      if (row.manual) {
        if (!row.path.trim()) {
          toast.error(`请填写步骤 ${row.order} 的本机目录`);
          return;
        }
        bindings.push({ step_order: row.order, path: row.path.trim() });
        localStorage.setItem(`cc-web-wf-dir:${pendingStart.templateId}:${row.order}`, `path:${row.path.trim()}`);
      } else {
        if (!row.directoryId) {
          toast.error(`请为步骤 ${row.order} 选择工作目录`);
          return;
        }
        bindings.push({ step_order: row.order, directory_id: Number(row.directoryId) });
        localStorage.setItem(`cc-web-wf-dir:${pendingStart.templateId}:${row.order}`, `id:${row.directoryId}`);
      }
    }
    setStarting(true);
    try {
      await create(pendingStart.templateId, pendingStart.input, bindings);
      setDirOpen(false);
      setPendingStart(null);
      toast.success('流程已创建');
      await loadHistory(1, size);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建流程失败');
    } finally {
      setStarting(false);
    }
  };

  const columns: Array<Column<WorkflowRunRow>> = [
    {
      key: 'template',
      title: '流程',
      render: (row) => <span className="font-medium text-ink">{row.template_name || row.template_code || '—'}</span>,
    },
    {
      key: 'input',
      title: '业务输入',
      render: (row) => (
        <span className="block max-w-[360px] truncate text-ink-3" title={row.business_input}>
          {row.business_input || '—'}
        </span>
      ),
    },
    {
      key: 'status',
      title: '状态',
      align: 'center',
      render: (row) => (
        <span className={`badge ${row.status === 'success' ? 'badge-success' : row.status === 'failed' ? 'badge-danger' : 'badge-muted'}`}>
          {STATUS_LABEL[row.status || ''] || row.status || '—'}
        </span>
      ),
    },
    {
      key: 'steps',
      title: '进度',
      align: 'center',
      render: (row) => (
        <span className="text-ink-3">
          {row.current_step ?? 0} / {row.step_count ?? 0}
        </span>
      ),
    },
    {
      key: 'updated',
      title: '更新时间',
      render: (row) => <span className="text-ink-3">{relativeTime(row.updated_at)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      width: '140px',
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            icon={<Eye size={12} />}
            onClick={() => navigate(`/workflow_run.html?run_id=${encodeURIComponent(String(row.id))}`)}
          >
            查看
          </Button>
          {['success', 'failed', 'cancelled'].includes(String(row.status)) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:text-danger"
              icon={<Trash2 size={12} />}
              onClick={async () => {
                try {
                  await patchApi.deleteWorkflowRun(row.id);
                  toast.success('已删除');
                  await loadHistory(page, size);
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : '删除失败');
                }
              }}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Play size={15} className="text-accent" />
          <span className="text-[13.5px] font-semibold text-ink">启动智能分析流程</span>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">流程模板 <span className="text-danger">*</span></label>
            <select
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
              className="input"
            >
              <option value="">选择模板</option>
              {templates.map((item) => (
                <option key={String(item.id)} value={String(item.id)}>
                  {item.name}
                </option>
              ))}
            </select>
            {selected?.description && (
              <div className="mt-1 text-[11.5px] leading-5 text-ink-3">{selected.description}</div>
            )}
          </div>
          {selected?.requires_product && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">产品 <span className="text-danger">*</span></label>
                <select
                  value={productId}
                  onChange={(event) => {
                    setProductId(event.target.value);
                    setVersionId('');
                  }}
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
                <select value={versionId} onChange={(event) => setVersionId(event.target.value)} className="input">
                  <option value="">选择版本</option>
                  {versions.map((item) => (
                    <option key={String(item.id)} value={String(item.id)}>
                      {item.version}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div className="lg:col-span-2">
            <label className="mb-1 block text-[12px] font-medium text-ink-2">业务需求 / 问题 <span className="text-danger">*</span></label>
            <AttachmentField
              value={businessInput}
              onChange={setBusinessInput}
              files={problemFiles}
              onFilesChange={setProblemFiles}
              rows={4}
              placeholder="描述要分析的业务需求、问题现象、期望结果…"
            />
          </div>
          <div className="flex items-center gap-2 lg:col-span-2">
            <Button variant="primary" icon={<Play size={14} />} loading={starting} onClick={start}>
              开始流程
            </Button>
            <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void loadTemplates()}>
              刷新模板
            </Button>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold text-ink">运行历史</span>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void loadHistory(page, size)}>
            刷新
          </Button>
        </div>
        <DataTable columns={columns} rows={history} loading={loading} rowKey={(row) => String(row.id)} empty="暂无运行记录" />
        <Pagination page={page} size={size} total={historyTotal} onPage={(next) => void loadHistory(next, size)} onSize={(next) => void loadHistory(1, next)} />
      </div>

      <Dialog
        open={dirOpen}
        onClose={() => setDirOpen(false)}
        title="选择各步骤的工作目录"
        description="这些步骤会在本机执行 Claude，需要指定每步的工作目录。"
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDirOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={starting} onClick={confirmDirs}>
              开始流程
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {dirRows.map((row, index) => (
            <div key={row.order} className="rounded-xl border border-line bg-surface-2 p-3">
              <div className="mb-2 text-[12px] font-medium text-ink-2">
                步骤 {row.order} · {row.flowName}
              </div>
              {dirOptions.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <select
                    value={row.directoryId}
                    disabled={row.manual}
                    onChange={(event) =>
                      setDirRows((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, directoryId: event.target.value } : item
                        )
                      )
                    }
                    className="input max-w-[320px]"
                  >
                    <option value="">选择已有目录</option>
                    {dirOptions.map((option) => (
                      <option key={String(option.id)} value={String(option.id)}>
                        {option.name}（{option.code}）
                      </option>
                    ))}
                  </select>
                  <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
                    <input
                      type="checkbox"
                      checked={row.manual}
                      onChange={(event) =>
                        setDirRows((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, manual: event.target.checked } : item
                          )
                        )
                      }
                    />
                    改用手动路径
                  </label>
                </div>
              )}
              {row.manual && (
                <div className="flex gap-2">
                  <Input
                    value={row.path}
                    onChange={(event) =>
                      setDirRows((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, path: event.target.value } : item
                        )
                      )
                    }
                    placeholder="本机工作目录绝对路径"
                  />
                  <Button
                    className="shrink-0"
                    icon={<FolderOpen size={14} />}
                    onClick={async () => {
                      const result = await api.pickFolder(row.path).catch(() => null);
                      if (result?.success && result.path) {
                        setDirRows((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, path: result.path! } : item
                          )
                        );
                      }
                    }}
                  >
                    选择
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
