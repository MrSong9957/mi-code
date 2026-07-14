import { describe, it, expect, beforeEach } from 'vitest';
import { InlineDynamicGrid } from './inline-dynamic-grid.js';
import { layoutFooter } from './layout.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
    columns: 80,
    rows: 30,
  };
}

function makeFooter(cols = 80) {
  return layoutFooter({
    input: '', cursor: 0, status: 'test', cols,
    suggestions: [], dropdownIndex: 0, viewportTop: 0,
  });
}

describe('InlineDynamicGrid.commit', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let grid: InlineDynamicGrid;

  beforeEach(() => {
    mock = createMockStdout();
    grid = new InlineDynamicGrid(mock as unknown as NodeJS.WriteStream);
  });

  it('首次写入（草稿+footer）：全量 diff', () => {
    const footer = makeFooter();
    grid.commit(['● hello'], footer, 5, 80);
    const output = mock.output;
    // topRow=5, yBias=4 → CUP row=5
    expect(output).toContain('\x1b[5;');
    // 草稿内容
    expect(output).toContain('hello');
    // footer 内容（border）
    expect(output).toContain('─');
  });

  it('无草稿（只有 footer）：全量 diff footer', () => {
    const footer = makeFooter();
    grid.commit(null, footer, 5, 80);
    const output = mock.output;
    expect(output).toContain('─');
    // 不应含草稿内容
    expect(output).not.toContain('●');
  });

  it('草稿增量（加了一个字）：只输出变化的 cell，不擦整行', () => {
    const footer = makeFooter();
    grid.commit(['● hello'], footer, 5, 80);
    mock.written.length = 0;

    grid.commit(['● hello!'], footer, 5, 80);
    const output = mock.output;
    // 只加了一个 '!'，不应含整行擦除
    expect(output).not.toContain('\x1b[2K');
    expect(output).toContain('!');
  });

  it('footer 内容变化（输入文字）：只 diff footer 变化的 cell', () => {
    grid.commit(['● hello'], makeFooter(), 5, 80);
    mock.written.length = 0;

    const footer2 = layoutFooter({
      input: 'hi', cursor: 2, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    grid.commit(['● hello'], footer2, 5, 80);
    const output = mock.output;
    // 应含 'hi'（footer 输入框新增）
    expect(output).toMatch(/hi/);
  });

  it('草稿行数增加（1→3）：footer 自动下移，一次 diff', () => {
    // 用空草稿起始，避免旧 footer 内容残留在草稿行位置
    grid.commit(null, makeFooter(), 5, 80);
    mock.written.length = 0;

    grid.commit(['● hello', '  world', '  foo'], makeFooter(), 5, 80);
    const output = mock.output;
    // 新增的草稿行
    expect(output).toContain('hello');
    expect(output).toContain('foo');
    // footer 也应在新位置出现（border）
    expect(output).toContain('─');
  });

  it('草稿行数减少（3→1）：footer 自动上移，多余行清除', () => {
    grid.commit(['● hello', '  world', '  foo'], makeFooter(), 5, 80);
    mock.written.length = 0;

    grid.commit(['● hello'], makeFooter(), 5, 80);
    const output = mock.output;
    // world/foo 应被清除
    expect(output).not.toMatch(/world/);
    expect(output).not.toMatch(/foo/);
  });

  it('连续两次完全相同：diff 为空（零输出）', () => {
    const footer = makeFooter();
    grid.commit(['● hello'], footer, 5, 80);
    mock.written.length = 0;

    grid.commit(['● hello'], footer, 5, 80);
    const output = mock.output;
    // 不应含任何内容字符（diff 为空）
    expect(output).not.toContain('hello');
    expect(output).not.toContain('─');
  });

  it('草稿消失（流式→固化）：null 替代草稿，旧草稿区清除', () => {
    grid.commit(['● hello', '  world'], makeFooter(), 5, 80);
    mock.written.length = 0;

    // 固化后无草稿
    grid.commit(null, makeFooter(), 5, 80);
    const output = mock.output;
    // 草稿内容应被清除
    expect(output).not.toContain('hello');
    expect(output).not.toContain('world');
    // footer 仍存在
    expect(output).toContain('─');
  });

  it('topRow 变化：在新位置全量重画', () => {
    const footer = makeFooter();
    grid.commit(['● hello'], footer, 5, 80);
    mock.written.length = 0;

    grid.commit(['● hello'], footer, 7, 80);
    const output = mock.output;
    // 新位置 CUP row=7
    expect(output).toContain('\x1b[7;');
  });
});
