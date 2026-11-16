import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import { cn } from '../../lib/utils';

/* ── Button ── */
type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const buttonVariants: Record<ButtonVariant, string> = {
  default: 'btn',
  primary: 'btn btn-primary',
  ghost: 'btn btn-ghost',
  danger: 'btn btn-danger',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-[12.5px]',
  md: '',
  lg: 'h-10 px-4 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'md', loading, icon, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={cn(buttonVariants[variant], buttonSizes[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, active, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      className={cn('btn-icon', active && 'bg-accent-soft text-accent', className)}
      {...props}
    >
      {children}
    </button>
  );
});

/* ── Badge ── */
export function Badge({
  children,
  tone = 'muted',
  className,
}: {
  children: ReactNode;
  tone?: 'accent' | 'success' | 'warning' | 'danger' | 'muted';
  className?: string;
}) {
  return <span className={cn('badge', `badge-${tone}`, className)}>{children}</span>;
}

/* ── Input / Select ── */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn('input', className)} {...props} />;
  }
);

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, ...props },
  ref
) {
  return (
    <div className={cn('relative', className)}>
      <select
        ref={ref}
        className="input appearance-none pr-8 [&>option]:bg-surface-2 [&>option]:text-ink"
        {...props}
      >
        {placeholder != null && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3"
      />
    </div>
  );
});

/* ── Checkbox ── */
export function Checkbox({
  checked,
  onChange,
  label,
  className,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer select-none items-center gap-2 text-[13px] text-ink-2',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      <span
        className={cn(
          'flex h-4 w-4 items-center justify-center rounded-[5px] border transition-colors',
          checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface-2'
        )}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/* ── Switch ── */
export function Switch({
  checked,
  onChange,
  label,
  description,
  className,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2',
        disabled && 'opacity-50',
        className
      )}
    >
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-ink-2">{label}</div>
        {description && (
          <div className="mt-0.5 text-[10.5px] leading-4 text-ink-3">{description}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-line bg-surface-3'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'left-0.5 translate-x-4' : 'left-0.5 translate-x-0'
          )}
        />
      </button>
    </div>
  );
}

/* ── Spinner / Empty ── */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cn('animate-spin text-ink-3', className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-14 text-center',
        className
      )}
    >
      {icon && <div className="mb-1 text-ink-3 opacity-70">{icon}</div>}
      <div className="text-[14px] font-medium text-ink-2">{title}</div>
      {description && <div className="max-w-sm text-[12.5px] leading-6 text-ink-3">{description}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* ── Tabs ── */
export interface TabItem {
  key: string;
  label: ReactNode;
  badge?: ReactNode;
}

export function Tabs({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1 border-b border-line', className)}>
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors',
              active
                ? 'border-accent font-medium text-ink'
                : 'border-transparent text-ink-3 hover:text-ink-2'
            )}
          >
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

/* ── Dialog ── */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
  className,
}: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'panel relative w-full animate-fade-in overflow-hidden',
          width,
          className
        )}
        style={{ boxShadow: 'var(--shadow-pop)' }}
      >
        {(title || description) && (
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              {title && <div className="text-[15px] font-semibold text-ink">{title}</div>}
              {description && (
                <div className="mt-1 text-[12.5px] leading-5 text-ink-3">{description}</div>
              )}
            </div>
            <IconButton label="关闭" onClick={onClose} className="-mr-2 -mt-1">
              <X size={16} />
            </IconButton>
          </div>
        )}
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = '确认',
  danger = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmText?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    />
  );
}

/* ── Tooltip（CSS，简洁） ── */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
}) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        className={cn(
          'pointer-events-none absolute left-1/2 z-40 w-max max-w-[260px] -translate-x-1/2 rounded-md border border-line bg-surface-3 px-2 py-1 text-[11.5px] leading-4 text-ink-2 opacity-0 shadow-pop transition-opacity duration-100 group-hover/tt:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
        )}
      >
        {content}
      </span>
    </span>
  );
}
