// src/__tests__/tui/terminal-wrap.test.ts
// 终端折行精确模拟测试。
//
// 物理本质：终端按列宽折行，CJK（2列）放不下当前行时**留空剩余列**换到下一行，
// 不会把字劈成两半。简单的 ceil(width/cols) 不考虑这个留空，对 CJK 不准。
// 本测试验证精确模拟算法与 ceil 法的差异，确保光标定位用精确值。

import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { simulateTerminalWrap } from '../../tui/state/input-viewport.js';

describe('simulateTerminalWrap（终端折行精确模拟）', () => {
  it('纯 ASCII 不折行：1 物理行，光标列 = 宽度', () => {
    const r = simulateTerminalWrap('hello', 80, 2);
    expect(r.physRows).toBe(1);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 5); // prompt 2 + 5 字符
  });

  it('纯 ASCII 恰好填满首行（78字）：1 物理行，光标在列 80（触发下次换行）', () => {
    const r = simulateTerminalWrap('a'.repeat(78), 80, 2);
    expect(r.physRows).toBe(1);
    expect(r.cursorCol).toBe(80);
  });

  it('纯 ASCII 79字：2 物理行（cursorCol=1，下一行行首）', () => {
    const r = simulateTerminalWrap('a'.repeat(79), 80, 2);
    expect(r.physRows).toBe(2);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(1);
  });

  it('CJK 39 字：1 物理行（39×2+2=80 列，恰好填满）', () => {
    const r = simulateTerminalWrap('中'.repeat(39), 80, 2);
    expect(r.physRows).toBe(1);
    expect(r.cursorCol).toBe(80);
  });

  it('CJK 40 字：2 物理行，光标在第2行（列 4 = prompt无 + 2字）', () => {
    // 首行 budget=78，可放 39 字（78列）。第40字放不下 → 第2行。
    // 第2行满宽 cols=80，放第40字，光标在 2×2=4 列（0-based）。
    // 但 cursorCol 是 0-based 内容列（不含该行前缀），第2行无 prompt。
    const r = simulateTerminalWrap('中'.repeat(40), 80, 2);
    expect(r.physRows).toBe(2);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(2); // 1 个字 × 2 列（0-based 列 2 = 第2行第1字之后）
  });

  it('CJK 关键：奇数列残留时留空换行（不劈字）', () => {
    // 构造：'a'(1列) + 39 个 '中'(78列) = 内容 79 列。首行 budget=78。
    // 前 38 个 '中' + 'a' = 1+76=77 ≤ 78 放得下。第 39 个 '中'：77+2=79 > 78 → 留空换行。
    // 第 39 字在第 2 行，光标在其后：cursorRow=1，cursorCol=2（第2行 1 字 × 2 列）。
    const text = 'a' + '中'.repeat(39);
    const r = simulateTerminalWrap(text, 80, 2);
    expect(r.physRows).toBe(2);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(2);
  });

  it('随机化不变量：physRows ≥ ceil(totalWidth/cols)', () => {
    expect.hasAssertions();
    for (let trial = 0; trial < 30; trial++) {
      const cols = 40 + Math.floor(Math.random() * 50);
      const len = Math.floor(Math.random() * 100);
      const isCjk = Math.random() < 0.6;
      const text = (isCjk ? '中' : 'a').repeat(len);
      const r = simulateTerminalWrap(text, cols, 2);
      const totalW = stringWidth(text) + 2;
      const ceilEst = Math.max(1, Math.ceil(totalW / cols));
      expect(r.physRows).toBeGreaterThanOrEqual(ceilEst);
    }
  });

  it('随机化不变量：cursorCol ∈ [0, cols]（光标列恒在物理行内）', () => {
    expect.hasAssertions();
    for (let trial = 0; trial < 50; trial++) {
      const cols = 40 + Math.floor(Math.random() * 50);
      const len = Math.floor(Math.random() * 200);
      const mix = Math.random();
      let text = '';
      for (let i = 0; i < len; i++) {
        text += Math.random() < mix ? '中' : 'a';
      }
      const r = simulateTerminalWrap(text, cols, 2);
      expect(r.cursorCol).toBeGreaterThanOrEqual(0);
      expect(r.cursorCol).toBeLessThanOrEqual(cols);
    }
  });
});
