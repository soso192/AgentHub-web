import type {
  AdaptRun,
  AssistantInfo,
  EnvCheckItem,
  FileEntry,
  NodeRun,
  PatchConfig,
  PatchItem,
  Session,
  StreamEvent,
  VersionInfo,
} from './types';

const API_BASE = '';

/** 把 Windows 反斜杠转成 URL 路径分隔符，同时逐段编码，保留目录层级。 */
export function normalizeFilePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function parseError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    return (data && (data.error || data.message)) || response.statusText;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new ApiError(await parseError(response), response.status);
  }
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/* ── 会话 / 助手 / 模型 ── */

export interface SessionSummary {
  id: string;
  assistant: string;
  cwd: string;
  model: string;
  messageCount: number;
  firstMessage: string;
  name: string | null;
  created: string;
  modified: string;
  isStreaming: boolean;
  agent_session_id?: string | null;
}

export interface SessionDetail {
  sessionId: string;
  assistant: string;
  cwd: string;
  model: string;
  name?: string | null;
  messages: Session['messages'];
  created: string;
  modified: string;
}

export const api = {
  version: () => request<{ success: boolean; data: VersionInfo }>('/api/version'),

  assistants: () =>
    request<{ assistants: AssistantInfo[] }>('/api/assistants').then((r) => r.assistants ?? []),

  sessions: {
    list: () =>
      request<{ sessions: SessionSummary[] }>('/api/sessions').then((r) => r.sessions ?? []),
    get: (id: string) => request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    rename: (id: string, name: string) =>
      request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/name`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
  },

  agent: {
    create: (body: {
      cwd: string;
      message?: string;
      model?: string;
      assistant?: string;
      resume_session_id?: string;
    }) =>
      request<{ success: boolean; sessionId: string; assistant: string; model: string; error?: string }>(
        '/api/agent/new',
        { method: 'POST', body: JSON.stringify(body) }
      ),
    start: (id: string, message: string, display_content?: string) =>
      request<{ success?: boolean; error?: string }>(
        `/api/agent/${encodeURIComponent(id)}/start`,
        {
          method: 'POST',
          body: JSON.stringify({ message, ...(display_content ? { display_content } : {}) }),
        }
      ),
    abort: (id: string) =>
      request<{ success?: boolean }>(`/api/agent/${encodeURIComponent(id)}/abort`, {
        method: 'POST',
      }),
    switchAssistant: (id: string, assistant: string, model?: string) =>
      request<{ success?: boolean; error?: string }>(
        `/api/agent/${encodeURIComponent(id)}/switch`,
        { method: 'POST', body: JSON.stringify({ assistant, model }) }
      ),
    state: (id: string) =>
      request<{ running: boolean; state?: Record<string, unknown> }>(
        `/api/agent/${encodeURIComponent(id)}`
      ),
    command: (id: string, body: Record<string, unknown>) =>
      request<{ success?: boolean }>(`/api/agent/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    claudeHistory: (sid: string, full = false) =>
      request<{ messages: Session['messages'] }>(
        `/api/claude-sessions/${encodeURIComponent(sid)}${full ? '?full=1' : ''}`
      ),
  },

  files: {
    list: (path: string) =>
      request<{ success: boolean; path: string; parent: string | null; files: FileEntry[] }>(
        `/api/files?path=${encodeURIComponent(path)}`
      ),
    read: (path: string) =>
      request<{ success: boolean; path: string; content: string }>(
        `/api/files/${normalizeFilePath(path)}`
      ),
    rawUrl: (path: string) =>
      `${API_BASE}/api/files/raw/${normalizeFilePath(path)}`,
    reveal: (path: string) =>
      request<{ success: boolean }>('/api/files/reveal', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    openFolder: (path: string) =>
      request<{ success: boolean }>('/api/files/open-folder', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
  },

  pickFolder: (start?: string) =>
    request<{ success: boolean; path: string | null; error?: string }>(
      `/api/pick-folder${start ? `?start=${encodeURIComponent(start)}` : ''}`
    ),

  /** local_temp 工作流步骤：在用户数据目录的 temp 下创建/重置临时目录。 */
  workflowTemp: (runId: string, stepOrder: number) =>
    request<{ success: boolean; path: string; error?: string }>('/api/workflows/local-temp', {
      method: 'POST',
      body: JSON.stringify({ run_id: runId, step_order: stepOrder }),
    }),

  chatAttachment: (sessionId: string, form: FormData, name?: string) =>
    request<{ success: boolean; path?: string; paths?: string[]; error?: string }>(
      `/api/chat/attachment?session_id=${encodeURIComponent(sessionId)}${
        name ? `&name=${encodeURIComponent(name)}` : ''
      }`,
      { method: 'POST', body: form }
    ),

  patchConfig: () =>
    request<{ patch_search_servers: string[]; code_search_url: string; fbip_graph_url: string }>(
      '/api/patch-config'
    ),

  envCheck: (home?: string) =>
    request<{
      success: boolean;
      claude: EnvCheckItem;
      python: EnvCheckItem;
      java: EnvCheckItem & { source?: string | null; java_home?: string };
      git_bash: EnvCheckItem & { path?: string };
      home_jdk: EnvCheckItem & { path?: string | null };
    }>(`/api/env-check${home ? `?home=${encodeURIComponent(home)}` : ''}`),

  update: {
    check: (server_url: string, auth_token: string) =>
      request<Record<string, unknown>>('/api/update/check', {
        method: 'POST',
        body: JSON.stringify({ server_url, auth_token }),
      }),
    apply: (server_url: string, auth_token: string) =>
      request<Record<string, unknown>>('/api/update/apply', {
        method: 'POST',
        body: JSON.stringify({ server_url, auth_token }),
      }),
  },

  nodeRuns: {
    list: () =>
      request<{ code: number; data: NodeRun[]; host: string }>('/api/node/runs'),
    put: (id: string, run: NodeRun) =>
      request<{ code: number }>(`/api/node/runs/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(run),
      }),
    remove: (id: string) =>
      request<{ code: number; data: { deleted: number } }>(
        `/api/node/runs/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      ),
    workspace: (run_id?: string) =>
      request<{ code: number; data: Record<string, string> }>('/api/node/workspace', {
        method: 'POST',
        body: JSON.stringify({ run_id }),
      }),
    ensureDir: (id: string, path: string) =>
      request<{ success: boolean; path?: string }>(
        `/api/node/runs/${encodeURIComponent(id)}/ensure-dir`,
        { method: 'POST', body: JSON.stringify({ path }) }
      ),
  },

  adapt: {
    upload: (runId: string, seq: number, file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return request<{ success: boolean; dir?: string; zip?: string; entries?: number; error?: string }>(
        `/api/adapt/upload?run_id=${encodeURIComponent(runId)}&seq=${seq}`,
        { method: 'POST', body: form }
      );
    },
    importPatch: async (
      body: Record<string, unknown>,
      onLine?: (line: string) => void
    ): Promise<Record<string, unknown>> => {
      const response = await fetch('/api/adapt/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new ApiError(await parseError(response), response.status);
      const text = await response.text();
      for (const line of text.split('\n')) {
        if (line.trim()) onLine?.(line.trim());
      }
      const okLine = text
        .split('\n')
        .find((line) => line.startsWith('ok '));
      if (!okLine) {
        const errorLine = text.split('\n').find((line) => line.startsWith('error '));
        throw new ApiError(errorLine ? errorLine.slice(6) : '补丁导入失败');
      }
      try {
        return JSON.parse(okLine.slice(3)) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    gitStatus: (path: string) =>
      request<Record<string, unknown>>(`/api/adapt/git-status?path=${encodeURIComponent(path)}`),
    start: (body: Record<string, unknown>) =>
      request<Record<string, unknown>>('/api/adapt/start', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    list: () =>
      request<{ code: number; data: AdaptRun[] }>('/api/adapt/runs'),
    get: (id: string) =>
      request<{ code: number; data: AdaptRun }>(`/api/adapt/runs/${encodeURIComponent(id)}`),
    action: (id: string, action: string, body: Record<string, unknown> = {}) =>
      request<Record<string, unknown>>(
        `/api/adapt/runs/${encodeURIComponent(id)}/${action}`,
        { method: 'POST', body: JSON.stringify(body) }
      ),
    remove: (id: string) =>
      request<Record<string, unknown>>(`/api/adapt/runs/${encodeURIComponent(id)}/delete`, {
        method: 'POST',
        body: '{}',
      }),
  },

  recorder: {
    open: (body: Record<string, unknown>) =>
      request<Record<string, unknown>>('/api/recorder/open', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    status: () => request<Record<string, unknown>>('/api/recorder/status'),
    close: () => request<Record<string, unknown>>('/api/recorder/close', { method: 'POST' }),
  },

  nodeProblemImage: (runId: string, form: FormData, name?: string) =>
    request<{ success: boolean; path?: string; paths?: string[]; error?: string }>(
      `/api/node/problem-image?run_id=${encodeURIComponent(runId)}${
        name ? `&name=${encodeURIComponent(name)}` : ''
      }`,
      { method: 'POST', body: form }
    ),
};

/* ── SSE ── */

export interface StreamHandlers {
  onEvent: (event: StreamEvent) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
}

export function openSessionStream(sessionId: string, handlers: StreamHandlers): () => void {
  const source = new EventSource(
    `${API_BASE}/api/agent/${encodeURIComponent(sessionId)}/events`
  );
  source.onopen = () => handlers.onOpen?.();
  source.onmessage = (event) => {
    if (!event.data) return;
    try {
      handlers.onEvent(JSON.parse(event.data) as StreamEvent);
    } catch {
      /* 非 JSON 心跳等，忽略 */
    }
  };
  source.onerror = (event) => handlers.onError?.(event);
  return () => source.close();
}

/* ── patch_search 外部服务（带多地址回退） ── */

export interface PatchServer {
  servers: string[];
  token: string;
}

const ACCESS_TOKEN_KEY = 'patch-search-access-token';
const REFRESH_TOKEN_KEY = 'patch-search-refresh-token';

export function readAccessToken(): string {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function readRefreshToken(): string {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function hasAuthSession(): boolean {
  return Boolean(readAccessToken() || readRefreshToken());
}

export function clearStoredTokens() {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    /* ignore */
  }
  clearPatchServerCache();
}

function storeAccessToken(accessToken: string) {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  } catch {
    /* ignore */
  }
  clearPatchServerCache();
}

function storeTokens(accessToken: string, refreshToken?: string | null) {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    else localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    /* ignore */
  }
  clearPatchServerCache();
}

let patchServerCache: PatchServer | null = null;

export async function getPatchServers(): Promise<PatchServer> {
  if (patchServerCache) return patchServerCache;
  const config: PatchConfig = await api.patchConfig();
  const value: PatchServer = {
    servers: config.patch_search_servers ?? [],
    token: readAccessToken(),
  };
  patchServerCache = value;
  return value;
}

export function clearPatchServerCache() {
  patchServerCache = null;
}

export function expireSession() {
  clearStoredTokens();
  if (!window.location.pathname.startsWith('/login')) {
    window.location.replace('/login?reason=expired');
  }
}

let refreshPromise: Promise<string | null> | null = null;

/** 用 30 天 refresh token 换新的 access token；并发请求共用同一个刷新过程。 */
export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const refreshToken = readRefreshToken();
    if (!refreshToken) return null;
    const { servers } = await getPatchServers();
    if (!servers.length) throw new ApiError('补丁中心地址未配置');
    let lastError: unknown;
    for (const base of servers) {
      try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        const payload = await response.json().catch(() => null);
        if (response.status === 401 || response.status === 403) {
          clearStoredTokens();
          throw new ApiError(
            payload?.detail || '登录已失效，请重新登录',
            response.status
          );
        }
        if (!response.ok || !payload || payload.code !== 0) {
          throw new ApiError(
            payload?.message || payload?.detail || `刷新登录失败（HTTP ${response.status}）`,
            response.status
          );
        }
        const accessToken = payload.data?.access_token;
        if (!accessToken) throw new ApiError('刷新响应缺少 access_token');
        storeAccessToken(accessToken);
        return accessToken;
      } catch (error) {
        // HTTP 响应是权威结果；只有网络错误才换下一个地址。
        if (error instanceof ApiError && error.status > 0) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new ApiError('刷新登录失败');
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

/** 发一次请求：自动带 access token，网络错误时切换下一个补丁中心地址。 */
async function fetchWithPatchServers(path: string, init: RequestInit = {}): Promise<Response> {
  const { servers } = await getPatchServers();
  if (!servers.length) throw new ApiError('补丁中心地址未配置');
  const token = readAccessToken();
  let lastError: unknown;
  for (const base of servers) {
    try {
      const headers = new Headers(init.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      return await fetch(`${base.replace(/\/+$/, '')}${path}`, { ...init, headers });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new ApiError('补丁中心请求失败');
}

/** 带自动续期的原始响应请求：401 时尝试 refresh token，再重试一次。 */
export async function patchRawFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  let response = await fetchWithPatchServers(path, init);
  if (response.status !== 401) return response;
  try {
    const accessToken = await refreshAccessToken();
    if (!accessToken) return response;
    response = await fetchWithPatchServers(path, init);
  } catch (error) {
    // refresh token 本身失效：原 401 交给调用方统一处理；网络问题直接抛出，避免误清登录态。
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return response;
    }
    throw error;
  }
  return response;
}

export async function patchFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await patchRawFetch(path, init);
  if (!response.ok) {
    if (response.status === 401) {
      expireSession();
      throw new ApiError('登录已失效，请重新登录', response.status);
    }
    if (response.status === 403) throw new ApiError('权限不足', response.status);
    throw new ApiError(await parseError(response), response.status);
  }
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export interface PatchEnvelope<T> {
  code: number;
  data: T;
  message?: string;
  detail?: string;
}

/** patch_search 通用请求：自动解包 {code, data}，非 0 视为失败。 */
export async function patchRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const payload = await patchFetch<PatchEnvelope<T>>(path, init);
  if (!payload || payload.code !== 0) {
    throw new ApiError(payload?.message || payload?.detail || '补丁中心请求失败');
  }
  return payload.data;
}

export interface PatchSearchResult {
  total?: number;
  items?: PatchItem[];
  list?: PatchItem[];
  data?: PatchItem[];
  [key: string]: unknown;
}

export interface PatchUser {
  id?: number | string;
  username?: string;
  display_name?: string;
  role?: string;
  menus?: string[];
  [key: string]: unknown;
}

/** 直接向 patch_search 登录（cc-web 本身没有登录接口）。 */
export async function patchLogin(
  username: string,
  password: string,
  rememberMe = false
): Promise<{ token: string; user: PatchUser; refreshToken?: string }> {
  const { servers } = await getPatchServers();
  if (!servers.length) throw new ApiError('补丁中心地址未配置，请联系管理员');
  let lastError: unknown;
  for (const base of servers) {
    try {
      const response = await fetch(`${base.replace(/\/+$/, '')}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember_me: rememberMe }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.code !== 0) {
        throw new ApiError(
          payload?.message || payload?.detail || (response.status === 401 ? '用户名或密码错误' : `登录失败（HTTP ${response.status}）`),
          response.status
        );
      }
      const data = payload.data || {};
      if (!data.access_token) throw new ApiError('登录响应缺少 token');
      storeTokens(data.access_token, data.refresh_token);
      return {
        token: data.access_token,
        user: data.user || {},
        refreshToken: data.refresh_token,
      };
    } catch (error) {
      lastError = error;
      if (error instanceof ApiError && error.status) break;
    }
  }
  throw lastError instanceof Error ? lastError : new ApiError('无法连接补丁中心');
}

export async function patchMe(): Promise<PatchUser | null> {
  if (!hasAuthSession()) return null;
  const response = await patchRawFetch('/api/auth/me');
  if (response.status === 401) {
    clearStoredTokens();
    return null;
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.code !== 0) {
    throw new ApiError(payload?.message || `HTTP ${response.status}`, response.status);
  }
  return (payload.data || {}) as PatchUser;
}

export async function patchLogout(accessToken?: string, refreshToken?: string) {
  const { servers } = await getPatchServers();
  if (!servers.length) return;
  const refresh = refreshToken ?? readRefreshToken();
  for (const base of servers) {
    try {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
      await fetch(`${base.replace(/\/+$/, '')}/api/auth/logout`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ refresh_token: refresh || null }),
      });
      return;
    } catch {
      /* best effort：换下一个地址 */
    }
  }
}
