import { useEffect, useState } from 'react';
import { Rocket, UploadCloud } from 'lucide-react';
import { patchApi } from '../../lib/patch';
import type { ReleaseRow } from '../../lib/types';
import { relativeTime } from '../../lib/utils';
import { Button, Checkbox, ConfirmDialog, Dialog, Input } from '../ui';
import { useToast } from '../ui/toast';
import { DataTable, type Column } from './DataTable';
import { DesktopReleaseTab } from './DesktopReleaseTab';

const PLATFORMS: Array<{ key: string; field: string; label: string }> = [
  { key: 'windows', field: 'windows', label: 'Windows' },
  { key: 'macos-arm64', field: 'macos_arm64', label: 'macOS ARM' },
  { key: 'macos-x64', field: 'macos_x64', label: 'macOS Intel' },
];

export function ReleaseTab() {
  const toast = useToast();
  const [releaseKind, setReleaseKind] = useState<'ccweb' | 'desktop'>('ccweb');
  const [edition, setEdition] = useState<'dev' | 'novice'>('dev');
  const [rows, setRows] = useState<ReleaseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [setLatest, setSetLatest] = useState(true);
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [publishing, setPublishing] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [latestTarget, setLatestTarget] = useState<ReleaseRow | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setRows(await patchApi.ccwebVersions(edition));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载版本列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition]);

  const publish = async () => {
    if (!files.windows && !files.macos_arm64 && !files.macos_x64) {
      toast.error('至少选择一个平台的文件');
      return;
    }
    setPublishing(true);
    setWarnings([]);
    try {
      const form = new FormData();
      form.append('edition', edition);
      form.append('version', version.trim());
      form.append('notes', notes);
      form.append('set_latest', setLatest ? '1' : '0');
      for (const platform of PLATFORMS) {
        const file = files[platform.field];
        if (!file) continue;
        form.append(platform.field, file, file.name);
        form.append(`${platform.field}_build_unix`, String(Math.floor(file.lastModified / 1000)));
      }
      const result = await patchApi.publishCcweb(form);
      setWarnings(result.warnings || []);
      toast.success('发布完成');
      setPublishOpen(false);
      setVersion('');
      setNotes('');
      setFiles({});
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const latest = rows.find((row) => row.is_latest);

  const columns: Array<Column<ReleaseRow>> = [
    {
      key: 'version',
      title: '版本',
      render: (row) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-[12px] font-medium text-ink">{row.version}</span>
          {row.is_latest && <span className="badge badge-success">最新</span>}
        </span>
      ),
    },
    ...PLATFORMS.map((platform) => ({
      key: platform.key,
      title: platform.label,
      align: 'center' as const,
      render: (row: ReleaseRow) =>
        row.platforms?.[platform.key] ? (
          <span className="text-success">✓</span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    })),
    {
      key: 'notes',
      title: '更新说明',
      render: (row) => (
        <span className="block max-w-[260px] truncate text-ink-3" title={row.notes}>
          {row.notes || '—'}
        </span>
      ),
    },
    {
      key: 'time',
      title: '发布时间',
      render: (row) => <span className="text-ink-3">{relativeTime(row.published_at)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      width: '120px',
      render: (row) =>
        row.is_latest ? (
          <span className="text-[11.5px] text-ink-3">当前最新</span>
        ) : (
          <Button size="sm" icon={<Rocket size={12} />} onClick={() => setLatestTarget(row)}>
            设为最新
          </Button>
        ),
    },
  ];

  const releaseKindTabs = (
    <div className="flex items-center gap-2 border-b border-line pb-2">
      <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
        {([
          ['ccweb', 'cc-web 应用发布'],
          ['desktop', '桌面版应用发布'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setReleaseKind(key)}
            className={`rounded-md px-3 py-1 text-[11.5px] transition-colors ${
              releaseKind === key ? 'bg-accent text-white' : 'text-ink-3 hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  if (releaseKind === 'desktop') {
    return (
      <div className="space-y-3">
        {releaseKindTabs}
        <DesktopReleaseTab />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {releaseKindTabs}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
            {(['dev', 'novice'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setEdition(value)}
                className={`rounded-md px-3 py-1 text-[11.5px] transition-colors ${
                  edition === value ? 'bg-accent text-white' : 'text-ink-3 hover:text-ink'
                }`}
              >
                {value === 'dev' ? '开发版' : '实施版'}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-ink-3">
            {latest
              ? `当前最新 v${latest.version} · ${relativeTime(latest.published_at)}`
              : '还没有发布过任何版本'}
          </span>
        </div>
        <Button variant="primary" icon={<UploadCloud size={14} />} onClick={() => setPublishOpen(true)}>
          发布新版本
        </Button>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[12px] text-warning">
          {warnings.join('；')}
        </div>
      )}

      <DataTable columns={columns} rows={rows} loading={loading} rowKey={(row) => row.version} empty="暂无发布记录" />

      <Dialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title="发布 cc-web 新版本"
        description="发布前请确认 Cargo.toml 的版本号已更新。未选择的平台会沿用该版本已有文件。"
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPublishOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={publishing} onClick={publish}>
              发布
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">版本号</label>
              <Input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="例如 1.0.6" />
            </div>
            <div className="flex items-end pb-1.5">
              <Checkbox checked={setLatest} onChange={setSetLatest} label="发布后设为最新版本" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-ink-2">更新说明</label>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} className="input h-auto py-2" />
          </div>
          {PLATFORMS.map((platform) => (
            <div key={platform.key}>
              <label className="mb-1 block text-[12px] font-medium text-ink-2">{platform.label} 安装包</label>
              <input
                type="file"
                onChange={(event) =>
                  setFiles((current) => ({ ...current, [platform.field]: event.target.files?.[0] || null }))
                }
                className="block w-full text-[12px] text-ink-3 file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-[12px] file:text-ink-2 hover:file:bg-surface-3"
              />
            </div>
          ))}
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(latestTarget)}
        onClose={() => setLatestTarget(null)}
        onConfirm={async () => {
          if (!latestTarget) return;
          try {
            await patchApi.setCcwebLatest(latestTarget.version, edition);
            toast.success('已设为最新版本');
            setLatestTarget(null);
            await load();
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '设置失败');
          }
        }}
        title="设为最新版本"
        description={latestTarget ? `确定把 v${latestTarget.version} 设为${edition === 'novice' ? '实施版' : '开发版'}最新版本吗？` : ''}
        confirmText="确定"
      />
    </div>
  );
}
