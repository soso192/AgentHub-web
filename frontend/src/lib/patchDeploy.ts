import { ApiError, request } from './api';

interface PatchDeployEnvelope<T> {
  success?: boolean;
  code?: number;
  data?: T;
  error?: string;
  message?: string;
}

/** 补丁部署接口统一 HTTP 200，成功/失败看包内 code。 */
async function patchDeployRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const envelope = await request<PatchDeployEnvelope<T>>(path, init);
  if (!envelope || envelope.success === false || envelope.code !== 0) {
    throw new ApiError(
      envelope?.error || envelope?.message || '补丁部署请求失败',
      envelope?.code ?? 0
    );
  }
  return envelope.data as T;
}

export interface PatchDeployService {
  kind: string;
  root: string;
  stop_script: string | null;
  force_script: string | null;
  start_script: string | null;
  restart_script: string | null;
  deploy_script: string | null;
  can_restart: boolean;
  message: string;
}

export interface PatchDeployEnv {
  edition: '8.1' | '8.2';
  edition_label: string;
  input_path: string;
  target_root: string;
  app_root: string;
  service_key: string;
  service: PatchDeployService;
}

export interface PatchDeployEntry {
  archive: string;
  archive_path: string;
  target_rel: string;
  status: 'add' | 'replace' | 'ignored' | 'error' | string;
  ignore_reason: string | null;
  warning: string | null;
  size: number;
  sha256: string | null;
  target_sha256: string | null;
  shadow_jar: string | null;
  error: string | null;
}

export interface PatchDeployArchive {
  name: string;
  entries: PatchDeployEntry[];
  errors: string[];
}

export interface PatchDeployStats {
  total: number;
  add: number;
  replace: number;
  shadow: number;
  ignored: number;
  errors: number;
}

export interface PatchDeployPlan {
  success: boolean;
  batch_id: string;
  created_at: string;
  product_name: string;
  product_version: string;
  env: PatchDeployEnv;
  archives: PatchDeployArchive[];
  stats: PatchDeployStats;
  has_conflicts: boolean;
  can_deploy: boolean;
  warnings: string[];
}

export interface PatchDeployBatchFile {
  target_rel: string;
  action: 'add' | 'replace' | string;
  backup_rel: string | null;
  sha256: string;
  size: number;
  shadow_jar: string | null;
}

export interface PatchDeployArtifact {
  path: string;
  name: string;
  size: number;
  updated_at: string;
}

export interface PatchDeployBatch {
  id: string;
  seq: number;
  created_at: string;
  product_name: string;
  product_version: string;
  edition: string;
  target_root: string;
  app_root: string;
  archives: string[];
  files: PatchDeployBatchFile[];
  status: string;
  rolled_back_at: string | null;
  note: string | null;
  later_deployed: number;
  service_key: string;
  source?: 'chat' | 'manual' | string;
  session_id?: string | null;
  session_name?: string | null;
  operator?: string | null;
}

export interface PatchDeployResult {
  success: boolean;
  batch_id: string;
  message: string;
  applied: number;
  replaced: number;
  added: number;
  service_restarted: boolean;
  warnings: string[];
  log_tail: string[];
}

export interface PatchDeployConfig {
  last_target: string;
  edition: string;
  restart: boolean;
  product_name: string;
  product_version: string;
  recent_targets: string[];
}

export const patchDeployApi = {
  config: () =>
    patchDeployRequest<{ success: boolean; config: PatchDeployConfig }>('/api/patch-deploy/config'),

  saveConfig: (body: Partial<PatchDeployConfig>) =>
    patchDeployRequest<{ success: boolean; config: PatchDeployConfig }>('/api/patch-deploy/config', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  detect: (path: string, edition: string) =>
    patchDeployRequest<{ success: boolean; env: PatchDeployEnv }>('/api/patch-deploy/detect', {
      method: 'POST',
      body: JSON.stringify({ path, edition }),
    }),

  preflight: (form: FormData) =>
    patchDeployRequest<PatchDeployPlan>('/api/patch-deploy/preflight', {
      method: 'POST',
      body: form,
    }),

  preflightByPath: (body: {
    target: string;
    edition?: string;
    product_name?: string;
    product_version?: string;
    session_id: string;
    artifact_dir?: string;
    paths: string[];
    operator?: string;
  }) =>
    patchDeployRequest<PatchDeployPlan>('/api/patch-deploy/preflight-by-path', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  sessionArtifacts: (sessionId: string, path?: string) =>
    patchDeployRequest<{ artifacts: PatchDeployArtifact[] }>(
      `/api/patch-deploy/session-artifacts?session_id=${encodeURIComponent(sessionId)}${
        path ? `&path=${encodeURIComponent(path)}` : ''
      }`
    ),

  deploy: (body: { batch_id: string; restart: boolean; confirm_replace: boolean }) =>
    patchDeployRequest<PatchDeployResult>('/api/patch-deploy/deploy', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  cancel: (batchId: string) =>
    patchDeployRequest<{ success: boolean }>('/api/patch-deploy/cancel', {
      method: 'POST',
      body: JSON.stringify({ batch_id: batchId }),
    }),

  batches: () =>
    patchDeployRequest<{ success: boolean; batches: PatchDeployBatch[] }>('/api/patch-deploy/batches'),

  deleteBatch: (batchId: string) =>
    patchDeployRequest<{ success: boolean; batch_id: string }>(
      `/api/patch-deploy/batches/${encodeURIComponent(batchId)}/delete`,
      { method: 'POST' }
    ),

  rollback: (body: { batch_id: string; restart: boolean; confirm: boolean }) =>
    patchDeployRequest<PatchDeployResult>('/api/patch-deploy/rollback', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  restart: (path: string, edition = 'auto') =>
    patchDeployRequest<PatchDeployResult>('/api/patch-deploy/restart', {
      method: 'POST',
      body: JSON.stringify({ path, edition }),
    }),

  saveServiceCommands: (body: {
    service_key: string;
    start_script: string;
    stop_script: string;
    restart_script: string;
  }) =>
    patchDeployRequest<{
      success: boolean;
      service_key: string;
      commands: {
        start_script: string | null;
        stop_script: string | null;
        restart_script: string | null;
      };
    }>('/api/patch-deploy/service-commands', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
