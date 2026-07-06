// src/render/output-ops.ts
// 操作收集器：blit 是编码值的唯一生产点（spec §3.6 铁律 4）。
// 接收 Style 对象（非 poolId），内部 intern + 编码 + 全角续位处理。

import stringWidth from 'string-width';
import type { Screen } from './screen.js';
import type { Style } from './types.js';
import { encodeStyleId } from './types.js';

/**
 * 在 screen 的（y 行 x 列起）写入字符串，应用样式。
 * 处理：码点遍历、全角字符双 cell、行末整字裁剪、多行（\n）。
 */
export function blit(screen: Screen, x: number, y: number, text: string, style: Style): void {
  if (text === '') return;
  const styleId = screen.stylePool.intern(style);

  // 按行分割（支持多行）
  const lines = text.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const targetY = y + lineIdx;
    if (targetY < 0 || targetY >= screen.rows) continue;

    // 按码点遍历（[...line] 等价）
    let cx = x;
    for (const ch of line) {
      if (cx >= screen.cols) break;  // 行末裁剪
      const w = stringWidth(ch);
      if (w <= 0) continue;  // 零宽字符（如组合标记）跳过
      if (cx + w > screen.cols) break;  // 全角字符跨右边界，整字裁掉

      const charId = screen.charPool.intern(ch);
      // head cell
      screen.setCell(cx, targetY, charId, encodeStyleId(styleId, false));
      // 全角续位 cell（w===2 时）
      if (w === 2 && cx + 1 < screen.cols) {
        screen.setCell(cx + 1, targetY, charId, encodeStyleId(styleId, true));
      }
      cx += w;
    }
  }
}

/**
 * 把 Screen 的指定矩形区域清空（写空白 + 默认样式）。
 * 用于 yoga-walk 在重绘前清场，或 clip 区域。
 */
export function clearRegion(screen: Screen, x1: number, y1: number, x2: number, y2: number): void {
  for (let y = Math.max(0, y1); y < Math.min(screen.rows, y2); y++) {
    for (let x = Math.max(0, x1); x < Math.min(screen.cols, x2); x++) {
      screen.setCell(x, y, 0, 0);
    }
  }
}
