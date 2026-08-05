// Task 7 fix: resolveInteractiveAsk 生产路径接线验收
//
// 证明 main-origin ask 经真实 resolver 链调用 resolveInteractiveAsk，
// dialog ESC 使 classifier signal aborted，且 Stage 2 / gate / executor 不执行。
import { describe, test, expect, vi } from 'vitest';
import { DefaultPermissionAskResolver } from '../../permission/ask-resolver.js';
import type { SecurityDecision } from '../../permission/decisions.js';
import type { ClassifierDecision } from '../../permission/classifier.js';
import type { DialogResult } from '../../permission/interactive-ask.js';

function makeDecision(behavior: 'allow' | 'ask' | 'deny', rc = 'permission.user_confirmation_required'): SecurityDecision {
  return { protocol_version: '1', decision_id: 'd1', action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 's1' }, behavior, deciding_layer: 'permission', risk_kind: 'test', policy_id: 'p', policy_version: '1', reason_code: rc, human_reason: 'test', provenance_refs: behavior === 'allow' ? ['t'] : [] } as SecurityDecision;
}

describe('resolveInteractiveAsk production wiring', () => {
  test('main-origin ask: dialog ESC aborts classifier signal; no Stage 2 / gate / executor', async () => {
    // classifier pending on Stage 1（deferred，永不主动 resolve —— 只靠 ESC abort）
    const classifierCalls: Array<{ signal: AbortSignal }> = [];
    const classify = vi.fn((_input: unknown, signal: AbortSignal) => {
      classifierCalls.push({ signal });
      return new Promise<ClassifierDecision>((_resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });

    // dialog 返回 ESC（delay=0，立即触发）
    const dialog = vi.fn().mockResolvedValue({ kind: 'escape' } as DialogResult);

    const resolver = new DefaultPermissionAskResolver({
      classifier: { classify },
      evaluateWithMode: vi.fn().mockResolvedValue(makeDecision('ask')),
      hooks: [],
      denialState: { consecutive: 0, total: 0 },
      // dialog provider + delay（main-origin 经 resolveInteractiveAsk）
      dialogProvider: dialog,
      dialogDelayMs: 0,
    });

    const result = await resolver.resolve({
      decision: makeDecision('ask'),
      executableToolCall: { callId: 'call-a', canonicalToolName: 'write_file', input: { path: 'a.ts' } },
      messages: [{ role: 'user', content: 'do it', authoredByUser: true }],
      origin: 'main',
      permissionContext: null,
    });

    // ESC 使 classifier signal aborted
    expect(classifierCalls).toHaveLength(1);
    expect(classifierCalls[0].signal.aborted).toBe(true);
    // 最终 deny（ESC -> abort -> classifier fail -> deny）
    expect(result.behavior).toBe('deny');
    // dialog 被调用（经 resolveInteractiveAsk）
    expect(dialog).toHaveBeenCalledOnce();
  });

  test('main-origin ask: automatic allow before dialog -> no dialog', async () => {
    const classify = vi.fn().mockResolvedValue({ behavior: 'allow', reason_code: 'permission.classifier_stage1_allow' } as ClassifierDecision);
    const dialog = vi.fn();

    const resolver = new DefaultPermissionAskResolver({
      classifier: { classify },
      evaluateWithMode: vi.fn().mockResolvedValue(makeDecision('ask')),
      hooks: [],
      denialState: { consecutive: 0, total: 0 },
      dialogProvider: dialog,
      dialogDelayMs: 5000, // 大 delay，automatic 先完成
    });

    const result = await resolver.resolve({
      decision: makeDecision('ask'),
      executableToolCall: { callId: 'call-a', canonicalToolName: 'write_file', input: { path: 'a.ts' } },
      messages: [{ role: 'user', content: 'do', authoredByUser: true }],
      origin: 'main',
      permissionContext: null,
    });

    expect(result.behavior).toBe('allow');
    expect(dialog).not.toHaveBeenCalled();
  });

  test('subagent-origin ask: no dialog (headless path)', async () => {
    const classify = vi.fn().mockResolvedValue({ behavior: 'deny', reason_code: 'x' } as ClassifierDecision);
    const dialog = vi.fn();

    const resolver = new DefaultPermissionAskResolver({
      classifier: { classify },
      evaluateWithMode: vi.fn().mockResolvedValue(makeDecision('ask')),
      hooks: [],
      denialState: { consecutive: 0, total: 0 },
      dialogProvider: dialog,
      dialogDelayMs: 0,
    });

    const result = await resolver.resolve({
      decision: makeDecision('ask'),
      executableToolCall: { callId: 'call-a', canonicalToolName: 'write_file', input: { path: 'a.ts' } },
      messages: [{ role: 'user', content: 'do', authoredByUser: true }],
      origin: 'subagent',
      permissionContext: null,
    });

    expect(result.behavior).toBe('deny');
    // subagent 不走 dialog（headless）
    expect(dialog).not.toHaveBeenCalled();
  });
});
