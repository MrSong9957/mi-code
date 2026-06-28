// 增量 diff 引擎（整篇核心）
//
// 物理本质：新旧两张格子纸逐格比对，只挑"变了样的格子"，
// 通过 VirtualScreen 生成 moveTo(相对移动) + writeCell 的指令串。
// **没变的格子不进入比对——这是"流式不重绘页脚"的物理实现**（文档§2.2③、§7.2）。
//
// 主屏 + 原生 scrollback 模式：minY = viewportY（已滚进 scrollback 的行数）。
// diff 只比对 y >= minY 的格子（可视行）；y < minY 的行在 scrollback 里够不着——
// 若它们变了，返回 needsFullReset=true（上层 fullReset 整屏重画，会闪）。

import type { Screen } from './screen.js';
import type { VirtualScreen } from './virtual-screen.js';
import { styleKey } from './cell.js';

/** 宽字符的占位标记（与 screen.ts 同口径） */
const WIDE_CONT = '\u0000';

/** renderDiff 结果 */
export interface DiffResult {
  /** 是否有 y < minY 的格子变化（scrollback 行被改）→ 需 fullReset */
  needsFullReset: boolean;
  /** 触发 fullReset 的最小 y（诊断用） */
  fullResetTriggerY: number;
}

/**
 * 把 prev → next 的变化，通过 vs 转成最少指令。
 * - 全同 → 不产出任何字节。
 * - 只对【变化了的格子】产出 moveTo + writeCell。
 * - minY 之上的行（y < minY）够不着；若它们变了 → needsFullReset=true，不产出指令（上层决定 fullReset）。
 * - 宽字符占位格跳过（跟随其主格一起被写）。
 */
export function renderDiff(
  prev: Screen,
  next: Screen,
  vs: VirtualScreen,
  minY: number = 0,
): DiffResult {
  const rows = Math.min(prev.rows, next.rows);
  const cols = Math.min(prev.cols, next.cols);
  let needsFullReset = false;
  let fullResetTriggerY = -1;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const pCell = prev.getCell(x, y);
      const nCell = next.getCell(x, y);

      // 跳过宽字符占位格（它由左边主格的写入顺带覆盖）
      if (nCell.char === WIDE_CONT && pCell.char === WIDE_CONT) continue;

      // 字符与样式都相同 → 跳过（页脚保护的核心）
      if (pCell.char === nCell.char && styleKey(pCell.style) === styleKey(nCell.style)) continue;

      // 变化但在 scrollback 区（y < minY）→ 够不着，标记 fullReset
      if (y < minY) {
        needsFullReset = true;
        if (fullResetTriggerY < 0) fullResetTriggerY = y;
        continue; // 不产出指令，继续扫描（或上层可早退）
      }

      // 有变化且在可视区：相对移到 (x,y) 再写（空格也照写——内容空格与背景空格无法区分，
      // 照写一个 ' ' 字节最安全，避免出现相对移动跳过实际内容）
      vs.moveTo(x, y);
      vs.writeCell(nCell);
    }
  }

  return { needsFullReset, fullResetTriggerY };
}
