// src/tui/inline/physical-line-footer-regression.test.ts
// 物理行折算回归测试（Bug 4：超宽输入连续渲染时不该 border 堆叠）。
//
// 核心契约：footerHeight 必须按物理行记账，而非逻辑行数。
// 否则连续输入超宽文本时，覆写 cursorUp 不够，旧 border 残留堆叠。
//
// 当前模型（DECAWM OFF + 应用层 wordWrap）：
// - InlineRenderer constructor 写 \x1b[?7l（DECAWM OFF），终端不再自动折行。
// - 每个输入行用 wrapLine(prefix + content, usableWidth) 折行（不截断）。
// - usableWidth = cols - 1（留 1 安全列）。
// - footerHeight = lines.length（间隔行(1) + 顶部border + 折行后输入行 + 底部border + 折行后 status）。
//   无 spinner 时 reserveRows = 1（仅一个间隔空行）。
// - 物理行 = 应用层折出的行（完全可控，不再依赖终端折行或 simulateTerminalWrap）。
//
// mock stdout 无法模拟终端折行（它不折行），故不能靠"数 border"测。
// 正确测法：直接读 getFooterHeight()，断言它 = 预期物理行数。
// 预期值用 wrapLine 现场算（与 renderer 同一算法），不硬编码魔术数字。

import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';
import { wrapLine, getUsableWidth } from '../state/wrap-line.js';
import { layoutInputCursor } from '../state/layout-cursor.js';

const PROMPT = '❯ ';
const CONTINUATION_INDENT = '  ';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

/**
 * 复刻 InlineRenderer.renderFooter 的行数算法（无 suggestions，viewportTop=0）。
 * 用 wrapLine 现场算预期 footerHeight，避免硬编码。
 *
 * 行序：间隔行(1) / 顶部border / wrapLine(prefix+每输入行) / 底部border / wrapLine(status)
 * （footer 顶部 1 行间隔 + 顶部 border + 底部 border，共 2 个 border）
 */
function expectedFooterHeight(input: string, statusText: string, cols: number): number {
  const usableWidth = getUsableWidth(cols);
  const border = '─'.repeat(usableWidth);
  const inputLines = input.split('\n');
  const lines: string[] = ['', border]; // 间隔行(1) + 顶部 border
  for (let i = 0; i < inputLines.length; i++) {
    const prefix = i === 0 ? PROMPT : CONTINUATION_INDENT;
    lines.push(...wrapLine(prefix + inputLines[i]!, usableWidth));
  }
  lines.push(border); // 底部 border
  lines.push(...wrapLine(statusText, usableWidth));
  return lines.length;
}

/**
 * 复刻 InlineRenderer.renderFooter 的光标 cursorUp 值（append 模式，footerHeight 从 0 开始）。
 * writtenLineCount = newHeight；cursorPhysLine0 = 2(间隔行1 + 顶部border1) + layout.row；
 * upFromBottom = writtenLineCount - cursorPhysLine0。
 */
function expectedCursorUp(input: string, cursorPos: number, statusText: string, cols: number): number {
  const usableWidth = getUsableWidth(cols);
  const h = expectedFooterHeight(input, statusText, cols);
  const layout = layoutInputCursor(input, cursorPos, PROMPT, usableWidth);
  return h - (2 + layout.row);
}

/**
 * 复刻 InlineRenderer.renderFooter 的光标 CHA 值（1-based，钳到 usableWidth）。
 */
function expectedCha(input: string, cursorPos: number, cols: number): number {
  const usableWidth = getUsableWidth(cols);
  const layout = layoutInputCursor(input, cursorPos, PROMPT, usableWidth);
  return Math.min(layout.col + 1, usableWidth);
}

