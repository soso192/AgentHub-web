import { useEffect, useRef, useState } from 'react';
import { ArrowDown, MessageSquarePlus, Sparkles } from 'lucide-react';
import type { ChatView } from '../../store/chat';
import { cn } from '../../lib/utils';
import { MessageItem, StreamingMessage } from './MessageItem';

export function MessageList({
  view,
  compact = false,
  onSuggestion,
}: {
  view: ChatView;
  compact?: boolean;
  onSuggestion?: (text: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  };

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
  };

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
              {view.messages.map((message, index) => (
                <MessageItem
                  key={`${message.timestamp}-${index}`}
                  message={message}
                  assistant={view.assistant}
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
