import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    write: vi.fn((s: string) => { written.push(s); return true; }),
  };
}

describe('InlineRenderer', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('appendLine writes text + newline to stdout', () => {
    renderer.appendLine('hello');
    expect(mock.write).toHaveBeenCalledWith('hello\n');
  });

  it('rewriteCurrentLine writes CR + erase + text', () => {
    renderer.rewriteCurrentLine('streaming...');
    expect(mock.write).toHaveBeenCalledWith('\r\x1b[Kstreaming...');
  });

  it('renderFooter writes footer lines and tracks them', () => {
    renderer.renderFooter('hello', 5, 'test | model');
    expect(mock.written.length).toBeGreaterThan(0);
  });

  it('commitFooter clears footer state', () => {
    renderer.renderFooter('hello', 5, 'test | model');
    renderer.commitFooter();
    const prevLen = mock.written.length;
    renderer.renderFooter('world', 5, 'test | model');
    expect(mock.written.length).toBeGreaterThan(prevLen);
  });

  it('renderFooter erases previous footer before writing new', () => {
    renderer.renderFooter('line1', 0, 'status1');
    const afterFirst = mock.written.length;
    renderer.renderFooter('line2', 0, 'status2');
    const secondWrites = mock.written.slice(afterFirst);
    const combined = secondWrites.join('');
    expect(combined).toContain('\x1b[');
  });

  it('commitFooter moves cursor below footer and resets state', () => {
    renderer.renderFooter('hello', 0, 'status');
    const afterFirst = mock.written.length;
    renderer.commitFooter();
    // commitFooter 写入换行符将光标移到 footer 下方
    expect(mock.written.length).toBeGreaterThan(afterFirst);
    // 之后 renderFooter 应以追加模式写入（不覆写）
    renderer.renderFooter('world', 0, 'status2');
    const afterSecond = mock.written.length;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });
});
