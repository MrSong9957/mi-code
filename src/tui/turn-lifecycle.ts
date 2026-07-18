export interface TurnLifecycle {
  activeToolIds: Set<string>;
  setSpinnerHasActiveTools: (hasActiveTools: boolean) => void;
  emitThinkingEnd: (durationSec: number) => void;
  stopSpinner: () => void;
  now: () => number;
}

export interface TurnThinkingState {
  thinkingActive: boolean;
  thinkingContent: string;
  thinkingStart: number;
}

export function handleTurnLoopEnd(lifecycle: TurnLifecycle): void {
  lifecycle.activeToolIds.clear();
  lifecycle.setSpinnerHasActiveTools(false);
}

export function finalizeTurnLifecycle(
  lifecycle: TurnLifecycle,
  thinking: TurnThinkingState,
): Pick<TurnThinkingState, 'thinkingActive' | 'thinkingContent'> {
  handleTurnLoopEnd(lifecycle);
  if (thinking.thinkingActive || thinking.thinkingContent) {
    const elapsed = Math.floor((lifecycle.now() - thinking.thinkingStart) / 1000);
    lifecycle.emitThinkingEnd(elapsed);
  }
  lifecycle.stopSpinner();
  return { thinkingActive: false, thinkingContent: '' };
}
