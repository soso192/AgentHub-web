import { Network } from 'lucide-react';
import { Spinner } from '../ui';

export function FbipGraphTab({ url }: { url: string | null }) {
  if (url === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-3">
        <Spinner size={18} />
        <span className="text-[12.5px]">正在读取图谱地址…</span>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-3">
        <Network size={24} />
        <span className="text-[12.5px]">
          未配置 FBIP 全库表关系图谱地址（patch_servers.json 的 fbip_graph_url）
        </span>
      </div>
    );
  }

  return (
    <iframe
      title="FBIP全库表关系图谱"
      src={url}
      className="h-full min-h-0 w-full rounded-xl border border-line bg-white"
    />
  );
}
