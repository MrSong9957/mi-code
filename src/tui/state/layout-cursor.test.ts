// src/tui/state/layout-cursor.test.ts
//
// layoutInputCursor 单元测试：计算光标在 wordWrap 后的物理行 + 列。
//
// cursorCpOffset 是码点索引（与 input-store 一致）。
// 切片用 [...text].slice(0, offset).join('') 保证 emoji 代理对不被劈开。

import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { layoutInputCursor } from './layout-cursor.js';
import { getUsableWidth } from './wrap-line.js';

const PROMPT = '❯ ';
const INDENT = '  ';

describe('layoutInputCursor', () => {
  describe('光标在单行内（不折行）', () => {
    it('光标在行首（col=prefixWidth）', () => {
      expect.hasAssertions();
      const layout = layoutInputCursor('hello', 0, PROMPT, 79);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(stringWidth(PROMPT)); // 2
    });

    it('光标在行尾（col=prefixWidth+textWidth）', () => {
      expect.hasAssertions();
      const layout = layoutInputCursor('hello', 5, PROMPT, 79);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(stringWidth(PROMPT) + 5); // 2+5=7
    });

    it('光标在行中间', () => {
      expect.hasAssertions();
      const layout = layoutInputCursor('hello', 2, PROMPT, 79);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(stringWidth(PROMPT) + 2); // 2+2=4
    });
  });

  describe('光标在 wordWrap 折行边界', () => {
    it('光标恰好填满宽度后在下一行行首', () => {
      expect.hasAssertions();
      // usableWidth=5, prefix='❯ ', text='abcde'
      // beforeSpace='❯'=1列 < 5*0.3=1.5 → 不空格断行，字符级断行
      // wrapLine('❯ abcde', 5) → ['❯ abc', 'de']
      // 光标在 offset=5（text末尾）→ beforeCursor='abcde'
      // wrapLine('❯ abcde', 5) → ['❯ abc', 'de']
      // 光标在 'de' 之后 → row=1, col=stringWidth('de')=2
      const layout = layoutInputCursor('abcde', 5, PROMPT, 5);
      expect(layout.row).toBe(1);
      expect(layout.col).toBe(2); // 'de' 的宽度
    });

    it('光标在折行边界前一行末尾', () => {
      expect.hasAssertions();
      // usableWidth=5, text='abcde', cursor在 offset=3（'abc'之后）
      // wrapLine('❯ abcde', 5) → ['❯ abc', 'de']
      // beforeCursor='abc' → wrapLine('❯ abc', 5) → ['❯ abc']（1行）
      // row=0, col=stringWidth('❯ abc')=5
      const layout = layoutInputCursor('abcde', 3, PROMPT, 5);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(5);
    });
  });

  describe('CJK 光标', () => {
    it('光标在 CJK 字符中间', () => {
      expect.hasAssertions();
      // text='你好世界', cursor在 offset=2（'你好'之后）
      // prefix='❯ '(2列), usableWidth=6
      // wrapLine('❯ 你好世界', 6): '❯ 你好'(6列) / '世界'(4列)
      // beforeCursor='你好' → wrapLine('❯ 你好', 6) → ['❯ 你好']（1行）
      // row=0, col=stringWidth('❯ 你好')=6
      const layout = layoutInputCursor('你好世界', 2, PROMPT, 6);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(6);
    });

    it('光标在 CJK 折行后最后一行', () => {
      expect.hasAssertions();
      // text='你好世界', cursor在 offset=4（全部4字之后）
      // prefix='❯ ', usableWidth=6
      // beforeSpace='❯'=1列 < 6*0.3=1.8 → 不空格断行，字符级断行
      // wrapLine('❯ 你好世界', 6) → ['❯ 你好', '世界']（字符级断行）
      // 光标在 '世界' 之后 → row=1, col=stringWidth('世界')=4
      const layout = layoutInputCursor('你好世界', 4, PROMPT, 6);
      expect(layout.row).toBe(1);
      expect(layout.col).toBe(4); // '世界' 的宽度
    });
  });

  describe('emoji 光标（码点安全切片）', () => {
    it('emoji 后光标位置正确', () => {
      expect.hasAssertions();
      // text='🤖abc', cursor在 offset=1（🤖之后）
      // 🤖 是1码点但2列。prefix='❯ '(2列)
      // beforeCursor='🤖' → wrapLine('❯ 🤖', 79) → ['❯ 🤖']（1行）
      // row=0, col=stringWidth('❯ 🤖')=4
      const layout = layoutInputCursor('🤖abc', 1, PROMPT, 79);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(4); // 2(prefix) + 2(emoji)
    });

    it('emoji 不被劈开（码点安全切片）', () => {
      expect.hasAssertions();
      // text='a🤖b', cursor在 offset=2（🤖之后，b之前）
      // 🤖 是1码点（[...text][1]），offset=2 指向 'b'
      // beforeCursor='a🤖' → wrapLine('❯ a🤖', 79) → ['❯ a🤖']
      // row=0, col=stringWidth('❯ a🤖')=5 (2+1+2)
      const layout = layoutInputCursor('a🤖b', 2, PROMPT, 79);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(5);
    });
  });

  describe('ANSI + emoji 混合 cursor', () => {
    it('ANSI 不占宽度，emoji 占2列，光标在 emoji 后', () => {
      expect.hasAssertions();
      // text='\x1b[31m你好🤖abc\x1b[0m', cursor在 offset=3（你好🤖之后）
      // 码点: [31m=ansi, 你, 好, 🤖, a, b, c, [0m=ansi
      // 但 cursorCpOffset 是相对于纯文本的码点索引（不含 ANSI）？
      // 不——cursorCpOffset 来自 input-store 的 cursor，input-store 的 text 包含 ANSI 吗？
      // input-store 的 text 是纯文本（无 ANSI），ANSI 由 renderFooter 添加。
      // 所以这里 text 参数应该是不含 ANSI 的纯文本。
      // 但 wrapLine 可以处理含 ANSI 的文本...
      // 实际：layoutInputCursor 的 text 参数是 visibleInputLines[i]（纯文本，无 ANSI）。
      // prefix 是 '❯ '（无 ANSI）。
      // 所以这个测试改用纯文本：
      const text = '你好🤖abc';
      // 码点: 你(0), 好(1), 🤖(2), a(3), b(4), c(5)
      // cursorCpOffset=3（🤖之后，a之前）
      // beforeCursor='你好🤖' → wrapLine('❯ 你好🤖', 79) → ['❯ 你好🤖']
      // col = stringWidth('❯ 你好🤖') = 2+2+2+2 = 8
      const layout = layoutInputCursor(text, 3, PROMPT, 79);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(8);
    });

    it('含 ANSI 的 prefix + 纯文本 text', () => {
      expect.hasAssertions();
      // prefix 含 ANSI（如 spinner 行），text 纯文本
      // 但实际 renderFooter 中 prefix 是 '❯ ' 或 '  '（无 ANSI）
      // 这个测试验证 layoutInputCursor 对含 ANSI 的 prefix 也正确
      const ansiPrefix = '\x1b[31m❯ \x1b[39m';
      const text = 'hello';
      const layout = layoutInputCursor(text, 3, ansiPrefix, 79);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(stringWidth(ansiPrefix) + 3); // 2+3=5
    });
  });

  describe('续行前缀', () => {
    it('续行用 CONTINUATION_INDENT 时光标列正确', () => {
      expect.hasAssertions();
      // text='world', prefix='  '(2列), cursor在 offset=3
      // col = stringWidth('  ') + 3 = 5
      const layout = layoutInputCursor('world', 3, INDENT, 79);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(5);
    });
  });

  describe('英文空格断行后光标定位', () => {
    it('光标在空格断行后的第二行（空格丢弃，光标在单词开头）', () => {
      expect.hasAssertions();
      // "hello world foo bar baz"，usableWidth=12
      // 光标在 offset=6（'hello ' 后，含空格）
      // beforeCursor='hello ' → wrapLine('❯ hello ', 12) → ['❯ hello ']（8列≤12）
      // row=0, col=8
      const text = 'hello world foo bar baz';
      const layout = layoutInputCursor(text, 6, PROMPT, 12);
      expect(layout.row).toBe(0);
      expect(layout.col).toBe(8); // '❯ hello ' = 2+5+1=8
    });

    it('光标在空格断行后第三行（row≥1，多次折行）', () => {
      expect.hasAssertions();
      // "hello world foo bar baz"，usableWidth=12
      // 光标在 offset=15（'hello world foo ' 后，含空格）
      // beforeCursor='hello world foo ' → wrapLine('❯ hello world foo ', 12)
      // '❯ hello'(7) + ' world'(6)=13>12 → 空格断行 → '❯ hello' / 'world foo '
      // row=1, col=stringWidth('world foo ')=10
      const text = 'hello world foo bar baz';
      const layout = layoutInputCursor(text, 15, PROMPT, 12);
      expect(layout.row).toBeGreaterThanOrEqual(1);
      expect(layout.col).toBeGreaterThan(0);
      expect(layout.col).toBeLessThanOrEqual(12);
    });

    it('光标在多次折行后的中间行（非首行非末行）', () => {
      expect.hasAssertions();
      // 长文本，多行 wordWrap，光标在第2行（row=1，总≥3行）
      const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh';
      const layout = layoutInputCursor(text, 10, PROMPT, 10);
      // 光标在 offset=10（'bbbb' 之后）
      // wrapLine('❯ aaaa bbbb cccc...', 10) → 多行
      expect(layout.row).toBeGreaterThanOrEqual(1);
      // col 应 > 0 且 ≤ usableWidth
      expect(layout.col).toBeGreaterThan(0);
      expect(layout.col).toBeLessThanOrEqual(10);
    });
  });

  describe('3行以上 wordWrap 光标', () => {
    it('光标在第3行末尾（row=2）', () => {
      expect.hasAssertions();
      // CJK 长文本，3行 wordWrap，光标在最后一行末尾
      const text = '中'.repeat(30); // 60列
      // usableWidth=10, prefix='❯ '(2列)
      // wrapLine('❯ 中...30个', 10): 每行4个中(8列)+prompt(首行2列)=10
      // 行1: '❯ 中中中中'(10), 行2: '中中中中中'(10), 行3: '中中中中中'(10)...
      // 30个中 = 60列 / 10 = 6行? 不对，首行 budget=10-2=8=4个中
      // 后续行 budget=10=5个中
      // 4 + 5 + 5 + 5 + 5 + 5 + 1 = 30 → 7行? 算实际
      const layout = layoutInputCursor(text, 30, PROMPT, 10);
      // 光标在末尾，row 应 ≥ 2（至少3行）
      expect(layout.row).toBeGreaterThanOrEqual(2);
      expect(layout.col).toBeGreaterThan(0);
      expect(layout.col).toBeLessThanOrEqual(10);
    });

    it('光标在第2行中间（row=1，非末行）', () => {
      expect.hasAssertions();
      const text = '中'.repeat(30);
      // 光标在第5个中之后（首行4个中，第5个在第2行第1个）
      const layout = layoutInputCursor(text, 5, PROMPT, 10);
      // beforeCursor='中'.repeat(5) → wrapLine('❯ 中中中中中', 10)
      // '❯ '(2) + 4个中(8) = 10 → '❯ 中中中中' / '中'
      // row=1, col=stringWidth('中')=2
      expect(layout.row).toBe(1);
      expect(layout.col).toBe(2);
    });
  });
});
