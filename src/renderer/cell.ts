// 格子 + 样式 + 显示宽度 模块
//
// 物理本质：给画布上每个小方格贴"字符标签 + 样式标签"。
// 显示宽度：一个字符在终端里横向占几个格子（中文/全角/emoji=2，半角=1）。

import { fg, bg } from './colors.js';

/** 文本样式（全部可选；缺省即默认） */
export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** 单个格子：一个字符（可能是 emoji/中文，即一个码点）+ 样式 */
export interface Cell {
  char: string;
  style: Style;
}

/** 空格子（空格 + 默认样式）——画布清空用 */
export const EMPTY_CELL: Cell = { char: ' ', style: {} };

const RESET = '\x1b[0m';

/**
 * 构造一个 cell。多字符只取首个码点，强制单字符语义。
 * 默认字符为空格、样式为空。
 */
export function makeCell(char: string = ' ', style: Style = {}): Cell {
  const first = [...char][0] ?? ' ';
  return { char: first, style };
}

/** 两个 cell 是否完全相等（字符 + 样式） */
export function cellsEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && styleKey(a.style) === styleKey(b.style);
}

/**
 * 把 Style 打包成 SGR 转义串（绝对设置：含属性码 + 结尾 reset）。
 * 用于"无样式跟踪"场景（如直接写一整段已含重置的串）。
 * 结果稳定可缓存。
 *
 * 注意：高频 diff 写格场景应改用 styleTransition（只在变化时发样式）。
 */
export function packStyle(style: Style | undefined): string {
  if (!style) return '';
  const key = styleKey(style);
  if (key === '') return '';
  return cached(key, () => buildStyle(style));
}

/**
 * 样式 key（稳定串）：相同样式必同串。供 VirtualScreen 跟踪当前样式。
 */
export function styleKey(style: Style | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.fg) parts.push('f' + style.fg);
  if (style.bg) parts.push('b' + style.bg);
  if (style.bold) parts.push('B');
  if (style.dim) parts.push('D');
  if (style.italic) parts.push('I');
  if (style.underline) parts.push('U');
  return parts.join('|');
}

/** 由 key 反解为 Style（与 styleKey 互逆） */
export function styleFromKey(key: string): Style {
  if (!key) return {};
  const style: Style = {};
  for (const part of key.split('|')) {
    if (!part) continue;
    const tag = part[0];
    const val = part.slice(1);
    if (tag === 'f') style.fg = val;
    else if (tag === 'b') style.bg = val;
    else if (tag === 'B') style.bold = true;
    else if (tag === 'D') style.dim = true;
    else if (tag === 'I') style.italic = true;
    else if (tag === 'U') style.underline = true;
  }
  return style;
}

/**
 * 从 prevStyle 过渡到 nextStyle 需要发出的最少 SGR 字节。
 * - 两者相同 → 空串（无需重发样式）。
 * - prev 非空、next 为空 → 只发 reset（\x1b[0m）。
 * - 否则 → 发 nextStyle 的绝对 SGR（含 reset 结尾，复位旧样式再设置新样式）。
 *
 * 这是 Claude Code stylePool.transition 的同思路：只在样式真正变化时发样式码，
 * 同样式连续格子之间不发任何字节（文档§2.2③）。
 */
export function styleTransition(prevStyle: Style | undefined, nextStyle: Style | undefined): string {
  return styleTransitionByKey(styleKey(prevStyle), styleKey(nextStyle));
}

/**
 * 按样式 key 算过渡字节（VirtualScreen 用，避免反复解析 Style 对象）。
 */
export function styleTransitionByKey(prevKey: string, nextKey: string): string {
  if (prevKey === nextKey) return '';          // 样式未变
  if (nextKey === '') return '\x1b[0m';         // 回到默认：reset
  return cached(nextKey, () => buildStyle(styleFromKey(nextKey)));
}


function buildStyle(style: Style): string {
  let s = '';
  if (style.bold) s += '\x1b[1m';
  if (style.dim) s += '\x1b[2m';
  if (style.italic) s += '\x1b[3m';
  if (style.underline) s += '\x1b[4m';
  if (style.fg) s += fg(style.fg);
  if (style.bg) s += bg(style.bg);
  return s ? s + RESET : '';
}

// packStyle 结果缓存（样式种类有限，命中率高）
const styleCache = new Map<string, string>();
function cached(key: string, build: () => string): string {
  const hit = styleCache.get(key);
  if (hit !== undefined) return hit;
  const v = build();
  styleCache.set(key, v);
  return v;
}

// ═══════ 显示宽度 ═══════

/** 计算字符串在终端的显示宽度（中文/全角/emoji=2，半角=1） */
export function stringWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    width += codePointWidth(codePointOf(ch));
  }
  return width;
}

