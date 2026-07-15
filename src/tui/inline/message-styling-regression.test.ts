// 消息样式回归测试（重写：调用真实 renderFinalizedLine，非副本）
//
// 本测试验证的是**真实的 InlineApp 渲染逻辑**（renderFinalizedLine 函数），
// 而非在测试里复制实现。通过导入真实的 renderFinalizedLine + MessageFormatter，
// 确保改错 InlineApp 代码时测试会报红。
//
// 防假测试验证：renderFinalizedLine 是 InlineApp 固化渲染的唯一事实源，
// 测试直接调用它，不复制任何缩进/上色逻辑。

import { describe, it, expect } from 'vitest';
import { renderFinalizedLine } from './text-layout.js';
import { MessageFormatter } from '../../ui/message-formatter.js';
import type { FormattedLine } from '../../ui/types.js';

/**
 * 渲染单条 FormattedLine（通过真实的 renderFinalizedLine）。
 * 返回拼接后的字符串（多行用 \n 连接）。
 *
 * 关键：这里不复制任何缩进/上色逻辑——全部委托给真实的 renderFinalizedLine。
 * 若 InlineApp 的逻辑改错，本函数的输出也会错 → 测试报红。
 */
function renderReal(role: string, line: FormattedLine, cols = 80): string {
  return renderFinalizedLine(role, line, cols).join('\n');
}

describe('逐行样式渲染契约（对齐 Claude Code）—— 调用真实 renderFinalizedLine', () => {
  it('assistant 行：● 前缀白色 + 正文白底蓝标（不再品红）', () => {
    const lines = MessageFormatter.format('assistant', {}, '我是 AI 助手');
    const rendered = renderReal('assistant', lines[0]);
    expect(rendered).toContain('● 我是 AI 助手');
    // 关键：不再整行品红（无 \x1b[35m）
    expect(rendered).not.toContain('\x1b[35m');
  });

  it('assistant 行含文件路径：路径蓝色，正文白色', () => {
    const lines = MessageFormatter.format('assistant', {}, 'edit src/config/schema.ts');
    const rendered = renderReal('assistant', lines[0]);
    // 去 ANSI 后含完整文本
    const clean = rendered.replace(/\x1b\[[0-9;]*m/g, '');
    expect(clean).toBe('● edit src/config/schema.ts');
    // 文件路径蓝色
    expect(rendered).toContain('\x1b[34m'); // blue
    // 不再品红
    expect(rendered).not.toContain('\x1b[35m');
  });

  it('user(input) 行：❯ text 带 green+bold（TrueColor）', () => {
    const lines = MessageFormatter.format('input', {}, '你是谁？');
    const rendered = renderReal('user', lines[0]);
    expect(rendered).toContain('❯ 你是谁？');
    // TrueColor: \x1b[38;2;R;G;Bm（theme.success = rgb(100,200,80)）
    expect(rendered).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(rendered).toContain('\x1b[1m');  // bold
  });

  it('thinking：● Thinking… 前缀白色（不再品红全染色）', () => {
    const lines = MessageFormatter.format('thinking', {});
    const rendered = renderReal('assistant', lines[0]);
    expect(rendered).toContain('● Thinking…');
  });

  it('thinking_end：2 空格缩进，不被双重缩进', () => {
    const lines = MessageFormatter.format('thinking_end', { duration: 8 });
    const rendered = renderReal('assistant', lines[0]);
    // content 已烤进 2 空格，indent=2，补齐后应正好 2 空格（不重复补）
    expect(rendered).toContain('  Thought for 8s');
    // 关键：不应有 4 空格（双重缩进 bug）
    expect(rendered).not.toMatch(/    Thought/);
    expect(rendered).toContain('\x1b[2m'); // dim
  });

  it('tool_call：● Bash(cmd) 无 [system] 前缀', () => {
    const lines = MessageFormatter.format('tool_call', {
      toolName: 'run_bash',
      toolInput: { command: 'npm test' },
    });
    const rendered = renderReal('tool', lines[0]);
    expect(rendered).toContain('● Bash(npm test)');
    // 关键回归断言：不再有 [system] 前缀
    expect(rendered).not.toContain('[system]');
  });

  it('tool_result：⎿ 行有 2 空格缩进（与 ● 对齐），无 [system]', () => {
    const lines = MessageFormatter.format('tool_result', { linesAdded: 2, linesRemoved: 1 });
    const rendered = renderReal('tool', lines[0]);
    // ⎿ 前应有 2 空格缩进（content 是 "⎿  Added..."，indent=2，补 2 空格）
    expect(rendered).toContain('  ⎿  Added 2 lines, removed 1 line');
    expect(rendered).not.toContain('[system]');
    expect(rendered).toContain('\x1b[2m'); // dim
  });

  it('error 行：红色（TrueColor），无 [system] 前缀，无堆栈', () => {
    const lines = MessageFormatter.format('error', {}, '[Error] Invalid API Key');
    const rendered = renderReal('system', lines[0]);
    expect(rendered).toContain('[Error] Invalid API Key');
    // TrueColor: \x1b[38;2;R;G;Bm（theme.error = rgb(255,90,90)）
    expect(rendered).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(rendered).not.toContain('[system]');
    expect(rendered).not.toContain('at ');
  });

  it('system 消息：无 [system] 前缀（内容原样）', () => {
    const lines = MessageFormatter.format('system', {}, 'Session started');
    const rendered = renderReal('system', lines[0]);
    expect(rendered).toContain('Session started');
    expect(rendered).not.toContain('[system]');
  });

  it('assistant 长文本折行：续行缩进 2 空格对齐 ● 后内容', () => {
    // 用窄列宽强制折行
    const longContent = '这是一个比较长的回复内容用来测试折行后的续行是否正确缩进对齐到首行内容';
    const lines = MessageFormatter.format('assistant', {}, longContent);
    const rendered = renderReal('assistant', lines[0], 30);
    const renderedLines = rendered.split('\n');
    expect(renderedLines.length).toBeGreaterThan(1);
    // 首行带 ● 前缀
    expect(renderedLines[0]).toContain('● ');
    // 续行：去掉 ANSI 后以 2 空格开头（对齐 ● 后内容）
    const cleanCont = renderedLines[1].replace(/\x1b\[[0-9;]*m/g, '');
    expect(cleanCont).toMatch(/^  /);
  });
});

describe('间距契约：renderFinalizedLine 不在行间加空行', () => {
  it('单条消息的多行渲染不产生空行（空行由 block-pipeline 负责）', () => {
    // 渲染两条不同消息的行，拼接后不应有空行（renderFinalizedLine 不加空行）
    const userLine = MessageFormatter.format('input', {}, '你好')[0];
    const assistantLine = MessageFormatter.format('assistant', {}, '你好！')[0];
    const rendered = [
      renderReal('user', userLine),
      renderReal('assistant', assistantLine),
    ].join('\n');

    expect(rendered).toContain('❯ 你好');
    expect(rendered).toContain('● 你好！');
    // 关键：renderFinalizedLine 自身不加空行
    expect(rendered).not.toMatch(/\n\n/);
  });

  it('block-pipeline 的空行 gap 是 content="" 的 FormattedLine（renderFinalizedLine 原样输出）', () => {
    // 验证 pipeline 产出的空行（content='', indent=0）被原样渲染为空字符串
    const gapLine: FormattedLine = { content: '', style: {}, indent: 0 };
    const rendered = renderReal('system', gapLine);
    // 空行渲染为空字符串（不含 SGR、不含空格）
    expect(rendered).toBe('');
  });
});
