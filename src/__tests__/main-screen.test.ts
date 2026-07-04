// 单测：主屏 + DECSTBM 滚动区域 + 纯追加渲染器
//
// 物理本质验证：
// - 主屏模式（不进 alt screen）：保留原生 scrollback
// - scroll region（DECSTBM）：消息区 LF 在 region 底部触发滚动，旧行进 scrollback，
//   region 外的页脚钉死不动
// - 纯追加：消息一行行写 + LF，写完永不回头改（不 CUP 回去改已显示行）
// - 页脚变化时 CUP 到 region 外重画（不触发滚动）
// - 不开鼠标追踪（保留原生拖选复制）
//
// FakeTerminal：解析 CSI（含 DECSTBM scroll region），模拟真实终端行为。
// region 内 LF 在底部只滚 region（顶行进 scrollback），region 外 CUP 不滚动。

import { describe, it, expect } from 'vitest';
import { Renderer } from '../renderer/renderer.js';
import { isWideCodePoint } from '../renderer/cell.js';

/** 模拟真实终端的 FakeTerminal：支持 DECSTBM scroll region。 */
class FakeTerminal {
  rows: number;
  cols: number;
  grid: string[][];
  scrollback: string[] = [];
  row = 0;
  col = 0;
  /** scroll region 边界（含两端，1-based 内部用）；null=全屏 */
  private regionTop = 0;
  private regionBottom: number;
  /** 累积的原始输出字节（检查 ANSI 序列用） */
  output = '';
  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));
    this.regionBottom = rows - 1; // 默认全屏为 region
  }
  write(s: string): void {
    this.output += s;
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        if (s[i + 1] === '[') {
          // eslint-disable-next-line no-control-regex
          const m = s.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z<])/);
          if (m) {
            if (m[2] !== '<') this.csi(m[1], m[2]);
            i += m[0].length;
            continue;
          }
        }
        i++; continue;
      }
      if (ch === '\r') { this.col = 0; i++; continue; }
      if (ch === '\n') { this.lf(); i++; continue; }
      const w = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
      // DECAWM 自动换行：写满一行后，下个字符自动换到下一行（模拟真实终端）
      if (this.col + w > this.cols && this.col > 0) {
        this.lf();
      }
      if (this.row < this.rows && this.col < this.cols) {
        this.grid[this.row]![this.col] = ch;
        if (w === 2 && this.col + 1 < this.cols) this.grid[this.row]![this.col + 1] = '\u0000';
      }
      this.col += w;
      i++;
    }
  }
  /** LF：光标在 region 底部 → 只 region 内上滚（顶行进 scrollback）；否则 row++ */
  private lf(): void {
    if (this.row >= this.regionBottom) {
      // region 内上滚：region 顶行进 scrollback，region 内各行上移，底行清空
      this.scrollback.push((this.grid[this.regionTop] ?? []).map(c => (c === '\u0000' ? '' : c)).join(''));
      for (let r = this.regionTop; r < this.regionBottom; r++) {
        this.grid[r] = this.grid[r + 1];
      }
      this.grid[this.regionBottom] = new Array(this.cols).fill(' ');
      this.col = 0;
      // row 保持 regionBottom（钉底）
    } else {
      this.row++;
      this.col = 0;
    }
  }
  private csi(params: string, cmd: string): void {
    if (params.includes('?')) return; // DEC 模式（alt/mouse）忽略
    if (cmd === 'H') {
      if (params === '') { this.row = 0; this.col = 0; return; }
      const [r, c] = params.split(';').map(x => parseInt(x || '1', 10));
      this.row = Math.max(0, Math.min(this.rows - 1, (r || 1) - 1));
      this.col = Math.max(0, Math.min(this.cols - 1, (c || 1) - 1));
      return;
    }
    // DECSTBM：设置 scroll region（1-based 输入 → 内部 0-based）
    if (cmd === 'r') {
      if (params === '') {
        this.regionTop = 0;
        this.regionBottom = this.rows - 1;
      } else {
        const [t, b] = params.split(';').map(x => parseInt(x || '1', 10));
        this.regionTop = (t || 1) - 1;
        this.regionBottom = (b || this.rows) - 1;
      }
      // DECSTBM 设完光标移到 region 左上角（终端标准行为）
      this.row = this.regionTop;
      this.col = 0;
      return;
    }
    const n = parseInt(params || '1', 10);
    if (cmd === 'A') this.row = Math.max(0, this.row - n);
    else if (cmd === 'B') this.row = Math.min(this.rows - 1, this.row + n);
    else if (cmd === 'C') this.col = Math.min(this.cols, this.col + n);
    else if (cmd === 'D') this.col = Math.max(0, this.col - n);
    else if (cmd === 'G') this.col = Math.max(0, Math.min(this.cols - 1, n - 1));
    else if (cmd === 'K') {
      const row = this.grid[this.row];
      if (row) for (let x = this.col; x < this.cols; x++) row[x] = ' ';
    } else if (cmd === 'J') {
      // 0=光标到屏底，这里近似全清（首帧用）
      const clearFrom = this.row;
      for (let rr = clearFrom; rr < this.rows; rr++) this.grid[rr] = new Array(this.cols).fill(' ');
    }
  }
  line(r: number): string {
    return (this.grid[r] ?? []).map(c => (c === '\u0000' ? '' : c)).join('').replace(/\s+$/, '');
  }
}

