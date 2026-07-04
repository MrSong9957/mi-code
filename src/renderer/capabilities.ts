// 终端能力探测
//
// 物理本质：探测终端"认不认得某条特殊指令"、"能显多少种颜色"。
// BSU/ESU（DEC 2026 同步更新）能让终端把一整帧的中间状态藏起来，最后一次性揭幕，
// 消除重画闪烁。但老终端不认这条指令，会把 \x1b[?2026h 当成可见垃圾字符显示，
// 所以用之前必须先探测。
//
// truecolor（\x1b[38;2;R;G;Bm）让终端显 1600 万色，但老终端只认 16 色或 256 色，
// 发 truecolor 序列会被忽略或显示乱码，所以也要探测后选合适的颜色编码。

/** 颜色能力等级（由低到高） */
export type ColorLevel = 'ansi16' | 'ansi256' | 'truecolor';

/** 探测当前终端是否支持 DEC 2026 同步更新（BSU/ESU）。 */
export function supportsSyncUpdate(): boolean {
  // dumb 终端直接降级
  if (process.env.TERM === 'dumb') return false;

  // TMUX：透传 2026 不可靠，除非外层终端明确支持（COLORTERM=truecolor 是强信号）
  if (process.env.TMUX) {
    return process.env.COLORTERM === 'truecolor';
  }

  // Windows Terminal（WT_SESSION）：DEC 2026 支持不稳定（部分版本会丢失
  // SGR 颜色属性或整帧渲染异常），保守降级为 false。仅 COLORTERM/明确信号才启用。
  // 见 https://github.com/microsoft/terminal/issues 对 2026 的历史 bug
  // if (process.env.WT_SESSION) return true;  // 注释掉：WT 的 BSU 不可靠

  // COLORTERM=truecolor：现代终端强信号（WezTerm/iTerm2 等透传过来）
  if (process.env.COLORTERM === 'truecolor') return true;

  // TERM_PROGRAM 已知支持 2026 的终端
  const tp = process.env.TERM_PROGRAM;
  if (tp === 'WezTerm' || tp === 'iTerm.app' || tp === 'vscode') {
    return true;
  }

  // TERM 包含已知终端名（kitty/alacritty/foot/wezterm 等）
  const term = process.env.TERM ?? '';
  if (/kitty|alacritty|foot|wezterm/i.test(term)) {
    return true;
  }

  // 无任何已知信号 → 保守降级
  return false;
}

/** 探测终端的颜色能力等级。
 *  - truecolor：COLORTERM=truecolor 或已知现代终端（WT_SESSION/WezTerm/iTerm/kitty 等）
 *  - ansi256：TERM 含 256color / 256color 字样
 *  - ansi16：其他（保守降级）
 *
 * 对齐 Claude Code 的 chalk.level 探测思路。 */
export function detectColorLevel(): ColorLevel {
  // dumb 终端
  if (process.env.TERM === 'dumb') return 'ansi16';

  // NO_COLOR 显式禁色（但保持 16 色基线，避免完全无色）
  if (process.env.NO_COLOR) return 'ansi16';

  // TMUX：透传色能力靠外层信号
  if (process.env.TMUX) {
    if (process.env.COLORTERM === 'truecolor') return 'truecolor';
    return 'ansi256'; // tmux 默认至少 256 色
  }

  // COLORTERM=truecolor：truecolor 强信号
  if (process.env.COLORTERM === 'truecolor') return 'truecolor';

  // Windows Terminal
  if (process.env.WT_SESSION) return 'truecolor';

  // 已知 truecolor 终端
  const tp = process.env.TERM_PROGRAM;
  if (tp === 'WezTerm' || tp === 'iTerm.app' || tp === 'vscode') return 'truecolor';

  const term = process.env.TERM ?? '';
  if (/kitty|alacritty|foot|wezterm/i.test(term)) return 'truecolor';

  // 256 色信号
  if (/256color|256color/i.test(term)) return 'ansi256';

  // 默认保守 16 色
  return 'ansi16';
}

