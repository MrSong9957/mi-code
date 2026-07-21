// src/__tests__/utils/format-content.test.ts
// formatUserContentForResume 单元测试:resume 时把 user 消息 content 转人类可读字符串
//
// TDD:先写失败测试,再实现 src/utils/format-content.ts。

import { describe, it, expect } from 'vitest';
import { formatUserContentForResume } from '../../utils/format-content.js';
import type { ContentBlock } from '../../agent/types.js';

describe('formatUserContentForResume', () => {
  it('字符串 content:原样透传', () => {
    expect(formatUserContentForResume('hello world')).toBe('hello world');
  });

  it('纯 text block:返回 text 原文', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: '这是什么' }];
    expect(formatUserContentForResume(blocks)).toBe('这是什么');
  });

  it('text + image(有 cachePath):text 在前,[图片 cachePath] 在后,空格连接', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '这是什么' },
      { type: 'image', mediaType: 'image/png', data: '', cachePath: '/x/1.png' },
    ];
    expect(formatUserContentForResume(blocks)).toBe('这是什么 [图片 /x/1.png]');
  });

  it('image 无 cachePath(防御):返回 [图片]', () => {
    const blocks: ContentBlock[] = [
      { type: 'image', mediaType: 'image/png', data: '' },
    ];
    expect(formatUserContentForResume(blocks)).toBe('[图片]');
  });

  it('空数组:返回空字符串', () => {
    expect(formatUserContentForResume([])).toBe('');
  });

  it('tool_use + tool_result 混合:转占位符,空格连接', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'x', name: 'f', input: {} },
      { type: 'tool_result', tool_use_id: 'x', content: 'r' },
    ];
    expect(formatUserContentForResume(blocks)).toBe('[工具调用] [工具结果]');
  });
});
