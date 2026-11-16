import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, FolderOpen, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import type { FileEntry } from '../../lib/types';
import { basename, formatBytes } from '../../lib/utils';
import { FileIcon, FilePreviewDialog } from '../chat/FileBrowser';
import { IconButton, Spinner } from '../ui';

export function Explorer({
  root,
  className,
  title = '资源管理器',
}: {
  root: string;
  className?: string;
  title?: string;
}) {
  const [path, setPath] = useState(root || '');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<FileEntry | null>(null);

  const load = useCallback(
    async (target: string) => {
      if (!target) return;
      setLoading(true);
      setError('');
      try {
        const result = await api.files.list(target);
        if (result.success) {
          setEntries(result.files || []);
          setPath(result.path || target);
          setParent(result.parent);
        } else {
          setError('无法读取目录');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '读取目录失败');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    setPath(root || '');
    setEntries([]);
    if (root) void load(root);
  }, [root, load]);

  if (!root) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4 text-[12px] text-ink-3">
        没有可浏览的工作目录
      </div>
    );
  }

  const atRoot = path === root;

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-1.5">
        <FolderOpen size={14} className="text-warning/80" />
        <span className="text-[12.5px] font-medium text-ink-2">{title}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-ink-3" title={path}>
          {path || basename(root)}
        </span>
      </div>
      <div className="mb-1.5 flex items-center gap-1">
        <IconButton
          label="上级目录"
          className="h-6 w-6"
          disabled={atRoot || !parent}
          onClick={() => {
            if (!atRoot && parent) void load(parent);
          }}
        >
          <ArrowUp size={13} />
        </IconButton>
        <span className="min-w-0 flex-1" />
        <IconButton label="刷新" className="h-6 w-6" onClick={() => void load(path)}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>
      <div className="scroll-area max-h-[60vh] rounded-lg border border-line bg-surface-2/50 p-1">
        {loading && !entries.length ? (
          <div className="flex justify-center py-6">
            <Spinner size={15} />
          </div>
        ) : error ? (
          <div className="px-2 py-3 text-[11.5px] text-danger">{error}</div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-3 text-[11.5px] text-ink-3">空目录</div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => {
                if (entry.is_dir) void load(entry.path);
                else setPreview(entry);
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
              title={entry.path}
            >
              <FileIcon entry={entry} />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {!entry.is_dir && (
                <span className="shrink-0 text-[10px] text-ink-3">{formatBytes(entry.size ?? 0)}</span>
              )}
            </button>
          ))
        )}
      </div>
      <FilePreviewDialog file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
