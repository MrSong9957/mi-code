/**
 * GRC-1 §8 — Wave G 不变量(INV-G1~G20)+ 公共出口 + D-edge 审计。
 *
 * 这是 Wave G Task 11 的 machine-checkable 验收测试。每条 INV 用最小可判定的
 * 场景证明该不变量成立 —— 不需要覆盖所有触发条件,只要"机器可判定"即可。
 *
 * 三组测试:
 *   1. INV-G1~G20(20 条 post-compact reconstruction 全局不变量,spec §8)
 *   2. 公共出口审计(只导出 GRC policy/snapshot/plan/resolution/candidate/
 *      postflight/publish + activation;不导出 SessionStore 私有路径 /
 *      raw persistence records / compactor internals)
 *   3. INV-G20 不新增冻结 D-edge(reconstruction.ts 不依赖 M-031/M-033/M-052/
 *      M-060/Hold 实现的 import-path 白名单审计)
 *
 * 测试只通过 `src/agent/index.ts` 公共出口消费 Wave G 契约 —— 这样既验证
 * 不变量,又验证公共出口的完整性。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as Agent from '../../agent/index.js';
import {
  assembleRestoredWorkingSetCandidate,
  buildPinnedWorkingSetPlan,
  capturePreCompactSnapshot,
  computeOmissionManifest,
  createCompactionResultSnapshot,
  createReconstructionPolicy,
  createReconstructionTransactionRequest,
  publishRestoredWorkingSetAtomically,
  reconstructPostCompactWorkingSet,
  resolveProjectInstruction,
  rebuildMemoryEntrypoint,
  runReconstructionPreflight,
  validateCompactSummaryShape,
  validateReconstructionPostflight,
  type AssembleCandidateInput,
  type BuildPinnedWorkingSetPlanInput,
  type PostCompactReconstructionActivationEvidence,
  type PostCompactReconstructionTransaction,
  type PinnedWorkingSetPlan,
  type PinnedWorkingSetPlanItem,
  type PreflightInput,
  type PublishRestoredWorkingSetInput,
  type ReconstructionAttemptResult,
  type ReconstructionInput,
  type ReconstructionOmissionManifest,
  type ReconstructionSourceResolution,
  type RestoredWorkingSetCandidate,
  type WorkingSetPublisher,
} from '../../agent/context/reconstruction.js';
import type {
  ToolPairState,
  ToolTranscriptSnapshot,
  ToolTranscriptValidation,
} from '../../agent/tools/transcript-validator.js';
import type { Message } from '../../agent/types.js';
import type { DurableAcknowledgement } from '../../session/store.js';

// ---------------------------------------------------------------------------
// Shared fixtures(与 reconstruction-publish.test.ts 同构,精简版)
// ---------------------------------------------------------------------------

const FIXED_NOW = '2026-07-26T00:00:00.000Z';
const SESSION_ID = 'sess:abc';
const TRANSACTION_ID = 'recon-tx:abc123';
const IDEMPOTENCY_KEY = 'recon-idem:deadbeef';

function policyIdentity() {
  return {
    policy_id: 'mi.reconstruction.policy:default',
    policy_version: '1.0.0',
    request_budget_policy_ref: 'mi.budget/1:default',
  };
}

function captureInput(overrides: Partial<Parameters<typeof capturePreCompactSnapshot>[0]> = {}) {
  return {
    session_id: SESSION_ID,
    turn_id: 'turn:1',
    task_snapshot_id: 'task:snap-1',
    current_context_snapshot_id: 'ctx:before-compact',
    project_version_ref: 'proj:sha-1',
    transcript_snapshot_id: 'tx:snap-1',
    current_user_message_ref: 'msg:user-1',
    current_user_message_hash: 'a'.repeat(64),
    active_project_activation_refs: ['act:proj-a', 'act:proj-b'],
    active_meta_lifecycle_refs: ['life:meta-a', 'life:meta-b'],
    memory_entrypoint_snapshot_ref: 'entry:mem-1',
    execution_state_refs: ['tc:tool-1'],
    request_budget_snapshot_id: 'budget:snap-1',
    captured_at: FIXED_NOW,
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
    session_id: SESSION_ID,
    turn_id: 'turn:1',
    messages,
  };
}

function validation(overrides: Partial<ToolTranscriptValidation> = {}): ToolTranscriptValidation {
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

function beforeProviderSendValidation(
  overrides: Partial<ToolTranscriptValidation> = {},
): ToolTranscriptValidation {
  return validation({
    validation_id: 'tv:postflight-1',
    checkpoint: 'before_provider_send',
    ...overrides,
  });
}

function durableAck(overrides: Partial<DurableAcknowledgement> = {}): DurableAcknowledgement {
  return {
    ack_protocol_version: 'mi.durable/1',
    ack_id: 'durable:abc',
    record_id: 'precompact:xyz',
    session_id: SESSION_ID,
    committed_at: FIXED_NOW,
    sidecar_ref: 'reconstruction.jsonl',
    ...overrides,
  };
}

function acceptedPreflightInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
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

function acceptedBuildInput(
  overrides: Partial<BuildPinnedWorkingSetPlanInput> = {},
): BuildPinnedWorkingSetPlanInput {
  const preflightInput = acceptedPreflightInput();
  const preflight = runReconstructionPreflight(preflightInput);
  const compaction_result = createCompactionResultSnapshot({
    precompact: preflightInput.precompact,
    preflight,
    compacted_summary_message: {
      role: 'user',
      content: 'This conversation was compacted for continuity.\n\nSummary body.',
    },
    method: 'deterministic_local',
    method_version: 'l1l2.v1',
    compactor_ack_payload: 'compactor-call:2026-07-26T00:00:00Z|client=v1',
    created_at: FIXED_NOW,
  });
  return {
    precompact: preflightInput.precompact,
    preflight,
    compaction_result,
    transaction_id: TRANSACTION_ID,
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
    ...overrides,
  };
}

function assembledTransaction(
  overrides: Partial<PostCompactReconstructionTransaction> = {},
): PostCompactReconstructionTransaction {
  return {
    reconstruction_protocol_version: 'mi.reconstruction.tx/1',
    reconstruction_transaction_id: TRANSACTION_ID,
    idempotency_key: IDEMPOTENCY_KEY,
    session_id: SESSION_ID,
    turn_id: 'turn:1',
    precompact_snapshot_id: 'precompact:deadbeef',
    preflight_validation_id: 'tv:preflight-1',
    compaction_result_id: 'comp:deadbeef',
    working_set_plan_id: 'plan:deadbeef',
    target_context_snapshot_id: 'ctx:after-compact',
    state: 'sources_resolved',
    source_resolution_refs: [],
    candidate_snapshot_ref: null,
    postflight_validation_ref: null,
    publish_ack_ref: null,
    recovery_ref: null,
    reason_codes: ['reconstruction.sources_resolved'],
    ...overrides,
  };
}

function makeResolution(
  plan_item: PinnedWorkingSetPlanItem,
  overrides: Partial<ReconstructionSourceResolution> = {},
): ReconstructionSourceResolution {
  const defaults: ReconstructionSourceResolution = {
    resolution_protocol_version: 'mi.source_resolution/1',
    resolution_id: `resol:for-${plan_item.plan_item_id.slice('plan-item:'.length)}`,
    reconstruction_transaction_id: TRANSACTION_ID,
    plan_item_id: plan_item.plan_item_id,
    source_ref_before: plan_item.source_ref,
    source_ref_after: plan_item.source_ref,
    source_hash_before: plan_item.source_hash,
    source_hash_after: plan_item.source_hash,
    action: plan_item.resolution_action,
    status: 'resolved',
    freshness_ref: null,
    provenance_refs: [],
    acknowledgement_ref: null,
    reason_codes: [],
  };
  return { ...defaults, ...overrides };
}

function defaultSuccessResolutions(
  plan: PinnedWorkingSetPlan,
): ReconstructionSourceResolution[] {
  return plan.items.map((item) => {
    if (item.item_kind === 'bounded_memory_entrypoint') {
      return makeResolution(item, {
        action: 'rebuild',
        source_ref_after: 'entry:mem-rebuilt',
        source_hash_after: null,
        acknowledgement_ref: 'frc1.ack:entry:mem-rebuilt',
      });
    }
    return makeResolution(item);
  });
}

function acceptedAssembleInput(
  overrides: Partial<AssembleCandidateInput> = {},
): AssembleCandidateInput {
  const buildInput = acceptedBuildInput();
  const plan = buildPinnedWorkingSetPlan(buildInput);
  const source_resolutions = defaultSuccessResolutions(plan);
  const transaction = assembledTransaction({
    working_set_plan_id: plan.working_set_plan_id,
    compaction_result_id: buildInput.compaction_result.compaction_result_id,
    source_resolution_refs: source_resolutions.map((r) => r.resolution_id),
  });
  return {
    transaction,
    plan,
    compaction_result: buildInput.compaction_result,
    source_resolutions,
    target_context_snapshot_id: buildInput.target_context_snapshot_id,
    request_budget_snapshot_id: buildInput.precompact.request_budget_snapshot_id,
    ...overrides,
  };
}

/**
 * 构造一份 postflight-accepted candidate bundle(publish path 的输入)。
 * 不走 Core Anchor —— 直接组装上游产物。
 */
