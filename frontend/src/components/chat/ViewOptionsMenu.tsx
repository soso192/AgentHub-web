import { useEffect } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { GroupBy, SortBy } from './sessionView';

function Option({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors',
        active
          ? 'bg-accent-soft font-medium text-accent'
          : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
      )}
    >
      <Check
        size={13}
        className={cn('shrink-0', active ? 'opacity-100' : 'opacity-0')}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function ViewOptionsMenu({
  groupBy,
  sortBy,
  onGroupChange,
  onSortChange,
  onClose,
}: {
  groupBy: GroupBy;
  sortBy: SortBy;
  onGroupChange: (value: GroupBy) => void;
  onSortChange: (value: SortBy) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-xl border border-line bg-surface-2 p-1.5 shadow-pop">
      <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
        分组方式
      </div>
      <Option
        active={groupBy === 'project'}
        label="按项目"
        onClick={() => onGroupChange('project')}
      />
      <Option
        active={groupBy === 'workspace'}
        label="按工作区"
        onClick={() => onGroupChange('workspace')}
      />
      <Option
        active={groupBy === 'none'}
        label="单列表"
        onClick={() => onGroupChange('none')}
      />

      <div className="my-1 h-px bg-line" />

      <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
        排序方式
      </div>
      <Option
        active={sortBy === 'manual'}
        label="手动排序"
        onClick={() => onSortChange('manual')}
      />
      <Option
        active={sortBy === 'recent'}
        label="最近更新"
        onClick={() => onSortChange('recent')}
      />
    </div>
  );
}
