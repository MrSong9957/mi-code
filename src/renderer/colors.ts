// ANSI 终端控制码工具模块
//
// 物理本质：调色盘。
// 提供前景色、背景色、样式（粗体/斜体/下划线）的 ANSI 转义码生成。

// ═══════ 样式码 ═══════

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDERLINE = '\x1b[4m';

// ═══════ 前景色 ═══════

const FG_MAP: Record<string, string> = {
  black: '30', red: '31', green: '32', yellow: '33',
  blue: '34', magenta: '35', cyan: '36', white: '37',
  gray: '90', grey: '90',
  redBright: '91', greenBright: '92', yellowBright: '93', blueBright: '94',
  magentaBright: '95', cyanBright: '96', whiteBright: '97',
};

// ═══════ 背景色 ═══════

const BG_MAP: Record<string, string> = {
  black: '40', red: '41', green: '42', yellow: '43',
  blue: '44', magenta: '45', cyan: '46', white: '47',
  gray: '100', grey: '100',
};

// ═══════ 组合色（前景+样式）═══════

/** 预定义的组合色常量，覆盖 code-highlighter / markdown-renderer / tool-status-panel 所需 */
// 注意：ANSI 对象在模块加载时调用 fg() 计算 ANSI 转义码，这是有意设计——常量在导入时确定，避免运行时重复计算
export const ANSI = {
  // 样式
  reset: RESET,
  bold: BOLD,
  dim: DIM,
  italic: ITALIC,
  underline: UNDERLINE,

  // 基础前景色
  cyan: fg('cyan'),
  yellow: fg('yellow'),
  green: fg('green'),
  red: fg('red'),
  blue: fg('blue'),
  magenta: fg('magenta'),
  gray: fg('gray'),
  white: fg('white'),

  // 组合样式
  heading1: `${BOLD}${fg('cyan')}`,
  heading2: `${BOLD}${fg('yellow')}`,
  heading3: `${BOLD}${fg('green')}`,
  code_inline: fg('yellow'),
  code_block: fg('cyan'),
  quote: fg('cyan'),
  list: fg('yellow'),
  link: `${UNDERLINE}${fg('blue')}`,
  string: fg('green'),
  comment: fg('gray'),
  keyword: fg('cyan'),
  number: fg('yellow'),
  border: fg('cyan'),
} as const;

// ═══════ 辅助函数 ═══════

/** 前景色转义码 */
export function fg(color: string | undefined): string {
  if (!color) return '';
  return `\x1b[${FG_MAP[color] ?? ''}m`;
}

/** 背景色转义码 */
export function bg(color: string | undefined): string {
  if (!color) return '';
  return `\x1b[${BG_MAP[color] ?? ''}m`;
}

// ═══════ 兼容旧接口 ═══════

/** 返回原始 ANSI 码（如 '31'），用于 setCell 等需要手动构建转义序列的场景 */
export function fgAnsi(color: string | undefined): string {
  if (!color) return '';
  return FG_MAP[color] ?? '';
}

/** 返回原始 ANSI 码（如 '41'），用于 setCell 等需要手动构建转义序列的场景 */
export function bgAnsi(color: string | undefined): string {
  if (!color) return '';
  return BG_MAP[color] ?? '';
}
