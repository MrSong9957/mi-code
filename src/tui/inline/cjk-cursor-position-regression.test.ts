/**
 * CJK 光标定位回归测试
 *
 * 复现 bug：输入中文时光标停在字符中间，而不是最后一个字符后面。
 * 症状：输入「你是谁？」（4 个码点 = 8 显示列），光标停在「是」和「谁」之间
 *      （第 4 列），而不是「？」后面（第 8 列）。
 *
 * 根因：renderFooter 把 cursor（码点索引）直接当终端显示列用，
 *      但 CJK 全角字符每个占 2 显示列、算 1 码点。
 *
 * 物理模型（查字典翻页）：
 *   码点 = 字典里每个字的编号（你=1，是=2，谁=3，？=4）
 *   显示列 = 字在纸上实际占的格子（每个汉字占 2 格）
 *   终端的 \x1b[NG 是「移到纸上第 N 格」，不是「移到字典第 N 个字」
 *   把字典编号当格子坐标用，每遇到一个汉字就少算 1 格。
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

/** 从写入序列中提取最后一次光标列定位 \x1b[NG 的 N 值 */
function lastCursorColumn(writes: string[]): number | null {
  for (let i = writes.length - 1; i >= 0; i--) {
    const m = writes[i]!.match(/\x1b\[(\d+)G/);
    if (m) return parseInt(m[1]!, 10);
  }
  return null;
}

describe('CJK 光标定位回归测试', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('ASCII 文本：光标列 = PROMPT宽度 + 码点数', () => {
    // PROMPT = '❯ '，❯ 占 1 列 + 空格 1 列 = 2 列
    renderer.renderFooter('hello', 5, 'STATUS');
    const col = lastCursorColumn(mock.written);
    // 期望列 = 2 (prompt) + 5 (码点=显示列) + 1 (1-based) = 8
    expect(col).toBe(8);
  });

  it('中文文本：每个汉字占 2 显示列（修复后应通过）', () => {
    // 「你好」2 个码点，但占 4 显示列
    renderer.renderFooter('你好', 2, 'STATUS');
    const col = lastCursorColumn(mock.written);
    // 期望列 = 2 (prompt) + 4 (显示列) + 1 (1-based) = 7
    expect(col).toBe(7);
  });

  it('「你是谁？」光标应在问号后（不在字符中间）', () => {
    renderer.renderFooter('你是谁？', 4, 'STATUS');
    const col = lastCursorColumn(mock.written);
    // 期望列 = 2 (prompt) + 8 (4汉字×2列) + 1 (1-based) = 11
    expect(col).toBe(11);
  });

  it('中英混合文本光标列按显示宽度计算', () => {
    // 「你abc」= 你(2列) + abc(3列) = 5 显示列，5 码点
    renderer.renderFooter('你abc', 5, 'STATUS');
    const col = lastCursorColumn(mock.written);
    // 期望列 = 2 (prompt) + 5 (显示列) + 1 (1-based) = 8
    expect(col).toBe(8);
  });

  it('emoji 宽度字符（如 👋 占 2 列）光标定位正确', () => {
    renderer.renderFooter('👋', 1, 'STATUS');
    const col = lastCursorColumn(mock.written);
    // 期望列 = 2 (prompt) + 2 (emoji显示列) + 1 (1-based) = 5
    expect(col).toBe(5);
  });
});
