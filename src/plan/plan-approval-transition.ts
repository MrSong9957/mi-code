export type PlanApprovalMode = 'auto' | 'build';

export interface PlanApprovalTransitionDeps {
  clearPipeline: () => void;
  clearSessionMessages: () => void;
  rotateSessionId: () => void;
  resetContextUsage: () => void;
  setPermissionMode: (mode: PlanApprovalMode) => void;
  setConfigMode: (mode: PlanApprovalMode) => void;
  setStatusMode: (mode: PlanApprovalMode) => void;
  /** 触发终端清屏信号(仅在 clearContext=true 时调用,通知 ConnectedApp 清屏+重挂载) */
  triggerClearScreen: () => void;
}

export function applyPlanApproval(
  mode: PlanApprovalMode,
  clearContext: boolean,
  deps: PlanApprovalTransitionDeps,
): void {
  if (clearContext) {
    deps.clearPipeline();
    deps.triggerClearScreen();   // 清屏信号(在 clearPipeline 之后,确保重挂载时 messages 已空)
    deps.clearSessionMessages();
    deps.rotateSessionId();
    deps.resetContextUsage();
  }
  deps.setPermissionMode(mode);
  deps.setConfigMode(mode);
  deps.setStatusMode(mode);
}
