export type PlanApprovalMode = 'auto' | 'build';

export interface PlanApprovalTransitionDeps {
  clearPipeline: () => void;
  clearSessionMessages: () => void;
  rotateSessionId: () => void;
  resetContextUsage: () => void;
  setPermissionMode: (mode: PlanApprovalMode) => void;
  setConfigMode: (mode: PlanApprovalMode) => void;
  setStatusMode: (mode: PlanApprovalMode) => void;
}

export function applyPlanApproval(
  mode: PlanApprovalMode,
  clearContext: boolean,
  deps: PlanApprovalTransitionDeps,
): void {
  if (clearContext) {
    deps.clearPipeline();
    deps.clearSessionMessages();
    deps.rotateSessionId();
    deps.resetContextUsage();
  }
  deps.setPermissionMode(mode);
  deps.setConfigMode(mode);
  deps.setStatusMode(mode);
}
