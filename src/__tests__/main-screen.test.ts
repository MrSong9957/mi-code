// 单测：主屏增长画布渲染器（主屏 + 原生 scrollback + 页脚钉底）
//
// 物理本质验证（对齐 Claude Code 默认行为）：
// - 消息超屏 → 顶部行进 scrollback（用户用终端滚动条翻阅）
// - 页脚（状态栏 + 输入框）钉在可视区底部
// - 增长靠 LF（触发终端滚动进 scrollback），不是 cursor-down
//
// FakeTerminal：解析 ANSI，模拟真实终端（含 \n→scrollback、相对/绝对移动真实落点）。

import { describe, it, expect } from 'vitest';
import { Renderer } from '../renderer/renderer.js';
import { isWideCodePoint } from '../renderer/cell.js';

/** 会模拟真实终端的 FakeTerminal：\n 在视口底部触发滚动（顶行进 scrollback）。 */
class FakeTerminal {
  rows: number;
  cols: number;
  grid: string[][];
  scrollback: string[] = [];
  row = 0;
  col = 0;
  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
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
  /** 换行：视口底部则整体上滚（顶行进 scrollback）——模拟终端原生滚动 */
  private lf(): void {
    if (this.row >= this.rows - 1) {
      this.scrollback.push((this.grid[0] ?? []).map(c => (c === '\u0000' ? '' : c)).join(''));
      for (let r = 0; r < this.rows - 1; r++) this.grid[r] = this.grid[r + 1];
      this.grid[this.rows - 1] = new Array(this.cols).fill(' ');
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
      for (let rr = 0; rr < this.rows; rr++) this.grid[rr] = new Array(this.cols).fill(' ');
    }
  }
  line(r: number): string {
    return (this.grid[r] ?? []).map(c => (c === '\u0000' ? '' : c)).join('').replace(/\s+$/, '');
  }
}

describe('主屏增长画布渲染器', () => {
  describe('页脚钉底', () => {
    it('enter 后：状态栏与输入框存在（内容少时跟随内容底部；填满屏后钉终端底）', () => {
      const t = new FakeTerminal(6, 40);
      const r = new Renderer({ rows: 6, cols: 40, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
      r.enter();
      // 内容少：页脚紧跟内容（在可视区前几行）
      const all = Array.from({ length: 6 }, (_, i) => t.line(i));
      expect(all.some(l => l.includes('MDL'))).toBe(true);
      expect(all.some(l => l.includes('❯'))).toBe(true);
    });
  });

  describe('原生 scrollback（消息超屏滚进历史）', () => {
    it('消息超出一屏：顶部行进 scrollback，最新消息 + 页脚在可视区', () => {
      const t = new FakeTerminal(8, 40);
      const r = new Renderer({ rows: 8, cols: 40, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
      r.enter();
      for (let i = 1; i <= 10; i++) { r.printMessage(`msg-${i}`, 'system', {}); r.flushNow(); }
      // 最早的消息进 scrollback
      expect(t.scrollback.some(l => l.includes('msg-1'))).toBe(true);
      expect(t.scrollback.some(l => l.includes('msg-6'))).toBe(true);
      // 最新消息在可视区
      expect(t.line(0)).toContain('msg-7');
      expect(t.line(3)).toContain('msg-10');
      // 页脚钉底（4行：状态栏 + 上边框 + 输入框 + 下边框）
      expect(t.line(4)).toContain('MDL');
      expect(t.line(6)).toContain('❯');
    });
  });

  describe('输入框', () => {
    it('setInput 后输入框显示文本', () => {
      const t = new FakeTerminal(8, 40);
      const r = new Renderer({ rows: 8, cols: 40, writer: s => t.write(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      r.setInput('hello world', 5);
      r.flushNow();
      const all = Array.from({ length: 8 }, (_, i) => t.line(i));
      expect(all.some(l => l.includes('hello world'))).toBe(true);
    });

    it('setInput 后状态栏仍存在', () => {
      const t = new FakeTerminal(8, 40);
      const r = new Renderer({ rows: 8, cols: 40, writer: s => t.write(s), status: { model: 'MDL', branch: 'b' } });
      r.enter();
      r.setInput('abc', 1);
      r.flushNow();
      const all = Array.from({ length: 8 }, (_, i) => t.line(i));
      expect(all.some(l => l.includes('MDL'))).toBe(true);
    });
  });

  describe('流式 Markdown', () => {
    it('流式追加 + finalize：消息成型、页脚存在', () => {
      const t = new FakeTerminal(8, 50);
      const r = new Renderer({ rows: 8, cols: 50, writer: s => t.write(s), status: { model: 'M', branch: 'b' } });
      r.enter();
      r.appendStreamingMarkdown('# Title', false);
      r.flushNow();
      r.appendStreamingMarkdown('# Title\nbody **bold**', false);
      r.flushNow();
      r.finalizeStreaming();
      // 页脚存在
      const all = [...t.scrollback, ...Array.from({ length: 8 }, (_, i) => t.line(i))];
      expect(all.some(l => l.includes('❯'))).toBe(true);
      expect(all.some(l => l.includes('Title'))).toBe(true);
      expect(all.some(l => l.includes('bold'))).toBe(true);
    });
  });
});
