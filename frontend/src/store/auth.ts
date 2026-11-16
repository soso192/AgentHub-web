import { create } from 'zustand';
import {
  clearStoredTokens,
  hasAuthSession,
  patchLogin,
  patchLogout,
  patchMe,
  readAccessToken,
  readRefreshToken,
  type PatchUser,
} from '../lib/api';

interface AuthState {
  user: PatchUser | null;
  token: string | null;
  checking: boolean;
  error: string;
  login: (username: string, password: string, rememberMe?: boolean) => Promise<PatchUser>;
  restore: () => Promise<PatchUser | null>;
  logout: () => void;
  clearError: () => void;
}

function readToken(): string | null {
  return readAccessToken() || null;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: readToken(),
  checking: false,
  error: '',

  login: async (username, password, rememberMe = false) => {
    set({ checking: true, error: '' });
    try {
      const { token, user } = await patchLogin(username, password, rememberMe);
      set({ token, user, checking: false });
      return user;
    } catch (error) {
      const message = error instanceof Error ? error.message : '登录失败';
      set({ checking: false, error: message });
      throw error;
    }
  },

  restore: async () => {
    if (!hasAuthSession()) {
      set({ user: null, token: null });
      return null;
    }
    set({ checking: true });
    try {
      const user = await patchMe();
      set({ user, token: user ? readToken() : null, checking: false });
      return user;
    } catch (error) {
      set({
        checking: false,
        error: error instanceof Error ? error.message : '无法验证登录状态',
      });
      return null;
    }
  },

  logout: () => {
    const token = get().token || readAccessToken();
    const refreshToken = readRefreshToken();
    void patchLogout(token, refreshToken);
    clearStoredTokens();
    set({ user: null, token: null, error: '' });
  },

  clearError: () => set({ error: '' }),
}));
