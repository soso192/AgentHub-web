import { useState } from 'react';
import { Bot, Check, Copy, User } from 'lucide-react';
import type { Message } from '../../lib/types';
import { assistantLabel, cn, formatTime } from '../../lib/utils';
import { Markdown } from '../Markdown';
import { ContentBlocks } from './ContentBlocks';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="复制消息"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="rounded-md p-1 text-ink-3 opacity-0 transition-opacity hover:bg-surface-3 hover:text-ink group-hover:opacity-100"
    >
      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
    </button>
  );
}

export function MessageItem({
  message,
  assistant,
  streaming = false,
}: {
  message: Message;
  assistant?: string;
  streaming?: boolean;
}) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const label = assistantLabel(message.assistant || assistant);
  const hasBlocks = Boolean(message.content_blocks?.length);

  if (isSystem) {
    return (
      <div className="my-3 flex items-center gap-3 text-[11.5px] text-ink-3">
        <div className="h-px flex-1 bg-line" />
        <span className="max-w-[70%] truncate text-center">{message.content}</span>
        <div className="h-px flex-1 bg-line" />
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="group flex justify-end gap-2.5 px-1 py-1.5">
        <div className="flex max-w-[82%] flex-col items-end gap-1">
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-md border border-line bg-[var(--user-bg)] px-4 py-2.5 text-[13.5px] leading-6 text-ink">
            {message.content}
          </div>
          <div className="flex items-center gap-1 pr-1 text-[10.5px] text-ink-3">
            <span>{formatTime(message.timestamp)}</span>
            <CopyButton text={message.content} />
          </div>
        </div>
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-3">
          <User size={14} />
        </div>
      </div>
    );
  }

  return (
    <div className="group flex gap-2.5 px-1 py-1.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-accent-soft text-accent">
        <Bot size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink-2">{label}</span>
          <span className="text-[10.5px] text-ink-3">{formatTime(message.timestamp)}</span>
          <CopyButton text={message.content} />
        </div>
        <div className={cn('min-w-0 text-ink', streaming && 'pb-1')}>
          {hasBlocks ? (
            <ContentBlocks blocks={message.content_blocks!} streaming={streaming} />
          ) : (
            <Markdown text={message.content} streaming={streaming} />
          )}
        </div>
      </div>
    </div>
  );
}

export function StreamingMessage({
  blocks,
  assistant,
  error,
  streaming = true,
}: {
  blocks: import('../../lib/types').ContentBlock[];
  assistant?: string;
  error?: string;
  streaming?: boolean;
}) {
  return (
    <div className="flex gap-2.5 px-1 py-1.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-accent-soft text-accent">
        <Bot size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink-2">{assistantLabel(assistant)}</span>
          {streaming ? (
            <span className="inline-flex items-center gap-1.5 text-[10.5px] text-success">
              <span className="live-dot" />
              正在生成
            </span>
          ) : error ? (
            <span className="text-[10.5px] text-danger">执行出错</span>
          ) : null}
        </div>
        {blocks.length ? (
          <ContentBlocks blocks={blocks} streaming={streaming} />
        ) : streaming ? (
          <div className="flex items-center gap-1.5 py-1 text-[13px] text-ink-3">
            <span className="typing-dots inline-flex items-center gap-1">
              <i className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-ink-3" />
              <i className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-ink-3 [animation-delay:150ms]" />
              <i className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-ink-3 [animation-delay:300ms]" />
            </span>
            正在思考…
          </div>
        ) : null}
        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
