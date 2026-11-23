import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ArrowRightLeft,
  Eye,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, getPatchServers, request } from '../../lib/api';
import { patchApi } from '../../lib/patch';
import type { AdaptLedgerRow, PatchRow } from '../../lib/types';
import { formatBytes, relativeTime } from '../../lib/utils';
import { AttachmentField } from '../AttachmentField';
import { Button, ConfirmDialog, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { useProjectEnvs } from './hooks';
import { DataTable, type Column } from './DataTable';

interface AdaptEntry {
  key: string;
  kind: 'file' | 'patch';
  file?: File;
  patch_id?: string | number;
  name: string;
  size?: number;
  problem_desc: string;
  files: File[];
  dir?: string;
  status: 'idle' | 'working' | 'done' | 'failed';
  error?: string;
}

const STATUS_LABEL: Record<string, string> = {
  running: '执行中',
  awaiting_confirmation: '待确认',
  done: '已完成',
  failed: '失败',
  aborted: '已中止',
};

export function AdaptTab({
  preset,
  onPresetConsumed,
}: {
  preset?: PatchRow | null;
  onPresetConsumed?: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const { envs } = useProjectEnvs();
  const [ledger, setLedger] = useState<AdaptLedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<AdaptEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [projectDir, setProjectDir] = useState('');
  const [envId, setEnvId] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdaptLedgerRow | null>(null);
  const runIdRef = useRef('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const rows = await patchApi.adaptLedger();
      setLedger(rows || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载适配记录失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!preset) return;
    setEntries((current) => [
      ...current,
      {
        key: `patch-${preset.id}-${Date.now()}`,
        kind: 'patch',
        patch_id: preset.id,
        name: preset.name || preset.file_name || '补丁',
        size: preset.file_size,
        problem_desc: '',
        files: [],
        status: 'idle',
      },
    ]);
    setOpen(true);
    onPresetConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const selectedEnv = useMemo(
    () => envs.find((item) => String(item.id) === envId),
    [envs, envId]
  );

  useEffect(() => {
    if (!selectedEnv) return;
    if (selectedEnv.code_directory) setProjectDir(selectedEnv.code_directory);
  }, [selectedEnv]);

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files).filter((file) => /\.(zip|rar)$/i.test(file.name));
    if (!list.length) {
      toast.error('请选择 .zip / .rar 补丁包');
      return;
    }
    setEntries((current) => [
      ...current,
      ...list.map((file) => ({
        key: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: 'file' as const,
        file,
        name: file.name.replace(/\.[^.]+$/, ''),
        size: file.size,
        problem_desc: '',
        files: [],
        status: 'idle' as const,
      })),
    ]);
    setOpen(true);
  };

  const start = async () => {
    if (!entries.length) return;
    if (!projectDir.trim()) {
      toast.error('请选择客开工程目录');
      return;
    }
    for (const entry of entries) {
      if (!entry.problem_desc.trim() && !entry.files.length) {
        toast.error(`请填写「${entry.name}」的问题描述或上传附件`);
        return;
      }
    }
    try {
      const git = await api.adapt.gitStatus(projectDir.trim());
      if (git && (git as { is_git?: boolean }).is_git && (git as { has_changes?: boolean }).has_changes) {
        setConfirmOpen(true);
        return;
      }
      await doStart();
    } catch {
      setConfirmOpen(true);
    }
  };

  const doStart = async () => {
    setConfirmOpen(false);
    setBusy(true);
    try {
      const { servers, token } = await getPatchServers();
      const serverUrl = servers[0] || '';
      const runId =
        (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ||
        `adapt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      runIdRef.current = runId;

      const items: Array<{
        seq: number;
        patch_name: string;
        problem_desc: string;
        dir: string;
      }> = [];

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        setEntries((current) =>
          current.map((item, i) => (i === index ? { ...item, status: 'working' } : item))
        );
        let dir = '';
        if (entry.kind === 'file' && entry.file) {
          const result = await api.adapt.upload(runId, index + 1, entry.file);
          if (!result.success || !result.dir) throw new Error(result.error || '补丁上传失败');
          dir = result.dir;
        } else {
          const result = await api.adapt.importPatch({
            run_id: runId,
            seq: index + 1,
            patch_id: String(entry.patch_id),
            patch_name: entry.name,
            server_url: serverUrl,
            auth_token: token,
          });
          if (typeof result.dir !== 'string') throw new Error('补丁导入失败');
          dir = result.dir;
        }
        const attachmentPaths: string[] = [];
        for (const file of entry.files) {
          const form = new FormData();
          form.append('file', file, file.name || 'attachment');
          const uploaded = await api.nodeProblemImage(runId, form, file.name);
          if (!uploaded.success) {
            throw new Error(`「${entry.name}」附件上传失败：${uploaded.error || ''}`);
          }
          if (uploaded.path) attachmentPaths.push(uploaded.path);
        }
        let problemDesc = entry.problem_desc.trim();
        if (!problemDesc && attachmentPaths.length) {
          problemDesc = `（已上传 ${attachmentPaths.length} 个问题附件，请查看）`;
        }
        if (attachmentPaths.length) {
          problemDesc +=
            '\n\n【附件】用户上传了以下文件，请先用 Read 工具查看（图片可看图，其他文件读取内容）：\n' +
            attachmentPaths.map((path) => `- ${path}`).join('\n');
        }

        items.push({
          seq: index + 1,
          patch_name: entry.name,
          problem_desc: problemDesc,
          dir,
        });
        setEntries((current) =>
          current.map((item, i) => (i === index ? { ...item, status: 'done' } : item))
        );
      }

      const version = selectedEnv
        ? {
            product_name: selectedEnv.product_name || '',
            product_version: selectedEnv.product_version || '',
          }
        : { product_name: '', product_version: '' };

      const result = await api.adapt.start({
        project_dir: projectDir.trim(),
        ...version,
        server_url: serverUrl,
        auth_token: token,
        items,
      });
      if (result && (result as { success?: boolean }).success === false) {
        throw new Error((result as { error?: string }).error || '启动适配失败');
      }
      toast.success('适配已开始，可关闭页面等待完成');
      setOpen(false);
      setEntries([]);
      await load();
      const createdId = (result as { run_id?: string }).run_id;
      if (createdId) {
        navigate(`/adapt_run.html?run_id=${encodeURIComponent(createdId)}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '启动适配失败');
      setEntries((current) =>
        current.map((item) => (item.status === 'working' ? { ...item, status: 'failed' } : item))
      );
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<AdaptLedgerRow>> = [
    {
      key: 'time',
      title: '时间',
      render: (row) => <span className="text-ink-3">{relativeTime(row.created_at)}</span>,
    },
    {
      key: 'product',
      title: '产品 / 版本',
      render: (row) => (
        <span className="text-ink-2">
          {row.product_name || '—'} {row.product_version || ''}
        </span>
      ),
    },
    {
      key: 'dir',
      title: '客开工程目录',
      render: (row) => (
        <span className="block max-w-[260px] truncate font-mono text-[11px] text-ink-3" title={row.code_directory}>
          {row.code_directory || '—'}
        </span>
      ),
    },
    {
      key: 'status',
      title: '状态',
      align: 'center',
      render: (row) => (
        <span
          className={`badge ${
            row.status === 'done'
              ? 'badge-success'
              : row.status === 'failed' || row.status === 'aborted'
                ? 'badge-danger'
                : 'badge-warning'
          }`}
        >
          {STATUS_LABEL[row.status || ''] || row.status || '—'}
        </span>
      ),
    },
    {
      key: 'count',
      title: '补丁数',
      align: 'center',
      render: (row) => <span className="text-ink-3">{row.patch_count ?? 0}</span>,
    },
    {
      key: 'result',
      title: '结果',
      render: (row) => (
        <span className="text-[11.5px]">
          <span className="text-success">成功 {row.succeeded_count ?? 0}</span>
          <span className="mx-1 text-ink-3">/</span>
          <span className="text-warning">冲突 {row.conflict_count ?? 0}</span>
          <span className="mx-1 text-ink-3">/</span>
          <span className="text-danger">失败 {row.failed_count ?? 0}</span>
        </span>
      ),
    },
    {
      key: 'host',
      title: '执行机器',
      render: (row) => <span className="text-ink-3">{row.client_host || '—'}</span>,
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
            onClick={() => navigate(`/adapt_run.html?run_id=${encodeURIComponent(row.local_run_id)}`)}
          >
            详情
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger hover:text-danger"
            icon={<Trash2 size={12} />}
            onClick={() => setDeleteTarget(row)}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div
        onDragOver={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer?.files ?? null);
        }}
        onClick={() => fileRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface/60 hover:border-accent/40'
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".zip,.rar"
          className="hidden"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <UploadCloud size={22} className="text-accent" />
        <span className="text-[13px] font-medium text-ink">拖入补丁包开始适配</span>
        <span className="text-[11.5px] text-ink-3">支持 .zip / .rar，可多选；也可以从「普通检索」里点「适配」</span>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[12.5px] text-ink-3">共 {ledger.length} 条适配记录</span>
        <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => void load()}>
          刷新
        </Button>
      </div>

      <DataTable columns={columns} rows={ledger} loading={loading} rowKey={(row) => row.local_run_id} empty="暂无适配记录" />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="开始补丁适配"
        description="为每个补丁填写问题描述，并指定客开工程目录。"
        width="max-w-4xl"
        footer={
          <>
            <span className="mr-auto text-[11.5px] text-ink-3">共 {entries.length} 个补丁</span>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} icon={<ArrowRightLeft size={14} />} onClick={start}>
              开始适配
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">客开工程目录 <span className="text-danger">*</span></label>
              <div className="flex gap-2">
                <Input value={projectDir} onChange={(event) => setProjectDir(event.target.value)} />
                <Button
                  className="shrink-0"
                  icon={<FolderOpen size={14} />}
                  onClick={async () => {
                    const result = await api.pickFolder(projectDir).catch(() => null);
                    if (result?.success && result.path) setProjectDir(result.path);
                  }}
                >
                  选择
                </Button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">项目环境（可选）</label>
              <select
                value={envId}
                onChange={(event) => setEnvId(event.target.value)}
                className="input"
              >
                <option value="">不指定</option>
                {envs.map((env) => (
                  <option key={String(env.id)} value={String(env.id)}>
                    {env.project_name} · {env.product_name} {env.product_version}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {entries.map((entry, index) => (
            <div key={entry.key} className="rounded-xl border border-line bg-surface-2 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{entry.name}</span>
                {entry.size != null && (
                  <span className="text-[10.5px] text-ink-3">{formatBytes(entry.size)}</span>
                )}
                {entry.status === 'working' && <Loader2 size={13} className="animate-spin text-accent" />}
                {entry.status === 'done' && <span className="badge badge-success">已准备</span>}
                {entry.status === 'failed' && <span className="badge badge-danger">失败</span>}
                {!busy && (
                  <button
                    type="button"
                    className="text-ink-3 hover:text-danger"
                    onClick={() => setEntries((current) => current.filter((_, i) => i !== index))}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              <AttachmentField
                value={entry.problem_desc}
                onChange={(value) =>
                  setEntries((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, problem_desc: value } : item
                    )
                  )
                }
                files={entry.files}
                onFilesChange={(files) =>
                  setEntries((current) =>
                    current.map((item, i) => (i === index ? { ...item, files } : item))
                  )
                }
                rows={3}
                placeholder="这个补丁解决的问题、复现步骤、涉及模块…"
              />
            </div>
          ))}
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={doStart}
        title="继续适配？"
        description={
          '客开工程目录不是 Git 仓库或存在未提交改动。\n\n适配过程会修改该目录下的文件，建议先提交或备份。确定继续吗？'
        }
        confirmText="仍然继续"
        danger
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            const { servers, token } = await getPatchServers();
            await request(`/api/adapt/runs/${encodeURIComponent(deleteTarget.local_run_id)}/delete`, {
              method: 'POST',
              body: JSON.stringify({ server_url: servers[0] || '', auth_token: token }),
            });
            setDeleteTarget(null);
            toast.success('记录已删除');
            await load();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '删除失败');
          }
        }}
        title="删除适配记录"
        description={deleteTarget ? `确定删除「${deleteTarget.product_name || deleteTarget.local_run_id}」的适配记录吗？本地补丁文件不会被删除。` : ''}
        confirmText="删除"
        danger
      />
    </div>
  );
}
