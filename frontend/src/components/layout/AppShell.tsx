import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Keyboard,
  Menu,
  PanelLeftClose,
  Settings,
  Sun,
  Moon,
  Zap,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cn, readStorage, writeStorage } from '../../lib/utils';
import { useTheme } from '../../lib/theme';
import { hasAuthSession } from '../../lib/api';
import { useAppStore } from '../../store/app';
import { useAuthStore } from '../../store/auth';
import { useChatStore } from '../../store/chat';
import { Button, Dialog, IconButton, Spinner, Tabs, Tooltip } from '../ui';
import { useToast } from '../ui/toast';
import { downloadManual, saveBlob } from '../../lib/patch';
import { SessionList } from '../chat/SessionList';
import { FileBrowser } from '../chat/FileBrowser';
import { EnvCheckView } from '../novice/EnvCheckView';
import { ProjectEnvTab } from '../patches/ProjectEnvTab';
import { UpdatePanel } from '../settings/UpdatePanel';

export interface NavItem {
  key: string;
  label: string;
  icon: ReactNode;
  href?: string;
  active?: boolean;
  onClick?: () => void;
  badge?: ReactNode;
}

const ShellContext = createContext<{ toggleSidebar: () => void }>({ toggleSidebar: () => {} });

export function useShell() {
  return useContext(ShellContext);
}

export function SidebarToggle({ className }: { className?: string }) {
  const { toggleSidebar } = useShell();
  return (
    <IconButton label="打开/收起侧边栏" onClick={toggleSidebar} className={className}>
      <Menu size={17} />
    </IconButton>
  );
}

