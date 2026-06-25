// 单个终端字符单元
export interface Cell {
  char: number;    // 字符池索引（整数比较，非字符串）
  fg: number;      // 前景色 ID
  bg: number;      // 背景色 ID
  attrs: number;   // 位标志：bold=1, dim=2, italic=4, underline=8
}

export const ATTR_BOLD = 1;
export const ATTR_DIM = 2;
export const ATTR_ITALIC = 4;
export const ATTR_UNDERLINE = 8;

// 空白单元
export const EMPTY_CELL: Cell = { char: 0, fg: 0, bg: 0, attrs: 0 };

export function cellEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs;
}
