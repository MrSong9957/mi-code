import { describe, it, expect } from 'vitest';
import { Renderer } from '../renderer/renderer.js';
import { isWideCodePoint } from '../renderer/cell.js';

/** 会模拟真实终端的 FakeTerminal：含 scroll region（DECSTBM），
 *  \n 在 region 底部触发 region 内滚动（顶行进 scrollback）。 */
class FakeTerminal {
  rows: number;
  cols: number;
  grid: string[][];
  scrollback: string[] = [];
  row = 0;
  col = 0;
  scrollTop = 0;
  scrollBottom: number;
  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.scrollBottom = rows - 1;
    this.grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));
  }
  write(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        if (s[i + 1] === '[') {
          // eslint-disable-next-line no-control-regex
          const m = s.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z])/);
          if (m) { this.csi(m[1], m[2]); i += m[0].length; continue; }
        }
        i++; continue;
      }
      if (ch === '\r') { this.col = 0; i++; continue; }
      if (ch === '\n') { this.lf(); i++; continue; }
      const w = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
      if (this.row < this.rows && this.col < this.cols) {
        this.grid[this.row]![this.col] = ch;
        if (w === 2 && this.col + 1 < this.cols) this.grid[this.row]![this.col + 1] = '\u0000';
      }
      this.col = Math.min(this.cols, this.col + w);
      i++;
    }
  }
  /** 换行：在 scroll region 底部则整体上滚（顶行进 scrollback）——模拟终端原生滚动 */
  private lf(): void {
    if (this.row >= this.scrollBottom) {
      this.scrollback.push((this.grid[this.scrollTop] ?? []).map(c => (c === '\u0000' ? '' : c)).join(''));
      for (let r = this.scrollTop; r < this.scrollBottom; r++) this.grid[r] = this.grid[r + 1]!;
      this.grid[this.scrollBottom] = new Array(this.cols).fill(' ');
      this.col = 0;
    } else {
      this.row++;
      this.col = 0;
    }
  }
  private csi(params: string, cmd: string): void {
    if (params.includes('?')) return; // DEC 模式忽略
    if (cmd === 'H') {
      if (params === '') { this.row = 0; this.col = 0; return; }
      const [r, c] = params.split(';').map(x => parseInt(x || '1', 10));
      this.row = Math.max(0, Math.min(this.rows - 1, (r || 1) - 1));
      this.col = Math.max(0, Math.min(this.cols - 1, (c || 1) - 1));
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
      // ED：对齐真实 ANSI（0/空=光标到屏末，1=屏首到光标，2=全屏）。
      const mode = params === '' ? 0 : n;
      const clear = (rr: number) => { this.grid[rr] = new Array(this.cols).fill(' '); };
      const clearFromCol = (rr: number, fromCol: number) => { const row = this.grid[rr]; if (row) for (let x = fromCol; x < this.cols; x++) row[x] = ' '; };
      if (mode === 0) { clearFromCol(this.row, this.col); for (let rr = this.row + 1; rr < this.rows; rr++) clear(rr); }
      else if (mode === 1) { for (let rr = 0; rr < this.row; rr++) clear(rr); clearFromCol(this.row, 0); }
      else if (mode === 2) { for (let rr = 0; rr < this.rows; rr++) clear(rr); }
    } else if (cmd === 'r') {
      // DECSTBM：设置 scroll region。params = "top;bottom" 或空（重置全屏）。
      if (params === '') { this.scrollTop = 0; this.scrollBottom = this.rows - 1; }
      else {
        const [top, bottom] = params.split(';').map(x => parseInt(x || '1', 10));
        this.scrollTop = (top || 1) - 1;
        this.scrollBottom = (bottom || this.rows) - 1;
      }
      this.row = this.scrollTop; // DECSTBM 后光标回 region 顶
      this.col = 0;
    }
  }
  line(r: number): string {
    return (this.grid[r] ?? []).map(c => (c === '\u0000' ? '' : c)).join('').replace(/\s+$/, '');
  }
}

describe('底部区刷新器 refreshFooter（CUP 绝对定位）', () => {
  it('底部区内容总在屏幕最后 footerHeight 行（用 CUP 定位，不依赖光标位置）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    // Task 2 后 commit 末尾的 showCursor 是最后一帧；检查合并输出里 footer 是否被渲染。
    const all = frames.join('');
    expect(all).toContain('\x1b[5;');
    expect(all).toContain('─');
    expect(all).toContain('MDL');
    expect(all).toContain('❯');
  });

  it('底部区用 CUP 绝对定位，不含相对移动 CUB/CUU（避开光标脱钩）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.setInput('hello', 5);
    r.flushNow();
    const all = frames.join('');
    const bigCub = [...all.matchAll(/\x1b\[(\d+)D/g)].map(m => +m[1]!).filter(n => n > 10);
    expect(bigCub).toEqual([]);
  });
});

