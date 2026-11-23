import { useEffect, useState } from 'react';
import { FolderOpen, PackageCheck, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { patchApi } from '../../lib/patch';
import {
  patchDeployApi,
  type PatchDeployArtifact,
  type PatchDeployEnv,
  type PatchDeployPlan,
  type PatchDeployResult,
} from '../../lib/patchDeploy';
import { formatBytes } from '../../lib/utils';
import type { LocalNodeRun } from '../../store/nodeRuns';
import { useAuthStore } from '../../store/auth';
import { Badge, Button, Checkbox, Dialog, Input, Spinner } from '../ui';
import { ResultBox } from '../ResultBox';
import { useToast } from '../ui/toast';
import { PatchPlanPreview } from '../patches/PatchDeployTab';

/**
 * 会话产出的补丁部署弹窗。
 *
 * 只负责“选 zip / 选目标 / 预检 / 确认部署”，实际部署仍由 patch_deploy 后端完成，
 * 批次也写入同一份 patch_deploy 数据，因此在「补丁管理」里可以直接看到。
 */
export function ChatPatchDeployDialog({
  open,
  sessionId,
  run,
  artifactDir,
  onClose,
  onDeployed,
}: {
  open: boolean;
  sessionId: string;
  run?: LocalNodeRun;
  /** 当前会话「打开产物所在位置」对应的同一个目录；补丁只从这里扫描。 */
  artifactDir?: string;
  onClose: () => void;
  onDeployed?: (result: PatchDeployResult) => void;
}) {
  const toast = useToast();
  const user = useAuthStore((state) => state.user);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<PatchDeployArtifact[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [env, setEnv] = useState<PatchDeployEnv | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [plan, setPlan] = useState<PatchDeployPlan | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [restart, setRestart] = useState(false);
  const [result, setResult] = useState<PatchDeployResult | null>(null);
  const [error, setError] = useState('');

  const envSnapshot = (run?.env_snapshot || {}) as Record<string, unknown>;
  const productName = String(envSnapshot.product_name || '');
  const productVersion = String(envSnapshot.product_version || '');
  const localServiceAddress = String(envSnapshot.local_service_address || '').trim();

  const detect = async (path: string, showError: boolean): Promise<boolean> => {
    const value = path.trim();
    if (!value) {
      setEnv(null);
      setPlan(null);
      if (showError) setError('请填写并检测本地服务地址');
      return false;
    }
    setDetecting(true);
    setError('');
    try {
      const data = await patchDeployApi.detect(value, 'auto');
      setEnv(data.env);
      setPlan(null);
      return true;
    } catch (err) {
      setEnv(null);
      setPlan(null);
      if (showError) setError(err instanceof Error ? err.message : '检测服务目录失败');
      return false;
    } finally {
      setDetecting(false);
    }
  };

  const fallbackArtifacts = () => {
    const root = String(artifactDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const prefix = root ? `${root}/` : '';
    return (run?.artifacts || [])
      .map((path) => ({ path, normalized: path.replace(/\\/g, '/') }))
      .filter(
        ({ normalized }) =>
          normalized.toLowerCase().endsWith('.zip') &&
          (!prefix || normalized === root || normalized.startsWith(prefix))
      )
      .map(({ path }) => ({
        path,
        name: path.split(/[\/]/).pop() || path,
        size: 0,
        updated_at: '',
      }));
  };

  const loadCandidates = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const data = await patchDeployApi.sessionArtifacts(sessionId, artifactDir);
      let list = Array.isArray(data.artifacts) ? data.artifacts : [];
      if (!list.length) list = fallbackArtifacts();
      setCandidates(list);
      setSelected(list.length ? [list[0].path] : []);
      setPlan(null);
    } catch (err) {
      const fallback = fallbackArtifacts();
      setCandidates(fallback);
      setSelected(fallback.length ? [fallback[0].path] : []);
      if (!fallback.length) {
        setError(err instanceof Error ? err.message : '读取会话补丁产物失败');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setResult(null);
    setError('');
    setRestart(false);
    void loadCandidates();
    void (async () => {
      // 优先读取会话关联的最新项目环境，避免任务创建后环境地址被修改却仍用旧快照。
      let liveLocal = '';
      let livePackage = '';
      try {
        const envs = await patchApi.projectEnvs();
        const matched = envs.find(
          (item) => String(item.id) === String(run?.env_id ?? '')
        );
        if (matched) {
          liveLocal = String(matched.local_service_address || '').trim();
          livePackage = String(matched.package_path || '').trim();
        }
      } catch {
        /* 离线/权限异常时退回运行快照 */
      }
      const defaultTarget =
        liveLocal ||
        livePackage ||
        localServiceAddress ||
        String(envSnapshot.package_path || '').trim();
      setTarget(defaultTarget);
      if (defaultTarget) await detect(defaultTarget, false);
    })();
    // 只在本弹窗打开时初始化；会话/运行对象由当前会话固定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  const toggleCandidate = (path: string, checked: boolean) => {
    discardPlan();
    setSelected((current) =>
      checked ? [...current.filter((item) => item !== path), path] : current.filter((item) => item !== path)
    );
  };

  const discardPlan = () => {
    if (plan) {
      void patchDeployApi.cancel(plan.batch_id).catch(() => {});
      setPlan(null);
    }
  };

  const preflight = async () => {
    if (!selected.length) {
      setError('请至少选择一个补丁 ZIP');
      return;
    }
    if (!env) {
      setError('请先检测本地服务地址');
      return;
    }
    discardPlan();
    setPreflighting(true);
    setError('');
    try {
      const data = await patchDeployApi.preflightByPath({
        target: env.input_path || target,
        edition: 'auto',
        product_name: productName,
        product_version: productVersion,
        session_id: sessionId,
        artifact_dir: artifactDir,
        paths: selected,
        operator: user?.username || user?.display_name || undefined,
      });
      setPlan(data);
      setResult(null);
    } catch (err) {
      setPlan(null);
      setError(err instanceof Error ? err.message : '预检失败');
    } finally {
      setPreflighting(false);
    }
  };

  const deploy = async () => {
    if (!plan) return;
    setDeploying(true);
    setError('');
    try {
      const data = await patchDeployApi.deploy({
        batch_id: plan.batch_id,
        restart: restart && Boolean(plan.env.service.can_restart),
        confirm_replace: true,
      });
      setResult(data);
      setPlan(null);
      onDeployed?.(data);
      toast.success(data.message || '补丁部署完成');
      window.dispatchEvent(new CustomEvent('ccweb:patch-deploy-updated'));
    } catch (err) {
      setError(err instanceof Error ? err.message : '补丁部署失败');
    } finally {
      setDeploying(false);
    }
  };

  const closeDialog = () => {
    if (preflighting || deploying) return;
    discardPlan();
    onClose();
  };

  const footer = result ? (
    <Button onClick={closeDialog}>关闭</Button>
  ) : (
    <>
      <Button variant="ghost" disabled={preflighting || deploying} onClick={closeDialog}>
        取消
      </Button>
      {plan ? (
        <Button
          variant="primary"
          icon={<PackageCheck size={14} />}
          loading={deploying}
          disabled={(plan.stats.errors || 0) > 0 || (plan.stats.total || 0) === 0}
          onClick={() => void deploy()}
        >
          确认部署
        </Button>
      ) : (
        <Button
          variant="primary"
          icon={<PackageCheck size={14} />}
          loading={preflighting}
          disabled={!selected.length || !env || detecting}
          onClick={() => void preflight()}
        >
          预检
        </Button>
      )}
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      title="部署 AI 产出的补丁"
      description="将当前会话产出的补丁部署到本机 FBIP 服务目录；部署后可在「补丁管理」中查看和撤回。"
      width="max-w-4xl"
      footer={footer}
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}

        {result ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-success/25 bg-success-soft px-3 py-2 text-[12px] text-ink-2">
              <div className="font-medium text-success">部署完成</div>
              <div className="mt-1">{result.message}</div>
              <div className="mt-1 text-[11px] text-ink-3">
                批次 {result.batch_id} · 替换 {result.replaced} 个 · 新增 {result.added} 个
                {result.service_restarted ? ' · 服务已重启' : ''}
              </div>
            </div>
            {result.log_tail.length > 0 && (
              <ResultBox content={result.log_tail.join('\n')} maxHeight="max-h-72" />
            )}
          </div>
        ) : (
          <>
            <div>
              <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-ink-2">
                补丁文件
                {loading && <Spinner size={13} />}
                <span className="ml-auto text-[10.5px] font-normal text-ink-3">
                  选择要部署的 ZIP
                </span>
              </div>
              {candidates.length === 0 ? (
                <div className="rounded-lg border border-line bg-surface-2 px-3 py-3 text-[12px] text-ink-3">
                  当前会话还没有找到补丁 ZIP。请先让 AI 完成补丁打包，或到「补丁管理」手动上传。
                </div>
              ) : (
                <div className="max-h-44 space-y-1 overflow-auto rounded-lg border border-line bg-surface-2 p-2">
                  {candidates.map((item) => (
                    <div
                      key={item.path}
                      className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-surface-3"
                    >
                      <Checkbox
                        className="min-w-0 flex-1"
                        checked={selected.includes(item.path)}
                        onChange={(checked) => toggleCandidate(item.path, checked)}
                        label={
                          <span
                            className="block truncate font-mono text-[11.5px] text-ink-2"
                            title={item.path}
                          >
                            {item.name}
                          </span>
                        }
                      />
                      {item.size > 0 && (
                        <span className="shrink-0 text-[10.5px] text-ink-3">
                          {formatBytes(item.size)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">
                本机 FBIP 部署目录
              </div>
              <div className="flex gap-2">
                <Input
                  value={target}
                  onChange={(event) => {
                    discardPlan();
                    setTarget(event.target.value);
                    setEnv(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void detect(target, true);
                  }}
                  placeholder="例如 D:\TongWeb\domains\domain1\deployment\fbip"
                />
                <Button
                  className="shrink-0"
                  icon={<FolderOpen size={14} />}
                  disabled={detecting}
                  onClick={async () => {
                    try {
                      const result = await api.pickFolder(target);
                      if (result.success && result.path) {
                        discardPlan();
                        setTarget(result.path);
                        setEnv(null);
                        await detect(result.path, true);
                      } else if (result.error) {
                        toast.error(result.error);
                      }
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : '选择目录失败');
                    }
                  }}
                >
                  选择目录
                </Button>
                <Button
                  className="shrink-0"
                  icon={detecting ? <Spinner size={13} /> : <RefreshCw size={13} />}
                  loading={detecting}
                  onClick={() => void detect(target, true)}
                >
                  检测
                </Button>
              </div>
              {env ? (
                <div className="mt-2 grid gap-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11px]">
                  <div className="flex gap-2">
                    <span className="w-[70px] shrink-0 text-ink-3">环境</span>
                    <span className="font-medium text-ink-2">
                      {env.edition_label} · {env.target_root}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="w-[70px] shrink-0 text-ink-3">服务命令</span>
                    <span className="break-all text-ink-2">{env.service.message}</span>
                  </div>
                </div>
              ) : (
                !detecting && (
                  <div className="mt-1 text-[11px] text-ink-3">
                    需要先检测 FBIP 8.1 / 8.2 服务目录
                  </div>
                )
              )}
            </div>

            {plan && (
              <div className="space-y-3 border-t border-line pt-3">
                <div className="flex flex-wrap gap-2">
                  <Badge tone="warning">已存在 {plan.stats.replace}</Badge>
                  <Badge tone="success">新增 {plan.stats.add}</Badge>
                  <Badge tone="accent">jar内同名类 {plan.stats.shadow}</Badge>
                  <Badge tone="muted">忽略 {plan.stats.ignored}</Badge>
                  {plan.stats.errors > 0 && <Badge tone="danger">错误 {plan.stats.errors}</Badge>}
                </div>
                {plan.stats.errors > 0 && (
                  <div className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12px] text-danger">
                    预检存在错误，不能部署。请展开文件列表查看。
                  </div>
                )}
                <PatchPlanPreview plan={plan} showAll />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Checkbox
                    checked={restart}
                    disabled={!plan.env.service.can_restart}
                    onChange={setRestart}
                    label="部署完成后重启本地服务"
                  />
                  {!plan.env.service.can_restart && (
                    <span className="text-[10.5px] text-ink-3">未找到重启命令，只能部署不重启</span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<RefreshCw size={13} />}
                    loading={preflighting}
                    onClick={() => void preflight()}
                  >
                    重新预检
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
