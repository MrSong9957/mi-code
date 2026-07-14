import { describe, it, expect, beforeEach } from 'vitest';
import { StreamingGridRenderer } from './streaming-grid-renderer.js';

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

describe('StreamingGridRenderer.commitStream', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let grid: StreamingGridRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    grid = new StreamingGridRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('首次写入：全量 diff（front 全 0 → 所有 cell 都变）', () => {
    grid.commitStream(['● hello', '  world'], 5, 80);
    const output = mock.output;
    // topRow=5, yBias=4 → CUP row=5+
    expect(output).toContain('\x1b[5;');
    expect(output).toContain('hello');
    expect(output).toContain('world');
  });

  it('增量更新（微调内容）：只输出变化的 cell，不擦整行', () => {
    grid.commitStream(['● hello'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello!'], 5, 80);
    const output = mock.output;
    // 只加了一个 '!'，不应含 \r\x1b[2K（整行擦除）
    expect(output).not.toContain('\x1b[2K');
    // 应含 '!' 字符
    expect(output).toContain('!');
  });

  it('行数增加（1→3）：旧行增量 + 新行追加', () => {
    grid.commitStream(['● hello'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello', '  world', '  foo'], 5, 80);
    const output = mock.output;
    expect(output).toContain('world');
    expect(output).toContain('foo');
  });

  it('行数减少（3→1）：多余行清除（不留残留）', () => {
    grid.commitStream(['● hello', '  world', '  foo'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello'], 5, 80);
    const output = mock.output;
    // world 和 foo 应被清除——diff 输出空格覆盖
    // 关键：buffer 高度取 max(3,1)=3，第 2-3 行 front 有旧内容，back 为空 → 清除 patch
    // 不应残留 world/foo 的字符
    expect(output).not.toMatch(/world/);
    expect(output).not.toMatch(/foo/);
  });

  it('连续两次相同内容：第二次 diff 为空', () => {
    grid.commitStream(['● hello'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello'], 5, 80);
    const output = mock.output;
    // diff 为空 → emit 只输出 BSU + reset + ESU（不含 hello）
    expect(output).not.toContain('hello');
  });

  it('topRow 变化（草稿位置移动）：新位置全量重画', () => {
    grid.commitStream(['● hello'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello'], 7, 80);
    const output = mock.output;
    // topRow 从 5 变 7 → CUP row=7
    expect(output).toContain('\x1b[7;');
  });
});

describe('StreamingGridRenderer.clear', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let grid: StreamingGridRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    grid = new StreamingGridRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('clear 后草稿区内容被擦除', () => {
    grid.commitStream(['● hello', '  world'], 5, 80);
    mock.written.length = 0;

    grid.clear();
    const output = mock.output;
    // front 有内容，back 全空 → diff 输出清除 patch
    expect(output).toContain('\x1b[5;');
    expect(output).not.toContain('hello');
  });

  it('clear 在 db=null 时是 no-op', () => {
    grid.clear();
    expect(mock.written.length).toBe(0);
  });

  it('clear 用内部 lastTopRow（不依赖外部传值）', () => {
    grid.commitStream(['● hello'], 7, 80);
    mock.written.length = 0;

    grid.clear();
    const output = mock.output;
    expect(output).toContain('\x1b[7;');
  });

  it('clear 后 commitStream 走全量重建', () => {
    grid.commitStream(['● hello'], 5, 80);
    grid.clear();
    mock.written.length = 0;

    grid.commitStream(['● world'], 5, 80);
    const output = mock.output;
    expect(output).toContain('world');
  });
});