describe('物理行折算回归（Bug 4）', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('短输入不折行：物理行=逻辑行，footerHeight=4（间隔1+1行+border+status）', () => {
    expect.hasAssertions();
    renderer.renderFooter('hello', 5, 'status', 80);
    // wrapLine('❯ hello', 79) = 1 行；wrapLine('status', 79) = 1 行
    // footerHeight = 间隔(1) + 1 + 1(border) + 1 = 4
    expect(renderer.getFooterHeight()).toBe(expectedFooterHeight('hello', 'status', 80));
  });

  it('单行 200 ASCII 字符：wordWrap 后多行，footerHeight 用 wrapLine 算', () => {
    expect.hasAssertions();
    // DECAWM OFF + 应用层 wordWrap：超宽内容换行显示（不截断）。
    // usableWidth=79，prompt '❯ '（宽 2）+ 200a 共 202 列，wrapLine 折成多行。
    // 不再是"截断到 1 物理行"——完整内容全显示。
    const text = 'a'.repeat(200);
    renderer.renderFooter(text, 200, 'status', 80);
    const expected = expectedFooterHeight(text, 'status', 80);
    expect(renderer.getFooterHeight()).toBe(expected);
  });

  it('单行 78 字符：prompt+内容超 usableWidth 折行（wordWrap），footerHeight 用 wrapLine 算', () => {
    expect.hasAssertions();
    // usableWidth=79。'❯ '（宽 2）+ 78a（宽 78）= 80 > 79，触发折行。
    // wrapLine 按空格断行：'❯ ' 的空格是单词边界 → '❯'(宽1) 单独成行，78a 成第 2 行。
    const text = 'a'.repeat(78);
    renderer.renderFooter(text, 78, 'status', 80);
    expect(renderer.getFooterHeight()).toBe(expectedFooterHeight(text, 'status', 80));
  });

  it('单行 79 字符：prompt+内容超 usableWidth 折行（wordWrap），footerHeight 用 wrapLine 算', () => {
    expect.hasAssertions();
    // '❯ ' + 79a = 81 列 > 79，折行：'❯'（宽1）+ 79a（宽79，恰好 usableWidth）→ 2 行
    const text = 'a'.repeat(79);
    renderer.renderFooter(text, 79, 'status', 80);
    expect(renderer.getFooterHeight()).toBe(expectedFooterHeight(text, 'status', 80));
  });

  it('CJK 折行：40 个汉字（80 列）wordWrap 后多行，footerHeight 用 wrapLine 算', () => {
    expect.hasAssertions();
    // usableWidth=79。'❯ '（宽 2）+ 40 中（宽 80）= 82 > 79。
    // CJK 无空格，按字符级断行：'❯'(1) + 空(1)… 实际 wrapLine('❯ '+40中, 79) = 3 行。
    const text = '中'.repeat(40);
    renderer.renderFooter(text, 40, 'status', 80);
    expect(renderer.getFooterHeight()).toBe(expectedFooterHeight(text, 'status', 80));
  });

  it('连续增长不变量：字符越多 footerHeight 单调非减', () => {
    expect.hasAssertions();
    let text = '';
    renderer.renderFooter('', 0, 'status', 80);
    const heights: number[] = [renderer.getFooterHeight()];
    for (let i = 0; i < 300; i++) {
      text += 'a';
      renderer.renderFooter(text, text.length, 'status', 80);
      heights.push(renderer.getFooterHeight());
    }
    // 不变量：单调非减（物理行不会随字符增加而减少）
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]!);
    }
    // 末值用 wrapLine 算（不硬编码）：300a 折行后多行
    expect(heights[heights.length - 1]).toBe(expectedFooterHeight('a'.repeat(300), 'status', 80));
  });

  it('多行超宽：每行独立 wordWrap 后求和', () => {
    expect.hasAssertions();
    // 两逻辑行各 100a：每行 wrapLine(prefix+100a, 79) 折成 3 行（prefix+100a 超 usableWidth）。
    // footerHeight = 间隔(1) + 行0折行数 + 行1折行数 + 1(border) + 1(status)
    const text = 'a'.repeat(100) + '\n' + 'a'.repeat(100);
    renderer.renderFooter(text, 201, 'status', 80);
    expect(renderer.getFooterHeight()).toBe(expectedFooterHeight(text, 'status', 80));
  });

  it('光标定位契约：单行 wordWrap 后光标 cursorUp 数值正确（光标在末尾）', () => {
    expect.hasAssertions();
    // 200a wordWrap 成 4 行（块内 0-based 物理：0=间隔，1..4=输入行，5=border，6=status）。
    // 光标在 200 字符末尾，layoutInputCursor 算得 row=3 → 块内 = 2+3 = 5。
    // footerHeight=7，append 模式 writtenLineCount=7，上移 = 7-5 = 2。
    const text = 'a'.repeat(200);
    renderer.renderFooter(text, 200, 'status', 80);
    const out = mock.output;
    const ups: number[] = [];
    const re = /\x1b\[(\d+)A/g;
    let m;
    while ((m = re.exec(out)) !== null) ups.push(parseInt(m[1], 10));
    expect(ups[ups.length - 1]).toBe(expectedCursorUp(text, 200, 'status', 80));
  });

  it('光标定位契约：光标在行首（cursorPos=0）cursorUp 正确（wordWrap 后）', () => {
    expect.hasAssertions();
    // 光标在行首：layoutInputCursor 算得 row=0 → 块内 = 2（间隔1 + 顶部border1 + 输入首行）。
    // footerHeight=7，append 模式 writtenLineCount=7，上移 = 7-2 = 5。
    const text = 'a'.repeat(200);
    renderer.renderFooter(text, 0, 'status', 80);
    const out = mock.output;
    const ups: number[] = [];
    const re = /\x1b\[(\d+)A/g;
    let m;
    while ((m = re.exec(out)) !== null) ups.push(parseInt(m[1], 10));
    expect(ups[ups.length - 1]).toBe(expectedCursorUp(text, 0, 'status', 80));
  });

  it('光标列定位契约：wordWrap 后光标在末尾，CHA 用 layoutInputCursor 算（钳到 usableWidth）', () => {
    expect.hasAssertions();
    // 200a wordWrap 成 4 行（displayWidth [1, 79, 79, 42]）。光标在末尾：row=3, col=42。
    // CHA = min(col+1, usableWidth) = min(43, 79) = 43。
    // 注意：DECAWM OFF 后不再"恰好填满 cols"——wordWrap 保证每行 ≤ usableWidth=79，
    // 故 CHA ∈ [1, 79]，永远不会到 80。
    const text = 'a'.repeat(200);
    renderer.renderFooter(text, 200, 'status', 80);
    const out = mock.output;
    const chaMatch = out.match(/\x1b\[(\d+)G/);
    expect(chaMatch).not.toBeNull();
    expect(parseInt(chaMatch![1], 10)).toBe(expectedCha(text, 200, 80));
  });

  it('光标列定位契约：CJK wordWrap 后光标在末尾，CHA 用 layoutInputCursor 算', () => {
    expect.hasAssertions();
    // 50 个汉字：wrapLine('❯ '+50中, 79) = 3 行（displayWidth [1, 78, 22]）。
    // 光标在末尾：row=2, col=22。CHA = min(23, 79) = 23。
    const text = '中'.repeat(50);
    renderer.renderFooter(text, 50, 'status', 80);
    const out = mock.output;
    const chaMatch = out.match(/\x1b\[(\d+)G/);
    expect(chaMatch).not.toBeNull();
    expect(parseInt(chaMatch![1], 10)).toBe(expectedCha(text, 50, 80));
  });

  it('边界一致性：ASCII 逐字增长，CHA 与 layoutInputCursor 自洽（不超 usableWidth）', () => {
    expect.hasAssertions();
    // 逐字输入 ASCII，每帧 CHA 应 = layoutInputCursor 算的 col+1（钳到 usableWidth）。
    const cols = 80;
    const usableWidth = getUsableWidth(cols);
    let text = '';
    renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
    for (let i = 1; i <= 400; i++) {
      text += 'a';
      mock.written.length = 0;
      renderer.renderFooter(text, text.length, 'status', cols, [], 0, 0);
      const out = mock.output;
      const chaMatch = out.match(/\x1b\[(\d+)G/);
      // CHA 不变量：∈ [1, usableWidth]（wordWrap 保证，不超界）
      const cha = parseInt(chaMatch![1], 10);
      expect(cha).toBeGreaterThanOrEqual(1);
      expect(cha).toBeLessThanOrEqual(usableWidth);
      expect(cha).toBe(expectedCha(text, text.length, cols));
    }
  });

  it('边界：prompt+内容触发折行后光标在续行（CHA 跟随 wordWrap 布局）', () => {
    expect.hasAssertions();
    // 78a：'❯ ' + 78a = 80 列 > usableWidth(79)，wordWrap 折成 2 行（'❯' / 78a）。
    // 光标在末尾：row=1, col=78。CHA = min(79, 79) = 79（恰好 usableWidth）。
    // 不再是"恰好填满 cols=80 延迟换行"——DECAWM OFF + wordWrap 后每行 ≤ 79。
    const text = 'a'.repeat(78);
    renderer.renderFooter(text, 78, 'status', 80);
    const out = mock.output;
    const chaMatch = out.match(/\x1b\[(\d+)G/);
    expect(parseInt(chaMatch![1], 10)).toBe(expectedCha(text, 78, 80));
    expect(renderer.getFooterHeight()).toBe(expectedFooterHeight(text, 'status', 80));
  });

  it('CJK 精确光标契约：wordWrap 后光标位置与 layoutInputCursor 自洽', () => {
    expect.hasAssertions();
    // 核心场景：CJK 连续输入，光标必须精确跟到文字末尾（用户报告的"光标在文字中间"bug）。
    // 逐字输入中文，每帧用 layoutInputCursor 算期望 CHA，对比 renderFooter 实际输出。
    // DECAWM OFF 后光标位置完全由应用层 wordWrap 决定，不再依赖 simulateTerminalWrap。
    const cols = 80;
    let text = '';
    renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
    for (let i = 1; i <= 90; i++) {
      text += '中';
      mock.written.length = 0;
      renderer.renderFooter(text, text.length, 'status', cols, [], 0, 0);
      const out = mock.output;
      const chaMatch = out.match(/\x1b\[(\d+)G/);
      const actualCha = parseInt(chaMatch![1], 10);
      expect(actualCha).toBe(expectedCha(text, text.length, cols));
    }
  });
});
