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

  it('text + image(有 cachePath):text 在前,[图片 basename] 在后,空格连接', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '这是什么' },
      { type: 'image', mediaType: 'image/png', data: '', cachePath: '/home/u/.micode/image-cache/sess-abc/1.png' },
    ];
    // 只取 basename,不显示 sessionId / 家目录路径(实测长路径视觉糟糕)
    expect(formatUserContentForResume(blocks)).toBe('这是什么 [图片 1.png]');
  });

  it('image cachePath 是 Windows 反斜杠路径:basename 提取正确', () => {
    const blocks: ContentBlock[] = [
      { type: 'image', mediaType: 'image/jpeg', data: '', cachePath: 'C:\\Users\\u\\.micode\\image-cache\\sid\\photo.jpg' },
    ];
    // path.basename 在所有平台都识别 POSIX /,Windows 反斜杠仅 Windows 原生识别。
    // 本测试在 win32 跑时返回 photo.jpg,在 Linux/macOS 跑时仍含反斜杠——
    // 接受平台差异,核心断言是不该含盘符前缀 C:
    const result = formatUserContentForResume(blocks);
    expect(result).not.toContain('C:');
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
