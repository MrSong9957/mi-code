/**
 * Wave C Task 10 (M-067 / CRC-5): Delegation Least-Privilege Gate — 测试.
 *
 * 覆盖规格 §11.2/§11.3:
 *   - 权限不扩张(scope/tools/mode 任一扩张 → 非 allowed_once)
 *   - local + read-only + same scope → 可 allowed_once
 *   - cross-machine / unknown provenance / side-effect → awaiting_user 或 denied
 *   - ask channel unavailable → denied (no_channel)
 *   - decision 绑定 action snapshot, 只消费一次
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateDelegationGate,
  DELEGATION_PROTOCOL_VERSION,
  type DelegationRequest,
  type DelegationGateDependencies,
} from '../../permission/delegation.js';

/** 构造一个最小合法的 DelegationRequest, 测试用覆盖个别字段 */
function makeBaseRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    delegation_protocol_version: DELEGATION_PROTOCOL_VERSION,
    delegation_id: 'del-1',
    parent_session_id: 'sess-parent-1',
    parent_turn_id: 'turn-1',
    parent_action_snapshot_id: 'snap-parent-1',
    role_profile_snapshot_id: 'role-1',
    task_scope_ref: 'scope-file',
    requested_tool_ids: ['read_file'],
    requested_control_mode: 'plan',
    context_source_refs: ['ctx-1'],
    permission_snapshot_id: 'perm-1',
    action_provenance_ref: 'prov-1',
    ...overrides,
  };
}

/** 构造一组允许 local read-only delegation 的依赖 */
function makeAllowingDeps(
  overrides: Partial<DelegationGateDependencies> = {},
): DelegationGateDependencies {
  return {
    parent_scope: 'scope-file',
    parent_tool_ids: ['read_file', 'write_file', 'run_bash'],
    parent_control_mode: 'build',
    action_provenance: {
      origin_scope: 'local' as const,
      origin_ref: 'local-machine',
      propagation_refs: [],
      content_trust: 'trusted' as const,
    },
    isToolSideEffect: () => false,
    securityDecisionRef: 'dec-allow-1',
    // 默认无 ask channel → ask 会降级为 denied (no_channel)
    ...overrides,
  };
}

describe('DelegationGate — 权限不扩张 (INV-C10)', () => {
  it.each([
    [
      'scope',
      { requested: { task_scope_ref: 'scope-workspace' }, parent: { parent_scope: 'scope-file' } },
    ],
    [
      'tools',
      {
        requested: { requested_tool_ids: ['write_file'] },
        parent: { parent_tool_ids: ['read_file'] },
      },
    ],
    [
      'mode',
      { requested: { requested_control_mode: 'build' }, parent: { parent_control_mode: 'plan' } },
    ],
  ] as const)(
    'never auto-allows %s expansion',
    async (_name, { requested, parent }) => {
      const request = makeBaseRequest(requested);
      const deps = makeAllowingDeps(parent);
      const decision = await evaluateDelegationGate(request, deps);
      expect(decision.status).not.toBe('allowed_once');
    },
  );

  it('denies or asks when requested tool is not in parent tool set', async () => {
    const request = makeBaseRequest({ requested_tool_ids: ['delete_database'] });
    const deps = makeAllowingDeps({ parent_tool_ids: ['read_file'] });
    const decision = await evaluateDelegationGate(request, deps);
    expect(decision.status).not.toBe('allowed_once');
    expect(['awaiting_user', 'denied']).toContain(decision.status);
  });
});

