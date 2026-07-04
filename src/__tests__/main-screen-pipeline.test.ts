// 复现：用项目的 FakeTerminal（正确模拟 scrollback）测 pipeline 超屏渲染
import { describe, it, expect } from 'vitest';
import { Renderer } from '../renderer/renderer.js';
import { BlockPipeline } from '../ui/block-pipeline.js';
import { isWideCodePoint } from '../renderer/cell.js';

class FakeTerminal {
  rows: number; cols: number; grid: string[][]; scrollback: string[] = []; row = 0; col = 0;
  /** scroll region 边界（含两端，0-based）；默认全屏 */
  private regionTop = 0;
  private regionBottom: number;
  constructor(r: number, c: number) { this.rows = r; this.cols = c; this.grid = Array.from({ length: r }, () => new Array(c).fill(' ')); this.regionBottom = r - 1; }
  write(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        if (s[i + 1] === '[') {
          const m = s.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z<])/);
          if (m) {
            if (m[2] !== '<') this.csi(m[1], m[2]);
            i += m[0].length; continue;
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
      this.scrollback.push((this.grid[this.regionTop] ?? []).map(c => (c === '\u0000' ? '' : c)).join(''));
      for (let r = this.regionTop; r < this.regionBottom; r++) this.grid[r] = this.grid[r + 1];
      this.grid[this.regionBottom] = new Array(this.cols).fill(' ');
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
    // DECSTBM：设置 scroll region（1-based 输入 → 0-based 内部）
    if (cmd === 'r') {
      if (params === '') { this.regionTop = 0; this.regionBottom = this.rows - 1; }
      else {
        const [t, b] = params.split(';').map(x => parseInt(x || '1', 10));
        this.regionTop = (t || 1) - 1;
        this.regionBottom = (b || this.rows) - 1;
      }
      this.row = this.regionTop; this.col = 0; // DECSTBM 设完光标移到 region 左上角
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

describe('BlockPipeline 超屏渲染（症状 A+B：坐标错乱 / 横向拉伸 / footer 串入）', () => {
  // 物理本质：增长画布在内容超过终端高度（产生 scrollback）后，diff 的相对光标移动
  // 无法可靠映射画布坐标→物理行。对齐 Claude Code shouldClearScreen：一旦溢出，整屏重画。
  // 这些测试用正确模拟 scrollback 的 FakeTerminal 复现并守住该修复。

  it('超屏后可视区能看到最近的工具结果，且 footer 不串入内容区', () => {
    const t = new FakeTerminal(14, 70);
    const r = new Renderer({ rows: 14, cols: 70, writer: s => t.write(s), status: { model: 'mimo', branch: 'master', dir: '~/mi-code', mode: 'Act', contextUsage: 0 } });
    r.enter();
    const p = new BlockPipeline(r);
    // 第一轮：thinking + assistant + bash（输出多行，制造滚动）
    p.emit({ kind: 'thinking_start' });
    p.emit({ kind: 'thinking_delta', content: '思考内容第一行\n第二行' });
    p.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });
    p.emit({ kind: 'assistant_text', text: '我来运行命令查看目录', isFinal: true });
    p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls -la' } });
    p.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1\nfile2\nfile3\nfile4\nfile5\nfile6\nfile7' });
    // 第二轮：又一个工具调用（内容总量远超 14 行）
    p.emit({ kind: 'assistant_text', text: '读取配置文件', isFinal: true });
    p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'README.md' } });
    p.emit({ kind: 'tool_result', name: 'read_file', output: 'line1\nline2\nline3\nline4\nline5\nline6' });
    r.flushNow();
    r.exit();

    const visible = Array.from({ length: 14 }, (_, i) => t.line(i));
    // 断言 1：最近一次工具调用应出现在可视区，而不是被错位到全空区域。
    const hasReadCall = visible.some(l => l.includes('Read(README.md)'));
    expect(hasReadCall, `可视区应含 Read(README.md)，实际：${JSON.stringify(visible)}`).toBe(true);

    // 断言 2：footer（上边框+输入+下边框+状态栏 = 4 行）钉在底部；
    // border（─）不应串入内容区（可视区上半部分）。
    // footerHeight=5: 上边框 + 输入区 + 下边框 + spinner行 + 状态栏
    const FOOTER_HEIGHT = 5;
    const contentArea = visible.slice(0, visible.length - FOOTER_HEIGHT);
    const borderInContent = contentArea.filter(l => l.includes('─'));
    expect(borderInContent, `border 不应串入内容区，实际：${JSON.stringify(borderInContent)}`).toEqual([]);
  });

  it('超屏后无横向拉伸：任何可视行不应同时含两个 ● 前缀', () => {
    const t = new FakeTerminal(14, 70);
    const r = new Renderer({ rows: 14, cols: 70, writer: s => t.write(s), status: { model: 'mimo', branch: 'master', dir: '~/mi-code', mode: 'Act', contextUsage: 0 } });
    r.enter();
    const p = new BlockPipeline(r);
    p.emit({ kind: 'thinking_start' });
    p.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
    p.emit({ kind: 'assistant_text', text: 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8', isFinal: true });
    p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
    p.emit({ kind: 'tool_result', name: 'run_bash', output: 'a\nb\nc\nd\ne\nf\ng\nh' });
    p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'x.md' } });
    p.emit({ kind: 'tool_result', name: 'read_file', output: 'p\nq\nr\ns\nt' });
    r.flushNow();
    r.exit();

    const visible = Array.from({ length: 14 }, (_, i) => t.line(i));
    // 横向拉伸标志：一行挤了多个块标题（多个 ●）。正常时每个 ● 独占一行。
    const stretched = visible.filter(l => (l.match(/●/g) ?? []).length > 1);
    expect(stretched, `不应有横向拉伸行，实际：${JSON.stringify(stretched)}`).toEqual([]);
  });

  it('超屏后 footer 状态栏只出现一次（无重复 footer）', () => {
    const t = new FakeTerminal(12, 60);
    const r = new Renderer({ rows: 12, cols: 60, writer: s => t.write(s), status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 } });
    r.enter();
    const p = new BlockPipeline(r);
    p.emit({ kind: 'thinking_start' });
    p.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
    p.emit({ kind: 'assistant_text', text: 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8', isFinal: true });
    p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
    p.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1\nfile2\nfile3' });
    r.flushNow();
    r.exit();
    const visibleLines = Array.from({ length: 12 }, (_, i) => t.line(i));
    const mdlCount = visibleLines.filter(l => l.includes('MDL')).length;
    // FakeTerminal 不模拟 alt screen 切换，footer 状态栏仍在 visible（真实终端会因 ?1049l 消失）
    expect(mdlCount).toBe(1); // footer 状态栏只出现一次（无重复）
  });
});

