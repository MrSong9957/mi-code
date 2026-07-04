// ANSI 颜色码生成 + theme token 解析（truecolor / 256 / 16 三级）
//
// 物理本质：颜料挤出机 + 三档精度调节。
// 给它一个 token（或颜色名），按当前终端颜色能力挤出对应精度的颜料管代码：
//   - truecolor：\x1b[38;2;R;G;Bm（1600 万色，现代终端）
//   - ansi256：\x1b[38;5;Nm（256 色，老终端近似）
//   - ansi16：\x1b[36m（16 色命名，最保守兜底）
//
// 优先级：直接颜色名命中 FG_MAP > theme token（保证旧代码传 'cyan' 不被误判）。

import { resolveTokenRgb, resolveTokenAnsi16, type ColorToken, type Rgb } from './theme.js';
import { detectColorLevel, type ColorLevel } from './capabilities.js';

// ═══════ 样式码 ═══════

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDERLINE = '\x1b[4m';

// ═══════ 16 色码表（FG_MAP / BG_MAP） ═══════

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

// ═══════ 颜色名 → RGB 近似（用于直接颜色名的 truecolor 输出） ═══════
//
// 16 色标准 ANSI 的 RGB 近似值（xterm 标准）。truecolor 模式下直接颜色名也走 RGB。

const NAME_TO_RGB: Record<string, Rgb> = {
  black: [0, 0, 0],
  red: [205, 0, 0],
  green: [0, 205, 0],
  yellow: [205, 205, 0],
  blue: [0, 0, 238],
  magenta: [205, 0, 205],
  cyan: [0, 255, 255],
  white: [229, 229, 229],
  gray: [127, 127, 127], grey: [127, 127, 127],
  redBright: [255, 85, 85],
  greenBright: [85, 255, 85],
  yellowBright: [255, 255, 85],
  blueBright: [85, 85, 255],
  magentaBright: [255, 85, 255],
  cyanBright: [85, 255, 255],
  whiteBright: [255, 255, 255],
};

// ═══════ 颜色能力管理 ═══════

let currentLevel: ColorLevel = detectColorLevel();

/** 设置当前颜色能力等级（测试/手动覆盖用）。 */
export function setColorLevel(level: ColorLevel): void {
  currentLevel = level;
}

/** 获取当前颜色能力等级。 */
export function getColorLevel(): ColorLevel {
  return currentLevel;
}

// ═══════ token / 颜色名解析 ═══════

/**
 * 把入参解析成 RGB（truecolor 优先用）。
 * 优先级：FG_MAP 直接命中 → 用 NAME_TO_RGB；否则 theme token → resolveTokenRgb。
 * 未知返回 null。
 */
function resolveRgb(input: string | undefined): Rgb | null {
  if (!input) return null;
  // 1. 直接颜色名命中
  if (FG_MAP[input] || BG_MAP[input]) {
    return NAME_TO_RGB[input] ?? null;
  }
  // 2. semantic token
  return resolveTokenRgb(input as ColorToken);
}

/**
 * 把入参解析成 16 色命名（ansi16 模式用）。
 * 优先级：FG_MAP 直接命中 → 原样返回；否则 theme token → resolveTokenAnsi16。
 * 未知返回空串。
 */
function resolveAnsi16Name(input: string | undefined): string {
  if (!input) return '';
  if (FG_MAP[input] || BG_MAP[input]) return input;
  return resolveTokenAnsi16(input as ColorToken);
}

// ═══════ RGB → 256 色索引近似 ═══════

/** RGB → xterm 256 色最接近索引。
 *  0-15：标准 16 色；16-231：6×6×6 立方体；232-255：灰阶。 */
function rgbTo256(rgb: Rgb): number {
  const [r, g, b] = rgb;
  // 灰阶判定（三通道接近）
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const ix = Math.round(r / 51);
  const jx = Math.round(g / 51);
  const kx = Math.round(b / 51);
  return 16 + 36 * ix + 6 * jx + kx;
}

// ═══════ fg / bg 主接口 ═══════

/** 前景色转义码。按当前 colorLevel 选格式：
 *  - truecolor：\x1b[38;2;R;G;Bm
 *  - ansi256：\x1b[38;5;Nm
 *  - ansi16：\x1b[Nm（查 FG_MAP） */
export function fg(color: string | undefined): string {
  if (!color) return '';
  if (currentLevel === 'truecolor') {
    const rgb = resolveRgb(color);
    return rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '';
  }
  if (currentLevel === 'ansi256') {
    const rgb = resolveRgb(color);
    return rgb ? `\x1b[38;5;${rgbTo256(rgb)}m` : '';
  }
  // ansi16
  const name = resolveAnsi16Name(color);
  return name ? `\x1b[${FG_MAP[name] ?? ''}m` : '';
}

/** 背景色转义码。语义同 fg()，但用 48;/4x 前缀。 */
export function bg(color: string | undefined): string {
  if (!color) return '';
  if (currentLevel === 'truecolor') {
    const rgb = resolveRgb(color);
    return rgb ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '';
  }
  if (currentLevel === 'ansi256') {
    const rgb = resolveRgb(color);
    return rgb ? `\x1b[48;5;${rgbTo256(rgb)}m` : '';
  }
  // ansi16
  const name = resolveAnsi16Name(color);
  return name ? `\x1b[${BG_MAP[name] ?? ''}m` : '';
}

// ═══════ 原始码接口（供 setCell 手动构建，当前生产代码无调用方） ═══════

/** 返回 16 色原始 ANSI 码（如 '31'）。仅 ansi16 降级场景用。 */
export function fgAnsi(color: string | undefined): string {
  const name = resolveAnsi16Name(color);
  if (!name) return '';
  return FG_MAP[name] ?? '';
}

/** 返回 16 色原始 ANSI 码（如 '41'）。 */
export function bgAnsi(color: string | undefined): string {
  const name = resolveAnsi16Name(color);
  if (!name) return '';
  return BG_MAP[name] ?? '';
}
