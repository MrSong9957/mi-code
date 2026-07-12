// src/tui/state/wrap-line.test.ts
//
// wordWrap 单元测试：按显示宽度折行（混合策略：英文优先按空格断行，CJK/无空格按字符级断行）。
// 基于 string-width（display width），ANSI token stream 保留样式。

import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { wrapLine, getUsableWidth } from './wrap-line.js';

describe('wrapLine', () => {
  describe('基本折行', () => {
    it('短文本不折行（返回1行）', () => {
      expect.hasAssertions();
      const result = wrapLine('hello', 80);
      expect(result).toEqual(['hello']);
    });

    it('空文本返回1行空字符串', () => {
      expect.hasAssertions();
      const result = wrapLine('', 80);
      expect(result).toEqual(['']);
    });

    it('恰好填满 usableWidth 不折行', () => {
      expect.hasAssertions();
      const result = wrapLine('a'.repeat(79), 79);
      expect(result).toHaveLength(1);
      expect(stringWidth(result[0]!)).toBe(79);
    });
  });

  describe('英文按空格断行', () => {
    it('超宽时优先在空格处断行（不劈单词）', () => {
      expect.hasAssertions();
      // usableWidth=10, "hello world" = 11 列（含空格）
      const result = wrapLine('hello world', 10);
      expect(result).toEqual(['hello', 'world']);
    });

    it('空格不进入下一行（无前导空格）', () => {
      expect.hasAssertions();
      const result = wrapLine('hello world abc', 10);
      // "hello world" 超10列 → "hello" / "world abc"
      // "world abc" = 9 列 ≤ 10
      expect(result).toEqual(['hello', 'world abc']);
      // 验证无前导空格
      for (const line of result) {
        expect(line).not.toMatch(/^\s/);
      }
    });

    it('多个空格连续时只断一次', () => {
      expect.hasAssertions();
      const result = wrapLine('hello  world', 10);
      // "hello  world" = 12 列 → "hello" / "world"（两个空格都丢弃）
      expect(result).toEqual(['hello', 'world']);
    });
  });

  describe('CJK 按字符级断行', () => {
    it('中文无空格时按字符级断行', () => {
      expect.hasAssertions();
      // 10个汉字 = 20列，usableWidth=10 → 每行5个汉字
      const result = wrapLine('中'.repeat(10), 10);
      expect(result).toHaveLength(2);
      expect(stringWidth(result[0]!)).toBe(10);
      expect(stringWidth(result[1]!)).toBe(10);
    });

    it('CJK 恰好填满不折行', () => {
      expect.hasAssertions();
      // 5个汉字 = 10列 = usableWidth
      const result = wrapLine('中'.repeat(5), 10);
      expect(result).toHaveLength(1);
      expect(stringWidth(result[0]!)).toBe(10);
    });

    it('CJK 超宽时按字符级断行（无空格可找）', () => {
      expect.hasAssertions();
      // 6个汉字 = 12列 > 10
      const result = wrapLine('中'.repeat(6), 10);
      expect(result).toHaveLength(2);
      expect(stringWidth(result[0]!)).toBe(10); // 5个汉字
      expect(stringWidth(result[1]!)).toBe(2);  // 1个汉字
    });
  });

  describe('超长无空格 token 强制断行', () => {
    it('超长英文无空格按字符级断行', () => {
      expect.hasAssertions();
      const result = wrapLine('a'.repeat(25), 10);
      expect(result).toHaveLength(3);
      expect(stringWidth(result[0]!)).toBe(10);
      expect(stringWidth(result[1]!)).toBe(10);
      expect(stringWidth(result[2]!)).toBe(5);
    });
  });

  describe('emoji 正确折行', () => {
    it('emoji 占2列，正确计入宽度', () => {
      expect.hasAssertions();
      // 🤖 占2列，5个emoji = 10列 = usableWidth
      const result = wrapLine('🤖'.repeat(5), 10);
      expect(result).toHaveLength(1);
      expect(stringWidth(result[0]!)).toBe(10);
    });

    it('emoji 超宽时折行', () => {
      expect.hasAssertions();
      // 6个emoji = 12列 > 10
      const result = wrapLine('🤖'.repeat(6), 10);
      expect(result).toHaveLength(2);
      expect(stringWidth(result[0]!)).toBe(10);
      expect(stringWidth(result[1]!)).toBe(2);
    });
  });

  describe('含 ANSI 颜色码的文本', () => {
    it('ANSI 序列不占宽度，样式保留', () => {
      expect.hasAssertions();
      const text = '\x1b[31mhello world\x1b[0m';
      const result = wrapLine(text, 10);
      // 断成2行，每行保留颜色码（SGR 31 = 红色）
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('\x1b[31m');
      expect(result[0]).toContain('hello');
      expect(result[1]).toContain('\x1b[31m');
      expect(result[1]).toContain('world');
      // 显示宽度正确（ANSI 不计入）
      expect(stringWidth(result[0]!)).toBe(5);
      expect(stringWidth(result[1]!)).toBe(5);
    });

    it('ANSI 颜色不污染断行宽度计算', () => {
      expect.hasAssertions();
      // 含颜色的10字符文本，usableWidth=10 → 不折行
      const text = '\x1b[36m' + 'a'.repeat(10) + '\x1b[0m';
      const result = wrapLine(text, 10);
      expect(result).toHaveLength(1);
      expect(stringWidth(result[0]!)).toBe(10);
    });

    it('多个 ANSI 序列穿插文本，样式保留', () => {
      expect.hasAssertions();
      // \x1b[31mhello\x1b[0m \x1b[32mworld\x1b[0m = "hello world" 11列
      const text = '\x1b[31mhello\x1b[0m \x1b[32mworld\x1b[0m';
      const result = wrapLine(text, 10);
      // 断成2行，每行保留各自颜色码
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('\x1b[31m');
      expect(result[0]).toContain('hello');
      expect(result[1]).toContain('\x1b[32m');
      expect(result[1]).toContain('world');
      expect(stringWidth(result[0]!)).toBe(5);
      expect(stringWidth(result[1]!)).toBe(5);
    });
  });

  describe('混合文本', () => {
    it('中文+emoji+英文混合', () => {
      expect.hasAssertions();
      // 你好hello🤖世界 = 2+2+5+2+2+2 = 15列（不含 ANSI）
      const text = '你好hello🤖世界';
      expect(stringWidth(text)).toBe(15);
      const result = wrapLine(text, 10);
      // 应折成2行，每行 ≤10列
      expect(result.length).toBeGreaterThanOrEqual(2);
      for (const line of result) {
        expect(stringWidth(line)).toBeLessThanOrEqual(10);
      }
    });

    it('英文+CJK 混合，优先在空格断行', () => {
      expect.hasAssertions();
      const result = wrapLine('hello 你好世界', 10);
      expect(stringWidth(result[0]!)).toBeLessThanOrEqual(10);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('空格太靠前时不在此空格断行（避免第一行太短）', () => {
      expect.hasAssertions();
      // 英文场景：'a bbbb...' 空格前后都是 ASCII（a 和 b）
      // beforeSpace='a'=1列 < 79*0.3=23.7 → 不空格断行，字符级断行
      // 第一行应铺满到接近79列，而非只有1列
      const text = 'a ' + 'b'.repeat(200);
      const result = wrapLine(text, 79);
      expect(result.length).toBeGreaterThan(1);
      // 第一行应 > 30列（不是只有1列 'a'）
      expect(stringWidth(result[0]!)).toBeGreaterThan(30);
      for (const line of result) {
        expect(stringWidth(line)).toBeLessThanOrEqual(79);
      }
    });

    it('CJK 文本含空格时不在此空格断行（CJK 空格非单词边界）', () => {
      expect.hasAssertions();
      // "中文 中文 中文..." 空格前后都是 CJK，不是英文单词边界
      // 应字符级断行（铺满），而非在空格处断行（导致行短）
      const text = '千'.repeat(50) + ' ' + '千'.repeat(50) + ' ' + '千'.repeat(50);
      const result = wrapLine(text, 79);
      // 每行应铺满（接近79列），而非在空格处断行
      for (let i = 0; i < result.length - 1; i++) {
        // 非最后一行应 > 70列（铺满，不是在空格处断行的短行）
        expect(stringWidth(result[i]!)).toBeGreaterThan(70);
      }
    });
  });

  describe('随机化测试（防假测试）', () => {
    it('随机英文+空格：每行 ≤ usableWidth，无前导空格', () => {
      expect.hasAssertions();
      for (let iter = 0; iter < 10; iter++) {
        const words: string[] = [];
        const wordCount = 5 + Math.floor(Math.random() * 20);
        for (let i = 0; i < wordCount; i++) {
          const len = 1 + Math.floor(Math.random() * 8);
          words.push('a'.repeat(len));
        }
        const text = words.join(' ');
        const width = 10 + Math.floor(Math.random() * 30);
        const result = wrapLine(text, width);
        // 不变量：每行 ≤ usableWidth
        for (const line of result) {
          expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
        // 不变量：无前导空格（空格断行时丢弃）
        for (const line of result) {
          expect(line).not.toMatch(/^\s/);
        }
        // 不变量：总宽度 + 丢失空格数 = 原文宽度
        // 空格断行丢1个空格，字符级断行不丢。lostSpaces ≤ 断行数。
        const totalWidth = result.reduce((s, l) => s + stringWidth(l), 0);
        const originalWidth = stringWidth(text);
        // totalWidth ≤ originalWidth（断行只丢空格，不丢字符）
        expect(totalWidth).toBeLessThanOrEqual(originalWidth);
        // 丢失的宽度 = originalWidth - totalWidth，应 = 丢失的空格数（每个空格1列）
        const lostWidth = originalWidth - totalWidth;
        // 丢失空格数 ≤ 断行数（每断行最多丢1个空格）
        expect(lostWidth).toBeLessThanOrEqual(result.length - 1);
      }
    });

    it('随机 CJK：每行 ≤ usableWidth', () => {
      expect.hasAssertions();
      for (let iter = 0; iter < 10; iter++) {
        const charCount = 10 + Math.floor(Math.random() * 40);
        const text = '中'.repeat(charCount);
        const width = 4 + Math.floor(Math.random() * 16);
        const result = wrapLine(text, width);
        for (const line of result) {
          expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
        // CJK 无空格，总宽度应 = 原文宽度（无字符丢失）
        const totalWidth = result.reduce((s, l) => s + stringWidth(l), 0);
        expect(totalWidth).toBe(stringWidth(text));
      }
    });
  });
});

describe('getUsableWidth', () => {
  it('返回 cols - 1（留安全列）', () => {
    expect.hasAssertions();
    expect(getUsableWidth(80)).toBe(79);
    expect(getUsableWidth(120)).toBe(119);
  });

  it('cols=1 时返回 1（不返回0）', () => {
    expect.hasAssertions();
    expect(getUsableWidth(1)).toBe(1);
  });
});

describe('wrapLine 边界与极端场景', () => {
  it('usableWidth=1：ASCII 每字符一行', () => {
    expect.hasAssertions();
    const result = wrapLine('abc', 1);
    expect(result).toHaveLength(3);
    for (const line of result) {
      expect(stringWidth(line)).toBeLessThanOrEqual(1);
    }
  });

  it('usableWidth=2：CJK(2列) 恰好填满不折行', () => {
    expect.hasAssertions();
    const result = wrapLine('中', 2);
    expect(result).toHaveLength(1);
    expect(stringWidth(result[0]!)).toBe(2);
  });

  it('usableWidth=1：CJK(2列) 超宽仍占1行（不劈字符）', () => {
    expect.hasAssertions();
    const result = wrapLine('中', 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('中');
  });

  it('空格恰好落在 usableWidth 边界', () => {
    expect.hasAssertions();
    const result = wrapLine('abcd efgh', 5);
    expect(result).toEqual(['abcd', 'efgh']);
  });

  it('beforeSpace 尾部有连续空格时 trim 生效', () => {
    expect.hasAssertions();
    const result = wrapLine('hello   world', 10);
    expect(result).toEqual(['hello', 'world']);
    for (const line of result) {
      expect(line).not.toMatch(/\s$/);
    }
  });
});
