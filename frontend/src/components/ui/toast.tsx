import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';

type ToastTone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: ReactNode;
  tone: ToastTone;
}

interface ToastApi {
  show: (message: ReactNode, tone?: ToastTone) => void;
  success: (message: ReactNode) => void;
  error: (message: ReactNode) => void;
  info: (message: ReactNode) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (message: ReactNode, tone: ToastTone = 'info') => {
      const id = idRef.current++;
      setItems((prev) => [...prev.slice(-3), { id, message, tone }]);
      window.setTimeout(() => dismiss(id), 3800);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message) => show(message, 'success'),
      error: (message) => show(message, 'error'),
      info: (message) => show(message, 'info'),
    }),
    [show]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed left-1/2 top-5 z-[80] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4">
          {items.map((item) => (
            <div
              key={item.id}
              className={cn(
                'pointer-events-auto flex w-full animate-fade-in items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] shadow-pop backdrop-blur',
                item.tone === 'success' && 'border-success/30 bg-surface-2 text-ink',
                item.tone === 'error' && 'border-danger/35 bg-surface-2 text-ink',
                item.tone === 'info' && 'border-line bg-surface-2 text-ink'
              )}
            >
              {item.tone === 'success' && <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />}
              {item.tone === 'error' && <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />}
              {item.tone === 'info' && <Info size={16} className="mt-0.5 shrink-0 text-info" />}
              <div className="min-w-0 flex-1 leading-5">{item.message}</div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="mt-0.5 shrink-0 text-ink-3 hover:text-ink"
                aria-label="关闭提示"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
