// src/tui/inline/text-layout.ts
// 文本布局纯函数：wordWrap / 折行 / 上色 / 已固化行渲染。
//
// 从 InlineApp.tsx 抽离，消除 layout.ts → InlineApp.tsx（React 组件）的循环依赖。
// 依赖关系：
//   InlineApp.tsx → text-layout.ts ✓（组件用纯函数）
//   layout.ts → text-layout.ts ✓（Layout Layer 用纯函数）
//   text-layout.ts → colors.ts / token-highlight.ts / ui/types.ts ✓（无 React）

import { colorizeStyled } from './colors.js';
import { highlightLine } from './token-highlight.js';
import type { FormattedLine } from '../../ui/types.js';

/** ● 前缀（assistant 流式首行，白色——和正文统一） */
export const STREAM_PREFIX = '● ';
/** 续行缩进（与 ● 后内容对齐：● 占 1 列 + 空格 1 列 = 2 列） */
export const CONTINUATION_INDENT = '  ';

/**
 * 计算字符串的显示宽度（CJK 全角=2，其余=1）。
 * 复用 strip-ansi 去除 ANSI 序列后按码点判断。
 */
export function displayWidth(text: string): number {
  // 去 ANSI 序列
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK 统一表意、全角标点等 → 2 列（简化判定：常见 CJK 区间）
    if (
      (code >= 0x1100 && code <= 0x115f) ||  // 韩文
      (code >= 0x2e80 && code <= 0x303e) ||  // CJK 部首/标点
      (code >= 0x3040 && code <= 0x33bf) ||  // 假名/谚文/注音
      (code >= 0x3400 && code <= 0x4dbf) ||  // CJK 扩展 A
      (code >= 0x4e00 && code <= 0xa4cf) ||  // CJK 统一表意
      (code >= 0xac00 && code <= 0xd7af) ||  // 韩文音节
      (code >= 0xf900 && code <= 0xfaff) ||  // CJK 兼容表意
      (code >= 0xfe30 && code <= 0xfe6f) ||  // CJK 兼容形式
      (code >= 0xff01 && code <= 0xff60) ||  // 全角 ASCII/标点
      (code >= 0xffe0 && code <= 0xffe6) ||  // 全角符号
      (code >= 0x20000 && code <= 0x3fffd)   // CJK 扩展 B-F
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * 把单行文本按显示宽度折成多行（CJK 感知）。
 * 在预算处断行，不拆分 CJK 字符（按字符完整断）。
 */
export function foldLine(text: string, budget: number): string[] {
  if (text === '') return [''];
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const ch of text) {
    const chWidth = displayWidth(ch);
    if (currentWidth + chWidth > budget && current !== '') {
      lines.push(current);
      current = ch;
      currentWidth = chWidth;
    } else {
      current += ch;
      currentWidth += chWidth;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * 把流式 assistant 文本折行，返回带样式的行数组（供 rewriteStreamingLines）。
 *
 * 首行带 ● 前缀（白色），续行缩进 2 空格对齐。正文白底为主，文件路径/命令/包名蓝色，**bold** 加粗。
 */
export function wrapStreamingText(text: string, cols: number): string[] {
  const raw = text.startsWith(STREAM_PREFIX) ? text.slice(STREAM_PREFIX.length) : text;

  const firstLineBudget = Math.max(1, cols - STREAM_PREFIX.length);
  const contLineBudget = Math.max(1, cols - CONTINUATION_INDENT.length);

  const paragraphs = raw.split('\n');
  const result: string[] = [];
  let isFirstLine = true;

  paragraphs.forEach((para) => {
    const budget = isFirstLine ? firstLineBudget : contLineBudget;
    const lines = foldLine(para, budget);
    lines.forEach((l) => {
      if (isFirstLine) {
        result.push(STREAM_PREFIX + highlightLine(l));
        isFirstLine = false;
      } else {
        result.push(CONTINUATION_INDENT + highlightLine(l));
      }
    });
  });

  if (result.length === 0) {
    result.push(STREAM_PREFIX);
  }
  return result;
}

/**
 * 把流式 thinking 文本折行，返回灰色 dim 的行数组。
 * 灰色 dim，2 空格缩进，无 ● 前缀。
 */
export function wrapThinkingText(text: string, cols: number): string[] {
  if (text === '') return [colorizeStyled('  ', { dim: true })];
  const indent = '  ';
  const budget = Math.max(1, cols - indent.length);
  const paragraphs = text.split('\n');
  const result: string[] = [];
  paragraphs.forEach((para) => {
    const lines = foldLine(para, budget);
    lines.forEach((l) => {
      result.push(colorizeStyled(indent + l, { dim: true }));
    });
  });
  return result.length > 0 ? result : [colorizeStyled(indent, { dim: true })];
}

/**
 * 把单条已固化的 FormattedLine 渲染成终端字符串数组。
 * 补齐缩进 → 上色。assistant 长文本额外按终端宽度折行（续行缩进 2 空格）。
 */
export function renderFinalizedLine(role: string, line: FormattedLine, cols: number): string[] {
  const leading = line.content.length - line.content.trimStart().length;
  const pad = leading < line.indent ? ' '.repeat(line.indent - leading) : '';
  const fullContent = pad + line.content;

  if (role === 'assistant' && line.content.startsWith(STREAM_PREFIX)
      && displayWidth(fullContent) > cols) {
    return wrapStreamingText(fullContent, cols);
  }
  if (role === 'assistant' && line.content.startsWith(STREAM_PREFIX)) {
    return [STREAM_PREFIX + highlightLine(line.content.slice(STREAM_PREFIX.length))];
  }
  return [colorizeStyled(fullContent, line.style)];
}
