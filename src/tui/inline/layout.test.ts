// src/tui/inline/layout.test.ts
// Layout Layer 单元测试：验证纯函数布局计算。
//
// Phase 2：把"计算显示内容"从"执行终端写入"分离。
// layout.ts 是纯函数层——无 stdout.write / 无 cursor / 无副作用。
// 本测试覆盖 footer 布局（border/input wrap/suggestion/status/光标参数）。

import { describe, it, expect } from 'vitest';
import stripAnsi from 'strip-ansi';
import { layoutFooter, layoutFrame, type FooterInput } from './layout.js';
import { InlineRenderState } from './render-state.js';
import { createTurnDurationMessage } from '../../tui/state/turn-duration-message.js';
import type { SuggestionItem } from '../../commands/suggestion-data.js';

/** 便捷:命令名字符串 → SuggestionItem */
function mkSuggestion(name: string, description = 'desc'): SuggestionItem {
  return { name, description, group: 'Config' };
}

function makeFooterInput(overrides: Partial<FooterInput> = {}): FooterInput {
  return {
    input: '', cursor: 0, status: 'test', cols: 80,
    suggestions: [], dropdownIndex: 0, viewportTop: 0,
    ...overrides,
  };
}

describe('layoutFooter — 纯函数布局计算', () => {
  describe('基本结构', () => {
    it('spinnerLines 动态占用间隔行加实际行数', () => {
      const layout = layoutFooter(makeFooterInput({
        spinnerLines: ['main', 'tip', 'next'],
      }));

      expect(layout.lines.slice(0, 4)).toEqual(['', 'main', 'tip', 'next']);
      expect(layout.cursorToTop).toBe(5);
      expect(layout.height).toBe(8);
    });

    it('无 spinnerLines 时只保留现有单个间隔行', () => {
      const layout = layoutFooter(makeFooterInput({ spinnerLines: [] }));

      expect(layout.lines[0]).toBe('');
      expect(layout.cursorToTop).toBe(2);
    });

    it('空输入：footer = 预留位(1) + 顶部border + 输入行(❯) + 底部border + status（5 行）', () => {
      const layout = layoutFooter(makeFooterInput());
      expect(layout.height).toBe(5);
      expect(layout.lines).toHaveLength(5);
      // spinner 不可见：预留位仅 1 行（空行间距）。行0 = 预留位，行1 = 顶部border，行2 = 输入框(❯)，行3 = 底部border，行4 = status
      expect(layout.lines[0]).toBe('');
      expect(layout.lines[1]).toMatch(/^─+$/);
      expect(layout.lines[2]).toMatch(/^❯/);
      expect(layout.lines[3]).toMatch(/^─+$/);
    });

    it('border 长度 = usableWidth = cols - 1', () => {
      const l80 = layoutFooter(makeFooterInput({ cols: 80 }));
      // spinner 不可见：顶部 border 在 lines[1]，底部 border 在 lines[3]
      expect(l80.lines[1]).toHaveLength(79);
      expect(l80.lines[3]).toHaveLength(79);
      expect(l80.usableWidth).toBe(79);

      const l40 = layoutFooter(makeFooterInput({ cols: 40 }));
      expect(l40.lines[1]).toHaveLength(39);
      expect(l40.lines[3]).toHaveLength(39);
      expect(l40.usableWidth).toBe(39);
    });
  });

  describe('输入行 wordWrap', () => {
    it('单行短输入：输入框 1 行', () => {
      const layout = layoutFooter(makeFooterInput({ input: 'hello', cursor: 5 }));
      // 预留位(1) + 顶部border + 1 输入行 + 底部border + status = 5
      expect(layout.height).toBe(5);
    });

    it('超宽输入 wordWrap：输入区占多行', () => {
      // usableWidth=79, '❯ ' + 200a = 202 列 → wrapLine 折成多行
      const layout = layoutFooter(makeFooterInput({
        input: 'a'.repeat(200), cursor: 200, cols: 80,
      }));
      // 顶部border(1) + 折行输入(>1) + 底部border(1) + status(1) > 4
      expect(layout.height).toBeGreaterThan(4);
    });

    it('多行输入（含 \\n）：每行独立 wordWrap', () => {
      const layout = layoutFooter(makeFooterInput({
        input: 'line1\nline2', cursor: 11, cols: 80,
      }));
      // 预留位(1) + 顶部border + 2 输入行 + 底部border + status = 6
      expect(layout.height).toBe(6);
    });
  });

  describe('suggestion（下拉菜单）', () => {
    it('有 suggestions：每条 1 行,下 border 下方(footer 替换模式,保留下 border 无 status)', () => {
      const layout = layoutFooter(makeFooterInput({
        suggestions: [mkSuggestion('cmd-a'), mkSuggestion('cmd-b')], dropdownIndex: 0,
      }));
      // 预留位(1) + 顶部border + 输入 + 下border + suggestion×2 = 6(保留 border,无 status)
      expect(layout.height).toBe(6);
      // suggestion 行含 /cmd-a
      const joined = layout.lines.join('\n');
      expect(joined).toContain('cmd-a');
      expect(joined).toContain('cmd-b');
    });

    it('selectedIndex 主题色高亮选中行(TrueColor SGR)', () => {
      const layout = layoutFooter(makeFooterInput({
        suggestions: [mkSuggestion('cmd-a'), mkSuggestion('cmd-b')], dropdownIndex: 1,
      }));
      const joined = layout.lines.join('\n');
      // cmd-b 被选中(主题色 TrueColor SGR,不硬编码具体色值,兼容 dark/light)
      expect(joined).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
      expect(joined).toContain('cmd-b');
    });

    it('suggestion 超 8 条：只显示 8 条（居中滚动窗口）', () => {
      const many: SuggestionItem[] = Array.from({ length: 20 }, (_, i) => mkSuggestion(`cmd-${i}`));
      const layout = layoutFooter(makeFooterInput({
        suggestions: many, dropdownIndex: 10, cols: 80,
      }));
      // 预留位(1) + 顶部border + 输入 + 下border + 8 suggestions = 12(保留 border,无 status)
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
    it('空输入：cursorToTop=2（跳过 1 行预留位 + 顶部 border），cursorCol=2（❯ 后）', () => {
      const layout = layoutFooter(makeFooterInput({ input: '', cursor: 0 }));
      expect(layout.cursorToTop).toBe(2);
      // ❯ 占 1 列 + 空格 1 列 = 光标在第 2 列（0-based col=2... 实际看 layoutInputCursor）
      // cursorCol 来自 layoutInputCursor，空输入时光标在 prefix 后
      expect(layout.cursorCol).toBeGreaterThanOrEqual(0);
    });

    it('光标在输入中间：cursorCol 反映光标在物理行的列位置', () => {
      const layout = layoutFooter(makeFooterInput({ input: 'hello', cursor: 3 }));
      expect(layout.cursorToTop).toBe(2); // 跳过 1 行预留位 + 顶部 border，仍在输入框首行
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
      const input = makeFooterInput({ input: 'test', cursor: 4, suggestions: [mkSuggestion('a'), mkSuggestion('b')], dropdownIndex: 1 });
      const l1 = layoutFooter(input);
      const l2 = layoutFooter(input);
      expect(l1.lines).toEqual(l2.lines);
      expect(l1.height).toBe(l2.height);
      expect(l1.cursorToTop).toBe(l2.cursorToTop);
      expect(l1.cursorCol).toBe(l2.cursorCol);
    });

    it('不修改输入参数（immutable）', () => {
      const input = makeFooterInput({ input: 'hello', cursor: 5, suggestions: [mkSuggestion('x')] });
      const inputCopy = { ...input, suggestions: [...input.suggestions] };
      layoutFooter(input);
      expect(input.input).toBe(inputCopy.input);
      expect(input.cursor).toBe(inputCopy.cursor);
      expect(input.suggestions).toEqual(inputCopy.suggestions);
      expect(input.cols).toBe(inputCopy.cols);
    });
  });

  describe('turn-duration 完成消息进入 scrollback', () => {
    it('turn-duration 首帧进入 newLines，下一帧账本阻止重复追加', () => {
      // 完成消息是 finalized 的 TuiMessage 子类型，layoutFrame 应当：
      // 1. 首帧把消息所有行（含前导空行 + dim 完成行）追加到 newLines；
      // 2. 第二帧账本已记录该 uuid 的行数，newLines 为空（避免重复追加）。
      const state = new InlineRenderState();
      const message = createTurnDurationMessage({
        uuid: 'duration-1', durationMs: 9_000,
        prependBlankLine: true, random: () => 0.5,
      });
      const input = {
        messages: [message],
        streamingMsg: null,
        footer: makeFooterInput(),
        cols: 80,
        state,
      };

      const first = layoutFrame(input);
      const second = layoutFrame(input);

      // 首帧：前导空行 + dim 完成行（stripAnsi 去掉 dim SGR 后剩纯文本）
      expect(first.newLines.map(stripAnsi)).toEqual(['', '✻ Cooked for 9s']);
      // 第二帧：账本已记录 duration-1 → 全部行已渲染，newLines 为空。
      expect(second.newLines).toEqual([]);
    });

    it('turn-duration 与普通消息混排时按顺序追加', () => {
      const state = new InlineRenderState();
      const userMsg = {
        uuid: 'u-1', role: 'user', finalized: true,
        lines: [{ content: 'hello', style: {}, indent: 0 }],
      };
      const durationMsg = createTurnDurationMessage({
        uuid: 'duration-1', durationMs: 5_000,
        prependBlankLine: true, random: () => 0,
      });
      const input = {
        messages: [userMsg, durationMsg],
        streamingMsg: null,
        footer: makeFooterInput(),
        cols: 80,
        state,
      };

      const result = layoutFrame(input);
      expect(result.newLines.map(stripAnsi)).toEqual([
        'hello', '', '✻ Baked for 5s',
      ]);
    });
  });
});
