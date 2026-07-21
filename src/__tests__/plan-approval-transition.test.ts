import { describe, expect, it, vi } from 'vitest';
import { applyPlanApproval, type PlanApprovalTransitionDeps } from '../plan/plan-approval-transition.js';

function makeDeps(calls: string[]): PlanApprovalTransitionDeps {
  return {
    clearPipeline: vi.fn(() => calls.push('pipeline')),
    triggerClearScreen: vi.fn(() => calls.push('clearscreen')),
    clearSessionMessages: vi.fn(() => calls.push('messages')),
    rotateSessionId: vi.fn(() => calls.push('session')),
    resetContextUsage: vi.fn(() => calls.push('usage')),
    setPermissionMode: vi.fn((mode) => calls.push(`permission:${mode}`)),
    setConfigMode: vi.fn((mode) => calls.push(`config:${mode}`)),
    setStatusMode: vi.fn((mode) => calls.push(`status:${mode}`)),
  };
}

describe('applyPlanApproval', () => {
  it('auto+clear: clears pipeline, triggers clear screen, then clears session messages', () => {
    const deps = makeDeps([]);
    applyPlanApproval('auto', true, deps);

    expect(deps.clearPipeline).toHaveBeenCalledTimes(1);
    expect(deps.triggerClearScreen).toHaveBeenCalledTimes(1);
    expect(deps.clearSessionMessages).toHaveBeenCalledTimes(1);
    expect(deps.rotateSessionId).toHaveBeenCalledTimes(1);
    expect(deps.resetContextUsage).toHaveBeenCalledTimes(1);
    // 模式切换
    expect(deps.setPermissionMode).toHaveBeenCalledWith('auto');
  });

  it('auto+clear: 触发完整顺序(pipeline → clearscreen → messages → session → usage → 3 modes)', () => {
    const calls: string[] = [];

    applyPlanApproval('auto', true, makeDeps(calls));

    expect(calls).toEqual([
      'pipeline',
      'clearscreen',
      'messages',
      'session',
      'usage',
      'permission:auto',
      'config:auto',
      'status:auto',
    ]);
  });

  it('auto+clear: triggerClearScreen fires after clearPipeline (empty remount)', () => {
    const order: string[] = [];
    const deps: PlanApprovalTransitionDeps = {
      clearPipeline: () => order.push('clearPipeline'),
      triggerClearScreen: () => order.push('triggerClearScreen'),
      clearSessionMessages: () => {},
      rotateSessionId: () => {},
      resetContextUsage: () => {},
      setPermissionMode: () => {},
      setConfigMode: () => {},
      setStatusMode: () => {},
    };
    applyPlanApproval('auto', true, deps);
    const cpIdx = order.indexOf('clearPipeline');
    const csIdx = order.indexOf('triggerClearScreen');
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(csIdx).toBeGreaterThan(cpIdx);  // clearScreen 在 clearPipeline 之后
  });

  it.each(['auto', 'build'] as const)('changes all modes to %s without clearing context', (mode) => {
    const calls: string[] = [];

    applyPlanApproval(mode, false, makeDeps(calls));

    expect(calls).toEqual([
      `permission:${mode}`,
      `config:${mode}`,
      `status:${mode}`,
    ]);
  });

  it('auto+keep: does NOT trigger clear screen', () => {
    const deps = makeDeps([]);
    applyPlanApproval('auto', false, deps);
    expect(deps.triggerClearScreen).not.toHaveBeenCalled();
    expect(deps.clearPipeline).not.toHaveBeenCalled();
    expect(deps.setPermissionMode).toHaveBeenCalledWith('auto');
  });

  it('build+keep: does NOT trigger clear screen', () => {
    const deps = makeDeps([]);
    applyPlanApproval('build', false, deps);
    expect(deps.triggerClearScreen).not.toHaveBeenCalled();
    expect(deps.setPermissionMode).toHaveBeenCalledWith('build');
  });
});