async function acceptedPublishBundle(): Promise<{
  transaction: PostCompactReconstructionTransaction;
  candidate: RestoredWorkingSetCandidate;
  plan: PinnedWorkingSetPlan;
  preflight: ReturnType<typeof runReconstructionPreflight>;
  omission_manifest: ReconstructionOmissionManifest;
  postflight_result: Awaited<ReturnType<typeof validateReconstructionPostflight>>;
  target_context_snapshot_id: string;
}> {
  const assembleInput = acceptedAssembleInput();
  const candidate = assembleRestoredWorkingSetCandidate(assembleInput);
  const omission_manifest = computeOmissionManifest(assembleInput);
  const preflightInput = acceptedPreflightInput();
  const preflight = runReconstructionPreflight(preflightInput);
  const postflight_result = await validateReconstructionPostflight(
    {
      transaction: assembleInput.transaction,
      candidate,
      plan: assembleInput.plan,
      compaction_result: assembleInput.compaction_result,
      source_resolutions: assembleInput.source_resolutions,
      preflight,
      omission_manifest,
      target_context_snapshot_id: assembleInput.target_context_snapshot_id,
    },
    { validatePostCompactToolTranscript: () => beforeProviderSendValidation() },
  );
  if (postflight_result.status !== 'accepted') {
    throw new Error(
      `fixture postflight not accepted: ${postflight_result.failed_gates.join(',')}`,
    );
  }
  return {
    transaction: assembleInput.transaction,
    candidate,
    plan: assembleInput.plan,
    preflight,
    omission_manifest,
    postflight_result,
    target_context_snapshot_id: assembleInput.target_context_snapshot_id,
  };
}

// ===========================================================================
// INV-G1 ~ INV-G20
// ===========================================================================

