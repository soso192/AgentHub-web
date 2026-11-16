import { useMemo, useState } from 'react';
import { MessageSquarePlus, Plus, SendHorizontal, X } from 'lucide-react';
import {
  LAYOUT_SLOTS,
  useChatStore,
} from '../../store/chat';
import { assistantLabel, cn } from '../../lib/utils';
import { IconButton, Tooltip } from '../ui';
import { ChatPanel } from './ChatPanel';

const GRID_STYLES: Record<string, React.CSSProperties> = {
  '1x1': { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' },
  '2x1': { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr' },
  '1x2': { gridTemplateColumns: '1fr', gridTemplateRows: '1fr 1fr' },
  '2x2': { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' },
  '3x2': { gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr' },
  '3x3': { gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr 1fr' },
};

function SyncBar() {
  const [text, setText] = useState('');
  const sendSync = useChatStore((state) => state.sendSync);
  return (
    <div className="flex items-center gap-2 border-b border-line bg-accent-soft/30 px-3 py-2">
      <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
        同步发送
      </span>
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (text.trim()) {
              void sendSync(text.trim());
              setText('');
            }
          }
        }}
        placeholder="一条消息同时发送到所有面板…"
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent/50"
      />
      <IconButton
        label="发送到所有面板"
        className="h-8 w-8 bg-accent text-white hover:bg-accent-hover hover:text-white"
        onClick={() => {
          if (text.trim()) {
            void sendSync(text.trim());
            setText('');
          }
        }}
      >
        <SendHorizontal size={14} />
      </IconButton>
    </div>
  );
}

export function SplitView() {
  const layout = useChatStore((state) => state.layout);
  const panels = useChatStore((state) => state.panels);
  const activePanelId = useChatStore((state) => state.activePanelId);
  const sessions = useChatStore((state) => state.sessions);
  const syncMode = useChatStore((state) => state.syncMode);
  const setActivePanel = useChatStore((state) => state.setActivePanel);
  const setPanelSession = useChatStore((state) => state.setPanelSession);
  const removePanel = useChatStore((state) => state.removePanel);
  const addPanel = useChatStore((state) => state.addPanel);

  const slots = LAYOUT_SLOTS[layout];
  const visible = panels.slice(0, slots);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {syncMode && <SyncBar />}
      <div
        className="grid min-h-0 flex-1 gap-2 overflow-hidden p-2"
        style={GRID_STYLES[layout]}
      >
        {visible.map((panel) => {
          const summary = panel.sessionId
            ? sessions.find((item) => item.id === panel.sessionId)
            : undefined;
          const title = summary?.name || summary?.firstMessage || '新面板';
          const active = panel.id === activePanelId;
          return (
            <div
              key={panel.id}
              onMouseDown={() => setActivePanel(panel.id)}
              className={cn(
                'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-surface transition-colors',
                active ? 'border-accent/45 shadow-[0_0_0_1px_var(--accent-soft)]' : 'border-line'
              )}
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2/70 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink-2">
                  {title}
                </span>
                {summary && (
                  <span className="badge badge-muted shrink-0">
                    {assistantLabel(summary.assistant)}
                  </span>
                )}
                {summary?.isStreaming && <span className="live-dot shrink-0" />}
                <Tooltip content="移除面板">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      removePanel(panel.id);
                    }}
                    className="rounded p-1 text-ink-3 hover:bg-danger-soft hover:text-danger"
                  >
                    <X size={12} />
                  </button>
                </Tooltip>
              </div>
              <ChatPanel
                sessionId={panel.sessionId}
                compact
                showHeader={false}
                onSessionCreated={(id) => setPanelSession(panel.id, id)}
              />
            </div>
          );
        })}

        {visible.length < slots && (
          <button
            type="button"
            onClick={addPanel}
            className="flex min-h-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface-2/30 text-ink-3 transition-colors hover:border-accent/40 hover:bg-accent-soft/20 hover:text-accent"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface-2">
              <Plus size={18} />
            </span>
            <span className="text-[12px]">添加面板</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function SplitEmptyHint() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-ink-3">
      <MessageSquarePlus size={22} />
      <span className="text-[13px]">选择布局后添加面板，即可并行运行多个会话</span>
    </div>
  );
}