describe('ctrl+o 临时 alt screen 覆盖层（getLastExpandableFullLines）', () => {
  it('thinking 折叠态主屏显示摘要，完整内容经 getLastExpandableFullLines 取出', () => {
    const t = new FakeTerminal(20, 70);
    const r = new Renderer({ rows: 20, cols: 70, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
    r.enter();
    const p = new BlockPipeline(r);
    p.emit({ kind: 'thinking_start' });
    p.emit({ kind: 'thinking_delta', content: '这是被折叠的完整思考内容，应该只在展开后显示。' });
    p.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
    r.flushNow();
    // 主屏折叠态：含摘要，不含完整思考（完整内容不在主屏）
    const screen = [...t.scrollback, ...Array.from({ length: 20 }, (_, i) => t.line(i))];
    expect(screen.some(l => l.includes('Thought for'))).toBe(true);
    // 完整内容经覆盖层 API 取出（ctrl+o 进 alt screen 渲染）
    const expandable = p.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    expect(expandable!.kind).toBe('thinking');
    expect(expandable!.lines.some(l => l.content.includes('被折叠的完整思考'))).toBe(true);
  });

  it('tool_result 截断时折叠显示预览，完整输出经覆盖层 API 取出', () => {
    const t = new FakeTerminal(20, 70);
    const r = new Renderer({ rows: 20, cols: 70, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
    r.enter();
    const p = new BlockPipeline(r);
    p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
    p.emit({ kind: 'tool_result', name: 'run_bash', output: 'f1\nf2\nf3\nf4\nf5\nf6\nf7' });
    r.flushNow();
    // 主屏折叠态不含 f7（被截断）
    const screen = [...t.scrollback, ...Array.from({ length: 20 }, (_, i) => t.line(i))];
    expect(screen.some(l => l.includes('f7'))).toBe(false);
    // 完整输出（含 f7）经覆盖层 API 取出
    const expandable = p.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    expect(expandable!.kind).toBe('tool_result');
    expect(expandable!.lines.some(l => l.content.includes('f7'))).toBe(true);
  });

  it('ctrl+o 覆盖层不破坏主屏内容（主屏 scrollback 完好，用户输入仍在）', () => {
    const t = new FakeTerminal(20, 70);
    const r = new Renderer({ rows: 20, cols: 70, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
    r.enter();
    const p = new BlockPipeline(r);
    p.emit({ kind: 'user_input', text: '你好世界' });
    p.emit({ kind: 'thinking_start' });
    p.emit({ kind: 'thinking_delta', content: '思考内容' });
    p.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });
    p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
    p.emit({ kind: 'tool_result', name: 'run_bash', output: 'f1\nf2\nf3\nf4\nf5\nf6\nf7' });
    r.flushNow();
    // 取覆盖层内容（ctrl+o 会进 alt screen 渲染它，主屏不动）
    const expandable = p.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    // 主屏内容完好：用户输入仍在（覆盖层不碰主屏）
    const screen = [...t.scrollback, ...Array.from({ length: 20 }, (_, i) => t.line(i))];
    expect(screen.some(l => l.includes('你好世界')), '主屏应保留用户输入').toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 多轮 agent loop 累积场景（真实乱码根因复现）
//
// 物理本质：MessageBuffer 只增不减。多轮（thinking+assistant+tool 循环）下，
// 每轮内容累积进同一个 lines[]，next.rows（=全部历史+footer）逐轮膨胀到远超终端高度。
// 此时画布「稳定增长」（新内容加在底部=可视区），应走增量 LF 滚动进原生 scrollback，
// 而非每帧全清屏（全清屏在真实终端会闪屏+乱码）。
//
// 这是用户实际遇到的乱码场景：一次查询触发多轮工具调用，
// 整段对话被反复重画、状态栏串入内容区、内容横向拉伸。
// ════════════════════════════════════════════════════════════════════
describe('多轮 agent loop 累积渲染（真实乱码根因）', () => {
  it('3 轮工具调用累积后：可视区显示最近内容，无横向拉伸，footer 不串入内容区', () => {
    const t = new FakeTerminal(14, 70);
    const r = new Renderer({ rows: 14, cols: 70, writer: s => t.write(s), status: { model: 'mimo', branch: 'master', dir: '~/mi-code', mode: 'Act', contextUsage: 0 } });
    r.enter();
    const p = new BlockPipeline(r);

    // 模拟 3 轮完整 agent loop（贴近真实：每轮 thinking+assistant+tool_call+tool_result）
    // 每轮 emit 多个块，累积后画布远超 14 行
    for (let turn = 1; turn <= 3; turn++) {
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_delta', content: `第${turn}轮思考内容，分析问题` });
      p.emit({ kind: 'thinking_end', durationSec: turn, filesRead: 0 });
      p.emit({ kind: 'assistant_text', text: `第${turn}轮回复：执行工具`, isFinal: true });
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: `cmd-${turn}` } });
      p.emit({ kind: 'tool_result', name: 'run_bash', output: `out-${turn}-1\nout-${turn}-2\nout-${turn}-3\nout-${turn}-4\nout-${turn}-5` });
    }
    r.flushNow();
    r.exit();

    const visible = Array.from({ length: 14 }, (_, i) => t.line(i));

    // 断言 1：最近一轮（第3轮）的工具调用应出现在可视区，而非全空/错位
    const hasTurn3 = visible.some(l => l.includes('cmd-3'));
    expect(hasTurn3, `可视区应含第3轮工具 cmd-3，实际：${JSON.stringify(visible)}`).toBe(true);

    // 断言 2：无横向拉伸——任何可视行不应同时含两个 ● 前缀（多个块标题挤一行）
    const stretched = visible.filter(l => (l.match(/●/g) ?? []).length > 1);
    expect(stretched, `不应有横向拉伸行，实际：${JSON.stringify(stretched)}`).toEqual([]);

    // 断言 3：footer（上border+输入+下border+spinner+状态栏=5行）钉在底部，
    // border 不应串入内容区（可视区上半部分）
    const FOOTER_HEIGHT = 5;
    const contentArea = visible.slice(0, visible.length - FOOTER_HEIGHT);
    const borderInContent = contentArea.filter(l => l.includes('─'));
    expect(borderInContent, `border 不应串入内容区，实际：${JSON.stringify(borderInContent)}`).toEqual([]);

    // 断言 4：状态栏只出现一次（FakeTerminal 不模拟 alt screen，真实终端 exit 后会消失）
    const statusCount = visible.filter(l => l.includes('mimo')).length;
    expect(statusCount, `状态栏应只出现 1 次，实际 ${statusCount} 次`).toBe(1);
  });

  it('累积后历史进原生 scrollback（纯追加 + DECSTBM，用户用滚动条翻历史）', () => {
    const t = new FakeTerminal(14, 70);
    const r = new Renderer({ rows: 14, cols: 70, writer: s => t.write(s), status: { model: 'mimo', branch: 'master', dir: '~/mi-code', mode: 'Act', contextUsage: 0 } });
    r.enter();
    const p = new BlockPipeline(r);

    // 2 轮，第1轮内容会超出可视区进原生 scrollback
    for (let turn = 1; turn <= 2; turn++) {
      p.emit({ kind: 'assistant_text', text: `第${turn}轮标记文本`, isFinal: true });
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: `cmd-${turn}` } });
      p.emit({ kind: 'tool_result', name: 'run_bash', output: `out-${turn}-1\nout-${turn}-2\nout-${turn}-3\nout-${turn}-4\nout-${turn}-5\nout-${turn}-6` });
    }
    r.flushNow();

    // 第2轮最新工具调用/结果在可视区（assistant_text 已随滚动进 scrollback）
    const visible = Array.from({ length: 14 }, (_, i) => t.line(i));
    expect(visible.some(l => l.includes('cmd-2')), '第2轮最新工具调用应可见').toBe(true);
    // 第1轮内容进原生 scrollback（用户用终端滚动条翻阅，不丢失）
    expect(t.scrollback.some(l => l.includes('第1轮标记文本')), '第1轮应进 scrollback').toBe(true);
    // 两轮内容都在（scrollback + 可视区）
    const all = [...t.scrollback, ...visible];
    expect(all.some(l => l.includes('第1轮标记文本'))).toBe(true);
    expect(all.some(l => l.includes('第2轮标记文本'))).toBe(true);

    r.exit();
  });
});

// ════════════════════════════════════════════════════════════════════
// thinking_end 时序：Thought for Ns 应紧跟思考内容，在 tool_call 之前
//
// 物理本质：模型回复顺序常为「thinking 块 → tool_use 块」。思考块结束
// （content_block_stop）是精确信号，Thought for Ns 应在那时打印，
// 而非推迟到工具调用之后的 text delta。这个测试验证 pipeline 在正确
// emit 序列（thinking_start → delta → end → tool_call）下渲染顺序正确。
// ════════════════════════════════════════════════════════════════════
describe('thinking_end 时序（Thought for Ns 位置）', () => {
  it('Thought for Ns 渲染在 tool_call 之前（思考→工具场景）', () => {
    const t = new FakeTerminal(30, 70);
    const r = new Renderer({ rows: 30, cols: 70, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
    r.enter();
    const p = new BlockPipeline(r);
    // 正确 emit 序列：thinking 块完整结束后才 tool_call（index.ts 修复后的行为）
    p.emit({ kind: 'thinking_start' });
    p.emit({ kind: 'thinking_delta', content: '分析问题' });
    p.emit({ kind: 'thinking_end', durationSec: 10, filesRead: 0 });
    p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
    p.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1\nfile2' });
    r.flushNow();
    r.exit();

    // 收集所有渲染行（scrollback + 可视区），保留顺序
    const all = [...t.scrollback, ...Array.from({ length: 30 }, (_, i) => t.line(i))];
    const thoughtIdx = all.findIndex(l => l.includes('Thought for'));
    const toolCallIdx = all.findIndex(l => l.includes('Bash(ls)'));

    expect(thoughtIdx, '应有 Thought for 行').toBeGreaterThanOrEqual(0);
    expect(toolCallIdx, '应有 Bash(ls) 行').toBeGreaterThanOrEqual(0);
    // 关键：Thought for 在 tool_call 之前
    expect(thoughtIdx, `Thought for(${thoughtIdx}) 应在 Bash(ls)(${toolCallIdx}) 之前`).toBeLessThan(toolCallIdx);
  });

  it('thinking_end 与下一条消息之间有空行分隔', () => {
    const t = new FakeTerminal(30, 70);
    const r = new Renderer({ rows: 30, cols: 70, writer: s => t.write(s), status: { model: 'MDL', branch: 'main' } });
    r.enter();
    const p = new BlockPipeline(r);
    // 思考 → 思考结束 → 文本回复（实测：Thought for 与 ● 文本间缺空行）
    p.emit({ kind: 'thinking_start' });
    p.emit({ kind: 'thinking_delta', content: '分析' });
    p.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
    p.emit({ kind: 'assistant_text', text: '回复内容', isFinal: true });
    r.flushNow();
    r.exit();

    const all = [...t.scrollback, ...Array.from({ length: 30 }, (_, i) => t.line(i))];
    const thoughtIdx = all.findIndex(l => l.includes('Thought for'));
    const replyIdx = all.findIndex(l => l.includes('回复内容'));
    expect(thoughtIdx).toBeGreaterThanOrEqual(0);
    expect(replyIdx).toBeGreaterThan(thoughtIdx);
    // 关键：Thought for 与回复之间应至少有一个空行
    const between = all.slice(thoughtIdx + 1, replyIdx);
    expect(between.some(l => l.trim() === ''), `Thought for 与回复之间应有空行，实际中间行：${JSON.stringify(between)}`).toBe(true);
  });
});
