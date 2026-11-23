export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface Message {
  role: string;
  content: string;
  timestamp: number;
  content_blocks?: ContentBlock[];
  assistant?: string;
  /** 聊天页展示用的短文本；完整提示词仍保存在 content 中。 */
  display_content?: string;
}

export interface Session {
  id: string;
  assistant: string;
  cwd: string;
  model: string;
  messages: Message[];
  created_at: string;
  updated_at: string;
  history_context?: string;
  name?: string;
  agent_session_id?: string;
  history_already_sent?: boolean;
}

export interface AssistantInfo {
  name: string;
  display_name?: string;
  description?: string;
  available?: boolean;
  [key: string]: unknown;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  modified?: number;
}

export interface AgentState {
  id: string;
  finished: boolean;
  streaming?: boolean;
  content_blocks?: ContentBlock[];
  messages?: Message[];
  [key: string]: unknown;
}

/** SSE 事件（后端 /api/agent/{id}/events 的 data JSON） */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface VersionInfo {
  version: string;
  marker?: string;
  build_unix?: number;
  edition: 'dev' | 'novice';
  platform?: string;
  exe_path?: string;
  exe_mtime?: number;
  size?: number;
  sha256?: string;
}

export interface PatchConfig {
  patch_search_servers?: string[];
  code_search_url?: string;
  fbip_graph_url?: string;
}

export interface PatchItem {
  id?: string | number;
  title?: string;
  name?: string;
  description?: string;
  product?: string;
  module?: string;
  version?: string;
  author?: string;
  created_at?: string;
  updated_at?: string;
  score?: number;
  [key: string]: unknown;
}

export interface EnvCheckItem {
  ok: boolean;
  detail?: string;
  hint?: string;
  source?: string | null;
  java_home?: string;
  path?: string | null;
  [key: string]: unknown;
}

export interface EnvVarItem {
  name: string;
  value?: string;
  description?: string;
  [key: string]: unknown;
}

export interface NodeRun {
  id: string;
  title?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface AdaptRun {
  id: string;
  project_dir?: string;
  product_name?: string;
  product_version?: string;
  status?: string;
  items?: AdaptItem[];
  report?: string | null;
  started_at?: string;
  finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface AdaptItem {
  id?: string;
  seq?: number;
  patch_name?: string;
  problem_desc?: string;
  status?: string;
  changed_files?: string | null;
  conflict_detail?: string | null;
  note?: string | null;
  output_conclusion?: string | null;
  output_summary?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  title?: string;
  [key: string]: unknown;
}

/* ── patch_search 数据对象 ── */

export interface PatchRow {
  id: number | string;
  name: string;
  file_name?: string;
  product_name?: string;
  product_version?: string;
  file_format?: string;
  file_size?: number;
  status?: number;
  analyzed_at?: string | null;
  description?: string | null;
  user_keyword?: string | null;
  class_name?: string | null;
  keyword?: string | null;
  analysis_result?: unknown;
  uploaded_by?: string | null;
  uploaded_at?: string | null;
  [key: string]: unknown;
}

export interface ProductVersion {
  id: number | string;
  version: string;
  is_deleted?: boolean;
}

export interface Product {
  id: number | string;
  name: string;
  sort_order?: number;
  is_deleted?: boolean;
  versions?: ProductVersion[];
}

export interface ProjectEnv {
  id: number | string;
  project_name: string;
  product_id: number | string;
  version_id: number | string;
  product_name?: string;
  product_version?: string;
  db_connection?: string;
  debug_address?: string;
  code_directory?: string;
  package_path?: string;
  local_service_address?: string;
  patch_output_path?: string;
  local_skill_path?: string;
  local_jdk_path?: string;
  record_url?: string;
  [key: string]: unknown;
}

export interface WorkDirectory {
  id: number | string;
  code: string;
  name: string;
  path: string;
  category?: string;
  product_id?: number | string | null;
  version_id?: number | string | null;
  is_builtin?: boolean | number;
  status?: number;
  can_edit?: boolean;
  can_delete?: boolean;
  [key: string]: unknown;
}

export interface FlowConfig {
  id: number | string;
  code: string;
  name: string;
  description?: string;
  claude_target?: string;
  directory_mode?: string;
  runtime_category?: string;
  directory_code?: string;
  save_context?: boolean | number;
  can_use?: boolean;
  can_edit?: boolean;
  can_delete?: boolean;
  ownership_scope?: string;
  is_shared?: boolean;
  [key: string]: unknown;
}

export interface PromptConfig {
  id: number | string;
  name: string;
  description?: string;
  content: string;
  status?: number;
  can_edit?: boolean;
  can_delete?: boolean;
  ownership_scope?: string;
  is_shared?: boolean;
  [key: string]: unknown;
}

export interface TemplateStep {
  step_order: number;
  flow_id: number | string;
  prompt_id: number | string;
  user_prompt?: string | null;
  save_context_override?: number | null;
  flow_name?: string;
}

export interface WorkflowTemplate {
  id: number | string;
  code: string;
  name: string;
  description?: string;
  status?: number;
  can_use?: boolean;
  requires_product?: boolean;
  can_edit?: boolean;
  can_delete?: boolean;
  ownership_scope?: string;
  steps?: TemplateStep[];
  [key: string]: unknown;
}

export interface NodePromptConfig {
  id: number | string;
  edition: string;
  product_name: string;
  version_scope: string;
  stage: string;
  content: string;
  description?: string;
  status?: number;
  [key: string]: unknown;
}

export interface WorkflowRunRow {
  id: number | string;
  template_name?: string;
  template_code?: string;
  business_input?: string;
  status?: string;
  current_step?: number;
  step_count?: number;
  updated_at?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface ProblemRunRow {
  local_run_id: string;
  product_name?: string;
  product_version?: string;
  status?: string;
  conclusion?: string;
  client_host?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface AdaptLedgerRow {
  local_run_id: string;
  created_at?: string;
  product_name?: string;
  product_version?: string;
  code_directory?: string;
  status?: string;
  patch_count?: number;
  succeeded_count?: number;
  conflict_count?: number;
  nosource_count?: number;
  failed_count?: number;
  client_host?: string;
  [key: string]: unknown;
}

export interface SessionArchiveRow {
  local_run_id: string;
  step?: string;
  created_by_user_id?: number | string;
  product_name?: string;
  product_version?: string;
  problem_desc?: string;
  message_count?: number;
  agent_session_id?: string;
  created_at?: string;
  conversation_json?: string;
  [key: string]: unknown;
}

export interface ReleaseRow {
  version: string;
  platforms?: Record<string, boolean>;
  notes?: string;
  published_at?: string;
  is_latest?: boolean;
  [key: string]: unknown;
}
