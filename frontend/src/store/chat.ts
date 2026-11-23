import { create } from 'zustand';
import {
  api,
  ApiError,
  openSessionStream,
  type SessionSummary,
  type SessionDetail,
} from '../lib/api';
import type {
  AssistantInfo,
  ContentBlock,
  Message,
  StreamEvent,
} from '../lib/types';
import { readStorage, writeStorage, sleep } from '../lib/utils';

export type LayoutKey = '1x1' | '2x1' | '1x2' | '2x2' | '3x2' | '3x3';

export const LAYOUT_SLOTS: Record<LayoutKey, number> = {
  '1x1': 1,
  '2x1': 2,
  '1x2': 2,
  '2x2': 4,
  '3x2': 6,
  '3x3': 9,
};

export const LAYOUT_LABELS: Record<LayoutKey, string> = {
  '1x1': '单栏',
  '2x1': '左右 2 栏',
  '1x2': '上下 2 栏',
  '2x2': '2 × 2',
  '3x2': '3 × 2',
  '3x3': '3 × 3',
};

export interface ChatView {
  sessionId: string;
  assistant: string;
  model: string;
  cwd: string;
  messages: Message[];
  liveBlocks: ContentBlock[];
  streaming: boolean;
  startedAt?: number;
  loading: boolean;
  loaded: boolean;
  error?: string;
  queue: string[];
  agentSessionId?: string | null;
}

export interface Panel {
  id: string;
  sessionId: string | null;
}

interface StreamRuntime {
  close: () => void;
  timers: number[];
  promptSent: boolean;
  finished: boolean;
  eventCount: number;
  lastHeartbeat: number;
  lastEventAt: number;
  retried: boolean;
}

interface ChatState {
  sessions: SessionSummary[];
  views: Record<string, ChatView>;
  currentSessionId: string | null;
  assistants: AssistantInfo[];
  currentAssistant: string;
  cwd: string;
  initialized: boolean;
  loadingSessions: boolean;

  split: boolean;
  layout: LayoutKey;
  panels: Panel[];
  activePanelId: string | null;
  syncMode: boolean;

  init: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  loadSession: (id: string, options?: { silent?: boolean }) => Promise<void>;
  createSession: (options?: {
    assistant?: string;
    cwd?: string;
    resumeSessionId?: string;
  }) => Promise<string>;
  sendMessage: (text: string, sessionId?: string | null, displayContent?: string) => Promise<void>;
  abort: (sessionId?: string | null) => Promise<void>;
  switchAssistant: (assistant: string, sessionId?: string | null) => Promise<void>;
  removeQueued: (sessionId: string, index: number) => void;
  clearQueue: (sessionId: string) => void;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  deleteSessions: (ids: string[]) => Promise<{ deleted: number; failed: number }>;
  selectSession: (id: string | null) => void;
  setAssistant: (assistant: string) => void;
  setCwd: (cwd: string) => void;
  attachStream: (id: string, force?: boolean) => void;

  enterSplit: () => void;
  exitSplit: () => void;
  setLayout: (layout: LayoutKey) => void;
  addPanel: () => void;
  removePanel: (panelId: string) => void;
  setActivePanel: (panelId: string) => void;
  setPanelSession: (panelId: string, sessionId: string | null) => void;
  toggleSync: () => void;
  sendToPanel: (panelId: string, text: string) => Promise<void>;
  sendSync: (text: string) => Promise<void>;
}

const streams = new Map<string, StreamRuntime>();

const CURRENT_KEY = 'cc-web-current-session';
const CWD_KEY = 'cc-web-last-cwd';
const LAYOUT_KEY = 'cc-web-split-layout';

function makeView(sessionId: string, assistant: string, model: string, cwd: string): ChatView {
  return {
    sessionId,
    assistant,
    model,
    cwd,
    messages: [],
    liveBlocks: [],
    streaming: false,
    loading: false,
    loaded: false,
    queue: [],
  };
}

function applyChunk(blocks: ContentBlock[], content: string): ContentBlock[] {
  if (!content) return blocks;
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    return [...blocks.slice(0, -1), { type: 'text', text: last.text + content }];
  }
  return [...blocks, { type: 'text', text: content }];
}

function applyThinking(blocks: ContentBlock[], thinking: string): ContentBlock[] {
  if (!thinking) return blocks;
  // 按事件顺序追加：thinking 只在它真实出现的位置展示，
  // 后续文本输出才能把「它之前的过程」准确折叠起来。
  return [...blocks, { type: 'thinking', thinking }];
}

