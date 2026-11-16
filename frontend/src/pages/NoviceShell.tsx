import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  KeyRound,
  LogIn,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Search,
  Server,
  Sparkles,
} from 'lucide-react';
import { hasAuthSession } from '../lib/api';
import { AppShell, SidebarToggle, type NavItem } from '../components/layout/AppShell';
import { ChatPanel } from '../components/chat/ChatPanel';
import { NewSessionMenu } from '../components/chat/NewSessionMenu';
import { NewSessionDialog } from '../components/chat/SessionList';
import { NewTaskDialog } from '../components/novice/NewTaskDialog';
import { ProjectEnvTab } from '../components/patches/ProjectEnvTab';
import { SearchTab } from '../components/patches/SearchTab';
import { NodeTab } from '../components/patches/NodeTab';
import { Button } from '../components/ui';
import { useToast } from '../components/ui/toast';
import { useAppStore } from '../store/app';
import { useAuthStore } from '../store/auth';
import { useChatStore } from '../store/chat';

type View = 'chat' | 'runs' | 'patch' | 'env';

const VIEW_TITLES: Record<View, string> = {
  chat: '智能开发',
  runs: '排查记录',
  patch: '补丁检索',
  env: '产品环境',
};

export function NoviceShell({ initialView }: { initialView?: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const edition = useAppStore((state) => state.edition);
  const { user, restore, logout } = useAuthStore();
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const refreshSessions = useChatStore((state) => state.refreshSessions);
  const loadSession = useChatStore((state) => state.loadSession);
  const [taskOpen, setTaskOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  const view = (searchParams.get('view') as View) || (initialView as View) || 'chat';
  const safeView: View = ['chat', 'runs', 'patch', 'env'].includes(view) ? view : 'chat';
  const loggedIn = Boolean(user) || hasAuthSession();

  useEffect(() => {
    if (hasAuthSession() && !user) {
      restore()
        .then((result) => {
          // refresh token 也失效时 patchMe 会清空登录态，此时回登录页；网络错误不会清 token。
          if (!result && !hasAuthSession()) {
            navigate('/login?reason=expired', { replace: true });
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    refreshSessions().catch(() => {});
  }, [refreshSessions]);

  // 左侧「创建开发任务」通过 ?newTask=1 打开任务弹窗
  useEffect(() => {
    if (searchParams.get('newTask') !== '1') return;
    if (!loggedIn) {
      navigate(`/login?next=${encodeURIComponent('/?newTask=1')}`, { replace: true });
      return;
    }
    setTaskOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('newTask');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, loggedIn, navigate]);

  // 未登录时只能使用聊天；补丁检索/环境变量/排查记录需要登录
  useEffect(() => {
    if (!loggedIn && safeView !== 'chat') {
      const next = `/?view=${safeView}`;
      navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
    }
  }, [loggedIn, safeView, navigate]);

  useEffect(() => {
    if (safeView === 'chat' && currentSessionId) {
      loadSession(currentSessionId).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeView, currentSessionId]);

  const setView = (next: View) => {
    if (next === 'chat') setSearchParams({}, { replace: true });
    else setSearchParams({ view: next }, { replace: true });
  };

  // 实施版左侧菜单只保留两个入口：补丁检索在上，智能开发在下
  const nav: NavItem[] = useMemo(
    () => [
      {
        key: 'patch',
        label: '补丁检索',
        icon: <Search size={15} />,
        active: safeView === 'patch',
        onClick: () => {
          if (!loggedIn) {
            navigate(`/login?next=${encodeURIComponent('/?view=patch')}`);
            return;
          }
          setView('patch');
        },
      },
      {
        key: 'chat',
        label: '智能开发',
        icon: <MessagesSquare size={15} />,
        active: safeView === 'chat',
        onClick: () => setView('chat'),
      },
    ],
    [safeView, loggedIn, navigate]
  );

  return (
    <AppShell nav={nav} showSessions showFiles={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <SidebarToggle />
        <div className="flex items-center gap-1.5">
          <Sparkles size={15} className="text-accent" />
          <span className="text-[14px] font-semibold text-ink">{VIEW_TITLES[safeView]}</span>
          <span className="badge badge-accent">实施版</span>
        </div>
        <div className="flex-1" />
        {safeView === 'chat' && loggedIn && (
          <Button size="sm" icon={<Server size={13} />} onClick={() => setView('env')}>
            产品环境
          </Button>
        )}
        {(safeView === 'chat' || safeView === 'runs') && loggedIn && (
          <NewSessionMenu
            onNewSession={() => setNewSessionOpen(true)}
            onNewTask={() => setTaskOpen(true)}
          />
        )}
        {(safeView === 'patch' || safeView === 'env') && loggedIn && (
          <Button size="sm" icon={<ArrowLeft size={14} />} onClick={() => setView('chat')}>
            返回
          </Button>
        )}
        {loggedIn ? (
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-[10px] font-bold text-accent">
              {(user?.display_name || user?.username || 'U').slice(0, 1)}
            </span>
            <div className="hidden leading-tight sm:block">
              <div className="text-[11.5px] font-medium text-ink">
                {user?.display_name || user?.username || '登录中…'}
              </div>
              <div className="text-[9.5px] text-ink-3">{user?.role || ''}</div>
            </div>
            <button
              type="button"
              className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-danger"
              title="退出登录"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              <LogOut size={13} />
            </button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon={<LogIn size={13} />}
            onClick={() => navigate('/login?next=%2F')}
          >
            登录
          </Button>
        )}
      </div>

      {safeView === 'chat' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {!currentSessionId && (
            <div className="border-b border-line bg-surface-2/50 px-4 py-2 text-[11.5px] text-ink-3">
              {loggedIn
                ? '点击右上角「新建会话」，选择「创建开发任务」填写产品环境和问题，或在下方直接与 AI 对话。'
                : '未登录也可以直接对话；登录后可创建智能开发任务并使用补丁检索。'}
            </div>
          )}
          <ChatPanel sessionId={currentSessionId} />
        </div>
      )}

      {safeView === 'runs' && loggedIn && (
        <div className="scroll-area min-h-0 flex-1 p-3">
          <NodeTab edition="novice" />
        </div>
      )}

      {safeView === 'patch' && loggedIn && (
        <div className="scroll-area min-h-0 flex-1 p-3">
          <SearchTab admin={false} canAdapt={false} />
        </div>
      )}

      {safeView === 'env' && loggedIn && (
        <div className="scroll-area min-h-0 flex-1 p-3">
          <div className="mb-3 flex items-center gap-2">
            <KeyRound size={15} className="text-accent" />
            <span className="text-[13.5px] font-semibold text-ink">产品环境</span>
            <span className="text-[11.5px] text-ink-3">
              这些环境会用于「创建任务」时的产品、目录、JDK、数据库等信息
            </span>
          </div>
          <ProjectEnvTab />
        </div>
      )}

      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        onCreated={() => setView('chat')}
      />

      {loggedIn && (
        <NewTaskDialog
          open={taskOpen}
          onClose={() => setTaskOpen(false)}
          onStarted={(sessionId) => {
            setView('chat');
            useChatStore.getState().selectSession(sessionId);
            toast.success('任务已创建');
          }}
        />
      )}
    </AppShell>
  );
}

export function NoviceChatPlaceholder() {
  return (
    <div className="flex flex-1 items-center justify-center text-[12.5px] text-ink-3">
      <MessageSquare size={16} className="mr-2" /> 正在加载…
    </div>
  );
}
