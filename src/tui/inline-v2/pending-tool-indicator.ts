// src/tui/inline-v2/pending-tool-indicator.ts
//
// AUTO-0025-stable Task 1:运行中工具(pending spawn_agent)的稳定指示器。
//
// 物理本质:pending 工具用闪烁的 ● 表示"正在执行"。闪烁由共享 spinner 时钟驱动,
// 所有 pending 工具复用同一个 useSpinnerClock(),不各自建 setInterval——
// 这样 N 个并行 pending 工具只触发叶子组件重渲染,不拖动整棵 InlineAppV2 树。
//
// 本文件只提供纯函数:输入时间戳 → 输出 ● 是否可见。组件在 PendingToolMessage.tsx。

/** 闪烁周期:600ms 可见 / 600ms 隐藏,循环。 */
export const PENDING_TOOL_BLINK_INTERVAL_MS = 600;

/**
 * 判断给定时间戳下 pending 元素(工具或 thinking)的 ● 是否可见。
 *
 * 周期语义:每个 intervalMs 区间内,偶数区间可见(0~599ms、1200~1799ms...),
 * 奇数区间隐藏(600~1199ms、1800~2399ms...)。所有 pending 元素用同一时间戳,
 * 保证并行时同步闪烁(in-phase)。
 *
 * 防御边界:负数/NaN/Infinity 时间戳按 0 处理,落在首个可见窗口——
 * 避免 pending 刚创建时因时钟未初始化而显示空白。
 */
export function isPendingGlyphVisible(
  timeMs: number,
  intervalMs: number = PENDING_TOOL_BLINK_INTERVAL_MS,
): boolean {
  const safeTime = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
  return Math.floor(safeTime / intervalMs) % 2 === 0;
}

/** 兼容别名:pending 工具仍可用旧名,内部指向同一实现。 */
export const isPendingToolGlyphVisible = isPendingGlyphVisible;
