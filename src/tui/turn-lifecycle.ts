// src/tui/turn-lifecycle.ts
//
// AUTO-0025-transient Task 2:跨 turn 的 thinking 状态 + 统一清理。
//
// 物理本质:一轮对话里 thinking 的"计时器"。模型开始思考时启动(startTurnThinking),
// 在任意退出路径(loop-end/finally/工具乱序/ESC/错误)统一结束(finishTurnThinking)。
// 幂等:已结束的状态再 finish 不重复 emit。
//
// duration 两段式策略:
// - finishTurnThinking 用 Math.floor(elapsedMs/1000) 向下取整,不夸大实际耗时
// - formatThinkingSummary 接收整数秒,Math.round 不变,Math.max(1,...) 保证至少 1s 显示

export interface TurnLifecycle {
  activeToolIds: Set<string>;
  setSpinnerHasActiveTools: (hasActiveTools: boolean) => void;
  emitThinkingEnd: (durationSec: number) => void;
  stopSpinner: () => void;
  now: () => number;
}

/**
 * AUTO-0025-transient:不可变 thinking 状态。
 * - active:本轮是否在 thinking 计时中
 * - startedAtMs:thinking 开始的时间戳(用于算 elapsed)
 */
export interface TurnThinkingState {
  active: boolean;
  startedAtMs: number;
}

/** 初始空闲态。 */
export function idleTurnThinking(): TurnThinkingState {
  return { active: false, startedAtMs: 0 };
}

/**
 * 启动 thinking 计时。已 active 时幂等返回原状态。
 */
export function startTurnThinking(
  state: TurnThinkingState,
  nowMs: number,
): TurnThinkingState {
  return state.active ? state : { active: true, startedAtMs: nowMs };
}

/**
 * 结束 thinking 计时并 emit thinking_end。未 active 时幂等返回空闲态。
 *
 * duration 用 Math.floor(elapsedMs/1000):显示时间不夸大实际耗时。
 * 例如 elapsed=1500ms → emit 1(不是 round 的 2)。
 */
export function finishTurnThinking(
  lifecycle: TurnLifecycle,
  state: TurnThinkingState,
): TurnThinkingState {
  if (!state.active) return state;
  const elapsed = Math.max(0, lifecycle.now() - state.startedAtMs);
  lifecycle.emitThinkingEnd(Math.floor(elapsed / 1000));
  return idleTurnThinking();
}

/**
 * loop-end 清理:只清工具 ID + spinner hasActiveTools。
 * thinking 的结束由 finalizeTurnLifecycle 统一处理。
 */
export function handleTurnLoopEnd(lifecycle: TurnLifecycle): void {
  lifecycle.activeToolIds.clear();
  lifecycle.setSpinnerHasActiveTools(false);
}

/**
 * 轮次最终收尾:先结束 thinking(emit 摘要),再 stop spinner。
 * 幂等:重复调用只产生一次 thinking_end(第二次 finishTurnThinking 因 active=false 跳过)。
 */
export function finalizeTurnLifecycle(
  lifecycle: TurnLifecycle,
  thinking: TurnThinkingState,
): TurnThinkingState {
  handleTurnLoopEnd(lifecycle);
  const next = finishTurnThinking(lifecycle, thinking);
  lifecycle.stopSpinner();
  return next;
}
