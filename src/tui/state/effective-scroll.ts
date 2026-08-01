// src/tui/state/effective-scroll.ts
//
// 历史区 scrollTop 决策：从 ConnectedApp L167 的内联逻辑提取为可测纯函数。
//
// 物理本质：输入区动态增高时，footer 占用行数变化 → 历史区 visibleRows 变化 → maxScroll 变化。
// 旧代码 effectiveScrollTop = scrolledAway ? scrollTop : maxScroll 的 scrolledAway 分支未钳位，
// 当 maxScroll 缩小（resize 变宽 / 删内容）时旧 scrollTop 可能越界。
// 本函数统一钳位：scrolledAway 时 clampScrollTop(scrollTop, maxScroll)。

import { clampScrollTop } from '../components/scroll-state.js';

/**
 * 计算历史区有效 scrollTop。
 *
 * @param scrolledAway 用户是否向上滚动离开底部（true=受控 scrollTop，false=钉底）
 * @param scrollTop 当前受控 scrollTop（仅在 scrolledAway=true 时使用）
 * @param maxScroll 当前最大滚动上限 = max(0, total - visibleRows)
 * @returns 钳位后的有效 scrollTop
 *   - 钉底（scrolledAway=false）：返回 maxScroll（跟随最新消息）
 *   - 受控（scrolledAway=true）：返回 clampScrollTop(scrollTop, maxScroll)（防越界）
 */
export function computeEffectiveScrollTop(
  scrolledAway: boolean,
  scrollTop: number,
  maxScroll: number,
): number {
  return scrolledAway ? clampScrollTop(scrollTop, maxScroll) : maxScroll;
}
