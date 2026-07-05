// src/tui/components/scroll-state.ts
// 虚拟滚动状态计算（charter §核心模块 1）
//
// 物理本质：可视窗口在长列表上的「取景器」。
// 不靠终端原生滚动（alt screen 无 scrollback），应用层全权管理滚动状态。
// ScrollState 描述取景器位置：scrollTop（顶部索引）、visibleRows（高度）、maxScroll（下限）。
//
// 本期 MVP：按「消息条」滚动（每条 TuiMessage 是一个滚动单位）。
// 二期可细化到行级（需把 messages 展开成行数组再算）。

export interface ScrollState {
  /** 当前可视区顶部在总列表中的索引（0-based） */
  scrollTop: number;
  /** 可视区能容纳的行/条数 */
  visibleRows: number;
  /** 最大滚动上限 = max(0, total - visibleRows) */
  maxScroll: number;
}

export interface ScrollStateInput {
  total: number;
  visibleRows: number;
  scrollTop: number;
}

/** 计算滚动状态：maxScroll + 钳位后的 scrollTop */
export function computeScrollState(input: ScrollStateInput): ScrollState {
  const { total, visibleRows, scrollTop } = input;
  const maxScroll = Math.max(0, total - Math.max(0, visibleRows));
  return {
    scrollTop: clampScrollTop(scrollTop, maxScroll),
    visibleRows,
    maxScroll,
  };
}

/** 把 scrollTop 钳位到 [0, maxScroll] */
export function clampScrollTop(scrollTop: number, maxScroll: number): number {
  if (scrollTop < 0) return 0;
  if (scrollTop > maxScroll) return maxScroll;
  return scrollTop;
}

/** 从完整列表切片出当前可视区间 [scrollTop, scrollTop+visibleRows) */
export function sliceVisible<T>(items: T[], state: ScrollState): T[] {
  const start = state.scrollTop;
  if (start >= items.length) return [];
  const end = Math.min(items.length, start + state.visibleRows);
  return items.slice(start, end);
}
