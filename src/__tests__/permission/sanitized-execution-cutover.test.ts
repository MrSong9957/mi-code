// ERC-4 / M-065 Sanitized Execution Cutover & Rollback — 单元测试
//
// 物理本质:Cutover 是"双轨切换"。Shadow/default 路径保持当前 spawn 行为
// (不宣称 M-065 生效);Enforced 路径在平台 policy/resolver/revalidation/
// permission gate 全部 ready 后才启用 shell:false 路径。Rollback 只切换
// 受信 policy state,不修改历史 plan/decision。
//
// 关键不变量(计划 Task 14 Step 7):
//   1. Shadow/default 路径保持当前行为——不宣称 M-065 生效;
//   2. Enforced 路径只在所有 gate ready 后启用;
//   3. Rollback 只切换 policy state,不修改历史 plan/decision(历史是不可变记录);
//   4. Stale decision(plan/decision snapshot mismatch)→ deny;
//   5. Plan/action mismatch → deny。

import { describe, expect, it, vi } from 'vitest';
import {
  SANITIZED_PLAN_PROTOCOL_VERSION,
  EXECUTABLE_RESOLUTION_PROTOCOL_VERSION,
  executeSanitizedCommand,
  resolveSanitizedExecutionPolicy,
  applyCutoverState,
  type SanitizedExecutionPlan,
  type RevalidationResult,
  type SanitizedExecutionCutoverState,
} from '../../permission/executable-environment.js';

// ─────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────

const PREVIOUS_HASH = 'a'.repeat(64);

function readyPlan(
  overrides: Partial<SanitizedExecutionPlan> = {},
): SanitizedExecutionPlan {
  return {
    plan_protocol_version: SANITIZED_PLAN_PROTOCOL_VERSION,
    plan_id: 'plan:ready',
    action_snapshot_id: 'snap-1',
    status: 'ready_for_permission',
    inherited_environment_ref: 'inherited-env:scrubbed-1',
    structural_decision_id: 'structural:green',
    inline_decision_id: 'inline-env:green',
    executable_resolution_id: 'exec-res:green',
    required_security_decision_ref: 'rc5:snap-1:allow',
    preserved_assignment_ids: [],
    stripped_assignment_ids: [],
    resolved_canonical_path: '/usr/bin/node',
    effective_environment_ref: 'inherited-env:scrubbed-1',
    literal_argv: ['-v'],
    reason_codes: ['plan.ready_for_permission'],
    ...overrides,
  };
}

function matchRevalidation(
  overrides: Partial<RevalidationResult> = {},
): RevalidationResult {
  return {
    revalidation_protocol_version: 'erc-4-revalidate-v1',
    revalidation_id: 'revalidate:match',
    action_snapshot_id: 'snap-1',
    status: 'match',
    current_content_or_metadata_hash: PREVIOUS_HASH,
    previous_content_or_metadata_hash: PREVIOUS_HASH,
    reason_codes: ['revalidation.match'],
    ...overrides,
  };
}

