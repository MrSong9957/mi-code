// src/__tests__/tui/input-cursor-units.test.ts
// Step 1:cursor 单位 characterization。
//
// 性质:characterization(锁定 store 当前真实行为),不是 RED。物理行模型的前置停止条件。
// 仅 BMP 范围(ASCII / CJK / 换行边界)——这三个在 store 与 layout 都码点一致。
//
// 失败 → 停止,说明 store 在 BMP 也有缺陷,回到计划 §0a 重新评估(不允许带失败继续)。
// 本步骤不驱动新代码(input-store 在禁改区);锁定 BMP 基线,作为后续 layout 与 store 交接的契约参照。

import { describe, it, expect } from 'vitest';
import { createInputStore } from '../../tui/state/input-store.js';

describe('input-store cursor 单位 characterization (BMP)', () => {
  it('ASCII:insert 后 cursor = 码点数', () => {
    const s = createInputStore();
    s.getState().insert('abc');
    expect(s.getState().cursor).toBe(3);
  });

  it('CJK:cursor = 码点数,text.length 一致(BMP)', () => {
    const s = createInputStore();
    s.getState().insert('你好');
    expect(s.getState().cursor).toBe(2);
    expect(s.getState().text.length).toBe(2);
  });

  it('换行边界:insertNewline 后 cursor +1 跨 \\n', () => {
    const s = createInputStore();
    s.getState().insert('ab');
    s.getState().insertNewline();
    expect(s.getState().cursor).toBe(3);
    expect(s.getState().text).toBe('ab\n');
  });
});
