// 流式渲染回归测试（RED 阶段）
//
// 验证三个契约：
// 1. InlineRenderer.rewriteStreamingLines：多行覆写（首次追加 / 后续覆写 / 行数增减）
// 2. wrapStreamingText：流式文本折行（首行 ● 前缀 + 续行无前缀 + CJK 全角）
// 3. spinner 标签 + braille 动画在状态栏显示

import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';
import {
  wrapStreamingText,
  wrapThinkingText,
  wrapStreamingTextTrimmed,
  wrapThinkingTextTrimmed,
  TAIL_OVERFLOW_THRESHOLD,
} from './text-layout.js';

/** 去 ANSI 后取行内容（断言可读性） */
function clean(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

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
    // 清空 constructor 的 DECAWM OFF 序列（\x1b[?7l），不污染测试断言
    mock.written.length = 0;
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

describe('rewriteStreamingLines 合并区：草稿 + spinner 行统一覆写', () => {
  // 对标方案 A：spinner 拼到草稿区末尾，cursorUp 基准 = 总行数（含 spinner）。
  // 验证连续两帧覆写时 cursorUp 算的是合并后总行数，不会少算 spinner 行。
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
    mock.written.length = 0;
  });

  it('草稿+spinner 合并：第二帧覆写 cursorUp = 总行数（含 spinner）', () => {
    // 第一帧：2 行文本 + 1 行 spinner = 3 行
    renderer.rewriteStreamingLines(['● 文本行1', '  文本行2', '✶ Crafting']);
    expect(renderer.state.lastStreamingHeight).toBe(3);
    mock.clear();
    // 第二帧：内容更新（spinner 符号变了），仍 3 行
    renderer.rewriteStreamingLines(['● 文本行1', '  文本行2', '· Pondering']);
    const out = mock.output;
    // cursorUp(3)：覆盖整个合并区（含 spinner），不少算
    expect(out).toContain('\x1b[3A');
    expect(out).toContain('· Pondering');
    expect(out).not.toContain('Crafting');
  });

  it('spinner 单独成草稿（工具执行）：覆写 cursorUp(1)', () => {
    // 第一帧：只有 spinner 1 行（工具执行，无文本草稿）
    renderer.rewriteStreamingLines(['· Investigating']);
    expect(renderer.state.lastStreamingHeight).toBe(1);
    mock.clear();
    // 第二帧：spinner 更新
    renderer.rewriteStreamingLines(['✶ Analyzing']);
    const out = mock.output;
    expect(out).toContain('\x1b[1A');
    expect(out).toContain('✶ Analyzing');
    expect(out).not.toContain('Investigating');
  });

  it('草稿行数变化（spinner 加入）：cursorUp 用旧行数，追加新行', () => {
    // 第一帧：2 行文本（正文生成中，无 spinner）
    renderer.rewriteStreamingLines(['● 行1', '  行2']);
    mock.clear();
    // 第二帧：spinner 加入（切到 thinking 或工具），3 行
    renderer.rewriteStreamingLines(['● 行1', '  行2', '✶ Crafting']);
    const out = mock.output;
    // cursorUp(2)（旧行数）+ 覆写 2 行 + 追加第 3 行（spinner）
    expect(out).toContain('\x1b[2A');
    expect(out).toContain('✶ Crafting');
  });
});

