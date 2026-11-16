import {
  ApiError,
  expireSession,
  patchRawFetch,
  patchRequest,
} from './api';
import type {
  AdaptLedgerRow,
  FlowConfig,
  NodePromptConfig,
  PatchRow,
  ProblemRunRow,
  Product,
  ProjectEnv,
  PromptConfig,
  ReleaseRow,
  SessionArchiveRow,
  WorkDirectory,
  WorkflowRunRow,
  WorkflowTemplate,
} from './types';

export interface Paged<T> {
  items: T[];
  page?: number;
  size?: number;
  total: number;
}

export interface PatchQuery {
  page: number;
  size: number;
  keyword?: string;
  name?: string;
  product_name?: string;
  product_version?: string;
  user_keyword?: string;
  description?: string;
  status?: string;
}

function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface UploadMeta {
  file: File;
  name: string;
  product_name: string;
  product_version: string;
  description: string;
  user_keyword: string;
}

export interface UploadResult {
  success: Array<Record<string, unknown>>;
  failed: Array<{ error?: string } & Record<string, unknown>>;
}

export const patchApi = {
  search: (query: PatchQuery) =>
    patchRequest<Paged<PatchRow>>(`/api/patches${toQuery({ ...query } as Record<string, unknown>)}`),

  mine: (page: number, size: number) =>
    patchRequest<Paged<PatchRow>>(`/api/patches/mine?page=${page}&size=${size}`),

  detail: (id: string | number) => patchRequest<PatchRow>(`/api/patches/${id}`),

  update: (id: string | number, body: Record<string, unknown>) =>
    patchRequest<unknown>(`/api/patches/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  remove: (id: string | number) =>
    patchRequest<unknown>(`/api/patches/${id}`, { method: 'DELETE' }),

  upload: async (entries: UploadMeta[]) => {
    const form = new FormData();
    for (const entry of entries) {
      form.append('files', entry.file, entry.file.name);
      form.append('file_names', entry.name);
      form.append('product_names', entry.product_name);
      form.append('product_versions', entry.product_version);
      form.append('descriptions', entry.description);
      form.append('user_keywords', entry.user_keyword);
    }
    return patchRequest<UploadResult>('/api/patches/upload', { method: 'POST', body: form });
  },

  pendingAnalysis: (page: number, size: number, status?: string) =>
    patchRequest<Paged<PatchRow>>(
      `/api/patches/pending-analysis${toQuery({ page, size, status })}`
    ),

  analyze: (patch_ids: Array<string | number>) =>
    patchRequest<{ id: string | number }>('/api/patches/analyze', {
      method: 'POST',
      body: JSON.stringify({ patch_ids }),
    }),

  analyzeStatus: (taskId: string | number) =>
    patchRequest<{
      completed: number;
      total: number;
      status: string;
      success: number;
      failed: number;
      patches?: Array<{ patch_id: string | number; status: number }>;
    }>(`/api/patches/analyze/${taskId}`),

  products: (includeDeleted = false) =>
    patchRequest<Product[]>(`/api/products${includeDeleted ? '?include_deleted=1' : ''}`),

  createProduct: (body: { name: string; sort_order?: number }) =>
    patchRequest<unknown>('/api/products', { method: 'POST', body: JSON.stringify(body) }),

  updateProduct: (id: string | number, body: { name: string; sort_order?: number }) =>
    patchRequest<unknown>(`/api/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteProduct: (id: string | number) =>
    patchRequest<unknown>(`/api/products/${id}`, { method: 'DELETE' }),

  addVersion: (productId: string | number, version: string) =>
    patchRequest<unknown>(`/api/products/${productId}/versions`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),

  deleteVersion: (productId: string | number, versionId: string | number) =>
    patchRequest<unknown>(`/api/products/${productId}/versions/${versionId}`, {
      method: 'DELETE',
    }),

  projectEnvs: () => patchRequest<ProjectEnv[]>('/api/project-envs'),

  projectEnvsPaged: (page: number, size: number) =>
    patchRequest<Paged<ProjectEnv>>(`/api/project-envs/paged?page=${page}&size=${size}`),

  saveProjectEnv: (body: Record<string, unknown>, id?: string | number) =>
    patchRequest<unknown>(id ? `/api/project-envs/${id}` : '/api/project-envs', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    }),

  deleteProjectEnv: (id: string | number) =>
    patchRequest<unknown>(`/api/project-envs/${id}`, { method: 'DELETE' }),

  directories: () => patchRequest<WorkDirectory[]>('/api/workflows/directories'),

  saveDirectory: (body: Record<string, unknown>, id?: string | number) =>
    patchRequest<unknown>(id ? `/api/workflows/directories/${id}` : '/api/workflows/directories', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    }),

  disableDirectory: (id: string | number) =>
    patchRequest<unknown>(`/api/workflows/directories/${id}`, { method: 'DELETE' }),

  deleteDirectory: (id: string | number) =>
    patchRequest<unknown>(`/api/workflows/directories/${id}/permanent`, { method: 'DELETE' }),

  flows: () => patchRequest<FlowConfig[]>('/api/workflows/flows'),
  prompts: () => patchRequest<PromptConfig[]>('/api/workflows/prompts'),
  templates: () => patchRequest<WorkflowTemplate[]>('/api/workflows/templates'),
  template: (id: string | number) =>
    patchRequest<WorkflowTemplate>(`/api/workflows/templates/${id}`),

  saveFlow: (body: Record<string, unknown>, id?: string | number) =>
    patchRequest<unknown>(id ? `/api/workflows/flows/${id}` : '/api/workflows/flows', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    }),

  savePrompt: (body: Record<string, unknown>, id?: string | number) =>
    patchRequest<unknown>(id ? `/api/workflows/prompts/${id}` : '/api/workflows/prompts', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    }),

  saveTemplate: (body: Record<string, unknown>, id?: string | number) =>
    patchRequest<unknown>(id ? `/api/workflows/templates/${id}` : '/api/workflows/templates', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    }),

  deleteConfig: (kind: 'flows' | 'prompts' | 'templates', id: string | number) =>
    patchRequest<unknown>(`/api/workflows/${kind}/${id}`, { method: 'DELETE' }),

  nodePrompts: (edition?: 'dev' | 'novice') =>
    patchRequest<NodePromptConfig[]>(
      `/api/node-prompts${edition ? `?edition=${encodeURIComponent(edition)}` : ''}`
    ),

  saveNodePrompt: (body: Record<string, unknown>, id?: string | number) =>
    patchRequest<unknown>(id ? `/api/node-prompts/${id}` : '/api/node-prompts', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    }),

  deleteNodePrompt: (id: string | number) =>
    patchRequest<unknown>(`/api/node-prompts/${id}`, { method: 'DELETE' }),

  seedNodePrompts: (body: Record<string, unknown>) =>
    patchRequest<{ inserted: string[]; skipped: string[] }>('/api/node-prompts/seed', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resolveNodePrompts: (product_name: string, product_version: string, edition = 'dev') =>
    patchRequest<Record<string, string>>(
      `/api/node-prompts/resolve${toQuery({
        product_name,
        product_version,
        edition: edition === 'novice' ? 'novice' : undefined,
      })}`
    ),

  workflowRuns: (page: number, size: number) =>
    patchRequest<Paged<WorkflowRunRow>>(`/api/workflows/runs?page=${page}&size=${size}`),

  deleteWorkflowRun: (id: string | number) =>
    patchRequest<unknown>(`/api/workflows/runs/${id}`, { method: 'DELETE' }),

  workflowRun: (id: string | number) =>
    patchRequest<Record<string, unknown>>(`/api/workflows/runs/${id}`),

  createWorkflowRun: (body: Record<string, unknown>) =>
    patchRequest<{ run_id?: string; id?: string }>('/api/workflows/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  directoryRequirements: (templateId: string | number) =>
    patchRequest<{
      steps: Array<{ step_order: number; flow_name?: string; default_directory_id?: number | string }>;
      options: Array<{ id: number | string; name: string; code: string }>;
    }>(`/api/workflows/templates/${templateId}/directory-requirements`),

  workflowSteps: (runId: string | number) =>
    patchRequest<Record<string, unknown>>(`/api/workflows/runs/${runId}/steps`),

  workflowStepResult: (runId: string | number, step: number) =>
    patchRequest<{
      step_order: number;
      flow_code?: string;
      flow_name?: string;
      status?: string;
      started_at?: string;
      finished_at?: string;
      error_message?: string;
      output_conclusion?: string;
      output_result?: string;
      output_context?: string;
      output_summary?: string;
      local_ccweb_session_id?: string;
      local_session_id?: string;
      server_session_id?: string;
      [key: string]: unknown;
    }>(`/api/workflows/runs/${runId}/steps/${step}/result`),

  workflowArtifacts: (runId: string | number, step: number) =>
    patchRequest<{ items: Array<{ name: string; [key: string]: unknown }> }>(
      `/api/workflows/runs/${runId}/steps/${step}/artifacts`
    ),

  workflowNext: (runId: string | number, step_order: number) =>
    patchRequest<Record<string, unknown>>(`/api/workflows/runs/${runId}/next`, {
      method: 'POST',
      body: JSON.stringify({ step_order }),
    }),

  workflowCancel: (runId: string | number) =>
    patchRequest<Record<string, unknown>>(`/api/workflows/runs/${runId}/cancel`, {
      method: 'POST',
    }),

  workflowRerun: (runId: string | number, step_order: number) =>
    patchRequest<Record<string, unknown>>(`/api/workflows/runs/${runId}/rerun`, {
      method: 'POST',
      body: JSON.stringify({ step_order }),
    }),

  claimLocal: (runId: string | number, step: number) =>
    patchRequest<{
      claimed: boolean;
      pending_local?: {
        step_order: number;
        execution_token: string;
        prompt: string;
        cwd: string;
        output_dir?: string;
      };
    }>(`/api/workflows/runs/${runId}/steps/${step}/claim-local`, { method: 'POST' }),

  releaseLocal: (runId: string | number, step: number) =>
    patchRequest<unknown>(`/api/workflows/runs/${runId}/steps/${step}/release-local`, {
      method: 'POST',
    }),

  sessionCcweb: (runId: string | number, step: number, execution_token: string, ccweb_session_id: string) =>
    patchRequest<unknown>(`/api/workflows/runs/${runId}/steps/${step}/session-ccweb`, {
      method: 'POST',
      body: JSON.stringify({ execution_token, ccweb_session_id }),
    }),

  localResult: (
    runId: string | number,
    step: number,
    body: {
      execution_token: string;
      text: string;
      error: string | null;
      session_id?: string | null;
      ccweb_session_id?: string | null;
      conclusion?: string | null;
      summary?: string | null;
    }
  ) =>
    patchRequest<Record<string, unknown>>(`/api/workflows/runs/${runId}/steps/${step}/local-result`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  reconcileLocal: (
    runId: string | number,
    step: number,
    body: {
      text: string;
      error: string | null;
      session_id?: string | null;
      ccweb_session_id?: string | null;
      conclusion?: string | null;
      summary?: string | null;
    }
  ) =>
    patchRequest<Record<string, unknown> | null>(
      `/api/workflows/runs/${runId}/steps/${step}/reconcile-local`,
      { method: 'POST', body: JSON.stringify(body) }
    ),

  workflowSession: (runId: string | number, step: number, after: number) =>
    patchRequest<{
      step_status?: string;
      unchanged?: boolean;
      size?: number;
      messages?: import('./types').Message[];
    }>(`/api/workflows/runs/${runId}/steps/${step}/session?after=${after}`),

  problemRun: (id: string) =>
    patchRequest<Record<string, unknown>>(`/api/problem-runs/${encodeURIComponent(id)}`),

  problemRuns: () => patchRequest<ProblemRunRow[]>('/api/problem-runs'),

  reportProblemRun: (body: Record<string, unknown>) =>
    patchRequest<unknown>('/api/problem-runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteProblemRun: (id: string) =>
    patchRequest<unknown>(`/api/problem-runs/${id}`, { method: 'DELETE' }),

  archiveSessions: (params: {
    user_id?: string;
    product?: string;
    local_run_id?: string;
    page: number;
    page_size: number;
  }) =>
    patchRequest<{
      total: number;
      page: number;
      page_size: number;
      items: SessionArchiveRow[];
    }>(`/api/problem-run-sessions${toQuery(params)}`),

  archiveSession: (localRunId: string, step?: string) =>
    patchRequest<SessionArchiveRow & { conversation_json?: string }>(
      `/api/problem-run-sessions/${encodeURIComponent(localRunId)}${toQuery({ step })}`
    ),

  saveArchiveSession: (body: Record<string, unknown>) =>
    patchRequest<unknown>('/api/problem-run-sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  adaptLedger: () => patchRequest<AdaptLedgerRow[]>('/api/patch-adapt/runs'),

  adaptLedgerDetail: (runId: string) =>
    patchRequest<{ run: Record<string, unknown>; items: Array<Record<string, unknown>> }>(
      `/api/patch-adapt/runs/${encodeURIComponent(runId)}`
    ),

  menuConfig: () =>
    patchRequest<{
      items: Array<{ key: string; name: string; visible: boolean; source?: string }>;
      defaults?: Record<string, boolean>;
    }>('/api/menus/config'),

  saveMenuConfig: (visible: Record<string, boolean>) =>
    patchRequest<unknown>('/api/menus/config', {
      method: 'PUT',
      body: JSON.stringify({ visible }),
    }),

  menuUsers: (keyword: string, size = 200) =>
    patchRequest<{
      items: Array<{ id: number | string; username: string; display_name?: string }>;
      total: number;
    }>(`/api/menus/users?size=${size}&keyword=${encodeURIComponent(keyword)}`),

  menuUser: (id: string | number) =>
    patchRequest<{
      items: Array<{
        key: string;
        name: string;
        role_visible: boolean;
        override: boolean | null;
        visible: boolean;
      }>;
    }>(`/api/menus/users/${id}`),

  saveMenuUser: (id: string | number, overrides: Record<string, boolean | null>) =>
    patchRequest<unknown>(`/api/menus/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ overrides }),
    }),

  usage: () =>
    patchRequest<{
      online_users?: number;
      search_count?: number;
      node_runs?: number;
      workflow_runs?: number;
      adapt_runs?: number;
    }>('/api/dashboard/usage'),

  profile: () => patchRequest<Record<string, unknown>>('/api/auth/profile'),

  changePassword: (body: {
    current_password: string;
    new_password: string;
    confirm_password: string;
  }) =>
    patchRequest<unknown>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  ccwebVersions: (edition: 'dev' | 'novice') =>
    patchRequest<ReleaseRow[]>(`/api/ccweb/versions?edition=${edition}`),

  setCcwebLatest: (version: string, edition: 'dev' | 'novice') =>
    patchRequest<unknown>('/api/ccweb/latest', {
      method: 'POST',
      body: JSON.stringify({ version, edition }),
    }),

  publishCcweb: (form: FormData) =>
    patchRequest<{ version?: string; is_latest?: boolean; warnings?: string[] }>(
      '/api/ccweb/publish',
      { method: 'POST', body: form }
    ),
};

/* ── 文件下载（带鉴权 + 多服务器回退） ── */

async function authorizedFetch(path: string): Promise<Response> {
  const response = await patchRawFetch(path);
  if (!response.ok) {
    if (response.status === 401) {
      expireSession();
      throw new ApiError('登录已失效，请重新登录', 401);
    }
    if (response.status === 403) throw new ApiError('权限不足', 403);
    throw new ApiError(`下载失败（HTTP ${response.status}）`, response.status);
  }
  return response;
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].replace(/^"|"$/g, ''));
    } catch {
      return star[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ? decodeURIComponent(plain[1]) : fallback;
}

export async function downloadPatchArchive(
  id: string | number,
  fallbackName = 'patch.zip'
): Promise<{ blob: Blob; filename: string }> {
  const response = await authorizedFetch(`/api/patches/${id}/download`);
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(
      response.headers.get('Content-Disposition'),
      fallbackName
    ),
  };
}

export async function downloadWorkflowArtifact(
  runId: string | number,
  step: number,
  name: string
): Promise<{ blob: Blob; filename: string }> {
  const response = await authorizedFetch(
    `/api/workflows/runs/${runId}/steps/${step}/artifacts/${encodeURIComponent(name)}`
  );
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(
      response.headers.get('Content-Disposition'),
      name
    ),
  };
}

export async function downloadManual(edition: 'dev' | 'novice'): Promise<{
  blob: Blob;
  filename: string;
}> {
  const response = await authorizedFetch(
    `/api/ccweb/manual${edition === 'novice' ? '?edition=novice' : ''}`
  );
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(
      response.headers.get('Content-Disposition'),
      'CC-Web使用手册.docx'
    ),
  };
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
