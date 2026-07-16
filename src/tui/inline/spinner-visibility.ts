// src/tui/inline/spinner-visibility.ts
// Spinner 可见性判定（纯函数，从 InlineApp 提取）。
//
// 设计意图（对标 Claude Code !visibleStreamingText）：
// spinner 与 assistant 正文互斥——正文流式输出时隐藏 spinner，
// 正文固化后也不应再显示（否则在 finalize→stopSpinner 窗口内闪烁）。
//
// 闪烁根因：message finalize (yield assistant) 早于 emitLoopEnd→stopSpinner，
// 两者间存在渲染窗口：active=true 且 isStreamingNow=false，
// 旧判定会在此窗口把 spinnerVisible 从 false 跳回 true → 画一帧 → stop 后擦掉 = 闪烁。
// 修复：finalized 后不再显示 spinner。

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
 * 1. spinner 未激活（active=false）
 * 2. assistant 正文正在流式输出（isStreamingNow && role !== thinking）
 * 3. assistant 正文刚固化（finalized=true）—— 防闪烁窗口
 *
 * 显示条件：active 且（thinking 流式中 / 无流式内容如工具调用间隙）。
 */
export function computeSpinnerVisible(input: SpinnerVisibilityInput): boolean {
  if (!input.spinnerActive) return false;
  // assistant 正文已固化：不再显示（防 finalize→stop 闪烁窗口）
  if (input.lastFinalized && input.lastRole === 'assistant') return false;
  // assistant 正文流式中：隐藏（thinking 流式除外）
  if (input.isStreamingNow && input.lastRole !== 'thinking') return false;
  return true;
}
