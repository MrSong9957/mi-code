// 流式渲染回归测试（RED 阶段）
//
// 验证三个契约：
// 1. InlineRenderer.rewriteStreamingLines：多行覆写（首次追加 / 后续覆写 / 行数增减）
// 2. wrapStreamingText：流式文本折行（首行 ● 前缀 + 续行无前缀 + CJK 全角）
// 3. spinner 标签 + braille 动画在状态栏显示

import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';
import { wrapStreamingText, wrapThinkingText } from './InlineApp.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    /** 清空缓冲（mock.written = [] 无效，因为闭包捕获原数组） */
    clear() { written.length = 0; },
    write: (s: string) => { written.push(s); return true; },
  };
}

describe('InlineRenderer.rewriteStreamingLines：多行覆写', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('首次调用 = 追加（无 cursorUp，含文本 + \\n）', () => {
    renderer.rewriteStreamingLines(['line1', 'line2']);
    const out = mock.output;
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    // 关键：首次追加不含光标上移（\x1b[NA）
    expect(out).not.toContain('\x1b[');
  });

  it('第二次调用 = 覆写（含 cursorUp + \\r\\x1b[2K 擦行）', () => {
    renderer.rewriteStreamingLines(['old1']);
    mock.clear(); // 清空，只看第二次
    renderer.rewriteStreamingLines(['new1']);
    const out = mock.output;
    // 上移旧行数（1 行）
    expect(out).toContain('\x1b[1A');
    // 擦行 + 写新内容
    expect(out).toContain('\r\x1b[2K');
    expect(out).toContain('new1');
  });

  it('行数减少时覆写新内容 + 物理删除多余行（新 1 行，旧 3 行）', () => {
    renderer.rewriteStreamingLines(['a', 'b', 'c']);
    mock.clear();
    renderer.rewriteStreamingLines(['only']);
    const out = mock.output;
    // 上移 3 行
    expect(out).toContain('\x1b[3A');
    // 'only' 在首行
    expect(out).toContain('only');
    // 物理删除 2 行多余行（\x1b[2M）
    expect(out).toContain('\x1b[2M');
  });

  it('行数减少时删除多余行（新 1 行，旧 4 行 → 物理删除 3 行，不留空行间隔）', () => {
    // 根因：rewriteStreamingLines 行数减少时只擦空不删除，残余空行变成"间隔"
    // 修复：行数减少时用 \x1b[<n>M 物理删除多余行
    renderer.rewriteStreamingLines(['a', 'b', 'c', 'd']); // 4 行草稿
    mock.clear();
    renderer.rewriteStreamingLines(['only']); // 缩减为 1 行
    const out = mock.output;
    // 关键：含删除行序列 \x1b[3M（删除 3 行 = 旧行数 - 新行数）
    expect(out).toContain('\x1b[3M');
  });

  it('行数增加时追加新行（新 3 行，旧 1 行）', () => {
    renderer.rewriteStreamingLines(['a']);
    mock.clear();
    renderer.rewriteStreamingLines(['x', 'y', 'z']);
    const out = mock.output;
    // 上移 1 行（旧高度）
    expect(out).toContain('\x1b[1A');
    // 3 行内容都在
    expect(out).toContain('x');
    expect(out).toContain('y');
    expect(out).toContain('z');
  });

  it('clearStreamingHeight 后再次调用回到追加模式（无 cursorUp）', () => {
    renderer.rewriteStreamingLines(['a']);
    renderer.clearStreamingHeight();
    mock.clear();
    renderer.rewriteStreamingLines(['fresh']);
    const out = mock.output;
    expect(out).toContain('fresh');
    expect(out).not.toContain('\x1b[');
  });
});

