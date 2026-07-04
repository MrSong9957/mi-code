// ANSI 终端控制码工具模块
//
// 物理本质：颜料挤出机 + 色票本查表。
// 给它一个颜色名（如 'cyan'）或语义 token（如 'accent'），
// 它挤出对应的 ANSI 颜料管代码（如 \x1b[36m）。
//
// theme 化后支持两种入参：
//  1. 直接颜色名（'cyan' / 'green' / ...）——走 FG_MAP，向后兼容
//  2. semantic token（'accent' / 'brand' / ...）——先查 theme 解析成颜色名再查 FG_MAP
// 优先级：FG_MAP 直接命中 > theme token（保证旧代码传 'cyan' 不被误判）

import { resolveToken, type ColorToken } from './theme.js';

// ═══════ 样式码 ═══════

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDERLINE = '\x1b[4m';

// ═══════ 颜色码表（16 色） ═══════

const FG_MAP: Record<string, string> = {
  black: '30', red: '31', green: '32', yellow: '33',
  blue: '34', magenta: '35', cyan: '36', white: '37',
  gray: '90', grey: '90',
  redBright: '91', greenBright: '92', yellowBright: '93', blueBright: '94',
  magentaBright: '95', cyanBright: '96', whiteBright: '97',
};

const BG_MAP: Record<string, string> = {
  black: '40', red: '41', green: '42', yellow: '43',
  blue: '44', magenta: '45', cyan: '46', white: '47',
  gray: '100', grey: '100',
};

// ═══════ token / 颜色名解析 ═══════

/**
 * 把入参（颜色名 or semantic token）解析成 FG_MAP/BG_MAP 的 key。
 * 优先级：FG_MAP 直接命中 > theme token。
 * - 'cyan' → 'cyan'（直接命中）
 * - 'accent' → 'cyan'（经 theme 解析）
 * - 'unknown' → ''（未知，返回空 = 无颜色码）
 */
function resolveColorName(input: string | undefined): string {
  if (!input) return '';
  // 1. 直接颜色名命中（向后兼容优先）
  if (FG_MAP[input] || BG_MAP[input]) return input;
  // 2. semantic token：查 theme
  const resolved = resolveToken(input as ColorToken);
  return resolved;
}

// ═══════ 辅助函数 ═══════

/** 前景色转义码。入参可是颜色名（'cyan'）或 semantic token（'accent'）。 */
export function fg(color: string | undefined): string {
  const name = resolveColorName(color);
  if (!name) return '';
  return `\x1b[${FG_MAP[name] ?? ''}m`;
}

/** 背景色转义码。入参可是颜色名或 semantic token。 */
export function bg(color: string | undefined): string {
  const name = resolveColorName(color);
  if (!name) return '';
  return `\x1b[${BG_MAP[name] ?? ''}m`;
}

// ═══════ 原始码接口（供 setCell 等手动构建转义序列） ═══════

/** 返回原始 ANSI 码（如 '31'），用于 setCell 等需要手动构建转义序列的场景。
 *  支持颜色名和 semantic token。 */
export function fgAnsi(color: string | undefined): string {
  const name = resolveColorName(color);
  if (!name) return '';
  return FG_MAP[name] ?? '';
}

/** 返回原始 ANSI 码（如 '41'），用于 setCell 等需要手动构建转义序列的场景。
 *  支持颜色名和 semantic token。 */
export function bgAnsi(color: string | undefined): string {
  const name = resolveColorName(color);
  if (!name) return '';
  return BG_MAP[name] ?? '';
}
