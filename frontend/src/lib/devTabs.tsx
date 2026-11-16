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
  codeSearchUrl: string;
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
      visible: Boolean(codeSearchUrl),
    },
    {
      key: 'directory',
      label: '工作目录',
      icon: <FolderTree size={14} />,
      visible: can('directory'),
    },
    {
      key: 'project_env',
      label: '产品环境变量',
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
