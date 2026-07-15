// src/render/emit.ts
// 把 Patch[] 写成 ANSI 序列发到 stdout（spec §4.5）。
// - DEC 2026 同步输出包裹（bsu/esu）
// - 每帧开头 reset 样式（不依赖帧间状态）
// - 两种光标模式：
//   CUP（默认）：绝对定位 \x1b[<y+1>;<x+1>H，邻接 patch 复用 cursor
//   cursorMove（useCursorMove=true）：首 patch CUP 建基准，后续相对移动
//     （cursorForward/cursorDown/cursorUp + \r），全角字符后 curX += widthOf
// - style transition 用 StylePool 缓存
// - ERASE_CHAR_ID → 写空格 ' '（逐 cell 擦除，不用 \x1b[K 避免误擦同行后续 cell）
// - 全角续位 patch → 跳过字符输出
// - 末尾 cursor 定位（如果有 cursor 提供）

import type { CharPool } from './char-pool.js';
import type { StylePool } from './style-pool.js';
import type { CursorPos, Patch } from './types.js';
import { ERASE_CHAR_ID } from './types.js';

export interface EmitContext {
  charPool: CharPool;
  stylePool: StylePool;
  stdout: { write: (s: string) => boolean };
  /** 光标位置（绝对，0-based）；无则隐藏光标 */
  cursor?: CursorPos;
  /** y 轴偏移（alt-screen=0，inline=footerTopRow-1）。所有 CUP 定位加此偏移。 */
  yBias?: number;
  /** 使用 cursorMove 相对移动模式（默认 false=CUP 绝对定位）。
   *  cursorMove 模式下首 patch 用 CUP 建基准，后续用相对移动 + widthOf 推进光标。 */
  useCursorMove?: boolean;
}

export function emit(patches: Patch[], ctx: EmitContext): void {
  const { charPool, stylePool, stdout, cursor, yBias, useCursorMove } = ctx;
  const bias = yBias ?? 0;
  const out: string[] = [];

  out.push('\x1b[?2026h');  // BSU
  out.push('\x1b[0m');      // 每帧 reset 样式
  let curStyleId = 0;

  if (useCursorMove) {
    // cursorMove 相对移动模式
    let curX = -1, curY = -1;

    for (const patch of patches) {
      if (patch.isFullWidthContinuation) continue;

      if (curX < 0) {
        // 首 patch：CUP 建基准
        out.push(`\x1b[${patch.y + bias + 1};${patch.x + 1}H`);
      } else {
        const dx = patch.x - curX;
        const dy = patch.y - curY;

        if (dy !== 0) {
          // 换行：\r + cursorUp/Down + cursorForward（不用 cursorBack，对齐 Claude Code log-update.ts:693）
          out.push('\r');
          if (dy < 0) out.push(`\x1b[${-dy}A`);  // cursorUp
          else if (dy > 0) out.push(`\x1b[${dy}B`);  // cursorDown
          if (patch.x > 0) out.push(`\x1b[${patch.x}C`);  // cursorForward
        } else if (dx === 1) {
          // 邻接，不需要移动
        } else if (dx > 1) {
          // 同行右移多列
          out.push(`\x1b[${dx}C`);  // cursorForward
        } else if (dx < 0) {
          // 同行左移：\r + cursorForward
          out.push('\r');
          if (patch.x > 0) out.push(`\x1b[${patch.x}C`);
        }
        // dx === 0：光标已在正确位置，不需要移动
      }

      if (patch.charId === ERASE_CHAR_ID) {
        out.push(' ');
        curX = patch.x + 1;
      } else {
        const trans = stylePool.transition(curStyleId, patch.styleId);
        if (trans) { out.push(trans); curStyleId = patch.styleId; }
        out.push(charPool.get(patch.charId));
        curX = patch.x + charPool.widthOf(patch.charId);
      }
      curY = patch.y;
    }
  } else {
    // CUP 绝对定位模式（默认，向后兼容）
    let prevX = -1, prevY = -1;

    for (const patch of patches) {
      if (patch.isFullWidthContinuation) continue;

      const adjacent = (patch.y === prevY && patch.x === prevX + 1);
      if (!adjacent) {
        out.push(`\x1b[${patch.y + bias + 1};${patch.x + 1}H`);
      }

      if (patch.charId === ERASE_CHAR_ID) {
        out.push(' ');
      } else {
        const trans = stylePool.transition(curStyleId, patch.styleId);
        if (trans) { out.push(trans); curStyleId = patch.styleId; }
        out.push(charPool.get(patch.charId));
      }

      prevX = patch.x;
      prevY = patch.y;
    }
  }

  // 末尾 cursor 定位（始终用 CUP 绝对定位）
  if (cursor) {
    out.push(`\x1b[${cursor.y + bias + 1};${cursor.x + 1}H`);
    out.push('\x1b[?25h');  // showCursor
  } else {
    out.push('\x1b[?25l');  // hideCursor
  }

  out.push('\x1b[?2026l');  // ESU
  stdout.write(out.join(''));
}
