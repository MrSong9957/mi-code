// src/tui/streaming/streaming-markdown.tsx
// 流式 Markdown 增量渲染（charter §核心模块 3.2）
//
// 物理本质：流式输出的「滑动窗口缓存」。
// 大模型逐 token 吐文本。若每次都用 marked.lexer 解析整段，长输出会卡。
// 按「最后一个 \n」把累积文本切成两段：
//   - stableText（末尾 \n 之前，含 \n）：行已结束，不会变 → useMemo 缓存渲染结果
//   - tailText（末尾 \n 之后）：当前未换行的尾巴，每次都可能变 → 实时渲染
//
// 性能：1000 token 的长文，每次只有末行重渲染，前 N-1 行命中缓存。
// 防御：marked 对未闭合标记（** / ` / ```）可能抛或产出异常 token，用 try/catch 降级。

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { renderMarkdown } from '../markdown/render-markdown.js';

export interface StreamingMarkdownProps {
  text: string;
}

/** 安全渲染 markdown：marked 解析失败时降级为纯文本 */
function safeRender(md: string, keyPrefix: string): React.ReactNode {
  if (md === '') return null;
  try {
    return renderMarkdown(md);
  } catch {
    return React.createElement(Text, { key: `${keyPrefix}-fallback` }, md);
  }
}

export function StreamingMarkdown({ text }: StreamingMarkdownProps): React.ReactElement {
  // 按最后一个 \n 切分
  const lastNewlineIdx = text.lastIndexOf('\n');

  const { stableText, tailText } = useMemo(() => {
    if (lastNewlineIdx < 0) {
      return { stableText: '', tailText: text };
    }
    return {
      stableText: text.slice(0, lastNewlineIdx + 1), // 含末尾 \n
      tailText: text.slice(lastNewlineIdx + 1),
    };
  }, [text, lastNewlineIdx]);

  // 稳定段：仅 stableText 变化时才重新渲染（useMemo 缓存）
  const stableRendered = useMemo(() => {
    return safeRender(stableText, 'stable');
  }, [stableText]);

  // 末尾段：每次重渲染（文本在变）
  const tailRendered = safeRender(tailText, 'tail');

  return React.createElement(Box, { flexDirection: 'column' }, stableRendered, tailRendered);
}
