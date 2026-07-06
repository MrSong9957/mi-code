// src/__tests__/render/optimizer.test.ts
import { describe, it, expect } from 'vitest';
import { optimize } from '../../render/optimizer.js';
import { ERASE_CHAR_ID, type Patch } from '../../render/types.js';

function patch(x: number, y: number, charId: number, styleId: number, fw = false): Patch {
  return { x, y, charId, styleId, isFullWidthContinuation: fw };
}

describe('optimize', () => {
  it('空输入 → 空输出', () => {
    expect(optimize([])).toEqual([]);
  });

  it('全角续位 patch 被过滤掉（emit 不需要它们）', () => {
    const input: Patch[] = [
      patch(0, 0, 1, 0, false),   // head
      patch(1, 0, 1, 0, true),    // 续位
      patch(2, 0, 2, 0, false),
    ];
    const out = optimize(input);
    expect(out.length).toBe(2);
    expect(out.every(p => !p.isFullWidthContinuation)).toBe(true);
  });

  it('行内按 x 排序', () => {
    const input: Patch[] = [
      patch(2, 0, 2, 0),
      patch(0, 0, 1, 0),
      patch(1, 0, 3, 0),
    ];
    const out = optimize(input);
    expect(out.map(p => p.x)).toEqual([0, 1, 2]);
  });

  it('跨行按 y 优先、x 次之排序', () => {
    const input: Patch[] = [
      patch(0, 1, 1, 0),
      patch(1, 0, 2, 0),
      patch(0, 0, 3, 0),
    ];
    const out = optimize(input);
    expect(out.map(p => `${p.x},${p.y}`)).toEqual(['0,0', '1,0', '0,1']);
  });

  it('「写空格 + 默认样式」patch → charId 标记为 ERASE_CHAR_ID', () => {
    // 空格的 charId 在 CharPool 里是 0（intern('') 或 intern(' ')？取决于实现）
    // optimizer 规则：charId 为空白 + styleId 为默认 → 标记 ERASE
    const input: Patch[] = [
      patch(0, 0, 0, 0),  // charId=0（空白）+ styleId=0（默认）
      patch(1, 0, 5, 0),  // 普通字符
    ];
    const out = optimize(input);
    expect(out[0]!.charId).toBe(ERASE_CHAR_ID);
    expect(out[1]!.charId).toBe(5);
  });

  it('非默认样式的空格不标记 ERASE（保留为普通字符）', () => {
    const input: Patch[] = [
      patch(0, 0, 0, 3),  // 空白但 styleId=3（非默认）
    ];
    const out = optimize(input);
    expect(out[0]!.charId).toBe(0);  // 未被标记 ERASE
  });
});
