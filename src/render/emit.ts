// src/render/emit.ts
// 把 Patch[] 写成 ANSI 序列发到 stdout（spec §4.5）。
// - DEC 2026 同步输出包裹（bsu/esu）
// - 每帧开头 reset 样式（不依赖帧间状态）
// - 绝对 cursor 定位（\x1b[<y+1>;<x+1>H，1-origin）
// - 邻接 patch 复用 cursor（不重发 cursorTo）
// - style transition 用 StylePool 缓存
// - ERASE_CHAR_ID → eraseEndLine
// - 全角续位 patch → 跳过字符输出
// - 末尾 cursor 定位（如果有 useCursor 提供）

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
}

export function emit(patches: Patch[], ctx: EmitContext): void {
  const { charPool, stylePool, stdout, cursor, yBias } = ctx;
  const bias = yBias ?? 0;
  const out: string[] = [];

  out.push('\x1b[?2026h');  // BSU
  out.push('\x1b[0m');      // 每帧 reset 样式
  let curStyleId = 0;
  let prevX = -1, prevY = -1;

  for (const patch of patches) {
    if (patch.isFullWidthContinuation) continue;  // 续位跳过字符输出

    // cursor 邻接判断（emit 自己做兜底，spec §4.4 决策）
    const adjacent = (patch.y === prevY && patch.x === prevX + 1);
    if (!adjacent) {
      out.push(`\x1b[${patch.y + bias + 1};${patch.x + 1}H`);
    }

    if (patch.charId === ERASE_CHAR_ID) {
      out.push('\x1b[K');  // eraseEndLine
    } else {
      // style transition
      const trans = stylePool.transition(curStyleId, patch.styleId);
      if (trans) { out.push(trans); curStyleId = patch.styleId; }
      // 字符
      out.push(charPool.get(patch.charId));
    }

    prevX = patch.x;
    prevY = patch.y;
  }

  // 末尾 cursor 定位
  if (cursor) {
    out.push(`\x1b[${cursor.y + bias + 1};${cursor.x + 1}H`);
    out.push('\x1b[?25h');  // showCursor
  } else {
    out.push('\x1b[?25l');  // hideCursor
  }

  out.push('\x1b[?2026l');  // ESU
  stdout.write(out.join(''));
}
