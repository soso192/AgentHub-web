import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * 结果输出框：跟随系统主题的底色 + 鼠标移入时右上角显示复制按钮。
 */
export function ResultBox({
  content,
  children,
  className,
  maxHeight = 'max-h-96',
}: {
  content: string;
  children?: ReactNode;
  className?: string;
  maxHeight?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const area = document.createElement('textarea');
        area.value = content;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={cn('group relative', className)}>
      <button
        type="button"
        onClick={() => void copy()}
        title="复制"
        aria-label="复制内容"
        className="absolute right-2 top-2 z-10 flex h-7 items-center gap-1 rounded-md border border-line bg-surface-2/95 px-2 text-[11px] text-ink-3 opacity-0 shadow-sm backdrop-blur transition-opacity duration-150 group-hover:opacity-100 hover:text-ink"
      >
        {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      {children ?? (
        <pre
          className={cn(
            'result-box overflow-auto whitespace-pre-wrap break-all rounded-lg p-3 font-mono text-[11.5px] leading-5',
            maxHeight
          )}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
