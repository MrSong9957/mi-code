// ANSI 终端控制码原语模块
//
// 物理本质：搬运/擦格子的"指令积木"。每个函数返回一段固定字节串，
// 上层把它拼成完整的终端指令。
//
// 坐标约定：本模块对外一律 0-based（row 0=顶行，col 0=最左列）；
// 内部发射 CSI 绝对定位时才转成终端要求的 1-based。

// ═══════ 单字节 / 整行 / 整屏 ═══════

/** 回车：回本行最左（不下移） */
export function cr(): string {
  return '\r';
}

/** 擦当前整行（EL） */
export function eraseLine(): string {
  return '\x1b[2K';
}

/** 擦整屏（ED） */
export function eraseScreen(): string {
  return '\x1b[2J';
}

/** 光标回左上角原点（CSI H） */
export function cursorHome(): string {
  return '\x1b[H';
}

// ═══════ 相对移动（CUU/CUD/CUF/CUB） ═══════
//
// 这些是 VirtualScreen 真正发出去的指令形态：只依赖"打印头现在在某处"，
// 对起点不敏感——这是整套光标协调机制的命门（文档§2.3 铁律）。

/** 往上 n 行（CUU） */
export function cursorUp(n: number): string {
  if (n <= 0) return '';
  return `\x1b[${n}A`;
}

/** 往下 n 行（CUD） */
export function cursorDown(n: number): string {
  if (n <= 0) return '';
  return `\x1b[${n}B`;
}

/** 往右 n 格（CUF） */
export function cursorForward(n: number): string {
  if (n <= 0) return '';
  return `\x1b[${n}C`;
}

/** 往左 n 格（CUB） */
export function cursorBack(n: number): string {
  if (n <= 0) return '';
  return `\x1b[${n}D`;
}

/**
 * 组合相对移动：dx=列偏移（+=右），dy=行偏移（+=下）。
 * 先水平后垂直，与 cursorMove 的拆解顺序一致。
 */
export function cursorMove(dx: number, dy: number): string {
  const h = dx > 0 ? cursorForward(dx) : cursorBack(-dx);
  const v = dy > 0 ? cursorDown(dy) : cursorUp(-dy);
  return h + v;
}

// ═══════ 绝对定位（0-based → 1-based ANSI） ═══════

/**
 * 走到绝对坐标 (row, col)（CUP），0-based 输入。
 * 备用屏模式下用于每帧末把光标精准送到输入框光标处（文档§3.3）。
 */
export function cup(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`;
}

/** 走到本行第 col 列（CHA），0-based 输入。 */
export function cursorColumn(col: number): string {
  return `\x1b[${col + 1}G`;
}

// ═══════ DEC 私有模式 ═══════

/** 切到备用屏画布（DEC 1049 set） */
export function enterAltScreen(): string {
  return '\x1b[?1049h';
}

/** 切回主屏画布（DEC 1049 reset） */
export function exitAltScreen(): string {
  return '\x1b[?1049l';
}

/** 显示光标（DEC 25 set） */
export function showCursor(): string {
  return '\x1b[?25h';
}

/** 隐藏光标（DEC 25 reset）——备用屏里自己管光标位置时用 */
export function hideCursor(): string {
  return '\x1b[?25l';
}

/** 关闭自动换行（DEC 7 reset，DECAWM off）——备用屏里写满一行不再滚到下一行 */
export function disableAutowrap(): string {
  return '\x1b[?7l';
}

/** 开启自动换行（DEC 7 set，DECAWM on）——退出前恢复终端默认 */
export function enableAutowrap(): string {
  return '\x1b[?7h';
}

/**
 * 开启鼠标跟踪（DEC 1000 + SGR 1006）——把鼠标滚轮变成可解析的事件。
 * 1000 = 含滚轮的按钮跟踪；1006 = SGR 编码（ESC[<btn;col;row M/m，干净可解析）。
 * 代价：启用后终端不再做原生文本选择（鼠标拖拽选字→复制失效）。
 */
export function enableMouseTracking(): string {
  return '\x1b[?1000h\x1b[?1006h';
}

/** 关闭鼠标跟踪（反序：先关 1006 编码，再关 1000 跟踪） */
export function disableMouseTracking(): string {
  return '\x1b[?1006l\x1b[?1000l';
}

/** 开始同步更新（DEC 2026 set，BSU）——整帧原子揭幕开头 */
export function bsu(): string {
  return '\x1b[?2026h';
}

/** 结束同步更新（DEC 2026 reset，ESU）——整帧原子揭幕结尾 */
export function esu(): string {
  return '\x1b[?2026l';
}