/**
 * 把字符串拆成 cell 数组（一个码点一个 cell，emoji/中文不拆字节）。
 */
export function stringToCells(s: string, style: Style = {}): Cell[] {
  return [...s].map(ch => ({ char: ch, style }));
}

/**
 * 把一组 cells 按显示宽度截断：保留从头开始、累计宽度 <= maxWidth 的 cells。
 * 若截断处落在一个宽字符上（剩余宽度不够 2），丢弃该宽字符以避免半字。
 */
export function truncateToWidth(cells: Cell[], maxWidth: number): Cell[] {
  if (maxWidth <= 0) return [];
  const out: Cell[] = [];
  let width = 0;
  for (const cell of cells) {
    const w = codePointWidth(codePointOf(cell.char));
    if (width + w > maxWidth) break;
    out.push(cell);
    width += w;
  }
  return out;
}

function codePointOf(ch: string): number {
  // [...] 已按码点迭代，单字符字符串的码点直接取
  return ch.codePointAt(0) ?? 0;
}

/** 单码点显示宽度：宽字符返回 2，其余 1 */
function codePointWidth(code: number): number {
  // 控制字符不计宽（理论上画布里不该出现，但防御）
  if (code === 0) return 0;
  return isWideCodePoint(code) ? 2 : 1;
}

/**
 * 判断一个码点是否"宽字符"（占 2 列）。
 *
 * 这是渲染层与终端"对账"的统一口径——cell.ts 的 stringWidth、screen.ts 的占位格、
 * 测试用的 FakeTerminal **三方必须走同一个判定**，否则任一处算错都会让后续格子整体错位。
 *
 * 覆盖范围：
 * - East Asian Fullwidth/Wide（CJK 文字、全角符号、韩文、假名、彝文、CJK 扩展等）
 * - East Asian **Ambiguous**（块元素、制表符、几何符号、杂项符号如 ❯ ⎇ · × 等）
 *   → 保守按 2 处理。多数 CJK locale 终端（Windows Terminal/带 CJK 的 xterm）都把它们渲染成宽字符，
 *     若按 1 算会与真实终端不一致，导致布局错位（这是历史 bug 的根因）。
 * - Emoji 与补充符号区。
 */
export function isWideCodePoint(code: number): boolean {
  // ── East Asian Fullwidth / Wide ──
  if (code >= 0x1100 && code <= 0x115F) return true; // 韩文 Jamo
  if (code >= 0x2E80 && code <= 0x303E) return true; // CJK 部首/标点
  if (code >= 0x3040 && code <= 0x33FF) return true; // 假名/韩文兼容/中文竖排标点
  if (code >= 0x3400 && code <= 0x4DBF) return true; // CJK 扩展 A
  if (code >= 0x4E00 && code <= 0x9FFF) return true; // CJK 统一表意
  if (code >= 0xA000 && code <= 0xA4CF) return true; // 彝文
  if (code >= 0xAC00 && code <= 0xD7A3) return true; // 韩文音节
  if (code >= 0xF900 && code <= 0xFAFF) return true; // CJK 兼容表意
  if (code >= 0xFE10 && code <= 0xFE19) return true; // 竖排标点
  if (code >= 0xFE30 && code <= 0xFE6F) return true; // CJK 兼容标点
  if (code >= 0xFF00 && code <= 0xFF60) return true; // 全角 ASCII/标点
  if (code >= 0xFFE0 && code <= 0xFFE6) return true; // 全角符号
  if (code >= 0x1F300 && code <= 0x1FAFF) return true; // emoji/补充符号
  if (code >= 0x1F000 && code <= 0x1F02F) return true; // 麻将
  if (code >= 0x20000 && code <= 0x3FFFD) return true; // CJK 扩展 B-F

  // ── East Asian Ambiguous（CJK 终端普遍按宽渲染；保守按 2）──
  if (code >= 0x00A1 && code <= 0x00FF) return true; // 拉丁补充（· × ÷ 等）
  if (code >= 0x2300 && code <= 0x23FF) return true; // 杂项技术符号（⎇ ⌘ ⏳ 等）
  if (code >= 0x2460 && code <= 0x24FF) return true; // 圈号/数字
  // 0x2500-0x257F（Box Drawing）：现代终端（Windows Terminal 等）按宽度 1 渲染，不视为宽字符。
  if (code >= 0x2580 && code <= 0x259F) return true; // 块元素（LOGO 用）
  if (code >= 0x25A0 && code <= 0x26FF) return true; // 几何/杂项符号
  if (code >= 0x2700 && code <= 0x27BF) return true; // 装饰符号（含 ❯ U+275F）
  if (code >= 0x2E80 && code <= 0x303F) return true; // （已含，保留防漏）
  if (code >= 0x3200 && code <= 0x33FF) return true; // CJK 兼容（含封闭）

  return false;
}
