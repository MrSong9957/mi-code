// src/render/optimizer.ts
// Patch 优化器（spec §4.4）：输出仍是单 cell Patch[]，不合并行段。
// 行段合并由 emit 自己用邻接判断完成。
//
// optimizer 职责：
// 1. 过滤全角续位 patch（emit 不需要）
// 2. 行内按 x 排序（让 emit 邻接判断命中率高）
// 3. 「写空白+默认样式」patch → 标记 ERASE_CHAR_ID（让 emit 发 eraseEndLine）

import { ERASE_CHAR_ID, type Patch } from './types.js';

export function optimize(patches: Patch[]): Patch[] {
  if (patches.length === 0) return [];

  // 1. 过滤全角续位 + 标记 ERASE
  const filtered: Patch[] = [];
  for (const p of patches) {
    if (p.isFullWidthContinuation) continue;  // 续位跳过
    if (p.charId === 0 && p.styleId === 0) {
      // 空白 + 默认样式 → 标记 ERASE
      filtered.push({ ...p, charId: ERASE_CHAR_ID });
    } else {
      filtered.push(p);
    }
  }

  // 2. 按 (y, x) 排序
  filtered.sort((a, b) => a.y - b.y || a.x - b.x);

  return filtered;
}
