// 终端能力探测
//
// 物理本质：探测终端"认不认得某条特殊指令"。
// BSU/ESU（DEC 2026 同步更新）能让终端把一整帧的中间状态藏起来，最后一次性揭幕，
// 消除重画闪烁。但老终端不认这条指令，会把 \x1b[?2026h 当成可见垃圾字符显示，
// 所以用之前必须先探测。
//
// 探测策略（对齐 Claude Code 的保守思路）：
//  1. 已知支持 2026 的现代终端（WezTerm/iTerm2/kitty/Alacritty/foot/VSCode xterm.js/Windows Terminal）→ true
//  2. COLORTERM=truecolor → true（能 truecolor 的现代终端基本都支持 2026）
//  3. TMUX 下保守返回 false（除非外层终端明确亮了 truecolor 信号）
//  4. dumb / 无信号 → false（保守降级到裸 flush）

/** 探测当前终端是否支持 DEC 2026 同步更新（BSU/ESU）。 */
export function supportsSyncUpdate(): boolean {
  // dumb 终端直接降级
  if (process.env.TERM === 'dumb') return false;

  // TMUX：透传 2026 不可靠，除非外层终端明确支持（COLORTERM=truecolor 是强信号）
  if (process.env.TMUX) {
    return process.env.COLORTERM === 'truecolor';
  }

  // Windows Terminal（WT_SESSION 环境变量是它的指纹）
  if (process.env.WT_SESSION) return true;

  // COLORTERM=truecolor：现代终端强信号
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
