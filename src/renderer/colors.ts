// ANSI 颜色码生成 + theme token 解析（16 色单级）
//
// 物理本质：颜料挤出机。给它一个 token（或颜色名），
// 挤出对应的 16 色 ANSI 颜料管代码（如 \x1b[36m）。
//
// 设计原则（必须遵守）：
// 1. 保持 16 色 ANSI，不升级 truecolor/256，与现有渲染器兼容
// 2. token 解析经 theme.ts，组件用语义 token（brand/error）而非颜色名（cyan/red）
//
// 入参支持三种形式：
//  1. semantic token（'brand' / 'error' / 'codeKeyword'）→ resolveThemeColor 查主题
//  2. 'ansi:xxx' 格式（主题值的格式，如 'ansi:cyan'）→ 剥前缀查 FG_MAP
//  3. 直接颜色名（'cyan' / 'green'）→ 直接查 FG_MAP（向后兼容旧代码）

import { resolveThemeColor } from './theme.js';

// ═══════ 样式码 ═══════

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDERLINE = '\x1b[4m';

// ═══════ 16 色码表 ═══════

const FG_MAP: Record<string, string> = {
  black: '30', red: '31', green: '32', yellow: '33',
  blue: '34', magenta: '35', cyan: '36', white: '37',
  blackBright: '90', redBright: '91', greenBright: '92', yellowBright: '93',
  blueBright: '94', magentaBright: '95', cyanBright: '96', whiteBright: '97',
  // 常见别名
  gray: '90', grey: '90',
};

const BG_MAP: Record<string, string> = {
  black: '40', red: '41', green: '42', yellow: '43',
  blue: '44', magenta: '45', cyan: '46', white: '47',
  blackBright: '100', redBright: '101', greenBright: '102', yellowBright: '103',
  blueBright: '104', magentaBright: '105', cyanBright: '106', whiteBright: '107',
  gray: '100', grey: '100',
};

// ═══════ 入参 → FG_MAP key 解析 ═══════

/** 把入参（token / 'ansi:xxx' / 直接颜色名）解析成 FG_MAP 的 key。
 *  优先级：FG_MAP 直接命中 > theme token > 'ansi:xxx' 剥前缀。
 *  未知返回空串（= 无颜色码，默认前景）。 */
function resolveColorName(input: string | undefined): string {
  if (!input) return '';
  // 1. 直接颜色名命中 FG_MAP（向后兼容 'cyan' / 'gray' 等）
  if (FG_MAP[input] || BG_MAP[input]) return input;
  // 2. semantic token：查主题（返回 'ansi:xxx' 或 ''）
  const themeValue = resolveThemeColor(input);
  if (!themeValue) return '';
  // 3. 'ansi:xxx' 剥前缀
  if (themeValue.startsWith('ansi:')) {
    const name = themeValue.slice(5);
    return name;
  }
  // theme 返回的直接颜色名
  return themeValue;
}

// ═══════ fg / bg 主接口 ═══════

/** 前景色转义码。入参可是 semantic token、'ansi:xxx' 或直接颜色名。 */
export function fg(color: string | undefined): string {
  const name = resolveColorName(color);
  if (!name) return '';
  return `\x1b[${FG_MAP[name] ?? ''}m`;
}

/** 背景色转义码。语义同 fg()。 */
export function bg(color: string | undefined): string {
  const name = resolveColorName(color);
  if (!name) return '';
  return `\x1b[${BG_MAP[name] ?? ''}m`;
}

// ═══════ 原始码接口（供 setCell 等手动构建，当前生产代码无调用方） ═══════

/** 返回 16 色原始 ANSI 码（如 '31'）。 */
export function fgAnsi(color: string | undefined): string {
  const name = resolveColorName(color);
  if (!name) return '';
  return FG_MAP[name] ?? '';
}

/** 返回 16 色原始 ANSI 码（如 '41'）。 */
export function bgAnsi(color: string | undefined): string {
  const name = resolveColorName(color);
  if (!name) return '';
  return BG_MAP[name] ?? '';
}