describe('消息追加器 writeMsgLine（顺序追加）', () => {
  it('连续 printMessage 多条：每条作为新行追加，旧行不重复', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('msg-1', 'system');
    r.flushNow();
    r.printMessage('msg-2', 'system');
    r.flushNow();
    const all = frames.join('');
    expect((all.match(/msg-1/g) || []).length).toBe(1);
    expect((all.match(/msg-2/g) || []).length).toBe(1);
  });

  it('满屏后（消息超过 rows-footerHeight）：最新消息在可视区，不内容重复', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    for (let i = 1; i <= 10; i++) {
      r.printMessage('msg-' + i, 'system');
      r.flushNow();
    }
    const all = frames.join('');
    for (let i = 1; i <= 10; i++) {
      // 负向先行断言：msg-1 不应匹配 msg-10 的前缀（精确匹配整条消息）
      const count = (all.match(new RegExp('msg-' + i + '(?!\\d)', 'g')) || []).length;
      expect(count, 'msg-' + i + ' 出现 ' + count + ' 次（应 ≤1）').toBeLessThanOrEqual(1);
    }
  });
});

describe('流式重写器 rewriteStreamingBlock（退格重写）', () => {
  it('assistant delta 逐字增长：当前块被退格重写，封口后内容保留', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 20, cols: 60,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.appendStreamingMarkdown('hello', false);
    r.flushNow();
    r.appendStreamingMarkdown('hello world', false);
    r.flushNow();
    r.appendStreamingMarkdown('hello world final', true);
    r.flushNow();
    frames.length = 0;
    r.printMessage('next-msg', 'system');
    r.flushNow();
    const all = frames.join('');
    expect(all).toContain('hello world final');
    expect(all).toContain('next-msg');
  });

  it('流式重写用 CUU（退格）回到块起点，范围=块行数（不超过屏幕）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 20, cols: 60,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.appendStreamingMarkdown('first version', false);
    r.flushNow();
    frames.length = 0;
    r.appendStreamingMarkdown('first version extended', false);
    r.flushNow();
    const delta = frames.join('');
    const cuu = [...delta.matchAll(/\x1b\[(\d+)A/g)].map(m => +m[1]!);
    expect(cuu.length, '流式重写应含 CUU 退格').toBeGreaterThan(0);
    expect(Math.max(0, ...cuu)).toBeLessThan(20);
  });
});

describe('边界：clearMessages / resize / enter', () => {
  it('clearMessages 全清屏，lastFlushedLine 归零', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('to-clear', 'system');
    r.flushNow();
    frames.length = 0;
    r.clearMessages();
    r.flushNow();
    expect(frames.join('')).toContain('\x1b[2J');
  });

  it('resize 后消息从 MessageBuffer 重画', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('resize-test', 'system');
    r.flushNow();
    frames.length = 0;
    r.resize(10, 50);
    r.flushNow();
    const all = frames.join('');
    expect(all).toContain('\x1b[2J');
    expect(all).toContain('resize-test');
  });

  it('enter 首帧清屏（\\x1b[2J）并画出页脚', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    const all = frames.join('');
    expect(all).toContain('\x1b[2J');
    expect(all).toContain('MDL');
  });
});

describe('样式精修（SGR 颜色）', () => {
  it('消息行 cells 的 style 被转为 SGR（magenta → 35m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('● magenta test', 'system', { fg: 'magenta' });
    r.flushNow();
    expect(frames.join('')).toContain('\x1b[35m');
  });

  it('边框行带 dim 样式（2m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    expect(frames.join('')).toContain('\x1b[2m');
  });

  it('prompt 带 green+bold 样式（32m + 1m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    const all = frames.join('');
    expect(all).toContain('\x1b[32m');
    expect(all).toContain('\x1b[1m');
  });

  it('状态栏 cells 的 style 被转为 SGR（cyan → 36m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    expect(frames.join('')).toContain('\x1b[36m');
  });
});

describe('消息区/footer 区隔离（满屏不重叠）', () => {
  it('满屏后：消息进 scrollback，footer 仍在底部，消息不覆盖 footer', () => {
    const t = new FakeTerminal(10, 40);
    const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
    r.enter();
    for (let i = 1; i <= 10; i++) { r.printMessage('msg-' + i, 'system', {}); r.flushNow(); }
    // footer 在底部（row 7 含 ❯，row 9 含 MDL）
    expect(t.line(7)).toContain('❯');
    expect(t.line(9)).toContain('MDL');
    // 最新消息在可视区消息行
    const visible = Array.from({ length: 10 }, (_, i) => t.line(i));
    expect(visible.some(l => l.includes('msg-10'))).toBe(true);
    // 早期消息进 scrollback
    expect(t.scrollback.length).toBeGreaterThan(0);
  });

  it('消息行不覆盖 footer 边框（row 6 / row 8 为边框 ─，不含 msg）', () => {
    const t = new FakeTerminal(10, 40);
    const r = new Renderer({ rows: 10, cols: 40, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
    r.enter();
    for (let i = 1; i <= 12; i++) { r.printMessage('msg-' + i, 'system', {}); r.flushNow(); }
    // 上边框 row 6、下边框 row 8：应为纯 ─，不含 msg
    expect(t.line(6)).toContain('─');
    expect(t.line(6)).not.toContain('msg');
    expect(t.line(8)).toContain('─');
    expect(t.line(8)).not.toContain('msg');
  });

  it('enter 首帧即设置 scroll region（含 DECSTBM \x1b[1;Nr 序列）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 10, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    const all = frames.join('');
    // footerHeight=4 → contentRows=6 → scroll region = rows 1..6（1-based）
    expect(all).toContain('\x1b[1;6r');
  });
});
