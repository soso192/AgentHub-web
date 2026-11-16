import { readStorage, writeStorage } from '../../lib/utils';

export type GroupBy = 'project' | 'workspace' | 'none';
export type SortBy = 'recent' | 'manual';

export interface SessionViewPrefs {
  groupBy: GroupBy;
  sortBy: SortBy;
}

export type Edition = 'dev' | 'novice';

const PREFS_KEY = 'cc-web-session-view-v1';
const ORDER_KEY = 'cc-web-session-order-v1';
const GROUP_ORDER_KEY = 'cc-web-session-group-order-v1';
const ALIAS_KEY = 'cc-web-session-group-alias-v1';
const UNGROUPED_KEY = 'cc-web-session-ungrouped-v1';
const COLLAPSED_KEY = 'cc-web-session-collapsed-v1';

export const DATE_GROUP_ORDER = ['今天', '昨天', '最近 7 天', '更早'] as const;

export function dateGroupLabel(input: string): string {
  const value = Date.parse(input);
  if (!Number.isFinite(value)) return '更早';
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (value >= startToday) return '今天';
  if (value >= startToday - 86_400_000) return '昨天';
  if (value >= startToday - 7 * 86_400_000) return '最近 7 天';
  return '更早';
}

export function normalizePath(path?: string | null): string {
  return (path || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function loadPrefs(_edition?: Edition): SessionViewPrefs {
  const stored = readStorage<Partial<SessionViewPrefs> | null>(PREFS_KEY, null);
  const groupBy: GroupBy =
    stored?.groupBy === 'project' ||
    stored?.groupBy === 'workspace' ||
    stored?.groupBy === 'none'
      ? stored.groupBy
      : 'none';
  const sortBy: SortBy = stored?.sortBy === 'manual' ? 'manual' : 'recent';
  return { groupBy, sortBy };
}

export function savePrefs(prefs: SessionViewPrefs) {
  writeStorage(PREFS_KEY, prefs);
}

export function loadSessionOrder(): string[] {
  const value = readStorage<unknown>(ORDER_KEY, []);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function saveSessionOrder(order: string[]) {
  writeStorage(ORDER_KEY, order);
}

export type GroupOrderMap = Partial<Record<GroupBy, string[]>>;

export function loadGroupOrders(): GroupOrderMap {
  const value = readStorage<GroupOrderMap>(GROUP_ORDER_KEY, {});
  return value && typeof value === 'object' ? value : {};
}

export function saveGroupOrders(value: GroupOrderMap) {
  writeStorage(GROUP_ORDER_KEY, value);
}

export type GroupAliasMap = Partial<Record<GroupBy, Record<string, string>>>;

export function loadAliases(): GroupAliasMap {
  const value = readStorage<GroupAliasMap>(ALIAS_KEY, {});
  return value && typeof value === 'object' ? value : {};
}

export function saveAliases(value: GroupAliasMap) {
  writeStorage(ALIAS_KEY, value);
}

export type UngroupedMap = Partial<Record<GroupBy, string[]>>;

export function loadUngrouped(): UngroupedMap {
  const value = readStorage<UngroupedMap>(UNGROUPED_KEY, {});
  return value && typeof value === 'object' ? value : {};
}

export function saveUngrouped(value: UngroupedMap) {
  writeStorage(UNGROUPED_KEY, value);
}

export type CollapsedMap = Partial<Record<GroupBy, string[]>>;

export function loadCollapsed(): CollapsedMap {
  const value = readStorage<CollapsedMap>(COLLAPSED_KEY, {});
  return value && typeof value === 'object' ? value : {};
}

export function saveCollapsed(value: CollapsedMap) {
  writeStorage(COLLAPSED_KEY, value);
}
