import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Download,
  KeyRound,
  LogOut,
  ShieldCheck,
  Wand2,
  Zap,
} from 'lucide-react';
import { AppShell, SidebarToggle, type NavItem } from '../components/layout/AppShell';
import { EmbeddedBrowserButton } from '../components/browser/EmbeddedBrowser';
import { Button, Spinner } from '../components/ui';
import { useToast } from '../components/ui/toast';
import { api, getPatchServers, hasAuthSession } from '../lib/api';
import { patchApi } from '../lib/patch';
import { relativeTime } from '../lib/utils';
import { useAppStore } from '../store/app';
import { useAuthStore } from '../store/auth';
import { SearchTab } from '../components/patches/SearchTab';
import { MineTab } from '../components/patches/MineTab';
import { UploadTab } from '../components/patches/UploadTab';
import { ProductsTab } from '../components/patches/ProductsTab';
import { ProjectEnvTab } from '../components/patches/ProjectEnvTab';
import { DirectoriesTab } from '../components/patches/DirectoriesTab';
import { AdminConfigTab } from '../components/patches/AdminConfigTab';
import { NodePromptsPanel } from '../components/patches/NodePromptsPanel';
import { AnalysisTab } from '../components/patches/AnalysisTab';
import { SessionsTab } from '../components/patches/SessionsTab';
import { MenusTab } from '../components/patches/MenusTab';
import { ReleaseTab } from '../components/patches/ReleaseTab';
import { CodeSearchTab } from '../components/patches/CodeSearchTab';
import { SmartTab } from '../components/patches/SmartTab';
import { AdaptTab } from '../components/patches/AdaptTab';
import { NodeTab } from '../components/patches/NodeTab';
import { FbipGraphTab } from '../components/patches/FbipGraphTab';
import { PatchDeployTab } from '../components/patches/PatchDeployTab';
import type { PatchRow } from '../lib/types';
import {
  buildDevTabs,
  readCachedCodeSearchUrl,
  readCachedFbipGraphUrl,
  rememberCodeSearchUrl,
  rememberFbipGraphUrl,
} from '../lib/devTabs';

