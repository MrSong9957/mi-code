import { describe, it, expect, beforeEach } from 'vitest';
import { InlineGridRenderer } from './grid-renderer.js';
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

describe('InlineGridRenderer.commitFooter', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineGridRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineGridRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('首次写入：全量重画 footer（front 全 0 → 所有 cell 都变）', () => {
    const layout = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 27, 80);
    const output = mock.output;
    // footerTopRow = 30 - 4 + 1 = 27, yBias = 26
    // 应含 CUP 定位到 row 27+
    expect(output).toContain('\x1b[27;');
    // 应含 border 字符（─）
    expect(output).toContain('─');
  });

  it('连续两次相同内容：第二次 diff 为空（无变化的 cell）', () => {
    const layout = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 27, 80);
    mock.written.length = 0;  // 清空，只看第二次

    renderer.commitFooter(layout, 27, 80);
    const output = mock.output;
    // diff(front, back) 应无变化 → emit 只输出 BSU + reset + ESU + cursor
    // 不应含 border 字符（没变化不需要重写）
    expect(output).not.toContain('─');
  });

  it('内容变化（输入文字）：只 diff 变化的 cell', () => {
    const layout1 = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout1, 27,80);
    mock.written.length = 0;

    const layout2 = layoutFooter({
      input: 'hi', cursor: 2, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout2, 27,80);
    const output = mock.output;
    // 应含 'h' 和 'i'（输入框新增的字符）
    expect(output).toMatch(/hi/);
  });

  it('cols 变化（宽度缩小）：border 长度更新', () => {
    const layout1 = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout1, 27,80);
    mock.written.length = 0;

    const layout2 = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 40,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout2, 27,40);
    const output = mock.output;
    // 新 border 应是 39 个 ─（usableWidth=40-1=39）
    expect(output).toContain('─'.repeat(39));
    // 不应含旧的长 border（79 个 ─）
    expect(output).not.toContain('─'.repeat(79));
  });

  it('footer 高度变化（suggestion 展开）：先清旧区域再重画', () => {
    const layout1 = layoutFooter({
      input: '/', cursor: 1, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout1, 27,80);
    expect(layout1.height).toBe(4);
    mock.written.length = 0;

    const layout2 = layoutFooter({
      input: '/', cursor: 1, status: 'test', cols: 80,
      suggestions: ['cmd-a', 'cmd-b', 'cmd-c'], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout2, 27,80);
    expect(layout2.height).toBe(7);
    const output = mock.output;
    // 高度变化 → 先清旧区域（CUP + ED）
    expect(output).toContain('\x1b[0J');
  });
});

describe('InlineGridRenderer.clearForResize', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineGridRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineGridRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('clearForResize 执行 CUP + ED（清旧 footer 区域）', () => {
    const layout = layoutFooter({
      input: 'hi', cursor: 2, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 27, 80);
    mock.written.length = 0;

    renderer.clearForResize();
    const output = mock.output;
    // footerTopRow=27 → CUP(27,1)
    expect(output).toContain('\x1b[27;1H');
    // ED（清到屏幕底）
    expect(output).toContain('\x1b[0J');
  });

  it('clearForResize 后 commitFooter 走全量重画（front 全 0）', () => {
    const layout = layoutFooter({
      input: 'hi', cursor: 2, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 27, 80);
    renderer.clearForResize();
    mock.written.length = 0;

    renderer.commitFooter(layout, 27, 80);
    const output = mock.output;
    // 全量重画：应含 border 字符（所有 cell 都变）
    expect(output).toContain('─');
  });

  it('clearForResize 在 db=null 时是 no-op（无 footer 可清）', () => {
    // 不先 commitFooter，直接 clearForResize
    renderer.clearForResize();
    expect(mock.written.length).toBe(0);
  });

  it('dispose 等同 clearForResize（清除 footer）', () => {
    const layout = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 27, 80);
    mock.written.length = 0;

    renderer.dispose();
    const output = mock.output;
    expect(output).toContain('\x1b[0J');
  });
});
