import { describe, expect, it, vi } from 'vitest';
import { applyPlanApproval, type PlanApprovalTransitionDeps } from '../plan/plan-approval-transition.js';

function makeDeps(calls: string[]): PlanApprovalTransitionDeps {
  return {
    clearPipeline: vi.fn(() => calls.push('pipeline')),
    clearSessionMessages: vi.fn(() => calls.push('messages')),
    rotateSessionId: vi.fn(() => calls.push('session')),
    resetContextUsage: vi.fn(() => calls.push('usage')),
    setPermissionMode: vi.fn((mode) => calls.push(`permission:${mode}`)),
    setConfigMode: vi.fn((mode) => calls.push(`config:${mode}`)),
    setStatusMode: vi.fn((mode) => calls.push(`status:${mode}`)),
  };
}

describe('applyPlanApproval', () => {
  it('clears all context state before changing the three modes', () => {
    const calls: string[] = [];

    applyPlanApproval('auto', true, makeDeps(calls));

    expect(calls).toEqual([
      'pipeline',
      'messages',
      'session',
      'usage',
      'permission:auto',
      'config:auto',
      'status:auto',
    ]);
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
});
