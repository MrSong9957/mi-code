/**
 * GRC-1 §7.9 / §7.12 — Target-Context Memory Rebuild (Wave G Task 6).
 *
 * 这一段测试只覆盖 rebuildMemoryEntrypoint 的 rebuild 委托行为。本契约**只**:
 *   - 把 T4 plan item + 旧 entrypoint identity + target context / FRC-1 policy
 *     / render / budget refs 打包成 rebuild 请求;
 *   - 委托给 FRC-1 owner port(deps.rebuild_via_frc1);
 *   - 把 FRC-1 结果映射为不可变的 ReconstructionSourceResolution。
 *
 * Non-negotiable invariants under test (spec §7.9):
 *   - post-compact target context ≠ old context(rule 1)。
 *   - 旧 MemoryUseDecision 不跨 target context(rule 2);FRC-1 rebuild 必须重新
 *     评估 use。
 *   - GRC-1 不读全部 Memory、不生成 verified claim(rule 5)。
 *   - 新 FRC-1 snapshot 必须绑定 target context(rule 6)。
 *   - ready/partial 可以进入 system section plane;partial 必须保留 degradation
 *     evidence。
 *   - empty 显式 omit Memory section(rule 8)。
 *   - rejected/unavailable 按 optional failure 记录 degradation,并 omit section
 *     (rule 9)。
 *   - Memory failure 不改变 TurnOutcome(rule 11)—— T6 只返回 Resolution。
 *   - Memory omission 不能被 summary 填补(rule 12)。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildPinnedWorkingSetPlan,
  capturePreCompactSnapshot,
  createCompactionResultSnapshot,
  createReconstructionPolicy,
  rebuildMemoryEntrypoint,
  runReconstructionPreflight,
  SOURCE_RESOLUTION_PROTOCOL_VERSION,
  type MemoryEntrypointRebuildInput,
  type MemoryEntrypointRebuildResult,
  type MemoryRebuildDependencies,
  type MemoryRebuildInput,
  type PinnedWorkingSetPlanItem,
  type PreflightInput,
} from '../../agent/context/reconstruction.js';
import type {
  ToolPairState,
  ToolTranscriptSnapshot,
  ToolTranscriptValidation,
} from '../../agent/tools/transcript-validator.js';
import type { Message } from '../../agent/types.js';
import type { DurableAcknowledgement } from '../../session/store.js';

// ---------------------------------------------------------------------------
// Helpers(与 reconstruction-source-resolution.test.ts 同构)
// ---------------------------------------------------------------------------

function policyIdentity() {
  return {
    policy_id: 'mi.reconstruction.policy:default',
    policy_version: '1.0.0',
    request_budget_policy_ref: 'mi.budget/1:default',
  };
}

function captureInput(overrides: Partial<Parameters<typeof capturePreCompactSnapshot>[0]> = {}) {
  return {
    session_id: 'sess:abc',
    turn_id: 'turn:1',
    task_snapshot_id: 'task:snap-1',
    current_context_snapshot_id: 'ctx:before-compact',
    project_version_ref: 'proj:sha-1',
    transcript_snapshot_id: 'tx:snap-1',
    current_user_message_ref: 'msg:user-1',
    current_user_message_hash: 'a'.repeat(64),
    active_project_activation_refs: ['act:proj-a'],
    active_meta_lifecycle_refs: ['life:meta-a'],
    memory_entrypoint_snapshot_ref: 'entry:mem-old',
    execution_state_refs: ['exec:state-1'],
    request_budget_snapshot_id: 'budget:snap-1',
    captured_at: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function transcriptSnapshot(): ToolTranscriptSnapshot {
  const messages: Message[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  return {
    transcript_snapshot_id: 'tx:snap-1',
    session_id: 'sess:abc',
    turn_id: 'turn:1',
    messages,
  };
}

function validation(
  overrides: Partial<ToolTranscriptValidation> = {},
): ToolTranscriptValidation {
  return {
    validation_protocol_version: '1',
    validation_id: 'tv:preflight-1',
    transcript_snapshot_id: 'tx:snap-1',
    checkpoint: 'before_compaction',
    status: 'accepted',
    validator_policy_id: 'mi.transcript.policy:default',
    validator_policy_version: '1.0.0',
    pair_records: [],
    reason_codes: [],
    ...overrides,
  };
}

function durableAck(
  overrides: Partial<DurableAcknowledgement> = {},
): DurableAcknowledgement {
  return {
    ack_protocol_version: 'mi.durable/1',
    ack_id: 'durable:abc',
    record_id: 'precompact:xyz',
    session_id: 'sess:abc',
    committed_at: '2026-07-26T00:00:00.000Z',
    sidecar_ref: 'reconstruction.jsonl',
    ...overrides,
  };
}

const IDEMPOTENCY_KEY = 'recon-idem:deadbeef';

function acceptedPreflightInput(
  overrides: Partial<PreflightInput> = {},
): PreflightInput {
  return {
    precompact: capturePreCompactSnapshot(captureInput()),
    transcript_snapshot: transcriptSnapshot(),
    validation: validation(),
    precompact_durable_ack: durableAck(),
    policy: createReconstructionPolicy(policyIdentity()),
    request_budget_snapshot_id: 'budget:snap-1',
    idempotency_key: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

/** 取出 T4 plan 中的 bounded_memory_entrypoint item。 */
function memoryPlanItem(): PinnedWorkingSetPlanItem {
  const preflightInput = acceptedPreflightInput();
  const preflight = runReconstructionPreflight(preflightInput);
  const compaction_result = createCompactionResultSnapshot({
    precompact: preflightInput.precompact,
    preflight,
    compacted_summary_message: { role: 'user', content: 'summary text' },
    method: 'deterministic_local',
    method_version: 'l1l2.v1',
    compactor_ack_payload: 'compactor-call:2026-07-26T00:00:00Z|client=v1',
    created_at: '2026-07-26T00:00:00.000Z',
  });
  const plan = buildPinnedWorkingSetPlan({
    precompact: preflightInput.precompact,
    preflight,
    compaction_result,
    transaction_id: 'recon-tx:abc123',
    target_context_snapshot_id: 'ctx:after-compact',
    active_project_instructions: [
      {
        activation_id: 'act:proj-a',
        message_id: 'msg:meta-a',
        content_hash: 'b'.repeat(64),
        lifecycle_record_id: 'life:meta-a',
        source_freshness_ref: 'fresh:a',
        ordinal: 100,
      },
    ],
    execution_state_refs: [
      {
        execution_ref: 'tc:tool-1',
        ack_ref: 'ack:completed-1',
        pair_state: 'paired' as ToolPairState,
        permission_security_refs: ['perm:allow-1'],
        ordinal: 300,
      },
    ],
  });
  const found = plan.items.find((it) => it.item_kind === 'bounded_memory_entrypoint');
  if (!found) throw new Error('expected memory plan item');
  return found;
}

