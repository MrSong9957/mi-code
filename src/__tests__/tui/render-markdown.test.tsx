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

  it('嵌套列表：不触发 Box-in-Text 崩溃，内容正常渲染', () => {
    // 回归测试：list item 内含嵌套 list 时，renderListItemContent 返回 <Box>，
    // 若用 <Text> 包裹会触发 Ink 的 Box-in-Text 约束导致渲染失败。
    // ink-testing-library 会吞掉该错误并返回空 frame，因此断言 frame 非空且含内容。
    const md = '1. 外层\n   - 内层A\n   - 内层B\n2. 外层2';
    const out = renderToText(md);
    expect(out.length).toBeGreaterThan(5);  // 崩溃时 frame 仅 1 字符
    expect(out).toContain('外层');
    expect(out).toContain('内层A');
    expect(out).toContain('内层B');
  });

  it('嵌套列表在 borderStyle Box 内：不崩溃（ExitPlanMode 场景）', () => {
    // ExitPlanModeOverlayV2 用 <Box borderStyle="round"> 包裹 renderMarkdown 输出。
    // borderStyle 改变了 Ink 渲染上下文，使 Box-in-Text 从"恰好不崩"变为"必然崩"。
    // 此测试锁定：嵌套 list 在 borderStyle Box 内仍正常渲染。
    const md = '1. 第一步\n   - 子步骤\n2. 第二步';
    const { lastFrame } = render(
      React.createElement(Box, { borderStyle: 'round' as const, paddingX: 1 },
        renderMarkdown(md),
      ),
    );
    const out = lastFrame() ?? '';
    expect(out.length).toBeGreaterThan(5);
    expect(out).toContain('第一步');
    expect(out).toContain('子步骤');
  });
});
