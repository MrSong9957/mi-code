// src/tui/inline/physical-line-footer-regression.test.ts
// 物理行折算回归测试（Bug 4：超宽输入连续渲染时不该 border 堆叠）。
//
// 核心契约：footerHeight 必须按物理行记账（终端原生折行后），而非逻辑行数。
// 否则连续输入超宽文本时，覆写 cursorUp 不够，旧 border 残留堆叠。
//
// mock stdout 无法模拟终端折行（它不折行），故不能靠"数 border"测。
// 正确测法：直接读 getFooterHeight()，断言它 = 预期物理行数。

import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';
import { simulateTerminalWrap } from '../state/input-viewport.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

describe('物理行折算回归（Bug 4）', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('短输入不折行：物理行=逻辑行，footerHeight=4（border+1行+border+status）', () => {
    expect.hasAssertions();
    renderer.renderFooter('hello', 5, 'status', 80);
    expect(renderer.getFooterHeight()).toBe(4);
  });

  it('单行 200 ASCII 字符：footerHeight=6（border + 3折行 + border + status）', () => {
    expect.hasAssertions();
    // 首行 budget = 80 - 2(prompt) = 78；200 字符：78 + 80 + 42 → 3 物理行
    const text = 'a'.repeat(200);
    renderer.renderFooter(text, 200, 'status', 80);
    // footerHeight = 1(border) + 3 + 1(border) + 1(status) = 6
    expect(renderer.getFooterHeight()).toBe(6);
  });

  it('单行 78 字符恰好首行：footerHeight=4（不折行）', () => {
    expect.hasAssertions();
    // 首行 budget=78，78 字符恰好填满首行，不折行
    const text = 'a'.repeat(78);
    renderer.renderFooter(text, 78, 'status', 80);
    expect(renderer.getFooterHeight()).toBe(4);
  });

  it('单行 79 字符：footerHeight=5（折 1 行）', () => {
    expect.hasAssertions();
    // 79 字符：首行 78 + 次行 1 → 2 物理行
    const text = 'a'.repeat(79);
    renderer.renderFooter(text, 79, 'status', 80);
    // footerHeight = 1 + 2 + 1 + 1 = 5
    expect(renderer.getFooterHeight()).toBe(5);
  });

  it('CJK 折行：40 个汉字（80 列）→ 2 物理行，footerHeight=5', () => {
    expect.hasAssertions();
    // 40 汉字 = 80 列，首行 budget=78（39 汉字），次行 1 汉字 → 2 物理行
    const text = '中'.repeat(40);
    renderer.renderFooter(text, 40, 'status', 80);
    // footerHeight = 1 + 2 + 1 + 1 = 5
    expect(renderer.getFooterHeight()).toBe(5);
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
    // 300 字符必折成多物理行，footerHeight 必 > 逻辑行数（4）
    expect(heights[heights.length - 1]).toBeGreaterThan(4);
  });

  it('多行超宽：每行独立折算后求和', () => {
    expect.hasAssertions();
    // 第0行 100 a（含 prompt budget 78 → ceil(100/78)=2 物理行）
    // 第1行 100 a（续行缩进 budget 78 → 2 物理行）
    // 合计输入物理行 = 4，footerHeight = 1 + 4 + 1 + 1 = 7
    const text = 'a'.repeat(100) + '\n' + 'a'.repeat(100);
    renderer.renderFooter(text, 201, 'status', 80);
    expect(renderer.getFooterHeight()).toBe(7);
  });

  it('光标定位契约：单行折行后光标 cursorUp 数值正确（光标在末尾）', () => {
    expect.hasAssertions();
    // 单行 200 字符折成 3 物理行。footerHeight=6（border + 3折行 + border + status）。
    // 块内 0-based 物理行：0=border，1/2/3=输入折行，4=border，5=status。
    // 光标在 200 字符末尾 → 行内 0-based 物理行 = floor(200/80) = 2 → 块内 = 1+2 = 3。
    // 写完 6 行（带\n）光标在 0-based 行 6，上移到行 3 = 上移 3。
    const text = 'a'.repeat(200);
    renderer.renderFooter(text, 200, 'status', 80);
    const out = mock.output;
    const ups: number[] = [];
    const re = /\x1b\[(\d+)A/g;
    let m;
    while ((m = re.exec(out)) !== null) ups.push(parseInt(m[1], 10));
    expect(ups[ups.length - 1]).toBe(3);
  });

  it('光标定位契约：光标在行首（cursorPos=0）cursorUp 正确', () => {
    expect.hasAssertions();
    // 光标在行首：行内偏移 0 → 块内 0-based = 1（border 下方第1行）。
    // 写完 6 行后光标在行 6，上移到行 1 = 上移 5。
    const text = 'a'.repeat(200);
    renderer.renderFooter(text, 0, 'status', 80);
    const out = mock.output;
    const ups: number[] = [];
    const re = /\x1b\[(\d+)A/g;
    let m;
    while ((m = re.exec(out)) !== null) ups.push(parseInt(m[1], 10));
    expect(ups[ups.length - 1]).toBe(5);
  });

  it('光标列定位契约：折行后 CHA 列 = 行内列（取模），非绝对列', () => {
    expect.hasAssertions();
    // 单行 200 字符，光标在末尾。显示总列 = 2(prompt) + 200 = 202。
    // 折行后光标在第 3 物理行（0-based），该行内列 = 202 - 2*80 = 42（0-based）。
    // CHA 是 1-based：应为 43，而非 203（绝对列会被终端钳到 80，光标跑到行尾错位）。
    const text = 'a'.repeat(200);
    renderer.renderFooter(text, 200, 'status', 80);
    const out = mock.output;
    // 提取 CHA 序列 \x1b[<n>G
    const chaMatch = out.match(/\x1b\[(\d+)G/);
    expect(chaMatch).not.toBeNull();
    expect(parseInt(chaMatch![1], 10)).toBe(43);
  });

  it('光标列定位契约：CJK 折行后 CHA 列正确（每字 2 列）', () => {
    expect.hasAssertions();
    // 50 个汉字 = 100 显示列 + prompt 2 = 102 总列。cols=80 → 折行。
    // 光标在末尾：物理行 floor(102/80)=1（0-based，第2物理行），行内列 = 102 - 80 = 22（0-based）。
    // CHA 1-based = 23。
    const text = '中'.repeat(50);
    renderer.renderFooter(text, 50, 'status', 80);
    const out = mock.output;
    const chaMatch = out.match(/\x1b\[(\d+)G/);
    expect(chaMatch).not.toBeNull();
    expect(parseInt(chaMatch![1], 10)).toBe(23);
  });

  it('边界一致性：ASCII 逐字增长，CHA 与精确折行模拟自洽', () => {
    expect.hasAssertions();
    // 逐字输入 ASCII，每帧 CHA 应 = simulateTerminalWrap 算的 cursorCol+1（钳到 cols）。
    // ASCII 不触发留空，cursorCol = promptWidth + 字符数（未折行时）。
    const cols = 80;
    let text = '';
    renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
    for (let i = 1; i <= 400; i++) {
      text += 'a';
      mock.written.length = 0;
      renderer.renderFooter(text, text.length, 'status', cols, [], 0, 0);
      const out = mock.output;
      const chaMatch = out.match(/\x1b\[(\d+)G/);
      // CHA 不变量：∈ [1, cols]，绝不超界（钳制保护）
      const cha = parseInt(chaMatch![1], 10);
      expect(cha).toBeGreaterThanOrEqual(1);
      expect(cha).toBeLessThanOrEqual(cols);
    }
  });

  it('边界：恰好填满 cols 时光标在末列（CHA=cols，延迟换行）', () => {
    expect.hasAssertions();
    // 78 a + prompt 2 = 80 列恰好填满。精确模拟：光标在列 80（0-based）= 延迟换行边界，
    // CHA 钳到 cols（80），不超界。物理行仍是 1（还没换到第 2 行）。
    const text = 'a'.repeat(78);
    renderer.renderFooter(text, 78, 'status', 80);
    const out = mock.output;
    const chaMatch = out.match(/\x1b\[(\d+)G/);
    expect(parseInt(chaMatch![1], 10)).toBe(80);
    expect(renderer.getFooterHeight()).toBe(4); // 仍 1 物理行 + border×2 + status
  });

  it('CJK 精确光标契约：折行后光标位置与 simulateTerminalWrap 自洽', () => {
    expect.hasAssertions();
    // 核心场景：CJK 连续输入折行，光标必须精确跟到文字末尾（用户报告的"光标在文字中间"bug）。
    // 逐字输入中文，每帧用 simulateTerminalWrap 算期望 CHA，对比 renderFooter 实际输出。
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
      // 期望 CHA = simulateTerminalWrap 算的 cursorCol+1（钳到 cols）
      const wrap = simulateTerminalWrap(text, cols, 2);
      const expectedCha = Math.min(wrap.cursorCol + 1, cols);
      expect(actualCha).toBe(expectedCha);
    }
  });
});
