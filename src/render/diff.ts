// src/render/diff.ts
// cell-level diff：逐 cell 比较 front/back 的 Int32Array，产出 Patch[]。
// spec §4.3：全角续位 cell 仍进 Patch（不 continue），由 emit 跳过字符输出。
// Patch.styleId 是解码后的纯 poolId（spec §3.6 铁律 2）。

import type { Screen } from './screen.js';
import type { Patch } from './types.js';
import { decodeStyleId, isFullWidthContinuation } from './types.js';

export function diff(front: Screen, back: Screen): Patch[] {
  if (front.rows !== back.rows || front.cols !== back.cols) {
    throw new Error(`diff: screen size mismatch (front ${front.rows}x${front.cols}, back ${back.rows}x${back.cols})`);
  }
  const patches: Patch[] = [];
  const cols = front.cols;
  const len = front.chars.length;
  for (let i = 0; i < len; i += 2) {
    if (front.chars[i] !== back.chars[i] || front.chars[i + 1] !== back.chars[i + 1]) {
      const cellIndex = i / 2;
      const y = Math.floor(cellIndex / cols);
      const x = cellIndex % cols;
      const encodedStyle = back.chars[i + 1];
      patches.push({
        x, y,
        charId: back.chars[i],
        styleId: decodeStyleId(encodedStyle),
        isFullWidthContinuation: isFullWidthContinuation(encodedStyle),
      });
    }
  }
  return patches;
}
