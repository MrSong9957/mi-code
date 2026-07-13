// src/tui/inline/diff.test.ts
// Diff Layer 单元测试：验证 line-level diff 生成正确的 RenderOperation[]。
//
// Phase 3：diff 是纯函数，输入 prevCount/nextLines → 输出 RenderOperation[]。
// 本测试覆盖三种场景：footer 覆写 / streaming 覆写 / footer commit。

import { describe, it, expect } from 'vitest';
import {
  diffFooterOverlay, diffStreamingOverlay, diffFooterCommit, diffOverlay,
  type RenderOperation,
} from './diff.js';

/** 辅助：简化 RenderOperation 为可读字符串，便于断言 */
function summarize(ops: RenderOperation[]): string[] {
  return ops.map(op => {
    switch (op.type) {
      case 'cursorUp': return `up(${op.count})`;
      case 'appendLine': return `append("${op.content}")`;
      case 'overwriteLine': return `write("${op.content}")`;
      case 'eraseAndAdvance': return 'erase+';
      case 'eraseNoAdvance': return 'erase';
      case 'advanceNewLine': return '\\n';
      case 'deleteLines': return `DL(${op.count})`;
    }
  });
}

describe('diffOverlay（通用覆写）', () => {
  it('prevCount=0（首次）：逐行 appendLine', () => {
    const ops = diffOverlay(0, ['A', 'B']);
    expect(summarize(ops)).toEqual(['append("A")', 'append("B")']);
  });

  it('prevCount>0，next 更长：cursorUp + 逐行 overwrite', () => {
    const ops = diffOverlay(2, ['A', 'B', 'C']);
    expect(summarize(ops)).toEqual(['up(2)', 'write("A")', 'write("B")', 'write("C")']);
  });

  it('prevCount>0，next 更短：cursorUp + overwrite + eraseAndAdvance 擦多余', () => {
    const ops = diffOverlay(3, ['A']);
    expect(summarize(ops)).toEqual(['up(3)', 'write("A")', 'erase+', 'erase+']);
  });
});

describe('diffFooterOverlay', () => {
  it('footerHeight=0（追加模式）：逐行 appendLine', () => {
    const ops = diffFooterOverlay(0, 0, ['border', '❯ ', 'border', 'status']);
    expect(ops.every(op => op.type === 'appendLine')).toBe(true);
    expect(ops).toHaveLength(4);
  });

  it('footerHeight>0：cursorUp 用 cursorToTop（不是 footerHeight）', () => {
    // footerHeight=4, cursorToTop=1（光标在输入框行）
    const ops = diffFooterOverlay(4, 1, ['border', '❯ ', 'border', 'status']);
    // 第一个操作是 cursorUp(1)，不是 cursorUp(4)
    expect(ops[0]).toEqual({ type: 'cursorUp', count: 1 });
  });

  it('footerHeight>0，行数相等：cursorUp + 逐行 overwrite', () => {
    const ops = diffFooterOverlay(4, 1, ['b1', 'b2', 'b3', 'b4']);
    expect(summarize(ops)).toEqual([
      'up(1)', 'write("b1")', 'write("b2")', 'write("b3")', 'write("b4")',
    ]);
  });

  it('footerHeight>0，next 更短：多余的旧行用 eraseAndAdvance', () => {
    const ops = diffFooterOverlay(6, 1, ['b1', 'b2', 'b3', 'b4']);
    expect(summarize(ops)).toEqual([
      'up(1)', 'write("b1")', 'write("b2")', 'write("b3")', 'write("b4")',
      'erase+', 'erase+',
    ]);
  });
});

describe('diffStreamingOverlay', () => {
  it('lastStreamingHeight=0（首次追加）：逐行 appendLine', () => {
    const ops = diffStreamingOverlay(0, ['S1', 'S2']);
    expect(summarize(ops)).toEqual(['append("S1")', 'append("S2")']);
  });

  it('lastStreamingHeight>0，行数相等：cursorUp(prevCount) + 逐行 overwrite', () => {
    const ops = diffStreamingOverlay(3, ['S1', 'S2', 'S3']);
    expect(summarize(ops)).toEqual([
      'up(3)', 'write("S1")', 'write("S2")', 'write("S3")',
    ]);
  });

  it('lastStreamingHeight>0，next 更短：cursorUp + overwrite + DL 删除多余', () => {
    // 3 行 → 1 行：DL(2)
    const ops = diffStreamingOverlay(3, ['S1']);
    expect(summarize(ops)).toEqual([
      'up(3)', 'write("S1")', 'up(1)', 'DL(2)', '\\n',
    ]);
  });

  it('lastStreamingHeight>0，next 更长：cursorUp + overwrite（无 DL）', () => {
    const ops = diffStreamingOverlay(2, ['S1', 'S2', 'S3', 'S4']);
    expect(summarize(ops)).toEqual([
      'up(2)', 'write("S1")', 'write("S2")', 'write("S3")', 'write("S4")',
    ]);
  });
});

describe('diffFooterCommit', () => {
  it('footerHeight=0：无操作（空数组）', () => {
    const ops = diffFooterCommit(0, 0);
    expect(ops).toEqual([]);
  });

  it('footerHeight=4：cursorUp(cursorToTop) + 逐行擦除（最后一行不换行）+ cursorUp 回顶', () => {
    const ops = diffFooterCommit(4, 1);
    expect(summarize(ops)).toEqual([
      'up(1)',       // cursorUp(cursorToTop)
      'erase+',      // 行0（擦+\n）
      'erase+',      // 行1
      'erase+',      // 行2
      'erase',       // 行3（最后一行，擦不换行）
      'up(3)',       // cursorUp(footerHeight-1=3) 回顶
    ]);
  });

  it('footerHeight=1：cursorUp + erase（唯一行不换行），不回顶（footerHeight-1=0）', () => {
    const ops = diffFooterCommit(1, 0);
    expect(summarize(ops)).toEqual(['erase']);
    // cursorToTop=0（光标在 footer 顶），不 cursorUp；footerHeight-1=0 不回顶
  });
});

describe('Diff 纯函数性质', () => {
  it('相同输入产生相同输出（确定性）', () => {
    const o1 = diffStreamingOverlay(3, ['A', 'B']);
    const o2 = diffStreamingOverlay(3, ['A', 'B']);
    expect(o1).toEqual(o2);
  });

  it('不修改输入数组', () => {
    const next = ['A', 'B', 'C'];
    const snapshot = [...next];
    diffStreamingOverlay(2, next);
    expect(next).toEqual(snapshot);
  });
});