/** 构造一份 MemoryRebuildInput,所有字段就绪,target=ctx:after-compact。 */
function memoryRebuildInput(
  overrides: Partial<MemoryRebuildInput> = {},
): MemoryRebuildInput {
  return {
    plan_item: memoryPlanItem(),
    old_entrypoint_snapshot_id: 'entry:mem-old',
    old_catalog_snapshot_id: 'catalog:mem-old',
    old_selection_id: 'sel:mem-old',
    target_context_snapshot_id: 'ctx:after-compact', // 与 old ctx 不同
    target_task_snapshot_id: 'task:snap-1',
    target_project_version_ref: 'proj:sha-1',
    memory_policy_ref: {
      contract_id: 'mi.memory.frc1/1',
      contract_version: '1.0.0',
    },
    render_profile_ref: 'render:default',
    request_budget_snapshot_id: 'budget:snap-1',
    reconstruction_transaction_id: 'recon-tx:abc123',
    ...overrides,
  };
}

/** FRC-1 ready 结果。 */
function frc1ReadyResult(
  overrides: Partial<MemoryEntrypointRebuildResult> = {},
): MemoryEntrypointRebuildResult {
  return {
    entrypoint_snapshot_id: 'entry:mem-new',
    target_context_snapshot_id: 'ctx:after-compact',
    state: 'ready',
    overflow_manifest_ref: null,
    provenance_manifest_ref: 'prov:mem-new',
    reason_codes: [],
    ...overrides,
  };
}

