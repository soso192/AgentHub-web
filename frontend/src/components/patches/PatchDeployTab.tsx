import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArchiveRestore,
  ChevronRight,
  Download,
  FileArchive,
  FolderOpen,
  FolderTree,
  Loader2,
  PackageCheck,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Trash2,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  patchDeployApi,
  type PatchDeployArchive,
  type PatchDeployBatch,
  type PatchDeployBatchFile,
  type PatchDeployEntry,
  type PatchDeployEnv,
  type PatchDeployPlan,
  type PatchDeployResult,
} from '../../lib/patchDeploy';
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, Input, Select, Spinner } from '../ui';
import { ResultBox } from '../ResultBox';
import { useToast } from '../ui/toast';
import { DataTable, type Column } from './DataTable';
import { useProjectEnvs } from './hooks';

/** 后端没有返回 service_key 时的兜底：只统一分隔符和末尾斜杠，不改大小写。 */
function fallbackServiceKey(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function batchServiceKey(batch: PatchDeployBatch): string {
  return batch.service_key || fallbackServiceKey(batch.target_root);
}

interface ServiceItem {
  key: string;
  target_root: string;
  label: string;
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  files: Array<{ name: string; entry: PatchDeployEntry }>;
}

interface TreeStats {
  replace: number;
  add: number;
  ignored: number;
  error: number;
}

function buildTree(entries: PatchDeployEntry[]): TreeNode {
  const root: TreeNode = { name: '', children: new Map(), files: [] };
  for (const entry of entries) {
    const full = entry.target_rel || entry.archive_path || '';
    const parts = full.split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      if (!node.children.has(name)) {
        node.children.set(name, { name, children: new Map(), files: [] });
      }
      node = node.children.get(name)!;
    }
    node.files.push({ name: parts[parts.length - 1], entry });
  }
  return root;
}

function treeStats(node: TreeNode): TreeStats {
  const result: TreeStats = { replace: 0, add: 0, ignored: 0, error: 0 };
  for (const child of node.children.values()) {
    const sub = treeStats(child);
    result.replace += sub.replace;
    result.add += sub.add;
    result.ignored += sub.ignored;
    result.error += sub.error;
  }
  for (const item of node.files) {
    if (item.entry.status === 'replace') result.replace += 1;
    else if (item.entry.status === 'add') result.add += 1;
    else if (item.entry.status === 'ignored') result.ignored += 1;
    else if (item.entry.status === 'error') result.error += 1;
  }
  return result;
}

function entryBadges(entry: PatchDeployEntry) {
  return (
    <>
      {entry.status === 'replace' && <Badge tone="warning">已存在</Badge>}
      {entry.status === 'add' && <Badge tone="success">新增</Badge>}
      {entry.status === 'ignored' && <Badge tone="muted">忽略</Badge>}
      {entry.status === 'error' && <Badge tone="danger">错误</Badge>}
      {entry.shadow_jar && (
        <Badge tone="accent" title={`jar: ${entry.shadow_jar}`}>
          jar内同名类
        </Badge>
      )}
    </>
  );
}

