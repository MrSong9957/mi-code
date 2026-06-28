// 画布 ScreenBuffer：rows×cols 二维格子网格
//
// 物理本质：一张和屏幕一样大的格子纸，每格贴一个字符 + 样式。
// 渲染器用它表示"一帧"——新旧两张格子纸逐格比对就是 diff（文档§2.2）。
//
// 存储采用按格数组（chars[y*cols+x] 一维铺平），简单且易克隆/resize。

import { EMPTY_CELL, type Cell, type Style, stringToCells, isWideCodePoint } from './cell.js';

/** 宽字符（中文/emoji）在网格里占两列：主格存字符，副格存占位标记。 */
const WIDE_CONT = '\u0000'; // 用 NUL 标记"我是左边那个宽字符的延续占位"

export class Screen {
  rows: number;
  cols: number;
  // 每格的字符（一维铺平，索引 = y*cols + x）
  private chars: string[];
  // 每格的样式（同上铺平）。用序列化 key 串而非对象，省内存、便于相等比较。
  private styles: string[];

  constructor(rows: number, cols: number) {
    this.rows = Math.max(0, rows);
    this.cols = Math.max(0, cols);
    const n = this.rows * this.cols;
    this.chars = new Array(n).fill(' ');
    this.styles = new Array(n).fill('');
  }

  private idx(x: number, y: number): number {
    return y * this.cols + x;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  /** 读取某格（越界返回 EMPTY_CELL）。x=列，y=行。 */
  getCell(x: number, y: number): Cell {
    if (!this.inBounds(x, y)) return { ...EMPTY_CELL };
    const i = this.idx(x, y);
    const styleKey = this.styles[i]!;
    return { char: this.chars[i]!, style: parseStyleKey(styleKey) };
  }

  /** 写入某格（越界静默忽略）。 */
  setCell(x: number, y: number, cell: Cell): void {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    this.chars[i] = cell.char;
    this.styles[i] = styleKeyOf(cell.style);
  }

  /**
   * 把文本从某行某列起铺进网格。宽字符占两列（第二列写占位标记）。
   * 超出宽度的部分裁掉。style 应用到所有写入的字符。
   */
  writeRow(y: number, text: string, style: Style, startX: number = 0): void {
    if (y < 0 || y >= this.rows) return;
    const cells = stringToCells(text, style);
    const key = styleKeyOf(style);
    let x = startX;
    for (const cell of cells) {
      if (x >= this.cols) break;
      const i = this.idx(x, y);
      this.chars[i] = cell.char;
      this.styles[i] = key;
      // 宽字符占第二格（占位）
      if (this.isWide(cell.char) && x + 1 < this.cols) {
        this.chars[this.idx(x + 1, y)] = WIDE_CONT;
        this.styles[this.idx(x + 1, y)] = key;
        x += 2;
      } else {
        x += 1;
      }
    }
  }

  /** 清空某行（全填空格 + 清样式）。 */
  clearRow(y: number): void {
    if (y < 0 || y >= this.rows) return;
    for (let x = 0; x < this.cols; x++) {
      const i = this.idx(x, y);
      this.chars[i] = ' ';
      this.styles[i] = '';
    }
  }

  /** 清空整屏。 */
  clear(): void {
    this.chars.fill(' ');
    this.styles.fill('');
  }

  /** 深拷贝。 */
  clone(): Screen {
    const c = new Screen(this.rows, this.cols);
    c.chars = this.chars.slice();
    c.styles = this.styles.slice();
    return c;
  }

  /** 调整尺寸。放大保留旧内容、新增区域为空；缩小裁掉超出部分。 */
  resize(rows: number, cols: number): void {
    const newRows = Math.max(0, rows);
    const newCols = Math.max(0, cols);
    if (newRows === this.rows && newCols === this.cols) return;

    const newChars = new Array(newRows * newCols).fill(' ');
    const newStyles = new Array(newRows * newCols).fill('');
    const copyCols = Math.min(this.cols, newCols);
    const copyRows = Math.min(this.rows, newRows);
    for (let y = 0; y < copyRows; y++) {
      for (let x = 0; x < copyCols; x++) {
        const src = this.idx(x, y);
        const dst = y * newCols + x;
        newChars[dst] = this.chars[src]!;
        newStyles[dst] = this.styles[src]!;
      }
    }
    this.rows = newRows;
    this.cols = newCols;
    this.chars = newChars;
    this.styles = newStyles;
  }

  /** 内部：判断字符是否宽字符（占 2 列）——复用 cell.ts 的统一口径，避免漂移 */
  private isWide(char: string): boolean {
    return isWideCodePoint(char.codePointAt(0) ?? 0);
  }

  // ─────────────── 静态：逐格比对 ───────────────

  /**
   * 返回 prev 与 next 之间"变化了"的格子坐标列表 [x, y]。
   * 宽字符占位格（WIDE_CONT）不单独计入——跟随其主格。
   * 尺寸不同时按两者交集比对。
   */
  static diffCells(prev: Screen, next: Screen): Array<[number, number]> {
    const rows = Math.min(prev.rows, next.rows);
    const cols = Math.min(prev.cols, next.cols);
    const out: Array<[number, number]> = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const pc = prev.chars[i] ?? ' ';
        const nc = next.chars[i] ?? ' ';
        const ps = prev.styles[i] ?? '';
        const ns = next.styles[i] ?? '';
        if (pc !== nc || ps !== ns) {
          out.push([x, y]);
        }
      }
    }
    return out;
  }
}

// ═══════ Style <-> 序列化 key（复用 cell.ts，保持同口径）═══════

import { styleKey as styleKeyOf, styleFromKey as parseStyleKey } from './cell.js';
