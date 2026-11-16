import { useEffect, useState } from 'react';
import { AlertCircle, Eye, EyeOff, Loader2, Lock, User, Zap } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { useAuthStore } from '../store/auth';
import { Button, Checkbox } from '../components/ui';
import { useTheme } from '../lib/theme';

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

  useEffect(() => {
    restore()
      .then((result) => {
        if (result) {
          if (edition === 'novice' && !localStorage.getItem('cc-web-novice-envcheck-done')) {
            localStorage.setItem('cc-web-novice-envcheck-done', '1');
            navigate('/?settings=check', { replace: true });
          } else if (next !== '/login') {
            navigate(next, { replace: true });
          }
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (user) {
      if (edition === 'novice' && !localStorage.getItem('cc-web-novice-envcheck-done')) {
        localStorage.setItem('cc-web-novice-envcheck-done', '1');
        navigate('/?settings=check', { replace: true });
      } else {
        navigate(next, { replace: true });
      }
    }
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
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-accent/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 h-96 w-96 rounded-full bg-[#a78bfa]/10 blur-3xl" />

      <div className="panel relative w-full max-w-[400px] overflow-hidden">
        <div className="border-b border-line px-7 pb-6 pt-7 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[#a78bfa] text-white shadow-[0_10px_30px_rgba(124,140,255,.35)]">
            <Zap size={24} />
          </div>
          <div className="text-[19px] font-semibold tracking-tight text-ink">CC-Web</div>
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
          登录凭据由补丁中心校验 · CC-Web v{version?.version || '—'}
        </div>
      </div>

      <div className="absolute bottom-5 text-[10.5px] text-ink-3">
        {theme === 'dark' ? '深色模式' : '浅色模式'} · 本地工作台
      </div>
    </div>
  );
}
