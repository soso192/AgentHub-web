import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ChevronRight,
  FolderOpen,
  GripVertical,
  ListChecks,
  MessageSquarePlus,
  Pencil,
  Search,
  SlidersHorizontal,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, hasAuthSession, type SessionSummary } from '../../lib/api';
import { patchApi } from '../../lib/patch';
import type { AssistantInfo, NodeRun, ProjectEnv } from '../../lib/types';
import { assistantLabel, basename, cn, relativeTime } from '../../lib/utils';
import { useAppStore } from '../../store/app';
import { useAuthStore } from '../../store/auth';
import { useChatStore } from '../../store/chat';
import { useNodeStore } from '../../store/nodeRuns';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Select,
  Spinner,
} from '../ui';
import { useToast } from '../ui/toast';
import { ViewOptionsMenu } from './ViewOptionsMenu';
import {
  DATE_GROUP_ORDER,
  dateGroupLabel,
  loadAliases,
  loadCollapsed,
  loadGroupOrders,
  loadPrefs,
  loadSessionOrder,
  loadUngrouped,
  normalizePath,
  saveAliases,
  saveCollapsed,
  saveGroupOrders,
  savePrefs,
  saveSessionOrder,
  saveUngrouped,
  type GroupBy,
  type SessionViewPrefs,
  type SortBy,
} from './sessionView';

/* ── 新建会话 ── */

export function NewSessionDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const { assistants, currentAssistant, cwd, createSession, setCwd } = useChatStore();
  const edition = useAppStore((state) => state.edition);
  const toast = useToast();
  const [dir, setDir] = useState(cwd);
  const [assistant, setAssistant] = useState(currentAssistant);
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDir(cwd);
    setAssistant(currentAssistant);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickFolder = async () => {
    setPicking(true);
    try {
      const result = await api.pickFolder(dir);
      if (result.success && result.path) setDir(result.path);
      else if (result.error) toast.error(result.error);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '打开目录选择器失败');
    } finally {
      setPicking(false);
    }
  };

  const create = async () => {
    if (!dir.trim()) {
      toast.error('请填写工作目录');
      return;
    }
    setCreating(true);
    try {
      setCwd(dir.trim());
      const id = await createSession({ cwd: dir.trim(), assistant });
      toast.success('会话已创建');
      onCreated?.(id);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建会话失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建会话"
      description="选择 AI 助手和工作目录。目录是 AI 读写文件的范围。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={create} loading={creating}>
            创建并开始
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-ink-2">
            工作目录 <span className="text-danger">*</span>
          </label>
          <div className="flex gap-2">
            <Input
              value={dir}
              onChange={(event) => setDir(event.target.value)}
              placeholder={edition === 'novice' ? undefined : '例如：D:/projects/my-app'}
            />
            <Button
              icon={picking ? <Spinner size={14} /> : <FolderOpen size={14} />}
              onClick={pickFolder}
              disabled={picking}
              className="shrink-0"
            >
              选择
            </Button>
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-ink-2">助手</label>
          <Select
            value={assistant}
            onChange={(event) => setAssistant(event.target.value)}
            options={(assistants.length
              ? assistants
              : ([
                  {
                    name: 'claude',
                    display_name: 'Claude Code',
                    is_default: true,
                    available: true,
                  },
                ] as AssistantInfo[])
            ).map((item) => ({
              value: item.name,
              label: `${item.display_name || assistantLabel(item.name)}${
                item.available === false ? '（未检测到）' : ''
              }`,
              disabled: item.available === false,
            }))}
          />
        </div>
      </div>
    </Dialog>
  );
}

/* ── 会话行 ── */

type RenderGroupKind = 'project' | 'workspace' | 'ungrouped' | 'date' | 'plain';

interface RenderGroup {
  key: string;
  name: string;
  kind: RenderGroupKind;
  sessions: SessionSummary[];
  showHeader: boolean;
}

