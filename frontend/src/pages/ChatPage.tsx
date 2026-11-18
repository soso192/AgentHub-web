import { useEffect, useRef, useState } from 'react';
import {
  Columns2,
  Grid2x2,
  Grid3x3,
  LayoutGrid,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Rows2,
  Search,
  Square,
  SquareStack,
  Wand2,
} from 'lucide-react';
import { AppShell, SidebarToggle, type NavItem } from '../components/layout/AppShell';
import { EmbeddedBrowserButton } from '../components/browser/EmbeddedBrowser';
import { ChatPanel } from '../components/chat/ChatPanel';
import { SplitView } from '../components/chat/SplitView';
import { NewSessionDialog } from '../components/chat/SessionList';
import { NewSessionMenu } from '../components/chat/NewSessionMenu';
import { Button, Select, Spinner } from '../components/ui';
import {
  LAYOUT_LABELS,
  LAYOUT_SLOTS,
  useChatStore,
  type ChatView,
  type LayoutKey,
} from '../store/chat';
import { cn } from '../lib/utils';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, hasAuthSession } from '../lib/api';
import {
  buildDevTabs,
  readCachedCodeSearchUrl,
  rememberCodeSearchUrl,
} from '../lib/devTabs';
import { useAppStore } from '../store/app';
import { useAuthStore } from '../store/auth';
import { MessageList } from '../components/chat/MessageList';
import { Eye, X } from 'lucide-react';

const LAYOUT_ICONS: Record<LayoutKey, JSX.Element> = {
  '1x1': <Square size={13} />,
  '2x1': <Columns2 size={13} />,
  '1x2': <Rows2 size={13} />,
  '2x2': <Grid2x2 size={13} />,
  '3x2': <LayoutGrid size={13} />,
  '3x3': <Grid3x3 size={13} />,
};

