import { useState, type ReactNode } from 'react';
import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { ContentBlock } from '../../lib/types';
import { cn } from '../../lib/utils';
import { Markdown } from '../Markdown';
import { ResultBox } from '../ResultBox';

function Collapsible({
  title,
  icon,
  meta,
  children,
  defaultOpen = false,
  tone = 'default',
}: {
  title: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  tone?: 'default' | 'success' | 'danger';
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-xl border',
        tone === 'success' && 'border-success/25 bg-success-soft/40',
        tone === 'danger' && 'border-danger/25 bg-danger-soft/40',
        tone === 'default' && 'border-line bg-surface-2/70'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-surface-3/60"
      >
        <ChevronRight
          size={13}
          className={cn('shrink-0 text-ink-3 transition-transform', open && 'rotate-90')}
        />
        <span
          className={cn(
            'shrink-0',
            tone === 'success' && 'text-success',
            tone === 'danger' && 'text-danger',
            tone === 'default' && 'text-ink-3'
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {meta && <span className="shrink-0 text-[11.5px] text-ink-3">{meta}</span>}
      </button>
      {open && children && (
        <div className="border-t border-line/70 px-3 py-2.5 text-[12.5px]">{children}</div>
      )}
    </div>
  );
}

function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const data = input as Record<string, unknown>;
  const candidate =
    (data.command as string) ||
    (data.file_path as string) ||
    (data.path as string) ||
    (data.pattern as string) ||
    (data.url as string) ||
    (data.query as string) ||
    (data.description as string);
  if (typeof candidate === 'string' && candidate.trim()) return candidate;
  return name;
}

export function ThinkingBlock({ text }: { text: string }) {
  return (
    <Collapsible
      title="思考过程"
      icon={<Brain size={13} />}
      meta={`${text.length} 字符`}
    >
      <div className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-5 text-ink-3">
        {text}
      </div>
    </Collapsible>
  );
}

export function ToolUseBlock({
  name,
  input,
}: {
  name: string;
  input: unknown;
}) {
  const summary = toolSummary(name, input);
  const isBash = /bash|shell|terminal/i.test(name);
  const inputText =
    typeof input === 'string' ? input : JSON.stringify(input ?? {}, null, 2);
  return (
    <Collapsible
      title={summary}
      icon={isBash ? <Terminal size={13} /> : <Wrench size={13} />}
      meta={isBash ? '命令' : name}
    >
      <ResultBox content={inputText} maxHeight="max-h-80" />
    </Collapsible>
  );
}

export function ToolResultBlock({ content }: { content: string }) {
  const failed = /(^|\n)\s*(error|错误|failed|exception|traceback)/i.test(content.slice(0, 800));
  return (
    <Collapsible
      title={failed ? '执行结果 · 可能有错误' : '执行结果'}
      icon={failed ? <CircleAlert size={13} /> : <Check size={13} />}
      tone={failed ? 'danger' : 'success'}
      meta={`${content.length} 字符`}
    >
      <ResultBox
        content={content.length > 20000 ? `${content.slice(0, 20000)}\n\n…（已截断）` : content}
        maxHeight="max-h-96"
      />
    </Collapsible>
  );
}

export function TextBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  return <Markdown text={text} streaming={streaming} />;
}

export function ContentBlocks({
  blocks,
  streaming = false,
}: {
  blocks: ContentBlock[];
  streaming?: boolean;
}) {
  const lastTextIndex = (() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (blocks[i].type === 'text') return i;
    }
    return -1;
  })();

  return (
    <div className="space-y-1">
      {blocks.map((block, index) => {
        if (block.type === 'thinking') {
          return <ThinkingBlock key={`thinking-${index}`} text={block.thinking} />;
        }
        if (block.type === 'tool_use') {
          return <ToolUseBlock key={`tool-${block.id || index}`} name={block.name} input={block.input} />;
        }
        if (block.type === 'tool_result') {
          return (
            <ToolResultBlock
              key={`result-${block.tool_use_id || index}`}
              content={block.content}
            />
          );
        }
        return (
          <TextBlock
            key={`text-${index}`}
            text={block.text}
            streaming={streaming && index === lastTextIndex}
          />
        );
      })}
    </div>
  );
}

export function FileAttachmentChip({ path }: { path: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface-3 px-2 py-1 text-[11.5px] text-ink-2">
      <FileText size={12} className="shrink-0 text-ink-3" />
      <span className="truncate">{path.split(/[\\/]/).pop()}</span>
    </span>
  );
}