describe('DelegationGate — local read-only same-scope allow_once', () => {
  it('allows once for local, read-only, same-scope delegation', async () => {
    const request = makeBaseRequest({
      requested_tool_ids: ['read_file'],
      task_scope_ref: 'scope-file',
      requested_control_mode: 'plan',
    });
    const deps = makeAllowingDeps({
      parent_scope: 'scope-file',
      parent_tool_ids: ['read_file', 'write_file'],
      parent_control_mode: 'build',
      action_provenance: {
        origin_scope: 'local',
        origin_ref: 'local',
        propagation_refs: [],
        content_trust: 'trusted',
      },
      isToolSideEffect: () => false,
    });
    const decision = await evaluateDelegationGate(request, deps);
    expect(decision.status).toBe('allowed_once');
    expect(decision.security_decision_ref).toBe('dec-allow-1');
  });

  it('does not allow when tool has side effects (even if local+same-scope)', async () => {
    const request = makeBaseRequest({ requested_tool_ids: ['write_file'] });
    const deps = makeAllowingDeps({
      parent_tool_ids: ['read_file', 'write_file'],
      isToolSideEffect: (toolId) => toolId === 'write_file',
    });
    const decision = await evaluateDelegationGate(request, deps);
    expect(decision.status).not.toBe('allowed_once');
  });
});

describe('DelegationGate — cross-machine / unknown provenance', () => {
  it('does not auto-allow cross-machine delegation', async () => {
    const request = makeBaseRequest();
    const deps = makeAllowingDeps({
      action_provenance: {
        origin_scope: 'cross_machine',
        origin_ref: 'remote-host',
        propagation_refs: [],
        content_trust: 'untrusted',
      },
    });
    const decision = await evaluateDelegationGate(request, deps);
    expect(decision.status).not.toBe('allowed_once');
  });

  it('does not auto-allow unknown provenance', async () => {
    const request = makeBaseRequest();
    const deps = makeAllowingDeps({
      action_provenance: {
        origin_scope: 'unknown',
        origin_ref: 'unknown',
        propagation_refs: [],
        content_trust: 'unknown',
      },
    });
    const decision = await evaluateDelegationGate(request, deps);
    expect(decision.status).not.toBe('allowed_once');
  });
});

describe('DelegationGate — ask channel handling', () => {
  it('denies (no_channel) when ask is needed but no channel provided', async () => {
    // side-effect tool → needs ask; deps 无 askChannel → denied
    const request = makeBaseRequest({ requested_tool_ids: ['write_file'] });
    const deps = makeAllowingDeps({
      parent_tool_ids: ['read_file', 'write_file'],
      isToolSideEffect: () => true,
      // 不提供 askChannel
    });
    const decision = await evaluateDelegationGate(request, deps);
    expect(decision.status).toBe('denied');
    expect(decision.reason_codes).toContain('ask.no_channel');
  });

  it('awaits user when ask is needed and channel is provided', async () => {
    const request = makeBaseRequest({ requested_tool_ids: ['write_file'] });
    const deps = makeAllowingDeps({
      parent_tool_ids: ['read_file', 'write_file'],
      isToolSideEffect: () => true,
      askChannel: {
        request: async () => ({
          protocol_version: '1',
          decision_id: 'dec-ask-1',
          response: 'approved_once' as const,
          decided_at: new Date().toISOString(),
        }),
      },
      pendingStore: {
        save: async () => {},
        load: async () => [],
        update: async () => {},
      },
      sessionId: 'sess-test-1',
      securityDecisionRef: 'dec-ask-1',
    });
    const decision = await evaluateDelegationGate(request, deps);
    expect(decision.status).toBe('allowed_once');
  });
});

describe('DelegationGate — decision identity & determinism', () => {
  it('produces stable decision for same input', async () => {
    const request = makeBaseRequest();
    const deps = makeAllowingDeps();
    const d1 = await evaluateDelegationGate(request, deps);
    const d2 = await evaluateDelegationGate(request, deps);
    expect(d1.status).toBe(d2.status);
    expect(d1.security_decision_ref).toBe(d2.security_decision_ref);
  });

  it('result is frozen (immutable)', async () => {
    const request = makeBaseRequest();
    const deps = makeAllowingDeps();
    const decision = await evaluateDelegationGate(request, deps);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.reason_codes)).toBe(true);
  });
});
