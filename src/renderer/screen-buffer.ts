import { type Cell, EMPTY_CELL, cellEqual } from './cell.js';
import type { CharPool, StylePool } from './pool.js';

export interface ScreenBuffer {
  width: number;
  height: number;
  cells: Cell[];
  charPool: CharPool;
  stylePool: StylePool;
}

export function createScreenBuffer(
  width: number,
  height: number,
  charPool: CharPool,
  stylePool: StylePool,
): ScreenBuffer {
  const cells = new Array(width * height);
  for (let i = 0; i < cells.length; i++) cells[i] = { ...EMPTY_CELL };
  return { width, height, cells, charPool, stylePool };
}

export function clearBuffer(buf: ScreenBuffer): void {
  for (let i = 0; i < buf.cells.length; i++) {
    buf.cells[i]!.char = 0;
    buf.cells[i]!.fg = 0;
    buf.cells[i]!.bg = 0;
    buf.cells[i]!.attrs = 0;
  }
}

export function setCell(
  buf: ScreenBuffer,
  x: number,
  y: number,
  char: string,
  fg: string,
  bg: string,
  attrs: number,
): void {
  if (x < 0 || x >= buf.width || y < 0 || y >= buf.height) return;
  const cell = buf.cells[y * buf.width + x]!;
  cell.char = buf.charPool.intern(char);
  cell.fg = buf.stylePool.intern(fg);
  cell.bg = buf.stylePool.intern(bg);
  cell.attrs = attrs;
}

// Diff 补丁
export type Patch =
  | { type: 'cursorTo'; x: number; y: number }
  | { type: 'style'; ansi: string }
  | { type: 'write'; content: string }
  | { type: 'clear' };

export function diffBuffers(prev: ScreenBuffer, curr: ScreenBuffer): Patch[] {
  const patches: Patch[] = [];
  const w = Math.min(prev.width, curr.width);
  const h = Math.min(prev.height, curr.height);

  let needCursor = true;
  let lastFg = -1, lastBg = -1, lastAttrs = -1;
  let batchChars = '';

  function flushBatch() {
    if (batchChars) {
      patches.push({ type: 'write', content: batchChars });
      batchChars = '';
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const prevCell = prev.cells[y * prev.width + x]!;
      const currCell = curr.cells[y * curr.width + x]!;

      if (cellEqual(prevCell, currCell)) {
        // 跳过未变化的单元格，断开批量
        flushBatch();
        needCursor = true;
        continue;
      }

      // 需要光标移动
      if (needCursor) {
        flushBatch();
        patches.push({ type: 'cursorTo', x, y });
        needCursor = false;
        lastFg = lastBg = lastAttrs = -1; // 强制刷新样式
      }

      // 样式变化时刷新批量并输出新样式
      if (lastFg !== currCell.fg || lastBg !== currCell.bg || lastAttrs !== currCell.attrs) {
        flushBatch();
        const fgCode = curr.stylePool.get(currCell.fg);
        const bgCode = curr.stylePool.get(currCell.bg);
        patches.push({ type: 'style', ansi: buildAnsiCode(fgCode, bgCode, currCell.attrs) });
        lastFg = currCell.fg;
        lastBg = currCell.bg;
        lastAttrs = currCell.attrs;
      }

      // 累积字符到批量缓冲
      batchChars += curr.charPool.get(currCell.char);
    }
    // 行末断开批量
    flushBatch();
    needCursor = true;
  }

  flushBatch();
  return patches;
}

function buildAnsiCode(fg: string, bg: string, attrs: number): string {
  const parts: string[] = ['0']; // 重置
  if (attrs & 1) parts.push('1'); // bold
  if (attrs & 2) parts.push('2'); // dim
  if (attrs & 4) parts.push('3'); // italic
  if (attrs & 8) parts.push('4'); // underline
  if (fg) parts.push(fg);
  if (bg) parts.push(bg);
  return `\x1b[${parts.join(';')}m`;
}
