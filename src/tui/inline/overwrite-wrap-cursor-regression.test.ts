// src/tui/inline/overwrite-wrap-cursor-regression.test.ts
//
// 回归测试：覆写模式下光标绝对位置正确（不漂移）
//
// 根因（2026-07-12 系统化调试锁定）：
//   simulateTerminalWrap 不跳过 ANSI 转义序列，把 \x1b[36m 的 [36m 算成 4 列宽度。
//   含颜色的 statusText physRows 虚高 → footerHeight 偏大 → cursorUp 偏移 → 光标漂移。
//
// 旧版假测试教训：
//   旧版只断言"追加后光标行 == 覆写后光标行"（相对漂移=0）。
//   但如果 simulateTerminalWrap 算错 physRows，追加和覆写都偏移同样的量，
//   相对漂移仍=0，测试通过——这是"模拟器与被测代码同源错误"导致的假测试。
//
// 修复：断言光标的**绝对位置**（应在输入框行=块顶+3），而非仅比较相对漂移。
// 块顶=起始行（logo3+hook1=行4），输入框=块顶+3=行7（0-based）。
// （footer lines 顶部有 2 行预留位 + border，输入框在第 3 行）

import { describe, it, expect, beforeEach } from 'vitest';
import stringWidth from 'string-width';
import { InlineRenderer } from './InlineRenderer.js';

/**
 * 精确终端光标模拟器：解析完整写入序列，追踪光标行号。
 *
 * 与旧 CursorTracker 的区别：逐字符放置，CJK 2列，超出 cols 自动换行（延迟换行语义）。
 * 正确跳过 ANSI 转义序列（SGR 颜色码零宽度），避免模拟器与被测代码同源错误。
 */
class PreciseCursorSimulator {
  row = 0;
  col = 0;

  apply(writeStr: string, cols: number): void {
    const chars = [...writeStr];
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i]!;
      // ANSI 转义序列：\x1b[...<letter>
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
        // m/K/?h/l/M 等不影响光标位置
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

describe('覆写模式折行光标回归', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;
  const cols = 80;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('超宽含ANSI statusText：追加后光标在输入框行（绝对位置=块顶+1）', () => {
    expect.hasAssertions();
    // statusText 含 ANSI 颜色码 + 超宽（stringWidth > cols）
    const statusText = '\x1b[1m\x1b[36m⠋ Idle\x1b[0m │ idle │ claude-sonnet-4-5 │ D:\\Files\\Projects\\mi-code │ master │ ██████████ 0%';
    expect(stringWidth(statusText)).toBeGreaterThan(cols); // 前置：确认超宽

    const sim = new PreciseCursorSimulator();
    sim.row = 4; // logo 3行 + hook 1行 = 块顶行4

    renderer.renderFooter('', 0, statusText, cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);

    // 绝对位置断言：光标应在输入框行 = 块顶(4) + 3 = 行7
    // （footer lines 顶部有 2 行预留位 + border，输入框在第 3 行）
    expect(sim.row).toBe(7);
  });

  it('超宽含ANSI statusText：覆写后光标仍在输入框行（与追加相同）', () => {
    expect.hasAssertions();
    const statusText = '\x1b[1m\x1b[36m⠋ Idle\x1b[0m │ idle │ claude-sonnet-4-5 │ D:\\Files\\Projects\\mi-code │ master │ ██████████ 0%';
    expect(stringWidth(statusText)).toBeGreaterThan(cols);

    const sim = new PreciseCursorSimulator();
    sim.row = 4;

    renderer.renderFooter('', 0, statusText, cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    const rowAfterAppend = sim.row;
    mock.written.length = 0;

    renderer.renderFooter('c', 1, statusText, cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);

    // 双重断言：绝对位置正确（行7）+ 与追加相同（不漂移）
    expect(sim.row).toBe(7);
    expect(sim.row).toBe(rowAfterAppend);
  });

  it('不折行时（statusText 短）：追加→覆写光标在输入框行（对照组）', () => {
    expect.hasAssertions();
    const shortStatus = 'short';
    expect(stringWidth(shortStatus)).toBeLessThanOrEqual(cols);

    const sim = new PreciseCursorSimulator();
    sim.row = 4;

    renderer.renderFooter('', 0, shortStatus, cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    expect(sim.row).toBe(7); // 绝对位置

    mock.written.length = 0;
    renderer.renderFooter('c', 1, shortStatus, cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    expect(sim.row).toBe(7);
  });

  it('连续多帧覆写（超宽含ANSI statusText）：光标始终在输入框行，不累计漂移', () => {
    expect.hasAssertions();
    const statusText = '\x1b[36m' + 'X'.repeat(120) + '\x1b[0m'; // 含 ANSI + 超宽
    expect(stringWidth(statusText)).toBeGreaterThan(cols);

    const sim = new PreciseCursorSimulator();
    sim.row = 4;

    renderer.renderFooter('', 0, statusText, cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    mock.written.length = 0;

    // 连续覆写 5 帧，每帧光标都应在行7（输入框行）
    for (let i = 1; i <= 5; i++) {
      renderer.renderFooter('c'.repeat(i), i, statusText, cols, [], 0, 0);
      for (const s of mock.written) sim.apply(s, cols);
      mock.written.length = 0;
      expect(sim.row).toBe(7); // 每帧绝对位置断言
    }
  });

  it('CJK 超宽含ANSI statusText：追加→覆写光标在输入框行', () => {
    expect.hasAssertions();
    // 含 ANSI 颜色码 + CJK 超宽（100 列 > 80）
    const cjkStatus = '\x1b[36m' + '中'.repeat(50) + '\x1b[0m';
    expect(stringWidth(cjkStatus)).toBeGreaterThan(cols);

    const sim = new PreciseCursorSimulator();
    sim.row = 4;

    renderer.renderFooter('', 0, cjkStatus, cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    expect(sim.row).toBe(7);

    mock.written.length = 0;
    renderer.renderFooter('中', 1, cjkStatus, cols, [], 0, 0);
    for (const s of mock.written) sim.apply(s, cols);
    expect(sim.row).toBe(7);
  });
});
