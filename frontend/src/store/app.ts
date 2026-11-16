import { create } from 'zustand';
import { api } from '../lib/api';
import type { VersionInfo } from '../lib/types';
import { useChatStore } from './chat';

export type Edition = 'dev' | 'novice';

interface AppState {
  version: VersionInfo | null;
  edition: Edition;
  ready: boolean;
  error: string;
  init: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  version: null,
  edition: 'dev',
  ready: false,
  error: '',

  init: async () => {
    if (get().ready) return;
    try {
      const result = await api.version();
      if (!result.success || !result.data) {
        throw new Error((result as unknown as { error?: string }).error || '无法读取版本信息');
      }
      const version = result.data;
      const edition: Edition = version.edition === 'novice' ? 'novice' : 'dev';
      set({ version, edition });

      await useChatStore.getState().init();
      set({ ready: true });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        ready: true,
      });
    }
  },
}));
