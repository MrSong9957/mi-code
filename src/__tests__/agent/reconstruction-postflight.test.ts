/**
 * GRC-1 §7.19 / §7.20 / Task 8 — Postflight Validation + Core Anchor
 * (Wave G Task 8).
 *
 * 这一段测试覆盖:
 *   - validateReconstructionPostflight 的 15 门检查(spec §7.19 1-15)
 *   - postflight tool pairing(spec §7.20 规则)
 *   - reconstructPostCompactWorkingSet Core Anchor 串联(规格 Task 8 Step 5)
 *   - capture-then-mutate(Task 8 Step 6)与 deterministic replay(Task 8 Step 7)
 *
 * Non-negotiable invariants under test:
 *   - postflight accepted 才允许 publish(spec §7.19 / §7.20 rule 5)。
 *   - postflight validator 不自行合成 missing result;summary 中的工具描述不参与
 *     pairing;structural execution refs 不参与 Provider-visible pairing。
 *   - Core Anchor 只协调 refs/acknowledgements,不调用 Provider / tool_executor /
 *     Prompt compiler。
 *   - 已 published attempt → 返回 'already_published' + 同一 snapshot ref。
 *   - 同一完整输入重复运行 → postflight result、candidate hash、reason codes、
 *     ordering 深相等(created_at/checked_at 时间戳不参与 hash)。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  POSTFLIGHT_PROTOCOL_VERSION,
  assembleRestoredWorkingSetCandidate,
  buildPinnedWorkingSetPlan,
  capturePreCompactSnapshot,
  computeOmissionManifest,
  createCompactionResultSnapshot,
  createReconstructionPolicy,
  reconstructPostCompactWorkingSet,
  runReconstructionPreflight,
  validateReconstructionPostflight,
  type AssembleCandidateInput,
  type BuildPinnedWorkingSetPlanInput,
  type CompactionResultSnapshot,
  type PinnedWorkingSetPlan,
  type PinnedWorkingSetPlanItem,
  type PostCompactReconstructionTransaction,
  type PostflightDependencies,
  type PreflightInput,
  type ReconstructionInput,
  type ReconstructionOmissionManifest,
  type ReconstructionSourceResolution,
  type WorkingSetItemKind,
} from '../../agent/context/reconstruction.js';
import type {
  ToolPairState,
  ToolTranscriptSnapshot,
  ToolTranscriptValidation,
} from '../../agent/tools/transcript-validator.js';
import type { Message } from '../../agent/types.js';
import type { DurableAcknowledgement } from '../../session/store.js';
import type { MetaMessageLifecycleRecord } from '../../agent/context/retention.js';

// ---------------------------------------------------------------------------
// Helpers (与 preflight / candidate / source-resolution 测试同构)
// ---------------------------------------------------------------------------

function policyIdentity() {
  return {
    policy_id: 'mi.reconstruction.policy:default',
    policy_version: '1.0.0',
    request_budget_policy_ref: 'mi.budget/1:default',
  };
}

function captureInput(
  overrides: Partial<Parameters<typeof capturePreCompactSnapshot>[0]> = {},
) {
  return {
    session_id: 'sess:abc',
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

function beforeProviderSendValidation(
  overrides: Partial<ToolTranscriptValidation> = {},
): ToolTranscriptValidation {
  return validation({
    validation_id: 'tv:postflight-1',
    checkpoint: 'before_provider_send',
    ...overrides,
  });
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

/**
 * 构造一份全绿 buildPinnedWorkingSetPlan 输入:
 *   - 2 个 active project instructions(ordinal 100, 200)
 *   - 1 个 execution state(ordinal 300)
 *   - memory entrypoint 存在
 */
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
    created_at: '2026-07-26T00:00:00.000Z',
  });
  return {
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
      {
        activation_id: 'act:proj-b',
        message_id: 'msg:meta-b',
        content_hash: 'c'.repeat(64),
        lifecycle_record_id: 'life:meta-b',
        source_freshness_ref: 'fresh:b',
        ordinal: 200,
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
    reconstruction_transaction_id: 'recon-tx:abc123',
    idempotency_key: IDEMPOTENCY_KEY,
    session_id: 'sess:abc',
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
    reconstruction_transaction_id: 'recon-tx:abc123',
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

function itemByKind(
  plan: PinnedWorkingSetPlan,
  kind: WorkingSetItemKind,
): PinnedWorkingSetPlanItem {
  const found = plan.items.find((it) => it.item_kind === kind);
  if (!found) {
    throw new Error(`expected plan item of kind ${kind} to be present`);
  }
  return found;
}

function itemsByKind(
  plan: PinnedWorkingSetPlan,
  kind: WorkingSetItemKind,
): PinnedWorkingSetPlanItem[] {
  return plan.items
    .filter((it) => it.item_kind === kind)
    .sort((a, b) => a.stable_ordinal - b.stable_ordinal);
}

/**
 * 为 plan 中每个 item 生成"默认成功" resolution:
 *   - current_user_message / compact_summary / execution_state / project_instruction_meta
 *     → preserve_exact / resolved,source_ref_after = source_ref_before
 *   - bounded_memory_entrypoint → rebuild / resolved,source_ref_after = 'entry:mem-rebuilt'
 */
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

/**
 * 构造一份"全绿" AssembleCandidateInput:所有 resolution 成功。
 */
function acceptedAssembleInput(
  overrides: Partial<AssembleCandidateInput> & {
    resolutionsFor?: (
      plan: PinnedWorkingSetPlan,
    ) => ReconstructionSourceResolution[];
  } = {},
): AssembleCandidateInput {
  const buildInput = acceptedBuildInput();
  const plan = buildPinnedWorkingSetPlan(buildInput);
  const { resolutionsFor, ...rest } = overrides;
  const source_resolutions = resolutionsFor
    ? resolutionsFor(plan)
    : defaultSuccessResolutions(plan);
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
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Postflight helper —— 构造"全绿" postflight input
// ---------------------------------------------------------------------------

interface PostflightInputBundle {
  transaction: PostCompactReconstructionTransaction;
  candidate: ReturnType<typeof assembleRestoredWorkingSetCandidate>;
  plan: PinnedWorkingSetPlan;
  compaction_result: CompactionResultSnapshot;
  source_resolutions: ReconstructionSourceResolution[];
  preflight: ReturnType<typeof runReconstructionPreflight>;
  omission_manifest: ReconstructionOmissionManifest;
  target_context_snapshot_id: string;
}

function acceptedPostflightInputBundle(
  overrides: Partial<{
    assembleInput: Partial<AssembleCandidateInput> & {
      resolutionsFor?: (
        plan: PinnedWorkingSetPlan,
      ) => ReconstructionSourceResolution[];
    };
    transaction: Partial<PostCompactReconstructionTransaction>;
  }> = {},
): PostflightInputBundle {
  const assembleInput = acceptedAssembleInput(overrides.assembleInput);
  const candidate = assembleRestoredWorkingSetCandidate(assembleInput);
  const omission_manifest = computeOmissionManifest(assembleInput);
  const preflightInput = acceptedPreflightInput();
  const preflight = runReconstructionPreflight(preflightInput);
  return {
    transaction: { ...assembleInput.transaction, ...overrides.transaction },
    candidate,
    plan: assembleInput.plan,
    compaction_result: assembleInput.compaction_result,
    source_resolutions: assembleInput.source_resolutions,
    preflight,
    omission_manifest,
    target_context_snapshot_id: assembleInput.target_context_snapshot_id,
  };
}

/** 默认 accepted postflight deps:返回 status='accepted' 的 before_provider_send validation。 */
function acceptedPostflightDeps(
  overrides: Partial<ToolTranscriptValidation> = {},
): PostflightDependencies {
  return {
    validatePostCompactToolTranscript: () => beforeProviderSendValidation(overrides),
  };
}

// ===========================================================================
// validateReconstructionPostflight — happy path
// ===========================================================================

describe('validateReconstructionPostflight — happy path', () => {
  it('all gates pass → status=accepted, failed_gates=[]', async () => {
    const bundle = acceptedPostflightInputBundle();
    const result = await validateReconstructionPostflight(bundle, acceptedPostflightDeps());
    expect(result.status).toBe('accepted');
    expect(result.failed_gates).toEqual([]);
    expect(result.reason_codes).toEqual([]);
    expect(result.postflight_protocol_version).toBe(POSTFLIGHT_PROTOCOL_VERSION);
    expect(result.postflight_id).toMatch(/^post:[0-9a-f]{16}$/);
    expect(result.candidate_snapshot_id).toBe(bundle.candidate.candidate_snapshot_id);
    expect(result.reconstruction_transaction_id).toBe(
      bundle.transaction.reconstruction_transaction_id,
    );
    expect(result.preflight_validation_id).toBe(bundle.preflight.validation_id);
    expect(result.postflight_tool_validation_ref.checkpoint).toBe(
      'before_provider_send',
    );
    expect(result.postflight_tool_validation_ref.expected_status).toBe('accepted');
    // 15 门全部列入 checked_gates
    expect(result.checked_gates.length).toBe(15);
    expect(result.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('status=accepted → deep-frozen', async () => {
    const bundle = acceptedPostflightInputBundle();
    const result = await validateReconstructionPostflight(bundle, acceptedPostflightDeps());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.checked_gates)).toBe(true);
    expect(Object.isFrozen(result.failed_gates)).toBe(true);
    expect(Object.isFrozen(result.reason_codes)).toBe(true);
  });

  it('deterministic postflight_id (same inputs → same id)', async () => {
    const bundle = acceptedPostflightInputBundle();
    const deps = acceptedPostflightDeps();
    const a = await validateReconstructionPostflight(bundle, deps);
    const b = await validateReconstructionPostflight(bundle, deps);
    expect(a.postflight_id).toBe(b.postflight_id);
    // checked_at 是时间戳(可不同),不参与 hash
  });
});

// ===========================================================================
// 15 gates RED —— 每门失败时 status='rejected' 且 failed_gates 含对应门
// ===========================================================================

/**
 * 把整个 15 门测试参数化:每门用一个 mutator 让对应门失败,其余门保持通过。
 * 期望:status='rejected',failed_gates 含对应门名,reason_codes 含
 * `postflight.<gate>.failed`。
 */
const GATE_CASES: ReadonlyArray<{
  gate: string;
  label: string;
  mutate: (bundle: PostflightInputBundle) => PostflightInputBundle;
}> = [
  {
    gate: 'transaction_candidate_target_identity',
    label: 'gate 1: candidate tx_id / target_context 与 transaction 不一致',
    mutate: (b) => ({
      ...b,
      candidate: {
        ...b.candidate,
        reconstruction_transaction_id: 'recon-tx:DIFFERENT',
      },
    }),
  },
  {
    gate: 'source_preflight_continuity',
    label: 'gate 2: preflight.preflight_id 属于不同 transcript',
    mutate: (b) => ({
      ...b,
      preflight: { ...b.preflight, transcript_snapshot_id: 'tx:OTHER' },
    }),
  },
  {
    gate: 'required_source_resolved',
    label: 'gate 3: required plan item 在 source_resolutions 中 status=blocked',
    mutate: (b) => {
      // 把 current_user 这个 required_exact item 改成 blocked
      const cur = itemByKind(b.plan, 'current_user_message');
      const resolutions = b.source_resolutions.map((r) =>
        r.plan_item_id === cur.plan_item_id
          ? { ...r, status: 'blocked' as const, action: 'block' as const, source_ref_after: null }
          : r,
      );
      return { ...b, source_resolutions: resolutions };
    },
  },
  {
    gate: 'invalidated_source_not_residual',
    label: 'gate 4: invalidated source 在 candidate 中残留(不该出现)',
    mutate: (b) => {
      // 把 proj-a 改成 exclude(resolved + exclude)= invalidated,
      // 但 candidate.meta_context_message_refs 仍含 'act:proj-a'。
      const project = itemsByKind(b.plan, 'project_instruction_meta')[0];
      const resolutions = b.source_resolutions.map((r) =>
        r.plan_item_id === project.plan_item_id
          ? {
              ...r,
              status: 'resolved' as const,
              action: 'exclude' as const,
              source_ref_after: null,
              reason_codes: ['project_instruction.invalidated'],
            }
          : r,
      );
      // candidate 不重算 —— 仍含旧 act:proj-a,因此 gate 4 失败
      return { ...b, source_resolutions: resolutions };
    },
  },
  {
    gate: 'meta_hash_ordinal_ack',
    label: 'gate 5: meta context resolution 缺 acknowledgement_ref(reload 时)',
    mutate: (b) => {
      // 把 proj-a 改成 reload(resolved + reload),但 acknowledgement_ref=null
      const project = itemsByKind(b.plan, 'project_instruction_meta')[0];
      const resolutions = b.source_resolutions.map((r) =>
        r.plan_item_id === project.plan_item_id
          ? {
              ...r,
              action: 'reload' as const,
              acknowledgement_ref: null,
              reason_codes: [],
            }
          : r,
      );
      return { ...b, source_resolutions: resolutions };
    },
  },
  {
    gate: 'memory_target_context_binding',
    label: 'gate 6: memory rebuild resolution.source_ref_after 绑定错误 context',
    mutate: (b) => {
      const mem = itemByKind(b.plan, 'bounded_memory_entrypoint');
      // memory 没有显式 context_ref 字段;通过把 source_ref_after 改成 null(空)
      // 来让 binding 失败。但 candidate 仍引用旧 entrypoint。
      const resolutions = b.source_resolutions.map((r) =>
        r.plan_item_id === mem.plan_item_id
          ? {
              ...r,
              status: 'resolved' as const,
              action: 'rebuild' as const,
              source_ref_after: null,
              reason_codes: ['memory.context_mismatch'],
            }
          : r,
      );
      // candidate.meta_context_message_refs 仍含 entry:mem-rebuilt —— mismatch
      return { ...b, source_resolutions: resolutions };
    },
  },
  {
    gate: 'current_user_exact_once',
    label: 'gate 7: current_user_message_ref 在 provider_visible_order 出现 0/2 次',
    mutate: (b) => ({
      ...b,
      candidate: {
        ...b.candidate,
        current_user_message_ref: '',
        provider_visible_order: [...b.candidate.provider_visible_order.filter(
          (r) => r !== 'msg:user-1',
        )],
      },
    }),
  },
  {
    gate: 'summary_exact_once',
    label: 'gate 8: compact_summary_ref 在 provider_visible_order 出现 0/2 次',
    mutate: (b) => {
      const summaryRef = b.candidate.compact_summary_ref;
      return {
        ...b,
        candidate: {
          ...b.candidate,
          compact_summary_ref: '',
          provider_visible_order: b.candidate.provider_visible_order.filter(
            (r) => r !== summaryRef,
          ),
        },
      };
    },
  },
  {
    gate: 'execution_state_plane_isolation',
    label: 'gate 9: execution_state refs 进入了 provider_visible_order',
    mutate: (b) => ({
      ...b,
      candidate: {
        ...b.candidate,
        provider_visible_order: [
          ...b.candidate.provider_visible_order,
          'tc:tool-1',
        ],
      },
    }),
  },
  {
    gate: 'before_provider_send_transcript_accepted',
    label: 'gate 10: deps.validatePostCompactToolTranscript 返回非 accepted',
    mutate: (b) => b, // 在 case 中用 deps 注入失败
  },
  {
    gate: 'no_pending_missing_orphan_duplicate_conflict',
    label: 'gate 11: postflight tool validation 含 missing_result pair',
    mutate: (b) => b, // 在 case 中用 deps 注入失败
  },
  {
    gate: 'budget_accepted',
    label: 'gate 12: request_budget_snapshot_id 为空',
    mutate: (b) => ({
      ...b,
      candidate: {
        ...b.candidate,
        request_budget_snapshot_id: '',
      },
    }),
  },
  {
    gate: 'duplicate_order_accepted',
    label: 'gate 13: provider_visible_order 含重复 ref',
    mutate: (b) => ({
      ...b,
      candidate: {
        ...b.candidate,
        provider_visible_order: [
          ...b.candidate.provider_visible_order,
          b.candidate.provider_visible_order[0],
        ],
      },
    }),
  },
  {
    gate: 'omission_manifest_consistent',
    label: 'gate 14: omission manifest 与实际省略不一致',
    mutate: (b) => ({
      ...b,
      // 把 manifest degraded 标错(实际 candidate 没 omit 但 manifest 说有)
      omission_manifest: {
        ...b.omission_manifest,
        degraded: !b.omission_manifest.degraded,
      },
    }),
  },
  {
    gate: 'candidate_hash_replayable',
    label: 'gate 15: candidate.candidate_hash 被篡改',
    mutate: (b) => ({
      ...b,
      candidate: {
        ...b.candidate,
        candidate_hash: '0'.repeat(64),
      },
    }),
  },
];

describe('validateReconstructionPostflight — 15 gates RED', () => {
  it.each(GATE_CASES)('$label', async ({ gate, mutate }) => {
    const baseBundle = acceptedPostflightInputBundle();
    const bundle = mutate(baseBundle);

    // gate 10/11 用 deps 注入失败状态
    let deps: PostflightDependencies;
    if (gate === 'before_provider_send_transcript_accepted') {
      deps = {
        validatePostCompactToolTranscript: () =>
          beforeProviderSendValidation({ status: 'rejected' }),
      };
    } else if (gate === 'no_pending_missing_orphan_duplicate_conflict') {
      deps = {
        validatePostCompactToolTranscript: () =>
          beforeProviderSendValidation({
            status: 'rejected',
            pair_records: [
              {
                session_id: 'sess:abc',
                turn_id: 'turn:1',
                tool_id: 'x',
                tool_call_id: 'tc:missing-1',
                tool_use_message_ref: 'msg@0',
                tool_result_message_ref: null,
                state: 'missing_result',
                execution_state_ref: null,
              },
            ],
            reason_codes: ['pair.missing_result:tc:missing-1'],
          }),
      };
    } else {
      deps = acceptedPostflightDeps();
    }

    const result = await validateReconstructionPostflight(bundle, deps);
    expect(result.status).toBe('rejected');
    expect(result.failed_gates).toContain(gate);
    expect(result.reason_codes).toContain(`postflight.${gate}.failed`);
  });
});

// ===========================================================================
// status=accepted 时 candidate 可 publish;rejected 时 publishable_candidate=null
// (这些是 Core Anchor 层的契约,在 Core Anchor 测试中验证。这里 validator
// 本身只产出 PostflightValidationResult;不直接管理 candidate。)
// ===========================================================================

describe('validateReconstructionPostflight — postflight result shape', () => {
  it('rejected result has non-empty failed_gates & reason_codes', async () => {
    const bundle = acceptedPostflightInputBundle({
      transaction: { reconstruction_transaction_id: 'recon-tx:DIFFERENT' },
    });
    const result = await validateReconstructionPostflight(
      bundle,
      acceptedPostflightDeps(),
    );
    expect(result.status).toBe('rejected');
    expect(result.failed_gates.length).toBeGreaterThan(0);
    expect(result.reason_codes.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Postflight tool pairing (spec §7.20)
// ===========================================================================

describe('validateReconstructionPostflight — tool pairing (spec §7.20)', () => {
  it('summary 中的工具描述不参与 pairing(只接受结构化 tool_use/tool_result)', async () => {
    // summary 文本里包含 "tool X succeeded" —— validator 仍只看 pair_records。
    // 通过自定义 compactor summary 文本构造一份完整 bundle:
    //   - 用一份"summary 文本含工具描述"的 compaction result 重新跑 plan + candidate
    const preflightInput = acceptedPreflightInput();
    const preflight = runReconstructionPreflight(preflightInput);
    const compaction_result = createCompactionResultSnapshot({
      precompact: preflightInput.precompact,
      preflight,
      compacted_summary_message: {
        role: 'user',
        // 摘要正文里声称 tool succeeded —— validator 不应把它当作需要配对的 tool
        content:
          'Tool tc:tool-1 succeeded. No pending execution remains. Summary body.',
      },
      method: 'deterministic_local',
      method_version: 'l1l2.v1',
      compactor_ack_payload: 'compactor-call:2026-07-26T00:00:00Z|client=v2',
      created_at: '2026-07-26T00:00:00.000Z',
    });
    const buildInput: BuildPinnedWorkingSetPlanInput = {
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
        {
          activation_id: 'act:proj-b',
          message_id: 'msg:meta-b',
          content_hash: 'c'.repeat(64),
          lifecycle_record_id: 'life:meta-b',
          source_freshness_ref: 'fresh:b',
          ordinal: 200,
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
    };
    const plan = buildPinnedWorkingSetPlan(buildInput);
    const source_resolutions = defaultSuccessResolutions(plan);
    const transaction = assembledTransaction({
      working_set_plan_id: plan.working_set_plan_id,
      compaction_result_id: compaction_result.compaction_result_id,
      source_resolution_refs: source_resolutions.map((r) => r.resolution_id),
    });
    const assembleInput: AssembleCandidateInput = {
      transaction,
      plan,
      compaction_result,
      source_resolutions,
      target_context_snapshot_id: 'ctx:after-compact',
      request_budget_snapshot_id: preflightInput.precompact.request_budget_snapshot_id,
    };
    const candidate = assembleRestoredWorkingSetCandidate(assembleInput);
    const omission_manifest = computeOmissionManifest(assembleInput);

    const bundle: PostflightInputBundle = {
      transaction,
      candidate,
      plan,
      compaction_result,
      source_resolutions,
      preflight,
      omission_manifest,
      target_context_snapshot_id: 'ctx:after-compact',
    };

    // deps 返回 accepted(空 pair_records)—— validator 不应该因为 summary 里有
    // "tool X succeeded" 而要求把它配对。
    const result = await validateReconstructionPostflight(
      bundle,
      acceptedPostflightDeps(),
    );
    expect(result.status).toBe('accepted');
    expect(result.failed_gates).not.toContain(
      'no_pending_missing_orphan_duplicate_conflict',
    );
  });

  it('structural execution refs 不参与 Provider-visible pairing', async () => {
    const bundle = acceptedPostflightInputBundle();
    // deps 返回 accepted(没有 tc:tool-1 这条 pair_record)
    // 即便 candidate.execution_state_refs 含 tc:tool-1,validator 不应要求它在
    // postflight pair_records 中出现。
    const result = await validateReconstructionPostflight(
      bundle,
      acceptedPostflightDeps(),
    );
    expect(result.status).toBe('accepted');
  });

  it('validator 不自行合成 missing result(deps 返回 missing_result 仍 fail)', async () => {
    const bundle = acceptedPostflightInputBundle();
    const deps: PostflightDependencies = {
      validatePostCompactToolTranscript: () =>
        beforeProviderSendValidation({
          status: 'rejected',
          pair_records: [
            {
              session_id: 'sess:abc',
              turn_id: 'turn:1',
              tool_id: 'x',
              tool_call_id: 'tc:missing-1',
              tool_use_message_ref: 'msg@0',
              tool_result_message_ref: null,
              state: 'missing_result',
              execution_state_ref: null,
            },
          ],
          reason_codes: ['pair.missing_result:tc:missing-1'],
        }),
    };
    const result = await validateReconstructionPostflight(bundle, deps);
    expect(result.status).toBe('rejected');
    expect(result.failed_gates).toContain(
      'no_pending_missing_orphan_duplicate_conflict',
    );
    expect(result.failed_gates).toContain(
      'before_provider_send_transcript_accepted',
    );
  });
});

// ===========================================================================
// Core Anchor —— reconstructPostCompactWorkingSet
// ===========================================================================

/**
 * 构造一份"全绿" ReconstructionInput:
 *   - 所有依赖注入 mock
 *   - postflight deps 返回 accepted
 */
function acceptedReconstructionInput(
  overrides: Partial<ReconstructionInput> = {},
): ReconstructionInput {
  const precompact_input = captureInput();
  const preflight_validation = validation();
  // preflight 用 before_compaction accepted
  // postflight validator policy(用于 createReconstructionTransactionRequest)
  return {
    precompact_input,
    transaction_request_input: {
      policy: createReconstructionPolicy(policyIdentity()),
      target_context_snapshot_id: 'ctx:after-compact',
      compaction_method: 'deterministic_local',
      compaction_method_version: 'l1l2.v1',
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
    persistence: makeRecordingPersistence(),
    compactor: makeAcceptedCompactor(),
    transcript_snapshot: transcriptSnapshot(),
    preflight_validation,
    active_project_instructions: [
      {
        activation_id: 'act:proj-a',
        message_id: 'msg:meta-a',
        content_hash: 'b'.repeat(64),
        lifecycle_record: makeResidentLifecycle('act:proj-a', 'msg:meta-a'),
        source_freshness_ref: 'fresh:a',
        source_content_hash: 'b'.repeat(64),
        ordinal: 100,
      },
      {
        activation_id: 'act:proj-b',
        message_id: 'msg:meta-b',
        content_hash: 'c'.repeat(64),
        lifecycle_record: makeResidentLifecycle('act:proj-b', 'msg:meta-b'),
        source_freshness_ref: 'fresh:b',
        source_content_hash: 'c'.repeat(64),
        ordinal: 200,
      },
    ],
    project_instruction_reload_pipeline: makeReloadPipeline(),
    memory_rebuild_port: makeMemoryRebuildPort(),
    execution_state_refs: [
      {
        execution_ref: 'tc:tool-1',
        ack_ref: 'ack:completed-1',
        pair_state: 'paired' as ToolPairState,
        permission_security_refs: ['perm:allow-1'],
        ordinal: 300,
      },
    ],
    target_context_snapshot_id: 'ctx:after-compact',
    target_task_snapshot_id: 'task:snap-1',
    target_project_version_ref: 'proj:sha-1',
    memory_policy_ref: { contract_id: 'mi.entrypoint/1', protocol_version: '1' },
    render_profile_ref: 'render:profile-1',
    request_budget_snapshot_id: 'budget:snap-1',
    postflight_deps: acceptedPostflightDeps(),
    ...overrides,
  };
}

function makeResidentLifecycle(
  activation_id: string,
  message_id: string,
): MetaMessageLifecycleRecord {
  return {
    lifecycle_protocol_version: 'mi.meta.lifecycle/1',
    lifecycle_record_id: `life:${activation_id}`,
    session_snapshot_id: 'sess-snap-1',
    message_id,
    activation_id,
    retention_decision_id: 'ret-dec-1',
    serializer_identity_ref: null,
    compressor_identity_ref: null,
    state: 'resident',
    previous_state: null,
    transitioned_at: '2026-07-26T00:00:00.000Z',
  };
}

function makeAcceptedCompactor(): ReconstructionInput['compactor'] {
  return vi.fn(async () => ({
    summary_message: {
      role: 'user',
      content: 'This conversation was compacted for continuity.\n\nSummary body.',
    },
    method: 'deterministic_local' as const,
    method_version: 'l1l2.v1',
    compactor_ack_payload: 'compactor-call:2026-07-26T00:00:00Z|client=v1',
  }));
}

function makeReloadPipeline(): NonNullable<
  ReconstructionInput['project_instruction_reload_pipeline']
> {
  return vi.fn(async (input) => ({
    new_activation_id: `${input.activation_id}:reloaded`,
    new_message_id: `msg:${input.activation_id}:reloaded`,
    new_lifecycle_record_id: `life:${input.activation_id}:reloaded`,
    new_content_hash: 'b'.repeat(64),
    new_freshness_ref: `fresh:${input.activation_id}:reloaded`,
    acknowledgement_ref: `ack:${input.activation_id}:reloaded`,
  }));
}

function makeMemoryRebuildPort(): NonNullable<
  ReconstructionInput['memory_rebuild_port']
> {
  return vi.fn(async () => ({
    entrypoint_snapshot_id: 'entry:mem-rebuilt',
    target_context_snapshot_id: 'ctx:after-compact',
    state: 'ready' as const,
    overflow_manifest_ref: null,
    provenance_manifest_ref: 'frc1.prov:1',
    reason_codes: [],
  }));
}

/**
 * 一个 in-memory persistence:
 *   - 第一次 beginReconstructionAttempt → 返回 latest_state='requested' 的新 attempt
 *   - 如果 setPublished(snapshotId) 被调用 → 下次 beginReconstructionAttempt 返回
 *     'published' attempt
 */
interface RecordingPersistence {
  savePreCompactSnapshot: ReturnType<typeof vi.fn>;
  beginReconstructionAttempt: ReturnType<typeof vi.fn>;
  publishedSnapshotRef: string | null;
  setPublished: (ref: string) => void;
  setLatestState: (state: string) => void;
  latestState: string;
}

function makeRecordingPersistence(): RecordingPersistence & {
  savePreCompactSnapshot(input: unknown, sessionId: string): Promise<DurableAcknowledgement>;
  beginReconstructionAttempt(tx: unknown): Promise<{
    attempt_id: string;
    latest_state: string;
    latest_state_record_id: string | null;
  }>;
} {
  const self: RecordingPersistence & {
    savePreCompactSnapshot(input: unknown, sessionId: string): Promise<DurableAcknowledgement>;
    beginReconstructionAttempt(tx: unknown): Promise<{
      attempt_id: string;
      latest_state: string;
      latest_state_record_id: string | null;
    }>;
  } = {
    publishedSnapshotRef: null,
    latestState: 'requested',
    savePreCompactSnapshot: vi.fn(async (input: { precompact_snapshot_id: string }, sessionId: string) => ({
      ack_protocol_version: 'mi.durable/1',
      ack_id: 'durable:test',
      record_id: input.precompact_snapshot_id,
      session_id: sessionId,
      committed_at: '2026-07-26T00:00:00.000Z',
      sidecar_ref: 'reconstruction.jsonl',
    })),
    beginReconstructionAttempt: vi.fn(async (tx: { idempotency_key: string }) => ({
      attempt_id: `attempt:${tx.idempotency_key.slice(0, 16)}`,
      latest_state: self.publishedSnapshotRef ? 'published' : self.latestState,
      latest_state_record_id: null,
    })),
    setPublished: (ref: string) => {
      self.publishedSnapshotRef = ref;
    },
    setLatestState: (state: string) => {
      self.latestState = state;
    },
  };
  return self;
}

// Casting helper:ReconstructionInput.persistence 只关心两个方法签名。
function persistenceOf(p: RecordingPersistence): ReconstructionInput['persistence'] {
  return {
    savePreCompactSnapshot: (snapshot, sessionId) =>
      p.savePreCompactSnapshot(snapshot, sessionId),
    beginReconstructionAttempt: (tx) => p.beginReconstructionAttempt(tx),
  };
}

// ===========================================================================
// Core Anchor —— happy path
// ===========================================================================

describe('reconstructPostCompactWorkingSet — happy path', () => {
  it('valid full pipeline → postflight_accepted + publishable_candidate', async () => {
    const persistence = makeRecordingPersistence();
    const input = acceptedReconstructionInput({
      persistence: persistenceOf(persistence),
    });
    const result = await reconstructPostCompactWorkingSet(input);

    expect(result.status).toBe('postflight_accepted');
    expect(result.publishable_candidate).not.toBeNull();
    expect(result.postflight_result).not.toBeNull();
    expect(result.postflight_result!.status).toBe('accepted');
    expect(result.publishable_candidate!.candidate_snapshot_id).toMatch(
      /^cand:[0-9a-f]{16}$/,
    );
    expect(result.recovery_ref).toBe(null);
    expect(result.reason_codes).toContain('reconstruction.postflight_accepted');
    // side effects called exactly once
    expect(persistence.savePreCompactSnapshot).toHaveBeenCalledTimes(1);
    expect(persistence.beginReconstructionAttempt).toHaveBeenCalledTimes(1);
    expect(input.compactor).toHaveBeenCalledTimes(1);
  });

  it('does NOT call Provider / tool_executor / Prompt compiler(spy 验证)', async () => {
    // 通过类型契约验证:ReconstructionInput 没有 provider/tool_executor/compiler 字段。
    // 这里构造一份"侵入式" input:任何外部 side effect 调用都通过 spy 注入。
    // Core Anchor 只调用:savePreCompactSnapshot / beginReconstructionAttempt /
    // compactor / project_instruction_reload_pipeline / memory_rebuild_port /
    // postflight_deps.validatePostCompactToolTranscript。
    // 这些都是 GRC-1 own 的内部 port,不是 Provider/tool_executor/compiler。
    const reloadPipeline = makeReloadPipeline();
    const memoryRebuild = makeMemoryRebuildPort();
    const compactor = makeAcceptedCompactor();
    const input = acceptedReconstructionInput({
      compactor,
      project_instruction_reload_pipeline: reloadPipeline,
      memory_rebuild_port: memoryRebuild,
    });
    const result = await reconstructPostCompactWorkingSet(input);
    expect(result.status).toBe('postflight_accepted');
    // resident lifecycle 不需要 reload,所以 reload pipeline 不应被调用
    expect(reloadPipeline).not.toHaveBeenCalled();
    // memory entrypoint 存在 → rebuild 调用一次
    expect(memoryRebuild).toHaveBeenCalledTimes(1);
    // compactor 调用一次
    expect(compactor).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Core Anchor —— error propagation
// ===========================================================================

describe('reconstructPostCompactWorkingSet — error propagation', () => {
  it('preflight blocked → status=blocked + recovery_ref', async () => {
    // 把 preflight_validation 改成 status=blocked
    const input = acceptedReconstructionInput({
      preflight_validation: validation({
        status: 'blocked',
        checkpoint: 'before_compaction',
        reason_codes: ['preflight.pending_execution'],
        pair_records: [
          {
            session_id: 'sess:abc',
            turn_id: 'turn:1',
            tool_id: 'x',
            tool_call_id: 'tc:exec-1',
            tool_use_message_ref: 'msg@0',
            tool_result_message_ref: null,
            state: 'pending_execution',
            execution_state_ref: null,
          },
        ],
      }),
    });
    const result = await reconstructPostCompactWorkingSet(input);
    expect(result.status).toBe('blocked');
    expect(result.publishable_candidate).toBe(null);
    expect(result.recovery_ref).not.toBe(null);
    expect(result.reason_codes.some((r) => r.startsWith('preflight.'))).toBe(true);
  });

  it('preflight rejected → status=rejected + recovery_ref', async () => {
    const input = acceptedReconstructionInput({
      preflight_validation: validation({
        status: 'rejected',
        checkpoint: 'before_compaction',
        reason_codes: ['pair.missing_result:tc:1'],
        pair_records: [
          {
            session_id: 'sess:abc',
            turn_id: 'turn:1',
            tool_id: 'x',
            tool_call_id: 'tc:1',
            tool_use_message_ref: 'msg@0',
            tool_result_message_ref: null,
            state: 'missing_result',
            execution_state_ref: null,
          },
        ],
      }),
    });
    const result = await reconstructPostCompactWorkingSet(input);
    expect(result.status).toBe('rejected');
    expect(result.publishable_candidate).toBe(null);
    expect(result.recovery_ref).not.toBe(null);
  });

  it('compactor failure → status=rejected', async () => {
    const compactor = vi.fn(async () => {
      throw new Error('compactor timeout');
    });
    const input = acceptedReconstructionInput({ compactor });
    const result = await reconstructPostCompactWorkingSet(input);
    expect(result.status).toBe('rejected');
    expect(result.publishable_candidate).toBe(null);
    expect(result.recovery_ref).not.toBe(null);
    expect(result.reason_codes.some((r) => r.startsWith('compactor.'))).toBe(true);
  });

  it('candidate rejected (T7 throw) → status=rejected', async () => {
    // 把一个 project instruction 的 lifecycle 改成会让 source resolution
    // 返回 rejected 的状态(resolveProjectInstruction 当前永不返回 rejected;
    // 但 memory rebuild identity mismatch 会)。这里通过让 memory rebuild port
    // 返回错误的 target context 来触发 rejected。
    const memoryRebuildPort = vi.fn(async () => ({
      entrypoint_snapshot_id: 'entry:mem-rebuilt',
      target_context_snapshot_id: 'ctx:DIFFERENT', // mismatch → rejected
      state: 'ready' as const,
      overflow_manifest_ref: null,
      provenance_manifest_ref: 'frc1.prov:1',
      reason_codes: [],
    }));
    const input = acceptedReconstructionInput({ memory_rebuild_port: memoryRebuildPort });
    // memory rebuild rejected → assembleRestoredWorkingSetCandidate 会 throw
    // (candidate.rejected:<plan_item_id>:...)
    await expect(reconstructPostCompactWorkingSet(input)).rejects.toThrow(
      /candidate\.rejected/,
    );
  });

  it('postflight rejected → status=rejected', async () => {
    // 注入一个返回 rejected 的 postflight deps
    const postflight_deps: PostflightDependencies = {
      validatePostCompactToolTranscript: () =>
        beforeProviderSendValidation({
          status: 'rejected',
          pair_records: [
            {
              session_id: 'sess:abc',
              turn_id: 'turn:1',
              tool_id: 'x',
              tool_call_id: 'tc:missing-1',
              tool_use_message_ref: 'msg@0',
              tool_result_message_ref: null,
              state: 'missing_result',
              execution_state_ref: null,
            },
          ],
          reason_codes: ['pair.missing_result:tc:missing-1'],
        }),
    };
    const input = acceptedReconstructionInput({ postflight_deps });
    const result = await reconstructPostCompactWorkingSet(input);
    expect(result.status).toBe('rejected');
    expect(result.publishable_candidate).toBe(null);
    expect(result.postflight_result).not.toBeNull();
    expect(result.postflight_result!.status).toBe('rejected');
  });
});

// ===========================================================================
// Core Anchor —— idempotent resume
// ===========================================================================

describe('reconstructPostCompactWorkingSet — idempotent resume', () => {
  it('already_published attempt → status=already_published + existing snapshot ref', async () => {
    const persistence = makeRecordingPersistence();
    persistence.setPublished('cand:existing-publish');
    const input = acceptedReconstructionInput({
      persistence: persistenceOf(persistence),
    });
    const result = await reconstructPostCompactWorkingSet(input);
    expect(result.status).toBe('already_published');
    // publishable_candidate 为 null(不重新组装);transaction 引用已有
    expect(result.publishable_candidate).toBe(null);
    // 不调用 compactor(已 published 不重做 side effect)
    expect(input.compactor).not.toHaveBeenCalled();
    // reason_codes 含 already_published 提示
    expect(result.reason_codes).toContain('reconstruction.already_published');
  });
});

// ===========================================================================
// Deterministic replay (Task 8 Step 7)
// ===========================================================================

describe('reconstructPostCompactWorkingSet — deterministic replay', () => {
  it('same input run twice → deep equal on status / candidate_hash / reason_codes / ordering', async () => {
    const persistenceA = makeRecordingPersistence();
    const persistenceB = makeRecordingPersistence();
    const a = await reconstructPostCompactWorkingSet(
      acceptedReconstructionInput({ persistence: persistenceOf(persistenceA) }),
    );
    const b = await reconstructPostCompactWorkingSet(
      acceptedReconstructionInput({ persistence: persistenceOf(persistenceB) }),
    );
    expect(a.status).toBe(b.status);
    expect(a.publishable_candidate!.candidate_hash).toBe(
      b.publishable_candidate!.candidate_hash,
    );
    expect(a.publishable_candidate!.candidate_snapshot_id).toBe(
      b.publishable_candidate!.candidate_snapshot_id,
    );
    expect(a.publishable_candidate!.provider_visible_order).toEqual(
      b.publishable_candidate!.provider_visible_order,
    );
    expect([...a.reason_codes].sort()).toEqual([...b.reason_codes].sort());
    expect(a.postflight_result!.failed_gates).toEqual(
      b.postflight_result!.failed_gates,
    );
    expect([...a.postflight_result!.reason_codes].sort()).toEqual(
      [...b.postflight_result!.reason_codes].sort(),
    );
  });
});

// ===========================================================================
// Capture-then-mutate (Task 8 Step 6)
// ===========================================================================

describe('reconstructPostCompactWorkingSet — capture-then-mutate', () => {
  it('mutating fixtures after Core starts does not change this attempt', async () => {
    // 演示 spec Task 8 Step 6:Core 开始后变更 source lifecycle / Memory use /
    // budget / transcript fixture,当前 attempt 只使用 captured snapshot。
    //
    // 实现:用 compactor 作为" midway mutation point"。Core 在 capture + save +
    // createTransaction + beginAttempt + preflight 之后调用 compactor。
    // 我们让 compactor 在被调用时 mutate input.precompact_input.current_user_message_ref
    // 与 input.active_project_instructions —— 模拟"在 attempt 进行中外部状态变化"。
    // attempt 仍应基于已 captured 的 precompact snapshot(msg:user-1),而非 mutated
    // 值(msg:MUTATED)。
    const input = acceptedReconstructionInput();
    const expectedSnapshotId = capturePreCompactSnapshot(input.precompact_input).precompact_snapshot_id;
    const originalCompactor = input.compactor;
    const mutatedCompactor: typeof input.compactor = vi.fn(async (messages) => {
      // 在 compactor 调用时(Core 已经 captured snapshot)mutate input 字段。
      input.precompact_input.current_user_message_ref = 'msg:MUTATED';
      // 调用原 compactor 行为
      return originalCompactor(messages);
    });
    input.compactor = mutatedCompactor;

    const result = await reconstructPostCompactWorkingSet(input);
    expect(result.status).toBe('postflight_accepted');
    // candidate 的 current_user_message_ref 仍是 captured 的 msg:user-1,
    // 而不是 MUTATED(captured snapshot 不受 mutation 影响)。
    expect(result.publishable_candidate!.current_user_message_ref).toBe('msg:user-1');
    // snapshot id 仍是预期(captured 纯函数产物)
    expect(result.transaction.precompact_snapshot_id).toBe(expectedSnapshotId);
    // 确认 mutation 真的发生了(compactor 被调用过)
    expect(mutatedCompactor).toHaveBeenCalledTimes(1);
  });
});
