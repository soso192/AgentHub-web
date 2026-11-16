import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { Product } from '../../lib/types';
import { cn } from '../../lib/utils';

export function ProductPicker({
  value,
  onChange,
  products,
  placeholder = '产品名称',
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  products: Product[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
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

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return products;
    return products.filter((item) => item.name.toLowerCase().includes(keyword));
  }, [products, query]);

  const select = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
          setQuery('');
        }}
        className="input flex items-center justify-between gap-2 text-left"
        title={value || placeholder}
      >
        <span className={cn('min-w-0 flex-1 truncate', value ? 'text-ink' : 'text-ink-3')}>
          {value || placeholder}
        </span>
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-ink-3 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[240px] overflow-hidden rounded-xl border border-line bg-surface-2 p-1.5 shadow-pop">
          <div className="relative mb-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索产品"
              className="h-8 w-full rounded-lg border border-line bg-surface-3 pl-8 pr-2 text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-accent/50"
            />
          </div>
          <div className="max-h-60 overflow-y-auto">
            <button
              type="button"
              onClick={() => select('')}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors',
                !value ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
              )}
            >
              <span className="min-w-0 flex-1 truncate">全部产品</span>
              {!value && <Check size={13} className="shrink-0" />}
            </button>
            {filtered.map((item) => (
              <button
                key={String(item.id)}
                type="button"
                onClick={() => select(item.name)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors',
                  value === item.name
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
                )}
              >
                <span className="min-w-0 flex-1 truncate" title={item.name}>
                  {item.name}
                </span>
                {value === item.name && <Check size={13} className="shrink-0" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-center text-[11.5px] text-ink-3">未找到产品</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