export function ChatPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const selectSession = useChatStore((state) => state.selectSession);
  const createSession = useChatStore((state) => state.createSession);
  const [replay, setReplay] = useState<ChatView | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const handledParamsRef = useRef('');
  const split = useChatStore((state) => state.split);
  const syncMode = useChatStore((state) => state.syncMode);
  const layout = useChatStore((state) => state.layout);
  const enterSplit = useChatStore((state) => state.enterSplit);
  const exitSplit = useChatStore((state) => state.exitSplit);
  const setLayout = useChatStore((state) => state.setLayout);
  const toggleSync = useChatStore((state) => state.toggleSync);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    const key = searchParams.toString();
    if (handledParamsRef.current === key) return;
    handledParamsRef.current = key;

    const session = searchParams.get('session');
    const history = searchParams.get('history');
    const resume = searchParams.get('resume');
    const resumeSid = searchParams.get('sid');
    const resumeCwd = searchParams.get('cwd');

    if (session) {
      setReplay(null);
      selectSession(session);
      return;
    }
    if (history) {
      setReplayLoading(true);
      api.agent
        .claudeHistory(history, true)
        .then(({ messages }) => {
          setReplay({
            sessionId: `history-${history}`,
            assistant: 'claude',
            model: '',
            cwd: '',
            messages: messages || [],
            liveBlocks: [],
            streaming: false,
            loading: false,
            loaded: true,
            queue: [],
          });
        })
        .finally(() => setReplayLoading(false));
      return;
    }
    if (resume === '1' && resumeSid && resumeCwd) {
      createSession({ cwd: resumeCwd, resumeSessionId: resumeSid })
        .then((id) => {
          selectSession(id);
          setSearchParams({}, { replace: true });
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const edition = useAppStore((state) => state.edition);
  const authUser = useAuthStore((state) => state.user);
  const restoreAuth = useAuthStore((state) => state.restore);
  const logout = useAuthStore((state) => state.logout);
  const loggedIn = Boolean(authUser) || hasAuthSession();
  const admin = /admin|super/i.test(String(authUser?.role || ''));
  const menus = Array.isArray(authUser?.menus) ? authUser!.menus : null;
  // 先用上次缓存渲染，配置回来后再校准：避免「源码搜索」菜单项刷新时先隐藏再出现。
  const [codeSearchUrl, setCodeSearchUrl] = useState<string | null>(() =>
    readCachedCodeSearchUrl()
  );

  useEffect(() => {
    api
      .patchConfig()
      .then((config) => {
        const url = config.code_search_url || '';
        rememberCodeSearchUrl(url);
        setCodeSearchUrl(url);
      })
      .catch(() => {});
  }, []);

  // 直接打开聊天页时补齐登录用户信息，菜单权限才与补丁中心一致。
  useEffect(() => {
    if (hasAuthSession() && !authUser) restoreAuth().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser]);

  // 聊天页与补丁中心共用同一份工作台菜单，避免点击会话后菜单只剩「智能开发」。
  const nav: NavItem[] =
    edition === 'novice'
      ? [
          {
            key: 'patch',
            label: '补丁检索',
            icon: <Search size={15} />,
            onClick: () => {
              if (!loggedIn) {
                navigate(`/login?next=${encodeURIComponent('/?view=patch')}`);
                return;
              }
              navigate('/?view=patch');
            },
          },
          {
            key: 'chat',
            label: '智能开发',
            icon: <MessagesSquare size={15} />,
            active: true,
            onClick: () => navigate('/'),
          },
        ]
      : loggedIn
        ? buildDevTabs({ edition, admin, menus, codeSearchUrl })
            .filter((tab) => tab.visible)
            .map((tab) => ({
              key: tab.key,
              label: tab.label,
              icon: tab.icon,
              onClick: () => navigate(`/?tab=${tab.key}`),
            }))
        : [
            {
              key: 'dev',
              label: '智能开发',
              icon: <Wand2 size={15} />,
              onClick: () => navigate('/'),
            },
          ];

  return (
    <AppShell nav={nav} showSessions showFiles onSessionSelect={() => setReplay(null)}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <SidebarToggle />
        <div className="flex min-w-0 items-center gap-2">
          <MessagesSquare size={16} className="text-accent" />
          <span className="text-[14px] font-semibold text-ink">聊天</span>
          {split && (
            <span className="badge badge-accent">
              分屏 {LAYOUT_SLOTS[layout]} 面板
            </span>
          )}
        </div>
        <div className="flex flex-1 items-center justify-end gap-1.5">
          {split && (
            <>
              <Select
                className="w-[132px]"
                value={layout}
                onChange={(event) => setLayout(event.target.value as LayoutKey)}
                options={Object.entries(LAYOUT_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
              <Button
                size="sm"
                variant={syncMode ? 'primary' : 'default'}
                onClick={toggleSync}
                title="一条消息同时发送到所有面板"
              >
                同步模式
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant={split ? 'primary' : 'default'}
            icon={split ? <SquareStack size={14} /> : <LayoutGrid size={14} />}
            onClick={() => (split ? exitSplit() : enterSplit())}
          >
            {split ? '退出分屏' : '分屏'}
          </Button>
          <NewSessionMenu
            onNewSession={() => setNewOpen(true)}
            onNewTask={() => navigate('/?tab=node&new=1')}
          />
          <EmbeddedBrowserButton />
          {loggedIn && edition !== 'novice' && (
            <Button
              size="sm"
              variant="ghost"
              icon={<LogOut size={14} />}
              title="退出补丁中心登录"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              退出登录
            </Button>
          )}
        </div>
      </div>

      <div className={cn('flex min-h-0 flex-1 flex-col')}>
        {replayLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12.5px] text-ink-3">
            <Spinner size={16} /> 正在加载历史会话…
          </div>
        ) : replay ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-line bg-surface-2/40 px-4 py-2">
              <Eye size={14} className="text-accent" />
              <span className="text-[12.5px] font-medium text-ink-2">只读历史回放</span>
              <span className="truncate font-mono text-[10.5px] text-ink-3">
                {replay.sessionId.replace(/^history-/, '')}
              </span>
              <div className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                icon={<X size={13} />}
                onClick={() => {
                  setReplay(null);
                  setSearchParams({}, { replace: true });
                }}
              >
                返回聊天
              </Button>
            </div>
            <MessageList view={replay} />
            <div className="border-t border-line px-4 py-2 text-center text-[11px] text-ink-3">
              这是 Claude 原生会话记录，只读展示，不能继续发送消息
            </div>
          </div>
        ) : split ? (
          <SplitView />
        ) : (
          <ChatPanel sessionId={currentSessionId} />
        )}
      </div>

      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </AppShell>
  );
}
