import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import {
  api,
  getPatchServers,
  readRefreshToken,
  refreshAccessToken,
} from '../../lib/api';
import { Button } from '../ui';
import { useToast } from '../ui/toast';

interface RemoteInfo {
  version?: string;
  notes?: string;
  has_package?: boolean;
  build_unix?: number;
}

interface UpdateData {
  shell_managed?: boolean;
  update_available?: boolean;
  local?: { version?: string; platform?: string };
  remote?: RemoteInfo | null;
}

export function UpdatePanel({ currentVersion }: { currentVersion?: string }) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState('');
  const [data, setData] = useState<UpdateData | null>(null);

  const freshAuth = async () => {
    if (readRefreshToken()) {
      try {
        await refreshAccessToken();
      } catch {
        /* 网络异常时继续用现有 token 尝试；401 会在请求里体现 */
      }
    }
    return getPatchServers();
  };

  const check = async () => {
    setChecking(true);
    setProgress('');
    try {
      const { servers, token } = await freshAuth();
      if (!servers.length) {
        toast.error('补丁中心地址未配置');
        return;
      }
      if (!token) {
        toast.error('请先登录补丁中心后再检查更新');
        return;
      }
      const result = await api.update.check(servers[0], token);
      if (!result.success) {
        toast.error(String(result.error || '检查更新失败'));
        return;
      }
      const payload = result.data as UpdateData;
      setData(payload);
      if (payload.shell_managed) {
        toast.info('桌面版由安装包统一升级');
      } else if (payload.remote && payload.remote.has_package === false) {
        toast.info('最新版本暂未提供本平台安装包');
      } else if (payload.update_available) {
        toast.success(`发现新版本 v${payload.remote?.version || ''}`);
      } else {
        toast.success('当前已是最新版本');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '检查更新失败');
    } finally {
      setChecking(false);
    }
  };

  const applyUpdate = async () => {
    const { servers, token } = await freshAuth();
    if (!servers.length || !token) return;
    setUpdating(true);
    setProgress('准备下载…');
    try {
      const response = await fetch('/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_url: servers[0], auth_token: token }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;

      const handleLine = (line: string) => {
        if (line.startsWith('progress ')) {
          const [, got, total] = line.split(' ');
          const percent =
            Number(total) > 0 ? Math.round((Number(got) / Number(total)) * 100) : 0;
          setProgress(`下载中 ${percent}%`);
        } else if (line.startsWith('ok ')) {
          done = true;
          const payload = JSON.parse(line.slice(3)) as { message?: string };
          const message = payload.message || '更新完成';
          setProgress(message);
          toast.success(message);
        } else if (line.startsWith('error ')) {
          throw new Error(line.slice(6));
        }
      };

      while (reader && !done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) handleLine(line);
      }
      if (buffer.trim()) handleLine(buffer.trim());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新失败');
      setProgress('');
    } finally {
      setUpdating(false);
    }
  };

  const remote = data?.remote;
  const status = (() => {
    if (!data) return `当前版本 v${currentVersion || '—'}`;
    if (data.shell_managed) return '桌面版由安装包统一升级';
    if (remote && remote.has_package === false) return '最新版本暂未提供本平台安装包';
    if (data.update_available) return `发现新版本 v${remote?.version || '—'}`;
    return `当前已是最新版本（v${currentVersion || data.local?.version || '—'}）`;
  })();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-ink-2">{status}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<RefreshCw size={13} />} loading={checking} onClick={check}>
            检查更新
          </Button>
          {data?.update_available && remote?.has_package !== false && (
            <Button
              size="sm"
              variant="primary"
              icon={<Download size={13} />}
              loading={updating}
              onClick={() => void applyUpdate()}
            >
              立即更新
            </Button>
          )}
        </div>
      </div>
      {remote?.notes && (
        <div className="whitespace-pre-wrap rounded-lg bg-surface-3/70 px-2.5 py-2 text-[11.5px] leading-5 text-ink-3">
          {remote.notes}
        </div>
      )}
      {progress && <div className="text-[11.5px] text-accent">{progress}</div>}
    </div>
  );
}