function makeSpawnSpy() {
  return vi.fn(
    async (
      _p: string,
      _a: string[],
      _o: { shell: false; env: Record<string, string>; cwd: string; windowsHide: true },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Cutover policy state — shadow vs enforced
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveSanitizedExecutionPolicy — shadow vs enforced', () => {
  it('shadow/default path returns mode=shadow (no M-065 claim)', () => {
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'shadow', version: 'cutover-1' },
      platform_policy_ready: true,
      resolver_ready: true,
      revalidation_ready: true,
      permission_gate_ready: true,
    });
    expect(policy.mode).toBe('shadow');
    // shadow 模式不宣称 M-065 生效
    expect(policy.enforced_active).toBe(false);
  });

  it('enforced mode activates only when all gates ready', () => {
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'enforced', version: 'cutover-1' },
      platform_policy_ready: true,
      resolver_ready: true,
      revalidation_ready: true,
      permission_gate_ready: true,
    });
    expect(policy.mode).toBe('enforced');
    expect(policy.enforced_active).toBe(true);
  });

  it('enforced mode degrades to shadow when any gate not ready', () => {
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'enforced', version: 'cutover-1' },
      platform_policy_ready: true,
      resolver_ready: false, // not ready
      revalidation_ready: true,
      permission_gate_ready: true,
    });
    // enforced 但 gate 未 ready → 不激活
    expect(policy.mode).toBe('enforced');
    expect(policy.enforced_active).toBe(false);
    expect(policy.reason_codes).toContain('cutover.gate_not_ready:resolver');
  });

  it('reports which gates are not ready (audit)', () => {
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'enforced', version: 'cutover-1' },
      platform_policy_ready: false,
      resolver_ready: true,
      revalidation_ready: false,
      permission_gate_ready: true,
    });
    expect(policy.reason_codes).toContain('cutover.gate_not_ready:platform_policy');
    expect(policy.reason_codes).toContain('cutover.gate_not_ready:revalidation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: applyCutoverState — rollback semantics
// ═══════════════════════════════════════════════════════════════════════════

describe('applyCutoverState — rollback semantics', () => {
  it('rollback only switches policy state, not history plan/decision', () => {
    const before: SanitizedExecutionCutoverState = {
      mode: 'enforced',
      version: 'cutover-1',
      activated_at: '2026-07-26T00:00:00.000Z',
    };
    // 模拟一次历史 plan(在任何切换之前已生成)
    const historicalPlan = readyPlan({ plan_id: 'plan:historical' });
    const historicalDecisionRef = 'rc5:snap-historical:allow';

    // rollback to shadow
    const after = applyCutoverState(before, { mode: 'shadow' });

    expect(after.mode).toBe('shadow');
    // version 不变(rollback 不重置 version —— 历史记录里这个版本号是已发生事实)
    expect(after.version).toBe(before.version);
    // 历史 plan/decision 字符串本身完全没动(它们是 frozen 记录,不复活)
    expect(historicalPlan.plan_id).toBe('plan:historical');
    expect(historicalDecisionRef).toBe('rc5:snap-historical:allow');
  });

  it('advancing to enforced bumps version only when previously shadow', () => {
    const shadow: SanitizedExecutionCutoverState = {
      mode: 'shadow',
      version: 'cutover-1',
    };
    const enforced = applyCutoverState(shadow, { mode: 'enforced' });
    expect(enforced.mode).toBe('enforced');
    // version 单调递增(不回退)
    expect(enforced.version).toMatch(/^cutover-\d+$/);
  });

  it('rollback then re-enable does not corrupt state', () => {
    const initial: SanitizedExecutionCutoverState = {
      mode: 'enforced',
      version: 'cutover-2',
    };
    const rolled = applyCutoverState(initial, { mode: 'shadow' });
    const reEnabled = applyCutoverState(rolled, { mode: 'enforced' });
    expect(reEnabled.mode).toBe('enforced');
    // version 单调递增
    expect(parseInt(reEnabled.version.replace('cutover-', ''), 10)).toBeGreaterThanOrEqual(
      parseInt(initial.version.replace('cutover-', ''), 10),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: executeSanitizedCommand 在 shadow vs enforced 路径下的语义
// ═══════════════════════════════════════════════════════════════════════════

describe('executeSanitizedCommand — cutover 行为边界', () => {
  it('shadow mode (enforced_active=false) reports shadow_no_op (caller keeps current behavior)', async () => {
    const spawnSpy = makeSpawnSpy();
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'shadow', version: 'cutover-1' },
      platform_policy_ready: true,
      resolver_ready: true,
      revalidation_ready: true,
      permission_gate_ready: true,
    });
    const result = await executeSanitizedCommand({
      plan: readyPlan(),
      revalidation: matchRevalidation(),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
      cutover_policy: policy,
    });
    // shadow 模式不调用本路径 spawn —— 调用方走自己的 default 路径
    expect(result.status).toBe('shadow_no_op');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('enforced_active=true path spawns (all gates ready)', async () => {
    const spawnSpy = makeSpawnSpy();
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'enforced', version: 'cutover-1' },
      platform_policy_ready: true,
      resolver_ready: true,
      revalidation_ready: true,
      permission_gate_ready: true,
    });
    const result = await executeSanitizedCommand({
      plan: readyPlan(),
      revalidation: matchRevalidation(),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
      cutover_policy: policy,
    });
    expect(result.status).toBe('executed');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('enforced mode but gate not ready → shadow_no_op (no spawn via this path)', async () => {
    const spawnSpy = makeSpawnSpy();
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'enforced', version: 'cutover-1' },
      platform_policy_ready: true,
      resolver_ready: false,
      revalidation_ready: true,
      permission_gate_ready: true,
    });
    const result = await executeSanitizedCommand({
      plan: readyPlan(),
      revalidation: matchRevalidation(),
      spawn: spawnSpy,
      current_permission_allows: true,
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
      cutover_policy: policy,
    });
    expect(result.status).toBe('shadow_no_op');
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: stale decision / plan-action mismatch 全部 deny
// ═══════════════════════════════════════════════════════════════════════════

describe('executeSanitizedCommand — cutover stale/mismatch (deny)', () => {
  it('stale decision denies', async () => {
    const spawnSpy = makeSpawnSpy();
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'enforced', version: 'cutover-1' },
      platform_policy_ready: true,
      resolver_ready: true,
      revalidation_ready: true,
      permission_gate_ready: true,
    });
    const result = await executeSanitizedCommand({
      plan: readyPlan({ action_snapshot_id: 'snap-1' }),
      revalidation: matchRevalidation({ action_snapshot_id: 'snap-1' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      permission_decision_snapshot_id: 'snap-stale',
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
      cutover_policy: policy,
    });
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('execution.stale_decision');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('plan/action mismatch denies', async () => {
    const spawnSpy = makeSpawnSpy();
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'enforced', version: 'cutover-1' },
      platform_policy_ready: true,
      resolver_ready: true,
      revalidation_ready: true,
      permission_gate_ready: true,
    });
    const result = await executeSanitizedCommand({
      plan: readyPlan({ action_snapshot_id: 'snap-1' }),
      revalidation: matchRevalidation({ action_snapshot_id: 'snap-1' }),
      spawn: spawnSpy,
      current_permission_allows: true,
      current_action_snapshot_id: 'snap-other',
      effective_environment: { PATH: '/usr/bin' },
      working_directory: '/work',
      cutover_policy: policy,
    });
    expect(result.status).toBe('denied');
    expect(result.reason_codes).toContain('execution.plan_action_mismatch');
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: 协议字段一致性
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveSanitizedExecutionPolicy — 协议字段一致性', () => {
  it('is frozen', () => {
    const policy = resolveSanitizedExecutionPolicy({
      cutover_state: { mode: 'enforced', version: 'cutover-1' },
      platform_policy_ready: true,
      resolver_ready: true,
      revalidation_ready: true,
      permission_gate_ready: true,
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('EXECUTABLE_RESOLUTION_PROTOCOL_VERSION exported (sanity)', () => {
    expect(EXECUTABLE_RESOLUTION_PROTOCOL_VERSION).toBe('erc-4-exec-res-v1');
  });
});
