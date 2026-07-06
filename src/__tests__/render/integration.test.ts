// src/__tests__/render/integration.test.ts
// 端到端：模拟 Ink render 一棵小树 → 自研 renderer → 断言 ANSI 输出含预期字符。

import { describe, it, expect } from 'vitest';
import { createCustomRenderer } from '../../render/renderer.js';

describe('integration: custom renderer 端到端', () => {
  it('渲染含 ASCII 的假树 → 输出含字符', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const renderer = createCustomRenderer({ stdout });

    const fakeTree = {
      nodeName: 'ink-root',
      yogaNode: {
        getComputedLeft: () => 0, getComputedTop: () => 0,
        getComputedWidth: () => 80, getComputedHeight: () => 24,
        getDisplay: () => 0,  // DISPLAY_FLEX
      },
      childNodes: [{
        nodeName: 'ink-text',
        yogaNode: {
          getComputedLeft: () => 0, getComputedTop: () => 0,
          getComputedWidth: () => 5, getComputedHeight: () => 1,
          getDisplay: () => 0,
        },
        childNodes: [{ nodeName: '#text', nodeValue: 'hello', childNodes: [] }],
      }],
    };
    renderer(fakeTree as never, { width: 80, height: 24 });
    const written = writes.join('');
    expect(written).toContain('hello');
    expect(written).toContain('\x1b[?2026h');  // DEC 2026
  });

  it('第二帧无变化 → 输出无字符（仅 DEC 2026 + cursor）', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const renderer = createCustomRenderer({ stdout });

    const fakeTree = {
      nodeName: 'ink-root',
      yogaNode: { getComputedLeft: () => 0, getComputedTop: () => 0, getComputedWidth: () => 5, getComputedHeight: () => 1, getDisplay: () => 0 },
      childNodes: [{ nodeName: 'ink-text', yogaNode: { getComputedLeft: () => 0, getComputedTop: () => 0, getComputedWidth: () => 5, getComputedHeight: () => 1, getDisplay: () => 0 }, childNodes: [{ nodeName: '#text', nodeValue: 'hi', childNodes: [] }] }],
    };
    renderer(fakeTree as never, { width: 80, height: 24 });
    writes.length = 0;  // 清第一帧
    renderer(fakeTree as never, { width: 80, height: 24 });  // 第二帧相同
    const secondFrame = writes.join('');
    expect(secondFrame).not.toContain('hi');  // 无变化不重写
    expect(secondFrame).toContain('\x1b[?2026h');  // 仍包裹 DEC 2026
  });
});
