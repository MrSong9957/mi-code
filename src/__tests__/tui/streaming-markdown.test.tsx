// src/__tests__/tui/streaming-markdown.test.tsx
// StreamingMarkdown：流式增量渲染（charter §核心模块 3.2）
//
// 物理本质：流式输出的「滑动窗口缓存」。
// 大模型逐 token 吐文本，若每次都重新 marked.lexer 整段会卡顿。
// 按「最后一个 \n」分两段：
//   - 前置稳定段（已结束的行）：useMemo 缓存，文本不变就不重渲染
//   - 末尾不稳定段（未换行的尾巴）：每次重渲染
// 大幅降低长流式输出的渲染开销。

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Box } from 'ink';
import { StreamingMarkdown } from '../../tui/streaming/streaming-markdown.js';

function renderToText(text: string): string {
  const { lastFrame } = render(React.createElement(Box, {}, React.createElement(StreamingMarkdown, { text })));
  return lastFrame() ?? '';
}

describe('StreamingMarkdown（流式分段渲染）', () => {
  it('纯文本（无换行）：整体作为不稳定段渲染', () => {
    expect(renderToText('hello world')).toContain('hello world');
  });

  it('多行：每行内容都渲染', () => {
    const out = renderToText('第一行\n第二行\n第三行');
    expect(out).toContain('第一行');
    expect(out).toContain('第二行');
    expect(out).toContain('第三行');
  });

  it('流式累加：末行逐步增长，完整内容始终可见', () => {
    // 模拟流式：text 逐步增长
    const r1 = render(React.createElement(Box, {}, React.createElement(StreamingMarkdown, { text: '# T\n正文**粗' })));
    const r2 = render(React.createElement(Box, {}, React.createElement(StreamingMarkdown, { text: '# T\n正文**粗体**' })));
    const r3 = render(React.createElement(Box, {}, React.createElement(StreamingMarkdown, { text: '# T\n正文**粗体**\n`code`' })));
    // 最终态含全部内容
    const final = r3.lastFrame() ?? '';
    expect(final).toContain('T');
    expect(final).toContain('粗体');
    expect(final).toContain('code');
    // 中间态不含未到的内容
    expect(r1.lastFrame() ?? '').not.toContain('code');
    expect(r2.lastFrame() ?? '').not.toContain('code');
  });

  it('空字符串：无输出（不崩）', () => {
    expect(() => renderToText('')).not.toThrow();
  });

  it('未闭合 markdown 标记：不崩（降级显示原始文本）', () => {
    // ** 未闭合、` 未闭合——marked 可能解析异常，应优雅降级
    expect(() => renderToText('未闭合 **粗体')).not.toThrow();
    expect(() => renderToText('未闭合 `代码')).not.toThrow();
    expect(renderToText('未闭合 **粗体')).toContain('粗体');
  });

  it('代码块流式：未闭合 ``` 不崩', () => {
    expect(() => renderToText('```ts\nconst x = 1;')).not.toThrow();
    expect(renderToText('```ts\nconst x = 1;')).toContain('const x = 1;');
  });
});