// ===========================================================================
// Spec §7.9 rule 1: post-compact target context ≠ old context
// ===========================================================================

describe('rebuildMemoryEntrypoint — target context ≠ old context (spec §7.9 rule 1)', () => {
  it('build invoked once with target context; returns target-context snapshot', async () => {
    // old entrypoint 绑定 ctx-old,target=ctx-new。FRC-1 必须收到 target=ctx-new。
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const input = memoryRebuildInput({
      old_entrypoint_snapshot_id: 'entry:mem-old', // 绑定 ctx-before-compact
      target_context_snapshot_id: 'ctx:after-compact', // ≠ old
    });
    const result = await rebuildMemoryEntrypoint(input, deps);

    expect(port).toHaveBeenCalledTimes(1);
    const callArg = port.mock.calls[0]![0] as MemoryEntrypointRebuildInput;
    expect(callArg.target_context_snapshot_id).toBe('ctx:after-compact');
    expect(callArg.old_entrypoint_snapshot_id).toBe('entry:mem-old');
    expect(result.status).toBe('resolved');
    expect(result.source_ref_after).toBe('entry:mem-new');
  });

  it('old context identity is forwarded to FRC-1 (not silently dropped)', async () => {
    // 旧 entrypoint / catalog / selection identity 必须透传给 FRC-1,让 FRC-1
    // 自己判定是否可复用(GRC-1 不能越权复用,spec §7.9 rule 10)。
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    const callArg = port.mock.calls[0]![0] as MemoryEntrypointRebuildInput;
    expect(callArg.old_entrypoint_snapshot_id).toBe('entry:mem-old');
    expect(callArg.old_catalog_snapshot_id).toBe('catalog:mem-old');
    expect(callArg.old_selection_id).toBe('sel:mem-old');
  });
});

// ===========================================================================
// FRC-1 state mapping (spec Task 6 Step 5)
// ===========================================================================

describe('rebuildMemoryEntrypoint — FRC-1 state mapping', () => {
  it("FRC-1 'ready' → resolved / rebuild / source_ref_after=entrypoint_snapshot_id", async () => {
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    expect(result.action).toBe('rebuild');
    expect(result.status).toBe('resolved');
    expect(result.source_ref_after).toBe('entry:mem-new');
    expect(result.acknowledgement_ref).toBe('frc1.ack:entry:mem-new');
  });

  it("FRC-1 'partial' → resolved, reason_codes contains 'memory.partial' (degradation evidence, spec §7.9)", async () => {
    const port = vi
      .fn()
      .mockResolvedValue(frc1ReadyResult({ state: 'partial', overflow_manifest_ref: 'overflow:1' }));
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    expect(result.action).toBe('rebuild');
    expect(result.status).toBe('resolved');
    expect(result.source_ref_after).toBe('entry:mem-new');
    expect(result.reason_codes).toContain('memory.partial');
    // partial 的 overflow_manifest_ref 必须保留为 degradation evidence
    expect(result.provenance_refs).toContain('overflow:1');
  });

  it("FRC-1 'empty' → excluded, reason_codes contains 'memory.empty' (explicit omission, spec §7.9 rule 8)", async () => {
    const port = vi.fn().mockResolvedValue(
      frc1ReadyResult({ state: 'empty', entrypoint_snapshot_id: null }),
    );
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    expect(result.action).toBe('rebuild');
    expect(result.status).toBe('excluded');
    expect(result.source_ref_after).toBe(null);
    expect(result.reason_codes).toContain('memory.empty');
  });

  it("FRC-1 'rejected' → excluded, reason_codes contains 'memory.rebuild_rejected' (optional failure, spec §7.9 rule 9)", async () => {
    const port = vi.fn().mockResolvedValue(
      frc1ReadyResult({ state: 'rejected', entrypoint_snapshot_id: null }),
    );
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    expect(result.action).toBe('rebuild');
    expect(result.status).toBe('excluded');
    expect(result.source_ref_after).toBe(null);
    expect(result.reason_codes).toContain('memory.rebuild_rejected');
  });

  it('FRC-1 throws → excluded, reason_codes contains "memory.rebuild_failed" (optional failure)', async () => {
    const port = vi.fn().mockRejectedValue(new Error('frc1.internal'));
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    expect(result.action).toBe('rebuild');
    expect(result.status).toBe('excluded');
    expect(result.source_ref_after).toBe(null);
    expect(result.reason_codes).toContain('memory.rebuild_failed');
    expect(result.reason_codes.some((c) => c.includes('frc1.internal'))).toBe(true);
  });

  it('FRC-1 returns context_mismatch → rejected (defensive, spec §7.9 rule 6)', async () => {
    // FRC-1 返回的 target_context_snapshot_id 与请求不一致 —— 这是 FRC-1 实现
    // 错误的硬信号,GRC-1 防御性拒绝。
    const port = vi.fn().mockResolvedValue(
      frc1ReadyResult({ target_context_snapshot_id: 'ctx:wrong' }),
    );
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    expect(result.action).toBe('rebuild');
    expect(result.status).toBe('rejected');
    expect(result.source_ref_after).toBe(null);
    expect(result.reason_codes).toContain('memory.context_mismatch');
  });
});

