import { Globe } from 'lucide-react';

export function CodeSearchTab({ url }: { url: string }) {
  if (!url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-3">
        <Globe size={24} />
        <span className="text-[12.5px]">
          未配置源码搜索地址（patch_servers.json 的 code_search_url）
        </span>
      </div>
    );
  }

  return (
    <iframe
      title="源码搜索"
      src={url}
      className="h-full min-h-0 w-full rounded-xl border border-line bg-white"
    />
  );
}
