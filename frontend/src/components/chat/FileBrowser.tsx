import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import { api } from '../../lib/api';
import type { FileEntry } from '../../lib/types';
import { basename, cn, formatBytes } from '../../lib/utils';
import { useChatStore } from '../../store/chat';
import { Button, Dialog, IconButton, Spinner, Tooltip } from '../ui';
import { useToast } from '../ui/toast';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
const CODE_EXT = /\.(ts|tsx|js|jsx|java|rs|py|go|c|cpp|h|hpp|cs|php|rb|kt|scala|sql|sh|bat|ps1|css|scss|less|html|htm|vue|json|yaml|yml|xml|toml|properties|ini|cfg)$/i;

export function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.is_dir) return <Folder size={14} className="text-warning/80" />;
  if (IMAGE_EXT.test(entry.name)) return <FileImage size={14} className="text-info/80" />;
  if (CODE_EXT.test(entry.name)) return <FileCode2 size={14} className="text-accent/80" />;
  if (/\.(md|txt|log)$/i.test(entry.name)) return <FileText size={14} className="text-ink-3" />;
  return <File size={14} className="text-ink-3" />;
}

export function FilePreviewDialog({
  file,
  onClose,
}: {
  file: FileEntry | null;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!file) return;
    setContent(null);
    setError('');
    if (IMAGE_EXT.test(file.name) || /\.pdf$/i.test(file.name)) return;
    setLoading(true);
    api.files
      .read(file.path)
      .then((result) => {
        if (result.success) setContent(result.content);
        else setError('无法读取该文件');
      })
      .catch((err) => setError(err instanceof Error ? err.message : '读取失败'))
      .finally(() => setLoading(false));
  }, [file]);

  if (!file) return null;
  const isImage = IMAGE_EXT.test(file.name);
  const isPdf = /\.pdf$/i.test(file.name);
  const lines = content?.split('\n') ?? [];
  const shown = lines.slice(0, 3000);

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <FileIcon entry={file} />
          {file.name}
        </span>
      }
      description={
        <span className="break-all font-mono text-[11px]">{file.path}</span>
      }
      width="max-w-5xl"
      footer={
        <>
          <span className="mr-auto text-[11.5px] text-ink-3">
            {file.is_dir ? '目录' : formatBytes(file.size ?? 0)}
            {content != null && ` · ${lines.length} 行`}
          </span>
          {content != null && (
            <Button
              icon={<Copy size={13} />}
              onClick={() => {
                navigator.clipboard?.writeText(content).catch(() => {});
                toast.success('已复制文件内容');
              }}
            >
              复制内容
            </Button>
          )}
          <Button
            icon={<ExternalLink size={13} />}
            onClick={() => window.open(api.files.rawUrl(file.path), '_blank')}
          >
            在新标签打开
          </Button>
          <Button
            onClick={() => {
              api.files.reveal(file.path).catch(() => {});
            }}
          >
            在资源管理器中定位
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner size={22} />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-danger/25 bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : isImage ? (
        <div className="flex justify-center rounded-xl bg-[var(--code-bg)] p-4">
          <img
            src={api.files.rawUrl(file.path)}
            alt={file.name}
            className="max-h-[60vh] max-w-full rounded-lg object-contain"
          />
        </div>
      ) : isPdf ? (
        <iframe
          title={file.name}
          src={api.files.rawUrl(file.path)}
          className="h-[65vh] w-full rounded-lg border border-line bg-white"
        />
      ) : (
        <div className="overflow-auto rounded-xl border border-line bg-[var(--code-bg)]">
          <pre className="min-w-max p-0 text-[12px] leading-[1.65] text-[#c9d2e3]">
            {shown.map((line, index) => (
              <div key={index} className="flex hover:bg-white/[0.03]">
                <span className="w-12 shrink-0 select-none border-r border-white/5 px-2 text-right text-[11px] text-white/25">
                  {index + 1}
                </span>
                <span className="whitespace-pre px-3 font-mono">{line || ' '}</span>
              </div>
            ))}
          </pre>
          {lines.length > 3000 && (
            <div className="border-t border-line px-3 py-2 text-[11.5px] text-ink-3">
              文件较大，仅展示前 3000 行（共 {lines.length} 行）
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function FileBrowser({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const sessions = useChatStore((state) => state.sessions);
  const views = useChatStore((state) => state.views);
  const cwd =
    (currentSessionId ? views[currentSessionId]?.cwd : '') ||
    sessions.find((item) => item.id === currentSessionId)?.cwd ||
    '';

  const [open, setOpen] = useState(defaultOpen);
  const [path, setPath] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const lastStreaming = useRef(false);

  const streaming = currentSessionId ? Boolean(views[currentSessionId]?.streaming) : false;

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
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    setPath(cwd);
    setEntries([]);
    setError('');
    if (cwd && open) void load(cwd);
  }, [cwd]);

  useEffect(() => {
    if (open && cwd && !entries.length && !loading) void load(path || cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (lastStreaming.current && !streaming && open && path) {
      void load(path);
    }
    lastStreaming.current = streaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  const isRoot = !cwd || path === cwd;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 border-b border-line-soft bg-surface-3/30 px-3 py-2.5 text-left text-[12px] font-medium text-ink-2 transition-colors hover:bg-surface-2"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <FolderOpen size={14} className="text-warning/80" />
        <span className="flex-1">文件</span>
        {cwd && (
          <span className="max-w-[130px] truncate text-[10.5px] font-normal text-ink-3" title={path || cwd}>
            {basename(path || cwd) || path || cwd}
          </span>
        )}
      </button>

      {open && (
        <div className="px-2 pb-2">
          {!cwd ? (
            <div className="px-2 py-3 text-[11.5px] text-ink-3">选择一个会话后浏览工作目录</div>
          ) : (
            <>
              <div className="mb-1 flex items-center gap-1 px-1">
                <IconButton
                  label="上级目录"
                  className="h-6 w-6"
                  disabled={isRoot || !parent}
                  onClick={() => {
                    if (parent && !isRoot) void load(parent);
                    else if (isRoot) return;
                  }}
                >
                  <ArrowUp size={13} />
                </IconButton>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3"
                  title={path || cwd}
                >
                  {path || cwd}
                </span>
                <IconButton
                  label="刷新"
                  className="h-6 w-6"
                  onClick={() => void load(path || cwd)}
                >
                  <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                </IconButton>
              </div>

              <div className="scroll-area max-h-56 rounded-lg border border-line bg-surface-2/50 p-1">
                {loading && !entries.length ? (
                  <div className="flex justify-center py-5">
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
            </>
          )}
        </div>
      )}

      <FilePreviewDialog file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