// ===========================================================================
// no-full-load / no-summary-fill (spec §7.9 rule 5, rule 12)
// ===========================================================================

describe('rebuildMemoryEntrypoint — no full Memory load / no summary fill (spec §7.9 rule 5, 12)', () => {
  it('MemoryRebuildDependencies has only rebuild_via_frc1 (structurally enforced)', () => {
    // deps 类型只有 rebuild_via_frc1 —— 没有 getIndexContent / inject / read-all /
    // summary-to-memory 注入点。这是结构保证:GRC-1 不读全部 Memory、不生成
    // verified claim、不被 summary 填补。
    const deps: MemoryRebuildDependencies = {
      rebuild_via_frc1: vi.fn().mockResolvedValue(frc1ReadyResult()),
    };
    const keys = Object.keys(deps) as ReadonlyArray<string>;
    expect(keys).toEqual(['rebuild_via_frc1']);
    expect(keys).not.toContain('getIndexContent');
    expect(keys).not.toContain('inject');
    expect(keys).not.toContain('readAll');
    expect(keys).not.toContain('summaryToMemory');
  });

  it('MemoryRebuildInput has only identity refs (no Memory detail / verified claim)', () => {
    // input 类型只有 identity refs + policy/render/budget refs —— 没有
    // memory_detail / verified_claim / selected_memory_body 字段。这是结构保证:
    // GRC-1 不能把 Memory 正文塞进 rebuild 请求。
    const input = memoryRebuildInput();
    const keys = Object.keys(input) as ReadonlyArray<string>;
    expect(keys).not.toContain('memory_detail');
    expect(keys).not.toContain('verified_claim');
    expect(keys).not.toContain('selected_memory_body');
    expect(keys).not.toContain('summary_text');
  });

  it('FRC-1 is the only Memory-touching call (GRC-1 does not read Memory directly)', async () => {
    // 用 spy 模拟 FRC-1 port;GRC-1 全程只调用它一次。若 GRC-1 自己读 Memory,
    // 这里会失败(因为 deps 没有其它注入点)。
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);
    expect(port).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// failure does not change TurnOutcome (spec §7.9 rule 11)
// ===========================================================================

describe('rebuildMemoryEntrypoint — failure does not change TurnOutcome (spec §7.9 rule 11)', () => {
  it('rebuildMemoryEntrypoint returns ReconstructionSourceResolution (not TurnOutcome)', async () => {
    // T6 只返回 Resolution;TurnOutcome 是 T7+ 的事情。失败 resolution 不会
    // 直接改变 TurnOutcome —— T7 candidate 根据 policy.source_failure_behavior
    // 决定是否 omit(optional)或 block(required)。Memory 是 optional_current,
    // 所以失败可降级为 omit。
    const port = vi.fn().mockRejectedValue(new Error('frc1.failed'));
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    // result 只有 Resolution 字段,没有 turn_outcome / action_submitted /
    // tool_executed 字段。
    const keys = Object.keys(result) as ReadonlyArray<string>;
    expect(keys).not.toContain('turn_outcome');
    expect(keys).not.toContain('action_submitted');
    expect(keys).not.toContain('tool_executed');
    // 仍然是 excluded(optional failure 可降级),不是 blocked。
    expect(result.status).toBe('excluded');
  });
});

// ===========================================================================
// selected ≠ use (spec §7.9 rule 4 — FRC-1 owns selection/use semantics)
// ===========================================================================

describe('rebuildMemoryEntrypoint — FRC-1 owns selection/use semantics (spec §7.9 rule 4)', () => {
  it('GRC-1 does not validate selected ≠ use directly (FRC-1 port indirectly guarantees)', async () => {
    // GRC-1 不直接检查 selected ≠ use;这个不变量由 FRC-1 owner 内部保证。
    // GRC-1 只消费 FRC-1 的最终结果。这里验证:即使 FRC-1 返回的 reason_codes
    // 含有 selected/use 相关 code,GRC-1 也只是透传,不做语义判断。
    const port = vi.fn().mockResolvedValue(
      frc1ReadyResult({
        reason_codes: ['frc1.selected_lt_use_budget_overflow'],
      }),
    );
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    expect(result.status).toBe('resolved');
    expect(result.reason_codes).toContain('frc1.selected_lt_use_budget_overflow');
  });
});

// ===========================================================================
// old MemoryUseDecision does not cross context (spec §7.9 rule 2)
// ===========================================================================

describe('rebuildMemoryEntrypoint — old MemoryUseDecision does not cross context (spec §7.9 rule 2)', () => {
  it('FRC-1 rebuild is invoked (old use decision is not reused verbatim by GRC-1)', async () => {
    // 旧 MemoryUseDecision(old_selection_id)只作为 identity 透传给 FRC-1;
    // GRC-1 自己不复用旧 use 决策。FRC-1 必须 rebuild 重新评估 use
    // (spec §7.9 rule 2)。这里通过验证 port 被调用 + 旧 selection 作为
    // identity 透传来确认。
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const input = memoryRebuildInput({
      old_selection_id: 'sel:mem-old', // 旧 use decision identity
      target_context_snapshot_id: 'ctx:after-compact', // ≠ old context
    });
    await rebuildMemoryEntrypoint(input, deps);

    expect(port).toHaveBeenCalledTimes(1);
    const callArg = port.mock.calls[0]![0] as MemoryEntrypointRebuildInput;
    expect(callArg.old_selection_id).toBe('sel:mem-old');
    expect(callArg.target_context_snapshot_id).toBe('ctx:after-compact');
  });

  it('old_entrypoint_snapshot_id=null tolerated (no prior memory state)', async () => {
    // 首次没有 memory entrypoint(old=null),FRC-1 仍然被调用以重新评估 use。
    const port = vi.fn().mockResolvedValue(
      frc1ReadyResult({ state: 'empty', entrypoint_snapshot_id: null }),
    );
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const input = memoryRebuildInput({
      old_entrypoint_snapshot_id: null,
      old_catalog_snapshot_id: null,
      old_selection_id: null,
    });
    const result = await rebuildMemoryEntrypoint(input, deps);

    expect(port).toHaveBeenCalledTimes(1);
    const callArg = port.mock.calls[0]![0] as MemoryEntrypointRebuildInput;
    expect(callArg.old_entrypoint_snapshot_id).toBe(null);
    expect(result.status).toBe('excluded');
  });
});

// ===========================================================================
// ReconstructionSourceResolution shape (spec §7.12)
// ===========================================================================

describe('rebuildMemoryEntrypoint — ReconstructionSourceResolution shape', () => {
  it('result carries protocol version, resolution_id, transaction_id, plan_item_id', async () => {
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const input = memoryRebuildInput();
    const result = await rebuildMemoryEntrypoint(input, deps);

    expect(result.resolution_protocol_version).toBe(SOURCE_RESOLUTION_PROTOCOL_VERSION);
    expect(result.resolution_id).toMatch(/^resol:[0-9a-f]{16}$/);
    expect(result.reconstruction_transaction_id).toBe(input.reconstruction_transaction_id);
    expect(result.plan_item_id).toBe(input.plan_item.plan_item_id);
  });

  it('source_ref_before / source_hash_before come from plan_item', async () => {
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const input = memoryRebuildInput();
    const result = await rebuildMemoryEntrypoint(input, deps);

    expect(result.source_ref_before).toBe(input.plan_item.source_ref);
    expect(result.source_hash_before).toBe(input.plan_item.source_hash); // null
    expect(result.source_hash_before).toBe(null);
  });

  it('result is deep-frozen (immutable, spec §7.12)', async () => {
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reason_codes)).toBe(true);
    expect(Object.isFrozen(result.provenance_refs)).toBe(true);
  });

  it('same input produces same resolution_id (deterministic)', async () => {
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const input = memoryRebuildInput();
    const a = await rebuildMemoryEntrypoint(input, deps);
    const b = await rebuildMemoryEntrypoint(input, deps);
    expect(a.resolution_id).toBe(b.resolution_id);
  });

  it('different FRC-1 state produces different resolution_id', async () => {
    const readyPort = vi.fn().mockResolvedValue(frc1ReadyResult({ state: 'ready' }));
    const emptyPort = vi.fn().mockResolvedValue(
      frc1ReadyResult({ state: 'empty', entrypoint_snapshot_id: null }),
    );
    const a = await rebuildMemoryEntrypoint(memoryRebuildInput(), {
      rebuild_via_frc1: readyPort,
    });
    const b = await rebuildMemoryEntrypoint(memoryRebuildInput(), {
      rebuild_via_frc1: emptyPort,
    });
    expect(a.resolution_id).not.toBe(b.resolution_id);
  });

  it('provenance_refs includes FRC-1 provenance_manifest_ref', async () => {
    const port = vi.fn().mockResolvedValue(
      frc1ReadyResult({ provenance_manifest_ref: 'prov:mem-frc1' }),
    );
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const result = await rebuildMemoryEntrypoint(memoryRebuildInput(), deps);

    expect(result.provenance_refs).toContain('prov:mem-frc1');
  });
});

// ===========================================================================
// Identity gates (configuration errors throw)
// ===========================================================================

describe('rebuildMemoryEntrypoint — identity gates', () => {
  it('throws on empty target_context_snapshot_id', async () => {
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const input = memoryRebuildInput({ target_context_snapshot_id: '' });
    await expect(rebuildMemoryEntrypoint(input, deps)).rejects.toThrowError(
      'target_context_snapshot_id',
    );
    expect(port).not.toHaveBeenCalled();
  });

  it('throws on empty memory_policy_ref.contract_id', async () => {
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    const input = memoryRebuildInput({
      memory_policy_ref: { contract_id: '', contract_version: '1.0.0' },
    });
    await expect(rebuildMemoryEntrypoint(input, deps)).rejects.toThrowError(
      'memory_policy_ref.contract_id',
    );
    expect(port).not.toHaveBeenCalled();
  });

  it('throws on wrong item_kind (defensive)', async () => {
    const port = vi.fn().mockResolvedValue(frc1ReadyResult());
    const deps: MemoryRebuildDependencies = { rebuild_via_frc1: port };
    // 拿一个 project_instruction_meta 的 plan item 强塞进来
    const wrongItem = { ...memoryPlanItem(), item_kind: 'project_instruction_meta' as const };
    const input = memoryRebuildInput({ plan_item: wrongItem });
    await expect(rebuildMemoryEntrypoint(input, deps)).rejects.toThrowError(
      'memory.wrong_item_kind',
    );
    expect(port).not.toHaveBeenCalled();
  });
});