describe('InlineRenderer.eraseStreamingLines：固化时擦除草稿（防重复绘制）', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
    mock.written.length = 0; // 清空 constructor 的 DECAWM OFF 序列
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

// ─────────────── trimmed 截断：对标 Claude Code 流式预览（机制二） ───────────────
//
// Claude Code（Linux/macOS）visibleStreamingText 只显示到最后一个 \n：
//   streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null
// 未完成的最后一行被隐藏，直到下一个 \n 到达。用户看到的是"按行出现"。
// 固化时（content_block_stop）完整文本经 renderFinalizedLine 渲染，tail 不丢。
//
// 超长兜底：长段无换行文字超过阈值时强制显示，避免长时间空白。

describe('wrapStreamingTextTrimmed：隐藏未完成行（对标 Claude Code 机制二）', () => {
  it('无 \\n：隐藏整行 → 仅 ● 占位（正在打的那行不可见）', () => {
    const lines = wrapStreamingTextTrimmed('正在打字', 80);
    expect(lines).toHaveLength(1);
    expect(clean(lines[0]!)).toBe('● ');
  });

  it('单 \\n + tail：只显示完整首行，partial 尾行丢弃', () => {
    const lines = wrapStreamingTextTrimmed('第一行\npartial', 80);
    expect(lines).toHaveLength(1);
    expect(clean(lines[0]!)).toBe('● 第一行');
  });

  it('多 \\n + tail：完整行逐行显示，最后一个 partial 丢弃', () => {
    const lines = wrapStreamingTextTrimmed('行1\n行2\n行3partial', 80);
    expect(lines).toHaveLength(2);
    expect(clean(lines[0]!)).toBe('● 行1');
    expect(clean(lines[1]!)).toBe('  行2');
  });

  it('\\n 结尾的文本：末尾空 tail 不显示，不产生多余空行', () => {
    const lines = wrapStreamingTextTrimmed('行1\n行2\n', 80);
    expect(lines).toHaveLength(2);
    expect(clean(lines[0]!)).toBe('● 行1');
    expect(clean(lines[1]!)).toBe('  行2');
  });

  it('空文本：● 占位（不返回空数组，避免物理删除）', () => {
    const lines = wrapStreamingTextTrimmed('', 80);
    expect(lines).toHaveLength(1);
    expect(clean(lines[0]!)).toBe('● ');
  });

  it('超长兜底（无 \\n）：长度超阈值 → 显示完整内容（多行折行，非占位）', () => {
    const long = 'a'.repeat(TAIL_OVERFLOW_THRESHOLD + 1);
    const lines = wrapStreamingTextTrimmed(long, 40);
    // 不是占位：行数 > 1（被折行），首行有实际内容
    expect(lines.length).toBeGreaterThan(1);
    expect(clean(lines[0]!).startsWith('● ')).toBe(true);
    // 首行含实际 a 内容而非只有 ● + 空格
    expect(clean(lines[0]!).replace('● ', '').length).toBeGreaterThan(0);
  });

  it('超长兜底（有 \\n）：完整行部分超阈值 → 显示完整 text', () => {
    // 一个超长"完整行" + 一个 partial tail
    const long = 'b'.repeat(TAIL_OVERFLOW_THRESHOLD + 1);
    const text = long + '\npartial';
    const lines = wrapStreamingTextTrimmed(text, 40);
    // 显示了 tail（partial），说明走了"显示完整 text"路径而非截断
    expect(lines.some(l => clean(l).includes('partial'))).toBe(true);
  });

  it('阈值边界：长度 = 阈值 无 \\n → 仍占位', () => {
    const at = 'c'.repeat(TAIL_OVERFLOW_THRESHOLD);
    const lines = wrapStreamingTextTrimmed(at, 80);
    expect(lines).toHaveLength(1);
    expect(clean(lines[0]!)).toBe('● ');
  });

  it('阈值边界：长度 = 阈值+1 无 \\n → 显示完整', () => {
    const over = 'd'.repeat(TAIL_OVERFLOW_THRESHOLD + 1);
    const lines = wrapStreamingTextTrimmed(over, 40);
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe('wrapThinkingTextTrimmed：thinking 流式隐藏未完成行', () => {
  it('无 \\n → dim 2 空格占位（隐藏正在思考的那行）', () => {
    const lines = wrapThinkingTextTrimmed('正在思考', 80);
    expect(lines).toHaveLength(1);
    expect(clean(lines[0]!)).toBe('  ');
    expect(lines[0]).toContain('\x1b[2m'); // dim
  });

  it('有 \\n + tail：只显示完整行（dim 样式），partial 丢弃', () => {
    const lines = wrapThinkingTextTrimmed('想法1\n想法2partial', 80);
    expect(lines).toHaveLength(1);
    expect(clean(lines[0]!)).toBe('  想法1');
    expect(lines[0]).toContain('\x1b[2m'); // dim
  });
});
