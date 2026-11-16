import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { ArrowUp, Image as ImageIcon, Paperclip, Square, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface ComposerProps {
  onSend: (text: string, files: File[]) => void | Promise<void>;
  streaming?: boolean;
  onAbort?: () => void;
  queue?: string[];
  onRemoveQueue?: (index: number) => void;
  onClearQueue?: () => void;
  disabled?: boolean;
  placeholder?: string;
  compact?: boolean;
  autoFocus?: boolean;
  footerLeft?: React.ReactNode;
  /** 发送按钮左侧的额外操作（如智能开发任务的「合并」）。 */
  actions?: React.ReactNode;
}

export function Composer({
  onSend,
  streaming = false,
  onAbort,
  queue = [],
  onRemoveQueue,
  onClearQueue,
  disabled = false,
  placeholder = '输入消息，Enter 发送，Shift + Enter 换行',
  compact = false,
  autoFocus = false,
  footerLeft,
  actions,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, compact ? 140 : 220)}px`;
  }, [text, compact]);

  const addFiles = (incoming: FileList | File[] | null) => {
    if (!incoming) return;
    const list = Array.from(incoming).filter((file) => file.size <= 20 * 1024 * 1024);
    if (list.length) setFiles((current) => [...current, ...list]);
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && !files.length) || sending || disabled) return;
    setSending(true);
    try {
      if (files.length) {
        // 附件先本轮上传（由上层把路径拼进消息文本）；这里把文件和文本一起交出去，
        // 上层完成会话创建/上传后再清空输入框。
        await onSend(value, files);
      } else {
        await onSend(value, []);
      }
      setText('');
      setFiles([]);
    } finally {
      setSending(false);
      window.setTimeout(() => areaRef.current?.focus(), 0);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      if (composingRef.current || (event.nativeEvent as unknown as { isComposing?: boolean }).isComposing) {
        return;
      }
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const images: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === 'file' && /^image\//i.test(item.type || '')) {
        const file = item.getAsFile();
        if (file) images.push(file);
      }
    }
    if (images.length) {
      event.preventDefault();
      addFiles(images);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer?.files ?? null);
  };

  const canSend = Boolean(text.trim() || files.length);

  return (
    <div className="w-full">
      {queue.length > 0 && (
        <div className="mb-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-ink-3">
              待发送队列 · {queue.length} 条
            </span>
            {onClearQueue && (
              <button
                type="button"
                onClick={onClearQueue}
                className="text-[11.5px] text-ink-3 hover:text-danger"
              >
                清空
              </button>
            )}
          </div>
          <div className="space-y-1">
            {queue.map((item, index) => (
              <div
                key={`${item}-${index}`}
                className="flex items-center gap-2 rounded-lg bg-surface-3/70 px-2.5 py-1.5 text-[12px] text-ink-2"
              >
                <span className="shrink-0 text-[10.5px] text-ink-3">#{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{item}</span>
                {onRemoveQueue && (
                  <button
                    type="button"
                    onClick={() => onRemoveQueue(index)}
                    className="shrink-0 text-ink-3 hover:text-danger"
                    aria-label="移除队列消息"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="inline-flex max-w-[240px] items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-[11.5px] text-ink-2"
            >
              {/^image\//i.test(file.type) ? (
                <ImageIcon size={12} className="shrink-0 text-accent" />
              ) : (
                <Paperclip size={12} className="shrink-0 text-ink-3" />
              )}
              <span className="truncate">{file.name || '附件'}</span>
              <button
                type="button"
                onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                className="shrink-0 text-ink-3 hover:text-danger"
                aria-label="移除附件"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-2xl border bg-surface-2/90 transition-all duration-150',
          dragging ? 'border-accent bg-accent-soft/40' : 'border-line',
          'focus-within:border-accent/60'
        )}
        style={{ boxShadow: 'var(--shadow-panel)' }}
      >
        <textarea
          ref={areaRef}
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'block w-full resize-none bg-transparent px-4 pt-3 text-[13.5px] leading-6 text-ink outline-none placeholder:text-ink-3 disabled:opacity-60',
            compact ? 'min-h-[40px]' : 'min-h-[46px]'
          )}
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="btn-icon h-7 w-7"
            title="添加图片或文件（也可直接粘贴图片）"
          >
            <Paperclip size={15} />
          </button>
          <div className="min-w-0 flex-1 truncate text-[10.5px] text-ink-3">{footerLeft}</div>
          {actions}
          {streaming && onAbort && (
            <button
              type="button"
              onClick={onAbort}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-3 text-danger transition-colors hover:border-danger/40 hover:bg-danger-soft"
              title="停止生成"
            >
              <Square size={12} fill="currentColor" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend || disabled || sending}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg transition-all',
              canSend && !disabled
                ? 'bg-accent text-white shadow-[0_6px_16px_rgba(124,140,255,.3)] hover:bg-accent-hover'
                : 'bg-surface-3 text-ink-3'
            )}
            title={streaming ? '发送（当前回复结束后自动处理）' : '发送'}
          >
            <ArrowUp size={16} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between px-1 text-[10.5px] text-ink-3">
        <span>Enter 发送 · Shift + Enter 换行 · 支持粘贴图片</span>
        {streaming && <span className="text-success">生成中，新消息会自动排队</span>}
      </div>
    </div>
  );
}
