// src/utils/theme-resolve.ts
// 主题解析器：把语义槽位翻译成终端能懂的格式
//
// 物理本质：两台翻译机。
// - resolveInkProps() → Ink <Text> 的 color/backgroundColor props（React 组件路径）
// - resolveSGR()      → ANSI SGR 转义序列（raw ANSI 路径，inline 模式用）
//
// 两条路径必须产生视觉一致的输出。

import type { Theme } from './theme.js';

// ─────────────── Ink Props 翻译 ───────────────

export interface InkStyleProps {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/**
 * 语义槽位 → Ink <Text> props。
 *
 * @param theme 当前主题
 * @param slot  语义槽位名（如 'brand', 'success', 'error'）
 * @returns Ink 兼容的样式 props
 */
export function resolveInkProps(theme: Theme, slot: keyof Theme): InkStyleProps {
  const color = theme[slot];
  if (!color) return {};
  return { color };
}

/**
 * 复合样式解析：语义槽位 + 额外属性。
 *
 * @example
 * resolveInkProps复合(theme, 'brand', { bold: true })
 * // → { color: 'rgb(180, 130, 255)', bold: true }
 */
export function resolveInkProps复合(
  theme: Theme,
  slot: keyof Theme,
  extra?: Partial<InkStyleProps>,
): InkStyleProps {
  return { ...resolveInkProps(theme, slot), ...extra };
}

// ─────────────── SGR 翻译 ───────────────

/** SGR 参数：数字 → \x1b[{n}m */
function sgr(code: number): string {
  return `\x1b[${code}m`;
}

/** SGR RESET */
export const RESET = sgr(0);

// rgb → ANSI 256色 近似映射表（常用色）
// 终端 256 色中 16-231 是 RGB cube，232-255 是灰度
function rgbToAnsi256(r: number, g: number, b: number): number {
  // 简化映射：取最近的 16 色基础色
  // 这是降级路径，256色终端会用下面的 rgb 转换
  const avg = (r + g + b) / 3;
  if (avg < 60) return 0;   // black
  if (avg > 200) return 15; // white
  if (r > g && r > b) return r > 180 ? 9 : 1;  // red / dark red
  if (g > r && g > b) return g > 180 ? 10 : 2; // green / dark green
  if (b > r && b > g) return b > 180 ? 12 : 4; // blue / dark blue
  if (r > 150 && g > 150 && b < 100) return 11; // yellow
  if (r > 150 && b > 150 && g < 100) return 13; // magenta
  if (g > 150 && b > 150 && r < 100) return 14; // cyan
  return 7; // white (default)
}

/**
 * 解析 rgb(r, g, b) 字符串为 [r, g, b] 数值。
 */
function parseRgb(color: string): [number, number, number] | null {
  const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!match) return null;
  return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
}

/**
 * 语义槽位 → SGR 前缀序列（256色模式）。
 *
 * 输出格式：\x1b[38;2;R;G;Bm（TrueColor）或降级到 \x1b[3Nm（16色）。
 * 调用方需拼接 text + RESET。
 *
 * @param theme 当前主题
 * @param slot  语义槽位名
 * @returns SGR 转义序列前缀（不含文本和 RESET）
 */
export function resolveSGR(theme: Theme, slot: keyof Theme): string {
  const color = theme[slot];
  if (!color) return '';

  const rgb = parseRgb(color);
  if (!rgb) return ''; // 非 rgb 格式，无法解析

  const [r, g, b] = rgb;
  // TrueColor: \x1b[38;2;R;G;Bm（前景）或 \x1b[48;2;R;G;Bm（背景）
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * 语义槽位 → SGR 背景序列。
 */
export function resolveSGRBg(theme: Theme, slot: keyof Theme): string {
  const color = theme[slot];
  if (!color) return '';

  const rgb = parseRgb(color);
  if (!rgb) return '';

  const [r, g, b] = rgb;
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * 给文本着色：SGR 前缀 + 文本 + RESET。
 */
export function colorizeSGR(theme: Theme, slot: keyof Theme, text: string): string {
  const prefix = resolveSGR(theme, slot);
  if (!prefix) return text;
  return `${prefix}${text}${RESET}`;
}

/**
 * 给文本上背景色：SGR 背景前缀 + 文本 + RESET。
 */
export function colorizeSGRBg(theme: Theme, slot: keyof Theme, text: string): string {
  const prefix = resolveSGRBg(theme, slot);
  if (!prefix) return text;
  return `${prefix}${text}${RESET}`;
}
