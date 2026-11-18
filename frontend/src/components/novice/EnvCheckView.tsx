import { useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Spinner } from '../ui';
import { useToast } from '../ui/toast';

interface CheckItem {
  ok: boolean;
  detail?: string;
  source?: string | null;
  java_home?: string;
  path?: string | null;
}

export function EnvCheckView({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    claude: CheckItem;
    python: CheckItem;
    git_bash: CheckItem;
  } | null>(null);

  const run = async () => {
    setLoading(true);
    try {
      const data = await api.envCheck();
      if (!data.success) throw new Error('检查失败');
      setResult(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '环境检查失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items: Array<{ key: string; title: string; item?: CheckItem; hint?: string }> = result
    ? [
        { key: 'claude', title: 'Claude Code CLI', item: result.claude },
        { key: 'python', title: 'Python', item: result.python },
        { key: 'git_bash', title: 'Git Bash / Bash', item: result.git_bash },
      ]
    : [];

  return (
    <div className={embedded ? '' : 'mx-auto max-w-3xl'}>
      <div className={embedded ? 'mb-3 flex items-center justify-between gap-3' : 'mb-4 flex items-center justify-between'}>
        <div>
          {!embedded && <h1 className="text-[18px] font-semibold text-ink">环境检查</h1>}
          <p className={embedded ? 'text-[12px] text-ink-3' : 'mt-1 text-[12.5px] text-ink-3'}>
            检查本机运行智能开发所需的 Claude、Python、Git Bash 等依赖。
          </p>
        </div>
        <Button icon={<RefreshCw size={14} />} loading={loading} onClick={run}>
          重新检查
        </Button>
      </div>

      {!result && loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-ink-3">
          <Spinner size={16} /> 正在检查本机环境…
        </div>
      ) : result ? (
        <div className="space-y-2">
          {items.map(({ key, title, item, hint }) => (
            <div
              key={key}
              className={`rounded-xl border p-4 ${
                item?.ok ? 'border-success/25 bg-success-soft/30' : 'border-danger/25 bg-danger-soft/30'
              }`}
            >
              <div className="flex items-start gap-3">
                <span className={item?.ok ? 'mt-0.5 text-success' : 'mt-0.5 text-danger'}>
                  {item?.ok ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium text-ink">{title}</span>
                    <span className={`badge ${item?.ok ? 'badge-success' : 'badge-danger'}`}>
                      {item?.ok ? '正常' : '异常'}
                    </span>
                  </div>
                  <div className="mt-1 break-all text-[12px] leading-5 text-ink-2">{item?.detail}</div>
                  {hint && <div className="mt-1 text-[11px] text-ink-3">{hint}</div>}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-surface p-6 text-center text-[12.5px] text-ink-3">
          检查失败，请稍后重试
        </div>
      )}
    </div>
  );
}