function SessionRow({
  session,
  active,
  manageMode,
  selected,
  indented,
  manual,
  draggable,
  onSelect,
  onToggleSelect,
  onRename,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  session: SessionSummary;
  active: boolean;
  manageMode: boolean;
  selected: boolean;
  indented: boolean;
  manual: boolean;
  draggable: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const title = session.name || session.firstMessage || '未命名会话';
  const activate = () => (manageMode ? onToggleSelect() : onSelect());
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      aria-current={active ? 'true' : undefined}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter') activate();
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative flex cursor-pointer items-start gap-2 rounded-xl border px-2.5 py-2 transition-all duration-150',
        indented && 'ml-2',
        draggable && 'cursor-grab active:cursor-grabbing',
        active &&
          'border-accent/55 bg-accent-soft shadow-[inset_3px_0_0_var(--accent)]',
        selected &&
          'border-accent/55 bg-accent-soft ring-1 ring-inset ring-accent/25',
        !active && !selected && 'border-transparent hover:border-line hover:bg-surface-2'
      )}
    >
      {manageMode && (
        <span className="mt-0.5 shrink-0" onClick={(event) => event.stopPropagation()}>
          <Checkbox checked={selected} onChange={onToggleSelect} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[12.5px]',
              active ? 'font-semibold text-accent' : 'text-ink-2'
            )}
            title={title}
          >
            {title}
          </span>
          {session.isStreaming && <span className="live-dot shrink-0" title="正在运行" />}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-3">
          <span className="truncate">{assistantLabel(session.assistant)}</span>
          <span>·</span>
          <span className="shrink-0">{relativeTime(session.modified)}</span>
          {session.messageCount > 0 && (
            <>
              <span>·</span>
              <span className="shrink-0">{session.messageCount} 条</span>
            </>
          )}
        </div>
      </div>
      {!manageMode && (
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {manual && <GripVertical size={12} className="shrink-0 text-ink-3" />}
          <button
            type="button"
            draggable={false}
            className="rounded-md p-1 text-ink-3 hover:bg-surface-3 hover:text-ink"
            title="重命名"
            onClick={(event) => {
              event.stopPropagation();
              onRename();
            }}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            draggable={false}
            className="rounded-md p-1 text-ink-3 hover:bg-danger-soft hover:text-danger"
            title="删除"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function DateGroupHeader({
  group,
  collapsed,
  onToggle,
}: {
  group: RenderGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2/70"
    >
      <ChevronRight
        size={13}
        className={cn(
          'shrink-0 text-ink-3 transition-transform duration-150',
          !collapsed && 'rotate-90'
        )}
      />
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {group.name}
      </span>
      <span className="shrink-0 text-[10.5px] text-ink-3">{group.sessions.length}</span>
    </div>
  );
}

function GroupHeader({
  group,
  manual,
  manageMode,
  draggable,
  collapsed,
  onToggle,
  onRename,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  group: RenderGroup;
  manual: boolean;
  manageMode: boolean;
  draggable: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const canManage = group.kind === 'project' || group.kind === 'workspace';
  const canDrag = draggable && canManage && !manageMode;
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={canDrag}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        'group flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2/70',
        canDrag && 'cursor-grab active:cursor-grabbing'
      )}
    >
      <ChevronRight
        size={13}
        className={cn(
          'shrink-0 text-ink-3 transition-transform duration-150',
          !collapsed && 'rotate-90'
        )}
      />
      <span
        className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-ink-2"
        title={group.name}
      >
        {group.name}
      </span>
      <span className="shrink-0 text-[10.5px] text-ink-3">{group.sessions.length}</span>
      {canManage && !manageMode && (
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {manual && <GripVertical size={12} className="shrink-0 text-ink-3" />}
          <button
            type="button"
            draggable={false}
            className="rounded-md p-1 text-ink-3 hover:bg-surface-3 hover:text-ink"
            title="重命名分组"
            onClick={(event) => {
              event.stopPropagation();
              onRename();
            }}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            draggable={false}
            className="rounded-md p-1 text-ink-3 hover:bg-danger-soft hover:text-danger"
            title="移除分组"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ── 会话列表 ── */

export function SessionList({
  onSessionSelect,
  compact = false,
}: {
  onSessionSelect?: (id: string) => void;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const edition = useAppStore((state) => state.edition);
  const authUser = useAuthStore((state) => state.user);
  const loggedIn = Boolean(authUser) || hasAuthSession();
  const {
    sessions,
    currentSessionId,
    selectSession,
    renameSession,
    deleteSession,
    deleteSessions,
    loadingSessions,
  } = useChatStore();

  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [prefs, setPrefs] = useState<SessionViewPrefs>(() => loadPrefs(edition));
  const [sessionOrder, setSessionOrder] = useState<string[]>(() => loadSessionOrder());
  const [groupOrders, setGroupOrders] = useState(() => loadGroupOrders());
  const [aliases, setAliases] = useState(() => loadAliases());
  const [ungrouped, setUngrouped] = useState(() => loadUngrouped());
  const [collapsedGroups, setCollapsedGroups] = useState(() => loadCollapsed());
  const [envs, setEnvs] = useState<ProjectEnv[]>([]);
  const [nodeRuns, setNodeRuns] = useState<NodeRun[]>([]);
  // 本页内存里的运行清单：新建任务/上报后立即参与分组，不用等重新拉取。
  const storeRuns = useNodeStore((state) => state.runs);

  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  const [renamingGroup, setRenamingGroup] = useState<{ key: string; name: string } | null>(null);
  const [groupRenameValue, setGroupRenameValue] = useState('');
  const [deletingGroup, setDeletingGroup] = useState<RenderGroup | null>(null);
  const [dragSession, setDragSession] = useState<{ id: string; groupKey: string } | null>(null);
  const [dragGroupKey, setDragGroupKey] = useState<string | null>(null);

  const viewMenuRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLSpanElement>(null);
  const manual = prefs.sortBy === 'manual';

  /* 会话变化后清理失效选中项 */
  useEffect(() => {
    setSelectedIds((prev) => {
      if (!prev.size) return prev;
      const alive = new Set(sessions.map((session) => session.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (alive.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [sessions]);

  /* 按项目分组需要产品环境和节点运行快照 */
  useEffect(() => {
    if (prefs.groupBy !== 'project') return;
    let cancelled = false;
    let token = '';
    try {
      token = localStorage.getItem('patch-search-access-token') || '';
    } catch {
      /* ignore */
    }
    const envPromise = token ? patchApi.projectEnvs().catch(() => []) : Promise.resolve([]);
    Promise.all([
      envPromise,
      api.nodeRuns
        .list()
        .then((result) => result.data || [])
        .catch(() => []),
    ]).then(([envList, runs]) => {
      if (cancelled) return;
      setEnvs(envList);
      setNodeRuns(runs);
    });
    return () => {
      cancelled = true;
    };
  }, [prefs.groupBy, authUser?.id]);

  /* 视图菜单点击外部关闭 */
  useEffect(() => {
    if (!viewMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!viewMenuRef.current?.contains(event.target as Node)) setViewMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [viewMenuOpen]);

  /* 新建菜单点击外部关闭 */
  useEffect(() => {
    if (!newMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!newMenuRef.current?.contains(event.target as Node)) setNewMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNewMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [newMenuOpen]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return sessions;
    return sessions.filter((session) =>
      `${session.name || ''} ${session.firstMessage || ''} ${session.cwd || ''}`
        .toLowerCase()
        .includes(keyword)
    );
  }, [sessions, query]);

  const manualIndex = useMemo(() => {
    const map = new Map<string, number>();
    sessionOrder.forEach((id, index) => map.set(id, index));
    return map;
  }, [sessionOrder]);

  const projectInfoBySession = useMemo(() => {
    const map = new Map<string, { key: string; name: string }>();
    if (prefs.groupBy !== 'project') return map;
    const skip = new Set(ungrouped.project || []);

    const runEnvBySession = new Map<string, Record<string, unknown>>();
    const allRuns = [...nodeRuns, ...(storeRuns as unknown as NodeRun[])];
    for (const run of allRuns) {
      const record = run as unknown as Record<string, unknown>;
      const sessionId = typeof record.session_id === 'string' ? record.session_id : '';
      if (!sessionId) continue;
      const snapshot = record.env_snapshot;
      if (snapshot && typeof snapshot === 'object') {
        runEnvBySession.set(sessionId, snapshot as Record<string, unknown>);
      }
    }

    const envByCwd = new Map<string, ProjectEnv>();
    for (const env of envs) {
      const key = normalizePath(env.code_directory);
      if (key && !envByCwd.has(key)) envByCwd.set(key, env);
    }

    for (const session of sessions) {
      if (skip.has(session.id)) continue;
      // 优先用工作目录匹配当前产品环境（环境改名后仍能显示新名称）；
      // 智能开发/排查任务的会话目录在 temp 下，匹配不到时退回节点运行的环境快照。
      const env = envByCwd.get(normalizePath(session.cwd));
      if (env) {
        const name =
          (env.project_name || `${env.product_name || ''} ${env.product_version || ''}`).trim() ||
          `环境 ${env.id}`;
        map.set(session.id, { key: `project:${name}`, name });
        continue;
      }
      const runEnv = runEnvBySession.get(session.id);
      if (!runEnv) continue;
      const projectName =
        String(runEnv.project_name || '').trim() ||
        `${String(runEnv.product_name || '')} ${String(runEnv.product_version || '')}`.trim();
      if (projectName) {
        map.set(session.id, { key: `project:${projectName}`, name: projectName });
      }
    }
    return map;
  }, [prefs.groupBy, nodeRuns, storeRuns, envs, ungrouped, sessions]);

  const groups = useMemo<RenderGroup[]>(() => {
    const sortSessions = (list: SessionSummary[]) => {
      const copy = [...list];
      if (prefs.sortBy === 'recent') {
        return copy.sort((a, b) => b.modified.localeCompare(a.modified));
      }
      return copy.sort((a, b) => {
        const aIndex = manualIndex.has(a.id) ? manualIndex.get(a.id)! : -1;
        const bIndex = manualIndex.has(b.id) ? manualIndex.get(b.id)! : -1;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return b.modified.localeCompare(a.modified);
      });
    };

    if (prefs.groupBy === 'none') {
      if (prefs.sortBy === 'manual') {
        return [
          {
            key: 'all',
            name: '全部',
            kind: 'plain',
            sessions: sortSessions(filtered),
            showHeader: false,
          },
        ];
      }
      const dateMap = new Map<string, SessionSummary[]>();
      for (const session of [...filtered].sort((a, b) => b.modified.localeCompare(a.modified))) {
        const label = dateGroupLabel(session.modified);
        const list = dateMap.get(label) || [];
        list.push(session);
        dateMap.set(label, list);
      }
      return DATE_GROUP_ORDER.filter((label) => dateMap.has(label)).map((label) => ({
        key: `date:${label}`,
        name: label,
        kind: 'date' as const,
        sessions: dateMap.get(label)!,
        showHeader: true,
      }));
    }

    const skip = new Set(ungrouped[prefs.groupBy] || []);
    const groupMap = new Map<string, RenderGroup>();
    const ungroupedSessions: SessionSummary[] = [];

    for (const session of filtered) {
      let info: { key: string; name: string } | null = null;
      if (!skip.has(session.id)) {
        if (prefs.groupBy === 'project') {
          info = projectInfoBySession.get(session.id) || null;
        } else {
          const cwdKey = normalizePath(session.cwd);
          if (cwdKey) {
            info = {
              key: `cwd:${cwdKey}`,
              name: basename(session.cwd) || session.cwd,
            };
          }
        }
      }
      if (!info) {
        ungroupedSessions.push(session);
        continue;
      }
      const existing = groupMap.get(info.key);
      if (existing) existing.sessions.push(session);
      else {
        groupMap.set(info.key, {
          key: info.key,
          name: aliases[prefs.groupBy]?.[info.key] || info.name,
          kind: prefs.groupBy,
          sessions: [session],
          showHeader: true,
        });
      }
    }

    const list = Array.from(groupMap.values());
    list.forEach((group) => {
      group.sessions = sortSessions(group.sessions);
    });
    if (ungroupedSessions.length) {
      list.push({
        key: 'ungrouped',
        name: '未分组',
        kind: 'ungrouped',
        sessions: sortSessions(ungroupedSessions),
        showHeader: true,
      });
    }

    if (prefs.sortBy === 'manual') {
      const order = groupOrders[prefs.groupBy] || [];
      const orderIndex = new Map(order.map((key, index) => [key, index]));
      list.sort((a, b) => {
        if (a.kind === 'ungrouped') return 1;
        if (b.kind === 'ungrouped') return -1;
        const aIndex = orderIndex.has(a.key) ? orderIndex.get(a.key)! : Number.MAX_SAFE_INTEGER;
        const bIndex = orderIndex.has(b.key) ? orderIndex.get(b.key)! : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return (b.sessions[0]?.modified || '').localeCompare(a.sessions[0]?.modified || '');
      });
    } else {
      list.sort((a, b) => {
        if (a.kind === 'ungrouped') return 1;
        if (b.kind === 'ungrouped') return -1;
        return (b.sessions[0]?.modified || '').localeCompare(a.sessions[0]?.modified || '');
      });
    }
    return list;
  }, [filtered, prefs, aliases, projectInfoBySession, ungrouped, groupOrders, manualIndex]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((session) => selectedIds.has(session.id));

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((session) => next.delete(session.id));
      } else {
        filtered.forEach((session) => next.add(session.id));
      }
      return next;
    });
  };

  const exitManageMode = () => {
    setManageMode(false);
    setSelectedIds(new Set());
  };

  const toggleGroupCollapsed = (key: string) => {
    const mode = prefs.groupBy;
    const current = new Set(collapsedGroups[mode] || []);
    if (current.has(key)) current.delete(key);
    else current.add(key);
    const next = { ...collapsedGroups, [mode]: Array.from(current) };
    setCollapsedGroups(next);
    saveCollapsed(next);
  };

  const removeSelected = async () => {
    setBatchBusy(true);
    try {
      const result = await deleteSessions(Array.from(selectedIds));
      setBatchConfirm(false);
      setSelectedIds(new Set());
      if (!useChatStore.getState().sessions.length) setManageMode(false);
      if (result.failed) {
        toast.error(`已删除 ${result.deleted} 个会话，${result.failed} 个删除失败`);
      } else {
        toast.success(`已删除 ${result.deleted} 个会话`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批量删除失败');
    } finally {
      setBatchBusy(false);
    }
  };

  const handleSelect = (id: string) => {
    selectSession(id);
    onSessionSelect?.(id);
    if (!onSessionSelect) navigate('/chat.html');
  };

  const startDevTask = () => {
    setNewMenuOpen(false);
    if (!loggedIn) {
      const next = edition === 'novice' ? '/?newTask=1' : '/?tab=node&new=1';
      navigate(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (edition === 'novice') {
      // 统一回到实施版工作台，由 NoviceShell 处理 newTask 参数并打开任务弹窗
      navigate('/?newTask=1');
    } else {
      navigate('/?tab=node&new=1');
    }
  };

  const submitRename = async () => {
    if (!renaming) return;
    try {
      await renameSession(renaming.id, renameValue);
      setRenaming(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重命名失败');
    }
  };

  const applyPrefs = (patch: Partial<SessionViewPrefs>) => {
    const next: SessionViewPrefs = { ...prefs, ...patch };
    if (
      next.sortBy === 'manual' &&
      prefs.sortBy !== 'manual' &&
      !sessionOrder.length &&
      sessions.length
    ) {
      const initial = [...sessions]
        .sort((a, b) => b.modified.localeCompare(a.modified))
        .map((session) => session.id);
      setSessionOrder(initial);
      saveSessionOrder(initial);
    }
    setPrefs(next);
    savePrefs(next);
    setViewMenuOpen(false);
  };

  const openRenameGroup = (group: RenderGroup) => {
    setRenamingGroup({ key: group.key, name: group.name });
    setGroupRenameValue(group.name);
  };

  const submitGroupRename = () => {
    if (!renamingGroup || prefs.groupBy === 'none') return;
    const mode = prefs.groupBy;
    const current = aliases[mode] || {};
    const nextMode = { ...current };
    const value = groupRenameValue.trim();
    if (value) nextMode[renamingGroup.key] = value;
    else delete nextMode[renamingGroup.key];
    const next = { ...aliases, [mode]: nextMode };
    setAliases(next);
    saveAliases(next);
    setRenamingGroup(null);
  };

  const confirmRemoveGroup = () => {
    if (!deletingGroup || prefs.groupBy === 'none') return;
    const mode = prefs.groupBy;
    const skip = new Set(ungrouped[mode] || []);
    // 搜索过滤只影响展示，删除分组要覆盖该组全部会话（包括当前被搜索隐藏的）
    const ids = sessions
      .filter((session) => {
        if (skip.has(session.id)) return false;
        if (mode === 'project') {
          return projectInfoBySession.get(session.id)?.key === deletingGroup.key;
        }
        const cwdKey = normalizePath(session.cwd);
        return Boolean(cwdKey) && `cwd:${cwdKey}` === deletingGroup.key;
      })
      .map((session) => session.id);
    const allIds = ids.length ? ids : deletingGroup.sessions.map((session) => session.id);
    const next = {
      ...ungrouped,
      [mode]: Array.from(new Set([...(ungrouped[mode] || []), ...allIds])),
    };
    setUngrouped(next);
    saveUngrouped(next);
    toast.success(`已移除分组“${deletingGroup.name}”，会话已归入未分组`);
    setDeletingGroup(null);
  };

  const reorderSessions = (dragId: string, targetId: string) => {
    const base = [...sessions]
      .sort((a, b) => {
        const aIndex = manualIndex.has(a.id) ? manualIndex.get(a.id)! : -1;
        const bIndex = manualIndex.has(b.id) ? manualIndex.get(b.id)! : -1;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return b.modified.localeCompare(a.modified);
      })
      .map((session) => session.id);
    const from = base.indexOf(dragId);
    const to = base.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    base.splice(to, 0, base.splice(from, 1)[0]);
    setSessionOrder(base);
    saveSessionOrder(base);
  };

  const reorderGroups = (dragKey: string, targetKey: string) => {
    if (prefs.groupBy === 'none') return;
    const keys = groups.filter((group) => group.kind !== 'ungrouped').map((group) => group.key);
    const from = keys.indexOf(dragKey);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0 || from === to) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    const next = { ...groupOrders, [prefs.groupBy]: keys };
    setGroupOrders(next);
    saveGroupOrders(next);
  };

  return (
    <div className={cn('flex min-h-0 flex-col', compact ? 'flex-none' : 'flex-1')}>
      {searchOpen ? (
        <div className="border-b border-line-soft bg-surface-3/30 px-2 py-2">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setQuery('');
                  setSearchOpen(false);
                }
              }}
              placeholder="搜索会话"
              className="h-8 w-full rounded-lg border border-line bg-surface-2 pl-7 pr-8 text-[12px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent/50"
            />
            <button
              type="button"
              title="关闭搜索"
              aria-label="关闭搜索"
              onClick={() => {
                setQuery('');
                setSearchOpen(false);
              }}
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : (
        <div
          ref={viewMenuRef}
          className="relative flex items-center gap-1 border-b border-line-soft bg-surface-3/30 px-2 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-wide text-ink-2">
            会话
          </span>
          <IconButton
            label="视图选项"
            active={viewMenuOpen}
            onClick={() => {
              setNewMenuOpen(false);
              setViewMenuOpen((value) => !value);
            }}
            className="h-8 w-8"
          >
            <SlidersHorizontal size={16} />
          </IconButton>

          <span ref={newMenuRef} className="relative inline-flex">
            <IconButton
              label="新建会话"
              active={newMenuOpen}
              onClick={() => {
                setViewMenuOpen(false);
                setNewMenuOpen((value) => !value);
              }}
              className="h-8 w-8"
            >
              <MessageSquarePlus size={16} />
            </IconButton>
            {newMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-surface-2 p-1.5 shadow-pop">
                <button
                  type="button"
                  onClick={() => {
                    setNewMenuOpen(false);
                    setNewOpen(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                >
                  <MessageSquarePlus size={14} className="shrink-0 text-accent" />
                  <span>创建普通会话</span>
                </button>
                {loggedIn && (
                  <button
                    type="button"
                    onClick={startDevTask}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                  >
                    <Wand2 size={14} className="shrink-0 text-accent" />
                    <span>创建开发任务</span>
                  </button>
                )}
              </div>
            )}
          </span>

          <IconButton
            label={manageMode ? '退出批量管理' : '批量管理'}
            active={manageMode}
            onClick={() => (manageMode ? exitManageMode() : setManageMode(true))}
            className="h-8 w-8"
          >
            {manageMode ? <X size={15} /> : <ListChecks size={16} />}
          </IconButton>
          <IconButton
            label="搜索会话"
            onClick={() => {
              setViewMenuOpen(false);
              setNewMenuOpen(false);
              setSearchOpen(true);
            }}
            className="h-8 w-8"
          >
            <Search size={15} />
          </IconButton>

          {viewMenuOpen && (
            <ViewOptionsMenu
              groupBy={prefs.groupBy}
              sortBy={prefs.sortBy}
              onGroupChange={(value: GroupBy) => applyPrefs({ groupBy: value })}
              onSortChange={(value: SortBy) => applyPrefs({ sortBy: value })}
              onClose={() => setViewMenuOpen(false)}
            />
          )}
        </div>
      )}

      {manageMode && (
        <div className="mx-2 mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft/50 px-2 py-1.5">
          <Checkbox
            checked={allFilteredSelected}
            onChange={toggleAllFiltered}
            label={allFilteredSelected ? '取消全选' : '全选当前列表'}
          />
          <span className="ml-auto shrink-0 text-[11px] text-ink-3">
            已选 {selectedIds.size}
          </span>
          <Button
            size="sm"
            variant="danger"
            disabled={!selectedIds.size}
            onClick={() => setBatchConfirm(true)}
          >
            删除 ({selectedIds.size})
          </Button>
        </div>
      )}

      <div className="scroll-area min-h-0 flex-1 px-1.5 pb-2">
        {loadingSessions && !sessions.length ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : groups.length === 0 || groups.every((group) => group.sessions.length === 0) ? (
          <EmptyState
            icon={<MessageSquarePlus size={22} />}
            title={query ? '没有匹配的会话' : '还没有会话'}
            description={query ? '换个关键词试试' : '新建一个会话，开始和 AI 协作'}
            action={
              !query && (
                <Button variant="primary" size="sm" onClick={() => setNewOpen(true)}>
                  新建会话
                </Button>
              )
            }
          />
        ) : (
          groups.map((group) => {
            const collapsed = (collapsedGroups[prefs.groupBy] || []).includes(group.key);
            return (
              <div key={group.key} className={group.kind === 'plain' ? '' : 'mb-2'}>
                {group.showHeader &&
                  (group.kind === 'date' ? (
                    <DateGroupHeader
                      group={group}
                      collapsed={collapsed}
                      onToggle={() => toggleGroupCollapsed(group.key)}
                    />
                  ) : (
                    <GroupHeader
                      group={group}
                      manual={manual}
                      manageMode={manageMode}
                      draggable={manual && !manageMode}
                      collapsed={collapsed}
                      onToggle={() => toggleGroupCollapsed(group.key)}
                      onRename={() => openRenameGroup(group)}
                      onDelete={() => setDeletingGroup(group)}
                      onDragStart={(event) => {
                        if (!manual || manageMode) return;
                        setDragGroupKey(group.key);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', group.key);
                      }}
                      onDragOver={(event) => {
                        if (!manual || manageMode || group.kind === 'ungrouped') return;
                        if (dragGroupKey && dragGroupKey !== group.key) event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (!manual || !dragGroupKey || group.kind === 'ungrouped') return;
                        reorderGroups(dragGroupKey, group.key);
                        setDragGroupKey(null);
                      }}
                      onDragEnd={() => setDragGroupKey(null)}
                    />
                  ))}
                {!collapsed && (
                  <div className="space-y-0.5">
                    {group.sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === currentSessionId}
                        manageMode={manageMode}
                        selected={selectedIds.has(session.id)}
                        indented={group.showHeader && group.kind !== 'date'}
                        manual={manual}
                        draggable={manual && !manageMode}
                        onSelect={() => handleSelect(session.id)}
                        onToggleSelect={() => toggleSelected(session.id)}
                        onRename={() => {
                          setRenaming(session);
                          setRenameValue(session.name || session.firstMessage || '');
                        }}
                        onDelete={() => setDeleting(session)}
                        onDragStart={(event) => {
                          if (!manual || manageMode) return;
                          setDragSession({ id: session.id, groupKey: group.key });
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', session.id);
                        }}
                        onDragOver={(event) => {
                          if (!manual || manageMode) return;
                          if (
                            dragSession &&
                            dragSession.groupKey === group.key &&
                            dragSession.id !== session.id
                          ) {
                            event.preventDefault();
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (!manual || !dragSession || dragSession.groupKey !== group.key) return;
                          reorderSessions(dragSession.id, session.id);
                          setDragSession(null);
                        }}
                        onDragEnd={() => setDragSession(null)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <NewSessionDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => handleSelect(id)}
      />

      <Dialog
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="重命名会话"
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={submitRename}>
              保存
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submitRename();
          }}
          placeholder={edition === 'novice' ? undefined : '留空则显示首条消息'}
          maxLength={100}
        />
      </Dialog>

      <Dialog
        open={Boolean(renamingGroup)}
        onClose={() => setRenamingGroup(null)}
        title="重命名分组"
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenamingGroup(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={submitGroupRename}>
              保存
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={groupRenameValue}
          onChange={(event) => setGroupRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitGroupRename();
          }}
          placeholder={edition === 'novice' ? undefined : '留空恢复默认分组名'}
          maxLength={100}
        />
        <div className="mt-2 text-[11.5px] text-ink-3">
          仅修改本地显示名称，不改产品环境变量或工作目录。
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          setDeletingBusy(true);
          try {
            await deleteSession(deleting.id);
            setDeleting(null);
            toast.success('会话已删除');
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '删除失败');
          } finally {
            setDeletingBusy(false);
          }
        }}
        title="删除会话"
        description={
          deleting
            ? `确定删除「${deleting.name || deleting.firstMessage || '未命名会话'}」吗？聊天记录会从本机移除，此操作不可恢复。`
            : ''
        }
        confirmText="删除"
        danger
        loading={deletingBusy}
      />

      <ConfirmDialog
        open={batchConfirm}
        onClose={() => setBatchConfirm(false)}
        onConfirm={removeSelected}
        title="批量删除会话"
        description={`确定删除选中的 ${selectedIds.size} 个会话吗？聊天记录会从本机移除，此操作不可恢复。`}
        confirmText={`删除 ${selectedIds.size} 个`}
        danger
        loading={batchBusy}
      />

      <ConfirmDialog
        open={Boolean(deletingGroup)}
        onClose={() => setDeletingGroup(null)}
        onConfirm={confirmRemoveGroup}
        title="移除分组"
        description={
          deletingGroup
            ? `将把“${deletingGroup.name}”从列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。`
            : ''
        }
        confirmText="移除"
      />
    </div>
  );
}
