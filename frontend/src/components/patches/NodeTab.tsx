import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  Eye,
  FolderOpen,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import { AttachmentField } from '../AttachmentField';
import { ResultBox } from '../ResultBox';
import { api } from '../../lib/api';
import type { ProjectEnv } from '../../lib/types';
import { cn, relativeTime, truncate } from '../../lib/utils';
import { useAuthStore } from '../../store/auth';
import { useChatStore } from '../../store/chat';
import { useNodeStore, type LocalNodeRun } from '../../store/nodeRuns';
import { NewSessionDialog } from '../chat/SessionList';
import { NewSessionMenu } from '../chat/NewSessionMenu';
import { Button, ConfirmDialog, Dialog, Input, Switch } from '../ui';
import { useToast } from '../ui/toast';
import { useProjectEnvs } from './hooks';

function phaseInfo(run: LocalNodeRun): { label: string; tone: string } {
  if (run.phase === 'analyzing') return { label: '执行中', tone: 'badge-warning' };
  if (run.phase === 'merging') return { label: '合并中', tone: 'badge-warning' };
  if (run.phase === 'awaiting_decision') return { label: '待判定', tone: 'badge-accent' };
  if (run.phase === 'done') {
    return run.verdict === 'solved'
      ? { label: '已解决', tone: 'badge-success' }
      : { label: '未解决', tone: 'badge-danger' };
  }
  if (run.failure === 'merge') return { label: '合并失败', tone: 'badge-danger' };
  if (run.failure === 'aborted') return { label: '已中断', tone: 'badge-muted' };
  return { label: '失败', tone: 'badge-danger' };
}

function envOf(run: LocalNodeRun): Record<string, unknown> {
  return (run.env_snapshot || {}) as Record<string, unknown>;
}

interface ArtifactItem {
  path: string;
  label: string;
}

function relativePath(base: string, full: string): string {
  const root = base.replace(/[\\/]+$/, '');
  if (!root) return full;
  if (full === root) return full.split(/[\\/]/).pop() || full;
  const prefix = full.slice(0, root.length);
  if (prefix.toLowerCase() !== root.toLowerCase()) return full;
  return full.slice(root.length).replace(/^[\\/]+/, '') || full;
}

// 递归收集补丁输出目录下的产物（跳过 work / baseline / clean 这些中间目录）。
async function collectRunArtifacts(
  root: string,
  base = root,
  depth = 0,
  out: string[] = []
): Promise<string[]> {
  if (!root || depth > 6 || out.length >= 300) return out;
  let result;
  try {
    result = await api.files.list(root);
  } catch {
    return out;
  }
  if (!result.success) return out;
  for (const file of result.files || []) {
    if (out.length >= 300) break;
    if (file.is_dir) {
      const name = file.name.toLowerCase();
      if (name === 'work' || name === 'baseline' || name === 'clean' || name === '.git') {
        continue;
      }
      await collectRunArtifacts(file.path, base, depth + 1, out);
    } else {
      out.push(file.path);
    }
  }
  return out;
}

async function loadRunArtifacts(run: LocalNodeRun): Promise<ArtifactItem[]> {
  const root = String(run.out_dir || run.turn_dir || '').trim();
  if (!root) return [];
  const paths = await collectRunArtifacts(root, root);
  // out_dir 不存在时再试一次当前步骤目录（老记录可能只有 turn_dir）
  if (!paths.length && run.turn_dir && run.turn_dir !== root) {
    paths.push(...(await collectRunArtifacts(run.turn_dir, run.turn_dir)));
  }
  return paths.map((path) => ({ path, label: relativePath(root, path) }));
}

