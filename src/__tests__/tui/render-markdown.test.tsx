// src/__tests__/tui/render-markdown.test.tsx
// renderMarkdown：markdown 文本 → Ink <Text> 树（charter §核心模块 3）

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Box } from 'ink';
import { renderMarkdown } from '../../tui/markdown/render-markdown.js';

/** 把 renderMarkdown 结果渲染成纯文本帧（提取可见内容） */
function renderToText(md: string): string {
  const { lastFrame } = render(React.createElement(Box, {}, renderMarkdown(md)));
  return lastFrame() ?? '';
}

describe('renderMarkdown（静态 markdown → Ink）', () => {
  it('纯文本：原样输出', () => {
    expect(renderToText('hello world')).toContain('hello world');
  });

  it('标题 # ：渲染文本（含 H1 内容）', () => {
    const out = renderToText('# 标题');
    expect(out).toContain('标题');
  });

  it('粗体 **text**：渲染文本内容', () => {
    const out = renderToText('这是 **粗体** 文本');
    expect(out).toContain('粗体');
    expect(out).toContain('这是');
  });

  it('斜体 *text*：渲染文本内容', () => {
    const out = renderToText('这是 *斜体* 文本');
    expect(out).toContain('斜体');
  });

  it('行内代码 `code`：渲染代码内容', () => {
    const out = renderToText('使用 `npm test` 跑测试');
    expect(out).toContain('npm test');
  });

  it('代码块：渲染多行代码内容', () => {
    const md = '```ts\nconst x = 1;\nconst y = 2;\n```';
    const out = renderToText(md);
    expect(out).toContain('const x = 1;');
    expect(out).toContain('const y = 2;');
  });

  it('无序列表 -：渲染列表项', () => {
    const out = renderToText('- 第一项\n- 第二项\n- 第三项');
    expect(out).toContain('第一项');
    expect(out).toContain('第二项');
    expect(out).toContain('第三项');
  });

  it('段落：多段落分行', () => {
    const out = renderToText('第一段\n\n第二段');
    expect(out).toContain('第一段');
    expect(out).toContain('第二段');
  });

  it('混合：标题 + 粗体 + 代码', () => {
    const md = '# Title\n\n**bold** and `code`';
    const out = renderToText(md);
    expect(out).toContain('Title');
    expect(out).toContain('bold');
    expect(out).toContain('code');
  });

  it('空字符串：无输出（不崩）', () => {
    expect(() => renderToText('')).not.toThrow();
  });

  it('链接 [text](url)：渲染文本部分（终端不显示可点链接）', () => {
    const out = renderToText('see [docs](https://example.com)');
    expect(out).toContain('docs');
  });
});
