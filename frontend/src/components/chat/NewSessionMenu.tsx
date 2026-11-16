import { useEffect, useRef, useState } from 'react';
import { ChevronDown, MessageSquarePlus, Wand2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button, type ButtonProps } from '../ui';

/**
 * 「新建会话」下拉：与左侧会话栏的入口保持一致，普通会话和开发任务从这里二选一。
 * 开发版、实施版的页面右上角都用这个组件，避免两处文案和行为不一致。
 */
export function NewSessionMenu({
  onNewSession,
  onNewTask,
  size = 'sm',
  variant = 'primary',
  className,
}: {
  onNewSession: () => void;
  onNewTask: () => void;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      <Button
        size={size}
        variant={variant}
        icon={<MessageSquarePlus size={14} />}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        新建会话
        <ChevronDown size={12} className="opacity-70" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-surface-2 p-1.5 shadow-pop">
          <button
            type="button"
            onClick={() => choose(onNewSession)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <MessageSquarePlus size={14} className="shrink-0 text-accent" />
            <span>创建普通会话</span>
          </button>
          <button
            type="button"
            onClick={() => choose(onNewTask)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <Wand2 size={14} className="shrink-0 text-accent" />
            <span>创建开发任务</span>
          </button>
        </div>
      )}
    </div>
  );
}
