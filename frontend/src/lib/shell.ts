/**
 * Electron 桌面壳桥接的类型定义。
 *
 * 只有桌面壳里才会注入 window.ccwebShell；普通浏览器访问 cc-web 时不存在，
 * 所有依赖它的入口都要先判断。
 */

export interface EmbeddedBrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  devToolsOpen?: boolean;
  error?: string;
}

export interface EmbeddedBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EmbeddedBrowserListeners {
  onState?: (state: EmbeddedBrowserState) => void;
  onClose?: () => void;
  onFocus?: () => void;
}

export interface EmbeddedBrowserBridge {
  open: (url?: string) => Promise<{ ok: boolean; message?: string }>;
  close: () => Promise<{ ok: boolean }>;
  setBounds: (bounds: EmbeddedBrowserBounds) => Promise<{ ok: boolean }>;
  setVisible: (visible: boolean) => Promise<{ ok: boolean; message?: string }>;
  toggleDevTools: () => Promise<{ ok: boolean; message?: string }>;
  navigate: (url: string) => Promise<{ ok: boolean; message?: string }>;
  back: () => Promise<{ ok: boolean }>;
  forward: () => Promise<{ ok: boolean }>;
  reload: () => Promise<{ ok: boolean }>;
  stop: () => Promise<{ ok: boolean }>;
  openExternal: (url: string) => Promise<{ ok: boolean; message?: string }>;
  getState: () => Promise<{ ok: boolean; state?: EmbeddedBrowserState }>;
  subscribe: (listeners: EmbeddedBrowserListeners) => void;
  unsubscribe: () => void;
}

export interface ShellCheckResult {
  ok: boolean;
  updateAvailable?: boolean;
  current?: string;
  version?: string;
  message?: string;
}

export interface CcwebShell {
  checkForUpdates?: () => Promise<ShellCheckResult>;
  embeddedBrowser?: EmbeddedBrowserBridge;
}

export function getShell(): CcwebShell | undefined {
  return (window as unknown as { ccwebShell?: CcwebShell }).ccwebShell;
}

export function hasEmbeddedBrowser(): boolean {
  return Boolean(getShell()?.embeddedBrowser);
}

/**
 * 地址栏输入规范化：没写协议时补 http://，只放行 http/https/about:blank。
 * 用户输入 `10.13.51.22:41451/fbip` 这种裸地址也能直接打开。
 */
export function normalizeBrowserUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return '';
  if (/^about:blank$/i.test(value)) return 'about:blank';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}
