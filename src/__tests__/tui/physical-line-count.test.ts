// src/__tests__/tui/physical-line-count.test.ts
// 物理行折算测试：把逻辑行（按 \n 分割）按终端宽度折算成物理行数。
//
// 物理本质：终端会按列宽自动折行，CJK 占 2 列。应用层虽不做 word wrap（不改输入文本），
// 但必须按物理行数记账（footerHeight），否则覆写时 cursorUp 不够 → border 残影堆叠。
//
// 防作弊：随机化输入长度 × CJK 比例，断言物理行数 ≥ 逻辑行数、且按宽度正确折算。

import { describe, it, expect } from 'vitest';
import { physicalLineCount, physicalLineOfCursor } from '../../tui/state/input-viewport.js';

describe('physicalLineCount（逻辑行→物理行折算）', () => {
  it('空文本：1 物理行', () => {
    expect(physicalLineCount('', 80)).toBe(1);
  });

  it('短文本不折行：物理行数 = 逻辑行数', () => {
    expect(physicalLineCount('hello', 80)).toBe(1);
    expect(physicalLineCount('a\nb\nc', 80)).toBe(3);
  });

  it('单行 ASCII 超宽折行：200 字符 / 80 列 = 3 物理行', () => {
    const text = 'a'.repeat(200);
    expect(physicalLineCount(text, 80)).toBe(3); // ceil(200/80) = 3
  });

  it('CJK 折行：每字 2 列，40 个汉字 / 80 列 = 1 物理行', () => {
    const text = '中'.repeat(40); // 40 × 2 = 80 列，恰好 1 行
    expect(physicalLineCount(text, 80)).toBe(1);
  });

  it('CJK 折行：41 个汉字 / 80 列 = 2 物理行', () => {
    const text = '中'.repeat(41); // 82 列 → 2 行
    expect(physicalLineCount(text, 80)).toBe(2);
  });

  it('首行 prompt 前缀折算：prompt 占 2 列，首行 budget = cols - 2', () => {
    // 首行有 '❯ ' 前缀（2 列），78 个 a 恰好 1 行，79 个 a 折成 2 行
    expect(physicalLineCount('a'.repeat(78), 80, 2)).toBe(1);
    expect(physicalLineCount('a'.repeat(79), 80, 2)).toBe(2);
  });

  it('多行混合：每行独立折算后求和', () => {
    // 第0行 100 a（含 prompt 2 列，budget 78 → ceil(100/78)=2 物理行）
    // 第1行 10 b（1 物理行）
    // 合计 3 物理行
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(10);
    expect(physicalLineCount(text, 80, 2)).toBe(3);
  });

  it('不变量【随机化】：物理行数 ≥ 逻辑行数', () => {
    expect.hasAssertions();
    for (let i = 0; i < 20; i++) {
      const cols = 40 + Math.floor(Math.random() * 60);
      const lineCount = 1 + Math.floor(Math.random() * 5);
      const lines: string[] = [];
      for (let j = 0; j < lineCount; j++) {
        const len = Math.floor(Math.random() * 150);
        const isCjk = Math.random() < 0.5;
        lines.push((isCjk ? '中' : 'a').repeat(len));
      }
      const text = lines.join('\n');
      const phys = physicalLineCount(text, cols, 2);
      // 不变量：物理行数 ≥ 逻辑行数（折行只会更多不会更少）
      expect(phys).toBeGreaterThanOrEqual(lineCount);
    }
  });
});

describe('physicalLineOfCursor（光标所在物理行）', () => {
  it('短文本光标在末尾：物理行 = 最后一行', () => {
    // 'hello' cursor=5，无折行，物理行 0（0-based）
    expect(physicalLineOfCursor('hello', 5, 80, 2)).toBe(0);
  });

  it('单行超宽：光标在 200 字符末尾 = 物理行 2（第 3 行，0-based）', () => {
    const text = 'a'.repeat(200);
    // 首行 budget = 80 - 2 = 78，后续 budget = 80
    // 物理行：[0,78) [78,158) [158,200) → 光标 200 在第 2 物理行（0-based）
    // 但首行含 prompt，cursor=200 时已越过首行
    expect(physicalLineOfCursor(text, 200, 80, 2)).toBe(2);
  });

  it('多行：光标在第 2 逻辑行末尾，物理行 = 第 1 逻辑行的物理行数之和', () => {
    // 第0行 'a'×100（含 prompt，budget 78 → 2 物理行：[0,2)+[2,80)+[80,102)？需精算
    // 实际：prompt 占 2 列，首行剩余 budget = 78。100 个 a：首物理行放 78，次物理行放 22 → 2 物理行
    // 第1行 'b'×10，光标在第1行末尾 → 物理行 = 2（前面2行）+ 0（第1行首物理行）= 2
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(10);
    const cursor = [...text].length; // 111
    expect(physicalLineOfCursor(text, cursor, 80, 2)).toBe(2);
  });
});
