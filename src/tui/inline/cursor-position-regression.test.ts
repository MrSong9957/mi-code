/**
 * 光标定位回归测试
 *
 * 验证 renderFooter 后光标定位到输入框的正确列位置。
 * cursorX = PROMPT.length + cursorPos（单行输入时）
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

// 提取光标定位序列：\x1b[<col>G
function extractCursorCol(output: string): number | null {
  const match = output.match(/\x1b\[(\d+)G/);
  return match ? parseInt(match[1], 10) : null;
}

describe('光标定位回归测试', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('单行空输入：光标在 ❯ 之后（第 3 列，1-indexed）', () => {
    renderer.renderFooter('', 0, 'status');
    const out = mock.output;
    // ❯ 占 1 列 + 空格占 1 列 = 2 字符，光标应在第 3 列（1-indexed）
    const col = extractCursorCol(out);
    expect(col).toBe(3); // \x1b[3G
  });

  it('单行输入 "hello"：光标在 ❯ hello 之后（第 8 列）', () => {
    renderer.renderFooter('hello', 5, 'status');
    const out = mock.output;
    // ❯ (1) + 空格 (1) + "hello" (5) = 7 字符，光标在第 8 列
    const col = extractCursorCol(out);
    expect(col).toBe(8);
  });

  it('光标偏移 cursorPos=3：光标在 ❯ hel 之后（第 6 列）', () => {
    renderer.renderFooter('hello', 3, 'status');
    const out = mock.output;
    const col = extractCursorCol(out);
    expect(col).toBe(6); // 2 + 3 + 1
  });

  it('多行输入 cursorPos=2：光标在第一行 li 之后（第 5 列）', () => {
    // 'line1\nline2'，cursorPos=2 落在第一行 'li' 之后
    // cursorX = promptWidth(2) + 2 = 4，列 = 5（1-based）
    renderer.renderFooter('line1\nline2', 2, 'status');
    const out = mock.output;
    const col = extractCursorCol(out);
    expect(col).toBe(5);
  });

  it('多行输入 cursorPos=8：光标在第二行 li 之后（第 5 列）', () => {
    // cursorPos=8 越过 'line1\n'(6字符)，落在第二行 'li' 之后。
    // 续行有 CONTINUATION_INDENT（=promptWidth=2），cursorX = 2 + 2 = 4，列 = 5。
    renderer.renderFooter('line1\nline2', 8, 'status');
    const out = mock.output;
    const col = extractCursorCol(out);
    expect(col).toBe(5);
  });
});
