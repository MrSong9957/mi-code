/** 光标上移 n 行 */
export const cursorUp = (n: number): string => `\x1b[${n}A`

/** 光标下移 n 行 */
export const cursorDown = (n: number): string => `\x1b[${n}B`

/** 擦除当前行（从光标到行尾） */
export const eraseLine = '\x1b[K'

/** 擦除 n 行（从当前行向上逐行擦除） */
export const eraseLines = (n: number): string =>
  Array(n).fill(cursorUp(1) + eraseLine).join('')

/** 隐藏光标 */
export const hideCursor = '\x1b[?25l'

/** 显示光标 */
export const showCursor = '\x1b[?25h'

/** SGR 样式序列 */
export const sgr = (code: string): string => `\x1b[${code}m`
