// src/tui/inline/truncate-status-cursor-regression.test.ts
//
// 回归测试：超宽 statusText 的 wordWrap 物理行记账
//
// 演进（DECAWM OFF + wordWrap）：
//   旧版（截断策略）：renderFooter 用 sliceAnsi 把 statusText 截到 cols，物理行恒=1。
//   新版（wordWrap 策略）：DECAWM OFF 后 statusText 用 wrapLine 折行，超宽内容
//   不被丢弃而是折成多行显示。物理行 = wrapLine 后的行数（完全可控）。
//   footerHeight = 2(预留位) + 1(input) + 1(border) + statusWrapLines。
//
// 本测试验证：超宽 statusText 渲染后 footerHeight 按 wrapLine 行数记账，
// 且跨帧稳定（追加→覆写不漂移）。期望值用 wrapLine 算（单一真理源）。

import { describe, it, expect, beforeEach } from 'vitest';
import stringWidth from 'string-width';
import { InlineRenderer } from './InlineRenderer.js';
import { wrapLine, getUsableWidth } from '../state/wrap-line.js';

const PROMPT = '❯ ';

/** 算期望 footerHeight = 2(预留位) + 1(顶部border) + inputWrapLines + 1(底部border) + statusWrapLines。
 *  本测试都用空输入（wrapLine('❯ ', usable)=1 行）。 */
function expectedFooterHeight(statusText: string, usableWidth: number): number {
  const inputPhys = wrapLine(PROMPT + '', usableWidth).length;
  const statusPhys = wrapLine(statusText, usableWidth).length;
  return 2 + 1 + inputPhys + 1 + statusPhys;
}

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

describe('超宽 statusText 截断回归', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;
  const cols = 80;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('超宽 statusText：footerHeight 按 wrapLine 行数记账', () => {
    expect.hasAssertions();
    // 超 usableWidth 列 statusText，wrapLine 会折成多行 → footerHeight 含多行
    const usableWidth = getUsableWidth(cols);
    const statusText = '\x1b[36midle\x1b[0m │ claude-sonnet-4-5 │ D:\\Files\\Projects\\mi-code-master │ fix/viewport-centering-test-blindspot │ ██████████ 0%';
    expect(stringWidth(statusText)).toBeGreaterThan(cols); // 前置：确认超宽

    renderer.renderFooter('', 0, statusText, cols, [], 0, 0);
    // footerHeight = 2(预留位) + 1(input) + 1(border) + statusWrapLines
    expect(renderer.getFooterHeight()).toBe(expectedFooterHeight(statusText, usableWidth));
  });

  it('短 statusText（不超宽）：footerHeight=6（不受影响）', () => {
    expect.hasAssertions();
    const shortStatus = 'short status';
    expect(stringWidth(shortStatus)).toBeLessThanOrEqual(cols);

    renderer.renderFooter('', 0, shortStatus, cols, [], 0, 0);
    expect(renderer.getFooterHeight()).toBe(6);
  });

  it('超宽 statusText：追加→覆写 footerHeight 稳定（不随帧增长）', () => {
    expect.hasAssertions();
    const usableWidth = getUsableWidth(cols);
    const statusText = 'X'.repeat(120); // 远超 80 列
    expect(stringWidth(statusText)).toBeGreaterThan(cols);
    const expected = expectedFooterHeight(statusText, usableWidth);

    renderer.renderFooter('', 0, statusText, cols, [], 0, 0);
    const h1 = renderer.getFooterHeight();

    renderer.renderFooter('c', 1, statusText, cols, [], 0, 0);
    const h2 = renderer.getFooterHeight();

    renderer.renderFooter('cc', 2, statusText, cols, [], 0, 0);
    const h3 = renderer.getFooterHeight();

    // 每帧都断言具体值（非仅"相同"——bug 下三帧都漂移也算"相同"）。
    // 输入从空→c→cc 都不超宽（inputWrapLines=1），footerHeight 只随 statusText 行数变。
    expect(h1).toBe(expected);
    expect(h2).toBe(expected);
    expect(h3).toBe(expected);
  });

  it('超宽 statusText：输出中不含超过 usableWidth 列的行（wordWrap 生效）', () => {
    expect.hasAssertions();
    const usableWidth = getUsableWidth(cols);
    const statusText = '\x1b[36m' + 'X'.repeat(120) + '\x1b[0m';
    renderer.renderFooter('', 0, statusText, cols, [], 0, 0);

    // 逐行检查：去掉 ANSI 后每行 displayWidth ≤ usableWidth（wordWrap 不超可用宽）
    const output = mock.output;
    const rawLines = output.split('\n');
    for (const line of rawLines) {
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
      if (clean.length === 0) continue;
      const w = stringWidth(clean);
      expect(w).toBeLessThanOrEqual(usableWidth);
    }
  });

  it('CJK 超宽 statusText：footerHeight 按 wrapLine 行数记账', () => {
    expect.hasAssertions();
    const usableWidth = getUsableWidth(cols);
    // 50 汉字 = 100 列 > usableWidth(79)
    const cjkStatus = '中'.repeat(50);
    expect(stringWidth(cjkStatus)).toBeGreaterThan(cols);

    renderer.renderFooter('', 0, cjkStatus, cols, [], 0, 0);
    expect(renderer.getFooterHeight()).toBe(expectedFooterHeight(cjkStatus, usableWidth));
  });

  it('超宽含ANSI statusText：光标 cursorUp 值正确（弥补 upFromBottom 盲区）', () => {
    expect.hasAssertions();
    const usableWidth = getUsableWidth(cols);
    // 变异 8 教训：footerHeight 正确但 upFromBottom 算错时，光标仍漂移。
    // 此测试直接断言 cursorUp 值，确保光标定位公式也正确。
    // 空输入：光标在输入框行（块内物理行3），newHeight=expectedFooterHeight，
    // cursorPhysLine0 = 3（空输入 wrapLine=1 行，layout row=0，跳过 2 行预留位后 = 3），
    // upFromBottom = newHeight - 3。
    const statusText = '\x1b[36m' + 'X'.repeat(120) + '\x1b[0m';
    expect(stringWidth(statusText)).toBeGreaterThan(cols);

    renderer.renderFooter('', 0, statusText, cols, [], 0, 0);
    const out = mock.output;
    // 提取所有 cursorUp 值
    const ups: number[] = [];
    // eslint-disable-next-line no-control-regex
    const re = /\x1b\[(\d+)A/g;
    let m;
    while ((m = re.exec(out)) !== null) ups.push(parseInt(m[1], 10));
    // 最后一个 cursorUp 是光标定位（前面的 cursorUp 是覆写模式上移到块顶）
    // 空输入首次渲染是追加模式，只有一个 cursorUp（光标定位）
    const newHeight = expectedFooterHeight(statusText, usableWidth);
    const cursorPhysLine0 = 3; // 空输入 layout row=0 → 跳过 2 行预留位后 = 3
    const expectedUp = newHeight - cursorPhysLine0;
    expect(ups[ups.length - 1]).toBe(expectedUp);
  });
});
