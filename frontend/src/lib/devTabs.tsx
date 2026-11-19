import type { ReactNode } from 'react';
import {
  ArrowRightLeft,
  Boxes,
  Bug,
  Code2,
  FileUp,
  FolderTree,
  KeyRound,
  LayoutList,
  ListChecks,
  MessageSquare,
  Network,
  PackageCheck,
  PackageSearch,
  Server,
  Settings2,
  Smartphone,
  Sparkles,
  UploadCloud,
} from 'lucide-react';

export interface DevTabDef {
  key: string;
  label: string;
  icon: ReactNode;
  visible: boolean;
}

const CODE_SEARCH_CACHE_KEY = 'cc-web-code-search-url';
const FBIP_GRAPH_CACHE_KEY = 'cc-web-fbip-graph-url';

/** 上次取到的源码搜索地址；null 表示还没有取到过，不能当成“未配置”。 */
export function readCachedCodeSearchUrl(): string | null {
  try {
    const value = localStorage.getItem(CODE_SEARCH_CACHE_KEY);
    return value === null ? null : value;
  } catch {
    return null;
  }
}

export function rememberCodeSearchUrl(url: string): void {
  try {
    localStorage.setItem(CODE_SEARCH_CACHE_KEY, url);
  } catch {
    /* localStorage 不可用时只影响下次首屏，不影响功能 */
  }
}

/** 上次取到的 FBIP 全库表关系图谱地址；null 表示还没取到。 */
export function readCachedFbipGraphUrl(): string | null {
  try {
    const value = localStorage.getItem(FBIP_GRAPH_CACHE_KEY);
    return value === null ? null : value;
  } catch {
    return null;
  }
}

export function rememberFbipGraphUrl(url: string): void {
  try {
    localStorage.setItem(FBIP_GRAPH_CACHE_KEY, url);
  } catch {
    /* ignore */
  }
}

/**
 * 开发版工作台菜单定义。
 * 补丁中心主页面顶部页签与聊天页左侧「工作台」共用这份配置，
 * 保证点击会话切到聊天页后菜单不会丢失。
 */
export function buildDevTabs({
  edition,
  admin,
  menus,
  codeSearchUrl,
}: {
  edition: string;
  admin: boolean;
  menus: string[] | null;
  /** null = 配置尚未返回；此时先按“已配置”显示，避免菜单项刷新时闪动。 */
  codeSearchUrl: string | null;
}): DevTabDef[] {
  const can = (key: string) => !menus || menus.includes(key);

  return [
    {
      key: 'node',
      label: edition === 'novice' ? '智能排查' : '智能开发',
      icon: <Bug size={14} />,
      visible: true,
    },
    { key: 'smart', label: '智能分析', icon: <Sparkles size={14} />, visible: can('smart') },
    {
      key: 'search',
      label: '普通检索',
      icon: <PackageSearch size={14} />,
      visible: can('search'),
    },
    { key: 'upload', label: '补丁上传', icon: <UploadCloud size={14} />, visible: can('upload') },
    { key: 'mine', label: '我的补丁', icon: <FileUp size={14} />, visible: can('mine') },
    {
      key: 'adapt',
      label: '补丁适配',
      icon: <ArrowRightLeft size={14} />,
      visible: can('adapt'),
    },
    {
      key: 'codesearch',
      label: '源码搜索',
      icon: <Code2 size={14} />,
      // 配置还没回来（null）时先显示；回来后若确实没配再隐藏。
      visible: codeSearchUrl === null || Boolean(codeSearchUrl),
    },
    {
      key: 'fbipgraph',
      label: 'FBIP全库表关系图谱',
      icon: <Network size={14} />,
      // 内置页面，开发版固定显示，不依赖异步配置，避免刷新时菜单闪动。
      visible: edition !== 'novice',
    },
    {
      key: 'patchdeploy',
      label: '补丁管理',
      icon: <PackageCheck size={14} />,
      // 本地部署能力只放在开发版；实施版后端不注册 /api/patch-deploy 高危路由。
      visible: edition !== 'novice',
    },
    {
      key: 'directory',
      label: '工作目录',
      icon: <FolderTree size={14} />,
      visible: can('directory'),
    },
    {
      key: 'project_env',
      label: '项目环境',
      icon: <Server size={14} />,
      visible: can('project_env'),
    },
    { key: 'flow', label: '流程设置', icon: <Settings2 size={14} />, visible: can('flow') },
    { key: 'prompt', label: '提示词设置', icon: <KeyRound size={14} />, visible: can('prompt') },
    {
      key: 'template',
      label: '流程模板',
      icon: <ListChecks size={14} />,
      visible: can('template'),
    },
    {
      key: 'product',
      label: '产品版本',
      icon: <Boxes size={14} />,
      visible: admin && can('product'),
    },
    {
      key: 'analysis',
      label: '待分析补丁',
      icon: <ListChecks size={14} />,
      visible: admin && can('analysis'),
    },
    { key: 'menus', label: '菜单可见性', icon: <LayoutList size={14} />, visible: admin },
    {
      key: 'sessions',
      label: '会话存档',
      icon: <MessageSquare size={14} />,
      visible: admin,
    },
    { key: 'release', label: '版本发布', icon: <Smartphone size={14} />, visible: admin },
  ];
}