function applyToolCall(
  blocks: ContentBlock[],
  id: string,
  name: string,
  input: unknown
): ContentBlock[] {
  const index = id
    ? blocks.findIndex((item) => item.type === 'tool_use' && item.id === id)
    : -1;
  if (index >= 0) {
    const existing = blocks[index];
    if (existing.type === 'tool_use') {
      const nextInput =
        input && input !== null && !(typeof input === 'object' && !Object.keys(input as object).length)
          ? input
          : existing.input;
      const next = [...blocks];
      next[index] = { type: 'tool_use', id: existing.id, name: name || existing.name, input: nextInput };
      return next;
    }
  }
  return [...blocks, { type: 'tool_use', id, name: name || 'tool', input }];
}

function applyToolResult(blocks: ContentBlock[], id: string, output: unknown): ContentBlock[] {
  const content =
    typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output);
  return [...blocks, { type: 'tool_result', tool_use_id: id, content }];
}

function closeRuntime(sessionId: string) {
  const runtime = streams.get(sessionId);
  if (!runtime) return;
  runtime.finished = true;
  runtime.timers.forEach((timer) => window.clearInterval(timer));
  try {
    runtime.close();
  } catch {
    /* ignore */
  }
  streams.delete(sessionId);
}

function patchView(
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  sessionId: string,
  patch: Partial<ChatView> | ((view: ChatView) => Partial<ChatView>)
) {
  set((state) => {
    const view = state.views[sessionId];
    if (!view) return {};
    const next = typeof patch === 'function' ? patch(view) : patch;
    return { views: { ...state.views, [sessionId]: { ...view, ...next } } };
  });
}