function SettingsDialog({
  open,
  onClose,
  tab,
  onTabChange,
  loggedIn,
}: {
  open: boolean;
  onClose: () => void;
  tab: string;
  onTabChange: (tab: string) => void;
  loggedIn: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const version = useAppStore((state) => state.version);
  const edition = useAppStore((state) => state.edition);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="设置"
      width={
        tab === 'project-env'
          ? 'max-w-5xl'
          : tab === 'env-check'
            ? 'max-w-3xl'
            : 'max-w-xl'
      }
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <Tabs
        items={[
          { key: 'appearance', label: '外观' },
          ...(edition === 'novice' && loggedIn
            ? [{ key: 'project-env', label: '项目环境' }]
            : []),
          { key: 'env-check', label: '环境检查' },
          { key: 'about', label: '关于' },
        ]}
        value={tab}
        onChange={onTabChange}
        className="mb-4"
      />
      {tab === 'project-env' && edition === 'novice' && loggedIn ? (
        <ProjectEnvTab />
      ) : tab === 'env-check' ? (
        <EnvCheckView embedded />
      ) : tab === 'appearance' ? (
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-[12.5px] font-medium text-ink-2">主题</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { key: 'dark' as const, label: '深色', icon: <Moon size={15} /> },
                { key: 'light' as const, label: '浅色', icon: <Sun size={15} /> },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTheme(item.key)}
                  className={cn(
                    'flex items-center gap-2 rounded-xl border px-3 py-3 text-left text-[13px] transition-colors',
                    theme === item.key
                      ? 'border-accent/50 bg-accent-soft text-ink'
                      : 'border-line bg-surface-2 text-ink-2 hover:border-accent/30'
                  )}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-line bg-surface-2 p-3 text-[12px] text-ink-3">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-ink-2">
              <Keyboard size={13} /> 快捷键
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <span>发送消息</span>
              <span className="text-right"><span className="kbd">Enter</span></span>
              <span>换行</span>
              <span className="text-right"><span className="kbd">Shift</span> + <span className="kbd">Enter</span></span>
              <span>停止生成</span>
              <span className="text-right">输入框右侧停止按钮</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3 text-[12.5px] text-ink-2">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 p-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-white">
              <Zap size={22} />
            </div>
            <div>
              <div className="text-[14px] font-semibold text-ink">智能开发平台</div>
              <div className="text-[11.5px] text-ink-3">
                版本 {version?.version || '—'} · {edition === 'novice' ? '实施版' : '开发版'}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-[88px_1fr] gap-2 rounded-xl border border-line bg-surface-2 p-3">
            <span className="text-ink-3">平台</span>
            <span>{version?.platform || '—'}</span>
            <span className="text-ink-3">程序路径</span>
            <span className="break-all font-mono text-[11px]">{version?.exe_path || '—'}</span>
            <span className="text-ink-3">SHA-256</span>
            <span className="break-all font-mono text-[11px]">{version?.sha256 || '—'}</span>
          </div>
          <div className="rounded-xl border border-line bg-surface-2 p-3">
            <div className="mb-2 text-[12.5px] font-medium text-ink-2">版本更新</div>
            <UpdatePanel currentVersion={version?.version} />
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function AppShell({
  nav,
  children,
  showSessions = true,
  showFiles = true,
  onSessionSelect,
  headerExtra,
  className,
}: {
  nav: NavItem[];
  children: ReactNode;
  showSessions?: boolean;
  showFiles?: boolean;
  onSessionSelect?: (id: string) => void;
  headerExtra?: ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { theme, toggleTheme } = useTheme();
  const version = useAppStore((state) => state.version);
  const edition = useAppStore((state) => state.edition);
  const authUser = useAuthStore((state) => state.user);
  const loggedIn = Boolean(authUser) || hasAuthSession();
  const refreshSessions = useChatStore((state) => state.refreshSessions);
  // 注意：必须按 JSON 解析，不能按原始字符串读取。
  // 之前 parse=false 会把 "false" 当成非空字符串 → collapsed 恒为 true，
  // 导致刷新页面、或切换到另一个页面时侧边栏自动收起。
  const [collapsed, setCollapsed] = useState(
    () => readStorage<boolean>('cc-web-sidebar-collapsed', false) === true
  );
  // 「工作台」分区折叠：只响应用户操作并持久化，刷新/切换页面不会自动展开或收起。
  const [workbenchCollapsed, setWorkbenchCollapsed] = useState(
    () => readStorage<boolean>('cc-web-workbench-collapsed', false) === true
  );
  const toggleWorkbench = () => {
    setWorkbenchCollapsed((value) => {
      const next = !value;
      writeStorage('cc-web-workbench-collapsed', next);
      return next;
    });
  };
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('appearance');
  const [helpBusy, setHelpBusy] = useState(false);

  useEffect(() => {
    refreshSessions().catch(() => {});
  }, [refreshSessions]);

  // 首次登录 /?settings=check 直接打开设置里的环境检查
  useEffect(() => {
    if (loggedIn && searchParams.get('settings') === 'check') {
      setSettingsTab('env-check');
      setSettingsOpen(true);
    }
  }, [loggedIn, searchParams]);

  // 未登录时项目环境页签不可用，自动回到外观；环境检查不依赖登录，保持可用
  useEffect(() => {
    if (!loggedIn && settingsTab === 'project-env') {
      setSettingsTab('appearance');
    }
  }, [loggedIn, settingsTab]);

  const closeSettings = () => {
    setSettingsOpen(false);
    if (searchParams.has('settings')) {
      const next = new URLSearchParams(searchParams);
      next.delete('settings');
      setSearchParams(next, { replace: true });
    }
  };

  const downloadHelp = async () => {
    if (helpBusy) return;
    if (!hasAuthSession()) {
      toast.error('请先登录补丁中心后再下载使用手册');
      return;
    }
    setHelpBusy(true);
    try {
      const { blob, filename } = await downloadManual(edition);
      saveBlob(blob, filename);
      toast.success('使用手册已开始下载');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载使用手册失败');
    } finally {
      setHelpBusy(false);
    }
  };

  const toggleSidebar = () => {
    if (window.innerWidth < 1024) {
      setMobileOpen((value) => !value);
    } else {
      const next = !collapsed;
      setCollapsed(next);
      writeStorage('cc-web-sidebar-collapsed', next);
    }
  };

  const handleNav = (item: NavItem) => {
    if (item.onClick) {
      item.onClick();
      setMobileOpen(false);
      return;
    }
    if (item.href) {
      navigate(item.href);
      setMobileOpen(false);
    }
  };

  return (
    <ShellContext.Provider value={{ toggleSidebar }}>
      <div className={cn('flex h-full min-h-0 w-full overflow-hidden', className)}>
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px] lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          className={cn(
            'z-50 flex h-full shrink-0 flex-col border-r border-line bg-surface/80 backdrop-blur-xl transition-transform duration-200',
            'fixed inset-y-0 left-0 w-[278px] lg:static',
            mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
            collapsed && 'lg:hidden'
          )}
        >
          <div className="flex items-center gap-2.5 px-3.5 py-3.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--accent)] to-[#a78bfa] text-white shadow-[0_6px_18px_rgba(124,140,255,.32)]">
              <Zap size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold tracking-tight text-ink">智能开发平台</div>
              <div className="text-[10px] text-ink-3">
                {edition === 'novice' ? '实施版' : 'AI 编程工作台'} · v{version?.version || '—'}
              </div>
            </div>
            <IconButton
              label="收起侧边栏"
              onClick={toggleSidebar}
              className="hidden lg:inline-flex"
            >
              <PanelLeftClose size={15} />
            </IconButton>
            <IconButton
              label="关闭侧边栏"
              onClick={() => setMobileOpen(false)}
              className="lg:hidden"
            >
              <PanelLeftClose size={15} />
            </IconButton>
          </div>

          <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2 px-2">
            <nav
              className="shrink-0 rounded-xl border border-line bg-surface-2/75 p-1.5 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_6px_16px_rgba(0,0,0,0.14)]"
              style={edition === 'novice' ? { paddingBottom: 6 } : undefined}
            >
              <button
                type="button"
                onClick={toggleWorkbench}
                title={workbenchCollapsed ? '展开工作台' : '收起工作台'}
                aria-expanded={!workbenchCollapsed}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-lg px-2 pb-1.5 pt-0.5 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-3 transition-colors hover:text-ink-2',
                  !workbenchCollapsed && 'mb-1.5 border-b border-line-soft'
                )}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span className="flex-1">工作台</span>
                {workbenchCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
              {!workbenchCollapsed && (
                <div
                  className="scroll-area max-h-[42vh] space-y-0.5"
                  style={edition === 'novice' ? { marginBottom: 120 } : undefined}
                >
                  {nav.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => handleNav(item)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-[12.5px] transition-colors',
                        item.active
                          ? 'border-accent/30 bg-accent-soft font-semibold text-accent'
                          : 'border-transparent text-ink-2 hover:bg-surface-3 hover:text-ink'
                      )}
                    >
                      <span className="shrink-0 opacity-90">{item.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badge}
                    </button>
                  ))}
                </div>
              )}
            </nav>

            {showSessions && (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface-2/50 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_6px_16px_rgba(0,0,0,0.12)]">
                {/* 「会话」标题与视图/新建/批量/搜索按钮统一由 SessionList 渲染在同一行 */}
                <SessionList onSessionSelect={onSessionSelect} />
              </div>
            )}

            {showFiles && (
              <div className="shrink-0 overflow-hidden rounded-xl border border-line bg-surface-3/40 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_6px_16px_rgba(0,0,0,0.12)]">
                <FileBrowser />
              </div>
            )}
          </div>

          <div className="mt-auto flex items-center gap-1 border-t border-line-soft px-2 py-2">
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 justify-start"
              icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? '浅色模式' : '深色模式'}
            </Button>
            <Tooltip content="下载使用手册">
              <IconButton
                label="下载使用手册"
                disabled={helpBusy}
                onClick={() => void downloadHelp()}
              >
                {helpBusy ? <Spinner size={15} /> : <HelpCircle size={15} />}
              </IconButton>
            </Tooltip>
            <IconButton
              label="设置"
              onClick={() => {
                setSettingsTab('appearance');
                setSettingsOpen(true);
              }}
            >
              <Settings size={15} />
            </IconButton>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {headerExtra}
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        </div>

        <SettingsDialog
          open={settingsOpen}
          onClose={closeSettings}
          tab={settingsTab}
          onTabChange={setSettingsTab}
          loggedIn={loggedIn}
        />
      </div>
    </ShellContext.Provider>
  );
}

export function HelpHint() {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-3">
      <BookOpen size={12} /> 查看 README 获取更多说明
    </span>
  );
}
