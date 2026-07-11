// src/tui/inline/input-viewport-delete-regression.test.ts
// 删除时的渲染回归测试（Bug 3：删除时上边框重复绘制）。
//
// 核心契约：无论输入如何增删，每帧 renderFooter 输出的 border（─────）行数恒为 2（上+下）。
// 如果 border 行数 > 2，说明覆写错位，旧行残留——这是用户报告的「删除时上边框重复」根因。
//
// 物理本质：footer 块在终端是一块固定区域，覆写时应整体重绘，不该留下旧帧的 border 残影。

import { describe, it, expect } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';
import { computeInputViewport, MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import { cursorScreenPos } from '../state/cursor-position.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

/** 模拟真实渲染：与 InlineApp.tsx 同款算 viewportTop。返回 viewportTop。 */
function renderInput(r: InlineRenderer, text: string, cursor: number, cols = 80): number {
  const totalLines = text.split('\n').length;
  const cursorLine = cursorScreenPos(text, cursor, '❯ ').y;
  const vp = computeInputViewport(totalLines, cursorLine, MAX_VISIBLE_INPUT_LINES);
  r.renderFooter(text, cursor, 'status', cols, [], 0, vp.viewportTop);
  return vp.viewportTop;
}

describe('删除时渲染回归（Bug 3：border 不应重复）', () => {
  it('契约：多行输入逐字删除到空，每一帧的 border 数恒为 2', () => {
    expect.hasAssertions();
    const mock = createMockStdout();
    const r = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
    const text = '你是谁？\n你手动千文噩\n是驱蚊器结尾\n啊水浇地请我\n去噩千文大';
    let t = text;
    let c = [...t].length;

    renderInput(r, '', 0); // 帧0：空
    renderInput(r, t, c);  // 帧1：完整 5 行

    // 逐字删除，逐帧检查 border 数
    while (c > 0) {
      mock.written.length = 0;
      const chars = [...t];
      chars.splice(c - 1, 1);
      t = chars.join('');
      c = Math.min(c - 1, [...t].length);
      renderInput(r, t, c);
      // 本帧输出里 border（─────）行数应恰好为 2（上+下边框）
      const borders = (mock.output.match(/─{20,}/g) || []).length;
      expect(borders).toBe(2);
    }
  });

  it('契约：逐帧删除过程中，任何一帧的渲染块 border 数都不超过 2', () => {
    expect.hasAssertions();
    const mock = createMockStdout();
    const r = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
    const text = 'aaaa\nbbbb\ncccc\ndddd\neeee\nffff\ngggg';
    let t = text;
    let c = [...t].length;

    renderInput(r, '', 0);
    renderInput(r, t, c);

    // 逐字删除，记录每帧输出
    const frames: string[] = [];
    while (c > 0) {
      mock.written.length = 0;
      const chars = [...t];
      chars.splice(c - 1, 1);
      t = chars.join('');
      c = Math.min(c - 1, [...t].length);
      renderInput(r, t, c);
      frames.push(mock.output);
    }

    // 每帧的 border 数应 ≤ 2（上+下边框）
    for (let i = 0; i < frames.length; i++) {
      const lastRender = frames[i]!.lastIndexOf('\x1b[?25l');
      const block = frames[i]!.slice(0, lastRender);
      const borders = (block.match(/─{20,}/g) || []).length;
      if (borders > 2) {
        // 诊断输出
        throw new Error(`第 ${i} 帧 border 数=${borders}（应为 2）。\n块内容:\n${block}`);
      }
    }
    expect(frames.length).toBeGreaterThan(0);
  });

  it('契约：行数变化（5行→3行→1行）每帧 border 数恒为 2', () => {
    expect.hasAssertions();
    const mock = createMockStdout();
    const r = new InlineRenderer(mock as unknown as NodeJS.WriteStream);

    renderInput(r, '', 0);
    renderInput(r, 'a\nb\nc\nd\ne', 9); // 5 行

    // 删到 3 行
    mock.written.length = 0;
    renderInput(r, 'a\nb\nc', 5);
    let block = mock.output.slice(0, mock.output.lastIndexOf('\x1b[?25l'));
    expect((block.match(/─{20,}/g) || []).length).toBe(2);

    // 删到 1 行
    mock.written.length = 0;
    renderInput(r, 'abc', 3);
    block = mock.output.slice(0, mock.output.lastIndexOf('\x1b[?25l'));
    expect((block.match(/─{20,}/g) || []).length).toBe(2);
  });
});
