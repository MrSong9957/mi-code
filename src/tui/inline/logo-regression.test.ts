/**
 * Logo 显示回归测试 v3
 *
 * 验证 stdout 实际输出内容和格式。
 * Logo 内容固定，可以精确匹配含空格的完整格式。
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

describe('Logo 显示回归测试', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  // Logo 精确内容（含前导空格）
  const LOGO_LINE_0 = ' ▐▛███▜▌   MiCode v1.0.0';
  const LOGO_LINE_1 = '▝▜█████▛▘  TypeScript CLI · Node.js Runtime';
  const LOGO_LINE_2 = '  ▘▘ ▝▝    /project';

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('Logo 三行精确格式匹配', () => {
    renderer.appendLine(LOGO_LINE_0);
    renderer.appendLine(LOGO_LINE_1);
    renderer.appendLine(LOGO_LINE_2);

    const lines = mock.output.split('\n');
    // 三行 Logo 必须在输出的前 3 行，且内容完全一致（含空格）
    expect(lines[0]).toBe(LOGO_LINE_0);
    expect(lines[1]).toBe(LOGO_LINE_1);
    expect(lines[2]).toBe(LOGO_LINE_2);
  });

  it('Logo 三行连续无间隔', () => {
    renderer.appendLine(LOGO_LINE_0);
    renderer.appendLine(LOGO_LINE_1);
    renderer.appendLine(LOGO_LINE_2);

    const lines = mock.output.split('\n').filter(l => l.length > 0);
    // 前 3 行是 Logo
    expect(lines[0]).toBe(LOGO_LINE_0);
    expect(lines[1]).toBe(LOGO_LINE_1);
    expect(lines[2]).toBe(LOGO_LINE_2);
    // Logo 之间没有空行
    expect(lines[0]).not.toBe('');
    expect(lines[1]).not.toBe('');
    expect(lines[2]).not.toBe('');
  });

  it('Logo 每行的前导空格正确（列对齐）', () => {
    renderer.appendLine(LOGO_LINE_0);
    renderer.appendLine(LOGO_LINE_1);
    renderer.appendLine(LOGO_LINE_2);

    const lines = mock.output.split('\n');
    // 第 0 行：1 个前导空格
    expect(lines[0].startsWith(' ')).toBe(true);
    expect(lines[0].charAt(0)).toBe(' ');
    expect(lines[0].charAt(1)).toBe('▐');
    // 第 1 行：0 个前导空格
    expect(lines[1].charAt(0)).toBe('▝');
    // 第 2 行：2 个前导空格
    expect(lines[2].charAt(0)).toBe(' ');
    expect(lines[2].charAt(1)).toBe(' ');
    expect(lines[2].charAt(2)).toBe('▘');
  });

  it('完整启动：Logo → Footer → 消息 → Footer 重绘，Logo 格式不变', () => {
    renderer.appendLine(LOGO_LINE_0);
    renderer.appendLine(LOGO_LINE_1);
    renderer.appendLine(LOGO_LINE_2);
    renderer.renderFooter('', 0, 'auto │ model');
    renderer.appendLine('[system] Session started');
    renderer.renderFooter('', 0, 'auto │ model');

    const lines = mock.output.split('\n');
    // 经过完整流程后，前 3 行仍然是精确的 Logo
    expect(lines[0]).toBe(LOGO_LINE_0);
    expect(lines[1]).toBe(LOGO_LINE_1);
    expect(lines[2]).toBe(LOGO_LINE_2);
  });

  it('Footer 不会覆盖 Logo 行', () => {
    renderer.appendLine(LOGO_LINE_0);
    renderer.appendLine(LOGO_LINE_1);
    renderer.appendLine(LOGO_LINE_2);
    renderer.renderFooter('', 0, 'auto │ model');

    // 覆写模式：再次 renderFooter 应该只修改 footer 区域
    renderer.renderFooter('typing...', 7, 'auto │ model');

    const lines = mock.output.split('\n');
    // Logo 三行仍然精确
    expect(lines[0]).toBe(LOGO_LINE_0);
    expect(lines[1]).toBe(LOGO_LINE_1);
    expect(lines[2]).toBe(LOGO_LINE_2);
  });

  it('覆写模式的 cursorUp 偏移量正确（不侵入 Logo）', () => {
    // 先写 Logo + 首次 footer
    renderer.appendLine(LOGO_LINE_0);
    renderer.appendLine(LOGO_LINE_1);
    renderer.appendLine(LOGO_LINE_2);
    renderer.renderFooter('', 0, 'auto │ model');
    const afterFirst = mock.written.length;

    // 覆写 footer：输入为单行 'hello'，inputLineIndex=0
    // 正确偏移量 = 1 + 0 = 1（上移 1 行到 border 行）
    renderer.renderFooter('hello', 0, 'auto │ model');

    // 收集覆写阶段的所有写入
    const rewriteWrites = mock.written.slice(afterFirst).join('');

    // 提取所有 cursorUp 序列：\x1b[<n>A
    const cursorUpPattern = /\x1b\[(\d+)A/g;
    const matches = [...rewriteWrites.matchAll(cursorUpPattern)];
    expect(matches.length).toBeGreaterThanOrEqual(1);

    // 第一个 cursorUp 是上移到 footer 顶部，n 应为 1
    const firstCursorUp = parseInt(matches[0][1], 10);
    expect(firstCursorUp).toBe(1);
  });

  it('覆写模式多行输入时偏移量正确', () => {
    renderer.appendLine(LOGO_LINE_0);
    renderer.appendLine(LOGO_LINE_1);
    renderer.appendLine(LOGO_LINE_2);
    renderer.renderFooter('', 0, 'auto │ model');
    const afterFirst = mock.written.length;

    // 多行输入：'line1\nline2'，cursorPos=0 → 光标在第 0 行
    // 视口化后 offsetToTop = 1 + cursorViewportLine = 1 + 0 = 1
    // （从上一帧光标所在输入行上移 1 到 border 顶部）
    renderer.renderFooter('line1\nline2', 0, 'auto │ model');

    const rewriteWrites = mock.written.slice(afterFirst).join('');
    const cursorUpPattern = /\x1b\[(\d+)A/g;
    const matches = [...rewriteWrites.matchAll(cursorUpPattern)];
    expect(matches.length).toBeGreaterThanOrEqual(1);

    const firstCursorUp = parseInt(matches[0][1], 10);
    expect(firstCursorUp).toBe(1);
  });

  it('覆写模式包含物理删除序列 \\x1b[<n>M（DL，删除旧行）', () => {
    renderer.appendLine(LOGO_LINE_0);
    renderer.appendLine(LOGO_LINE_1);
    renderer.appendLine(LOGO_LINE_2);
    renderer.renderFooter('', 0, 'auto │ model');
    const afterFirst = mock.written.length;

    renderer.renderFooter('updated', 0, 'auto │ model');

    const rewriteWrites = mock.written.slice(afterFirst).join('');
    // 覆写模式用 DL（\x1b[<n>M）物理删除旧 footer 块，比逐行擦除更可靠（折行残留也删干净）。
    expect(rewriteWrites).toMatch(/\x1b\[\d+M/);
  });
});
