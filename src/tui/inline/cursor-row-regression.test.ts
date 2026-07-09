/**
 * 光标行位置回归测试
 *
 * 验证 renderFooter 后光标移动到正确的行（输入框行，不是 status 行）。
 * footer 结构：border(0) + input(1) + border(2) + status(3)
 * 光标应在行 1（input），写完后光标在行 4 之后，需上移 3 行。
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

// 提取所有 cursorUp 序列的参数
function extractCursorUpValues(output: string): number[] {
  const pattern = /\x1b\[(\d+)A/g;
  const values: number[] = [];
  let match;
  while ((match = pattern.exec(output)) !== null) {
    values.push(parseInt(match[1], 10));
  }
  return values;
}

describe('光标行位置回归测试', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('单行输入：footer 高度 4，光标应上移 3 行到 input 行', () => {
    // footer: border(0) + input(1) + border(2) + status(3)
    // 写完后光标在行 4 之后，需上移 3 行到行 1
    renderer.renderFooter('hello', 0, 'status');
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    // 最后一个 cursorUp 应为 3（从行 4 移到行 1）
    expect(cursorUps[cursorUps.length - 1]).toBe(3);
  });

  it('多行输入（2行）：footer 高度 5，cursorPos=0 时光标在第一行，上移 4 行', () => {
    // footer: border(0) + line1(1) + line2(2) + border(3) + status(4)
    // cursorPos=0 → 光标在第 0 行（line1），写完后光标在 footer 下方（行5之后）
    // 需上移 4 行回到 line1（footerHeight-1-cursorLineIndex = 5-1-0 = 4）
    renderer.renderFooter('line1\nline2', 0, 'status');
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    expect(cursorUps[cursorUps.length - 1]).toBe(4);
  });

  it('多行输入（2行）：cursorPos=8 时光标在第二行，上移 3 行', () => {
    // footer: border(0) + line1(1) + line2(2) + border(3) + status(4)
    // cursorPos=8 → 光标在第 1 行（line2），需上移 3 行（5-1-1）
    renderer.renderFooter('line1\nline2', 8, 'status');
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    expect(cursorUps[cursorUps.length - 1]).toBe(3);
  });
});
