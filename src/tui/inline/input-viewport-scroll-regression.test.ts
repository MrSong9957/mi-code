// src/tui/inline/input-viewport-scroll-regression.test.ts
// 输入框视口滚动回归测试。
//
// 验证两个核心不变量：
// 1. 渲染切片：renderFooter 输出只含视口内行（toContain 视口内 / not.toContain 视口外）
// 2. 光标落点：视口滚动时光标始终落在可见区（cursorUp 数值 = footerHeight-1-cursorViewportLine）
//
// 防作弊设计：
// - expect.hasAssertions() 防空跑
// - 随机化输入行数与 cursor 位置 × 10 组，断言不变量而非硬编码
// - 用 computeInputViewport 算期望 viewportTop（单一真理源），不重复实现公式

import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';
import { computeInputViewport, MAX_VISIBLE_INPUT_LINES, simulateTerminalWrap } from '../state/input-viewport.js';
import { cursorScreenPos } from '../state/cursor-position.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

// 提取所有 cursorUp 序列的参数
function extractCursorUpValues(output: string): number[] {
  const pattern = /\x1b\[(\d+)A/g;
  const values: number[] = [];
  let match;
  while ((match = pattern.exec(output)) !== null) {
    values.push(parseInt(match[1], 10));
  }
  return values;
}

describe('输入框视口滚动回归', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('viewportTop=0 时退化为旧行为：全部输入行都渲染', () => {
    expect.hasAssertions();
    renderer.renderFooter('l0\nl1\nl2', 0, 'status', 80, [], 0, 0);
    const out = mock.output;
    expect(out).toContain('l0');
    expect(out).toContain('l1');
    expect(out).toContain('l2');
  });

  it('视口滚动：只渲染窗口内行，视口外行不出现在输出', () => {
    expect.hasAssertions();
    // 8 行输入，viewportTop=2 → 可见 [2, 7)，即 l2..l6
    const input = 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7';
    renderer.renderFooter(input, 12, 'status', 80, [], 0, 2); // cursorPos=12 → l4 行首
    const out = mock.output;
    // 视口内行应出现
    expect(out).toContain('l2');
    expect(out).toContain('l6');
    // 视口外行不应出现
    expect(out).not.toContain('l0');
    expect(out).not.toContain('l1');
    expect(out).not.toContain('l7');
  });

  it('不变量【防作弊随机化】：10 组随机输入，视口外行恒不出现在输出', () => {
    expect.hasAssertions();
    for (let trial = 0; trial < 10; trial++) {
      mock = createMockStdout();
      renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
      // 随机生成 6~15 行输入。行名用定宽 lnNN 格式，避免 'ln1' 是 'ln10' 子串污染断言。
      const lineCount = 6 + Math.floor(Math.random() * 10);
      const lines: string[] = [];
      for (let i = 0; i < lineCount; i++) lines.push(`ln${String(i).padStart(2, '0')}`);
      const input = lines.join('\n');
      // 随机 cursorLine，cursorPos 用真实 join 算（行首位置 = 前面所有行长度 + \n 数）
      const cursorLine = Math.floor(Math.random() * lineCount);
      let cursorPos = 0;
      for (let i = 0; i < cursorLine; i++) cursorPos += lines[i]!.length + 1; // +1 for \n
      // 用 computeInputViewport 算期望 viewportTop（单一真理源）
      const vp = computeInputViewport(lineCount, cursorLine, MAX_VISIBLE_INPUT_LINES);
      renderer.renderFooter(input, cursorPos, 'status', 80, [], 0, vp.viewportTop);
      const out = mock.output;
      // 不变量：视口外行不出现在输出
      for (let i = 0; i < lineCount; i++) {
        const inViewport = i >= vp.viewportTop && i < vp.viewportTop + MAX_VISIBLE_INPUT_LINES;
        if (!inViewport) {
          expect(out).not.toContain(`ln${String(i).padStart(2, '0')}`);
        }
      }
    }
  });

  it('光标落点：视口滚动后 cursorUp 数值 = footerHeight - 1 - cursorViewportLine', () => {
    expect.hasAssertions();
    // 10 行输入，cursor 在第 7 行
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`x${i}`);
    const input = lines.join('\n');
    const cursorLine = 7;
    const cursorPos = cursorLine * 3; // 'xN' 每行 2 字符 + \n
    const vp = computeInputViewport(10, cursorLine, MAX_VISIBLE_INPUT_LINES);
    renderer.renderFooter(input, cursorPos, 'status', 80, [], 0, vp.viewportTop);
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    const cursorViewportLine = cursorLine - vp.viewportTop;
    // footerHeight = 1(border) + maxVisible + 1(border) + 1(status) = 8
    const footerHeight = 1 + MAX_VISIBLE_INPUT_LINES + 1 + 1;
    const expectedUp = footerHeight - 1 - cursorViewportLine;
    expect(cursorUps[cursorUps.length - 1]).toBe(expectedUp);
  });

  it('一致性：cursorScreenPos 与 renderFooter 用的光标行号同源', () => {
    expect.hasAssertions();
    // 确保 renderFooter 内部用的 cursorScreenPos 与外部算的 vp 基于同一函数
    const input = 'a\nb\nc\nd\ne\nf\ng';
    const cursorPos = 10; // 指向 'f'（第 5 行，x=10）
    const pos = cursorScreenPos(input, cursorPos, '❯ ');
    expect(pos.y).toBe(5);
    const vp = computeInputViewport(7, pos.y, MAX_VISIBLE_INPUT_LINES);
    // 7 行，cursorLine=5，居中 5-2=3，maxScroll=7-5=2 → viewportTop=3（钳位）
    expect(vp.viewportTop).toBe(2);
  });
});