describe('主屏 + scroll region + 纯追加渲染器', () => {
  describe('主屏模式（不进 alt screen，不开鼠标追踪）', () => {
    it('enter 不输出 alt screen（?1049h）', () => {
      const frames: string[] = [];
      const r = new Renderer({ rows: 10, cols: 40, writer: s => frames.push(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      const all = frames.join('');
      expect(all).not.toContain('\x1b[?1049h');
    });

    it('enter 不开鼠标追踪（?1000h）', () => {
      const frames: string[] = [];
      const r = new Renderer({ rows: 10, cols: 40, writer: s => frames.push(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      const all = frames.join('');
      expect(all).not.toContain('\x1b[?1000h');
    });

    it('enter 设置 scroll region（DECSTBM \\x1b[1;Nr）', () => {
      const frames: string[] = [];
      // rows=10, footer=4 → contentRows=6 → region [0,5] → DECSTBM \x1b[1;6r
      const r = new Renderer({ rows: 10, cols: 40, writer: s => frames.push(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      const all = frames.join('');
      // footerHeight=5（border+input+border+spinner+status）→ contentRows=5 → DECSTBM row 5
      expect(all).toContain('\x1b[1;5r');
    });

    it('exit 重置 scroll region（\\x1b[r）', () => {
      const frames: string[] = [];
      const r = new Renderer({ rows: 10, cols: 40, writer: s => frames.push(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      frames.length = 0;
      r.exit();
      const all = frames.join('');
      expect(all).toContain('\x1b[r');
    });
  });

  describe('页脚钉 region 外', () => {
    it('enter 后页脚在屏幕底部（border/input/border/status）', () => {
      const t = new FakeTerminal(10, 40);
      const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
      r.enter();
      // footer=5: row5 border, row6 input, row7 border, row8 spinner(空), row9 status
      expect(t.line(5)).toContain('─');
      expect(t.line(6)).toContain('❯');
      expect(t.line(7)).toContain('─');
      expect(t.line(9)).toContain('MDL');
    });
  });

  describe('纯追加 + 原生 scrollback', () => {
    it('消息超屏：旧行进 scrollback，页脚钉底不动', () => {
      const t = new FakeTerminal(10, 40);
      const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
      r.enter();
      // contentRows=5（footerHeight=5），写 10 条消息 → 前 5 条进 scrollback
      for (let i = 1; i <= 10; i++) { r.printMessage(`msg-${i}`, 'system', {}); }
      r.flushNow();
      // 最早的消息进 scrollback（scrollback 行含尾部空格，用 includes 匹配）
      expect(t.scrollback.some(l => l.includes('msg-1'))).toBe(true);
      // 最新消息在可视区（region 内，5 行：0-4）
      const region = Array.from({ length: 5 }, (_, i) => t.line(i));
      expect(region.some(l => l.includes('msg-10'))).toBe(true);
      // 页脚钉底不动（region 外，不被消息 LF 滚走）
      expect(t.line(9)).toContain('MDL');
    });

    it('纯追加：连续 printMessage 不 CUP 回头改已显示行', () => {
      const frames: string[] = [];
      const r = new Renderer({ rows: 10, cols: 40, writer: s => frames.push(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      frames.length = 0;
      r.printMessage('first', 'system', {});
      r.flushNow();
      const firstOut = frames.join('');
      frames.length = 0;
      r.printMessage('second', 'system', {});
      r.flushNow();
      const secondOut = frames.join('');
      // 第二条消息输出里应含 'second' 文本，不应含 CUU(上移) 去 'first' 那行
      expect(secondOut).toContain('second');
      // 纯追加：不应出现回头上移（A 命令去改旧行）
      // 注意：footer 重画会用 CUP/H，但消息区不该 CUU 回去
      expect(secondOut).not.toMatch(/\x1b\[\d+A/);
    });
  });

  describe('输入框', () => {
    it('setInput 后输入框显示文本', () => {
      const t = new FakeTerminal(10, 40);
      const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      r.setInput('hello world', 5);
      r.flushNow();
      // input 在 row6（contentRows=5, inputStartY=6）
      expect(t.line(6)).toContain('hello world');
    });

    it('setInput 后状态栏仍存在（钉底）', () => {
      const t = new FakeTerminal(10, 40);
      const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'MDL', branch: 'b' } });
      r.enter();
      r.setInput('abc', 1);
      r.flushNow();
      expect(t.line(9)).toContain('MDL');
    });
  });

  describe('流式 Markdown delta 追加', () => {
    it('appendStreamingMarkdown 全文重发只输出 delta 部分', () => {
      const frames: string[] = [];
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r\n]/g, '');
      const r = new Renderer({ rows: 10, cols: 40, writer: s => frames.push(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      frames.length = 0;
      // 第一次：全文 "hello"（带前缀 ●  + 缩进，实际可见文本含 hello）
      r.appendStreamingMarkdown('hello', false);
      r.flushNow();
      const firstText = stripAnsi(frames.join(''));
      frames.length = 0;
      // 第二次：全文 "hello world"（只 delta " world" 应被输出）
      r.appendStreamingMarkdown('hello world', false);
      r.flushNow();
      const secondText = stripAnsi(frames.join(''));
      // 第一次输出了 hello
      expect(firstText).toContain('hello');
      // 第二次只输出 delta " world"（含 world），不重复输出 hello
      expect(secondText).toContain('world');
      expect(secondText).not.toContain('hello');
    });

    it('长行流式：手动折行让每行 ≤ cols，messageRow 不因自动换行失准（内容不破损）', () => {
      // 回归测试：真实终端开 DECAWM，长文本写满一行会自动换行。
      // 若 renderer 没手动折行，messageRow 会失准，后续 cup 定位错误 → 内容行首被覆盖。
      // 本测试用 DECAWM-aware FakeTerminal 验证：长流式文本能完整保留（不破损/错位）。
      const t = new FakeTerminal(12, 20);
      const r = new Renderer({ rows: 12, cols: 20, writer: s => t.write(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      // 一行远超 cols=20 的长文本（无空格，强制断行）
      const longText = 'abcdefghijklmnopqrstuvwxyz'; // 26 字符
      r.appendStreamingMarkdown(longText, true);
      r.flushNow();
      // 完整文本应在 scrollback + 可视区中找到（手动折行成多行，每行 ≤ 20）
      const all = [...t.scrollback, ...Array.from({ length: 12 }, (_, i) => t.line(i))];
      // 逐段检查：abcdefghij / klmnopqrst / uvwxyz（按 cols=20 折）
      expect(all.some(l => l.includes('abcdefghij'))).toBe(true);
      expect(all.some(l => l.includes('uvwxyz'))).toBe(true);
      // 页脚未被覆盖（钉底）
      expect(t.line(11)).toContain('M');
    });

    it('多行流式：每行折行后 messageRow 按视觉行准确推进（第二段不覆盖第一段）', () => {
      const t = new FakeTerminal(12, 15);
      const r = new Renderer({ rows: 12, cols: 15, writer: s => t.write(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      // 两段长文本，每段都会折行
      r.appendStreamingMarkdown('第一段长文本内容这里超过宽度会折行\n第二段也很长同样折行测试', true);
      r.flushNow();
      const all = [...t.scrollback, ...Array.from({ length: 12 }, (_, i) => t.line(i))];
      // 两段内容都应完整存在（不被互相覆盖）
      expect(all.some(l => l.includes('第一段'))).toBe(true);
      expect(all.some(l => l.includes('第二段'))).toBe(true);
    });
  });

  describe('printMessage 应用传入的 style（颜色着色）', () => {
    it('magenta style → 输出含 35m 颜色码', () => {
      const frames: string[] = [];
      const r = new Renderer({ rows: 10, cols: 40, writer: s => frames.push(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      frames.length = 0;
      r.printMessage('● Bash(npm test)', 'system', { fg: 'magenta' });
      r.flushNow();
      const all = frames.join('');
      expect(/\[35m/.test(all)).toBe(true);
      expect(all).toContain('Bash(npm test)');
    });

    it('dim style → 输出含 2m 颜色码', () => {
      const frames: string[] = [];
      const r = new Renderer({ rows: 10, cols: 40, writer: s => frames.push(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      frames.length = 0;
      r.printMessage('⎿  Done', 'system', { dim: true });
      r.flushNow();
      const all = frames.join('');
      expect(/\[2m/.test(all)).toBe(true);
      expect(all).toContain('Done');
    });
  });

  describe('spinner 行（页脚区，不进 scrollback）', () => {
    it('inactive 时 spinner 行空白占位', () => {
      const t = new FakeTerminal(10, 40);
      const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      r.flushNow();
      // spinner 行在 row8（borderBottomY=7, spinnerY=8）
      // inactive 时该行应为空（不含 spinner 帧）
      expect(t.line(8)).not.toContain('⠋');
      expect(t.line(8)).not.toContain('⠙');
    });

    it('startSpinner 后 spinner 行显示帧字符 + label', () => {
      const t = new FakeTerminal(10, 40);
      const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      r.startSpinner('Thinking…');
      r.flushNow();
      // spinner 行应含帧字符和 label
      const spinnerLine = t.line(8);
      expect(spinnerLine).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      expect(spinnerLine).toContain('Thinking…');
      r.stopSpinner(); // 清定时器
    });

    it('stopSpinner 后 spinner 行清空', () => {
      const t = new FakeTerminal(10, 40);
      const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      r.startSpinner('Thinking…');
      r.flushNow();
      r.stopSpinner();
      r.flushNow();
      expect(t.line(8)).not.toContain('⠋');
      expect(t.line(8)).not.toContain('Thinking');
    });

    it('setSpinnerLabel 运行中切换文案', () => {
      const t = new FakeTerminal(10, 40);
      const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      r.startSpinner('Thinking…');
      r.flushNow();
      r.setSpinnerLabel('Running bash…');
      r.flushNow();
      expect(t.line(8)).toContain('Running bash');
      r.stopSpinner();
    });
  });
});
