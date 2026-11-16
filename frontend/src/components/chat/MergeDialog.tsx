import { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { Button, Dialog, Spinner, Switch } from '../ui';

export interface MergeOptions {
  stripLog: boolean;
  diffReport: boolean;
}

export interface MergeDialogProps {
  open: boolean;
  initial: MergeOptions;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (options: MergeOptions) => void | Promise<void>;
}

/** 聊天页「合并」按钮弹出的阶段二开关表单。 */
export function MergeDialog({ open, initial, busy = false, onClose, onConfirm }: MergeDialogProps) {
  const [stripLog, setStripLog] = useState(initial.stripLog);
  const [diffReport, setDiffReport] = useState(initial.diffReport);

  useEffect(() => {
    if (!open) return;
    setStripLog(initial.stripLog);
    setDiffReport(initial.diffReport);
  }, [open, initial.stripLog, initial.diffReport]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="合并"
      description="阶段二会按下面的选项裁剪提示词并发送到当前会话"
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={busy ? <Spinner size={14} /> : <GitMerge size={14} />}
            disabled={busy}
            onClick={() => void onConfirm({ stripLog, diffReport })}
          >
            开始合并
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Switch
          checked={stripLog}
          onChange={setStripLog}
          disabled={busy}
          label="是否需要去除排查日志"
          description="选择否时，阶段一没有加排查日志：不重新打包，阶段一生成的补丁直接作为最终补丁。"
        />
        <Switch
          checked={diffReport}
          onChange={setDiffReport}
          disabled={busy}
          label="是否需要生成差异报告"
          description="选择否时，提示词中生成 HTML 对比报告的步骤会被移除。"
        />
      </div>
    </Dialog>
  );
}
