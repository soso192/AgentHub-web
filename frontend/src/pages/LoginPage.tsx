import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Eye, EyeOff, Loader2, Lock, User } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { useAuthStore } from '../store/auth';
import { Button, Checkbox } from '../components/ui';
import { useTheme } from '../lib/theme';
import logoUrl from '../assets/logo.png';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme } = useTheme();
  const edition = useAppStore((state) => state.edition);
  const version = useAppStore((state) => state.version);
  const { user, login, restore, checking, error, clearError } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => {
    try {
      return localStorage.getItem('cc-web-remember-login') !== '0';
    } catch {
      return true;
    }
  });

  const next = new URLSearchParams(location.search).get('next') || '/';
  // 实施版/开发版各自记录一次“首次登录环境检查”；两个版本端口不同，
  // localStorage 本来就隔离，这里分开命名只是为了语义清楚。
  const envCheckDoneKey =
    edition === 'novice' ? 'cc-web-novice-envcheck-done' : 'cc-web-dev-envcheck-done';
  const navigatedRef = useRef(false);

  const navigateAfterAuth = () => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    try {
      if (!localStorage.getItem(envCheckDoneKey)) {
        localStorage.setItem(envCheckDoneKey, '1');
        navigate('/?settings=check', { replace: true });
        return;
      }
    } catch {
      /* localStorage 不可用时按已检查处理 */
    }
    if (next !== '/login') navigate(next, { replace: true });
  };

  useEffect(() => {
    restore()
      .then((result) => {
        if (result) navigateAfterAuth();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (user) navigateAfterAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const submit = async () => {
    if (!username.trim() || !password) return;
    setSubmitting(true);
    clearError();
    try {
      await login(username.trim(), password, rememberMe);
    } catch {
      /* 错误已写入 store */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-[radial-gradient(900px_560px_at_8%_0%,#dce9ff_0%,transparent_58%),radial-gradient(800px_520px_at_100%_100%,#e4eeff_0%,transparent_55%),#f3f7ff] px-4 py-8 dark:bg-[var(--bg)]">
      <div className="pointer-events-none absolute left-[8%] top-[12%] h-56 w-56 rounded-full bg-white/40 blur-3xl dark:bg-accent/10" />
      <div className="pointer-events-none absolute bottom-[8%] right-[12%] h-64 w-64 rounded-full bg-[#cfe0ff]/50 blur-3xl dark:bg-[#a78bfa]/10" />

      <div className="panel relative z-10 w-full max-w-[420px] overflow-hidden">
        <div className="border-b border-line px-7 pb-6 pt-7 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-2 p-1.5 shadow-[0_10px_30px_rgba(124,140,255,.18)]">
            <img
              src={logoUrl}
              alt="智能开发平台"
              className="h-full w-full object-contain"
            />
          </div>
          <div className="text-[19px] font-semibold tracking-tight text-ink">智能开发平台</div>
          <div className="mt-1 text-[12.5px] text-ink-3">
            {edition === 'novice' ? '实施版 · 登录后开始排查' : 'AI 编程工作台'}
          </div>
        </div>

        <div className="space-y-4 px-7 py-6">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-2">用户名</label>
            <div className="relative">
              <User
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
              />
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                }}
                autoFocus
                autoComplete="username"
                placeholder={edition === 'novice' ? undefined : '请输入用户名'}
                className="input pl-9"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-2">密码</label>
            <div className="relative">
              <Lock
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
              />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                }}
                autoComplete="current-password"
                placeholder={edition === 'novice' ? undefined : '请输入密码'}
                className="input pl-9 pr-9"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <Checkbox
            checked={rememberMe}
            onChange={(checked) => {
              setRememberMe(checked);
              try {
                localStorage.setItem('cc-web-remember-login', checked ? '1' : '0');
              } catch {
                /* ignore */
              }
            }}
            label="30 天内免登录"
          />

          {(error || checking) && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12px] text-danger">
              {checking ? (
                <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />
              ) : (
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
              )}
              <span>{checking ? '正在验证登录状态…' : error}</span>
            </div>
          )}

          <Button
            variant="primary"
            className="w-full"
            size="lg"
            loading={submitting}
            disabled={!username.trim() || !password}
            onClick={submit}
          >
            登录
          </Button>
        </div>

        <div className="border-t border-line bg-surface-2/60 px-7 py-3 text-center text-[10.5px] text-ink-3">
          智能开发平台 v{version?.version || '—'}
        </div>
      </div>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10.5px] text-ink-3">
        {theme === 'dark' ? '深色模式' : '浅色模式'} · 本地工作台
      </div>
    </div>
  );
}
