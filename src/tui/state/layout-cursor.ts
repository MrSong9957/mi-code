// src/tui/state/layout-cursor.ts
//
// 光标在 wordWrap 后的物理行 + 列计算。
//
// 物理本质：wordWrap 把长文本切成多行，光标在哪个切出来的行 + 该行内的列。
// DECAWM OFF 后物理行 = wordWrap 切出的行，不再需要猜测终端折行。
//
// 算法：对 prefix + 光标前内容 做 wrapLine，最后一行就是光标所在物理行，
// 其 displayWidth 就是光标列。
//
// 码点安全：cursorCpOffset 是码点索引（与 input-store 一致）。
// 切片用 [...text].slice(0, offset).join('') 保证 emoji 代理对不被劈开。

import stringWidth from 'string-width';
import { wrapLine } from './wrap-line.js';

export interface CursorLayout {
  /** 光标所在物理行（0-based，相对 wordWrap 后的行数组） */
  row: number;
  /** 光标在该行的显示列（0-based，含 prefix 偏移） */
  col: number;
}

/**
 * 计算光标在 wordWrap 后的物理行 + 列。
 *
 * @param text 光标所在逻辑行的完整文本（不含 \n，不含 prefix）
 * @param cursorCpOffset 光标在该行的码点偏移（0-based，[0, 码点数]）
 * @param prefix 行前缀（prompt/缩进，如 '❯ '）
 * @param usableWidth 可用宽度（getUsableWidth(cols)）
 * @returns 光标的 (row, col)
 */
export function layoutInputCursor(
  text: string,
  cursorCpOffset: number,
  prefix: string,
  usableWidth: number,
): CursorLayout {
  // 码点安全切片：[...text] 把字符串拆成码点数组，避免劈开 emoji 代理对
  const cps = [...text];
  const clampedOffset = Math.max(0, Math.min(cursorCpOffset, cps.length));
  const beforeCursor = cps.slice(0, clampedOffset).join('');

  // 对 prefix + 光标前内容 做 wrapLine
  // 最后一行就是光标所在物理行，其 displayWidth 就是光标列
  const wrapped = wrapLine(prefix + beforeCursor, usableWidth);
  const lastLine = wrapped[wrapped.length - 1]!;

  return {
    row: wrapped.length - 1,
    col: stringWidth(lastLine),
  };
}
