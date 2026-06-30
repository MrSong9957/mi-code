// 复现：用项目的 FakeTerminal（正确模拟 scrollback）测 pipeline 超屏渲染
import { describe, it, expect } from 'vitest';
import { Renderer } from '../renderer/renderer.js';
import { BlockPipeline } from '../ui/block-pipeline.js';
import { isWideCodePoint } from '../renderer/cell.js';

class FakeTerminal {
  rows: number; cols: number; grid: string[][]; scrollback: string[] = []; row = 0; col = 0;
  constructor(r: number, c: number) { this.rows = r; this.cols = c; this.grid = Array.from({ length: r }, () => new Array(c).fill(' ')); }
  write(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        if (s[i + 1] === '[') {
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
  private lf(): void {
    if (this.row >= this.rows - 1) {
      this.scrollback.push((this.grid[0] ?? []).map(c => (c === '\u0000' ? '' : c)).join(''));
      for (let r = 0; r < this.rows - 1; r++) this.grid[r] = this.grid[r + 1];
      this.grid[this.rows - 1] = new Array(this.cols).fill(' ');
      this.col = 0;
    } else { this.row++; this.col = 0; }
  }
  private csi(params: string, cmd: string): void {
    if (params.includes('?')) return;
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
    else if (cmd === 'K') { const row = this.grid[this.row]; if (row) for (let x = this.col; x < this.cols; x++) row[x] = ' '; }
    else if (cmd === 'J') { for (let rr = 0; rr < this.rows; rr++) this.grid[rr] = new Array(this.cols).fill(' '); }
  }
  line(r: number): string { return (this.grid[r] ?? []).map(c => (c === '\u0000' ? '' : c)).join('').replace(/\s+$/, ''); }
}

describe('BlockPipeline 超屏渲染（复现乱码）', () => {
  it('超屏后无重复 footer / 无内容错位', () => {
    const t = new FakeTerminal(12, 60);
    const r = new Renderer({ rows: 12, cols: 60, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
    r.enter();
    const p = new BlockPipeline(r);
    // 模拟流式：内容远超 12 行
    p.emit({ kind: 'thinking_start' });
    p.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
    p.emit({ kind: 'assistant_text', text: 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8', isFinal: true });
    p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
    p.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1\nfile2\nfile3' });
    r.flushNow();
    r.exit();
    // 检查：可视区内 footer 只出现一次（状态栏 MDL 只在最后一行）
    const visibleLines = Array.from({ length: 12 }, (_, i) => t.line(i));
    const mdlCount = visibleLines.filter(l => l.includes('MDL')).length;
    console.log('VISIBLE:', JSON.stringify(visibleLines));
    console.log('MDL count in visible:', mdlCount);
    expect(mdlCount).toBe(1); // footer 状态栏应只出现一次
  });
});

it('多轮超屏渲染可视化（打印调试）', () => {
  const t = new FakeTerminal(14, 70);
  const r = new Renderer({ rows: 14, cols: 70, writer: s => t.write(s), status: { model: 'mimo', branch: 'master', dir: '~/mi-code', mode: 'Act', contextUsage: 0 } });
  r.enter();
  const p = new BlockPipeline(r);
  p.emit({ kind: 'thinking_start' });
  p.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
  let txt = '';
  for (const c of ['我是你的助手。\n', '我可以：\n', '1. 执行命令\n', '2. 编辑文件\n', '3. 代码审查\n']) { txt += c; p.emit({ kind: 'assistant_text', text: txt, isFinal: false }); }
  p.emit({ kind: 'assistant_text', text: txt, isFinal: true });
  p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'pwd' } });
  p.emit({ kind: 'tool_result', name: 'run_bash', output: '/home/user' });
  p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
  p.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1\nfile2' });
  r.flushNow();
  r.exit();
  console.log('═══ scrollback ═══');
  t.scrollback.forEach((l, i) => console.log(`[s${i}] ${l.slice(0, 65)}`));
  console.log('═══ 可视区 ═══');
  for (let i = 0; i < 14; i++) console.log(`[${i}] ${t.line(i).slice(0, 65)}`);
  const visibleMdl = Array.from({ length: 14 }, (_, i) => t.line(i)).filter(l => l.includes('mimo')).length;
  console.log('可视区状态栏次数:', visibleMdl);
  expect(visibleMdl).toBe(1);
});
