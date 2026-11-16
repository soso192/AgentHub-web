import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/** 把后端时间（RFC3339 / 毫秒时间戳）转成相对时间 */
export function relativeTime(input?: string | number | null): string {
  if (!input) return '';
  const value = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(value)) return '';
  const diff = Date.now() - value;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  const date = new Date(value);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function formatTime(input?: string | number | null): string {
  if (!input) return '';
  const value = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(value)) return '';
  const date = new Date(value);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function truncate(text: string, max = 48): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取 localStorage，异常时返回 fallback（隐身模式等） */
export function readStorage<T>(key: string, fallback: T, parse = true): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return parse ? (JSON.parse(raw) as T) : (raw as unknown as T);
  } catch {
    return fallback;
  }
}

export function writeStorage(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

export function dirname(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx > 0 ? normalized.slice(0, idx) : normalized;
}

export function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** 把 assistant / provider 名称映射成展示名 */
const ASSISTANT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  pi: 'Pi Agent',
  codex: 'OpenAI Codex',
  'openai-codex': 'OpenAI Codex',
};

export function assistantLabel(name?: string | null): string {
  if (!name) return 'AI';
  return ASSISTANT_LABELS[name] ?? name;
}
