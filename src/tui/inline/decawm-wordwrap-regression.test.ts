// src/tui/inline/decawm-wordwrap-regression.test.ts
//
// 集成测试：DECAWM OFF + 应用层 wordWrap 后光标不漂移 + border 不堆叠。
//
// 验证三个不变量：
// 1. constructor 写入 \x1b[?7l（DECAWM OFF 序列）
// 2. destroy 写入 \x1b[?7h（DECAWM ON 恢复）
// 3. 超宽输入 wordWrap 后光标绝对位置稳定 + border 不堆叠

import { describe, it, expect, beforeEach } from 'vitest';
import stringWidth from 'string-width';
import { InlineRenderer } from './InlineRenderer.js';
import { wrapLine, getUsableWidth } from '../state/wrap-line.js';
import { layoutInputCursor } from '../state/layout-cursor.js';

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
      // DECAWM OFF：不自动折行（模拟器也不折行）
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

describe('DECAWM OFF + wordWrap 回归', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;
  const cols = 80;
  const usableWidth = getUsableWidth(cols);

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  describe('DECAWM 序列', () => {
    it('constructor 写入 DECAWM OFF 序列', () => {
      expect.hasAssertions();
      expect(mock.output).toContain('\x1b[?7l');
    });

    it('destroy 写入 DECAWM ON + 光标可见', () => {
      expect.hasAssertions();
      renderer.destroy();
      expect(mock.output).toContain('\x1b[?7h');
      expect(mock.output).toContain('\x1b[?25h');
    });
  });

  describe('超宽输入 wordWrap 光标稳定', () => {
    it('连续输入至超宽：光标绝对位置稳定不漂移', () => {
      expect.hasAssertions();
      const sim = new PreciseCursorSimulator();
      sim.row = 4; // 块顶 = logo3 + hook1

      // 帧1：空输入（追加模式，跳过 constructor 的 DECAWM 序列）
      renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
      // 跳过 constructor 的 \x1b[?7l（mock.written[0]）
      const writes1 = mock.written[0] === '\x1b[?7l' ? mock.written.slice(1) : mock.written;
      for (const s of writes1) {
        sim.apply(s, cols);
      }
      mock.written.length = 0;
      const rowAfterAppend = sim.row;
      expect(rowAfterAppend).toBe(7);

      // 帧2：78个a（❯ +78a=80列 > 79 usableWidth，wordWrap 折行）
      renderer.renderFooter('a'.repeat(78), 78, 'status', cols, [], 0, 0);
      for (const s of mock.written) sim.apply(s, cols);
      mock.written.length = 0;
      expect(sim.row).toBeGreaterThan(5); // wordWrap 后行数增加

      // 帧3：100个a（更宽，折更多行）
      renderer.renderFooter('a'.repeat(100), 100, 'status', cols, [], 0, 0);
      for (const s of mock.written) sim.apply(s, cols);
      const rowAfter100 = sim.row;
      mock.written.length = 0;

      // 帧4：再次100个a（相同内容，光标必须与帧3相同——无累积漂移）
      renderer.renderFooter('a'.repeat(100), 100, 'status', cols, [], 0, 0);
      for (const s of mock.written) sim.apply(s, cols);
      mock.written.length = 0;
      expect(sim.row).toBe(rowAfter100); // 核心不变量：不漂移
    });

    it('连续输入至超宽：每帧 border 数量恒为 2', () => {
      expect.hasAssertions();
      renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
      for (let i = 1; i <= 100; i++) {
        mock.written.length = 0;
        renderer.renderFooter('a'.repeat(i), i, 'status', cols, [], 0, 0);
        if (i > 1) {
          expect(countBorders(mock.output)).toBe(2);
        }
      }
    });

    it('CJK 超宽 wordWrap：光标稳定 + border 不堆叠', () => {
      expect.hasAssertions();
      const sim = new PreciseCursorSimulator();
      sim.row = 4;

      renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
      const writes0 = mock.written[0] === '\x1b[?7l' ? mock.written.slice(1) : mock.written;
      for (const s of writes0) sim.apply(s, cols);
      mock.written.length = 0;

      // 50个中文 = 100列 > 79(usableWidth)
      renderer.renderFooter('中'.repeat(50), 50, 'status', cols, [], 0, 0);
      for (const s of mock.written) sim.apply(s, cols);
      const rowAfterWrap = sim.row;
      expect(countBorders(mock.output)).toBe(2);
      mock.written.length = 0;

      // 60个中文
      renderer.renderFooter('中'.repeat(60), 60, 'status', cols, [], 0, 0);
      for (const s of mock.written) sim.apply(s, cols);
      expect(sim.row).toBe(rowAfterWrap);
      expect(countBorders(mock.output)).toBe(2);
    });

    it('中文+emoji+英文混合 wordWrap：光标稳定 + border 不堆叠', () => {
      expect.hasAssertions();
      const sim = new PreciseCursorSimulator();
      sim.row = 4;

      renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
      const writes00 = mock.written[0] === '\x1b[?7l' ? mock.written.slice(1) : mock.written;
      for (const s of writes00) sim.apply(s, cols);
      mock.written.length = 0;

      const text = '你好hello🤖世界'.repeat(10);
      renderer.renderFooter(text, [...text].length, 'status', cols, [], 0, 0);
      for (const s of mock.written) sim.apply(s, cols);
      const rowAfterWrap = sim.row;
      expect(countBorders(mock.output)).toBe(2);
      mock.written.length = 0;

      // 再输入更多
      const text2 = text + 'abc';
      renderer.renderFooter(text2, [...text2].length, 'status', cols, [], 0, 0);
      for (const s of mock.written) sim.apply(s, cols);
      expect(sim.row).toBe(rowAfterWrap);
      expect(countBorders(mock.output)).toBe(2);
    });

    it('光标在折行边界（恰好填满宽度后）', () => {
      expect.hasAssertions();
      // usableWidth=79, prompt='❯ '(2列), 77个a = 79列恰好填满
      // 光标在 77（末尾）→ wrapLine 不折行，光标在行0末尾
      renderer.renderFooter('a'.repeat(77), 77, 'status', cols, [], 0, 0);
      const out = mock.output;
      // 提取最后的 CHA（光标列）
      const chaMatch = out.match(/\x1b\[(\d+)G/g);
      expect(chaMatch).not.toBeNull();
      const lastCha = chaMatch![chaMatch!.length - 1]!.match(/\d+/)!;
      // 光标在 79列（prompt2 + 77a = 79），CHA = 79
      expect(parseInt(lastCha[0], 10)).toBe(79);
    });

    it('多行输入（Ctrl+J）+ 单行超宽：光标稳定 + border 不堆叠', () => {
      expect.hasAssertions();
      renderer.renderFooter('', 0, 'status', cols, [], 0, 0);
      mock.written.length = 0;

      // 第1行正常，第2行超宽
      const text = 'hello\n' + 'a'.repeat(100);
      renderer.renderFooter(text, text.length, 'status', cols, [], 0, 0);
      expect(countBorders(mock.output)).toBe(2);
    });
  });

  describe('wordWrap 与 layoutInputCursor 自洽', () => {
    it('renderFooter 光标位置与 layoutInputCursor 算的一致', () => {
      expect.hasAssertions();
      const text = 'a'.repeat(100);
      const cursorPos = 100;
      renderer.renderFooter(text, cursorPos, 'status', cols, [], 0, 0);
      const out = mock.output;

      // 用 layoutInputCursor 算期望光标位置
      const layout = layoutInputCursor(text, cursorPos, '❯ ', usableWidth);

      // 提取 renderFooter 输出的 cursorUp 值
      const ups = [...out.matchAll(/\x1b\[(\d+)A/g)].map((m) => parseInt(m[1], 10));
      const lastUp = ups[ups.length - 1]!;

      // 提取 CHA（光标列）
      const chaMatch = out.match(/\x1b\[(\d+)G/g);
      const lastCha = chaMatch![chaMatch!.length - 1]!.match(/\d+/)!;
      const chaCol = parseInt(lastCha[0], 10);

      // CHA 应 = layout.col + 1（0-based → 1-based）
      expect(chaCol).toBe(layout.col + 1);
    });
  });

  it('suggestion 超宽时截断到 usableWidth（不 wordWrap）', () => {
    expect.hasAssertions();
    // 构造超长 suggestion 名
    const longName = 'x'.repeat(120);
    renderer.renderFooter('hel', 3, 'status', cols, [longName], 0, 0);
    const out = mock.output;
    // suggestion 行应被截断，不含超过 usableWidth 的内容
    // suggestion 行格式: ' ▸ /xxx ' 或 '   /xxx'
    // 检查输出中 suggestion 相关行的 displayWidth ≤ usableWidth
    const lines = out.split('\n');
    for (const line of lines) {
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
      if (clean.includes('/' + 'x'.repeat(10))) {
        // 这是 suggestion 行
        expect(stringWidth(clean)).toBeLessThanOrEqual(getUsableWidth(cols));
      }
    }
  });
});

// ───────────────────────────────────────────────────────────
// resize 跟随回归：cols 变化时 footer 覆写必须正确，border 不堆叠。
//
// 历史 bug：Bug B 修复（cols 加入 InlineApp effect 依赖）后，resize 触发 effect
// 重跑 → renderFooter 覆写。但若覆写逻辑在 cols 变化时光标定位错误，
// 会出现 border 重复绘制（屏幕上 4+ 条 ───）。
//
// 关键：模拟真实光标位置连续性（PreciseCursorSimulator），而非每帧独立。
// 旧测试全程 cols=80，无法发现 resize 退化。
// ───────────────────────────────────────────────────────────
describe('resize 跟随：cols 变化时 border 不堆叠', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('连续 resize（宽→窄）：每帧 border 恒为 2', () => {
    expect.hasAssertions();
    const sim = new PreciseCursorSimulator();
    sim.row = 4; // 模拟 logo 3 行 + 已有内容 1 行后光标位置

    // 帧1：cols=180（初始宽屏），追加模式
    renderer.renderFooter('', 0, 'status', 180, [], 0, 0);
    // 跳过 constructor 的 \x1b[?7l
    const writes1 = mock.written[0] === '\x1b[?7l' ? mock.written.slice(1) : [...mock.written];
    for (const s of writes1) sim.apply(s, 180);
    expect(countBorders(mock.output)).toBe(2);
    mock.written.length = 0;

    // 帧2：resize 到 120（覆写模式）
    renderer.renderFooter('', 0, 'status', 120, [], 0, 0);
    for (const s of mock.written) sim.apply(s, 120);
    expect(countBorders(mock.output)).toBe(2);
    mock.written.length = 0;

    // 帧3：resize 到 80（覆写模式）
    renderer.renderFooter('', 0, 'status', 80, [], 0, 0);
    for (const s of mock.written) sim.apply(s, 80);
    expect(countBorders(mock.output)).toBe(2);
    mock.written.length = 0;

    // 帧4：resize 到 40（覆写模式，窄屏）
    renderer.renderFooter('', 0, 'status', 40, [], 0, 0);
    for (const s of mock.written) sim.apply(s, 40);
    expect(countBorders(mock.output)).toBe(2);
  });

  it('resize 后 footerHeight 不漂移（与帧1 一致，6 行）', () => {
    expect.hasAssertions();
    renderer.renderFooter('', 0, 'status', 180, [], 0, 0);
    const h1 = renderer.getFooterHeight();
    expect(h1).toBe(6); // 预留位(2) + 顶部border + 输入框 + 底部border + status

    renderer.renderFooter('', 0, 'status', 120, [], 0, 0);
    expect(renderer.getFooterHeight()).toBe(h1);

    renderer.renderFooter('', 0, 'status', 80, [], 0, 0);
    expect(renderer.getFooterHeight()).toBe(h1);
  });
});