export const useChatStore = create<ChatState>((set, get) => {
  const openStream = (sessionId: string, prompt?: string, displayContent?: string) => {
    const existing = streams.get(sessionId);
    if (existing && !existing.finished) return;

    const runtime: StreamRuntime = {
      close: () => {},
      timers: [],
      promptSent: false,
      finished: false,
      eventCount: 0,
      lastHeartbeat: Date.now(),
      lastEventAt: Date.now(),
      retried: false,
    };
    streams.set(sessionId, runtime);
    patchView(set, sessionId, { streaming: true, startedAt: Date.now(), error: undefined });

    const sendPrompt = async () => {
      if (!prompt || runtime.promptSent) return;
      runtime.promptSent = true;
      try {
        const result = await api.agent.start(sessionId, prompt, displayContent);
        if (result && result.success === false) {
          patchView(set, sessionId, { error: (result as { error?: string }).error || '发送失败' });
          void finalize(sessionId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        patchView(set, sessionId, { error: message });
        void finalize(sessionId);
      }
    };

    const handleEvent = (event: StreamEvent) => {
      if (runtime.finished) return;
      runtime.eventCount += 1;
      runtime.lastEventAt = Date.now();

      switch (event.type) {
        case 'connected':
          runtime.lastHeartbeat = Date.now();
          if (prompt && !runtime.promptSent) void sendPrompt();
          break;
        case 'heartbeat':
          runtime.lastHeartbeat = Date.now();
          break;
        case 'start': {
          const agentSessionId =
            typeof event.agentSessionId === 'string' ? event.agentSessionId : undefined;
          patchView(set, sessionId, (view) => ({
            streaming: true,
            startedAt: view.startedAt ?? Date.now(),
            agentSessionId: agentSessionId ?? view.agentSessionId,
          }));
          get().refreshSessions().catch(() => {});
          // 智能开发创建后立即跳转时，页面可能先于本轮提问落库加载了会话；
          // 执行开始时静默重载一次，保证用户刚提交的问题也能显示出来。
          get()
            .loadSession(sessionId, { silent: true })
            .catch(() => {});
          break;
        }
        case 'thinking': {
          const thinking = typeof event.thinking === 'string' ? event.thinking : '';
          patchView(set, sessionId, (view) => ({
            liveBlocks: applyThinking(view.liveBlocks, thinking),
            streaming: true,
          }));
          break;
        }
        case 'chunk': {
          const content = typeof event.content === 'string' ? event.content : '';
          patchView(set, sessionId, (view) => ({
            liveBlocks: applyChunk(view.liveBlocks, content),
            streaming: true,
          }));
          break;
        }
        case 'tool_call': {
          const id = typeof event.id === 'string' ? event.id : '';
          const name = typeof event.name === 'string' ? event.name : 'tool';
          patchView(set, sessionId, (view) => ({
            liveBlocks: applyToolCall(view.liveBlocks, id, name, event.input),
            streaming: true,
          }));
          break;
        }
        case 'tool_result': {
          const id = typeof event.id === 'string' ? event.id : '';
          patchView(set, sessionId, (view) => ({
            liveBlocks: applyToolResult(view.liveBlocks, id, event.output),
            streaming: true,
          }));
          break;
        }
        case 'result': {
          const finalText = typeof event.content === 'string' ? event.content : '';
          patchView(set, sessionId, (view) => {
            let blocks = view.liveBlocks;
            const hasText = blocks.some((block) => block.type === 'text');
            if (!hasText && finalText) blocks = applyChunk(blocks, finalText);
            return { liveBlocks: blocks };
          });
          // 一次运行可能先发多个 result（后台任务/通知），这里只更新文本；
          // 真正的结束以后端进程退出后发的 stream_end 为准。
          break;
        }
        case 'stream_end': {
          void finalize(sessionId);
          break;
        }
        case 'error': {
          const message = typeof event.message === 'string' ? event.message : '执行出错';
          patchView(set, sessionId, { error: message });
          void finalize(sessionId);
          break;
        }
        default:
          break;
      }
    };

    const finalize = async (id: string) => {
      if (runtime.finished) return;
      closeRuntime(id);
      patchView(set, id, { streaming: false, startedAt: undefined });
      await sleep(220);
      try {
        await get().loadSession(id, { silent: true });
      } catch {
        patchView(set, id, { liveBlocks: [] });
      }
      await get().refreshSessions().catch(() => {});
      void processQueue(id);
    };

    const processQueue = async (id: string) => {
      const view = get().views[id];
      if (!view || !view.queue.length) return;
      if (streams.has(id)) return;
      const [next, ...rest] = view.queue;
      patchView(set, id, (current) => ({
        queue: rest,
        messages: [
          ...current.messages,
          { role: 'user', content: next, timestamp: Date.now() },
        ],
        streaming: true,
        startedAt: Date.now(),
      }));
      openStream(id, next);
    };

    runtime.close = openSessionStream(sessionId, {
      onEvent: handleEvent,
      onError: () => {
        if (runtime.finished) return;
        if (!runtime.promptSent && !runtime.retried) {
          runtime.retried = true;
          window.setTimeout(() => {
            closeRuntime(sessionId);
            openStream(sessionId, prompt);
          }, 1000);
        }
      },
    });

    // 无事件超时：只收到 connected 时向后端确认是否仍在流式
    const noEventTimer = window.setTimeout(async () => {
      if (runtime.finished || runtime.eventCount > 1) return;
      try {
        const state = await api.agent.state(sessionId);
        if (!state.state?.isStreaming) await finalize(sessionId);
      } catch {
        /* ignore */
      }
    }, 15_000);

    // 心跳检查
    const heartbeatTimer = window.setInterval(async () => {
      if (runtime.finished) return;
      if (Date.now() - runtime.lastHeartbeat <= 30_000) return;
      try {
        const state = await api.agent.state(sessionId);
        if (!state.state?.isStreaming) {
          await finalize(sessionId);
        }
      } catch {
        /* ignore */
      }
    }, 10_000);

    // 安全超时：120 秒无任何事件
    const safetyTimer = window.setInterval(() => {
      if (runtime.finished) return;
      if (Date.now() - runtime.lastEventAt > 120_000) {
        void finalize(sessionId);
      }
    }, 30_000);

    runtime.timers.push(noEventTimer, heartbeatTimer, safetyTimer);
  };

  return {
    sessions: [],
    views: {},
    currentSessionId: null,
    assistants: [],
    currentAssistant: 'claude',
    cwd: '',
    initialized: false,
    loadingSessions: false,

    split: false,
    layout: '1x1',
    panels: [],
    activePanelId: null,
    syncMode: false,

    init: async () => {
      if (get().initialized) return;
      const [assistants, sessions] = await Promise.all([
        api.assistants().catch(() => [] as AssistantInfo[]),
        api.sessions.list().catch(() => [] as SessionSummary[]),
      ]);

      const available = assistants.filter((item) => item.available !== false);
      const preferred =
        assistants.find((item) => item.is_default) ||
        assistants.find((item) => item.name === 'claude') ||
        assistants[0];
      const currentAssistant = preferred?.name || 'claude';

      const savedSession = readStorage<string | null>(CURRENT_KEY, null, false);
      // 优先恢复上次会话；否则自动选中最近一个会话（与旧版聊天页一致）
      const currentSessionId =
        savedSession && sessions.some((item) => item.id === savedSession)
          ? savedSession
          : sessions[0]?.id ?? null;
      const storedCwd = readStorage<string>(CWD_KEY, '', false) || '';
      const currentSummary = sessions.find((item) => item.id === currentSessionId);
      const cwd = storedCwd || currentSummary?.cwd || '';

      const layout = (readStorage<string>(LAYOUT_KEY, '1x1', false) as LayoutKey) || '1x1';
      set({
        assistants,
        sessions,
        currentAssistant,
        currentSessionId,
        cwd,
        layout,
        initialized: true,
      });

      if (currentSessionId) {
        await get().loadSession(currentSessionId);
        // 页面刷新时若后端仍在流式，接上已有的 SSE（后端不重放，后续事件从此刻开始）
        get().attachStream(currentSessionId);
      }
    },

    refreshSessions: async () => {
      const sessions = await api.sessions.list();
      set((state) => {
        const views = { ...state.views };
        for (const summary of sessions) {
          const view = views[summary.id];
          if (!view) continue;
          views[summary.id] = {
            ...view,
            assistant: summary.assistant,
            model: summary.model,
            cwd: summary.cwd,
            streaming: streams.has(summary.id) ? view.streaming : summary.isStreaming,
          };
        }
        return { sessions, views };
      });
    },

    loadSession: async (id, options) => {
      const state = get();
      if (!state.views[id]) {
        const summary = state.sessions.find((item) => item.id === id);
        set((current) => ({
          views: {
            ...current.views,
            [id]: makeView(
              id,
              summary?.assistant || current.currentAssistant,
              summary?.model || '',
              summary?.cwd || current.cwd
            ),
          },
        }));
      }
      if (!options?.silent) patchView(set, id, { loading: true });
      try {
        const detail: SessionDetail = await api.sessions.get(id);
        const active = streams.has(id);
        let messages = detail.messages || [];
        let liveBlocks = get().views[id]?.liveBlocks ?? [];

        if (active && messages.length) {
          const last = messages[messages.length - 1];
          if (last.role === 'assistant') {
            if (!liveBlocks.length && last.content_blocks?.length) {
              liveBlocks = last.content_blocks;
            }
            messages = messages.slice(0, -1);
          }
        }

        patchView(set, id, {
          assistant: detail.assistant,
          model: detail.model,
          cwd: detail.cwd,
          messages,
          liveBlocks: active ? liveBlocks : [],
          streaming: active,
          loading: false,
          loaded: true,
        });
        writeStorage(CURRENT_KEY, id);
      } catch (error) {
        patchView(set, id, {
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    createSession: async (options) => {
      const state = get();
      const assistant = options?.assistant || state.currentAssistant;
      const cwd = (options?.cwd ?? state.cwd).trim();
      if (!cwd) throw new ApiError('请先填写工作目录');

      // 模型由后端使用助手的默认模型，前端不再提供模型选择
      const result = await api.agent.create({
        cwd,
        assistant,
        resume_session_id: options?.resumeSessionId,
      });
      if (!result.success || !result.sessionId) {
        throw new ApiError(result.error || '创建会话失败');
      }
      writeStorage(CWD_KEY, cwd);
      const view = makeView(result.sessionId, result.assistant || assistant, result.model || '', cwd);
      set((current) => ({
        views: { ...current.views, [result.sessionId]: view },
        currentSessionId: result.sessionId,
        currentAssistant: result.assistant || assistant,
      }));
      writeStorage(CURRENT_KEY, result.sessionId);
      await get().refreshSessions().catch(() => {});
      return result.sessionId;
    },

    sendMessage: async (text, sessionId, displayContent) => {
      const message = text.trim();
      if (!message) return;
      const id = sessionId ?? get().currentSessionId;
      if (!id) throw new ApiError('请先选择一个会话');
      const view = get().views[id];
      if (!view) {
        await get().loadSession(id);
      }
      if (streams.has(id)) {
        patchView(set, id, (current) => ({ queue: [...current.queue, message] }));
        return;
      }
      patchView(set, id, (current) => ({
        messages: [
          ...current.messages,
          {
            role: 'user',
            content: message,
            timestamp: Date.now(),
            display_content: displayContent,
          },
        ],
        streaming: true,
        startedAt: Date.now(),
        liveBlocks: [],
        error: undefined,
      }));
      writeStorage(CURRENT_KEY, id);
      openStream(id, message, displayContent);
      get().refreshSessions().catch(() => {});
    },

    abort: async (sessionId) => {
      const id = sessionId ?? get().currentSessionId;
      if (!id) return;
      closeRuntime(id);
      patchView(set, id, { streaming: false, startedAt: undefined });
      try {
        await api.agent.abort(id);
      } catch {
        /* 后端中止是 best-effort */
      }
      await get().loadSession(id, { silent: true }).catch(() => {});
      await get().refreshSessions().catch(() => {});
      // 中止后继续处理排队消息（与旧版行为一致）
      const queued = get().views[id]?.queue ?? [];
      if (queued.length && !streams.has(id)) {
        const [next, ...rest] = queued;
        patchView(set, id, { queue: rest });
        void get().sendMessage(next, id);
      }
    },

    switchAssistant: async (assistant, sessionId) => {
      const id = sessionId ?? get().currentSessionId;
      if (!id) {
        get().setAssistant(assistant);
        return;
      }
      const result = await api.agent.switchAssistant(id, assistant);
      if (result && (result as { success?: boolean }).success === false) {
        throw new ApiError((result as { error?: string }).error || '切换助手失败');
      }
      const switched = !/already using/i.test(String((result as { message?: string }).message || ''));
      set({ currentAssistant: assistant });
      patchView(set, id, {
        assistant,
        streaming: switched ? true : get().views[id]?.streaming,
        startedAt: switched ? Date.now() : get().views[id]?.startedAt,
      });
      // 切换成功后后端会立刻流式输出一段上下文确认；先接 SSE，再拉会话，避免漏事件
      if (switched) get().attachStream(id);
      await get().loadSession(id, { silent: true });
      await get().refreshSessions().catch(() => {});
    },

    removeQueued: (sessionId, index) => {
      patchView(set, sessionId, (view) => ({
        queue: view.queue.filter((_, i) => i !== index),
      }));
    },

    clearQueue: (sessionId) => {
      patchView(set, sessionId, { queue: [] });
    },

    renameSession: async (id, name) => {
      await api.sessions.rename(id, name.trim());
      await get().refreshSessions();
      if (get().currentSessionId === id) {
        await get().loadSession(id, { silent: true });
      }
    },

    deleteSession: async (id) => {
      const result = await get().deleteSessions([id]);
      if (result.failed) throw new ApiError('删除会话失败');
    },

    deleteSessions: async (ids) => {
      const unique = Array.from(new Set(ids.filter(Boolean)));
      if (!unique.length) return { deleted: 0, failed: 0 };
      unique.forEach((id) => closeRuntime(id));

      const results = await Promise.allSettled(unique.map((id) => api.sessions.remove(id)));
      const deletedIds = unique.filter((id, index) => {
        const result = results[index];
        if (result.status === 'fulfilled') return true;
        // 已经被别处删掉的会话视为删除成功，避免列表残留
        return result.reason instanceof ApiError && result.reason.status === 404;
      });
      const failed = unique.length - deletedIds.length;
      const deletedSet = new Set(deletedIds);

      set((state) => {
        const views = { ...state.views };
        deletedIds.forEach((id) => delete views[id]);
        const sessions = state.sessions.filter((item) => !deletedSet.has(item.id));
        const currentDeleted =
          state.currentSessionId != null && deletedSet.has(state.currentSessionId);
        const nextId = currentDeleted ? sessions[0]?.id ?? null : state.currentSessionId;
        return {
          views,
          sessions,
          currentSessionId: nextId,
          panels: state.panels.map((panel) =>
            panel.sessionId && deletedSet.has(panel.sessionId)
              ? { ...panel, sessionId: null }
              : panel
          ),
        };
      });

      const next = get().currentSessionId;
      if (next) {
        writeStorage(CURRENT_KEY, next);
        await get().loadSession(next, { silent: true }).catch(() => {});
      } else {
        writeStorage(CURRENT_KEY, null);
      }
      await get().refreshSessions().catch(() => {});
      return { deleted: deletedIds.length, failed };
    },

    selectSession: (id) => {
      set({ currentSessionId: id });
      if (id) {
        writeStorage(CURRENT_KEY, id);
        const view = get().views[id];
        const summary = get().sessions.find((item) => item.id === id);
        if (!view?.loaded) {
          get()
            .loadSession(id)
            .then(() => get().attachStream(id))
            .catch(() => {});
        } else if (view.streaming || summary?.isStreaming) {
          if (!streams.has(id)) openStream(id);
        }
        if (summary) {
          set({ currentAssistant: summary.assistant });
        }
      }
    },

    setAssistant: (assistant) => {
      set({ currentAssistant: assistant });
    },

    setCwd: (cwd) => {
      writeStorage(CWD_KEY, cwd);
      set({ cwd });
    },

    attachStream: (id, force = false) => {
      if (streams.has(id)) return;
      const summary = get().sessions.find((item) => item.id === id);
      // force：智能开发刚创建的会话，后端可能还没把会话标成 executing，但 run 已经在执行，
      // 这里要直接接上事件流，否则页面要刷新一次才能看到执行状态和输出。
      if (force || summary?.isStreaming || get().views[id]?.streaming) openStream(id);
    },

    enterSplit: () => {
      const state = get();
      const existing = state.panels.length
        ? state.panels
        : [{ id: `panel-${Date.now()}`, sessionId: state.currentSessionId }];
      set({
        split: true,
        panels: existing,
        activePanelId: existing[0]?.id ?? null,
      });
    },

    exitSplit: () => {
      const state = get();
      const active = state.panels.find((panel) => panel.id === state.activePanelId);
      set({ split: false });
      if (active?.sessionId) get().selectSession(active.sessionId);
    },

    setLayout: (layout) => {
      const slots = LAYOUT_SLOTS[layout];
      set((state) => {
        const panels = [...state.panels];
        while (panels.length < slots) {
          panels.push({ id: `panel-${Date.now()}-${panels.length}`, sessionId: null });
        }
        if (panels.length > slots) panels.length = slots;
        return {
          layout,
          panels,
          activePanelId: panels.some((panel) => panel.id === state.activePanelId)
            ? state.activePanelId
            : panels[0]?.id ?? null,
        };
      });
      writeStorage(LAYOUT_KEY, layout);
    },

    addPanel: () => {
      const state = get();
      const slots = LAYOUT_SLOTS[state.layout];
      if (state.panels.length >= slots) return;
      const panel = { id: `panel-${Date.now()}`, sessionId: null };
      set({ panels: [...state.panels, panel], activePanelId: panel.id });
    },

    removePanel: (panelId) => {
      set((state) => {
        const panels = state.panels.filter((panel) => panel.id !== panelId);
        const next = panels.length ? panels : [{ id: `panel-${Date.now()}`, sessionId: null }];
        return {
          panels: next,
          activePanelId:
            state.activePanelId === panelId ? next[0]?.id ?? null : state.activePanelId,
        };
      });
    },

    setActivePanel: (panelId) => {
      const panel = get().panels.find((item) => item.id === panelId);
      set({ activePanelId: panelId });
      if (panel?.sessionId) get().selectSession(panel.sessionId);
    },

    setPanelSession: (panelId, sessionId) => {
      set((state) => ({
        panels: state.panels.map((panel) =>
          panel.id === panelId ? { ...panel, sessionId } : panel
        ),
      }));
    },

    toggleSync: () => set((state) => ({ syncMode: !state.syncMode })),

    sendToPanel: async (panelId, text) => {
      const state = get();
      const panel = state.panels.find((item) => item.id === panelId);
      if (!panel) return;
      if (!panel.sessionId) {
        const id = await state.createSession({
          assistant: state.currentAssistant,
          cwd: state.cwd,
        });
        set((current) => ({
          panels: current.panels.map((item) =>
            item.id === panelId ? { ...item, sessionId: id } : item
          ),
        }));
        await get().sendMessage(text, id);
        return;
      }
      await get().sendMessage(text, panel.sessionId);
    },

    sendSync: async (text) => {
      const state = get();
      const panels = state.panels.slice(0, LAYOUT_SLOTS[state.layout]);
      await Promise.all(panels.map((panel) => get().sendToPanel(panel.id, text)));
    },
  };
});

export function isStreaming(sessionId: string): boolean {
  return streams.has(sessionId);
}