export function PatchCenterPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const edition = useAppStore((state) => state.edition);
  const version = useAppStore((state) => state.version);
  const { user, checking, restore, logout } = useAuthStore();
  const [restoring, setRestoring] = useState(false);
  const [apiStatus, setApiStatus] = useState<'unknown' | 'ok' | 'fail' | 'missing'>('unknown');
  // 先用上次缓存渲染，配置回来后再校准：避免「源码搜索」菜单项刷新时先隐藏再出现。
  const [codeSearchUrl, setCodeSearchUrl] = useState<string | null>(() =>
    readCachedCodeSearchUrl()
  );
  const [fbipGraphUrl, setFbipGraphUrl] = useState<string | null>(() =>
    readCachedFbipGraphUrl()
  );
  const [usage, setUsage] = useState<Record<string, number> | null>(null);
  const [updateInfo, setUpdateInfo] = useState<Record<string, unknown> | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState('');
  const [adaptPreset, setAdaptPreset] = useState<PatchRow | null>(null);

  const admin = /admin|super/i.test(String(user?.role || ''));
  const tabKey = searchParams.get('tab') || 'node';

  useEffect(() => {
    if (!hasAuthSession() || user) return;
    setRestoring(true);
    restore()
      .catch(() => {})
      .finally(() => setRestoring(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    api
      .patchConfig()
      .then((config) => {
        const url = config.code_search_url || '';
        rememberCodeSearchUrl(url);
        setCodeSearchUrl(url);
        const graphUrl = config.fbip_graph_url || '';
        rememberFbipGraphUrl(graphUrl);
        setFbipGraphUrl(graphUrl);
        setApiStatus(config.patch_search_servers?.length ? 'ok' : 'missing');
      })
      .catch(() => setApiStatus('fail'));
  }, []);

  useEffect(() => {
    if (!user) return;
    const loadUsage = () =>
      patchApi
        .usage()
        .then((data) => setUsage(data as Record<string, number>))
        .catch(() => setUsage(null));
    void loadUsage();
    const timer = window.setInterval(loadUsage, 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void checkUpdate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const checkUpdate = async (manual: boolean) => {
    try {
      const { servers, token: authToken } = await getPatchServers();
      if (!servers.length) {
        if (manual) toast.error('补丁中心地址未配置');
        return;
      }
      const result = await api.update.check(servers[0], authToken);
      if (!result.success) {
        if (manual) toast.error(String(result.error || '检查更新失败'));
        return;
      }
      const data = result.data as Record<string, unknown>;
      setUpdateInfo(data);
      setDismissed(false);
      if (manual) {
        if (data.shell_managed) toast.info('桌面版由安装包统一升级');
        else if ((data as { update_available?: boolean }).update_available) {
          toast.success(`发现新版本 ${(data as { remote?: { version?: string } }).remote?.version || ''}`);
        } else {
          toast.success('当前已是最新版本');
        }
      }
    } catch (error) {
      if (manual) toast.error(error instanceof Error ? error.message : '检查更新失败');
    }
  };

  const applyUpdate = async () => {
    const { servers, token: authToken } = await getPatchServers();
    if (!servers.length) return;
    setUpdating(true);
    setProgress('准备下载…');
    try {
      const response = await fetch('/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_url: servers[0], auth_token: authToken }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;
      const handleLine = (line: string) => {
        if (line.startsWith('progress ')) {
          const [, got, total] = line.split(' ');
          const percent = Number(total) > 0 ? Math.round((Number(got) / Number(total)) * 100) : 0;
          setProgress(`下载中 ${percent}%`);
        } else if (line.startsWith('ok ')) {
          done = true;
          const data = JSON.parse(line.slice(3)) as { message?: string };
          setProgress(data.message || '更新完成');
          toast.success(data.message || '更新完成');
          setUpdateInfo(null);
        } else if (line.startsWith('error ')) {
          throw new Error(line.slice(6));
        }
      };
      while (reader && !done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) handleLine(line);
      }
      if (buffer.trim()) handleLine(buffer.trim());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新失败');
      setProgress('');
    } finally {
      setUpdating(false);
    }
  };

  const menus = Array.isArray(user?.menus) ? (user!.menus as string[]) : null;
  const can = (key: string) => !menus || menus.includes(key);

  const tabs = buildDevTabs({ edition, admin, menus, codeSearchUrl });

  const visibleTabs = tabs.filter((tab) => tab.visible);
  const activeTab = visibleTabs.find((tab) => tab.key === tabKey) || visibleTabs[0];

  const switchTab = (key: string) => {
    searchParams.set('tab', key);
    setSearchParams(searchParams, { replace: true });
  };

  const remote = updateInfo?.remote as
    | { version?: string; notes?: string; has_package?: boolean; build_unix?: number }
    | null
    | undefined;
  const showBanner =
    Boolean(updateInfo) &&
    Boolean((updateInfo as { update_available?: boolean }).update_available) &&
    !dismissed;

  // 未登录时保留单一入口；登录后把主页面顶部的页签全部搬到左侧「工作台」。
  const guestNav: NavItem[] = [
    {
      key: 'dev',
      label: '智能开发',
      icon: <Wand2 size={15} />,
      active: true,
    },
  ];

  const sidebarNav: NavItem[] = visibleTabs.map((tab) => ({
    key: tab.key,
    label: tab.label,
    icon: tab.icon,
    active: activeTab?.key === tab.key,
    onClick: () => switchTab(tab.key),
  }));

  if (checking || restoring) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Spinner size={16} /> 正在验证补丁中心登录状态…
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <AppShell nav={guestNav} showSessions showFiles={false}>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="panel w-full max-w-md p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <ShieldCheck size={24} />
            </div>
            <div className="text-[16px] font-semibold text-ink">登录补丁中心</div>
            <p className="mt-2 text-[12.5px] leading-6 text-ink-3">
              检索、上传和适配补丁需要登录补丁中心账号。聊天功能不受影响。
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <Button variant="primary" onClick={() => navigate('/login?next=/')}>
                去登录
              </Button>
              <Button onClick={() => navigate('/chat.html')}>只使用聊天</Button>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell nav={sidebarNav} showSessions showFiles={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <SidebarToggle />
        <div className="flex items-center gap-1.5">
          <span className="text-accent">{activeTab?.icon || <Zap size={15} />}</span>
          <span className="text-[14px] font-semibold text-ink">
            {activeTab?.label || '智能开发'}
          </span>
          {edition === 'novice' && <span className="badge badge-muted">补丁中心</span>}
        </div>
        <div className="flex-1" />
        {usage && (
          <div className="hidden items-center gap-2 text-[11px] text-ink-3 xl:flex">
            <span>在线 {usage.online_users ?? 0}</span>
            <span className="text-line">|</span>
            <span>检索 {usage.search_count ?? 0}</span>
            <span className="text-line">|</span>
            <span>开发 {usage.node_runs ?? 0}</span>
            <span className="text-line">|</span>
            <span>适配 {usage.adapt_runs ?? 0}</span>
          </div>
        )}
        <span
          className={`badge ${
            apiStatus === 'ok'
              ? 'badge-success'
              : apiStatus === 'missing'
                ? 'badge-warning'
                : apiStatus === 'fail'
                  ? 'badge-danger'
                  : 'badge-muted'
          }`}
          title="补丁中心连接状态"
        >
          {apiStatus === 'ok' ? '已连接' : apiStatus === 'missing' ? '配置缺失' : apiStatus === 'fail' ? '连接失败' : '连接中'}
        </span>
        <EmbeddedBrowserButton />
        <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-[10px] font-bold text-accent">
            {(user.display_name || user.username || 'U').slice(0, 1)}
          </span>
          <div className="hidden leading-tight sm:block">
            <div className="text-[11.5px] font-medium text-ink">{user.display_name || user.username}</div>
            <div className="text-[9.5px] text-ink-3">{user.role || '用户'}</div>
          </div>
          <button
            type="button"
            className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-danger"
            title="退出登录"
            onClick={() => {
              logout();
              setUpdateInfo(null);
            }}
          >
            <LogOut size={13} />
          </button>
        </div>
      </div>

      {showBanner && remote && (
        <div className="flex flex-wrap items-center gap-3 border-b border-accent/25 bg-accent-soft/40 px-4 py-2 text-[12px] text-ink-2">
          <Download size={14} className="text-accent" />
          <span>
            发现新版本 <b className="text-ink">v{remote.version}</b>
            {remote.build_unix ? ` · ${relativeTime(Number(remote.build_unix) * 1000)}` : ''}
            {` · 当前 v${version?.version || '—'}`}
          </span>
          {progress && <span className="text-accent">{progress}</span>}
          <div className="flex-1" />
          {remote.notes && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => toast.info(String(remote.notes).slice(0, 300))}
            >
              更新说明
            </Button>
          )}
          <Button size="sm" variant="primary" loading={updating} onClick={applyUpdate}>
            立即更新
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            忽略
          </Button>
        </div>
      )}
      {updating && progress && !showBanner && (
        <div className="border-b border-accent/25 bg-accent-soft/40 px-4 py-2 text-[12px] text-accent">
          {progress}
        </div>
      )}

      <div
        className={
          activeTab?.key === 'codesearch' || activeTab?.key === 'fbipgraph'
            ? 'flex min-h-0 flex-1 flex-col p-3'
            : 'scroll-area min-h-0 flex-1 p-3'
        }
      >
        {activeTab?.key === 'node' && <NodeTab edition={edition} />}
        {activeTab?.key === 'search' && (
          <SearchTab
            admin={admin}
            canAdapt={can('adapt')}
            onAdapt={(row) => {
              setAdaptPreset(row);
              switchTab('adapt');
            }}
          />
        )}
        {activeTab?.key === 'upload' && <UploadTab />}
        {activeTab?.key === 'mine' && <MineTab admin={admin} />}
        {activeTab?.key === 'adapt' && (
          <AdaptTab preset={adaptPreset} onPresetConsumed={() => setAdaptPreset(null)} />
        )}
        {activeTab?.key === 'smart' && <SmartTab />}
        {activeTab?.key === 'codesearch' && <CodeSearchTab url={codeSearchUrl || ''} />}
        {activeTab?.key === 'fbipgraph' && <FbipGraphTab url={fbipGraphUrl} />}
        {activeTab?.key === 'patchdeploy' && <PatchDeployTab />}
        {activeTab?.key === 'directory' && <DirectoriesTab admin={admin} />}
        {activeTab?.key === 'project_env' && <ProjectEnvTab />}
        {activeTab?.key === 'flow' && <AdminConfigTab kind="flow" />}
        {activeTab?.key === 'prompt' && (
          <div className="space-y-6">
            <AdminConfigTab kind="prompt" />
            <div className="border-t border-line pt-5">
              <div className="mb-3 flex items-center gap-2">
                <KeyRound size={15} className="text-accent" />
                <span className="text-[13.5px] font-semibold text-ink">智能开发提示词</span>
              </div>
              <NodePromptsPanel />
            </div>
          </div>
        )}
        {activeTab?.key === 'template' && <AdminConfigTab kind="template" />}
        {activeTab?.key === 'product' && <ProductsTab />}
        {activeTab?.key === 'analysis' && <AnalysisTab />}
        {activeTab?.key === 'menus' && <MenusTab />}
        {activeTab?.key === 'sessions' && <SessionsTab />}
        {activeTab?.key === 'release' && <ReleaseTab />}
      </div>
    </AppShell>
  );
}
