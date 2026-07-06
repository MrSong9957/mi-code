// src/__tests__/render/diff.test.ts
import { describe, it, expect } from 'vitest';
import { diff } from '../../render/diff.js';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE } from '../../render/types.js';
import { blit } from '../../render/output-ops.js';

function makeScreen(rows: number, cols: number): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

describe('diff', () => {
  it('两帧相同 → 空 Patch[]', () => {
    const front = makeScreen(2, 3);
    const back = makeScreen(2, 3);
    expect(diff(front, back)).toEqual([]);
  });

  it('单 cell 变更 → 1 个 Patch', () => {
    const front = makeScreen(1, 3);
    const back = makeScreen(1, 3);
    blit(back, 0, 0, 'a', DEFAULT_STYLE);
    const patches = diff(front, back);
    expect(patches.length).toBe(1);
    expect(patches[0]!.x).toBe(0);
    expect(patches[0]!.y).toBe(0);
    expect(patches[0]!.isFullWidthContinuation).toBe(false);
  });

  it('多 cell 变更 → 多 Patch（按行优先序）', () => {
    const front = makeScreen(1, 3);
    const back = makeScreen(1, 3);
    blit(back, 0, 0, 'abc', DEFAULT_STYLE);
    const patches = diff(front, back);
    expect(patches.length).toBe(3);
    expect(patches.map(p => p.x)).toEqual([0, 1, 2]);
  });

  it('CJK 变更 → head + 续位 都进 Patch，续位 isFullWidthContinuation=true', () => {
    const front = makeScreen(1, 3);
    const back = makeScreen(1, 3);
    blit(back, 0, 0, '你', DEFAULT_STYLE);
    const patches = diff(front, back);
    expect(patches.length).toBe(2);
    const head = patches.find(p => !p.isFullWidthContinuation)!;
    const tail = patches.find(p => p.isFullWidthContinuation)!;
    expect(head).toBeTruthy();
    expect(tail).toBeTruthy();
    expect(head.x).toBe(0);
    expect(tail.x).toBe(1);
  });

  it('Patch.styleId 是解码后的纯 poolId（非编码值）', () => {
    const front = makeScreen(1, 2);
    const back = makeScreen(1, 2);
    const bold = { ...DEFAULT_STYLE, bold: true };
    blit(back, 0, 0, 'a', bold);
    const patches = diff(front, back);
    const expectedStyleId = back.stylePool.intern(bold);
    expect(patches[0]!.styleId).toBe(expectedStyleId);
  });

  it('跨行变更：按 y 优先、x 次之排序', () => {
    const front = makeScreen(2, 2);
    const back = makeScreen(2, 2);
    blit(back, 0, 0, 'ab', DEFAULT_STYLE);
    blit(back, 0, 1, 'cd', DEFAULT_STYLE);
    const patches = diff(front, back);
    expect(patches.map(p => `${p.x},${p.y}`)).toEqual(['0,0', '1,0', '0,1', '1,1']);
  });

  it('尺寸不同 → 抛错（防御，DoubleBuffer 保证同尺寸）', () => {
    const front = makeScreen(2, 3);
    const back = makeScreen(3, 2);
    expect(() => diff(front, back)).toThrow();
  });

  it('同 charId 不同 styleId → 检测到变更', () => {
    const front = makeScreen(1, 2);
    const back = makeScreen(1, 2);
    blit(front, 0, 0, 'a', DEFAULT_STYLE);  // front 已有 a
    blit(back, 0, 0, 'a', { ...DEFAULT_STYLE, bold: true });  // back 同字符但 bold
    const patches = diff(front, back);
    expect(patches.length).toBe(1);
    expect(patches[0]!.charId).toBe(back.charPool.intern('a'));
  });
});
