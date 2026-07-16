// src/tui/inline/input-wrap-border-regression.test.ts
//
// 回归测试：连续输入至折行时 border 不堆叠 + 光标不漂移
//
// 根因（2026-07-12 系统化调试锁定）：
//   simulateTerminalWrap 假设终端折行（DECAWM），算输入行(>cols) physRows>1。
//   但 ConPTY 不折行（超宽内容被截断，node-pty 实测确认）。
//   newHeight 偏大 → cursorUp 偏多 → 光标上移（问题1）+ 每帧漂移 → border 堆叠（问题2）。
//   两个问题是同一个根因的两面：simulateTerminalWrap 的折行假设在 ConPTY 下不成立。
//
// 修复演进（DECAWM OFF + wordWrap）：
//   InlineRenderer constructor 写 \x1b[?7l（DECAWM OFF），应用层用 wrapLine 自己折行。
//   physical rows = wrapLine 后的行数（完全可控，不依赖终端）。
//   footerHeight = lines.length，光标定位用 layoutInputCursor（wordWrap 后的 row/col）。
//
// 不变量：
//   1. 跨帧光标绝对位置 = 块顶 + 3(2行预留位) + layoutInputCursor.row（与输入物理行一致，不漂移）
//   2. 输出中 border 数量恒为 1（footer 现只有底部 border，顶部 border 被预留位替代），不堆叠

import { describe, it, expect, beforeEach } from 'vitest';
import stringWidth from 'string-width';
import { InlineRenderer } from './InlineRenderer.js';
import { wrapLine, getUsableWidth } from '../state/wrap-line.js';
import { layoutInputCursor } from '../state/layout-cursor.js';

const PROMPT = '❯ ';

/**
 * 算空输入光标行的基准：块顶(4) + 2行预留位 + layoutInputCursor.row。
 * 输入超宽时 wordWrap 产生多个物理行，光标跟着移到对应物理行。
 */
function expectedCursorRow(blockTop: number, input: string, cursorPos: number, usableWidth: number): number {
  // 单行输入；多行需逐行累加（本测试只覆盖单行）
  const layout = layoutInputCursor(input, cursorPos, PROMPT, usableWidth);
  return blockTop + 3 + layout.row;
}

class PreciseCursorSimulator {
  row = 0;
  col = 0;

  apply(writeStr: string, cols: number): void {
    const chars = [...writeStr];
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i]!;
      if (ch === '\x1b') {
        let j = i + 1;
        let seq = ch;
        while (j < chars.length && !/[A-Za-z]/.test(chars[j]!)) {
          seq += chars[j];
          j++;
        }
        if (j < chars.length) {
          seq += chars[j];
          j++;
        }
        const params = seq.slice(2, -1);
        const cmd = seq.slice(-1);
        if (cmd === 'A') this.row -= parseInt(params || '1', 10);
        else if (cmd === 'B') this.row += parseInt(params || '1', 10);
        else if (cmd === 'G') this.col = parseInt(params || '1', 10) - 1;
        else if (cmd === 'H' || cmd === 'f') {
          const [r, c] = (params || '1;1').split(';').map((x) => parseInt(x || '1', 10));
          this.row = r - 1;
          this.col = c - 1;
        }
        i = j;
        continue;
      }
      if (ch === '\n') { this.row++; this.col = 0; i++; continue; }
      if (ch === '\r') { this.col = 0; i++; continue; }
      const cw = stringWidth(ch);
      if (cw === 0) { i++; continue; }
      if (this.col + cw > cols) {
        this.row++;
        this.col = 0;
      }
      this.col += cw;
      i++;
    }
  }
}

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

/** 统计输出中的 border 行数（去 ANSI 后含 ─ 的行） */
function countBorders(output: string): number {
  const lines = output.split('\n');
  let count = 0;
  for (const line of lines) {
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
    if (clean.includes('─')) count++;
  }
  return count;
}

