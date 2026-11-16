import { useRef } from 'react';
import { Image as ImageIcon, Paperclip, X } from 'lucide-react';

export function AttachmentField({
  value,
  onChange,
  files,
  onFilesChange,
  rows = 4,
  placeholder,
  mono = false,
}: {
  value: string;
  onChange: (value: string) => void;
  files: File[];
  onFilesChange: (files: File[]) => void;
  rows?: number;
  placeholder?: string;
  mono?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: FileList | File[] | null) => {
    if (!incoming) return;
    const list = Array.from(incoming).filter((file) => file.size <= 20 * 1024 * 1024);
    if (list.length) onFilesChange([...files, ...list]);
  };

  return (
    <div className="rounded-xl border border-line bg-surface-2 transition-colors focus-within:border-accent/50">
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {files.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border border-line bg-surface-3 px-2 py-1 text-[11.5px] text-ink-2"
            >
              {/^image\//i.test(file.type || '') ? (
                <ImageIcon size={12} className="shrink-0 text-accent" />
              ) : (
                <Paperclip size={12} className="shrink-0 text-ink-3" />
              )}
              <span className="truncate">{file.name || '附件'}</span>
              <button
                type="button"
                className="shrink-0 text-ink-3 hover:text-danger"
                onClick={() => onFilesChange(files.filter((_, i) => i !== index))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        placeholder={placeholder}
        className={`block w-full resize-none bg-transparent px-3 pt-3 text-ink outline-none placeholder:text-ink-3 ${
          mono ? 'font-mono text-[12px] leading-5' : 'text-[13px] leading-6'
        }`}
        onPaste={(event) => {
          const items = event.clipboardData?.items;
          if (!items) return;
          const pasted: File[] = [];
          for (let i = 0; i < items.length; i += 1) {
            if (items[i].kind === 'file') {
              const file = items[i].getAsFile();
              if (file) pasted.push(file);
            }
          }
          if (pasted.length) {
            event.preventDefault();
            addFiles(pasted);
          }
        }}
      />
      <div className="flex items-center gap-1.5 px-2 pb-2">
        <input
          ref={inputRef}
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
          className="btn-icon h-7 w-7"
          title="添加图片或文件"
          aria-label="添加图片或文件"
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip size={15} />
        </button>
      </div>
    </div>
  );
}