export function NodeTab({ edition }: { edition: 'dev' | 'novice' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const user = useAuthStore((state) => state.user);
  const runs = useNodeStore((state) => state.runs);
  const loading = useNodeStore((state) => state.loading);
  const streaming = useNodeStore((state) => state.streaming);
  const load = useNodeStore((state) => state.load);
  const create = useNodeStore((state) => state.create);
  const solve = useNodeStore((state) => state.solve);
  const unsolve = useNodeStore((state) => state.unsolve);
  const rerun = useNodeStore((state) => state.rerun);
  const abort = useNodeStore((state) => state.abort);
  const remove = useNodeStore((state) => state.remove);
  const { envs } = useProjectEnvs();
  const [searchParams, setSearchParams] = useSearchParams();

  const [formOpen, setFormOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [detailArtifacts, setDetailArtifacts] = useState<ArtifactItem[]>([]);
  const [detailArtifactsLoading, setDetailArtifactsLoading] = useState(false);
  const detailLoadRef = useRef(0);
  const [creating, setCreating] = useState(false);
  const [problemFiles, setProblemFiles] = useState<File[]>([]);
  const [logFiles, setLogFiles] = useState<File[]>([]);
  const [form, setForm] = useState({
    problem_desc: '',
    trigger_url: '',
    env_id: '',
    patch_output_path: '',
    log_text: '',
    log_file_name: '',
    need_debug_log: true,
    need_diff_report: true,
  });
  const [unsolvedOpen, setUnsolvedOpen] = useState(false);
  const [unsolvedTarget, setUnsolvedTarget] = useState<string | null>(null);
  const [unsolvedForm, setUnsolvedForm] = useState({ note: '', log_text: '', log_file_name: '' });
  const [solveTarget, setSolveTarget] = useState<LocalNodeRun | null>(null);
  const [solveChanges, setSolveChanges] = useState('');
  const [solveBusy, setSolveBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LocalNodeRun | null>(null);
  const [artifact, setArtifact] = useState<{ name: string; content: string } | null>(null);

  useEffect(() => {
    void load().catch((error) =>
      toast.error(error instanceof Error ? error.message : '加载运行记录失败')
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 从左侧「创建开发任务」进入：/?tab=node&new=1 自动打开新建表单
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setForm((current) => ({
      ...current,
      env_id: current.env_id || String(envs[0]?.id || ''),
    }));
    setFormOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, envs]);

  const visibleRuns = useMemo(() => {
    const list = edition === 'novice' ? runs.filter((run) => run.edition === 'novice') : runs;
    return list;
  }, [runs, edition]);

  const selectedEnv = envs.find((env) => String(env.id) === form.env_id);
  const detailRun = detail ? runs.find((run) => run.id === detail) || null : null;
  // 优先用打开详情时实时扫描的磁盘产物；扫描失败时退回清单里保存的旧产物路径。
  const artifactItems: ArtifactItem[] = detailArtifacts.length
    ? detailArtifacts
    : (detailRun?.artifacts || []).map((path) => ({
        path,
        label: relativePath(String(detailRun?.out_dir || ''), path),
      }));

  const openDetail = async (run: LocalNodeRun) => {
    setDetail(run.id);
    // 产物与执行状态无关：每次打开详情都直接扫补丁输出目录，
    // 失败/中断的运行也能看到已经落盘的文件。
    const token = ++detailLoadRef.current;
    setDetailArtifacts([]);
    setDetailArtifactsLoading(true);
    void loadRunArtifacts(run)
      .then((items) => {
        if (token === detailLoadRef.current) setDetailArtifacts(items);
      })
      .finally(() => {
        if (token === detailLoadRef.current) setDetailArtifactsLoading(false);
      });
    if ((run.stage || 1) >= 2) {
      try {
        const result = await api.files.read(`${String(run.step_dir || '').replace(/\\/g, '/')}/changes.txt`);
        setSolveChanges(result.success ? result.content : '');
      } catch {
        setSolveChanges('');
      }
    }
  };

  const openTaskForm = () => {
    setForm((current) => ({
      ...current,
      env_id: current.env_id || String(envs[0]?.id || ''),
    }));
    setFormOpen(true);
  };

  const submitCreate = async () => {
    if (!form.problem_desc.trim() && !problemFiles.length) {
      toast.error('请填写问题描述或上传附件');
      return;
    }
    if (edition === 'dev' && !form.trigger_url.trim()) {
      toast.error('请填写触发入口');
      return;
    }
    if (!selectedEnv) {
      toast.error('请选择产品环境');
      return;
    }
    // 补丁输出路径：表单填了用表单，没填回落到产品环境变量；两者都没有才提示。
    const patchOutputPath =
      form.patch_output_path.trim() || String(selectedEnv.patch_output_path || '').trim();
    if (edition === 'dev' && !patchOutputPath) {
      toast.error('当前产品环境变量中未填写补丁输出路径，请在此处填写');
      return;
    }
    setCreating(true);
    try {
      const run = await create({
        edition,
        env: selectedEnv,
        problem_desc:
          form.problem_desc.trim() ||
          `（已上传 ${problemFiles.length} 个问题附件，请查看）`,
        trigger_url: form.trigger_url,
        patch_output_path: patchOutputPath,
        log_text: form.log_text,
        log_file_name: form.log_file_name,
        need_debug_log: form.need_debug_log,
        need_diff_report: form.need_diff_report,
        problem_files: problemFiles,
        log_files: logFiles,
        user_id: user?.id,
      });
      setFormOpen(false);
      setProblemFiles([]);
      setLogFiles([]);
      setForm({
        problem_desc: '',
        trigger_url: '',
        env_id: '',
        patch_output_path: '',
        log_text: '',
        log_file_name: '',
        need_debug_log: true,
        need_diff_report: true,
      });
      toast.success('智能开发已启动');
      if (run.session_id) {
        // 会话列表立刻刷新，然后在当前页签直接进入该会话，不再停在运行列表/详情。
        void useChatStore.getState().refreshSessions().catch(() => {});
        navigate(`/chat.html?session=${encodeURIComponent(run.session_id)}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '启动失败');
    } finally {
      setCreating(false);
    }
  };

  const openUnsolved = (runId: string) => {
    setUnsolvedTarget(runId);
    setUnsolvedForm({ note: '', log_text: '', log_file_name: '' });
    setUnsolvedOpen(true);
  };

  const doSolve = async (run: LocalNodeRun) => {
    setSolveTarget(run);
    try {
      const path = `${String(run.step_dir || '').replace(/\\/g, '/')}/changes.txt`;
      const result = await api.files.read(path);
      setSolveChanges(result.success ? result.content : '');
    } catch {
      setSolveChanges('');
    }
  };

  const openArtifact = async (path: string) => {
    const fileName = path.split(/[\\/]/).pop() || path;
    if (/\.(html?|htm)$/i.test(fileName)) {
      window.open(api.files.rawUrl(path), '_blank');
      return;
    }
    if (/\.(zip|rar|7z|tar|gz)$/i.test(fileName)) {
      try {
        await api.files.reveal(path);
        toast.success('已在系统文件管理器中定位');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '定位文件失败');
      }
      return;
    }
    try {
      const result = await api.files.read(path);
      setArtifact({
        name: fileName,
        content: result.success ? result.content : '无法读取该文件',
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取产物失败');
    }
  };

  const stats = useMemo(() => {
    return {
      total: visibleRuns.length,
      active: visibleRuns.filter(
        (run) => run.phase === 'analyzing' || run.phase === 'merging'
      ).length,
      waiting: visibleRuns.filter(
        (run) => run.phase === 'awaiting_decision' || run.phase === 'failed'
      ).length,
      solved: visibleRuns.filter((run) => run.phase === 'done' && run.verdict === 'solved').length,
    };
  }, [visibleRuns]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13.5px] font-semibold text-ink">
            {edition === 'novice' ? '智能排查' : '智能开发'}
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-3">
            共 {visibleRuns.length} 次运行 · 运行记录保存在本机
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => void load()}>
            刷新
          </Button>
          {edition === 'dev' ? (
            <NewSessionMenu
              onNewSession={() => setNewSessionOpen(true)}
              onNewTask={openTaskForm}
            />
          ) : (
            <Button variant="primary" icon={<Plus size={14} />} onClick={openTaskForm}>
              新建排查
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: '全部运行', value: stats.total, tone: 'text-ink' },
          { label: '执行中', value: stats.active, tone: 'text-warning' },
          { label: '待判定', value: stats.waiting, tone: 'text-accent' },
          { label: '已解决', value: stats.solved, tone: 'text-success' },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-line bg-surface px-3 py-2.5">
            <div className="text-[10.5px] text-ink-3">{item.label}</div>
            <div className={`mt-0.5 text-[20px] font-semibold leading-7 ${item.tone}`}>
              {item.value}
            </div>
          </div>
        ))}
      </div>

      {loading && visibleRuns.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-line bg-surface py-14 text-[12.5px] text-ink-3">
          <RefreshCw size={15} className="animate-spin" /> 正在加载运行记录…
        </div>
      ) : visibleRuns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-surface/40 px-6 py-14 text-center">
          <div className="text-[13.5px] font-medium text-ink-2">还没有运行记录</div>
          <div className="mt-1 text-[11.5px] text-ink-3">
            点击右上角新建，开始一次智能开发任务
          </div>
          <div className="mt-3 flex justify-center">
            {edition === 'dev' ? (
              <NewSessionMenu
                onNewSession={() => setNewSessionOpen(true)}
                onNewTask={openTaskForm}
              />
            ) : (
              <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={openTaskForm}>
                新建排查
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleRuns.map((run) => {
            const info = phaseInfo(run);
            const waiting = run.phase === 'awaiting_decision' || run.phase === 'failed';
            const productName = String(envOf(run).product_name || '');
            const productVersion = String(envOf(run).product_version || '');
            const summary = run.report || run.conclusion || '';
            return (
              <div
                key={run.id}
                className="rounded-xl border border-line bg-surface p-3.5 transition-colors hover:border-accent/30 hover:bg-surface-2/30"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <span className={`badge ${info.tone} shrink-0`}>
                    {streaming[run.id] && <span className="live-dot" />}
                    {info.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => void openDetail(run)}
                      className="block max-w-full truncate text-left text-[13.5px] font-semibold text-ink transition-colors hover:text-accent"
                      title={run.problem_desc}
                    >
                      {run.problem_desc || '未命名任务'}
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-ink-3">
                      {productName && (
                        <span className="badge badge-muted">
                          {productName} {productVersion}
                        </span>
                      )}
                      <span>{relativeTime(run.created_at)}</span>
                      {(run.retry_count || 0) > 0 && <span>重试 {run.retry_count} 次</span>}
                      {run.session_id && (
                        <span className="font-mono">{run.session_id.slice(0, 8)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    <Button size="sm" icon={<Eye size={12} />} onClick={() => void openDetail(run)}>
                      详情
                    </Button>
                    {waiting && (
                      <>
                        <Button
                          size="sm"
                          icon={<CheckCircle2 size={12} />}
                          onClick={() => void doSolve(run)}
                        >
                          已解决
                        </Button>
                        <Button size="sm" icon={<XCircle size={12} />} onClick={() => openUnsolved(run.id)}>
                          未解决
                        </Button>
                        <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => void rerun(run.id)}>
                          继续
                        </Button>
                      </>
                    )}
                    {(run.phase === 'analyzing' || run.phase === 'merging') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        icon={<Square size={12} />}
                        onClick={() => void abort(run.id)}
                      >
                        中断
                      </Button>
                    )}
                    {run.session_id && (
                      <Button
                        size="sm"
                        icon={<MessageSquare size={12} />}
                        onClick={() =>
                          navigate(`/chat.html?session=${encodeURIComponent(run.session_id!)}`)
                        }
                      >
                        会话
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger hover:text-danger"
                      icon={<Trash2 size={12} />}
                      onClick={() => setDeleteTarget(run)}
                    />
                  </div>
                </div>
                {summary && (
                  <div className="mt-2 line-clamp-2 rounded-lg bg-surface-2/70 px-3 py-2 text-[11.5px] leading-5 text-ink-3">
                    {truncate(summary, 160)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 新建运行 */}
      <Dialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={`新建${edition === 'novice' ? '智能排查' : '智能开发'}`}
        description={
          edition === 'novice'
            ? '填写问题描述并选择产品环境，系统会在工作区中启动 Claude 分析。'
            : '填写问题、触发入口和输出目录，分析过程不会修改客户工程。'
        }
        width="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={creating} icon={<Play size={14} />} onClick={submitCreate}>
              开始任务
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">问题描述 <span className="text-danger">*</span></label>
            <AttachmentField
              value={form.problem_desc}
              onChange={(value) => setForm({ ...form, problem_desc: value })}
              files={problemFiles}
              onFilesChange={setProblemFiles}
              rows={4}
              placeholder={edition === 'novice' ? undefined : '现象、复现步骤、期望结果…'}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">产品环境 <span className="text-danger">*</span></label>
              <select
                value={form.env_id}
                onChange={(event) => setForm({ ...form, env_id: event.target.value })}
                className="input"
              >
                <option value="">选择产品环境</option>
                {envs.map((env) => (
                  <option key={String(env.id)} value={String(env.id)}>
                    {env.project_name} · {env.product_name} {env.product_version}
                  </option>
                ))}
              </select>
            </div>
            {edition === 'dev' && (
              <div>
                <label className="mb-1 block text-[12px] font-medium text-ink-2">触发入口 <span className="text-danger">*</span></label>
                <Input
                  value={form.trigger_url}
                  onChange={(event) => setForm({ ...form, trigger_url: event.target.value })}
                  placeholder="菜单路径 / URL / 类名"
                />
              </div>
            )}
          </div>
          {edition === 'dev' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Switch
                  checked={form.need_debug_log}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, need_debug_log: value }))
                  }
                  label="是否需要排查日志"
                  description="关闭后不新增日志代码，也不生成只加日志的补丁"
                />
                <Switch
                  checked={form.need_diff_report}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, need_diff_report: value }))
                  }
                  label="是否生成差异报告"
                  description="关闭后不调用 diff-report，不生成 HTML 对比报告"
                />
              </div>
              {form.need_debug_log && (
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-ink-2">
                    日志文件名称（不需要后缀）
                  </label>
                  <Input
                    value={form.log_file_name}
                    onChange={(event) => setForm({ ...form, log_file_name: event.target.value })}
                    placeholder="如 ailog，留空默认 ailog"
                  />
                </div>
              )}
            </div>
          )}
          {edition === 'dev' && (
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">补丁输出路径（选填）</label>
              <div className="flex gap-2">
                <Input
                  value={form.patch_output_path}
                  onChange={(event) => setForm({ ...form, patch_output_path: event.target.value })}
                  placeholder="留空则使用产品环境变量中的补丁输出路径"
                />
                <Button
                  className="shrink-0"
                  icon={<FolderOpen size={14} />}
                  onClick={async () => {
                    const result = await api.pickFolder(form.patch_output_path).catch(() => null);
                    if (result?.success && result.path) setForm({ ...form, patch_output_path: result.path });
                  }}
                >
                  选择
                </Button>
              </div>
            </div>
          )}
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">运行日志（可选）</label>
            <AttachmentField
              value={form.log_text}
              onChange={(value) => setForm({ ...form, log_text: value })}
              files={logFiles}
              onFilesChange={setLogFiles}
              rows={4}
              mono
              placeholder={edition === 'novice' ? undefined : '粘贴报错日志，或上传日志文件'}
            />
          </div>
        </div>
      </Dialog>

      {/* 运行详情 */}
      <Dialog
        open={Boolean(detailRun)}
        onClose={() => setDetail(null)}
        title={detailRun ? truncate(detailRun.problem_desc, 60) : '运行详情'}
        description={
          detailRun
            ? `${String(envOf(detailRun).product_name || '')} ${String(envOf(detailRun).product_version || '')} · ${relativeTime(detailRun.created_at)}`
            : ''
        }
        width="max-w-3xl"
        footer={
          detailRun && (
            <>
              {detailRun.session_id && (
                <Button
                  icon={<MessageSquare size={14} />}
                  onClick={() =>
                    navigate(`/chat.html?session=${encodeURIComponent(detailRun.session_id!)}`)
                  }
                >
                  查看会话
                </Button>
              )}
              {(detailRun.phase === 'analyzing' || detailRun.phase === 'merging') && (
                <Button variant="danger" icon={<Square size={13} />} onClick={() => void abort(detailRun.id)}>
                  中断
                </Button>
              )}
              {(detailRun.phase === 'awaiting_decision' || detailRun.phase === 'failed') && (
                <>
                  <Button icon={<XCircle size={14} />} onClick={() => openUnsolved(detailRun.id)}>
                    未解决
                  </Button>
                  <Button icon={<RotateCcw size={14} />} onClick={() => void rerun(detailRun.id)}>
                    继续
                  </Button>
                  <Button variant="primary" icon={<CheckCircle2 size={14} />} onClick={() => void doSolve(detailRun)}>
                    已解决
                  </Button>
                </>
              )}
            </>
          )
        }
      >
        {detailRun && (
          <div className="space-y-3">
            <div className="rounded-xl border border-line bg-surface-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${phaseInfo(detailRun).tone}`}>
                  {streaming[detailRun.id] && <span className="live-dot" />}
                  {phaseInfo(detailRun).label}
                </span>
                <span className="text-[11.5px] text-ink-3">
                  阶段 {detailRun.stage || 1} · 重试 {detailRun.retry_count || 0} 次
                </span>
                {detailRun.verdict && (
                  <span className="badge badge-muted">{detailRun.verdict}</span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11.5px]">
                {detailRun.env_snapshot && (
                  <>
                    <span className="badge badge-accent">
                      {String(envOf(detailRun).product_name || '—')}{' '}
                      {String(envOf(detailRun).product_version || '')}
                    </span>
                    <span className="badge badge-muted">
                      {String(envOf(detailRun).project_name || '未命名项目')}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {[
                { label: '问题描述', value: detailRun.problem_desc, full: true },
                { label: '触发入口', value: detailRun.trigger_url || '—' },
                { label: '代码目录', value: String(envOf(detailRun).code_directory || '—') },
                { label: 'home / war', value: String(envOf(detailRun).package_path || '—') },
                { label: '补丁输出目录', value: detailRun.out_dir || '—' },
                { label: '当前工作目录', value: detailRun.stage_dir || '—' },
              ].map((item) => (
                <div
                  key={item.label}
                  className={cn(
                    'rounded-lg border border-line bg-surface-2 px-3 py-2',
                    item.full && 'sm:col-span-2'
                  )}
                >
                  <div className="text-[10.5px] text-ink-3">{item.label}</div>
                  <div className="mt-0.5 whitespace-pre-wrap break-all text-[12px] leading-5 text-ink-2">
                    {item.value || '—'}
                  </div>
                </div>
              ))}
            </div>

            {detailRun.failure && (
              <div className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12px] text-danger">
                失败原因：{detailRun.failure}
              </div>
            )}

            {(detailRun.report || detailRun.conclusion) && (
              <div>
                <div className="mb-1.5 text-[11.5px] font-medium text-ink-3">结论 / 报告</div>
                <ResultBox
                  content={String(detailRun.report || detailRun.conclusion || '')}
                  maxHeight="max-h-64"
                />
              </div>
            )}

            {detailRun && (
              <div>
                <div className="mb-1.5 flex items-center gap-2 text-[11.5px] font-medium text-ink-3">
                  <span>产物（补丁输出路径下）</span>
                  {detailArtifactsLoading ? (
                    <span className="text-[10.5px] font-normal">正在读取…</span>
                  ) : artifactItems.length ? (
                    <span className="text-[10.5px] font-normal">共 {artifactItems.length} 个</span>
                  ) : null}
                </div>
                {artifactItems.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {artifactItems.map((item) => (
                      <button
                        key={item.path}
                        type="button"
                        onClick={() => void openArtifact(item.path)}
                        className="max-w-[280px] truncate rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-left text-[11px] text-ink-2 transition-colors hover:border-accent/40 hover:text-accent"
                        title={item.path}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ) : !detailArtifactsLoading ? (
                  <div className="rounded-lg border border-dashed border-line bg-surface/40 px-3 py-4 text-center text-[11.5px] text-ink-3">
                    补丁输出路径下暂无产物
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* 已解决确认 */}
      <ConfirmDialog
        open={Boolean(solveTarget)}
        onClose={() => setSolveTarget(null)}
        onConfirm={async () => {
          if (!solveTarget) return;
          setSolveBusy(true);
          try {
            await solve(solveTarget.id);
            setSolveTarget(null);
            toast.success('已进入合并阶段');
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '操作失败');
          } finally {
            setSolveBusy(false);
          }
        }}
        title="确认问题已解决？"
        description={
          <div className="space-y-2">
            <div>将进入阶段二：把改动合并回客开工程并生成补丁包。</div>
            {solveChanges && (
              <ResultBox content={solveChanges.slice(0, 2000)} maxHeight="max-h-40" />
            )}
          </div>
        }
        confirmText="问题已解决，开始合并"
        loading={solveBusy}
      />

      {/* 未解决 */}
      <Dialog
        open={unsolvedOpen}
        onClose={() => setUnsolvedOpen(false)}
        title="问题未解决 · 补充信息"
        description="补充日志或说明后会进入新的排查步骤，旧步骤的产物会保留。"
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setUnsolvedOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (!unsolvedTarget) return;
                try {
                  await unsolve(unsolvedTarget, unsolvedForm);
                  setUnsolvedOpen(false);
                  setDetail(unsolvedTarget);
                  toast.success('已重新开始排查');
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : '操作失败');
                }
              }}
            >
              继续排查
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">补充说明</label>
            <textarea
              value={unsolvedForm.note}
              onChange={(event) => setUnsolvedForm({ ...unsolvedForm, note: event.target.value })}
              rows={3}
              className="input h-auto py-2"
              placeholder={edition === 'novice' ? undefined : '上一轮分析哪里不对、还需要看什么…'}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">补充日志</label>
            <textarea
              value={unsolvedForm.log_text}
              onChange={(event) => setUnsolvedForm({ ...unsolvedForm, log_text: event.target.value })}
              rows={5}
              className="input h-auto py-2 font-mono text-[11.5px]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">从日志文件读取</label>
            <input
              type="file"
              accept=".log,.txt"
              className="block w-full text-[12px] text-ink-3 file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-[12px] file:text-ink-2"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                let text = await file.text();
                if (text.includes('�')) {
                  try {
                    text = new TextDecoder('gbk').decode(await file.arrayBuffer());
                  } catch {
                    /* ignore */
                  }
                }
                setUnsolvedForm((current) => ({
                  ...current,
                  log_text: text,
                  log_file_name: file.name.replace(/\.(log|txt)$/i, ''),
                }));
              }}
            />
          </div>
        </div>
      </Dialog>

      {/* 产物预览 */}
      <Dialog
        open={Boolean(artifact)}
        onClose={() => setArtifact(null)}
        title={artifact?.name || '产物'}
        width="max-w-4xl"
        footer={
          <Button variant="ghost" onClick={() => setArtifact(null)}>
            关闭
          </Button>
        }
      >
        <ResultBox content={artifact?.content || '（空）'} maxHeight="max-h-[65vh]" />
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await remove(deleteTarget.id);
          setDeleteTarget(null);
          setDetail(null);
          toast.success('运行记录已删除');
        }}
        title="删除运行记录"
        description={
          deleteTarget
            ? '只从本机清单移除，不会删除补丁产物和会话。确定删除吗？'
            : ''
        }
        confirmText="删除"
        danger
      />

      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        onCreated={(id) => navigate(`/chat.html?session=${encodeURIComponent(id)}`)}
      />
    </div>
  );
}

export type { ProjectEnv };
