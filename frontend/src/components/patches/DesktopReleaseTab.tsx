import { useEffect, useRef, useState } from 'react';
import { RefreshCw, UploadCloud } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import { formatBytes, relativeTime } from '../../lib/utils';
import { Button, Spinner } from '../ui';
import { useToast } from '../ui/toast';

type Edition = 'dev' | 'impl';
type Platform = 'windows' | 'arm64' | 'x64';

const EDITIONS: Array<{ key: Edition; label: string }> = [
  { key: 'dev', label: '开发版' },
  { key: 'impl', label: '实施版' },
];

const PLATFORMS: Array<{ key: Platform; label: string; hint: string }> = [
  { key: 'windows', label: 'Windows', hint: 'latest.yml + *.exe + *.exe.blockmap' },
  { key: 'arm64', label: 'macOS ARM', hint: 'latest-mac.yml + *.zip + *.zip.blockmap' },
  { key: 'x64', label: 'macOS Intel', hint: 'latest-mac.yml + *.zip + *.zip.blockmap' },
];

interface ReleaseFile {
  name: string;
  size: number;
  updated_at: string;
}

export function DesktopReleaseTab() {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [edition, setEdition] = useState<Edition>('dev');
  const [platform, setPlatform] = useState<Platform>('windows');
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<ReleaseFile[]>([]);
  const [target, setTarget] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await patchApi.desktopReleaseFiles(edition, platform);
      setRows(data.files || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载桌面版发布文件失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition, platform]);

  const upload = async () => {
    if (!files.length) {
      toast.error('请选择要上传的文件');
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('edition', edition);
      form.append('platform', platform);
      for (const file of files) form.append('files', file, file.name);
      const result = await patchApi.publishDesktopRelease(form);
      setRows(result.files || []);
      setTarget(result.path || '');
      setFiles([]);
      if (inputRef.current) inputRef.current.value = '';
      toast.success(`已上传到 ${edition}/${platform}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const currentPlatform = PLATFORMS.find((item) => item.key === platform);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
            {EDITIONS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setEdition(item.key)}
                className={`rounded-md px-3 py-1 text-[11.5px] transition-colors ${
                  edition === item.key ? 'bg-accent text-white' : 'text-ink-3 hover:text-ink'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
            {PLATFORMS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setPlatform(item.key)}
                className={`rounded-md px-3 py-1 text-[11.5px] transition-colors ${
                  platform === item.key ? 'bg-accent text-white' : 'text-ink-3 hover:text-ink'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <Button size="sm" icon={<RefreshCw size={13} />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
      </div>

      <div className="rounded-xl border border-line bg-surface-2 p-3">
        <div className="mb-2 text-[12.5px] font-medium text-ink-2">上传发布文件</div>
        <div className="mb-2 text-[11.5px] text-ink-3">
          目标目录：desktop-update/{edition}/{platform}/
          {currentPlatform ? `　建议：${currentPlatform.hint}` : ''}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={(event) => setFiles(Array.from(event.target.files || []))}
          className="block w-full text-[12px] text-ink-3 file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-[12px] file:text-ink-2 hover:file:bg-surface-3"
        />
        {files.length > 0 && (
          <div className="mt-2 space-y-1 text-[11.5px] text-ink-3">
            {files.map((file) => (
              <div key={`${file.name}-${file.lastModified}`} className="truncate">
                {file.name} · {formatBytes(file.size)}
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<UploadCloud size={13} />}
            loading={uploading}
            onClick={() => void upload()}
          >
            上传到服务器
          </Button>
          {target && <span className="truncate text-[11px] text-ink-3">已写入：{target}</span>}
        </div>
      </div>

      <div className="rounded-xl border border-line">
        <div className="border-b border-line px-3 py-2 text-[12.5px] font-medium text-ink-2">
          当前文件
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-ink-3">该目录还没有文件</div>
        ) : (
          <div className="divide-y divide-line">
            {rows.map((row) => (
              <div key={row.name} className="flex items-center gap-3 px-3 py-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2" title={row.name}>
                  {row.name}
                </span>
                <span className="shrink-0 text-[11px] text-ink-3">{formatBytes(row.size)}</span>
                <span className="shrink-0 text-[11px] text-ink-3">{relativeTime(row.updated_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
