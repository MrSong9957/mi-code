/**
 * 光标行位置回归测试
 *
 * 验证 renderFooter 后光标移动到正确的行（输入框行，不是 status 行）。
 * footer 结构：预留位(0,1) + 顶部border(2) + input(3) + 底部border + status
 * cursorToTop=3（跳过 2 预留位 + 1 顶部border），光标应在 input 行（行 3）。
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

  it('单行输入：footer 高度 6，光标应上移 3 行到 input 行', () => {
    // footer: 预留位(0,1) + 顶部border(2) + input(3) + 底部border(4) + status(5)
    // 写完后光标在行 6 之后，需上移 3 行到行 3（footerHeight - cursorToTop = 6 - 3）
    renderer.renderFooter('hello', 0, 'status');
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    // 最后一个 cursorUp 应为 3（从行 6 移到行 3）
    expect(cursorUps[cursorUps.length - 1]).toBe(3);
  });

  it('多行输入（2行）：footer 高度 7，cursorPos=0 时光标在第一行，上移 4 行', () => {
    // footer: 预留位(0,1) + 顶部border(2) + line1(3) + line2(4) + 底部border(5) + status(6)
    // cursorPos=0 → 光标在第 0 行（line1，cursorToTop=3），写完后光标在 footer 下方（行7之后）
    // 需上移 4 行回到 line1（footerHeight - cursorToTop = 7 - 3 = 4）
    renderer.renderFooter('line1\nline2', 0, 'status');
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    expect(cursorUps[cursorUps.length - 1]).toBe(4);
  });

  it('多行输入（2行）：cursorPos=8 时光标在第二行，上移 3 行', () => {
    // footer: 预留位(0,1) + 顶部border(2) + line1(3) + line2(4) + 底部border(5) + status(6)
    // cursorPos=8 → 光标在第 1 行（line2，cursorToTop=4），需上移 3 行（7 - 4）
    renderer.renderFooter('line1\nline2', 8, 'status');
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    expect(cursorUps[cursorUps.length - 1]).toBe(3);
  });

  it('视口滚动（8行输入，cursor 在第 6 行）：光标落在视口可见区，cursorUp 数值正确', () => {
    // 输入 8 行（超 MAX_VISIBLE_INPUT_LINES=5），viewportTop=4 → 可见 slice(4,9)=[l4,l5,l6,l7] 共 4 行
    // footer: 预留位(0,1) + 顶部border(2) + 4 可见输入行(3-6) + 底部border(7) + status(8) → footerHeight=9
    // cursor 在绝对行 6 → 视口内行 6-4=2
    // cursorToTop = 3(2预留位 + 1顶部border基准) + 2(cursorLine) = 5，upFromBottom = 9 - 5 = 4
    const input = 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7';
    // cursorPos 指向第 6 行行首（l6）：每行 2 字符 + \n，l6 起始 = 6*3 = 18
    renderer.renderFooter(input, 18, 'status', 80, [], 0, 4);
    const out = mock.output;
    const cursorUps = extractCursorUpValues(out);
    expect(cursorUps[cursorUps.length - 1]).toBe(4);
  });
});
