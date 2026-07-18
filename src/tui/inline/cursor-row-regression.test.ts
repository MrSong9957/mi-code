/**
 * 光标行位置回归测试
 *
 * 验证 renderFooter 后光标移动到正确的行（输入框行，不是 status 行）。
 * footer 结构：间隔行(0) + 顶部border(1) + input(2) + 底部border + status
 * cursorToTop=2（跳过 1 间隔行 + 1 顶部border），光标应在 input 行（行 2）。
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

  it('单行输入：footer 高度 5，光标应上移 3 行到 input 行', () => {
    // footer: 间隔行(0) + 顶部border(1) + input(2) + 底部border(3) + status(4)
    // 写完后光标在行 5 之后，需上移 3 行到 input（footerHeight - cursorToTop = 5 - 2）
    renderer.renderFooter('hello', 0, 'status');
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    // 最后一个 cursorUp 应为 3（从行 6 移到行 3）
    expect(cursorUps[cursorUps.length - 1]).toBe(3);
  });

  it('多行输入（2行）：footer 高度 6，cursorPos=0 时光标在第一行，上移 4 行', () => {
    // footer: 间隔行(0) + 顶部border(1) + line1(2) + line2(3) + 底部border(4) + status(5)
    // cursorPos=0 → 光标在第 0 行（line1，cursorToTop=2）
    // 需上移 4 行回到 line1（footerHeight - cursorToTop = 6 - 2 = 4）
    renderer.renderFooter('line1\nline2', 0, 'status');
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    expect(cursorUps[cursorUps.length - 1]).toBe(4);
  });

  it('多行输入（2行）：cursorPos=8 时光标在第二行，上移 3 行', () => {
    // footer: 间隔行(0) + 顶部border(1) + line1(2) + line2(3) + 底部border(4) + status(5)
    // cursorPos=8 → 光标在第 1 行（line2，cursorToTop=3），需上移 3 行（6 - 3）
    renderer.renderFooter('line1\nline2', 8, 'status');
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    expect(cursorUps[cursorUps.length - 1]).toBe(3);
  });

  it('视口滚动（8行输入，cursor 在第 6 行）：光标落在视口可见区，cursorUp 数值正确', () => {
    // 输入 8 行（超 MAX_VISIBLE_INPUT_LINES=5），viewportTop=4 → 可见 slice(4,9)=[l4,l5,l6,l7] 共 4 行
    // footer: 间隔行(0) + 顶部border(1) + 4 可见输入行(2-5) + 底部border(6) + status(7) → footerHeight=8
    // cursor 在绝对行 6 → 视口内行 6-4=2
    // cursorToTop = 2(1间隔行 + 1顶部border基准) + 2(cursorLine) = 4，upFromBottom = 8 - 4 = 4
    const input = 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7';
    // cursorPos 指向第 6 行行首（l6）：每行 2 字符 + \n，l6 起始 = 6*3 = 18
    renderer.renderFooter(input, 18, 'status', 80, [], 0, 4);
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    expect(cursorUps[cursorUps.length - 1]).toBe(4);
  });
});
