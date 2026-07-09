/**
 * 边框宽度自适应回归测试
 *
 * 上下边框应自适应终端宽度，而非固定 40 字符。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
  };
}

describe('边框宽度自适应回归测试', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('边框宽度等于传入的 cols 参数', () => {
    renderer.renderFooter('', 0, 'status', 80);
    const out = mock.output;
    // 上边框应为 80 个 ─
    expect(out).toContain('─'.repeat(80));
  });

  it('不同终端宽度产生不同边框', () => {
    renderer.renderFooter('', 0, 'status', 60);
    const out60 = mock.output;

    mock.written.length = 0; // 清空
    renderer.renderFooter('', 0, 'status', 120);
    const out120 = mock.output;

    expect(out60).toContain('─'.repeat(60));
    expect(out120).toContain('─'.repeat(120));
    expect(out60).not.toContain('─'.repeat(120));
  });

  it('默认宽度为 80（未传 cols 时）', () => {
    renderer.renderFooter('', 0, 'status');
    const out = mock.output;
    expect(out).toContain('─'.repeat(80));
  });
});