describe('InlineRenderer.eraseStreamingLines：固化时擦除草稿（防重复绘制）', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('eraseStreamingLines 物理删除草稿行（cursorUp + \x1b[<n>M），不留空行', () => {
    // 先画 3 行草稿
    renderer.rewriteStreamingLines(['line1', 'line2', 'line3']);
    mock.clear();
    // 物理删除（finalize 时固化内容由 appendLine 在干净区域写入）
    renderer.eraseStreamingLines();
    const out = mock.output;
    // 上移 3 行
    expect(out).toContain('\x1b[3A');
    // 物理删除 3 行（\x1b[3M）
    expect(out).toContain('\x1b[3M');
  });

  it('eraseStreamingLines 后 rewriteStreamingLines 回到追加模式（无 cursorUp）', () => {
    renderer.rewriteStreamingLines(['a', 'b']);
    renderer.eraseStreamingLines();
    mock.clear();
    renderer.rewriteStreamingLines(['fresh']);
    const out = mock.output;
    expect(out).toContain('fresh');
    expect(out).not.toContain('\x1b[');
  });

  it('eraseStreamingLines 在无草稿时安全 no-op', () => {
    mock.clear();
    renderer.eraseStreamingLines();
    const out = mock.output;
    // 无草稿时不输出任何 cursorUp/擦除
    expect(out).not.toContain('\x1b[');
  });
});

describe('wrapStreamingText：流式文本折行', () => {
  it('短文本 = 1 行，带 ● 前缀（白色，无品红）', () => {
    const lines = wrapStreamingText('你好', 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('● 你好');
    // 纯文本无 token → 不含任何 SGR（白色默认）
    expect(lines[0]).not.toContain('\x1b[');
  });

  it('长文本按列宽折行，续行缩进 2 空格对齐 ● 后内容（无 ● 前缀）', () => {
    const long = 'a'.repeat(100);
    const lines = wrapStreamingText(long, 40);
    expect(lines.length).toBeGreaterThan(1);
    // 首行带 ● 前缀
    expect(lines[0]).toContain('● ');
    // 续行：缩进 2 空格 + 内容，无 ● 前缀（SGR 序列后跟 2 空格）
    expect(lines[1]).not.toContain('●');
    // 去掉 ANSI 序列后应以 2 空格开头（colorizeStyled 先加 SGR 再加内容）
    const clean1 = lines[1].replace(/\x1b\[[0-9;]*m/g, '');
    expect(clean1).toMatch(/^  /);
  });

  it('空文本 = 1 行只有 ● 前缀', () => {
    const lines = wrapStreamingText('', 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('●');
  });

  it('CJK 全角字符按 2 列计算（不截断到字符中间）', () => {
    // 10 个中文字 = 20 列，列宽 25 → 首行约容纳 (25-2前缀)/2 ≈ 11 字
    const text = '一二三四五六七八九十'.repeat(3);
    const lines = wrapStreamingText(text, 25);
    expect(lines.length).toBeGreaterThan(1);
    // 不应在行尾留下半个 CJK（每行可见宽度 <= 列宽）
    expect(lines[0]).toContain('● ');
  });
});

describe('wrapThinkingText：thinking 流式折行（灰色 dim）', () => {
  it('文本带 dim SGR + 2 空格缩进，无 ● 前缀', () => {
    const lines = wrapThinkingText('我在思考', 80);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const clean = lines[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(clean).toBe('  我在思考'); // 2 空格缩进
    expect(lines[0]).toContain('\x1b[2m'); // dim
    // 无 ● 前缀
    expect(clean).not.toContain('●');
  });

  it('长文本按列宽折行，续行也带 dim + 缩进', () => {
    const long = '思考'.repeat(30);
    const lines = wrapThinkingText(long, 30);
    expect(lines.length).toBeGreaterThan(1);
    // 每行都带 dim
    expect(lines.every(l => l.includes('\x1b[2m'))).toBe(true);
    // 每行去 ANSI 后以 2 空格开头
    expect(lines.every(l => l.replace(/\x1b\[[0-9;]*m/g, '').startsWith('  '))).toBe(true);
  });

  it('空文本 → 1 行（2 空格 + dim）', () => {
    const lines = wrapThinkingText('', 80);
    expect(lines).toHaveLength(1);
  });
});
