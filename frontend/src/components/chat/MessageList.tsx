import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, MessageSquarePlus, Sparkles } from 'lucide-react';
import type { ChatView } from '../../store/chat';
import { cn } from '../../lib/utils';
import { MessageItem, StreamingMessage } from './MessageItem';

interface TurnAnchor {
  id: string;
  text: string;
}

function cleanTurnText(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`#>*_~[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || '用户提问'
  );
}

function clipTurnText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}...` : text;
}

export function MessageList({
  view,
  compact = false,
  displayUserPrompt = '',
  onSuggestion,
}: {
  view: ChatView;
  compact?: boolean;
  /** 智能开发/智能分析任务只展示表单里填写的问题描述，不展示拼接后的完整提示词。 */
  displayUserPrompt?: string;
  onSuggestion?: (text: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const railCloseTimer = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [detail, setDetail] = useState<{ text: string; left: number; top: number } | null>(null);

  const displayMessages = useMemo(() => {
    if (!displayUserPrompt) return view.messages;
    let replaced = false;
    return view.messages.map((message) => {
      if (!replaced && message.role === 'user') {
        replaced = true;
        return { ...message, content: displayUserPrompt };
      }
      return message;
    });
  }, [view.messages, displayUserPrompt]);

  const turns = useMemo<TurnAnchor[]>(
    () =>
      displayMessages
        .map((message, index) =>
          message.role === 'user'
            ? {
                id: `turn-${index}-${message.timestamp}`,
                text: cleanTurnText(message.display_content || message.content || ''),
              }
            : null
        )
        .filter((turn): turn is TurnAnchor => Boolean(turn)),
    [displayMessages]
  );

  // 轨道最多 10 个点，均匀采样全部提问（包含第一条和最后一条）。
  const railTurns = useMemo<TurnAnchor[]>(() => {
    if (turns.length <= 10) return turns;
    return Array.from({ length: 10 }, (_, index) =>
      turns[Math.round((index * (turns.length - 1)) / 9)]
    );
  }, [turns]);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  };

  const updateActiveTurn = () => {
    const node = scrollerRef.current;
    if (!node) return;
    const anchors = Array.from(node.querySelectorAll<HTMLElement>('[data-turn-id]'));
    if (!anchors.length) {
      setActiveTurn(null);
      return;
    }
    const top = node.getBoundingClientRect().top;
    let current = anchors[0].dataset.turnId || null;
    for (const anchor of anchors) {
      if (anchor.getBoundingClientRect().top - top <= 80) {
        current = anchor.dataset.turnId || current;
      } else {
        break;
      }
    }
    setActiveTurn(current);
  };

  const jumpToTurn = (turnId: string) => {
    const node = scrollerRef.current;
    if (!node) return;
    const anchor = Array.from(node.querySelectorAll<HTMLElement>('[data-turn-id]')).find(
      (item) => item.dataset.turnId === turnId
    );
    anchor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveTurn(turnId);
    setRailOpen(false);
    setDetail(null);
  };

  const openRail = () => {
    if (railCloseTimer.current) {
      window.clearTimeout(railCloseTimer.current);
      railCloseTimer.current = null;
    }
    setRailOpen(true);
  };

  const closeRail = () => {
    if (railCloseTimer.current) window.clearTimeout(railCloseTimer.current);
    railCloseTimer.current = window.setTimeout(() => {
      setRailOpen(false);
      setDetail(null);
      railCloseTimer.current = null;
    }, 180);
  };

  const showDetail = (turn: TurnAnchor, event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const popupRect = popupRef.current?.getBoundingClientRect();
    const left = Math.max(8, (popupRect?.left ?? rect.left) - 272);
    const top = Math.max(40, Math.min(window.innerHeight - 40, rect.top + rect.height / 2));
    setDetail({
      text: clipTurnText(turn.text, 100),
      left,
      top,
    });
  };

  useEffect(() => {
    return () => {
      if (railCloseTimer.current) window.clearTimeout(railCloseTimer.current);
    };
  }, []);

  useEffect(() => {
    if (atBottom) scrollToBottom('auto');
  }, [view.messages.length, view.liveBlocks, view.streaming, atBottom]);

  useEffect(() => {
    // 切换会话时直接落到底部
    scrollToBottom('auto');
  }, [view.sessionId]);

  const onScroll = () => {
    const node = scrollerRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setAtBottom(distance < 80);
    updateActiveTurn();
  };

  useEffect(() => {
    const frame = requestAnimationFrame(updateActiveTurn);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.messages.length, view.sessionId]);

  const isEmpty =
    !view.loading && view.messages.length === 0 && !view.streaming && view.liveBlocks.length === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="scroll-area h-full px-3 py-4 sm:px-5"
      >
        <div className={cn('mx-auto w-full', compact ? 'max-w-none' : 'max-w-4xl')}>
          {isEmpty ? (
            <div className="flex min-h-[46vh] flex-col items-center justify-center px-4 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/25 bg-accent-soft text-accent">
                <Sparkles size={24} />
              </div>
              <h2 className="text-[18px] font-semibold text-ink">开始新的对话</h2>
              <p className="mt-1.5 max-w-md text-[13px] leading-6 text-ink-3">
                直接输入问题开始。可以让我读代码、跑命令、排查报错，也可以同时开多个面板并行处理不同任务。
              </p>
              {onSuggestion && (
                <div className="mt-5 flex max-w-lg flex-wrap justify-center gap-2">
                  {[
                    '帮我看看这个项目是做什么的',
                    '检查当前工作目录的代码质量',
                    '帮我排查一个报错',
                    '生成一份实施方案',
                  ].map((text) => (
                    <button
                      key={text}
                      type="button"
                      onClick={() => onSuggestion(text)}
                      className="rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
                    >
                      {text}
                    </button>
                  ))}
                </div>
              )}
              {!view.sessionId && (
                <div className="mt-4 flex items-center gap-1.5 text-[11.5px] text-ink-3">
                  <MessageSquarePlus size={13} />
                  先在左侧填写工作目录并新建会话
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1 pb-2">
              {displayMessages.map((message, index) => (
                <MessageItem
                  key={`${message.timestamp}-${index}`}
                  message={message}
                  assistant={view.assistant}
                  turnId={message.role === 'user' ? `turn-${index}-${message.timestamp}` : undefined}
                />
              ))}
              {(view.streaming || view.liveBlocks.length > 0 || view.error) && (
                <StreamingMessage
                  blocks={view.liveBlocks}
                  assistant={view.assistant}
                  error={view.error}
                  streaming={view.streaming}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {turns.length > 0 && (
        <div
          className="absolute right-1.5 top-1/2 z-30 -translate-y-1/2"
          onMouseEnter={openRail}
          onMouseLeave={closeRail}
        >
          <div className="flex flex-col items-center gap-2" aria-label="用户提问导航">
            {railTurns.map((turn, index) => (
              <button
                key={turn.id}
                type="button"
                title={clipTurnText(turn.text, 15)}
                aria-label={`跳转到第 ${index + 1} 个用户提问：${clipTurnText(turn.text, 15)}`}
                aria-current={activeTurn === turn.id ? 'true' : undefined}
                onClick={() => jumpToTurn(turn.id)}
                className={cn(
                  'rounded-full transition-all duration-150',
                  activeTurn === turn.id
                    ? 'h-3 w-3 shadow-[0_0_0_3px_var(--accent-soft)]'
                    : 'h-2.5 w-2.5 hover:h-3 hover:w-3 hover:opacity-80'
                )}
                style={{
                  backgroundColor:
                    activeTurn === turn.id ? 'var(--turn-dot-active)' : 'var(--turn-dot)',
                }}
              />
            ))}
          </div>

          {railOpen && (
            <div
              ref={popupRef}
              onMouseEnter={openRail}
              onMouseLeave={closeRail}
              className="absolute right-full top-1/2 mr-2 max-h-72 w-60 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-surface-2 p-1.5 shadow-pop"
            >
              <div className="px-2 py-1 text-[10.5px] font-medium text-ink-3">用户提问导航</div>
              {turns.map((turn, index) => (
                <button
                  key={turn.id}
                  type="button"
                  onMouseEnter={(event) => showDetail(turn, event)}
                  onMouseLeave={() => setDetail(null)}
                  onClick={() => jumpToTurn(turn.id)}
                  className={cn(
                    'block w-full truncate rounded-lg px-2 py-1.5 text-left text-[11.5px] transition-colors',
                    activeTurn === turn.id
                      ? 'bg-accent-soft text-accent'
                      : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
                  )}
                  title={clipTurnText(turn.text, 15)}
                >
                  {index + 1}. {clipTurnText(turn.text, 15)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {detail &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[80] w-64 -translate-y-1/2 rounded-lg border border-white/10 bg-[#1f2329] px-3 py-2 text-[11.5px] leading-5 text-white shadow-pop"
            style={{ left: detail.left, top: detail.top }}
          >
            {detail.text}
          </div>,
          document.body
        )}

      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            setAtBottom(true);
            scrollToBottom();
          }}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[11.5px] text-ink-2 shadow-pop transition-colors hover:text-ink"
        >
          <ArrowDown size={13} />
          回到最新
        </button>
      )}
    </div>
  );
}