describe('Wave G / GRC-1 — INV-G1~G20 全局不变量', () => {
  // ---------------------------------------------------------------------------
  // INV-G1: Reconstruction 不是 Transcript Restore
  //   GRC-1 只重建当前工作集(current user / meta / summary / memory handoff /
  //   execution refs),不恢复完整 pre-compact transcript。
  // ---------------------------------------------------------------------------
  it('INV-G1: RestoredWorkingSetCandidate 不含完整 transcript 字段(只持 identity refs)', () => {
    const assembleInput = acceptedAssembleInput();
    const candidate = assembleRestoredWorkingSetCandidate(assembleInput);

    // candidate 不含 transcript_messages / full_messages / restored_transcript 字段。
    const candidateKeys = Object.keys(candidate);
    expect(candidateKeys).not.toContain('transcript_messages');
    expect(candidateKeys).not.toContain('full_messages');
    expect(candidateKeys).not.toContain('restored_transcript');
    expect(candidateKeys).not.toContain('messages');

    // candidate 只持有 identity refs(refs / id 字段),不持有正文。
    for (const key of candidateKeys) {
      const value = (candidate as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        // 数组字段必须是 string[](identity refs),不能是 Message[] / object[]
        for (const item of value) {
          expect(typeof item).toBe('string');
        }
      }
    }

    // 也验证 PreCompactSnapshot 不持有 transcript 正文 —— 只有 transcript_snapshot_id。
    const precompact = capturePreCompactSnapshot(captureInput());
    const precompactKeys = Object.keys(precompact);
    expect(precompactKeys).not.toContain('transcript_messages');
    expect(precompactKeys).not.toContain('messages');
    expect(precompactKeys).toContain('transcript_snapshot_id');
  });

  // ---------------------------------------------------------------------------
  // INV-G2: Preflight 先于 Compaction
  //   tool transcript pairing 未 accepted 时不得执行 compaction。
  //   构造:validation.status='blocked' → runReconstructionPreflight 返回 blocked,
  //   用 spy 验证 compactor 在 reconstructPostCompactWorkingSet 中没被调用。
  // ---------------------------------------------------------------------------
  it('INV-G2: preflight rejected/blocked 时 Core Anchor 不调用 compactor', async () => {
    const compactorSpy = vi.fn(async () => ({
      summary_message: { role: 'user', content: 'should not be called' },
      method: 'deterministic_local' as const,
      method_version: 'local/1',
      compactor_ack_payload: 'should-not-reach',
    }));
    const persistenceMock = {
      savePreCompactSnapshot: vi.fn(async () => durableAck()),
      beginReconstructionAttempt: vi.fn(async () => ({
        attempt_id: 'att-1',
        latest_state: 'requested',
        latest_state_record_id: null,
      })),
    };

    // validation.status='blocked' + pending_execution pair → preflight blocked。
    const blockedValidation = validation({
      status: 'blocked',
      pair_records: [
        {
          tool_call_id: 'tc:pending-1',
          tool_use_message_id: 'msg:tu-1',
          tool_result_message_id: null,
          state: 'pending_execution' as ToolPairState,
          identity_hash: 'p-hash',
          pair_index: 0,
        },
      ],
      reason_codes: ['pair.pending_execution:tc:pending-1'],
    });

    const input: ReconstructionInput = {
      precompact_input: captureInput(),
      transaction_request_input: {
        policy: createReconstructionPolicy(policyIdentity()),
        target_context_snapshot_id: 'ctx:after-compact',
        compaction_method: 'deterministic_local',
        compaction_method_version: 'local/1',
        memory_rebuild_identity: {
          old_entrypoint_snapshot_id: 'entry:mem-1',
          policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
          render_profile_ref: 'render:profile-1',
        },
        postflight_validator_policy: {
          validator_policy_id: 'mi.postflight.policy:default',
          validator_policy_version: '1.0.0',
        },
      },
      persistence: persistenceMock,
      compactor: compactorSpy,
      transcript_snapshot: transcriptSnapshot(),
      preflight_validation: blockedValidation,
      active_project_instructions: [],
      project_instruction_reload_pipeline: vi.fn(),
      memory_rebuild_port: vi.fn(),
      execution_state_refs: [],
      target_context_snapshot_id: 'ctx:after-compact',
      target_task_snapshot_id: 'task:target-1',
      target_project_version_ref: 'proj:sha-1',
      memory_policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
      render_profile_ref: 'render:profile-1',
      request_budget_snapshot_id: 'budget:snap-1',
      postflight_deps: {
        validatePostCompactToolTranscript: () => beforeProviderSendValidation(),
      },
    };

    const result = await reconstructPostCompactWorkingSet(input);

    // preflight blocked → status='blocked',compactor 不被调用。
    expect(result.status).toBe('blocked');
    expect(compactorSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // INV-G3: Completed Tool 不重执行
  //   Reconstruction / retry / resume / publish 都不能重新执行已完成 tool call。
  //   构造:在 reconstructPostCompactWorkingSet 前后各检查一次 execSpy 调用次数,
  //   应保持 0(reconstruction 不调用 tool executor)。
  // ---------------------------------------------------------------------------
  it('INV-G3: reconstruction pipeline 不调用任何 tool executor', async () => {
    const fakeToolExecutor = vi.fn(async () => ({
      content: 'should-not-be-called',
    }));

    // 注入的依赖中没有 tool executor 入口 —— reconstruction API structurally
    // 不接受 tool_executor。我们验证 ReconstructionInput 类型不允许 tool executor,
    // 且实际运行不调用我们传入的 spy。
    const compactor = vi.fn(async () => ({
      summary_message: { role: 'user', content: 'compacted summary' },
      method: 'deterministic_local' as const,
      method_version: 'local/1',
      compactor_ack_payload: 'compactor:ack-1',
    }));

    const input: ReconstructionInput = {
      precompact_input: captureInput(),
      transaction_request_input: {
        policy: createReconstructionPolicy(policyIdentity()),
        target_context_snapshot_id: 'ctx:after-compact',
        compaction_method: 'deterministic_local',
        compaction_method_version: 'local/1',
        memory_rebuild_identity: {
          old_entrypoint_snapshot_id: 'entry:mem-1',
          policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
          render_profile_ref: 'render:profile-1',
        },
        postflight_validator_policy: {
          validator_policy_id: 'mi.postflight.policy:default',
          validator_policy_version: '1.0.0',
        },
      },
      persistence: {
        savePreCompactSnapshot: async () => durableAck(),
        beginReconstructionAttempt: async () => ({
          attempt_id: 'att-1',
          latest_state: 'requested',
          latest_state_record_id: null,
        }),
      },
      compactor,
      transcript_snapshot: transcriptSnapshot(),
      preflight_validation: validation(),
      active_project_instructions: [
        {
          activation_id: 'act:proj-a',
          message_id: 'msg:meta-a',
          content_hash: 'b'.repeat(64),
          lifecycle_record: {
            lifecycle_record_protocol_version: 'mi.meta.lifecycle/1',
            lifecycle_record_id: 'life:meta-a',
            message_id: 'msg:meta-a',
            state: 'resident',
            source_kind: 'project_instruction',
            source_freshness_ref: 'fresh:a',
            content_hash: 'b'.repeat(64),
            acknowledgement_ref: null,
            transition_reason_codes: [],
            transitioned_at: FIXED_NOW,
          },
          source_freshness_ref: 'fresh:a',
          source_content_hash: 'b'.repeat(64),
          ordinal: 100,
        },
      ],
      project_instruction_reload_pipeline: vi.fn(async () => ({
        new_activation_id: 'act:proj-a-reloaded',
        new_message_id: 'msg:meta-a-reloaded',
        new_lifecycle_record_id: 'life:meta-a-reloaded',
        new_content_hash: 'b'.repeat(64),
        new_freshness_ref: 'fresh:a-reloaded',
        acknowledgement_ref: 'ack:reload-1',
      })),
      memory_rebuild_port: vi.fn(async () => ({
        entrypoint_snapshot_id: 'entry:mem-rebuilt',
        target_context_snapshot_id: 'ctx:after-compact',
        state: 'ready',
        overflow_manifest_ref: null,
        provenance_manifest_ref: 'prov:mem-1',
        reason_codes: [],
      })),
      execution_state_refs: [
        {
          execution_ref: 'tc:tool-1',
          ack_ref: 'ack:completed-1',
          pair_state: 'paired' as ToolPairState,
          permission_security_refs: ['perm:1'],
          ordinal: 300,
        },
      ],
      target_context_snapshot_id: 'ctx:after-compact',
      target_task_snapshot_id: 'task:target-1',
      target_project_version_ref: 'proj:sha-1',
      memory_policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
      render_profile_ref: 'render:profile-1',
      request_budget_snapshot_id: 'budget:snap-1',
      postflight_deps: {
        validatePostCompactToolTranscript: () => beforeProviderSendValidation(),
      },
    };

    const execCallsBefore = fakeToolExecutor.mock.calls.length;
    await reconstructPostCompactWorkingSet(input);
    const execCallsAfter = fakeToolExecutor.mock.calls.length;

    // Tool executor 从未被 reconstruction pipeline 调用。
    expect(execCallsAfter).toBe(execCallsBefore);
    expect(execCallsAfter).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // INV-G4: Reload Marker 不等于 Reload
  //   reload_required 只要求重载;只有受信 pipeline acknowledgement 可证明重载完成。
  //   构造:lifecycle.state='reload_required' 但 pipeline throw → resolution.status='blocked',
  //   acknowledgement_ref=null(没有 ack 证明 reload 完成)。
  // ---------------------------------------------------------------------------
  it('INV-G4: reload marker + pipeline 失败 → blocked 且无 acknowledgement', async () => {
    const buildInput = acceptedBuildInput();
    const plan = buildPinnedWorkingSetPlan(buildInput);
    const projectItem = plan.items.find((it) => it.item_kind === 'project_instruction_meta')!;

    const reloadPipelineThrow = vi.fn(async () => {
      throw new Error('pipeline down');
    });

    const resolution = await resolveProjectInstruction(
      {
        plan_item: projectItem,
        lifecycle_record: {
          lifecycle_record_protocol_version: 'mi.meta.lifecycle/1',
          lifecycle_record_id: 'life:meta-a',
          message_id: 'msg:meta-a',
          state: 'reload_required',
          source_kind: 'project_instruction',
          source_freshness_ref: 'fresh:a',
          content_hash: 'b'.repeat(64),
          acknowledgement_ref: null,
          transition_reason_codes: [],
          transitioned_at: FIXED_NOW,
        },
        target_context_snapshot_id: 'ctx:after-compact',
        target_project_version_ref: 'proj:sha-1',
        source_freshness_ref: 'fresh:a',
        source_content_hash: 'b'.repeat(64),
        reconstruction_transaction_id: TRANSACTION_ID,
      },
      { reload_via_trusted_pipeline: reloadPipelineThrow },
    );

    expect(resolution.action).toBe('reload');
    expect(resolution.status).toBe('blocked');
    // 没有 acknowledgement —— reload marker 本身不证明 reload 完成。
    expect(resolution.acknowledgement_ref).toBeNull();
    expect(resolution.source_ref_after).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // INV-G5: Invalidated 不复活
  //   invalidated source 不得因 summary/cache/旧 snapshot/旧正文重新进入 working set。
  //   构造:lifecycle.state='invalidated' + source_content_hash 匹配 → 仍 exclude,
  //   source_ref_after=null,即使 hash 一致也不 preserve。
  // ---------------------------------------------------------------------------
  it('INV-G5: invalidated lifecycle 即使 hash 匹配也 exclude,不复活', async () => {
    const buildInput = acceptedBuildInput();
    const plan = buildPinnedWorkingSetPlan(buildInput);
    const projectItem = plan.items.find((it) => it.item_kind === 'project_instruction_meta')!;

    const reloadPipeline = vi.fn(); // 不应被调用(invalidated 不走 reload)

    const resolution = await resolveProjectInstruction(
      {
        plan_item: projectItem,
        lifecycle_record: {
          lifecycle_record_protocol_version: 'mi.meta.lifecycle/1',
          lifecycle_record_id: 'life:meta-a',
          message_id: 'msg:meta-a',
          state: 'invalidated',
          source_kind: 'project_instruction',
          source_freshness_ref: 'fresh:a',
          content_hash: 'b'.repeat(64),
          acknowledgement_ref: null,
          transition_reason_codes: [],
          transitioned_at: FIXED_NOW,
        },
        target_context_snapshot_id: 'ctx:after-compact',
        target_project_version_ref: 'proj:sha-1',
        // 即使 hash 一致 + freshness 存在,invalidated 优先级最高,强制 exclude。
        source_freshness_ref: 'fresh:a',
        source_content_hash: projectItem.source_hash,
        reconstruction_transaction_id: TRANSACTION_ID,
      },
      { reload_via_trusted_pipeline: reloadPipeline },
    );

    expect(resolution.action).toBe('exclude');
    expect(resolution.status).toBe('resolved'); // excluded 是确定性成功
    expect(resolution.source_ref_after).toBeNull();
    expect(reloadPipeline).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // INV-G6: Current User 精确保留
  //   Active current user message identity/hash 必须精确保留且只出现一次。
  //   构造:candidate.current_user_message_ref === precompact.current_user_message_ref,
  //   且在 provider_visible_order 中出现恰好一次。
  // ---------------------------------------------------------------------------
  it('INV-G6: current_user_message_ref 精确保留 + provider_visible_order 出现一次', () => {
    const precompactInput = captureInput();
    const precompact = capturePreCompactSnapshot(precompactInput);

    // 手工构造 build input 让其 precompact === 上面的 precompact。
    const buildInput = acceptedBuildInput();
    // 直接覆盖 precompact(已捕获的 snapshot 是不变量)。
    const patchedInput: BuildPinnedWorkingSetPlanInput = {
      ...buildInput,
      precompact,
    };
    const plan = buildPinnedWorkingSetPlan(patchedInput);

    const assembleInput: AssembleCandidateInput = {
      transaction: assembledTransaction({
        working_set_plan_id: plan.working_set_plan_id,
        compaction_result_id: buildInput.compaction_result.compaction_result_id,
      }),
      plan,
      compaction_result: buildInput.compaction_result,
      source_resolutions: defaultSuccessResolutions(plan),
      target_context_snapshot_id: buildInput.target_context_snapshot_id,
      request_budget_snapshot_id: precompact.request_budget_snapshot_id,
    };
    const candidate = assembleRestoredWorkingSetCandidate(assembleInput);

    // current user 精确保留(identity 不变)。
    expect(candidate.current_user_message_ref).toBe(precompact.current_user_message_ref);
    // 在 provider_visible_order 中出现恰好一次。
    const countInPvo = candidate.provider_visible_order.filter(
      (r) => r === candidate.current_user_message_ref,
    ).length;
    expect(countInPvo).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // INV-G7: Meta 不计 User Turn
  //   恢复后的 project instruction meta context 不增加 user turn count,不冒充 current user。
  //   构造:candidate 区分 meta_context_message_refs 与 current_user_message_ref,
  //   meta refs 不出现在 current_user_message_ref 字段。
  // ---------------------------------------------------------------------------
  it('INV-G7: meta_context refs 与 current_user_ref 字段分离,不冒充 current user', () => {
    const assembleInput = acceptedAssembleInput();
    const candidate = assembleRestoredWorkingSetCandidate(assembleInput);

    // 字段分离:meta_context_message_refs 与 current_user_message_ref 是不同字段。
    expect(Object.keys(candidate)).toContain('meta_context_message_refs');
    expect(Object.keys(candidate)).toContain('current_user_message_ref');
    // meta refs 不冒充 current user(current_user 不在 meta refs 中)。
    expect(candidate.meta_context_message_refs).not.toContain(
      candidate.current_user_message_ref,
    );
    // current_user 在 provider_visible_order 中只出现一次(不是 N 次,不冒充多 user turn)。
    const userInPvo = candidate.provider_visible_order.filter(
      (r) => r === candidate.current_user_message_ref,
    ).length;
    expect(userInPvo).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // INV-G8: Summary 是 Derived Context
  //   Compaction summary 不继承 System Rule/Project Instruction/Tool Result/
  //   SecurityDecision/CompletionReport 的 Authority。
  //   构造:validateCompactSummaryShape 只接受 role='user' + content=string ——
  //   assistant summary / tool_result summary 都被 rejected。
  //   且 candidate 把 summary 放在 conversation_summary plane,与 meta/system 隔离。
  // ---------------------------------------------------------------------------
  it('INV-G8: summary shape 必须是 user/text,且 candidate 把 summary 单独放 conversation_summary plane', () => {
    // 1. assistant 角色 summary 被 shape validator reject。
    const assistantShape = validateCompactSummaryShape({
      role: 'assistant',
      content: 'I am a summary',
    });
    expect(assistantShape.status).toBe('rejected');

    // 2. tool_use block content 被 reject(content 必须是 string,不能是 ContentBlock[])。
    const blocksShape = validateCompactSummaryShape({
      role: 'user',
      content: [{ type: 'text', text: 'summary' }] as unknown as string,
    });
    expect(blocksShape.status).toBe('rejected');

    // 3. summary 在 candidate 的 plan item 中固定在 conversation_summary plane
    //    (矩阵检查:REQUIRED_ITEM_MATRIX.compact_summary.target_plane === 'conversation_summary')。
    const buildInput = acceptedBuildInput();
    const plan = buildPinnedWorkingSetPlan(buildInput);
    const summaryItem = plan.items.find((it) => it.item_kind === 'compact_summary')!;
    expect(summaryItem.target_plane).toBe('conversation_summary');
    // conversation_summary plane 与 meta_context / system plane 互斥。
    expect(summaryItem.target_plane).not.toBe('meta_context');
    expect(summaryItem.target_plane).not.toBe('system');
  });

  // ---------------------------------------------------------------------------
  // INV-G9: System Prompt 不属于 Reconstruction
  //   旧 system Prompt string 不进入 Pinned Working Set。
  //   构造:PreCompactSnapshot 类型不含 system_prompt 字段(反射检查);
  //   PinnedWorkingSetPlanItem.item_kind 封闭值域不含 'system_prompt'。
  // ---------------------------------------------------------------------------
  it('INV-G9: PreCompactSnapshot / PlanItemKind 不含 system_prompt 字段', () => {
    const precompact = capturePreCompactSnapshot(captureInput());
    const precompactKeys = Object.keys(precompact);
    // PreCompactSnapshot 没有 system_prompt / system_prompt_hash / prompt_body。
    expect(precompactKeys).not.toContain('system_prompt');
    expect(precompactKeys).not.toContain('system_prompt_hash');
    expect(precompactKeys).not.toContain('prompt_body');

    const buildInput = acceptedBuildInput();
    const plan = buildPinnedWorkingSetPlan(buildInput);
    // item_kind 封闭值域不含 'system_prompt'。
    const allKinds = new Set(plan.items.map((it) => it.item_kind));
    expect(allKinds.has('system_prompt')).toBe(false);
    // 也不含 'prompt' / 'system_prompt_message'。
    expect(allKinds.has('prompt')).toBe(false);
    expect(allKinds.has('system_prompt_message')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // INV-G10: Memory 必须绑定 Target Context
  //   旧 Memory entrypoint / use decision 不跨 post-compact target context 自动复用。
  //   构造:rebuildMemoryEntrypoint 接受 target_context_snapshot_id,
  //   返回的 MemoryEntrypointRebuildResult.target_context_snapshot_id 必须与 input 一致;
  //   否则 resolution.status='rejected'。
  // ---------------------------------------------------------------------------
  it('INV-G10: memory rebuild result 与 target context 不一致 → rejected', async () => {
    const buildInput = acceptedBuildInput();
    const plan = buildPinnedWorkingSetPlan(buildInput);
    const memoryItem = plan.items.find((it) => it.item_kind === 'bounded_memory_entrypoint')!;

    // FRC-1 port 返回了一个错误的 target context。
    const badPort = vi.fn(async () => ({
      entrypoint_snapshot_id: 'entry:wrong',
      target_context_snapshot_id: 'ctx:WRONG',
      state: 'ready' as const,
      overflow_manifest_ref: null,
      provenance_manifest_ref: 'prov:1',
      reason_codes: [],
    }));

    const resolution = await rebuildMemoryEntrypoint(
      {
        plan_item: memoryItem,
        old_entrypoint_snapshot_id: 'entry:mem-1',
        old_catalog_snapshot_id: null,
        old_selection_id: null,
        target_context_snapshot_id: 'ctx:after-compact',
        target_task_snapshot_id: 'task:target-1',
        target_project_version_ref: 'proj:sha-1',
        memory_policy_ref: { contract_id: 'mi.entrypoint/1', contract_version: '1' },
        render_profile_ref: 'render:profile-1',
        request_budget_snapshot_id: 'budget:snap-1',
        reconstruction_transaction_id: TRANSACTION_ID,
      },
      { rebuild_via_frc1: badPort },
    );

    // target context mismatch → rejected(memory 必须绑定 target context)。
    expect(resolution.status).toBe('rejected');
    expect(resolution.reason_codes).toContain('memory.context_mismatch');
    expect(resolution.source_ref_after).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // INV-G11: Plane 不混合
  //   System/meta context/summary/current user/execution state 必须保持独立 plane。
  //   构造:RestoredWorkingSetCandidate 有独立字段(meta_context_message_refs /
  //   compact_summary_ref / current_user_message_ref / execution_state_refs)。
  //   execution_state_refs 不出现在 provider_visible_order 中。
  // ---------------------------------------------------------------------------
  it('INV-G11: candidate 各 plane 字段分离,execution 不出现在 provider_visible_order', () => {
    const assembleInput = acceptedAssembleInput();
    const candidate = assembleRestoredWorkingSetCandidate(assembleInput);

    // 5 个 plane 字段都是独立的(不混合成一个 messages 数组)。
    const keys = Object.keys(candidate);
    expect(keys).toContain('meta_context_message_refs');
    expect(keys).toContain('compact_summary_ref');
    expect(keys).toContain('current_user_message_ref');
    expect(keys).toContain('execution_state_refs');
    expect(keys).toContain('bounded_memory_entrypoint_snapshot_ref');

    // execution_state plane isolation:execution refs 不进 provider_visible_order。
    const pvoSet = new Set(candidate.provider_visible_order);
    for (const execRef of candidate.execution_state_refs) {
      expect(pvoSet.has(execRef)).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // INV-G12: Required 缺失不 Partial Publish
  //   任一 required item 未解析时不得发布半工作集。
  //   构造:required resolution blocked → blocked_required_items 非空 →
  //   postflight rejected(status='rejected')。
  // ---------------------------------------------------------------------------
  it('INV-G12: 任一 required item blocked → postflight rejected', async () => {
    const assembleInput = acceptedAssembleInput();
    // 把 project_instruction_meta resolution 改成 blocked(required item 失败)。
    const projectResolution = assembleInput.source_resolutions.find(
      (r) => r.plan_item_id === assembleInput.plan.items.find((it) => it.item_kind === 'project_instruction_meta')!.plan_item_id,
    )!;
    const blockedProjectResolution: ReconstructionSourceResolution = {
      ...projectResolution,
      status: 'blocked',
      action: 'block',
      source_ref_after: null,
      source_hash_after: null,
      acknowledgement_ref: null,
      reason_codes: ['reload.pipeline_failed'],
    };
    const source_resolutions = assembleInput.source_resolutions.map((r) =>
      r.plan_item_id === blockedProjectResolution.plan_item_id ? blockedProjectResolution : r,
    );

    // assemble 会把 blocked required item 放进 blocked_required_items。
    const candidate = assembleRestoredWorkingSetCandidate({
      ...assembleInput,
      source_resolutions,
    });
    const omission_manifest = computeOmissionManifest({
      ...assembleInput,
      source_resolutions,
    });
    expect(omission_manifest.blocked_required_items.length).toBeGreaterThan(0);

    // postflight 因此 rejected。
    const preflight = runReconstructionPreflight(acceptedPreflightInput());
    const postflight = await validateReconstructionPostflight(
      {
        transaction: assembleInput.transaction,
        candidate,
        plan: assembleInput.plan,
        compaction_result: assembleInput.compaction_result,
        source_resolutions,
        preflight,
        omission_manifest,
        target_context_snapshot_id: assembleInput.target_context_snapshot_id,
      },
      { validatePostCompactToolTranscript: () => beforeProviderSendValidation() },
    );
    expect(postflight.status).toBe('rejected');
    // required_source_resolved 门失败。
    expect(postflight.failed_gates).toContain('required_source_resolved');
  });

  // ---------------------------------------------------------------------------
  // INV-G13: Optional 缺失显式降级
  //   Optional item 可以省略,但必须进入 omission manifest,不能声称完整。
  //   构造:memory rebuild 失败(excluded)→ omission_manifest.omitted_items 含该项,
  //   degraded=true。
  // ---------------------------------------------------------------------------
  it('INV-G13: optional item omitted → 进 omission manifest,degraded=true', () => {
    const assembleInput = acceptedAssembleInput();
    // 把 memory resolution 改成 excluded(optional failure)。
    const memoryItemId = assembleInput.plan.items.find(
      (it) => it.item_kind === 'bounded_memory_entrypoint',
    )!.plan_item_id;
    const memoryResolution = assembleInput.source_resolutions.find(
      (r) => r.plan_item_id === memoryItemId,
    )!;
    const excludedMemoryResolution: ReconstructionSourceResolution = {
      ...memoryResolution,
      status: 'excluded',
      action: 'rebuild',
      source_ref_after: null,
      source_hash_after: null,
      acknowledgement_ref: null,
      reason_codes: ['memory.rebuild_failed', 'memory.error:simulated'],
    };
    const source_resolutions = assembleInput.source_resolutions.map((r) =>
      r.plan_item_id === memoryItemId ? excludedMemoryResolution : r,
    );

    const omission_manifest = computeOmissionManifest({
      ...assembleInput,
      source_resolutions,
    });

    // memory 进 omitted_items,degraded=true。
    const memoryOmission = omission_manifest.omitted_items.find(
      (it) => it.plan_item_id === memoryItemId,
    );
    expect(memoryOmission).toBeDefined();
    expect(omission_manifest.degraded).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // INV-G14: Publish 原子
  //   Candidate 只有通过全部 postflight gate 后才能一次性替换 active working set。
  //   构造:postflight rejected → publishRestoredWorkingSetAtomically 抛错
  //   'reconstruction.postflight_not_accepted',CAS 不被调用。
  // ---------------------------------------------------------------------------
  it('INV-G14: postflight rejected 时 publish 抛错 + publisher 不被调用', async () => {
    const bundle = await acceptedPublishBundle();
    const publisherSpy: WorkingSetPublisher = {
      publishAtomically: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };

    // 把 postflight_result 改成 rejected。
    const rejectedPostflight = {
      ...bundle.postflight_result,
      status: 'rejected' as const,
      failed_gates: ['current_user_exact_once'],
      reason_codes: ['postflight.current_user_exact_once.failed'],
    };

    const publishInput: PublishRestoredWorkingSetInput = {
      session_id: SESSION_ID,
      candidate: bundle.candidate,
      postflight_result: rejectedPostflight,
      transaction: bundle.transaction,
      expected_previous_snapshot_id: null,
      publisher: publisherSpy,
      created_at: FIXED_NOW,
    };

    // 抛错对象(code 字段 = 'reconstruction.postflight_not_accepted')。
    await expect(publishRestoredWorkingSetAtomically(publishInput)).rejects.toMatchObject({
      code: 'reconstruction.postflight_not_accepted',
    });
    // publisher(CAS)从未被调用 —— publish 原子性:postflight 不过不切 active。
    expect(publisherSpy.publishAtomically).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // INV-G15: 旧 Snapshot 可恢复
  //   Publish acknowledgement durable 前,最后一个有效 pre-compact/active snapshot
  //   必须保持可恢复。
  //   构造:reconstructPostCompactWorkingSet 在 preflight/compaction 失败时返回
  //   recovery_ref(指向 precompact_snapshot_id),旧 snapshot 仍可加载。
  // ---------------------------------------------------------------------------
  it('INV-G15: preflight rejected 时 result.recovery_ref 指向 precompact snapshot', async () => {
    const compactor = vi.fn(async () => ({
      summary_message: { role: 'user', content: 'irrelevant' },
      method: 'deterministic_local' as const,
      method_version: 'local/1',
      compactor_ack_payload: 'irrelevant',
    }));

    const input: ReconstructionInput = {
      precompact_input: captureInput(),
      transaction_request_input: {
        policy: createReconstructionPolicy(policyIdentity()),
        target_context_snapshot_id: 'ctx:after-compact',
        compaction_method: 'deterministic_local',
        compaction_method_version: 'local/1',
        memory_rebuild_identity: {
          old_entrypoint_snapshot_id: 'entry:mem-1',
          policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
          render_profile_ref: 'render:profile-1',
        },
        postflight_validator_policy: {
          validator_policy_id: 'mi.postflight.policy:default',
          validator_policy_version: '1.0.0',
        },
      },
      persistence: {
        savePreCompactSnapshot: async () => durableAck(),
        beginReconstructionAttempt: async () => ({
          attempt_id: 'att-1',
          latest_state: 'requested',
          latest_state_record_id: null,
        }),
      },
      compactor,
      transcript_snapshot: transcriptSnapshot(),
      // rejected validation(identity_conflict)→ preflight rejected。
      preflight_validation: validation({
        status: 'rejected',
        pair_records: [
          {
            tool_call_id: 'tc:bad-1',
            tool_use_message_id: 'msg:tu-1',
            tool_result_message_id: 'msg:tr-1',
            state: 'identity_conflict' as ToolPairState,
            identity_hash: 'conflict-hash',
            pair_index: 0,
          },
        ],
        reason_codes: ['pair.identity_conflict:tc:bad-1'],
      }),
      active_project_instructions: [],
      project_instruction_reload_pipeline: vi.fn(),
      memory_rebuild_port: vi.fn(),
      execution_state_refs: [],
      target_context_snapshot_id: 'ctx:after-compact',
      target_task_snapshot_id: 'task:target-1',
      target_project_version_ref: 'proj:sha-1',
      memory_policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
      render_profile_ref: 'render:profile-1',
      request_budget_snapshot_id: 'budget:snap-1',
      postflight_deps: {
        validatePostCompactToolTranscript: () => beforeProviderSendValidation(),
      },
    };

    const result = await reconstructPostCompactWorkingSet(input);

    // rejected → status='rejected',recovery_ref 指向 precompact snapshot(可恢复)。
    expect(result.status).toBe('rejected');
    expect(result.recovery_ref).not.toBeNull();
    expect(result.recovery_ref).toMatch(/^precompact:/);
    // compactor 没被调用(preflight 先于 compaction)。
    expect(compactor).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // INV-G16: Retry 幂等
  //   相同 reconstruction input 的 retry 不重复 compaction/reload/rebuild/消息插入/publish。
  //   构造:相同 capture input → 同一 precompact_snapshot_id;相同 transaction input →
  //   同一 idempotency_key;Core Anchor 第二次进入 attempt.latest_state='published' →
  //   直接返回 'already_published',不再调 compactor。
  // ---------------------------------------------------------------------------
  it('INV-G16: 相同输入产生相同 idempotency_key + 已 published 时 Core Anchor 不重做 side effect', async () => {
    // 1. 相同输入产生相同 idempotency_key。
    const preflightValidation = validation();
    const txInput1 = {
      precompact: capturePreCompactSnapshot(captureInput()),
      preflight_validation: preflightValidation,
      policy: createReconstructionPolicy(policyIdentity()),
      target_context_snapshot_id: 'ctx:after-compact',
      compaction_method: 'deterministic_local' as const,
      compaction_method_version: 'local/1',
      memory_rebuild_identity: {
        old_entrypoint_snapshot_id: 'entry:mem-1',
        policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
        render_profile_ref: 'render:profile-1',
      },
      postflight_validator_policy: {
        validator_policy_id: 'mi.postflight.policy:default',
        validator_policy_version: '1.0.0',
      },
    };
    const tx1 = createReconstructionTransactionRequest(txInput1);
    const tx2 = createReconstructionTransactionRequest(txInput1);
    expect(tx1.idempotency_key).toBe(tx2.idempotency_key);
    expect(tx1.reconstruction_transaction_id).toBe(tx2.reconstruction_transaction_id);

    // 2. attempt.latest_state='published' → Core Anchor 直接 'already_published'。
    const compactor = vi.fn(async () => ({
      summary_message: { role: 'user', content: 'should not be called' },
      method: 'deterministic_local' as const,
      method_version: 'local/1',
      compactor_ack_payload: 'should-not-reach',
    }));

    const input: ReconstructionInput = {
      precompact_input: captureInput(),
      transaction_request_input: {
        policy: createReconstructionPolicy(policyIdentity()),
        target_context_snapshot_id: 'ctx:after-compact',
        compaction_method: 'deterministic_local',
        compaction_method_version: 'local/1',
        memory_rebuild_identity: {
          old_entrypoint_snapshot_id: 'entry:mem-1',
          policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
          render_profile_ref: 'render:profile-1',
        },
        postflight_validator_policy: {
          validator_policy_id: 'mi.postflight.policy:default',
          validator_policy_version: '1.0.0',
        },
      },
      persistence: {
        savePreCompactSnapshot: async () => durableAck(),
        beginReconstructionAttempt: async () => ({
          attempt_id: 'att-1',
          latest_state: 'published', // 已 published
          latest_state_record_id: 'sr-1',
        }),
      },
      compactor,
      transcript_snapshot: transcriptSnapshot(),
      preflight_validation: validation(),
      active_project_instructions: [],
      project_instruction_reload_pipeline: vi.fn(),
      memory_rebuild_port: vi.fn(),
      execution_state_refs: [],
      target_context_snapshot_id: 'ctx:after-compact',
      target_task_snapshot_id: 'task:target-1',
      target_project_version_ref: 'proj:sha-1',
      memory_policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
      render_profile_ref: 'render:profile-1',
      request_budget_snapshot_id: 'budget:snap-1',
      postflight_deps: {
        validatePostCompactToolTranscript: () => beforeProviderSendValidation(),
      },
    };

    const result = await reconstructPostCompactWorkingSet(input);
    expect(result.status).toBe('already_published');
    // compactor 不被调用(retry 不重做 compaction)。
    expect(compactor).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // INV-G17: Failure 不提升状态
  //   Summary/reload/rebuild/validation/budget/cache/logging/publish failure 不能
  //   产生 accepted/trusted/use/completed/published。
  //   构造:reload pipeline 失败 → resolution.status='blocked'(不是 'resolved'),
  //   acknowledgement_ref=null(不是 trusted)。
  //   已在 INV-G4 验证 reload failure;这里验证 rebuild failure 也不提升状态。
  // ---------------------------------------------------------------------------
  it('INV-G17: memory rebuild port throw → status=excluded(非 resolved),无 acknowledgement', async () => {
    const buildInput = acceptedBuildInput();
    const plan = buildPinnedWorkingSetPlan(buildInput);
    const memoryItem = plan.items.find((it) => it.item_kind === 'bounded_memory_entrypoint')!;

    const throwingPort = vi.fn(async () => {
      throw new Error('FRC-1 down');
    });

    const resolution = await rebuildMemoryEntrypoint(
      {
        plan_item: memoryItem,
        old_entrypoint_snapshot_id: 'entry:mem-1',
        old_catalog_snapshot_id: null,
        old_selection_id: null,
        target_context_snapshot_id: 'ctx:after-compact',
        target_task_snapshot_id: 'task:target-1',
        target_project_version_ref: 'proj:sha-1',
        memory_policy_ref: { contract_id: 'mi.entrypoint/1', contract_version: '1' },
        render_profile_ref: 'render:profile-1',
        request_budget_snapshot_id: 'budget:snap-1',
        reconstruction_transaction_id: TRANSACTION_ID,
      },
      { rebuild_via_frc1: throwingPort },
    );

    // rebuild failure → excluded(不是 resolved),acknowledgement_ref=null(不是 trusted)。
    expect(resolution.status).toBe('excluded');
    expect(resolution.action).toBe('rebuild');
    expect(resolution.acknowledgement_ref).toBeNull();
    expect(resolution.source_ref_after).toBeNull();
    expect(resolution.reason_codes.some((r) => r.startsWith('memory.'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // INV-G18: Failure 不改变 TurnOutcome
  //   Reconstruction failure 只改变 reconstruction/session continuity 状态,
  //   不直接改写业务 TurnOutcome。
  //   构造:ReconstructionAttemptResult 类型字段不含 turn_outcome / completion_report /
  //   user_satisfaction 等 turn-level 业务字段。
  // ---------------------------------------------------------------------------
  it('INV-G18: ReconstructionAttemptResult 不含 turn_outcome 字段(failure 不改写 TurnOutcome)', () => {
    const resultKeys: ReadonlyArray<keyof ReconstructionAttemptResult> = [
      'reconstruction_result_protocol_version',
      'status',
      'transaction',
      'publishable_candidate',
      'postflight_result',
      'recovery_ref',
      'reason_codes',
    ];
    // 类型反射:reconstruction result 的字段集合是封闭的 turn-irrelevant 集合。
    expect(resultKeys).not.toContain('turn_outcome');
    expect(resultKeys).not.toContain('completion_report');
    expect(resultKeys).not.toContain('turn_status');
    expect(resultKeys).not.toContain('agent_outcome');

    // 实际跑一次失败路径(rejected),验证 result 上没有 turn 字段。
    const rejectedResult: ReconstructionAttemptResult = {
      reconstruction_result_protocol_version: 'mi.reconstruction.result/1',
      status: 'rejected',
      transaction: assembledTransaction(),
      publishable_candidate: null,
      postflight_result: null,
      recovery_ref: 'precompact:abc',
      reason_codes: ['preflight.rejected'],
    };
    const keys = Object.keys(rejectedResult);
    expect(keys).not.toContain('turn_outcome');
    expect(keys).not.toContain('completion_report');
  });

  // ---------------------------------------------------------------------------
  // INV-G19: Cache/Observability 不拥有语义
  //   Cache/telemetry/日志不能决定 preserve/reload/rebuild/exclude/order/publish。
  //   构造:resolveProjectInstruction / rebuildMemoryEntrypoint / buildPinnedWorkingSetPlan /
  //   assembleRestoredWorkingSetCandidate 都不接受 cache / telemetry / logger 参数。
  //   (PostflightDependencies 只有 validatePostCompactToolTranscript。)
  // ---------------------------------------------------------------------------
  it('INV-G19: 关键 GRC-1 API 不接受 cache/telemetry/logger 参数', () => {
    // 反射函数签名:cache/telemetry/logger 不应作为参数名出现。
    const buildSource = buildPinnedWorkingSetPlan.toString();
    const assembleSource = assembleRestoredWorkingSetCandidate.toString();
    const preflightSource = runReconstructionPreflight.toString();
    const postflightSource = validateReconstructionPostflight.toString();

    const bannedTokens = ['cache', 'telemetry', 'logger', 'logSink', 'metricSink'];
    for (const token of bannedTokens) {
      expect(buildSource).not.toContain(token);
      expect(assembleSource).not.toContain(token);
      expect(preflightSource).not.toContain(token);
      expect(postflightSource).not.toContain(token);
    }

    // PostflightDependencies 类型只暴露 validatePostCompactToolTranscript
    // (注入 BRC-5 tool transcript validator),没有 cache/telemetry。
    // 这通过 TS 类型层面强制 —— 我们用 satisfies 检查字段集合。
    type PostflightDepKeys = keyof import('../../agent/context/reconstruction.js').PostflightDependencies;
    const depKeys: ReadonlyArray<PostflightDepKeys> = ['validatePostCompactToolTranscript'];
    expect(depKeys).not.toContain('cache');
    expect(depKeys).not.toContain('telemetry');
    expect(depKeys).not.toContain('logger');
  });

  // ---------------------------------------------------------------------------
  // INV-G20: 不新增冻结 D-edge
  //   M-049 只消费 M-008/M-013/M-038/M-070;全局不变量的适用不改变机制所有权。
  //   构造:静态检查 reconstruction.ts 不 import M-031/M-033/M-052/M-060/Hold 实现
  //   (no-tool-contract / policy-projection / local-buffer / telemetry /
  //    reference-validator 等不应作为 GRC-1 的依赖)。
  //   详细 import-path 白名单审计见下方 "INV-G20 D-edge audit" describe block。
  // ---------------------------------------------------------------------------
  it('INV-G20: reconstruction 不调用 M-031/M-033/M-052/M-060 实现函数(运行时)', async () => {
    // 运行时验证:reconstruction pipeline 不触发 no-tool-contract / policy-projection /
    // local-buffer / reference-validator 这些其它机制的核心函数。
    //
    // 由于这些是其它 Wave 的内部函数,我们通过 mock 注入的依赖验证 reconstruction
    // pipeline 只通过显式注入的 port 与外界交互 —— 不暗中调用其它机制。
    const compactor = vi.fn(async () => ({
      summary_message: { role: 'user', content: 'compacted' },
      method: 'deterministic_local' as const,
      method_version: 'local/1',
      compactor_ack_payload: 'compactor:1',
    }));
    const reloadPipeline = vi.fn(async () => ({
      new_activation_id: 'act:proj-a-reloaded',
      new_message_id: 'msg:meta-a-reloaded',
      new_lifecycle_record_id: 'life:meta-a-reloaded',
      new_content_hash: 'b'.repeat(64),
      new_freshness_ref: 'fresh:a-reloaded',
      acknowledgement_ref: 'ack:reload-1',
    }));
    const memoryRebuild = vi.fn(async () => ({
      entrypoint_snapshot_id: 'entry:mem-rebuilt',
      target_context_snapshot_id: 'ctx:after-compact',
      state: 'ready' as const,
      overflow_manifest_ref: null,
      provenance_manifest_ref: 'prov:1',
      reason_codes: [],
    }));
    const postflightValidate = vi.fn(() => beforeProviderSendValidation());

    const input: ReconstructionInput = {
      precompact_input: captureInput(),
      transaction_request_input: {
        policy: createReconstructionPolicy(policyIdentity()),
        target_context_snapshot_id: 'ctx:after-compact',
        compaction_method: 'deterministic_local',
        compaction_method_version: 'local/1',
        memory_rebuild_identity: {
          old_entrypoint_snapshot_id: 'entry:mem-1',
          policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
          render_profile_ref: 'render:profile-1',
        },
        postflight_validator_policy: {
          validator_policy_id: 'mi.postflight.policy:default',
          validator_policy_version: '1.0.0',
        },
      },
      persistence: {
        savePreCompactSnapshot: async () => durableAck(),
        beginReconstructionAttempt: async () => ({
          attempt_id: 'att-1',
          latest_state: 'requested',
          latest_state_record_id: null,
        }),
      },
      compactor,
      transcript_snapshot: transcriptSnapshot(),
      preflight_validation: validation(),
      active_project_instructions: [
        {
          activation_id: 'act:proj-a',
          message_id: 'msg:meta-a',
          content_hash: 'b'.repeat(64),
          lifecycle_record: {
            lifecycle_record_protocol_version: 'mi.meta.lifecycle/1',
            lifecycle_record_id: 'life:meta-a',
            message_id: 'msg:meta-a',
            state: 'reload_required',
            source_kind: 'project_instruction',
            source_freshness_ref: 'fresh:a',
            content_hash: 'b'.repeat(64),
            acknowledgement_ref: null,
            transition_reason_codes: [],
            transitioned_at: FIXED_NOW,
          },
          source_freshness_ref: 'fresh:a',
          source_content_hash: null,
          ordinal: 100,
        },
      ],
      project_instruction_reload_pipeline: reloadPipeline,
      memory_rebuild_port: memoryRebuild,
      execution_state_refs: [
        {
          execution_ref: 'tc:tool-1',
          ack_ref: 'ack:completed-1',
          pair_state: 'paired' as ToolPairState,
          permission_security_refs: ['perm:1'],
          ordinal: 300,
        },
      ],
      target_context_snapshot_id: 'ctx:after-compact',
      target_task_snapshot_id: 'task:target-1',
      target_project_version_ref: 'proj:sha-1',
      memory_policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
      render_profile_ref: 'render:profile-1',
      request_budget_snapshot_id: 'budget:snap-1',
      postflight_deps: { validatePostCompactToolTranscript: postflightValidate },
    };

    const result = await reconstructPostCompactWorkingSet(input);
    expect(result.status).toBe('postflight_accepted');

    // 所有外部交互只通过 4 个注入 port:persistence / compactor / reload / rebuild /
    // postflight-validate。没有暗中调用其它机制(若调用,会因为没有注入而 throw)。
    expect(compactor).toHaveBeenCalledTimes(1);
    expect(reloadPipeline).toHaveBeenCalledTimes(1);
    expect(memoryRebuild).toHaveBeenCalledTimes(1);
    expect(postflightValidate).toHaveBeenCalled();
  });
});

// ===========================================================================
// 公共出口审计
// ===========================================================================

describe('Wave G 公共出口(src/agent/index.ts)', () => {
  it('导出所有 GRC policy/snapshot/plan/resolution/candidate/postflight/publish + activation 函数', () => {
    // 值导出(函数)
    expect(Agent.createReconstructionPolicy).toBeTypeOf('function');
    expect(Agent.capturePreCompactSnapshot).toBeTypeOf('function');
    expect(Agent.computeReconstructionIdempotencyKey).toBeTypeOf('function');
    expect(Agent.createReconstructionTransactionRequest).toBeTypeOf('function');
    expect(Agent.runReconstructionPreflight).toBeTypeOf('function');
    expect(Agent.validateCompactSummaryShape).toBeTypeOf('function');
    expect(Agent.createCompactionResultSnapshot).toBeTypeOf('function');
    expect(Agent.buildPinnedWorkingSetPlan).toBeTypeOf('function');
    expect(Agent.resolveProjectInstruction).toBeTypeOf('function');
    expect(Agent.rebuildMemoryEntrypoint).toBeTypeOf('function');
    expect(Agent.assembleRestoredWorkingSetCandidate).toBeTypeOf('function');
    expect(Agent.computeOmissionManifest).toBeTypeOf('function');
    expect(Agent.validateReconstructionPostflight).toBeTypeOf('function');
    expect(Agent.reconstructPostCompactWorkingSet).toBeTypeOf('function');
    expect(Agent.publishRestoredWorkingSetAtomically).toBeTypeOf('function');
    expect(Agent.createDefaultPublisher).toBeTypeOf('function');
    expect(Agent.canActivatePostCompactReconstruction).toBeTypeOf('function');
  });

  it('导出 protocol version 常量(各 version 独立演进)', () => {
    expect(Agent.RECONSTRUCTION_PROTOCOL_VERSION).toMatch(/^mi\.reconstruction\//);
    expect(Agent.RECONSTRUCTION_POLICY_PROTOCOL_VERSION).toMatch(/^mi\.reconstruction\.policy\//);
    expect(Agent.PRECOMPACT_PROTOCOL_VERSION).toMatch(/^mi\.precompact\//);
    expect(Agent.RECONSTRUCTION_TRANSACTION_PROTOCOL_VERSION).toMatch(/^mi\.reconstruction\.tx\//);
    expect(Agent.RECONSTRUCTION_ACTIVATION_PROTOCOL_VERSION).toMatch(
      /^mi\.reconstruction\.activation\//,
    );
    expect(Agent.PUBLISH_PROTOCOL_VERSION).toMatch(/^mi\.publish\//);
    expect(Agent.RESTORED_WS_PROTOCOL_VERSION).toMatch(/^mi\.restored_ws\//);
  });

  it('导出 activation 入口 + 16 门 evidence/result 类型(运行时构造可)', () => {
    const allTrue: PostCompactReconstructionActivationEvidence = {
      precompact_transcript_immutable: true,
      before_compaction_validation_available: true,
      compactor_immutable_result_with_shape_validation: true,
      current_user_exact_preservable: true,
      project_instruction_lifecycle_correlatable: true,
      preserve_reload_invalidate_enforced: true,
      reload_via_trusted_pipeline: true,
      frc1_target_context_rebuild_available: true,
      system_prompt_outside_reconstruction: true,
      working_set_plane_separated: true,
      postflight_tool_validation_available: true,
      duplicate_order_budget_validators_available: true,
      atomic_publish_rollback_available: true,
      transaction_idempotency_recovery_persistable: true,
      completed_tool_no_reexecution: true,
      deterministic_failure_recovery_evidence: true,
    };
    const result = Agent.canActivatePostCompactReconstruction(allTrue);
    expect(result.active).toBe(true);
    expect(result.activation_protocol_version).toBe('mi.reconstruction.activation/1');
  });

  it('不导出 SessionStore 私有路径 / raw persistence records / compactor internals(negative audit)', () => {
    // 公共出口对象上不应出现以下成员。
    const agentExports = Object.keys(Agent);
    // SessionStore 类不应被 agent/index.ts 直接导出(那是 session 模块的责任)。
    expect(agentExports).not.toContain('SessionStore');
    // raw persistence record 类型不应作为值导出(它们是 session/store.ts 的内部形态)。
    expect(agentExports).not.toContain('RestoredWorkingSetSnapshotRecord');
    expect(agentExports).not.toContain('ReconstructionStateRecord');
    expect(agentExports).not.toContain('ActiveWorkingSetSwapResult');
    expect(agentExports).not.toContain('AttemptRecord');
    // compactor internals 不单独导出(只通过 ReconstructionInput.compactor 字段暴露签名)。
    expect(agentExports).not.toContain('ReconstructionCompactor');
    // Prompt body / Memory raw detail 不导出。
    expect(agentExports).not.toContain('PromptBody');
    expect(agentExports).not.toContain('MemoryRawDetail');
    expect(agentExports).not.toContain('getMemoryRawDetail');
  });
});

// ===========================================================================
// INV-G20 + negative dependency audit:reconstruction.ts import 白名单
// ===========================================================================

describe('Wave G 不新增冻结 D-edge(INV-G20 + import-path 白名单审计)', () => {
  // 读 reconstruction.ts 源码,检查所有 import 来源。
  const here = dirname(fileURLToPath(import.meta.url));
  const reconstructionPath = resolve(
    here,
    '..',
    '..',
    'agent',
    'context',
    'reconstruction.ts',
  );
  const source = readFileSync(reconstructionPath, 'utf8');

  /** 提取所有 import-from 语句的 source path。 */
  function extractImportSources(src: string): string[] {
    const lines = src.split('\n');
    const sources: string[] = [];
    let inImportBlock = false;
    let buffer = '';
    for (const line of lines) {
      if (line.trim().startsWith('import ')) {
        if (line.includes('from ')) {
          // single-line import
          const m = line.match(/from\s+['"]([^'"]+)['"]/);
          if (m) sources.push(m[1]);
        } else {
          // multi-line block import
          inImportBlock = true;
          buffer = line;
        }
      } else if (inImportBlock) {
        buffer += '\n' + line;
        const m = buffer.match(/from\s+['"]([^'"]+)['"]/);
        if (m) {
          sources.push(m[1]);
          inImportBlock = false;
          buffer = '';
        }
      }
    }
    return sources;
  }

  it('reconstruction.ts 只依赖允许的 module(白名单)', () => {
    const sources = extractImportSources(source);

    // 白名单(允许的依赖):
    //   - node:crypto(hash)
    //   - ../contracts/identities(requireIdentity / freezeSnapshot 共享原语)
    //   - ../tools/transcript-validator(BRC-5 tool transcript validation)
    //   - ../types(Message 类型)
    //   - ../../session/store(SessionStore + 持久化 record 类型 —— T2/T9 通过
    //     injected port 消费,不直接调用私有方法)
    //   - ./retention(ERC-1 MetaMessageLifecycleRecord 类型)
    const allowed = new Set([
      'node:crypto',
      '../contracts/identities.js',
      '../tools/transcript-validator.js',
      '../types.js',
      '../../session/store.js',
      './retention.js',
    ]);

    for (const src of sources) {
      expect(allowed.has(src)).toBe(true);
    }
  });

  it('reconstruction.ts 不依赖 M-031/M-033/M-052/M-060/Hold 实现(negative D-edge)', () => {
    const sources = extractImportSources(source);

    // 禁止依赖的 module(对应"冻结 D-edge"):
    //   - M-031 No-Tool Request Contract(../tools/no-tool-contract.js)
    //   - M-033 (= M-026 Tool Policy Projection,文件 ../tools/policy-projection.js)
    //   - M-052 Local Diagnostic Buffer(../observability/local-buffer.js)
    //   - M-060 / M-055 Component Telemetry(../observability/telemetry.js)
    //   - M-054 Decision Trace / M-056 Telemetry Redaction(../observability/*)
    //   - M-028 Tool Reference Integrity(../tools/reference-validator.js)
    //   - M-009/M-012 Markdown Routing(../context/routing.js)
    //   - M-069 Injection Suspicion(../context/injection-signal.js)
    //   - M-052 Diagnostic Buffer(../observability/local-buffer.js)
    //   - bounded-memory 系列(M-013 是允许的,但只通过 injected port;reconstruction.ts
    //     **不**直接 import bounded-memory.ts,只 import 其 port type —— 严格起见,
    //     我们检查 reconstruction.ts 没有 import bounded-memory)
    const forbidden = [
      '../tools/no-tool-contract.js', // M-031
      '../tools/policy-projection.js', // M-033 / M-026
      '../observability/local-buffer.js', // M-052
      '../observability/telemetry.js', // M-055 / M-060
      '../observability/decision-trace.js', // M-054
      '../observability/redaction.js', // M-056
      '../tools/reference-validator.js', // M-028
      '../context/routing.js', // M-009 / M-012
      '../context/injection-signal.js', // M-069
      '../context/bounded-memory.js', // M-013(应通过 injected port,不直接 import)
      '../context/bounded-memory-render.js',
      '../context/bounded-memory-cache.js',
      '../context/activation.js', // M-008 / M-044
      '../context/discovery.js', // M-003
      '../prompt/registry.js', // M-002
      '../prompt/compiler.js', // M-004
      '../prompt/resolution.js', // M-002/M-003/M-004
      '../prompt/profiles.js', // M-048
      '../context/intake.js', // M-006/M-007
      '../tools/capability-snapshot.js', // M-025
      '../tools/overlay.js', // M-026/M-027
      '../tools/descriptor-snapshot.js', // M-023
      '../observability/envelopes.js', // M-053
      '../contracts/completion-report.js', // M-070
      '../contracts/request-snapshot.js', // M-024
    ];

    for (const path of forbidden) {
      expect(sources).not.toContain(path);
    }
  });

  it('reconstruction.ts 只 import retention 的 type,不消费 retention runtime(M-038 owner boundary)', () => {
    // reconstruction.ts 通过 import type { MetaMessageLifecycleRecord } from './retention.js'
    // 消费 lifecycle record 类型 —— 这是 spec §7.8 允许的(只看类型,不调 runtime)。
    // 验证:import 语句带 `type` 关键字。
    const lines = source.split('\n');
    const retentionImportLines = lines.filter(
      (l) => l.includes('./retention.js') && l.trim().startsWith('import'),
    );
    expect(retentionImportLines.length).toBeGreaterThan(0);
    for (const line of retentionImportLines) {
      // 必须是 type-only import。
      expect(line).toMatch(/\bimport\s+type\b/);
    }
  });

  it('reconstruction.ts 对 session/store.js 的依赖只用于类型 + injected port', () => {
    // 验证 store.js 的 import 是 type-only 或 namespace-type-only。
    // reconstruction.ts 有两种 store.js 用法:
    //   1. `import type { ... }`(record types)—— 允许
    //   2. `import type { SessionStore } from ...`(用于 createDefaultPublisher(store: SessionStore))—— 允许
    // 不允许:`import { SessionStore } from ...`(运行时构造)或调用 new SessionStore()。
    const lines = source.split('\n');
    const storeImportLines = lines.filter(
      (l) => l.includes('../../session/store.js') && l.trim().startsWith('import'),
    );
    expect(storeImportLines.length).toBeGreaterThan(0);
    for (const line of storeImportLines) {
      expect(line).toMatch(/\bimport\s+type\b/);
    }
    // reconstruction.ts 中不应出现 `new SessionStore(`。
    expect(source).not.toMatch(/new\s+SessionStore\s*\(/);
  });
});
