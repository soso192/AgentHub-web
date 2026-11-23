import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  FolderOpen,
  GitMerge,
  MessageSquarePlus,
  PackageCheck,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { api } from '../../lib/api';
import { assistantLabel, cn } from '../../lib/utils';
import { useAppStore } from '../../store/app';
import { useBrowserStore } from '../../store/browser';
import { useChatStore } from '../../store/chat';
import { useNodeStore, type LocalNodeRun } from '../../store/nodeRuns';
import { useWorkflowSessionStore } from '../../store/workflowSessions';
import { Button, Input, Select, Spinner, Tooltip } from '../ui';
import { useToast } from '../ui/toast';
import { Composer } from './Composer';
import { MergeDialog } from './MergeDialog';
import { ChatPatchDeployDialog } from './ChatPatchDeployDialog';
import { MessageList } from './MessageList';

export interface ChatPanelProps {
  sessionId: string | null;
  compact?: boolean;
  showHeader?: boolean;
  onSessionCreated?: (id: string) => void;
  className?: string;
}

export function ChatPanel({
  sessionId,
  compact = false,
  showHeader = true,
  onSessionCreated,
  className,
}: ChatPanelProps) {
  const toast = useToast();
  const view = useChatStore((state) => (sessionId ? state.views[sessionId] : undefined));
  const summary = useChatStore((state) =>
    sessionId ? state.sessions.find((item) => item.id === sessionId) : undefined
  );
  const assistants = useChatStore((state) => state.assistants);
  const globalAssistant = useChatStore((state) => state.currentAssistant);
  const globalCwd = useChatStore((state) => state.cwd);
  const createSession = useChatStore((state) => state.createSession);
  const loadSession = useChatStore((state) => state.loadSession);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const abort = useChatStore((state) => state.abort);
  const switchAssistant = useChatStore((state) => state.switchAssistant);
  const removeQueued = useChatStore((state) => state.removeQueued);
  const clearQueue = useChatStore((state) => state.clearQueue);
  const attachStream = useChatStore((state) => state.attachStream);
  const setCwd = useChatStore((state) => state.setCwd);

  const [newCwd, setNewCwd] = useState(globalCwd);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);

  const nodeRuns = useNodeStore((state) => state.runs);
  const nodeRunsLoaded = useNodeStore((state) => state.initialized);
  const loadNodeRuns = useNodeStore((state) => state.load);
  const mergeToSession = useNodeStore((state) => state.mergeToSession);
  const [mergeRun, setMergeRun] = useState<LocalNodeRun | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [patchDeployOpen, setPatchDeployOpen] = useState(false);
  const edition = useAppStore((state) => state.edition);

  const assistant = view?.assistant || summary?.assistant || globalAssistant;
  const streaming = view?.streaming ?? summary?.isStreaming ?? false;
  const cwd = view?.cwd || summary?.cwd || '';
  // 当前会话对应的开发版智能开发任务（合并按钮只在这类会话里出现）。
  const deviceRun = sessionId
    ? nodeRuns.find(
        (run) => run.session_id === sessionId && (run.edition || 'dev') === 'dev'
      )
    : undefined;
  // 当前会话对应的智能开发任务（开发版/实施版都算），用于「打开产物所在位置」。
  const taskRun = sessionId ? nodeRuns.find((run) => run.session_id === sessionId) : undefined;
  // 智能分析（workflow）的本地步骤没有 node run，产物目录由执行器登记在这里。
  const workflowSession = useWorkflowSessionStore((state) =>
    sessionId ? state.artifacts[sessionId] : undefined
  );
  const workflowArtifactDir = workflowSession?.dir || '';
  // 聊天页只展示表单里填写的问题/业务需求，不展示拼好的长提示词。
  const displayUserPrompt = String(
    taskRun?.problem_desc || workflowSession?.display_prompt || ''
  ).trim();
  // 顶栏内置浏览器的默认地址：优先调试地址，其次录制页面，最后触发入口。
  const setBrowserDefaultUrl = useBrowserStore((state) => state.setDefaultUrl);
  useEffect(() => {
    const env = (taskRun?.env_snapshot || {}) as Record<string, unknown>;
    const url = String(env.debug_address || env.record_url || taskRun?.trigger_url || '').trim();
    setBrowserDefaultUrl(url);
  }, [taskRun, setBrowserDefaultUrl]);
  const runArtifactDir = String(
    taskRun?.turn_dir || taskRun?.step_dir || taskRun?.out_dir || ''
  ).trim();
  // 实施版「创建排查任务」走的是 NewTaskDialog，不一定有 run 记录：
  // 它的会话 cwd 固定是 temp/node/<runId>，产物目录就是它下面的 step01。
  const noviceTaskDir = (() => {
    if (runArtifactDir || edition !== 'novice') return '';
    const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!/\/temp\/node\/[^/]+$/i.test(normalized)) return '';
    return `${normalized}/step01`;
  })();
  const artifactDir = runArtifactDir || workflowArtifactDir || noviceTaskDir;
  const nodeStreaming = useNodeStore((state) =>
    deviceRun ? Boolean(state.streaming[deviceRun.id]) : false
  );

  useEffect(() => {
    if (!nodeRunsLoaded) void loadNodeRuns().catch(() => {});
  }, [nodeRunsLoaded, loadNodeRuns]);

  useEffect(() => {
    if (!sessionId) return;
    if (!view?.loaded) {
      void loadSession(sessionId).then(() => attachStream(sessionId));
    } else if (streaming) {
      attachStream(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 智能开发创建后立刻跳转过来的会话：run 已在执行，但后端会话摘要可能还没标成 streaming，
  // 这里按 run 的执行状态强制接上事件流，避免要刷新一次页面才看到状态和输出。
  useEffect(() => {
    if (sessionId && nodeStreaming) attachStream(sessionId, true);
  }, [sessionId, nodeStreaming, attachStream]);

  const assistantOptions = useMemo(
    () =>
      (assistants.length
        ? assistants
        : [{ name: 'claude', display_name: 'Claude Code', is_default: true, available: true }]
      ).map((item) => ({
        value: item.name,
        label: `${item.display_name || assistantLabel(item.name)}${
          item.available === false ? '（未检测到）' : ''
        }`,
        disabled: item.available === false,
      })),
    [assistants]
  );

  const handleSend = async (text: string, files: File[]) => {
    let id = sessionId;
    if (!id) {
      if (!newCwd.trim()) {
        toast.error('请先填写工作目录');
        return;
      }
      setCreating(true);
      try {
        id = await createSession({ cwd: newCwd.trim(), assistant: globalAssistant });
        setCwd(newCwd.trim());
        onSessionCreated?.(id);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '创建会话失败');
        return;
      } finally {
        setCreating(false);
      }
    }

    let payload = text;
    if (files.length) {
      const paths: string[] = [];
      for (const file of files) {
        const form = new FormData();
        form.append('file', file, file.name || 'attachment');
        try {
          const result = await api.chatAttachment(id, form, file.name);
          if (!result.success) throw new Error(result.error || '附件保存失败');
          if (result.path) paths.push(result.path);
        } catch (error) {
          toast.error(`附件「${file.name}」上传失败：${error instanceof Error ? error.message : ''}`);
          return;
        }
      }
      if (paths.length) {
        const suffix =
          '\n\n【附件】用户发送了以下文件，请先用 Read 工具查看（图片可看图，其他文件读取内容）：\n' +
          paths.map((path) => `- ${path}`).join('\n');
        payload = `${payload.replace(/\s+$/, '')}${suffix}`;
      }
    }

    try {
      await sendMessage(payload || '请查看附件', id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发送失败');
    }
  };

  const pickFolder = async () => {
    setPicking(true);
    try {
      const result = await api.pickFolder(newCwd);
      if (result.success && result.path) setNewCwd(result.path);
      else if (result.error) toast.error(result.error);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '打开目录选择器失败');
    } finally {
      setPicking(false);
    }
  };

  /* ── 空会话：欢迎页 / 新建表单 ── */
  if (!sessionId) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
        <div className="flex flex-1 flex-col items-center justify-center px-6">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/25 bg-accent-soft text-accent">
            <Sparkles size={24} />
          </div>
          <h2 className="text-[18px] font-semibold text-ink">开始新的对话</h2>
          <p className="mt-1.5 max-w-md text-center text-[13px] leading-6 text-ink-3">
            填写工作目录后直接输入问题。AI 会在该目录下读写文件、执行命令。
          </p>
          {!newCwd.trim() ? (
            <div className="mt-5 flex w-full max-w-md gap-2">
              <Input
                value={newCwd}
                onChange={(event) => setNewCwd(event.target.value)}
                placeholder="工作目录，例如 D:/projects/my-app"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                }}
              />
              <Button
                icon={picking ? <Spinner size={14} /> : <FolderOpen size={14} />}
                onClick={pickFolder}
                disabled={picking}
              >
                选择
              </Button>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-1.5 text-[11.5px] text-ink-3">
              <FolderOpen size={12} />
              <span className="max-w-md truncate font-mono">{newCwd}</span>
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => setNewCwd('')}
              >
                修改
              </button>
            </div>
          )}
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 pb-5">
          <Composer
            onSend={handleSend}
            disabled={creating || !newCwd.trim()}
            placeholder={newCwd.trim() ? '输入第一条消息…' : '请先填写工作目录'}
            autoFocus
          />
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className={cn('flex flex-1 items-center justify-center', className)}>
        <Spinner size={22} />
      </div>
    );
  }

  const title = summary?.name || summary?.firstMessage || '会话';
  // 会话流结束后才出现；不校验阶段一状态。
  const mergeAction =
    deviceRun && !streaming && !nodeStreaming ? (
      <Tooltip content="合并到客开工程">
        <button
          type="button"
          onClick={() => setMergeRun(deviceRun)}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2 transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
          aria-label="合并到客开工程"
          title="合并到客开工程"
        >
          <GitMerge size={15} />
        </button>
      </Tooltip>
    ) : null;
  // 智能开发任务（两版都算）才出现：在系统资源管理器里定位到当前 step 的产物目录。
  const openArtifactAction = artifactDir ? (
    <Tooltip content="打开产物所在位置">
      <button
        type="button"
        onClick={() => {
          void api.files
            .openFolder(artifactDir)
            .catch((error) =>
              toast.error(error instanceof Error ? error.message : '打开产物目录失败')
            );
        }}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2 transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
        aria-label="打开产物所在位置"
        title="打开产物所在位置"
      >
        <FolderOpen size={15} />
      </button>
    </Tooltip>
  ) : null;
  const patchDeployAction =
    taskRun && artifactDir && !streaming && !nodeStreaming ? (
      <Tooltip content="部署 AI 产出的补丁">
        <button
          type="button"
          onClick={() => setPatchDeployOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2 transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
          aria-label="部署补丁"
          title="部署补丁"
        >
          <PackageCheck size={15} />
        </button>
      </Tooltip>
    ) : null;
  const composerActions =
    openArtifactAction || mergeAction || patchDeployAction ? (
      <>
        {openArtifactAction}
        {mergeAction}
        {patchDeployAction}
      </>
    ) : null;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {showHeader && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-ink" title={title}>
                {title}
              </span>
              {streaming ? (
                <span className="badge badge-success shrink-0">
                  <span className="live-dot" /> LIVE
                </span>
              ) : (
                <span className="badge badge-muted shrink-0">空闲</span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-ink-3">
              <FolderOpen size={10} />
              <span className="max-w-[360px] truncate font-mono" title={cwd}>
                {cwd}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Select
              className="w-[150px]"
              value={assistant}
              onChange={(event) => {
                switchAssistant(event.target.value, sessionId).catch((error) =>
                  toast.error(error instanceof Error ? error.message : '切换助手失败')
                );
              }}
              options={assistantOptions}
              title="切换助手"
            />
          </div>
        </div>
      )}

      {view.loading && !view.loaded ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={22} />
        </div>
      ) : (
        <MessageList
          view={view}
          compact={compact}
          displayUserPrompt={displayUserPrompt}
          onSuggestion={(text) => {
            void handleSend(text, []);
          }}
        />
      )}

      <div className={cn('mx-auto w-full px-3 pb-3 sm:px-5', compact ? 'max-w-none' : 'max-w-4xl')}>
        <Composer
          onSend={handleSend}
          streaming={streaming}
          onAbort={() => void abort(sessionId)}
          queue={view.queue}
          onRemoveQueue={(index) => removeQueued(sessionId, index)}
          onClearQueue={() => clearQueue(sessionId)}
          placeholder="输入消息…"
          compact={compact}
          actions={composerActions}
          footerLeft={
            <span className="inline-flex items-center gap-1">
              <Bot size={11} />
              {assistantLabel(assistant)}
              {streaming && <WifiOff size={11} className="ml-1 opacity-60" />}
            </span>
          }
        />
      </div>

      {taskRun && sessionId && (
        <ChatPatchDeployDialog
          open={patchDeployOpen}
          sessionId={sessionId}
          run={taskRun}
          artifactDir={artifactDir}
          onClose={() => setPatchDeployOpen(false)}
        />
      )}

      {mergeRun && (
        <MergeDialog
          open
          busy={mergeBusy}
          initial={{
            stripLog: mergeRun.need_debug_log !== false,
            diffReport: mergeRun.need_diff_report !== false,
          }}
          onClose={() => {
            if (!mergeBusy) setMergeRun(null);
          }}
          onConfirm={async (options) => {
            setMergeBusy(true);
            try {
              await mergeToSession(mergeRun.id, options);
              setMergeRun(null);
            } catch (error) {
              toast.error(error instanceof Error ? error.message : '发起合并失败');
            } finally {
              setMergeBusy(false);
            }
          }}
        />
      )}
    </div>
  );
}

export function EmptyPanel({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-3">
        <MessageSquarePlus size={20} />
      </div>
      <div className="text-[13px] font-medium text-ink-2">空面板</div>
      <Button variant="primary" size="sm" onClick={onNew}>
        新建会话
      </Button>
    </div>
  );
}
