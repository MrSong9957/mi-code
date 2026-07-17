// src/tui/inline/spinner-visibility.ts
// Spinner 可见性判定（纯函数，从 InlineApp 提取）。
//
// 设计意图（方案 A1）：
// spinner 在整个 spinnerStore.active 期间持续显示——thinking、生成正文、
// 工具调用间隙,只要任务在跑(active=true)就显示,让用户始终看到"系统在工作"。
// 只在 stopSpinner() 真正调用后(active=false)才隐藏。
//
// 唯一例外:assistant 消息刚 finalize 但 stopSpinner 还没执行的那个渲染窗口
// (yield assistant 早于 emitLoopEnd→stopSpinner)。此时短暂隐藏 spinner,
// 避免 finalize→stop 之间画一帧残影再擦掉 = 闪烁(见 spinner-visibility.test.ts)。

export interface SpinnerVisibilityInput {
  /** spinnerStore.active */
  spinnerActive: boolean;
  /** 末条消息是否正在流式（!finalized && streamingText !== undefined） */
  isStreamingNow: boolean;
  /** 末条消息的 streamingText（throttled 后的值） */
  streamingText: string | undefined;
  /** 末条消息角色 */
  lastRole: string;
  /** 末条消息是否已固化 */
  lastFinalized: boolean;
}

/**
 * 判定 spinner 是否可见。
 *
 * 隐藏条件（任一满足即隐藏）：
 * 1. spinner 未激活（active=false）—— stopSpinner 已调用,任务结束
 * 2. assistant 正文刚固化（finalized=true）—— 防 finalize→stop 闪烁窗口
 *
 * 显示条件：active 且未进入 finalize 窗口（thinking 流式 / assistant 正文流式 / 工具调用间隙 / 等等）。
 */
export function computeSpinnerVisible(input: SpinnerVisibilityInput): boolean {
  if (!input.spinnerActive) return false;
  // assistant 正文已固化：不再显示（防 finalize→stop 闪烁窗口）
  if (input.lastFinalized && input.lastRole === 'assistant') return false;
  // 其他情况(thinking 流式 / assistant 正文流式 / 工具间隙 / Connecting):只要 active 就显示
  return true;
}