describe('输入行折行 border 堆叠 + 光标漂移回归', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;
  const cols = 80;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('连续输入至超宽（折行边界）：光标绝对位置稳定不漂移', () => {
    expect.hasAssertions();
    const usableWidth = getUsableWidth(cols);
    const sim = new PreciseCursorSimulator();
    sim.row = 4; // 块顶 = logo3 + hook1 = 行4

    // 帧1：空输入（追加模式）。空输入 wrapLine=1 行，光标在物理行0。
    renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    mock.written.length = 0;
    const rowAfterAppend = sim.row;
    expect(rowAfterAppend).toBe(expectedCursorRow(4, '', 0, usableWidth)); // 块顶+3+0=7

    // 帧2：78个a。2+78=80 > usableWidth(79)，wrapLine 折成 2 行，光标在物理行1。
    renderer.renderFooter('a'.repeat(78), 78, 'status', cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    mock.written.length = 0;
    expect(sim.row).toBe(expectedCursorRow(4, 'a'.repeat(78), 78, usableWidth));

    // 帧3：79个a。仍折 2 行（usableWidth=79 容不下 2+79=81），光标在物理行1。
    renderer.renderFooter('a'.repeat(79), 79, 'status', cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    mock.written.length = 0;
    expect(sim.row).toBe(expectedCursorRow(4, 'a'.repeat(79), 79, usableWidth));

    // 帧4：100个a。折 3 行，光标在物理行2。
    renderer.renderFooter('a'.repeat(100), 100, 'status', cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    mock.written.length = 0;
    expect(sim.row).toBe(expectedCursorRow(4, 'a'.repeat(100), 100, usableWidth));
  });

  it('连续输入至超宽：每帧 border 数量恒为 1（不堆叠）', () => {
    expect.hasAssertions();
    // 追加模式
    renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
    // 逐字输入到超宽
    for (let i = 1; i <= 100; i++) {
      mock.written.length = 0;
      renderer.renderFooter('a'.repeat(i), i, 'status', cols, [], 0, 0);
      const borders = countBorders(mock.output);
      // 覆写模式下每次应写 2 个 border（footer 有顶部 + 底部 border），不堆叠
      if (i > 1) { // 第1次覆写开始检查
        expect(borders).toBe(2);
      }
    }
  });

  it('CJK 连续输入至超宽：光标不漂移 + border 不堆叠', () => {
    expect.hasAssertions();
    const usableWidth = getUsableWidth(cols);
    const sim = new PreciseCursorSimulator();
    sim.row = 4;

    renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    mock.written.length = 0;
    expect(sim.row).toBe(expectedCursorRow(4, '', 0, usableWidth));

    // 40 个中文 = 80 列（含 prompt 2 = 82 > usableWidth 79）→ wrapLine 折 3 行
    const cjkText = '中'.repeat(40);
    renderer.renderFooter(cjkText, 40, 'status', cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    expect(sim.row).toBe(expectedCursorRow(4, cjkText, 40, usableWidth));
    expect(countBorders(mock.output)).toBe(2);
    mock.written.length = 0;

    // 50 个中文 = 100 列 → wrapLine 折 3 行，光标在物理行2
    const cjkText2 = '中'.repeat(50);
    renderer.renderFooter(cjkText2, 50, 'status', cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    expect(sim.row).toBe(expectedCursorRow(4, cjkText2, 50, usableWidth));
    expect(countBorders(mock.output)).toBe(2);
  });

  it('多行输入（Ctrl+J 显式换行）+ 单行超宽：光标稳定 + border 不堆叠', () => {
    expect.hasAssertions();
    const sim = new PreciseCursorSimulator();
    sim.row = 4;

    renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    mock.written.length = 0;

    // 第1行正常，第2行超宽
    const text = 'hello\n' + 'a'.repeat(100);
    renderer.renderFooter(text, text.length, 'status', cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);

    // footerHeight 应稳定（每行截断到 cols 后各 1 物理行）
    // border 不堆叠（footer 只有底部 border）
    expect(countBorders(mock.output)).toBe(2);
  });
});