function TreeDir({ node }: { node: TreeNode }) {
  const stats = treeStats(node);
  const conflicts = stats.replace + stats.error;
  const dirs = Array.from(node.children.values()).sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-CN')
  );
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return (
    <details className="pd-dir" open={conflicts > 0}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="pd-arrow shrink-0 text-ink-3" />
        <FolderTree size={13} className="shrink-0 text-ink-3" />
        <span className="font-medium">{node.name}</span>
        {stats.replace > 0 && (
          <Badge tone="warning">{stats.replace} 个已存在</Badge>
        )}
        {stats.error > 0 && <Badge tone="danger">{stats.error} 个错误</Badge>}
        {stats.replace === 0 && stats.error === 0 && (
          <span className="text-[10.5px] text-ink-3">{stats.add + stats.ignored} 个</span>
        )}
      </summary>
      <div className="ml-3 border-l border-line pl-2">
        {dirs.map((child) => (
          <TreeDir key={child.name} node={child} />
        ))}
        {files.map(({ name, entry }) => (
          <div
            key={`${entry.archive_path}-${entry.target_rel}`}
            className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-surface-2"
            title={entry.error || entry.ignore_reason || entry.warning || entry.target_rel}
          >
            <FileArchive size={13} className="mt-0.5 shrink-0 text-ink-3" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11px] text-ink-2">{name}</div>
              <div className="truncate text-[10px] text-ink-3">
                {entry.target_rel || entry.archive_path}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-1">{entryBadges(entry)}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

function ArchiveTree({ archive, showAll }: { archive: PatchDeployArchive; showAll: boolean }) {
  const entries = showAll
    ? archive.entries
    : archive.entries.filter((entry) => entry.status === 'replace' || entry.status === 'error');
  if (!entries.length) return null;
  const tree = buildTree(entries);
  const stats = treeStats(buildTree(archive.entries));
  return (
    <details className="pd-dir rounded-lg border border-line bg-surface" open>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-t-lg bg-surface-2 px-3 py-2 text-[12px] font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={13} className="pd-arrow shrink-0 text-ink-3" />
        <FileArchive size={14} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate">{archive.name}</span>
        <Badge tone="warning">已存在 {stats.replace}</Badge>
        <Badge tone="success">新增 {stats.add}</Badge>
        {stats.error > 0 && <Badge tone="danger">错误 {stats.error}</Badge>}
      </summary>
      <div className="p-2">
        <TreeDir node={tree} />
      </div>
    </details>
  );
}

function statusBadge(batch: PatchDeployBatch) {
  if (batch.status === 'deployed') return <Badge tone="success">已部署</Badge>;
  if (batch.status === 'rolled_back') return <Badge tone="muted">已撤回</Badge>;
  if (batch.status === 'rollback_failed') return <Badge tone="danger">撤回失败</Badge>;
  return <Badge tone="warning">{batch.status || '未知'}</Badge>;
}

function actionBadge(file: PatchDeployBatchFile) {
  return file.action === 'replace' ? (
    <Badge tone="warning">替换</Badge>
  ) : (
    <Badge tone="success">新增</Badge>
  );
}

export function PatchDeployTab() {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const targetFieldRef = useRef<HTMLDivElement>(null);
  const { envs, loading: envsLoading, reload: reloadEnvs } = useProjectEnvs();
  const [envPickerOpen, setEnvPickerOpen] = useState(false);
  const [selectedEnvId, setSelectedEnvId] = useState('');

  const [target, setTarget] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restartResult, setRestartResult] = useState<PatchDeployResult | null>(null);
  const [restartError, setRestartError] = useState('');
  const [restartMode, setRestartMode] = useState<'restart' | 'rollback-restart'>('restart');
  const [files, setFiles] = useState<File[]>([]);
  const [env, setEnv] = useState<PatchDeployEnv | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [savingCommands, setSavingCommands] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [commandForm, setCommandForm] = useState({
    start: '',
    stop: '',
    restart: '',
  });
  const [preflighting, setPreflighting] = useState(false);
  const [plan, setPlan] = useState<PatchDeployPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [batches, setBatches] = useState<PatchDeployBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [detail, setDetail] = useState<PatchDeployBatch | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<PatchDeployBatch | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackCanRestart, setRollbackCanRestart] = useState<boolean | null>(null);
  const [deleteBatchTarget, setDeleteBatchTarget] = useState<PatchDeployBatch | null>(null);
  const [deleteBatchBusy, setDeleteBatchBusy] = useState(false);
  const [result, setResult] = useState<PatchDeployResult | null>(null);
  const [serviceFilter, setServiceFilter] = useState('');
  const [showRolledBack, setShowRolledBack] = useState(false);

  useEffect(() => {
    if (!env) return;
    setCommandForm({
      start: env.service.start_script || '',
      stop: env.service.stop_script || '',
      restart: env.service.restart_script || '',
    });
    setCommandsOpen(false);
  }, [env]);

  // 撤回并重启需要该批次所属服务的重启命令；批次列表可能跨服务，不能只看当前输入框。
  useEffect(() => {
    if (!rollbackTarget) {
      setRollbackCanRestart(null);
      return;
    }
    let cancelled = false;
    setRollbackCanRestart(null);
    const key = batchServiceKey(rollbackTarget);
    if (env && (env.service_key || fallbackServiceKey(env.target_root)) === key) {
      setRollbackCanRestart(env.service.can_restart);
      return () => {
        cancelled = true;
      };
    }
    void patchDeployApi
      .detect(rollbackTarget.target_root, rollbackTarget.edition)
      .then(({ env: detected }) => {
        if (!cancelled) setRollbackCanRestart(detected.service.can_restart);
      })
      .catch(() => {
        if (!cancelled) setRollbackCanRestart(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rollbackTarget, env]);

  const serviceCommandMessage = (service: PatchDeployEnv['service']) =>
    `已识别到服务器启动命令：${service.start_script || '未配置'}，停止命令：${
      service.stop_script || '未配置'
    }，重启命令：${service.restart_script || '未配置'}`;

  const saveServiceCommands = async () => {
    if (!env) return;
    setSavingCommands(true);
    try {
      const data = await patchDeployApi.saveServiceCommands({
        service_key: env.service_key,
        start_script: commandForm.start.trim(),
        stop_script: commandForm.stop.trim(),
        restart_script: commandForm.restart.trim(),
      });
      const commands = data.commands;
      const service: PatchDeployEnv['service'] = {
        ...env.service,
        start_script: commands.start_script,
        stop_script: commands.stop_script,
        restart_script: commands.restart_script,
        can_restart: Boolean(
          commands.restart_script || (commands.start_script && commands.stop_script)
        ),
        message: serviceCommandMessage({
          ...env.service,
          start_script: commands.start_script,
          stop_script: commands.stop_script,
          restart_script: commands.restart_script,
        }),
      };
      setEnv({ ...env, service });
      setCommandForm({
        start: commands.start_script || '',
        stop: commands.stop_script || '',
        restart: commands.restart_script || '',
      });
      setCommandsOpen(false);
      toast.success('服务命令已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存服务命令失败');
    } finally {
      setSavingCommands(false);
    }
  };

  const loadBatches = async () => {
    setBatchesLoading(true);
    try {
      const data = await patchDeployApi.batches();
      setBatches(data.batches || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载已部署补丁失败');
    } finally {
      setBatchesLoading(false);
    }
  };

  const saveFormConfig = (path = target) => {
    if (!path.trim()) return;
    void patchDeployApi
      .saveConfig({
        last_target: path.trim(),
        edition: 'auto',
      })
      .catch(() => {});
  };

  const detectWith = async (
    path: string,
    silent = false,
    showError = !silent
  ): Promise<PatchDeployEnv | null> => {
    const value = path.trim();
    if (!value) {
      if (!silent) toast.error('请填写本地服务地址（FBIP 部署目录）');
      return null;
    }
    if (!silent) setDetecting(true);
    try {
      const data = await patchDeployApi.detect(value, 'auto');
      setEnv(data.env);
      if (!silent) {
        toast.success(`已识别 ${data.env.edition_label}`);
      }
      return data.env;
    } catch (error) {
      setEnv(null);
      if (showError) toast.error(error instanceof Error ? error.message : '环境检测失败');
      return null;
    } finally {
      if (!silent) setDetecting(false);
    }
  };

  const handleDetect = async () => {
    const detected = await detectWith(target);
    if (detected) saveFormConfig();
  };

  const handleTargetBlur = async () => {
    if (!target.trim()) {
      setEnv(null);
      return;
    }
    const detected = await detectWith(target, true, true);
    if (detected) saveFormConfig();
  };

  useEffect(() => {
    void (async () => {
      try {
        const data = await patchDeployApi.config();
        const config = data.config;
        setTarget(config.last_target || '');
        if (config.last_target) {
          await detectWith(config.last_target, true);
        }
      } catch {
        // 配置读取失败不阻断使用
      }
    })();
    void loadBatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const node = dropRef.current;
    if (!node) return;
    const prevent = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      addFiles(event.dataTransfer?.files);
    };
    node.addEventListener('dragover', prevent);
    node.addEventListener('dragenter', prevent);
    node.addEventListener('drop', onDrop);
    return () => {
      node.removeEventListener('dragover', prevent);
      node.removeEventListener('dragenter', prevent);
      node.removeEventListener('drop', onDrop);
    };
  }, []);

  const addFiles = (list: FileList | null | undefined) => {
    if (!list) return;
    const incoming: File[] = [];
    for (const file of Array.from(list)) {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        toast.error(`只接受 ZIP 补丁包：${file.name}`);
        continue;
      }
      incoming.push(file);
    }
    if (!incoming.length) return;
    setFiles((current) => {
      const next = [...current];
      for (const file of incoming) {
        const duplicate = next.some(
          (item) =>
            item.name === file.name &&
            item.size === file.size &&
            item.lastModified === file.lastModified
        );
        if (!duplicate) next.push(file);
      }
      return next;
    });
  };

  const pickFolder = async () => {
    try {
      const data = await api.pickFolder(target);
      if (data.success && data.path) {
        setTarget(data.path);
        const detected = await detectWith(data.path);
        if (detected) saveFormConfig(data.path);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '选择目录失败');
    }
  };

  const preflight = async () => {
    if (!files.length) return toast.error('请选择要部署的补丁 ZIP');
    const current = await detectWith(target);
    if (!current) return;
    saveFormConfig();

    setPreflighting(true);
    try {
      const form = new FormData();
      form.append('target', target.trim());
      form.append('edition', 'auto');
      for (const file of files) form.append('files', file, file.name);
      const data = await patchDeployApi.preflight(form);
      setPlan(data);
      setShowAll(false);
      setPlanOpen(true);
      if ((data.stats?.errors || 0) > 0) {
        toast.error('预检发现错误，请查看文件列表');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '补丁预检失败');
    } finally {
      setPreflighting(false);
    }
  };

  const cancelPlan = async () => {
    const current = plan;
    setPlanOpen(false);
    setPlan(null);
    if (!current) return;
    try {
      await patchDeployApi.cancel(current.batch_id);
    } catch {
      // 已关闭弹窗时不阻断用户
    }
  };

  const deploy = async () => {
    if (!plan) return;
    setDeploying(true);
    try {
      const data = await patchDeployApi.deploy({
        batch_id: plan.batch_id,
        restart: false,
        confirm_replace: true,
      });
      setServiceFilter(plan.env.service_key || fallbackServiceKey(plan.env.target_root));
      setPlanOpen(false);
      setPlan(null);
      setFiles([]);
      setResult(data);
      await loadBatches();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '补丁部署失败');
    } finally {
      setDeploying(false);
    }
  };

  const openRollback = (batch: PatchDeployBatch) => {
    setRollbackTarget(batch);
  };

  const performRollback = async (restart: boolean) => {
    if (!rollbackTarget) return;
    if (restart && rollbackCanRestart !== true) {
      toast.error('未找到重启命令，不能撤回并重启');
      return;
    }
    const batch = rollbackTarget;
    if (restart) {
      setRollbackTarget(null);
      setRestartMode('rollback-restart');
      setRestartDialogOpen(true);
      setRestartResult(null);
      setRestartError('');
      setRestarting(true);
      try {
        const data = await patchDeployApi.rollback({
          batch_id: batch.id,
          restart: true,
          confirm: true,
        });
        setRestartResult(data);
        toast.success(data.message || '撤回并重启完成');
      } catch (error) {
        setRestartError(error instanceof Error ? error.message : '撤回并重启失败');
        toast.error(error instanceof Error ? error.message : '撤回并重启失败');
      } finally {
        setRestarting(false);
        await loadBatches();
      }
      return;
    }
    setRollbackBusy(true);
    try {
      const data = await patchDeployApi.rollback({
        batch_id: batch.id,
        restart: false,
        confirm: true,
      });
      setRollbackTarget(null);
      setResult(data);
      await loadBatches();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '撤回补丁失败');
    } finally {
      setRollbackBusy(false);
    }
  };

  const deleteBatch = async () => {
    if (!deleteBatchTarget) return;
    setDeleteBatchBusy(true);
    try {
      await patchDeployApi.deleteBatch(deleteBatchTarget.id);
      setDeleteBatchTarget(null);
      toast.success('已撤回记录已删除');
      await loadBatches();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除记录失败');
    } finally {
      setDeleteBatchBusy(false);
    }
  };

  const restartService = async () => {
    if (!env?.service.can_restart) return;
    setRestartMode('restart');
    setRestartDialogOpen(true);
    setRestartResult(null);
    setRestartError('');
    setRestarting(true);
    try {
      const data = await patchDeployApi.restart(env.input_path, 'auto');
      setRestartResult(data);
      toast.success(data.message || '本地服务已重启');
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : '重启本地服务失败');
      toast.error(error instanceof Error ? error.message : '重启本地服务失败');
    } finally {
      setRestarting(false);
    }
  };

  const planShowAll = useMemo(() => showAll || (plan?.stats.replace || 0) === 0, [showAll, plan]);
  const isRollbackRestart = restartMode === 'rollback-restart';

  const services = useMemo<ServiceItem[]>(() => {
    const map = new Map<string, ServiceItem>();
    for (const batch of batches) {
      const key = batchServiceKey(batch);
      if (!map.has(key)) {
        map.set(key, {
          key,
          target_root: batch.target_root,
          label: `${batch.target_root} · FBIP ${batch.edition}`,
        });
      }
    }
    if (env) {
      const key = env.service_key || fallbackServiceKey(env.target_root);
      if (!map.has(key)) {
        map.set(key, {
          key,
          target_root: env.target_root,
          label: `${env.target_root} · ${env.edition_label}`,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }, [batches, env]);

  const visibleBatches = useMemo(() => {
    let list = serviceFilter
      ? batches.filter((batch) => batchServiceKey(batch) === serviceFilter)
      : batches;
    if (!showRolledBack) {
      list = list.filter((batch) => batch.status !== 'rolled_back');
    }
    return list;
  }, [batches, serviceFilter, showRolledBack]);

  useEffect(() => {
    if (env) setServiceFilter(env.service_key || fallbackServiceKey(env.target_root));
  }, [env]);

  useEffect(() => {
    if (env) return;
    if (serviceFilter && services.some((item) => item.key === serviceFilter)) return;
    if (services.length) setServiceFilter(services[0].key);
  }, [services, serviceFilter, env]);

  const selectService = (key: string) => {
    setServiceFilter(key);
    const item = services.find((candidate) => candidate.key === key);
    if (!item) return;
    setTarget(item.target_root);
    setEnv(null);
    void detectWith(item.target_root, true);
  };

  const importFromEnv = async () => {
    const item = envs.find((candidate) => String(candidate.id) === selectedEnvId);
    if (!item) return;
    const address = (item.package_path || '').trim();
    if (!address) {
      toast.error('该项目环境暂未填写 home/war 包地址');
      return;
    }
    setEnvPickerOpen(false);
    setSelectedEnvId('');
    setTarget(address);
    setEnv(null);
    const detected = await detectWith(address);
    if (detected) saveFormConfig(address);
  };

  const batchColumns: Array<Column<PatchDeployBatch>> = [
    {
      key: 'env',
      title: '本地服务地址',
      render: (batch) => (
        <div className="max-w-[260px]">
          <div className="truncate font-mono text-[11px] text-ink-2" title={batch.target_root}>
            {batch.target_root}
          </div>
          <div className="text-[10.5px] text-ink-3">FBIP {batch.edition}</div>
        </div>
      ),
    },
    {
      key: 'patches',
      title: '补丁',
      render: (batch) => (
        <div className="max-w-[220px]">
          <div className="truncate text-[11.5px]" title={batch.archives.join('、')}>
            {batch.archives.join('、') || '—'}
          </div>
          <div className="text-[10.5px] text-ink-3">{batch.files.length} 个文件</div>
        </div>
      ),
    },
    {
      key: 'time',
      title: '部署时间',
      render: (batch) => <span className="text-[11.5px] text-ink-3">{batch.created_at}</span>,
    },
    {
      key: 'status',
      title: '状态',
      render: (batch) => (
        <div className="flex flex-col items-start gap-1">
          {statusBadge(batch)}
          {batch.later_deployed > 0 && batch.status === 'deployed' && (
            <span className="text-[10px] text-ink-3">之后还有 {batch.later_deployed} 个批次</span>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      width: '160px',
      render: (batch) => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setDetail(batch)}>
            详情
          </Button>
          {batch.status === 'deployed' && (
            <Button
              size="sm"
              variant="danger"
              icon={<RotateCcw size={12} />}
              onClick={() => openRollback(batch)}
            >
              {batch.later_deployed ? '撤回至此' : '撤回本次'}
            </Button>
          )}
          {batch.status === 'rolled_back' && (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:text-danger"
              icon={<Trash2 size={12} />}
              onClick={() => setDeleteBatchTarget(batch)}
            >
              删除
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <PackageCheck size={16} className="text-accent" />
              补丁管理
            </div>
            <div className="mt-1 text-[12px] leading-5 text-ink-3">
              直接部署到本机 FBIP 服务目录。预检发现同名文件时会先弹出替换确认，不会直接覆盖。
            </div>
          </div>
          {env ? (
            <Badge tone="success">{env.edition_label}</Badge>
          ) : (
            <Badge tone="muted">未检测环境</Badge>
          )}
        </div>

        <div>
          <label className="mb-1 block text-[12px] font-medium text-ink-2">
            本地服务地址（FBIP 部署目录）
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div ref={targetFieldRef} className="relative min-w-[300px] flex-1">
              <Input
                className="w-full pr-10"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                  setEnv(null);
                }}
                onBlur={() => {
                  if (targetFieldRef.current?.contains(document.activeElement)) return;
                  void handleTargetBlur();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleDetect();
                }}
                placeholder="例如 D:\TongWeb\domains\domain1\deployment\fbip 或 /data/fbip"
              />
              {detecting && (
                <span className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 text-ink-3">
                  <Loader2 size={14} className="animate-spin" />
                </span>
              )}
              <button
                type="button"
                title="选择目录"
                aria-label="选择目录"
                disabled={detecting}
                onClick={() => void pickFolder()}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-3 hover:text-accent disabled:opacity-50"
              >
                <FolderOpen size={15} />
              </button>
            </div>
            <Button
              icon={<Download size={14} />}
              onClick={() => {
                setEnvPickerOpen(true);
                setSelectedEnvId('');
                void reloadEnvs();
              }}
            >
              从项目环境导入
            </Button>
            {env && (
              <Button
                icon={<Settings2 size={14} />}
                title={commandsOpen ? '收起服务命令' : '修改服务命令'}
                onClick={() => setCommandsOpen((open) => !open)}
              >
                {commandsOpen ? '收起服务命令' : '修改服务命令'}
              </Button>
            )}
          </div>
        </div>

        {env && (
          <div className="mt-3 grid gap-1.5 rounded-lg border border-line bg-surface-2 p-3 text-[11.5px]">
            <div className="flex gap-2">
              <span className="w-[92px] shrink-0 text-ink-3">部署根目录</span>
              <span className="break-all font-mono text-ink-2">{env.target_root}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-[92px] shrink-0 text-ink-3">应用根目录</span>
              <span className="break-all font-mono text-ink-2">{env.app_root}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-[92px] shrink-0 leading-5 text-ink-3">服务命令</span>
              <div className="min-w-0 flex-1 break-all leading-5 text-ink-2">
                {env.service.message}
              </div>
            </div>
            {env.service.deploy_script && (
              <div className="flex gap-2">
                <span className="w-[92px] shrink-0 text-ink-3">部署脚本</span>
                <span className="break-all font-mono text-ink-2">{env.service.deploy_script}</span>
              </div>
            )}
            {commandsOpen && (
            <div className="mt-2 rounded-lg border border-line bg-surface p-2.5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11.5px] font-medium text-ink-2">服务命令配置</span>
                <span className="text-[10.5px] text-ink-3">
                  有重启命令时直接执行重启，否则停止后启动
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-[10.5px] text-ink-3">启动命令</label>
                  <Input
                    className="h-8 text-[11px]"
                    value={commandForm.start}
                    onChange={(event) =>
                      setCommandForm((current) => ({ ...current, start: event.target.value }))
                    }
                    placeholder="未配置"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10.5px] text-ink-3">停止命令</label>
                  <Input
                    className="h-8 text-[11px]"
                    value={commandForm.stop}
                    onChange={(event) =>
                      setCommandForm((current) => ({ ...current, stop: event.target.value }))
                    }
                    placeholder="未配置"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10.5px] text-ink-3">重启命令</label>
                  <Input
                    className="h-8 text-[11px]"
                    value={commandForm.restart}
                    onChange={(event) =>
                      setCommandForm((current) => ({ ...current, restart: event.target.value }))
                    }
                    placeholder="未配置时使用停止+启动"
                  />
                </div>
              </div>
              <div className="mt-2 flex justify-end">
                <Button size="sm" loading={savingCommands} onClick={() => void saveServiceCommands()}>
                  保存服务命令
                </Button>
              </div>
            </div>
            )}
          </div>
        )}
      </div>

      <div className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <UploadCloud size={16} className="text-accent" />
              选择要部署的补丁
            </div>
            <div className="mt-1 text-[11.5px] text-ink-3">
              一次选择多个 ZIP 会作为同一个部署批次。
            </div>
          </div>
          <span className="badge badge-muted">{files.length} 个文件</span>
        </div>

        <div
          ref={dropRef}
          className="cursor-pointer rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-7 text-center transition-colors hover:border-accent hover:bg-accent-soft/30"
          onClick={() => fileInput.current?.click()}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".zip"
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <UploadCloud size={26} className="mx-auto mb-2 text-accent" />
          <div className="text-[13px] font-medium text-ink-2">点击选择或拖拽 ZIP 补丁包到这里</div>
          <div className="mt-1 text-[11.5px] text-ink-3">
            支持 FBIP 8.1 / 8.2 补丁格式和 installpatch.xml
          </div>
        </div>

        {files.length > 0 && (
          <div className="mt-2 grid gap-1.5">
            {files.map((file, index) => (
              <div
                key={`${file.name}-${file.size}-${file.lastModified}`}
                className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px]"
              >
                <FileArchive size={14} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 text-[10.5px] text-ink-3">
                  {(file.size / 1024).toFixed(1)} KB
                </span>
                <button
                  type="button"
                  className="rounded p-0.5 text-ink-3 hover:bg-surface-3 hover:text-danger"
                  title="移除"
                  onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                >
                  <XCircle size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="primary"
            size="lg"
            loading={preflighting}
            icon={<Play size={14} />}
            onClick={() => void preflight()}
          >
            预检并部署
          </Button>
          <span
            className="inline-flex"
            title={
              !env
                ? '请先填写并检测本地服务地址'
                : env.service.can_restart
                  ? '重启本地服务'
                  : '未找到重启命令'
            }
          >
            <Button
              size="lg"
              icon={<RefreshCw size={14} />}
              loading={restarting}
              disabled={!env?.service.can_restart}
              onClick={() => void restartService()}
            >
              重启本地服务
            </Button>
          </span>
        </div>
      </div>

      <div className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <ArchiveRestore size={16} className="text-accent" />
              已部署的补丁
            </div>
            <div className="mt-1 text-[11.5px] text-ink-3">
              只支持逆序撤回。撤回较早批次时，会自动先撤回它之后的所有批次。
            </div>
          </div>
          <Button
            size="sm"
            icon={<RefreshCw size={13} />}
            loading={batchesLoading}
            onClick={() => void loadBatches()}
          >
            刷新
          </Button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
          <span className="text-[12px] font-medium text-ink-2">按服务查看</span>
          <Select
            className="min-w-[300px] flex-1"
            value={serviceFilter}
            onChange={(event) => selectService(event.target.value)}
            options={services.map((service) => ({
              value: service.key,
              label: service.label,
            }))}
            placeholder={services.length ? undefined : '还没有服务记录'}
          />
          <Badge tone="muted">{visibleBatches.length} 个批次</Badge>
          <Checkbox
            checked={showRolledBack}
            onChange={setShowRolledBack}
            label="显示已撤回记录"
          />
          <span className="text-[10.5px] text-ink-3">
            部署、撤回和列表都按服务隔离；撤回只会影响当前服务。
          </span>
        </div>

        <DataTable
          columns={batchColumns}
          rows={visibleBatches}
          rowKey={(batch) => batch.id}
          loading={batchesLoading}
          empty="当前服务还没有已部署的补丁"
        />
      </div>

      <Dialog
        open={planOpen && Boolean(plan)}
        onClose={() => {
          if (!deploying) void cancelPlan();
        }}
        title={
          plan?.stats.errors
            ? '预检发现错误，不能部署'
            : (plan?.stats.total || 0) === 0
              ? '没有可部署文件'
              : plan?.has_conflicts
                ? '检测到环境中已有以下文件，请确认是否替换'
                : '未发现已存在文件，确认部署本次补丁？'
        }
        description={
          plan?.has_conflicts
            ? '确认后会在备份原文件的前提下覆盖；取消不会修改环境。'
            : '预检不会修改环境；确认后才会写入补丁。'
        }
        width="max-w-5xl"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={deploying}
              onClick={() => void cancelPlan()}
            >
              取消
            </Button>
            <Button
              variant="primary"
              loading={deploying}
              disabled={
                !plan ||
                (plan.stats.errors || 0) > 0 ||
                (plan.stats.total || 0) === 0 ||
                plan.can_deploy === false
              }
              onClick={() => void deploy()}
            >
              {plan?.has_conflicts ? '确认替换并部署' : '确认部署'}
            </Button>
          </>
        }
      >
        {plan && (
          <div className="space-y-3">
            <div className="text-[11.5px] text-ink-3">
              目标环境：
              <span className="ml-1 break-all font-mono text-ink-2">{plan.env.target_root}</span>
              <span className="ml-2 text-ink-3">{plan.env.edition_label}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="warning">已存在 {plan.stats.replace}</Badge>
              <Badge tone="success">新增 {plan.stats.add}</Badge>
              <Badge tone="accent">jar内同名类 {plan.stats.shadow}</Badge>
              <Badge tone="muted">忽略 {plan.stats.ignored}</Badge>
              {plan.stats.errors > 0 && <Badge tone="danger">错误 {plan.stats.errors}</Badge>}
            </div>

            {plan.stats.errors > 0 && (
              <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
                <div className="mb-1 flex items-center gap-1.5 font-medium">
                  <ShieldAlert size={13} /> 预检错误
                </div>
                <ul className="list-inside list-disc space-y-0.5">
                  {plan.archives.flatMap((archive) => [
                    ...archive.errors.map((error) => `${archive.name}：${error}`),
                    ...archive.entries
                      .filter((entry) => entry.status === 'error')
                      .map((entry) => `${archive.name}：${entry.archive_path}：${entry.error}`),
                  ]).slice(0, 40).map((error, index) => (
                    <li key={`${error}-${index}`}>{error}</li>
                  ))}
                </ul>
              </div>
            )}

            {plan.warnings.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[11.5px] leading-5 text-warning">
                <div className="mb-1 flex items-center gap-1.5 font-medium">
                  <ShieldAlert size={13} /> 提示
                </div>
                <ul className="list-inside list-disc space-y-0.5">
                  {plan.warnings.slice(0, 30).map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <Checkbox
              checked={showAll}
              onChange={setShowAll}
              label="显示全部文件（含新增和忽略）"
            />

            <div className="space-y-2">
              {plan.archives.map((archive) => (
                <ArchiveTree key={archive.name} archive={archive} showAll={planShowAll} />
              ))}
              {!plan.archives.some((archive) =>
                planShowAll
                  ? archive.entries.length > 0
                  : archive.entries.some(
                      (entry) => entry.status === 'replace' || entry.status === 'error'
                    )
              ) && <div className="py-6 text-center text-[12px] text-ink-3">没有需要展示的文件</div>}
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={Boolean(result)}
        onClose={() => setResult(null)}
        title={result?.success ? '操作完成' : '操作失败'}
        description={result?.message}
        width="max-w-3xl"
        footer={
          <Button variant="primary" onClick={() => setResult(null)}>
            关闭
          </Button>
        }
      >
        {result && (
          <div className="space-y-3">
            {result.warnings.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[11.5px] leading-5 text-warning">
                <ul className="list-inside list-disc space-y-0.5">
                  {result.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.log_tail.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11.5px] font-medium text-ink-3">执行日志</div>
                <ResultBox content={result.log_tail.join('\n')} maxHeight="max-h-[50vh]" />
              </div>
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail ? `批次 ${detail.id}` : '批次详情'}
        description={
          detail
            ? `${detail.created_at} · FBIP ${detail.edition}`
            : ''
        }
        width="max-w-4xl"
        footer={
          <Button variant="primary" onClick={() => setDetail(null)}>
            关闭
          </Button>
        }
      >
        {detail && (
          <div className="space-y-3">
            <div className="text-[11.5px] text-ink-3">
              本地服务地址：
              <span className="ml-1 break-all font-mono text-ink-2">{detail.target_root}</span>
            </div>
            <div className="rounded-lg border border-line">
              {detail.files.map((file) => (
                <div
                  key={file.target_rel}
                  className="flex items-start gap-2 border-b border-line-soft px-3 py-2 last:border-0"
                >
                  <FileArchive size={13} className="mt-0.5 shrink-0 text-ink-3" />
                  <div className="min-w-0 flex-1">
                    <div className="break-all font-mono text-[11.5px] text-ink-2">
                      {file.target_rel}
                    </div>
                    <div className="text-[10.5px] text-ink-3">
                      {file.action === 'replace' ? '已备份并替换' : '新增'}
                      {file.shadow_jar ? ` · jar: ${file.shadow_jar}` : ''}
                    </div>
                  </div>
                  <div className="shrink-0">{actionBadge(file)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={Boolean(rollbackTarget)}
        onClose={() => {
          if (!rollbackBusy) setRollbackTarget(null);
        }}
        title={rollbackTarget?.later_deployed ? '撤回较早批次' : '撤回本次部署'}
        description="撤回会恢复部署前备份的文件；可以选择是否同时重启本地服务。"
        width="max-w-2xl"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={rollbackBusy}
              onClick={() => setRollbackTarget(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              disabled={rollbackBusy}
              onClick={() => void performRollback(false)}
            >
              撤回
            </Button>
            <span
              className="inline-flex"
              title={
                rollbackCanRestart === null
                  ? '正在检测重启命令…'
                  : rollbackCanRestart
                    ? '撤回补丁并重启本地服务'
                    : '未找到重启命令'
              }
            >
              <Button
                variant="danger"
                loading={rollbackBusy}
                disabled={rollbackBusy || rollbackCanRestart !== true}
                onClick={() => void performRollback(true)}
              >
                撤回并重启
              </Button>
            </span>
          </>
        }
      >
        {rollbackTarget && (
          <div className="space-y-3">
            <div className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12px] leading-5 text-danger">
              撤回批次 <span className="font-mono">{rollbackTarget.id}</span>
              {rollbackTarget.later_deployed
                ? ` 会先逆序撤回它之后的所有已部署批次（共 ${
                    rollbackTarget.later_deployed + 1
                  } 个批次）。`
                : ' 会恢复该批次部署前的文件。'}
            </div>
            <div className="space-y-1 text-[11.5px] text-ink-2">
              <div>
                <span className="text-ink-3">本地服务地址：</span>
                <span className="break-all font-mono">{rollbackTarget.target_root}</span>
              </div>
              <div>
                <span className="text-ink-3">补丁：</span>
                {rollbackTarget.archives.join('、')}
              </div>
              <div>
                <span className="text-ink-3">文件：</span>
                {rollbackTarget.files.length} 个
              </div>
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteBatchTarget)}
        onClose={() => {
          if (!deleteBatchBusy) setDeleteBatchTarget(null);
        }}
        onConfirm={() => void deleteBatch()}
        title="删除已撤回记录"
        description={
          deleteBatchTarget
            ? `确定删除批次 ${deleteBatchTarget.id} 的撤回记录和备份吗？删除后不可恢复。`
            : ''
        }
        confirmText="删除"
        danger
        loading={deleteBatchBusy}
      />

      <Dialog
        open={restartDialogOpen}
        onClose={() => {
          if (!restarting) setRestartDialogOpen(false);
        }}
        title={
          restarting
            ? isRollbackRestart
              ? '正在撤回并重启本地服务'
              : '正在重启本地服务'
            : restartResult?.success
              ? isRollbackRestart
                ? '撤回并重启完成'
                : '本地服务已重启'
              : restartError
                ? isRollbackRestart
                  ? '撤回并重启失败'
                  : '重启失败'
                : isRollbackRestart
                  ? '正在撤回并重启本地服务'
                  : '正在重启本地服务'
        }
        description={
          restarting
            ? isRollbackRestart
              ? '正在撤回补丁并重启中，请稍后...'
              : '正在重启中，请稍后...'
            : restartResult?.message || restartError || ''
        }
        width="max-w-3xl"
        footer={
          restarting ? (
            <Button variant="primary" loading disabled>
              正在重启
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setRestartDialogOpen(false)}>
              关闭
            </Button>
          )
        }
      >
        {restarting ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <Spinner size={22} />
            <div className="text-[13px] text-ink-2">
              {isRollbackRestart ? '正在撤回补丁并重启中，请稍后...' : '正在重启中，请稍后...'}
            </div>
            {env && (
              <div className="max-w-xl break-all text-[10.5px] text-ink-3">
                {isRollbackRestart ? '先撤回补丁，再执行重启命令。' : ''}
                启动：{env.service.start_script || '未配置'}；停止：
                {env.service.stop_script || '未配置'}；重启：
                {env.service.restart_script || '未配置'}
              </div>
            )}
          </div>
        ) : restartError ? (
          <div className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12px] leading-5 text-danger">
            {restartError}
          </div>
        ) : restartResult ? (
          <div className="space-y-3">
            {restartResult.warnings.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[11.5px] leading-5 text-warning">
                <ul className="list-inside list-disc space-y-0.5">
                  {restartResult.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            {restartResult.log_tail.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11.5px] font-medium text-ink-3">执行日志</div>
                <ResultBox content={restartResult.log_tail.join('\n')} maxHeight="max-h-[50vh]" />
              </div>
            )}
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={envPickerOpen}
        onClose={() => setEnvPickerOpen(false)}
        title="从项目环境导入 home/war 包地址"
        description="选择项目环境，把它的「home/war 包地址」回显到部署工具。"
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEnvPickerOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!selectedEnvId}
              onClick={() => void importFromEnv()}
            >
              导入
            </Button>
          </>
        }
      >
        {envsLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-ink-3">
            <Loader2 size={15} className="animate-spin" /> 正在加载项目环境…
          </div>
        ) : envs.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-ink-3">
            还没有项目环境，请先在「项目环境」里创建。
          </div>
        ) : (
          <div className="max-h-80 space-y-2 overflow-auto pr-1">
            {envs.map((item) => {
              const selected = String(item.id) === selectedEnvId;
              const address = (item.package_path || '').trim();
              return (
                <button
                  key={String(item.id)}
                  type="button"
                  onClick={() => setSelectedEnvId(String(item.id))}
                  className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? 'border-accent bg-accent-soft/50'
                      : 'border-line bg-surface-2 hover:border-accent/50'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12.5px] font-medium text-ink">
                        {item.project_name}
                      </span>
                      <span className="text-[10.5px] text-ink-3">
                        {item.product_name} {item.product_version}
                      </span>
                    </div>
                    <div
                      className={`mt-1 break-all font-mono text-[11px] ${
                        address ? 'text-ink-2' : 'text-warning'
                      }`}
                    >
                      {address || '未填写 home/war 包地址'}
                    </div>
                  </div>
                  {selected && <Badge tone="accent">已选择</Badge>}
                </button>
              );
            })}
          </div>
        )}
      </Dialog>
    </div>
  );
}