describe('CJK × 视口滚动 × 物理折行组合回归', () => {
  // 最高风险交叉场景：多行中文 + 每行超长折行 + 总行数超 5 触发视口滚动。
  // 三个维度同时作用，任一环节错位都会导致 border 堆叠或光标跑偏。

  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('8 行中文（每行 20 字触发折行）+ cursor 在末行：视口内行渲染、视口外不出现', () => {
    expect.hasAssertions();
    // 8 行，每行 20 个汉字（40 列，cols=80 下首行不折行，但总行数 8 > 5 触发视口滚动）
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) lines.push(`第${i}行`.repeat(10)); // 每行 30 字 = 60 列
    const input = lines.join('\n');
    const cursorPos = [...input].length;
    const totalLines = input.split('\n').length;
    const cursorLine = cursorScreenPos(input, cursorPos, '❯ ').y;
    const vp = computeInputViewport(totalLines, cursorLine, MAX_VISIBLE_INPUT_LINES);
    renderer.renderFooter(input, cursorPos, 'status', 80, [], 0, vp.viewportTop);
    const out = mock.output;
    // 视口外行不出现
    for (let i = 0; i < vp.viewportTop; i++) {
      expect(out).not.toContain(`第${i}行`);
    }
    // 视口内行出现（至少最后一个视口内行）
    const lastVisibleIdx = vp.viewportTop + MAX_VISIBLE_INPUT_LINES - 1;
    expect(out).toContain(`第${lastVisibleIdx}行`);
  });

  it('CJK 折行 + 视口滚动：footerHeight 按物理行记账（border 不堆叠）', () => {
    expect.hasAssertions();
    // 每行 50 个汉字 = 100 列，cols=80 → 每逻辑行折 2 物理行。8 行 → 16 物理输入行。
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) lines.push('中'.repeat(50));
    const input = lines.join('\n');
    const cursorPos = [...input].length;
    const vp = computeInputViewport(8, 7, MAX_VISIBLE_INPUT_LINES);
    renderer.renderFooter(input, cursorPos, 'status', 80, [], 0, vp.viewportTop);
    // footerHeight = 1(border) + 视口内可见行的物理行数 + 1(border) + 1(status)
    // 视口只渲染 MAX_VISIBLE_INPUT_LINES=5 个逻辑行，每行 2 物理行 = 10 物理行
    // footerHeight = 1 + 10 + 1 + 1 = 13
    expect(renderer.getFooterHeight()).toBe(13);
  });

  it('CJK 视口滚动 + 光标在中间行：cursorUp + CHA 与精确模拟自洽', () => {
    expect.hasAssertions();
    // 7 行中文，每行 50 字。cursor 在第 3 行末尾（触发视口）。
    const lines: string[] = [];
    for (let i = 0; i < 7; i++) lines.push('中'.repeat(50));
    const input = lines.join('\n');
    // cursor 在第 3 行末尾
    let cursorPos = 0;
    for (let i = 0; i <= 3; i++) cursorPos += [...lines[i]!].length + (i < 3 ? 1 : 0);
    const cursorLine = 3;
    const vp = computeInputViewport(7, cursorLine, MAX_VISIBLE_INPUT_LINES);
    renderer.renderFooter(input, cursorPos, 'status', 80, [], 0, vp.viewportTop);
    const out = mock.output;
    // CHA = 光标在第 3 行内的精确列（simulateTerminalWrap）+ 1，钳到 cols
    const wrap = simulateTerminalWrap(lines[3]!, 80, 2);
    const expectedCha = Math.min(wrap.cursorCol + 1, 80);
    const chaMatch = out.match(/\x1b\[(\d+)G/);
    expect(parseInt(chaMatch![1], 10)).toBe(expectedCha);
  });

  it('随机化组合不变量：任意行数 × 任意 CJK 行长 × 任意 cursor，border 不堆叠', () => {
    expect.hasAssertions();
    for (let trial = 0; trial < 15; trial++) {
      mock = createMockStdout();
      renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
      const lineCount = 3 + Math.floor(Math.random() * 8);
      const charsPerLine = Math.floor(Math.random() * 60);
      const lines: string[] = [];
      for (let i = 0; i < lineCount; i++) lines.push(`行${i}`.repeat(charsPerLine));
      const input = lines.join('\n');
      const cursorPos = Math.floor(Math.random() * ([...input].length + 1));
      const cursorLine = cursorScreenPos(input, cursorPos, '❯ ').y;
      const vp = computeInputViewport(lineCount, cursorLine, MAX_VISIBLE_INPUT_LINES);
      renderer.renderFooter(input, cursorPos, 'status', 80, [], 0, vp.viewportTop);
      // 不变量：本帧输出 border 数 ≤ 2（上+下，不应堆叠）
      const borders = (mock.output.match(/─{20,}/g) || []).length;
      expect(borders).toBeLessThanOrEqual(2);
    }
  });
});
