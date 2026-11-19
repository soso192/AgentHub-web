import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  open: controlledOpen,
  onOpenChange,
  tone = 'default',
}: {
  title: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  tone?: 'default' | 'success' | 'danger';
}) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const open = controlledOpen ?? innerOpen;
  const toggle = () => {
    const next = !open;
    if (controlledOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
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
        onClick={toggle}
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
      title="思考"
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

type TextContentBlock = Extract<ContentBlock, { type: 'text' }>;
type ProcessContentBlock = Exclude<ContentBlock, { type: 'text' }>;

interface BlockRound {
  key: string;
  process: ProcessContentBlock[];
  text?: TextContentBlock;
}

function blockKey(block: ContentBlock, index: number): string {
  if (block.type === 'tool_use') return `tool-${block.id || index}-${index}`;
  if (block.type === 'tool_result') return `result-${block.tool_use_id || index}-${index}`;
  if (block.type === 'thinking') return `thinking-${index}`;
  return `text-${index}`;
}

/** 以文本输出为界，把一段助手消息拆成「过程 + 输出」的轮次。 */
function groupBlocks(blocks: ContentBlock[]): BlockRound[] {
  const rounds: BlockRound[] = [];
  let current: BlockRound = { key: '', process: [] };
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!current.key) current.key = blockKey(block, index);
    if (block.type === 'text') {
      current.text = block;
      rounds.push(current);
      current = { key: '', process: [] };
    } else {
      current.process.push(block);
    }
  }
  if (current.key || current.process.length) rounds.push(current);
  return rounds;
}

function processStats(blocks: ProcessContentBlock[]) {
  let thinking = 0;
  let tools = 0;
  for (const block of blocks) {
    if (block.type === 'thinking') thinking += 1;
    else if (block.type === 'tool_use') tools += 1;
  }
  return { thinking, tools };
}

function processMeta(blocks: ProcessContentBlock[]): string {
  const { thinking, tools } = processStats(blocks);
  const parts: string[] = [];
  if (thinking > 0) parts.push(`${thinking} 段思考`);
  if (tools > 0) parts.push(`${tools} 次工具`);
  return parts.join(' · ');
}

function outputPreview(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`#>*_~\[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 72) || '过程与输出'
  );
}

function ProcessList({ blocks }: { blocks: ProcessContentBlock[] }) {
  return (
    <div className="space-y-1.5">
      {blocks.map((block, index) => {
        if (block.type === 'thinking') {
          return <ThinkingBlock key={blockKey(block, index)} text={block.thinking} />;
        }
        if (block.type === 'tool_use') {
          return (
            <ToolUseBlock
              key={blockKey(block, index)}
              name={block.name}
              input={block.input}
            />
          );
        }
        return (
          <ToolResultBlock
            key={blockKey(block, index)}
            content={block.content}
          />
        );
      })}
    </div>
  );
}

function ProcessGroup({
  blocks,
  active,
}: {
  blocks: ProcessContentBlock[];
  active: boolean;
}) {
  const [open, setOpen] = useState(active);
  useEffect(() => {
    // 当前阶段自动展开；文本输出出现后（active=false）立即折叠。
    setOpen(active);
  }, [active]);

  return (
    <Collapsible
      title={active ? '正在思考和处理…' : '思考与处理过程'}
      icon={<Brain size={13} />}
      meta={processMeta(blocks)}
      open={open}
      onOpenChange={setOpen}
    >
      <div className={cn(active ? 'pr-1' : 'max-h-[70vh] overflow-auto pr-1')}>
        <ProcessList blocks={blocks} />
      </div>
    </Collapsible>
  );
}

function CollapsedRound({ round }: { round: BlockRound }) {
  const preview = outputPreview(round.text?.text || '');
  return (
    <Collapsible
      title={`已折叠 · ${preview}`}
      icon={<FileText size={13} />}
      meta={processMeta(round.process)}
    >
      <div className="max-h-[70vh] space-y-2 overflow-auto pr-1">
        {round.process.length > 0 && <ProcessList blocks={round.process} />}
        {round.text && (
          <div className="rounded-lg border border-line/70 bg-surface/60 px-3 py-2">
            <TextBlock text={round.text.text} />
          </div>
        )}
      </div>
    </Collapsible>
  );
}

export function ContentBlocks({
  blocks,
  streaming = false,
}: {
  blocks: ContentBlock[];
  streaming?: boolean;
}) {
  const rounds = useMemo(() => groupBlocks(blocks), [blocks]);
  let lastTextIndex = -1;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (rounds[index].text) {
      lastTextIndex = index;
      break;
    }
  }

  return (
    <div className="space-y-1">
      {rounds.map((round, index) => {
        // 只保留最后一段文本输出可见；它之前的「过程 + 文本」全部折叠。
        if (lastTextIndex >= 0 && index < lastTextIndex) {
          return <CollapsedRound key={round.key} round={round} />;
        }
        // 最后一段文本之后可能还有工具调用；最后文本继续显示，后续过程实时展开。
        if (lastTextIndex >= 0 && index === lastTextIndex) {
          return (
            <div key={round.key}>
              {round.process.length > 0 && (
                <ProcessGroup blocks={round.process} active={false} />
              )}
              {round.text && (
                <TextBlock text={round.text.text} streaming={streaming} />
              )}
            </div>
          );
        }
        // 没有文本输出，或最后文本之后的纯过程：最新一段在流式时展开。
        return (
          <ProcessGroup
            key={round.key}
            blocks={round.process}
            active={streaming && index === rounds.length - 1}
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
