import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { cn } from '../lib/utils';

marked.setOptions({
  gfm: true,
  breaks: true,
});

// 新窗口打开外链，避免把工作台顶掉
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(text: string): string {
  if (!text) return '';
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
}

export function Markdown({
  text,
  className,
  streaming = false,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
}) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={cn('md', streaming && 'stream-caret', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
