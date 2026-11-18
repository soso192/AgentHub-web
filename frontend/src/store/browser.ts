import { create } from 'zustand';

const LAST_URL_KEY = 'cc-web-embedded-browser-last-url';

function readLastUrl(): string {
  try {
    return sessionStorage.getItem(LAST_URL_KEY) || '';
  } catch {
    return '';
  }
}

interface BrowserState {
  /** 抽屉是否打开。 */
  open: boolean;
  /** 本次打开时要求加载的地址；为空表示沿用视图里已有的页面。 */
  requestedUrl: string;
  /** 当前会话/任务建议的地址，由 ChatPanel 根据 env_snapshot 更新。 */
  defaultUrl: string;
  /** 上一次访问的地址，关闭再打开时兜底。 */
  lastUrl: string;
  openBrowser: (url?: string) => void;
  closeBrowser: () => void;
  setDefaultUrl: (url: string) => void;
  setLastUrl: (url: string) => void;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  open: false,
  requestedUrl: '',
  defaultUrl: '',
  lastUrl: readLastUrl(),

  openBrowser: (url) => {
    const requested = url?.trim() || get().defaultUrl || get().lastUrl || '';
    set({ open: true, requestedUrl: requested });
  },

  closeBrowser: () => set({ open: false }),

  setDefaultUrl: (url) => set({ defaultUrl: url.trim() }),

  setLastUrl: (url) => {
    const value = url && url !== 'about:blank' ? url : '';
    if (!value) return;
    try {
      sessionStorage.setItem(LAST_URL_KEY, value);
    } catch {
      /* 隐私模式等场景忽略 */
    }
    set({ lastUrl: value });
  },
}));
