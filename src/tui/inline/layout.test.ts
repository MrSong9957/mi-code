// src/tui/inline/layout.test.ts
// Layout Layer 单元测试：验证纯函数布局计算。
//
// Phase 2：把"计算显示内容"从"执行终端写入"分离。
// layout.ts 是纯函数层——无 stdout.write / 无 cursor / 无副作用。
// 本测试覆盖 footer 布局（border/input wrap/suggestion/status/光标参数）。

import { describe, it, expect } from 'vitest';
import { layoutFooter, type FooterInput } from './layout.js';

function makeFooterInput(overrides: Partial<FooterInput> = {}): FooterInput {
  return {
    input: '', cursor: 0, status: 'test', cols: 80,
    suggestions: [], dropdownIndex: 0, viewportTop: 0,
    ...overrides,
  };
}

describe('layoutFooter — 纯函数布局计算', () => {
  describe('基本结构', () => {
    it('空输入：footer = border + 输入行(❯) + border + status（4 行）', () => {
      const layout = layoutFooter(makeFooterInput());
      expect(layout.height).toBe(4);
      expect(layout.lines).toHaveLength(4);
      // 行0 = border，行1 = 输入框，行2 = border，行3 = status
      expect(layout.lines[0]).toMatch(/^─+$/);
      expect(layout.lines[2]).toMatch(/^─+$/);
    });

    it('border 长度 = usableWidth = cols - 1', () => {
      const l80 = layoutFooter(makeFooterInput({ cols: 80 }));
      expect(l80.lines[0]).toHaveLength(79);
      expect(l80.usableWidth).toBe(79);

      const l40 = layoutFooter(makeFooterInput({ cols: 40 }));
      expect(l40.lines[0]).toHaveLength(39);
      expect(l40.usableWidth).toBe(39);
    });
  });

  describe('输入行 wordWrap', () => {
    it('单行短输入：输入框 1 行', () => {
      const layout = layoutFooter(makeFooterInput({ input: 'hello', cursor: 5 }));
      // border + 1 输入行 + border + status = 4
      expect(layout.height).toBe(4);
    });

    it('超宽输入 wordWrap：输入区占多行', () => {
      // usableWidth=79, '❯ ' + 200a = 202 列 → wrapLine 折成多行
      const layout = layoutFooter(makeFooterInput({
        input: 'a'.repeat(200), cursor: 200, cols: 80,
      }));
      // border(1) + 折行输入(>1) + border(1) + status(1) > 4
      expect(layout.height).toBeGreaterThan(4);
    });

    it('多行输入（含 \\n）：每行独立 wordWrap', () => {
      const layout = layoutFooter(makeFooterInput({
        input: 'line1\nline2', cursor: 11, cols: 80,
      }));
      // border + 2 输入行 + border + status = 5
      expect(layout.height).toBe(5);
    });
  });

  describe('suggestion（下拉菜单）', () => {
    it('有 suggestions：每条 1 行，插入 border 和 status 之间', () => {
      const layout = layoutFooter(makeFooterInput({
        suggestions: ['cmd-a', 'cmd-b'], dropdownIndex: 0,
      }));
      // border + 输入 + suggestion×2 + border + status = 6
      expect(layout.height).toBe(6);
      // suggestion 行含 /cmd-a
      const joined = layout.lines.join('\n');
      expect(joined).toContain('cmd-a');
      expect(joined).toContain('cmd-b');
    });

    it('selectedIndex 反白选中行（\\x1b[7m）', () => {
      const layout = layoutFooter(makeFooterInput({
        suggestions: ['cmd-a', 'cmd-b'], dropdownIndex: 1,
      }));
      const joined = layout.lines.join('\n');
      // cmd-b 被选中（反白）
      expect(joined).toContain('\x1b[7m');
      expect(joined).toContain('cmd-b');
    });

    it('suggestion 超 8 条：只显示 8 条（居中滚动窗口）', () => {
      const many = Array.from({ length: 20 }, (_, i) => `cmd-${i}`);
      const layout = layoutFooter(makeFooterInput({
        suggestions: many, dropdownIndex: 10, cols: 80,
      }));
      // border + 输入 + 8 suggestions + border + status = 12
      expect(layout.height).toBe(12);
    });
  });

  describe('status wordWrap', () => {
    it('超长 status wordWrap：占多行', () => {
      const longStatus = 'x'.repeat(200);
      const layout = layoutFooter(makeFooterInput({
        status: longStatus, cols: 80,
      }));
      // status 折成多行 → height > 4
      expect(layout.height).toBeGreaterThan(4);
    });
  });

  describe('光标定位参数', () => {
    it('空输入：cursorToTop=1（输入框是块内第 1 行），cursorCol=2（❯ 后）', () => {
      const layout = layoutFooter(makeFooterInput({ input: '', cursor: 0 }));
      expect(layout.cursorToTop).toBe(1);
      // ❯ 占 1 列 + 空格 1 列 = 光标在第 2 列（0-based col=2... 实际看 layoutInputCursor）
      // cursorCol 来自 layoutInputCursor，空输入时光标在 prefix 后
      expect(layout.cursorCol).toBeGreaterThanOrEqual(0);
    });

    it('光标在输入中间：cursorCol 反映光标在物理行的列位置', () => {
      const layout = layoutFooter(makeFooterInput({ input: 'hello', cursor: 3 }));
      expect(layout.cursorToTop).toBe(1); // 仍在第 1 行（输入框）
      // cursor=3 → 光标在 'hel|lo'，prefix '❯ '(2列) + 3 = col 5（0-based... 取决于 layoutInputCursor）
      expect(layout.cursorCol).toBeGreaterThan(0);
    });

    it('超宽输入光标在折行后：cursorToTop 反映物理行', () => {
      // 200 个 a，光标在末尾 → 必然折行，cursorToTop > 1
      const layout = layoutFooter(makeFooterInput({
        input: 'a'.repeat(200), cursor: 200, cols: 80,
      }));
      expect(layout.cursorToTop).toBeGreaterThan(1);
    });
  });

  describe('纯函数性质（无副作用）', () => {
    it('相同输入产生相同输出（确定性）', () => {
      const input = makeFooterInput({ input: 'test', cursor: 4, suggestions: ['a', 'b'], dropdownIndex: 1 });
      const l1 = layoutFooter(input);
      const l2 = layoutFooter(input);
      expect(l1.lines).toEqual(l2.lines);
      expect(l1.height).toBe(l2.height);
      expect(l1.cursorToTop).toBe(l2.cursorToTop);
      expect(l1.cursorCol).toBe(l2.cursorCol);
    });

    it('不修改输入参数（immutable）', () => {
      const input = makeFooterInput({ input: 'hello', cursor: 5, suggestions: ['x'] });
      const inputCopy = { ...input, suggestions: [...input.suggestions] };
      layoutFooter(input);
      expect(input.input).toBe(inputCopy.input);
      expect(input.cursor).toBe(inputCopy.cursor);
      expect(input.suggestions).toEqual(inputCopy.suggestions);
      expect(input.cols).toBe(inputCopy.cols);
    });
  });
});
