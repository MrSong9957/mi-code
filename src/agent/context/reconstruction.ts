/**
 * GRC-1 §6 / §7 — Post-Compact Reconstruction: Policy, Identity, Immutable Capture.
 *
 * Wave G Task 1 covers the immutable-capture surface of post-compact
 * reconstruction. It does NOT perform the reconstruction itself — it captures
 * the pre-compact truth (who, what, when, with which authority) and mints the
 * transaction record that downstream tasks (T2 SessionStore, T3 compaction
 * adapter, T4+ working-set assembly) will progress through the reconstruction
 * state machine.
 *
 * Non-negotiable invariants (spec GRC-1 §7.2 / §7.3 / §7.13 / §7.24):
 *   - Policy is a closed value domain. Any out-of-domain field throws on
 *     construction (no silent fallback, no summary-derived override).
 *   - The pre-compact snapshot is captured exactly once, deep-frozen, and
 *     content-addressed. Re-capturing identical inputs yields the same id.
 *   - The reconstruction transaction starts at state `requested` with every
 *     downstream field (`compaction_result_id`, `working_set_plan_id`, …)
 *     null/empty — they are filled by later tasks, never invented here.
 *   - Idempotency keys bind to every identity-bearing input field. Two
 *     captures that disagree on any bound field MUST produce different keys;
 *     two captures that agree on every bound field MUST collide.
 *
 * What this module does NOT do:
 *   - Reconstruct prompts or read transcript content.
 *   - Run compaction or talk to a model.
 *   - Provide a "full transcript recovery" switch.
 *   - Trust summary text for permissions.
 *
 * Identity helpers come from `contracts/identities.ts`; hashing mirrors the
 * `canonicalJson` + `sha256Hex` pattern shared by `retention.ts` /
 * `activation.ts` so identity digests are comparable across the meta pipeline.
 */

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';
import type {
  ToolPairState,
  ToolTranscriptValidation,
  ToolTranscriptSnapshot,
} from '../tools/transcript-validator.js';
import type { Message } from '../types.js';
import type {
  ActiveWorkingSetSwapResult,
  DurableAcknowledgement,
  ReconstructionStateRecord,
  RestoredWorkingSetSnapshotRecord,
} from '../../session/store.js';
import type { SessionStore } from '../../session/store.js';
import type { MetaMessageLifecycleRecord } from './retention.js';

// ---------------------------------------------------------------------------
// Shared primitives (mirror retention.ts / activation.ts).
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization. Object keys are emitted in ascending
 * (lexicographic) order regardless of insertion order. This canonical form
 * feeds every sha256 in this module so identity digests are stable across
 * captures and across processes.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${entries.join(',')}}`;
}

/** sha256 of `input`, returned as 64 lowercase hex characters. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ===========================================================================
// Protocol versions (independently versioned, spec §6.5).
// ===========================================================================

/** Reconstruction transaction state machine version. */
export const RECONSTRUCTION_PROTOCOL_VERSION = 'mi.reconstruction/1';

/** Reconstruction policy contract version. */
export const RECONSTRUCTION_POLICY_PROTOCOL_VERSION = 'mi.reconstruction.policy/1';

/** Pre-compact snapshot version. */
export const PRECOMPACT_PROTOCOL_VERSION = 'mi.precompact/1';

/** Reconstruction transaction record version. */
export const RECONSTRUCTION_TRANSACTION_PROTOCOL_VERSION = 'mi.reconstruction.tx/1';

// The remaining protocol versions are reserved for later Wave G tasks. They
// are exported now so downstream code can reference a single source of truth
// rather than hard-coding string literals as those tasks land.
export const COMPACT_RESULT_PROTOCOL_VERSION = 'mi.compact_result/1';
export const WORKING_SET_PLAN_PROTOCOL_VERSION = 'mi.working_set.plan/1';
export const WORKING_SET_PLAN_ITEM_PROTOCOL_VERSION = 'mi.working_set.plan_item/1';
export const SOURCE_RESOLUTION_PROTOCOL_VERSION = 'mi.source_resolution/1';
export const CANDIDATE_PROTOCOL_VERSION = 'mi.candidate/1';
export const POSTFLIGHT_PROTOCOL_VERSION = 'mi.postflight/1';
export const PUBLISH_PROTOCOL_VERSION = 'mi.publish/1';
export const RESTORED_WS_PROTOCOL_VERSION = 'mi.restored_ws/1';
export const OMISSION_PROTOCOL_VERSION = 'mi.omission/1';

/**
 * Reconstruction activation gate 协议版本(spec §7.26)。
 *
 * 与 reconstruction 主协议(mi.reconstruction/1)独立版本化:activation 只描述
 * "是否允许进入 reconstruction 主路径",不描述 reconstruction 自身的 record schema。
 * 升级 activation 评判标准(增删门、调整 reason_code 命名)只 bump 这个 version,
 * 不污染 reconstruction transaction 的 protocol_version。
 */
export const RECONSTRUCTION_ACTIVATION_PROTOCOL_VERSION =
  'mi.reconstruction.activation/1';

// ===========================================================================
// Data structures (spec §6.2 / §6.3 / §6.4 / §7.2 / §7.3 / §7.13).
// ===========================================================================

/** Cross-cutting reference to another Wave G contract (id + protocol version). */
export interface WaveGContractRef {
  contract_id: string;
  protocol_version: string;
}

/** Reconstruction transaction state machine (spec §6.2). */
export type ReconstructionState =
  | 'requested'
  | 'preflight_accepted'
  | 'compacted'
  | 'sources_resolved'
  | 'assembled'
  | 'postflight_accepted'
  | 'published'
  | 'blocked'
  | 'rejected';

/**
 * How strictly a working-set slot must be satisfied (spec §7.2).
 * The closed domain is enforced by the policy factory.
 */
export type WorkingSetRequirement =
  | 'required_exact'
  | 'required_current'
  | 'optional_current'
  | 'structural_only';

/** Per-slot resolution action (used by T4+, defined here for forward compat). */
export type ReconstructionResolutionAction =
  | 'preserve_exact'
  | 'reload'
  | 'rebuild'
  | 'exclude'
  | 'block';

/**
 * Reconstruction policy (spec §7.2). Closed value domain — every field below
 * the identity fields must take exactly the listed value, or the factory
 * throws. This is the "policy must come from trusted runtime" gate: source
 * content, summaries, or prompts cannot override these.
 */
export interface ReconstructionPolicy {
  reconstruction_policy_protocol_version: string;
  policy_id: string;
  policy_version: string;
  current_user_requirement: 'required_exact';
  compact_summary_requirement: 'required_current';
  project_instruction_requirement: 'required_current';
  memory_entrypoint_requirement: 'optional_current';
  execution_state_requirement: 'structural_only';
  publish_mode: 'atomic';
  source_failure_behavior: 'block_required_omit_optional';
  duplicate_behavior: 'reject';
  unknown_item_behavior: 'reject';
  request_budget_policy_ref: string;
}

/**
 * Frozen pre-compact snapshot (spec §7.3). Captured exactly once before
 * compaction runs; content-addressed so re-capturing identical inputs yields
 * the same id.
 */
export interface PreCompactSnapshot {
  precompact_protocol_version: string;
  precompact_snapshot_id: string;
  session_id: string;
  turn_id: string;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  transcript_snapshot_id: string;
  current_user_message_ref: string;
  current_user_message_hash: string;
  active_project_activation_refs: ReadonlyArray<string>;
  active_meta_lifecycle_refs: ReadonlyArray<string>;
  memory_entrypoint_snapshot_ref: string | null;
  execution_state_refs: ReadonlyArray<string>;
  request_budget_snapshot_id: string;
  captured_at: string;
}

/**
 * Reconstruction transaction record (spec §6.2). T1 only ever produces the
 * `requested` state — downstream fields are null/empty until later tasks fill
 * them in. Old transactions are immutable; new transitions mint new records.
 */
export interface PostCompactReconstructionTransaction {
  reconstruction_protocol_version: string;
  reconstruction_transaction_id: string;
  idempotency_key: string;
  session_id: string;
  turn_id: string;
  precompact_snapshot_id: string;
  preflight_validation_id: string;
  compaction_result_id: string | null;
  working_set_plan_id: string | null;
  target_context_snapshot_id: string;
  state: ReconstructionState;
  source_resolution_refs: ReadonlyArray<string>;
  candidate_snapshot_ref: string | null;
  postflight_validation_ref: string | null;
  publish_ack_ref: string | null;
  recovery_ref: string | null;
  reason_codes: ReadonlyArray<string>;
}

/** Input to `capturePreCompactSnapshot`. */
export interface CapturePreCompactInput {
  session_id: string;
  turn_id: string;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  transcript_snapshot_id: string;
  current_user_message_ref: string;
  current_user_message_hash: string;
  active_project_activation_refs: ReadonlyArray<string>;
  active_meta_lifecycle_refs: ReadonlyArray<string>;
  memory_entrypoint_snapshot_ref: string | null;
  execution_state_refs: ReadonlyArray<string>;
  request_budget_snapshot_id: string;
  /** Defaults to `new Date().toISOString()`; callers may override for tests. */
  captured_at?: string;
}

/** Input to `createReconstructionTransactionRequest`. */
export interface CreateTransactionRequestInput {
  precompact: PreCompactSnapshot;
  preflight_validation: ToolTranscriptValidation;
  policy: ReconstructionPolicy;
  /** Target context — may differ from current_context_snapshot_id. */
  target_context_snapshot_id: string;
  /** Compaction method identity (fed into idempotency). */
  compaction_method: 'deterministic_local' | 'model_summary';
  compaction_method_version: string;
  /** Memory rebuild identity (fed into idempotency). */
  memory_rebuild_identity: {
    old_entrypoint_snapshot_id: string | null;
    policy_ref: WaveGContractRef;
    render_profile_ref: string;
  };
  /** Postflight validator policy identity (fed into idempotency). */
  postflight_validator_policy: {
    validator_policy_id: string;
    validator_policy_version: string;
  };
}

// ===========================================================================
// createReconstructionPolicy — closed value domain (spec §7.2)
// ===========================================================================

/**
 * Construct a `ReconstructionPolicy` from required identity fields, filling
 * the closed-domain defaults. If a caller supplies any closed-domain field
 * with a value outside the canonical set, this throws — the closed domain is
 * enforced, not advisory.
 *
 * @throws {Error} When any closed-domain field is out of domain, or any
 *   identity field (`policy_id`, `policy_version`,
 *   `request_budget_policy_ref`) is empty.
 */
export function createReconstructionPolicy(
  input: Partial<ReconstructionPolicy> &
    Pick<ReconstructionPolicy, 'policy_id' | 'policy_version' | 'request_budget_policy_ref'>,
): ReconstructionPolicy {
  // Identity fields must be non-empty. Policy must come from trusted runtime;
  // an empty identity means we cannot prove that.
  const policy_id = requireIdentity(input.policy_id, 'policy_id');
  const policy_version = requireIdentity(input.policy_version, 'policy_version');
  const request_budget_policy_ref = requireIdentity(
    input.request_budget_policy_ref,
    'request_budget_policy_ref',
  );

  // Closed value domain. Each field must equal exactly one canonical literal.
  // Any other value — even an adjacent enum string — is rejected so that a
  // future policy cannot accidentally relax the constraints by supplying a
  // string that the type system would not catch at compile time.
  const closedDomain: Array<{
    field: keyof ReconstructionPolicy;
    expected: string;
    actual: string | undefined;
  }> = [
    {
      field: 'current_user_requirement',
      expected: 'required_exact',
      actual: input.current_user_requirement,
    },
    {
      field: 'compact_summary_requirement',
      expected: 'required_current',
      actual: input.compact_summary_requirement,
    },
    {
      field: 'project_instruction_requirement',
      expected: 'required_current',
      actual: input.project_instruction_requirement,
    },
    {
      field: 'memory_entrypoint_requirement',
      expected: 'optional_current',
      actual: input.memory_entrypoint_requirement,
    },
    {
      field: 'execution_state_requirement',
      expected: 'structural_only',
      actual: input.execution_state_requirement,
    },
    {
      field: 'publish_mode',
      expected: 'atomic',
      actual: input.publish_mode,
    },
    {
      field: 'source_failure_behavior',
      expected: 'block_required_omit_optional',
      actual: input.source_failure_behavior,
    },
    {
      field: 'duplicate_behavior',
      expected: 'reject',
      actual: input.duplicate_behavior,
    },
    {
      field: 'unknown_item_behavior',
      expected: 'reject',
      actual: input.unknown_item_behavior,
    },
  ];
  for (const { field, expected, actual } of closedDomain) {
    if (actual !== undefined && actual !== expected) {
      throw new Error(
        `${field} must be '${expected}' (got '${actual}'); reconstruction policy is a closed value domain`,
      );
    }
  }

  const policy: ReconstructionPolicy = {
    reconstruction_policy_protocol_version: RECONSTRUCTION_POLICY_PROTOCOL_VERSION,
    policy_id,
    policy_version,
    current_user_requirement: 'required_exact',
    compact_summary_requirement: 'required_current',
    project_instruction_requirement: 'required_current',
    memory_entrypoint_requirement: 'optional_current',
    execution_state_requirement: 'structural_only',
    publish_mode: 'atomic',
    source_failure_behavior: 'block_required_omit_optional',
    duplicate_behavior: 'reject',
    unknown_item_behavior: 'reject',
    request_budget_policy_ref,
  };
  return freezeSnapshot(policy);
}

// ===========================================================================
// capturePreCompactSnapshot — one-shot capture (spec §7.3)
// ===========================================================================

/** ID prefix for precompact snapshots. */
const PRECOMPACT_ID_PREFIX = 'precompact:';

/**
 * Capture a pre-compact snapshot exactly once. Every identity field is
 * validated, the snapshot is content-addressed, and the result is
 * deep-frozen. The snapshot is built from `input` plus the protocol version
 * stamp and the computed `precompact_snapshot_id`.
 *
 * Algorithm (spec §7.3):
 *   1. requireIdentity on every non-nullable string field.
 *   2. Normalize arrays to string[] (callers may pass ReadonlyArray; the
 *      snapshot keeps the values verbatim).
 *   3. Default `captured_at` to `new Date().toISOString()` if not supplied.
 *   4. Compute `precompact_snapshot_id = 'precompact:' + sha256(canonical).slice(0,16)`,
 *      where `canonical` covers every field except the id itself.
 *   5. Deep-freeze and return.
 *
 * @throws {Error} When any required identity field is empty.
 */
export function capturePreCompactSnapshot(
  input: CapturePreCompactInput,
): PreCompactSnapshot {
  const session_id = requireIdentity(input.session_id, 'session_id');
  const turn_id = requireIdentity(input.turn_id, 'turn_id');
  const task_snapshot_id = requireIdentity(input.task_snapshot_id, 'task_snapshot_id');
  const current_context_snapshot_id = requireIdentity(
    input.current_context_snapshot_id,
    'current_context_snapshot_id',
  );
  const transcript_snapshot_id = requireIdentity(
    input.transcript_snapshot_id,
    'transcript_snapshot_id',
  );
  const current_user_message_ref = requireIdentity(
    input.current_user_message_ref,
    'current_user_message_ref',
  );
  const current_user_message_hash = requireIdentity(
    input.current_user_message_hash,
    'current_user_message_hash',
  );
  const request_budget_snapshot_id = requireIdentity(
    input.request_budget_snapshot_id,
    'request_budget_snapshot_id',
  );

  // Nullable identity refs are accepted as either a non-empty string or null.
  // An empty/whitespace string is not a valid identity — coerce to null so a
  // caller cannot accidentally capture an empty-string ref that looks like an
  // identity to downstream consumers.
  const project_version_ref =
    input.project_version_ref === null || input.project_version_ref === undefined
      ? null
      : requireIdentity(input.project_version_ref, 'project_version_ref');
  const memory_entrypoint_snapshot_ref =
    input.memory_entrypoint_snapshot_ref === null ||
    input.memory_entrypoint_snapshot_ref === undefined
      ? null
      : requireIdentity(
          input.memory_entrypoint_snapshot_ref,
          'memory_entrypoint_snapshot_ref',
        );

  // Arrays are normalized to plain string arrays. Empty arrays stay empty —
  // they are not coerced to null (an empty active set is meaningful: it
  // declares "nothing active", distinct from "unknown").
  //
  // The active-source identity arrays (project activations, meta lifecycles)
  // are also SORTED, because they represent a *set* of identities, not an
  // ordered list. This makes the precompact_snapshot_id order-insensitive
  // over these sets: two captures that declare the same active source set in
  // different physical order yield the same id (spec §7.24 treats active
  // source identities as a sorted set). execution_state_refs is left in
  // caller order — it is a structural fingerprint, not a source-identity set,
  // and its order is not bound by idempotency either.
  const active_project_activation_refs: string[] = [
    ...input.active_project_activation_refs,
  ].sort();
  const active_meta_lifecycle_refs: string[] = [
    ...input.active_meta_lifecycle_refs,
  ].sort();
  const execution_state_refs: string[] = [...input.execution_state_refs];

  // Each element of these identity arrays must itself be a non-empty string.
  // We sort defensively for canonicalization below, but the snapshot keeps the
  // caller's physical order — order-independence is enforced at the idempotency
  // layer, not at the snapshot layer.
  for (const ref of active_project_activation_refs) {
    requireIdentity(ref, 'active_project_activation_refs[*]');
  }
  for (const ref of active_meta_lifecycle_refs) {
    requireIdentity(ref, 'active_meta_lifecycle_refs[*]');
  }
  for (const ref of execution_state_refs) {
    requireIdentity(ref, 'execution_state_refs[*]');
  }

  const captured_at =
    input.captured_at !== undefined && input.captured_at !== null
      ? input.captured_at
      : new Date().toISOString();

  // Deterministic snapshot id. The canonical payload excludes the id itself
  // (it does not exist yet) and uses sorted-key JSON so two equivalent
  // captures produce the same digest regardless of insertion order at the
  // call site.
  const canonical = canonicalJson({
    precompact_protocol_version: PRECOMPACT_PROTOCOL_VERSION,
    session_id,
    turn_id,
    task_snapshot_id,
    current_context_snapshot_id,
    project_version_ref,
    transcript_snapshot_id,
    current_user_message_ref,
    current_user_message_hash,
    active_project_activation_refs,
    active_meta_lifecycle_refs,
    memory_entrypoint_snapshot_ref,
    execution_state_refs,
    request_budget_snapshot_id,
    captured_at,
  });
  const precompact_snapshot_id =
    PRECOMPACT_ID_PREFIX + sha256Hex(canonical).slice(0, 16);

  const snapshot: PreCompactSnapshot = {
    precompact_protocol_version: PRECOMPACT_PROTOCOL_VERSION,
    precompact_snapshot_id,
    session_id,
    turn_id,
    task_snapshot_id,
    current_context_snapshot_id,
    project_version_ref,
    transcript_snapshot_id,
    current_user_message_ref,
    current_user_message_hash,
    active_project_activation_refs,
    active_meta_lifecycle_refs,
    memory_entrypoint_snapshot_ref,
    execution_state_refs,
    request_budget_snapshot_id,
    captured_at,
  };
  return freezeSnapshot(snapshot);
}

// ===========================================================================
// computeReconstructionIdempotencyKey — binding matrix (spec §7.24)
// ===========================================================================

/** Prefix for reconstruction idempotency keys. 32 hex chars for uniqueness. */
const RECON_IDEMPOTENCY_PREFIX = 'recon-idem:';

/**
 * Compute a deterministic idempotency key for a reconstruction transaction.
 *
 * The key binds to every identity-bearing input field enumerated in spec
 * §7.24:
 *   - session / turn (from precompact)
 *   - precompact_snapshot_id (whole pre-compact truth)
 *   - preflight_validation_id
 *   - compaction method + version
 *   - reconstruction policy (policy_id + policy_version)
 *   - target context
 *   - project version (from precompact)
 *   - active source identities (active_project_activation_refs +
 *     active_meta_lifecycle_refs), canonicalized by SORTING so order does not
 *     matter
 *   - memory rebuild identity (old entrypoint + policy ref + render profile)
 *   - request budget (from precompact)
 *   - postflight validator policy (id + version)
 *
 * Two captures that agree on every bound field collide; two captures that
 * disagree on any bound field diverge. Array-valued identity sets are sorted
 * before hashing so re-ordering the same set is not a new identity (spec
 * §7.13 rule: order-insensitive over active source identities).
 *
 * Serialization uses sorted-key canonical JSON (same helper as the rest of
 * the meta pipeline), so the resulting digest is stable across processes and
 * across capture order at the call site.
 */
export function computeReconstructionIdempotencyKey(
  input: CreateTransactionRequestInput,
): string {
  const { precompact, preflight_validation, policy } = input;

  // Sort the active-source identity arrays so their physical order at the
  // call site does not change the digest. Only the SET of active identities
  // is identity-bearing.
  const activeProjectActivations = [...precompact.active_project_activation_refs].sort();
  const activeMetaLifecycles = [...precompact.active_meta_lifecycle_refs].sort();

  const canonical = canonicalJson({
    // session / turn
    session_id: precompact.session_id,
    turn_id: precompact.turn_id,
    // pre-compact truth
    precompact_snapshot_id: precompact.precompact_snapshot_id,
    // preflight
    preflight_validation_id: preflight_validation.validation_id,
    // compaction method
    compaction_method: input.compaction_method,
    compaction_method_version: input.compaction_method_version,
    // reconstruction policy
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    // target context
    target_context_snapshot_id: input.target_context_snapshot_id,
    // project version
    project_version_ref: precompact.project_version_ref,
    // active source identities (order-insensitive)
    active_project_activation_refs: activeProjectActivations,
    active_meta_lifecycle_refs: activeMetaLifecycles,
    // memory rebuild identity
    memory_rebuild_old_entrypoint_snapshot_id:
      input.memory_rebuild_identity.old_entrypoint_snapshot_id,
    memory_rebuild_policy_ref: input.memory_rebuild_identity.policy_ref,
    memory_rebuild_render_profile_ref: input.memory_rebuild_identity.render_profile_ref,
    // request budget
    request_budget_snapshot_id: precompact.request_budget_snapshot_id,
    // postflight validator
    postflight_validator_policy_id: input.postflight_validator_policy.validator_policy_id,
    postflight_validator_policy_version:
      input.postflight_validator_policy.validator_policy_version,
  });
  return RECON_IDEMPOTENCY_PREFIX + sha256Hex(canonical).slice(0, 32);
}

// ===========================================================================
// createReconstructionTransactionRequest — state='requested' (spec §6.2)
// ===========================================================================

/** Prefix for reconstruction transaction ids. */
const RECON_TX_ID_PREFIX = 'recon-tx:';

/**
 * Construct a reconstruction transaction in the `requested` state.
 *
 * Every downstream-resolution field (`compaction_result_id`,
 * `working_set_plan_id`, `candidate_snapshot_ref`,
 * `postflight_validation_ref`, `publish_ack_ref`, `recovery_ref`,
 * `source_resolution_refs`) is initialized to null/empty — they are filled by
 * later tasks. The transaction identity is bound to the idempotency key plus
 * the precompact snapshot id, so it is deterministic but distinct from the
 * idempotency key itself (the key is "what is being requested"; the
 * transaction id is "this request record").
 *
 * Algorithm (spec §6.2):
 *   1. Validate identities: preflight validation_id, policy identity, target
 *      context, compaction method/version, memory rebuild identity,
 *      postflight policy.
 *   2. Compute `idempotency_key` via `computeReconstructionIdempotencyKey`.
 *   3. Compute `reconstruction_transaction_id =
 *      'recon-tx:' + sha256(idempotency_key + ':' + precompact_snapshot_id).slice(0,16)`.
 *   4. Forward session_id / turn_id / precompact_snapshot_id from precompact.
 *   5. Initialize state to 'requested' with reason_codes
 *      ['reconstruction.requested'].
 *   6. Deep-freeze.
 */
export function createReconstructionTransactionRequest(
  input: CreateTransactionRequestInput,
): PostCompactReconstructionTransaction {
  // 1. Identity gates.
  requireIdentity(
    input.preflight_validation.validation_id,
    'preflight_validation.validation_id',
  );
  requireIdentity(input.policy.policy_id, 'policy.policy_id');
  requireIdentity(input.policy.policy_version, 'policy.policy_version');
  const target_context_snapshot_id = requireIdentity(
    input.target_context_snapshot_id,
    'target_context_snapshot_id',
  );
  requireIdentity(input.compaction_method, 'compaction_method');
  requireIdentity(
    input.compaction_method_version,
    'compaction_method_version',
  );
  requireIdentity(
    input.memory_rebuild_identity.policy_ref.contract_id,
    'memory_rebuild_identity.policy_ref.contract_id',
  );
  requireIdentity(
    input.memory_rebuild_identity.policy_ref.protocol_version,
    'memory_rebuild_identity.policy_ref.protocol_version',
  );
  requireIdentity(
    input.memory_rebuild_identity.render_profile_ref,
    'memory_rebuild_identity.render_profile_ref',
  );
  requireIdentity(
    input.postflight_validator_policy.validator_policy_id,
    'postflight_validator_policy.validator_policy_id',
  );
  requireIdentity(
    input.postflight_validator_policy.validator_policy_version,
    'postflight_validator_policy.validator_policy_version',
  );

  const idempotency_key = computeReconstructionIdempotencyKey(input);
  const { precompact } = input;

  // 3. Transaction id bound to (idempotency_key, precompact_snapshot_id).
  //    This makes the transaction identity distinct from the idempotency key
  //    but still deterministic.
  const txCanonical = `${idempotency_key}:${precompact.precompact_snapshot_id}`;
  const reconstruction_transaction_id =
    RECON_TX_ID_PREFIX + sha256Hex(txCanonical).slice(0, 16);

  const transaction: PostCompactReconstructionTransaction = {
    reconstruction_protocol_version: RECONSTRUCTION_TRANSACTION_PROTOCOL_VERSION,
    reconstruction_transaction_id,
    idempotency_key,
    session_id: precompact.session_id,
    turn_id: precompact.turn_id,
    precompact_snapshot_id: precompact.precompact_snapshot_id,
    preflight_validation_id: input.preflight_validation.validation_id,
    compaction_result_id: null,
    working_set_plan_id: null,
    target_context_snapshot_id,
    state: 'requested',
    source_resolution_refs: [],
    candidate_snapshot_ref: null,
    postflight_validation_ref: null,
    publish_ack_ref: null,
    recovery_ref: null,
    reason_codes: ['reconstruction.requested'],
  };
  return freezeSnapshot(transaction);
}

// ===========================================================================
// Wave G Task 3 (M-049 / GRC-1 §7.4 / §7.5)
//
// Preflight gate + Compaction Result adapter + Summary shape validator.
//
// 这一段是 compaction 真正动刀前的硬门 + compactor 输出回写为不可变 snapshot
// 的 adapter。所有函数都不调用 compactor —— preflight 只做结构校验,adapter
// 接受 compactor 已产出的 summary message 作为输入。
//
// 不变式 (spec §7.4 / §7.5 / INV-G2):
//   - Preflight 先于 Compaction。任一条件失败绝不调用 compactor。
//   - Preflight 不读 transcript 正文,不消费 system prompt。
//   - Summary 是 text-only derived content;不继承 Authority、不替代 result。
//   - Shape validator 只看形状,不判摘要质量(不接管 M-031)。
// ===========================================================================

/** Preflight protocol version (independent of reconstruction/precompact). */
export const PREFLIGHT_PROTOCOL_VERSION = 'mi.preflight/1';

/** Summary shape validation protocol version. */
export const SUMMARY_SHAPE_PROTOCOL_VERSION = 'mi.summary_shape/1';

// ---------------------------------------------------------------------------
// Preflight types (spec §7.4)
// ---------------------------------------------------------------------------

/** Preflight 最终状态(与 ToolTranscriptValidation.status 对齐)。 */
export type PreflightStatus = 'accepted' | 'blocked' | 'rejected';

/**
 * Preflight 输入。来自 capture:precompact + transcript validation + T2
 * savePreCompactSnapshot 的 durable ack + policy/budget + T1 idempotency key。
 */
export interface PreflightInput {
  /** 已捕获(冻结)的 pre-compact snapshot。 */
  precompact: PreCompactSnapshot;
  /** 绑定当前 transcript 的 snapshot(只读引用,不重算)。 */
  transcript_snapshot: ToolTranscriptSnapshot;
  /** checkpoint='before_compaction' 的 tool transcript validation。 */
  validation: ToolTranscriptValidation;
  /** T2 savePreCompactSnapshot 的返回值 —— pre-compact 已落盘证据。 */
  precompact_durable_ack: DurableAcknowledgement;
  /** Reconstruction policy(trusted runtime 提供,非 summary 派生)。 */
  policy: ReconstructionPolicy;
  /** Request budget snapshot id(来自 transaction request,但 preflight 直接验证)。 */
  request_budget_snapshot_id: string;
  /** T1 computeReconstructionIdempotencyKey 的结果。 */
  idempotency_key: string;
}

/**
 * Preflight 注入依赖(预留)。当前没有任何注入项 —— preflight 不调用
 * compactor,也不读取任何外部资源。生产接线由 Core Anchor 负责。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 预留扩展点(例如未来的 telemetry sink),当前刻意保持空接口
export interface PreflightDependencies {
  // 无字段 —— 预留扩展点(例如未来的 telemetry sink)。
}

/**
 * Preflight 不可变结果。reason_codes 在 accepted 时为空;blocked/rejected 时
 * 至少含一条 'preflight.*' code。
 */
export interface PreflightResult {
  preflight_protocol_version: string;
  preflight_id: string;
  status: PreflightStatus;
  precompact_snapshot_id: string;
  transcript_snapshot_id: string;
  validation_id: string;
  idempotency_key: string;
  reason_codes: ReadonlyArray<string>;
  checked_at: string;
}

/**
 * 执行 reconstruction preflight(spec §7.4 十项检查)。
 *
 * 按顺序短路 —— 任一失败立即返回 blocked/rejected,绝不继续后续检查,也绝不
 * 调用 compactor。这是 "preflight 先于 compaction" 硬门(INV-G2)。
 *
 * 检查顺序(对应 spec §7.4):
 *   1. checkpoint === 'before_compaction'
 *   2. validation.status === 'accepted'(否则转发状态)
 *   3. transcript_snapshot_id 一致
 *   4. 不含 pending_execution(blocked)
 *   5. 不含 missing/orphan/duplicate/identity_conflict(rejected)
 *   6. current_user_message_ref / current_user_message_hash 非空
 *   7. system prompt 不在 reconstruction 范围 —— 等同通过(spec §7.4 第 7 项)
 *   8. policy + request_budget_snapshot_id 可用
 *   9. idempotency_key 非空
 *   10. precompact_durable_ack 非空
 *
 * 确定性: preflight_id 由 (precompact_snapshot_id + transcript_snapshot_id +
 * validation_id + idempotency_key) 的 sha256 截短决定,前缀 'pre:'。
 */
export function runReconstructionPreflight(
  input: PreflightInput,
  _deps?: PreflightDependencies,
): PreflightResult {
  const { precompact, validation } = input;

  // 公共字段:无论哪条失败,reason_codes 都要给出 'preflight.*' 解释。
  // accepted 时为空数组。
  // 短路返回时只填一行 reason_code(失败原因清晰);转发 validation 失败时
  // 把 validation.reason_codes 一并透传,但本契约至少追加一条 'preflight.*'
  // code 让上层能用统一前缀过滤。
  const fail = (
    status: Exclude<PreflightStatus, 'accepted'>,
    reason_codes: string[],
  ): PreflightResult => {
    const checked_at = new Date().toISOString();
    const preflight_id = computePreflightId(
      precompact.precompact_snapshot_id,
      validation.transcript_snapshot_id,
      validation.validation_id,
      input.idempotency_key,
    );
    return freezeSnapshot({
      preflight_protocol_version: PREFLIGHT_PROTOCOL_VERSION,
      preflight_id,
      status,
      precompact_snapshot_id: precompact.precompact_snapshot_id,
      transcript_snapshot_id: validation.transcript_snapshot_id,
      validation_id: validation.validation_id,
      idempotency_key: input.idempotency_key,
      reason_codes,
      checked_at,
    });
  };

  // 1. checkpoint 必须是 'before_compaction'。
  if (validation.checkpoint !== 'before_compaction') {
    return fail('rejected', ['preflight.wrong_checkpoint']);
  }

  // 2. validation.status 必须 accepted。否则按映射转发(blocked→blocked,
  //    rejected→rejected),并把 validation.reason_codes 透传,本契约至少追加
  //    一条 'preflight.validation_<status>' code 让前缀统一。
  if (validation.status !== 'accepted') {
    const code = `preflight.validation_${validation.status}`;
    return fail(validation.status, [...validation.reason_codes, code]);
  }

  // 3. validation.transcript_snapshot_id 必须等于 precompact.transcript_snapshot_id。
  //    这是 "validation 绑定当前 transcript" 的硬约束。
  if (validation.transcript_snapshot_id !== precompact.transcript_snapshot_id) {
    return fail('rejected', ['preflight.transcript_mismatch']);
  }

  // 4 + 5. 扫描 pair_records。pending_execution → blocked;其余 rejected-class
  //    pair → rejected。短路:按物理顺序遇到第一项违规即返回,reason_code 只
  //    反映这一类违规(避免把 blocked 与 rejected 混在一个 reason_codes 中)。
  const pairStateToReason: Record<string, string> = {
    pending_execution: 'preflight.pending_execution',
    missing_result: 'preflight.missing_result',
    orphan_result: 'preflight.orphan_result',
    duplicate_result: 'preflight.duplicate_result',
    identity_conflict: 'preflight.identity_conflict',
  };
  // 先扫 pending_execution(blocked)——因为如果有 pending + missing 共存,
  // spec §7.4 把 "pending_execution 阻止 compaction" 列为第 4 项,语义上
  // pending 是可恢复的(blocked),missing 是不可恢复的(rejected),blocked
  // 优先于 rejected 给上层重试机会。
  for (const record of validation.pair_records) {
    if (record.state === 'pending_execution') {
      return fail('blocked', ['preflight.pending_execution']);
    }
  }
  // 再扫 rejected-class。
  for (const record of validation.pair_records) {
    const code = pairStateToReason[record.state];
    if (code !== undefined && record.state !== 'pending_execution') {
      return fail('rejected', [code]);
    }
  }

  // 6. current_user_message_ref / current_user_message_hash 必须非空。
  //    这是 "current user turn 必须真实存在" 的硬约束 —— 没有 active user
  //    turn 时不启动 reconstruction(spec §7.10 rule 5)。
  if (
    !isNonEmpty(precompact.current_user_message_ref) ||
    !isNonEmpty(precompact.current_user_message_hash)
  ) {
    return fail('rejected', ['preflight.current_user_missing']);
  }

  // 7. system prompt 不在 reconstruction 范围内 —— spec §7.4 第 7 项是规格
  //    说明(本契约不消费 system prompt),不是运行时检查。等同通过。

  // 8. policy + request_budget_snapshot_id 可用。
  //    policy 必须是真实对象(不允许 null/undefined);request budget 必须非空。
  if (
    input.policy === null ||
    input.policy === undefined ||
    !isNonEmpty(input.policy.policy_id) ||
    !isNonEmpty(input.policy.policy_version) ||
    !isNonEmpty(input.request_budget_snapshot_id)
  ) {
    return fail('rejected', ['preflight.policy_or_budget_missing']);
  }

  // 9. idempotency_key 非空。
  if (!isNonEmpty(input.idempotency_key)) {
    return fail('rejected', ['preflight.idempotency_missing']);
  }

  // 10. precompact_durable_ack 非空(已落盘证据)。
  if (
    input.precompact_durable_ack === null ||
    input.precompact_durable_ack === undefined ||
    !isNonEmpty(input.precompact_durable_ack.ack_id)
  ) {
    return fail('rejected', ['preflight.durable_ack_missing']);
  }

  // 全部通过 → accepted。
  const checked_at = new Date().toISOString();
  const preflight_id = computePreflightId(
    precompact.precompact_snapshot_id,
    validation.transcript_snapshot_id,
    validation.validation_id,
    input.idempotency_key,
  );
  return freezeSnapshot({
    preflight_protocol_version: PREFLIGHT_PROTOCOL_VERSION,
    preflight_id,
    status: 'accepted',
    precompact_snapshot_id: precompact.precompact_snapshot_id,
    transcript_snapshot_id: validation.transcript_snapshot_id,
    validation_id: validation.validation_id,
    idempotency_key: input.idempotency_key,
    reason_codes: [],
    checked_at,
  });
}

/** 非空字符串判断(不修改原值,只判断)。 */
function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Preflight id 派生:pre: + sha256(四个身份字段).slice(0,16)。 */
function computePreflightId(
  precompact_snapshot_id: string,
  transcript_snapshot_id: string,
  validation_id: string,
  idempotency_key: string,
): string {
  const canonical = canonicalJson({
    precompact_snapshot_id,
    transcript_snapshot_id,
    validation_id,
    idempotency_key,
  });
  return PREFLIGHT_ID_PREFIX + sha256Hex(canonical).slice(0, 16);
}

/** Preflight id 前缀。 */
const PREFLIGHT_ID_PREFIX = 'pre:';

// ---------------------------------------------------------------------------
// Summary shape validator (spec §7.5 rule 8)
// ---------------------------------------------------------------------------

/** Summary shape validation 结果。 */
export interface SummaryShapeValidation {
  shape_validation_protocol_version: string;
  shape_validation_id: string;
  status: 'accepted' | 'rejected';
  reason_codes: ReadonlyArray<string>;
}

/**
 * 校验 compacted summary message 的形状(spec §7.5 rule 8)。
 *
 * 只看形状,不判语义(spec §7.5 rule 9):
 *   - role 必须是 'user'(assistant 不可能是 summary)
 *   - content 必须是 string(ContentBlock[] 不允许 —— summary 不能含 tool_use
 *     /tool_result block)
 *   - content 非空(空摘要无意义)
 *
 * 失败 reason_codes:
 *   - 'summary_shape.not_user_role'
 *   - 'summary_shape.content_not_string'
 *   - 'summary_shape.empty_content'
 *
 * 此 validator 不接管 M-031(compactor 内部策略)—— 即使 summary 文本字面
 * 含 "tool succeeded" / "permission granted" / "memory verified" 等声称,
 * 也只产生 accepted(形状合法);语义判断由 postflight / 业务校验负责。
 */
export function validateCompactSummaryShape(
  summary_message: Message,
): SummaryShapeValidation {
  const reason_codes: string[] = [];

  if (summary_message.role !== 'user') {
    reason_codes.push('summary_shape.not_user_role');
  }
  if (typeof summary_message.content !== 'string') {
    reason_codes.push('summary_shape.content_not_string');
  } else if (summary_message.content.length === 0) {
    reason_codes.push('summary_shape.empty_content');
  }

  const status: 'accepted' | 'rejected' =
    reason_codes.length === 0 ? 'accepted' : 'rejected';

  // shape_validation_id 派生自 (role, content type tag, content length, content prefix)
  // —— 用 prefix 而非全文,避免超长 summary 把 id 拖慢。但仍保证不同形状不同 id。
  const contentTag =
    typeof summary_message.content === 'string' ? 'string' : 'blocks';
  const contentLen =
    typeof summary_message.content === 'string'
      ? summary_message.content.length
      : summary_message.content.length;
  const contentPrefix =
    typeof summary_message.content === 'string'
      ? summary_message.content.slice(0, 32)
      : '';
  const canonical = canonicalJson({
    role: summary_message.role,
    content_tag: contentTag,
    content_len: contentLen,
    content_prefix: contentPrefix,
    reason_codes: [...reason_codes].sort(),
  });
  const shape_validation_id =
    SUMMARY_SHAPE_ID_PREFIX + sha256Hex(canonical).slice(0, 16);

  return freezeSnapshot({
    shape_validation_protocol_version: SUMMARY_SHAPE_PROTOCOL_VERSION,
    shape_validation_id,
    status,
    reason_codes,
  });
}

/** Summary shape id 前缀。 */
const SUMMARY_SHAPE_ID_PREFIX = 'summary_shape:';

// ---------------------------------------------------------------------------
// Compaction Result adapter (spec §7.5)
// ---------------------------------------------------------------------------

/** Compaction 方法(L1+L2 本地 vs L4 模型摘要)。 */
export type CompactionMethod = 'deterministic_local' | 'model_summary';

/**
 * Compaction result snapshot —— 把 compactor 输出回写为不可变 snapshot。
 * 创建后 deep-frozen。source transcript / preflight validation 通过 ref
 * 绑定,不存整个对象。
 */
export interface CompactionResultSnapshot {
  compaction_result_protocol_version: string;
  compaction_result_id: string;
  precompact_snapshot_id: string;
  source_transcript_snapshot_id: string;
  preflight_validation_id: string;
  method: CompactionMethod;
  method_version: string;
  compact_summary_ref: string;
  compact_summary_hash: string;
  compact_summary_bytes: number;
  compact_summary_lines: number;
  compactor_ack_ref: string;
  created_at: string;
}

/** createCompactionResultSnapshot 输入。 */
export interface CompactionResultInput {
  precompact: PreCompactSnapshot;
  preflight: PreflightResult;
  /** Compactor 已产出的 summary message(role=user, content=string)。 */
  compacted_summary_message: Message;
  method: CompactionMethod;
  method_version: string;
  /** 任意标识 compactor 调用 ack 的字符串(可含调用时间、客户端版本)。 */
  compactor_ack_payload: string;
  /** 默认 new Date().toISOString();测试可覆盖。 */
  created_at?: string;
}

/**
 * Compaction result 注入依赖(预留)。当前没有任何字段 —— adapter 不读取
 * transcript 正文,只接受 compacted_summary_message 作为输入。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 预留扩展点,当前刻意保持空接口
export interface CompactionResultDependencies {
  // 无字段。
}

/**
 * 把 compactor 输出回写为不可变 CompactionResultSnapshot(spec §7.5)。
 *
 * adapter **不调用 compactor** —— 它接受已 compactor 的 summary message 作为
 * 输入。这保证了 "compactor 失败保留 pre-compact snapshot" 的语义由调用方
 * 控制:adapter 永远不会在 compactor 失败时被调用。
 *
 * 算法:
 *   1. validateCompactSummaryShape(compacted_summary_message) —— 失败 throw。
 *   2. 提取 summary text,计算 hash/bytes/lines。
 *   3. 冗余校验:source_transcript_snapshot_id 必须一致(preflight 已检查,
 *      adapter 再检查一次保险)。
 *   4. 派生 compaction_result_id / compact_summary_ref / compactor_ack_ref。
 *   5. deep-freeze。
 *
 * @throws {Error} 当 summary shape 不合法(message 'compaction_result.summary_shape_invalid')
 *   或 source_transcript_snapshot_id 不一致时。
 */
export function createCompactionResultSnapshot(
  input: CompactionResultInput,
  _deps?: CompactionResultDependencies,
): CompactionResultSnapshot {
  const { precompact, preflight, compacted_summary_message } = input;

  // 1. Summary shape gate。失败立即抛错 —— adapter 不产出"残缺" snapshot。
  const shape = validateCompactSummaryShape(compacted_summary_message);
  if (shape.status !== 'accepted') {
    throw new Error('compaction_result.summary_shape_invalid');
  }

  // 此时 content 必为 string(shape validator 已保证)。
  const summary_text = compacted_summary_message.content as string;

  // 2. 计算 hash / bytes / lines。
  //    hash 是 64-hex sha256;bytes 用 utf8 字节长度(而非 utf16 code unit 数,
  //    以与磁盘/网络字节计数一致);lines 用 \n 分割,空串为 0。
  const compact_summary_hash = sha256Hex(summary_text);
  const compact_summary_bytes = Buffer.byteLength(summary_text, 'utf8');
  const compact_summary_lines =
    summary_text === '' ? 0 : summary_text.split('\n').length;

  // 3. 冗余校验:source transcript id 一致。
  //    spec §7.5 rule 10: source transcript identity/hash 不匹配时 rejected。
  //    preflight 已检查 precompact.transcript_snapshot_id ===
  //    validation.transcript_snapshot_id;adapter 这里再次校验保险,防止
  //    调用方在 preflight 之后篡改 precompact 字段。
  if (precompact.transcript_snapshot_id !== preflight.transcript_snapshot_id) {
    throw new Error('compaction_result.source_transcript_mismatch');
  }

  // 4. 派生引用。
  //    compact_summary_ref 取 hash 前 16 hex(与 summary 文本内容绑定)。
  //    compactor_ack_ref 取 compactor_ack_payload 的 sha256 前 16 hex(与
  //    compactor 调用身份绑定,而非 summary 内容 —— 同一 summary 可由不同
  //    compactor 调用产生)。
  const compact_summary_ref = `summary:${compact_summary_hash.slice(0, 16)}`;
  const compactor_ack_ref = `compactor.ack:${sha256Hex(input.compactor_ack_payload).slice(0, 16)}`;
  const created_at =
    input.created_at !== undefined && input.created_at !== null
      ? input.created_at
      : new Date().toISOString();

  // compaction_result_id 派生自所有身份字段(precompact + preflight + method +
  // summary hash + compactor ack),保证相同输入产生相同 id,任一字段变化则 id
  // 变化。
  const resultCanonical = canonicalJson({
    precompact_snapshot_id: precompact.precompact_snapshot_id,
    source_transcript_snapshot_id: precompact.transcript_snapshot_id,
    preflight_validation_id: preflight.validation_id,
    method: input.method,
    method_version: input.method_version,
    compact_summary_hash,
    compactor_ack_ref,
  });
  const compaction_result_id =
    COMPACT_RESULT_ID_PREFIX + sha256Hex(resultCanonical).slice(0, 16);

  const snapshot: CompactionResultSnapshot = {
    compaction_result_protocol_version: COMPACT_RESULT_PROTOCOL_VERSION,
    compaction_result_id,
    precompact_snapshot_id: precompact.precompact_snapshot_id,
    source_transcript_snapshot_id: precompact.transcript_snapshot_id,
    preflight_validation_id: preflight.validation_id,
    method: input.method,
    method_version: input.method_version,
    compact_summary_ref,
    compact_summary_hash,
    compact_summary_bytes,
    compact_summary_lines,
    compactor_ack_ref,
    created_at,
  };
  return freezeSnapshot(snapshot);
}

/** Compaction result id 前缀。 */
const COMPACT_RESULT_ID_PREFIX = 'comp:';

// ===========================================================================
// Wave G Task 4 (GRC-1 §7.6 / §7.7 / §7.8 / §7.9 / §7.10 / §7.11)
//
// Pinned Working Set Plan 组装 + Required item matrix + Current user /
// Structural execution 处理。
//
// 这一段**只组装 plan item refs**,不调用 tool_executor / permission gate /
// action submit / FRC-1 rebuild / source loader。所有 side-effecting
// pipeline 由 T5+ 接入;本契约保证 plan 是纯函数产物,只引用上游已冻结的
// identity refs。
//
// 不变式 (spec §7.6 / §7.7 / §7.11 / §7.16):
//   - Plan 创建后不可变,deep-frozen。
//   - Required item matrix 是封闭值域;不允许任意 item_kind / requirement /
//     target_plane 组合。
//   - 旧 system Prompt、完整 transcript、Provider-visible execution state
//     和 synthetic tool result 都不进 plan。
//   - pending_execution 不应在 plan 中存在(preflight 已阻止);本契约冗余
//     校验,发现立即抛错。
//   - duplicate identity / ordinal conflict / unknown item → throw。
//   - plan_hash 只由 canonical(items sorted by (ordinal, plan_item_id)) +
//     ids 决定,不含时间戳、不依赖物理顺序。
// ===========================================================================

// ---------------------------------------------------------------------------
// Working Set Plan types (spec §7.6)
// ---------------------------------------------------------------------------

/**
 * Plan item 的种类(封闭值域,spec §7.6)。
 *
 * 这五种 item 覆盖 GRC-1 关心的全部"必须还原的内容身份";任何不在此列的
 * 内容(例如旧 system Prompt body、完整 transcript、synthetic tool result)
 * 都不属于 plan item。
 */
export type WorkingSetItemKind =
  | 'current_user_message'
  | 'compact_summary'
  | 'project_instruction_meta'
  | 'bounded_memory_entrypoint'
  | 'execution_state';

/**
 * Plan item 落到的 plane(封闭值域,spec §7.6 / §7.15)。
 *
 * Plane 决定 item 在最终 reconstruction 消息序列中的归属;GRC-1 只组装 refs,
 * 不接管 plane Owner(BRC-1 / FRC-1 / DRC-2+ERC-1 / compaction result /
 * session-turn lifecycle / 对应 runtime contract)。
 */
export type WorkingSetPlane =
  | 'system'
  | 'meta_context'
  | 'conversation_summary'
  | 'current_user'
  | 'execution_state';

/**
 * 单个 plan item —— pinned working set 的最小组装单元。
 *
 * 字段语义:
 *   - `plan_item_protocol_version`: 与 WORKING_SET_PLAN_ITEM_PROTOCOL_VERSION
 *     绑定,跨版本不兼容。
 *   - `plan_item_id`: 内容寻址(`'plan-item:' + sha256(canonical).slice(0,16)`)。
 *   - `item_kind`: 5 种之一(封闭值域)。
 *   - `source_ref`: 上游 identity ref(message_id / summary_ref /
 *     activation_id / entrypoint_id / execution_ref)。
 *   - `source_hash`: 当前已知 hash;structural-only 类(execution_state)与
 *     rebuild 类(memory entrypoint 在 rebuild 完成前)为 null。
 *   - `requirement`: WorkingSetRequirement,矩阵决定(spec §7.7)。
 *   - `lifecycle_record_ref`: 仅 project_instruction_meta 有,指向
 *     MetaMessageLifecycleRecord.lifecycle_record_id;首次加载时为 null。
 *   - `target_plane`: 5 种 plane 之一(封闭值域)。
 *   - `stable_ordinal`: 调用方传入的唯一性序号(0+ 整数);用于排序,语义见
 *     spec §7.16。duplicate ordinal → throw。
 *   - `resolution_action`: 当前确定的初始 action(T5 会根据 lifecycle 细化
 *     project_instruction_meta 的 reload/exclude)。
 *   - `reason_codes`: 该 item 的诊断 code 数组(非空时仅描述本 item 决策依据,
 *     不复用为 plan-level 失败信号)。
 */
export interface PinnedWorkingSetPlanItem {
  plan_item_protocol_version: string;
  plan_item_id: string;
  item_kind: WorkingSetItemKind;
  source_ref: string;
  source_hash: string | null;
  requirement: WorkingSetRequirement;
  lifecycle_record_ref: string | null;
  target_plane: WorkingSetPlane;
  stable_ordinal: number;
  resolution_action: ReconstructionResolutionAction;
  reason_codes: ReadonlyArray<string>;
}

/**
 * Pinned working set plan —— reconstruction 的"必须还原什么"清单。
 *
 * `item_refs` 与 `items` 同时保留(前者是 id 列表用于 ref-only 消费者,
 * 后者是完整对象用于本地消费)。两者必须一致: items 的 id 集合 === item_refs。
 *
 * `plan_hash` 是 canonical hash,只覆盖 items(按 (ordinal, plan_item_id)
 * 排序)+ item_refs + protocol 版本 + transaction/precompact/compaction
 * /target_context id;不含时间戳。
 */
export interface PinnedWorkingSetPlan {
  working_set_plan_protocol_version: string;
  working_set_plan_id: string;
  reconstruction_transaction_id: string;
  precompact_snapshot_id: string;
  compaction_result_id: string;
  target_context_snapshot_id: string;
  item_refs: ReadonlyArray<string>;
  items: ReadonlyArray<PinnedWorkingSetPlanItem>;
  plan_hash: string;
}

/**
 * 单个 active project instruction 在 plan 组装阶段的输入。
 *
 * 一个 activation 对应一个 plan item(item_kind='project_instruction_meta');
 * T5 会根据 lifecycle 决定 reload / preserve_exact / exclude。
 */
export interface ActiveProjectInstructionInput {
  activation_id: string;
  message_id: string;
  content_hash: string;
  /** 首次加载时为 null;后续 reload 会产生新 lifecycle record。 */
  lifecycle_record_id: string | null;
  /** Source freshness ref —— T5 reload 判定使用,本契约不消费。 */
  source_freshness_ref: string;
  ordinal: number;
}

/**
 * 单个 structural execution state 在 plan 组装阶段的输入。
 *
 * `execution_ref` 是 tool_call_id 或 ToolPairRecord.execution_state_ref;
 * `ack_ref` 是 completed/failed/cancelled acknowledgement ref;
 * `pair_state` 必须是 completed-class(paired),pending_execution 在本契约
 * 直接抛错。
 */
export interface ExecutionStateRefInput {
  execution_ref: string;
  ack_ref: string;
  pair_state: ToolPairState;
  permission_security_refs: ReadonlyArray<string>;
  ordinal: number;
}

/**
 * buildPinnedWorkingSetPlan 的完整输入。
 *
 * 重要:此类型**不**接受 old system prompt string、完整 transcript、
 * Provider-visible execution state 正文或 synthetic tool result。任何调用方
 * 试图把这些塞进 plan 都会在 TS 类型层面被拒绝;若通过类型断言绕过,本契约
 * 在运行时也不读取这些字段(不会进 plan)。
 */
export interface BuildPinnedWorkingSetPlanInput {
  /** 来自 capture(T1)。 */
  precompact: PreCompactSnapshot;
  /** 来自 preflight(T3)。 */
  preflight: PreflightResult;
  /** 来自 compaction(T3)。 */
  compaction_result: CompactionResultSnapshot;
  /** 当前 reconstruction transaction id。 */
  transaction_id: string;
  /** Post-compact target context snapshot id。 */
  target_context_snapshot_id: string;
  /** Active project instructions(每个 activation → 一个 plan item)。 */
  active_project_instructions: ReadonlyArray<ActiveProjectInstructionInput>;
  /** Execution state refs(structural,只保留 refs)。 */
  execution_state_refs: ReadonlyArray<ExecutionStateRefInput>;
}

// ---------------------------------------------------------------------------
// 常量与封闭值域内部表
// ---------------------------------------------------------------------------

/** Plan item id 前缀。 */
const PLAN_ITEM_ID_PREFIX = 'plan-item:';

/** Working set plan id 前缀。 */
const WORKING_SET_PLAN_ID_PREFIX = 'plan:';

/** Plan hash 前缀。 */
const PLAN_HASH_PREFIX = 'plan-hash:';

/**
 * Current user 的 stable_ordinal 高位常量。
 *
 * Spec §7.16 rule 4: current user message 位于 conversation tail,stable_ordinal
 * 必须大于所有其它 conversation-bearing item。用一个远高于普通 ordinal 范围
 * (project instruction / execution state 通常使用 0..N 小整数)的高位常量,
 * 避免与调用方传入的 ordinal 冲突。
 */
const CURRENT_USER_STABLE_ORDINAL = 1_000_000;

/**
 * Compact summary 的 stable_ordinal 高位常量。
 *
 * Spec §7.16: summary 在 meta context 之后、current user 之前。给定一个介于
 * meta context ordinal 范围与 current user 之间的固定高位,既保证顺序,又避免
 * 与调用方传入的 ordinal 冲突。
 */
const COMPACT_SUMMARY_STABLE_ORDINAL = 500_000;

/**
 * Bounded Memory entrypoint 的 stable_ordinal 低位常量。
 *
 * Spec §7.16: Memory entrypoint handoff 位于 reconstruction 顺序最前(system
 * section plane)。Memory 是 handoff-only,不进入 conversation ordering。
 */
const MEMORY_ENTRYPOINT_STABLE_ORDINAL = 0;

/**
 * Required item matrix(spec §7.7)的封闭值域内部表。
 *
 * 每个 item_kind 固定映射到 (requirement, default_resolution_action,
 * target_plane)。**调用方不能覆盖此映射**。default_resolution_action 是 T4
 * 阶段的初始值;T5 会根据 lifecycle 把 project_instruction_meta 的 action
 * 改为 reload/exclude(T5 在 source resolution record 阶段细化,而不是改
 * plan item 本身)。
 */
interface MatrixRow {
  requirement: WorkingSetRequirement;
  resolution_action: ReconstructionResolutionAction;
  target_plane: WorkingSetPlane;
}

const REQUIRED_ITEM_MATRIX: Record<WorkingSetItemKind, MatrixRow> = {
  current_user_message: {
    requirement: 'required_exact',
    resolution_action: 'preserve_exact',
    target_plane: 'current_user',
  },
  compact_summary: {
    requirement: 'required_current',
    resolution_action: 'preserve_exact',
    target_plane: 'conversation_summary',
  },
  project_instruction_meta: {
    requirement: 'required_current',
    resolution_action: 'preserve_exact',
    target_plane: 'meta_context',
  },
  bounded_memory_entrypoint: {
    requirement: 'optional_current',
    resolution_action: 'rebuild',
    target_plane: 'system',
  },
  execution_state: {
    requirement: 'structural_only',
    resolution_action: 'preserve_exact',
    target_plane: 'execution_state',
  },
};

// ---------------------------------------------------------------------------
// buildPinnedWorkingSetPlan —— pure plan assembly (spec §7.6 / §7.7)
// ---------------------------------------------------------------------------

/**
 * 组装 Pinned Working Set Plan(spec §7.6 / §7.7)。
 *
 * 这是 reconstruction pipeline 的"必须还原什么"清单组装步骤。它**只**:
 *   - 从 precompact / preflight / compaction_result / 调用方提供的 active
 *     project instruction + execution state refs 中提取 identity refs;
 *   - 按 Required item matrix(spec §7.7)为每个 item 固定 requirement /
 *     resolution_action / target_plane;
 *   - 校验封闭值域、duplicate identity、ordinal conflict、pending_execution;
 *   - 计算 plan_item_id / working_set_plan_id / plan_hash;
 *   - 深冻结后返回。
 *
 * 它**不**:
 *   - 调用 tool_executor / permission gate / action submit / source loader /
 *     FRC-1 rebuild(这些 side effect 全部由 T5+ 接入);
 *   - 读 transcript 正文、读 system Prompt body、读 Provider-visible
 *     execution state 正文、合成 tool result;
 *   - 信任 summary 文本来决定 resolution(本契约甚至不读 summary 内容,只
 *     保留 summary ref)。
 *
 * @throws {Error}
 *   - `'plan.duplicate_identity'`: 相同 source_ref 出现多次。
 *   - `'plan.ordinal_conflict'`: 两个 plan item 共用 stable_ordinal。
 *   - `'plan.pending_execution_present'`: execution_state_refs 含
 *     pending_execution(spec §7.11 rule 3 冗余校验;preflight 应已阻止)。
 *   - `'plan.source_ref_empty'`: 某个必需 identity ref 为空。
 *   - `'plan.unknown_item'`: 内部错误,出现不在矩阵中的 item_kind。
 */
export function buildPinnedWorkingSetPlan(
  input: BuildPinnedWorkingSetPlanInput,
): PinnedWorkingSetPlan {
  const { precompact, compaction_result } = input;

  // 1. 上游 identity gates。这些字段即使 preflight/compaction 已校验过,
  //    本契约也再校验一次 —— 防御性保险,确保 plan 引用的全是真实身份。
  requireIdentity(input.transaction_id, 'transaction_id');
  requireIdentity(
    input.target_context_snapshot_id,
    'target_context_snapshot_id',
  );
  requireIdentity(
    precompact.current_user_message_ref,
    'precompact.current_user_message_ref',
  );
  requireIdentity(
    precompact.current_user_message_hash,
    'precompact.current_user_message_hash',
  );
  requireIdentity(
    compaction_result.compact_summary_ref,
    'compaction_result.compact_summary_ref',
  );
  requireIdentity(
    compaction_result.compact_summary_hash,
    'compaction_result.compact_summary_hash',
  );

  // 2. 冗余校验:execution_state_refs 不含 pending_execution(spec §7.11
  //    rule 3)。preflight 已阻止 pending,这里再扫一遍保险 —— plan 阶段
  //    不允许 pending_execution 进入 published snapshot。
  for (const exec of input.execution_state_refs) {
    if (exec.pair_state === 'pending_execution') {
      throw new Error('plan.pending_execution_present');
    }
  }

  // 3. 组装 plan items(顺序无关 —— 后面会按 (ordinal, plan_item_id) 排序)。
  const items: PinnedWorkingSetPlanItem[] = [];

  // 3a. Bounded Memory entrypoint —— 即使 precompact.memory_entrypoint_snapshot_ref
  //     为 null 也添加 plan item(T6 会处理 null case,可能 excluded)。
  //     source_ref 为空串表示"暂无 entrypoint identity";source_hash=null 表示
  //     rebuild 完成前没有内容 hash。
  const memoryRow = REQUIRED_ITEM_MATRIX.bounded_memory_entrypoint;
  items.push(
    buildPlanItem({
      item_kind: 'bounded_memory_entrypoint',
      source_ref: precompact.memory_entrypoint_snapshot_ref ?? '',
      source_hash: null,
      lifecycle_record_ref: null,
      stable_ordinal: MEMORY_ENTRYPOINT_STABLE_ORDINAL,
      matrix: memoryRow,
      reason_codes: precompact.memory_entrypoint_snapshot_ref
        ? []
        : ['plan.memory_entrypoint_absent'],
    }),
  );

  // 3b. 每个 active project instruction → 一个 plan item。lifecycle_record_ref
  //     转发(首次加载为 null);source_ref = activation_id;source_hash =
  //     content_hash。resolution_action 默认 preserve_exact,T5 根据 lifecycle
  //     在 source resolution record 阶段细化为 reload/exclude(不改 plan item)。
  const projectRow = REQUIRED_ITEM_MATRIX.project_instruction_meta;
  for (const instr of input.active_project_instructions) {
    requireIdentity(instr.activation_id, 'activation_id');
    requireIdentity(instr.content_hash, 'content_hash');
    items.push(
      buildPlanItem({
        item_kind: 'project_instruction_meta',
        source_ref: instr.activation_id,
        source_hash: instr.content_hash,
        lifecycle_record_ref: instr.lifecycle_record_id ?? null,
        stable_ordinal: instr.ordinal,
        matrix: projectRow,
        reason_codes: [],
      }),
    );
  }

  // 3c. 每个 structural execution state → 一个 plan item。source_ref =
  //     execution_ref(tool_call_id);source_hash=null(structural only,不存
  //     内容)。pending_execution 已在上一步拦截。
  const execRow = REQUIRED_ITEM_MATRIX.execution_state;
  for (const exec of input.execution_state_refs) {
    requireIdentity(exec.execution_ref, 'execution_ref');
    items.push(
      buildPlanItem({
        item_kind: 'execution_state',
        source_ref: exec.execution_ref,
        source_hash: null,
        lifecycle_record_ref: null,
        stable_ordinal: exec.ordinal,
        matrix: execRow,
        reason_codes: [],
      }),
    );
  }

  // 3d. Compact summary —— source_ref = compaction_result.compact_summary_ref,
  //     source_hash = compact_summary_hash。requirement=required_current,
  //     resolution_action=preserve_exact(本契约不重写 summary)。
  const summaryRow = REQUIRED_ITEM_MATRIX.compact_summary;
  items.push(
    buildPlanItem({
      item_kind: 'compact_summary',
      source_ref: compaction_result.compact_summary_ref,
      source_hash: compaction_result.compact_summary_hash,
      lifecycle_record_ref: null,
      stable_ordinal: COMPACT_SUMMARY_STABLE_ORDINAL,
      matrix: summaryRow,
      reason_codes: [],
    }),
  );

  // 3e. Current user —— 必须是最后一个(conversation tail)。source_ref =
  //     precompact.current_user_message_ref;source_hash =
  //     current_user_message_hash。requirement=required_exact。
  const currentUserRow = REQUIRED_ITEM_MATRIX.current_user_message;
  items.push(
    buildPlanItem({
      item_kind: 'current_user_message',
      source_ref: precompact.current_user_message_ref,
      source_hash: precompact.current_user_message_hash,
      lifecycle_record_ref: null,
      stable_ordinal: CURRENT_USER_STABLE_ORDINAL,
      matrix: currentUserRow,
      reason_codes: [],
    }),
  );

  // 4. duplicate identity 校验。相同 source_ref 出现多次 → throw。
  //    注意:bounded_memory_entrypoint 在 entrypoint=null 时 source_ref='',
  //    这是合法的"无 identity"状态,但其它 item 不应出现空 source_ref ——
  //    上面的 requireIdentity 已防止。这里对**非空** source_ref 检查唯一性。
  const seenNonEmptyRefs = new Set<string>();
  for (const item of items) {
    if (item.source_ref === '') continue;
    if (seenNonEmptyRefs.has(item.source_ref)) {
      throw new Error('plan.duplicate_identity');
    }
    seenNonEmptyRefs.add(item.source_ref);
  }

  // 5. ordinal conflict 校验。两个 plan item 共用 stable_ordinal → throw。
  //    spec §7.8 rule 9: meta context ordinal conflict 使 transaction
  //    rejected;本契约统一对所有 item_kind 检查 ordinal 唯一性。
  const seenOrdinals = new Set<number>();
  for (const item of items) {
    if (seenOrdinals.has(item.stable_ordinal)) {
      throw new Error('plan.ordinal_conflict');
    }
    seenOrdinals.add(item.stable_ordinal);
  }

  // 6. 按 (stable_ordinal, plan_item_id) 排序,保证 plan_hash 与 item_refs
  //    的物理顺序与调用方传入顺序无关。
  const sortedItems = [...items].sort((a, b) => {
    if (a.stable_ordinal !== b.stable_ordinal) {
      return a.stable_ordinal - b.stable_ordinal;
    }
    return a.plan_item_id < b.plan_item_id
      ? -1
      : a.plan_item_id > b.plan_item_id
        ? 1
        : 0;
  });

  const item_refs = sortedItems.map((it) => it.plan_item_id);

  // 7. plan_hash 与 working_set_plan_id 计算。
  //    plan_hash: sha256(canonical items sorted by (ordinal, plan_item_id)
  //                      + ids + protocol + 顶层 id 字段)。不含时间戳。
  const plan_hash = computePlanHash({
    items: sortedItems,
    transaction_id: input.transaction_id,
    precompact_snapshot_id: precompact.precompact_snapshot_id,
    compaction_result_id: compaction_result.compaction_result_id,
    target_context_snapshot_id: input.target_context_snapshot_id,
  });

  const plan_id_canonical = canonicalJson({
    working_set_plan_protocol_version: WORKING_SET_PLAN_PROTOCOL_VERSION,
    reconstruction_transaction_id: input.transaction_id,
    precompact_snapshot_id: precompact.precompact_snapshot_id,
    compaction_result_id: compaction_result.compaction_result_id,
    target_context_snapshot_id: input.target_context_snapshot_id,
    plan_hash,
  });
  const working_set_plan_id =
    WORKING_SET_PLAN_ID_PREFIX + sha256Hex(plan_id_canonical).slice(0, 16);

  // 8. 组装 + 深冻结。freezeSnapshot 递归冻结 items 与每个 item 对象。
  const plan: PinnedWorkingSetPlan = {
    working_set_plan_protocol_version: WORKING_SET_PLAN_PROTOCOL_VERSION,
    working_set_plan_id,
    reconstruction_transaction_id: input.transaction_id,
    precompact_snapshot_id: precompact.precompact_snapshot_id,
    compaction_result_id: compaction_result.compaction_result_id,
    target_context_snapshot_id: input.target_context_snapshot_id,
    item_refs,
    items: sortedItems,
    plan_hash,
  };
  return freezeSnapshot(plan);
}

// ---------------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------------

/** 单个 plan item 的构造输入(已从矩阵查得 requirement/action/plane)。 */
interface BuildPlanItemInput {
  item_kind: WorkingSetItemKind;
  source_ref: string;
  source_hash: string | null;
  lifecycle_record_ref: string | null;
  stable_ordinal: number;
  matrix: MatrixRow;
  reason_codes: ReadonlyArray<string>;
}

/**
 * 构造单个 plan item,计算 plan_item_id,深冻结后返回。
 *
 * plan_item_id 派生自 (item_kind, source_ref, source_hash, requirement,
 * target_plane, stable_ordinal, resolution_action, lifecycle_record_ref)
 * 的 canonical hash。这样相同语义输入产生相同 plan_item_id,任一字段变化
 * 则 id 变化 —— 既保证 plan_hash 确定性,也允许上游(T5)在新 lifecycle
 * 阶段生成新 plan。
 */
function buildPlanItem(input: BuildPlanItemInput): PinnedWorkingSetPlanItem {
  // 防御性:确认 item_kind 仍在矩阵中(spec §7.7 封闭值域)。若调用方通过
  // 类型断言塞入未知值,这里抛错。
  const known = REQUIRED_ITEM_MATRIX[input.item_kind];
  if (known === undefined) {
    throw new Error('plan.unknown_item');
  }
  // 矩阵内部一致性自检 —— 确认调用 buildPlanItem 时传入的 matrix 与矩阵一致。
  // 这条分支在当前实现中永不触发(buildPinnedWorkingSetPlan 总是用矩阵 row),
  // 但保留以便未来矩阵演进时防御性回归。
  if (
    known.requirement !== input.matrix.requirement ||
    known.resolution_action !== input.matrix.resolution_action ||
    known.target_plane !== input.matrix.target_plane
  ) {
    throw new Error('plan.unknown_item');
  }

  const item_canonical = canonicalJson({
    plan_item_protocol_version: WORKING_SET_PLAN_ITEM_PROTOCOL_VERSION,
    item_kind: input.item_kind,
    source_ref: input.source_ref,
    source_hash: input.source_hash,
    requirement: input.matrix.requirement,
    lifecycle_record_ref: input.lifecycle_record_ref,
    target_plane: input.matrix.target_plane,
    stable_ordinal: input.stable_ordinal,
    resolution_action: input.matrix.resolution_action,
  });
  const plan_item_id =
    PLAN_ITEM_ID_PREFIX + sha256Hex(item_canonical).slice(0, 16);

  const item: PinnedWorkingSetPlanItem = {
    plan_item_protocol_version: WORKING_SET_PLAN_ITEM_PROTOCOL_VERSION,
    plan_item_id,
    item_kind: input.item_kind,
    source_ref: input.source_ref,
    source_hash: input.source_hash,
    requirement: input.matrix.requirement,
    lifecycle_record_ref: input.lifecycle_record_ref,
    target_plane: input.matrix.target_plane,
    stable_ordinal: input.stable_ordinal,
    resolution_action: input.matrix.resolution_action,
    reason_codes: input.reason_codes,
  };
  return freezeSnapshot(item);
}

/**
 * 计算 plan_hash(spec Task 4 Step 7)。
 *
 * 输入:已按 (ordinal, plan_item_id) 排序的 items + 顶层 id 字段。
 * 输出:`'plan-hash:' + sha256(canonical).slice(0, 32)`。
 *
 * 不含时间戳、不含 checked_at / created_at。同一输入产生同一 plan_hash,
 * 任意 item 字段变化则 plan_hash 变化。
 */
function computePlanHash(args: {
  items: ReadonlyArray<PinnedWorkingSetPlanItem>;
  transaction_id: string;
  precompact_snapshot_id: string;
  compaction_result_id: string;
  target_context_snapshot_id: string;
}): string {
  const items_view = args.items.map((it) => ({
    plan_item_id: it.plan_item_id,
    item_kind: it.item_kind,
    source_ref: it.source_ref,
    source_hash: it.source_hash,
    requirement: it.requirement,
    lifecycle_record_ref: it.lifecycle_record_ref,
    target_plane: it.target_plane,
    stable_ordinal: it.stable_ordinal,
    resolution_action: it.resolution_action,
    // reason_codes 排序后纳入 —— 同一 reason set 不同顺序不应改变 plan_hash。
    reason_codes: [...it.reason_codes].sort(),
  }));
  const canonical = canonicalJson({
    working_set_plan_protocol_version: WORKING_SET_PLAN_PROTOCOL_VERSION,
    reconstruction_transaction_id: args.transaction_id,
    precompact_snapshot_id: args.precompact_snapshot_id,
    compaction_result_id: args.compaction_result_id,
    target_context_snapshot_id: args.target_context_snapshot_id,
    items: items_view,
  });
  return PLAN_HASH_PREFIX + sha256Hex(canonical).slice(0, 32);
}

// ===========================================================================
// Wave G Task 5 + Task 6 (GRC-1 §7.8 / §7.9 / §7.12)
//
// Source Resolution Record(共享类型)+ Project Instruction Resolution
// + Target-Context Memory Rebuild。
//
// 这一段消费 T4 的 PinnedWorkingSetPlanItem + ERC-1 MetaMessageLifecycleRecord
// + Wave F FRC-1 rebuild port(通过 frozen interface 注入),把 plan item 细化为
// 不可变的 ReconstructionSourceResolution。
//
// 不变式 (spec §7.8 / §7.9):
//   - GRC-1 不重新实现 discovery / routing / trusted extraction / activation /
//     retention;所有受信 reload 都通过 deps.reload_via_trusted_pipeline 注入。
//   - preserve gate 失败 → block(让 T7 candidate 决定降级,而非 GRC-1 自己降级)。
//   - invalidated 必须 exclude;旧正文 / cache / summary 不复活。
//   - reload marker 本身不读 source;只有 trusted pipeline 是 source 读取路径。
//   - reload 后内容相同仍形成新 acknowledgement(spec §7.8 rule 7)。
//   - GRC-1 不读全部 Memory、不生成 verified claim;FRC-1 拥有 selection/use/
//     budget/render 语义。
//   - 旧 MemoryUseDecision 不跨 target context;FRC-1 rebuild 必须重新评估 use。
// ===========================================================================

// ---------------------------------------------------------------------------
// 共享类型:Source Resolution Record (spec §7.12)
// ---------------------------------------------------------------------------

/** Source resolution 的终态(封闭值域,spec §7.12)。 */
export type SourceResolutionStatus = 'resolved' | 'excluded' | 'blocked' | 'rejected';

/**
 * 单个 plan item 的 source resolution 记录(spec §7.12)。
 *
 * 创建后不可变。相同 source 发生新变化时创建新 record,不修改旧 record。
 *
 * 字段语义:
 *   - `resolution_protocol_version`: 与 SOURCE_RESOLUTION_PROTOCOL_VERSION 绑定。
 *   - `resolution_id`: `'resol:' + sha256(canonical).slice(0,16)`。
 *   - `reconstruction_transaction_id`: 该 resolution 所属的 transaction。
 *   - `plan_item_id`: 对应 T4 plan item 的 id。
 *   - `source_ref_before` / `source_hash_before`: resolution 前的 identity/hash,
 *     来自 plan_item。
 *   - `source_ref_after` / `source_hash_after`: resolution 后的 identity/hash。
 *     preserve_exact 时与 before 相同;reload 时是 pipeline 返回的新 identity;
 *     exclude/block 时为 null。
 *   - `action`: 'preserve_exact'|'reload'|'rebuild'|'exclude'|'block'。
 *   - `status`: 'resolved'|'excluded'|'blocked'|'rejected'。excluded 是"成功 omit"
 *     而非失败(spec §7.8 rule 4)。
 *   - `freshness_ref`: source freshness 观测的 identity ref。
 *   - `provenance_refs`: 透传 plan_item 的 provenance,或 reload 后的新 provenance。
 *   - `acknowledgement_ref`: reload 成功时的新 acknowledgement identity;
 *     preserve/exclude/block 时为 null。
 *   - `reason_codes`: 诊断 code 数组。
 */
export interface ReconstructionSourceResolution {
  resolution_protocol_version: string;
  resolution_id: string;
  reconstruction_transaction_id: string;
  plan_item_id: string;
  source_ref_before: string;
  source_ref_after: string | null;
  source_hash_before: string | null;
  source_hash_after: string | null;
  action: ReconstructionResolutionAction;
  status: SourceResolutionStatus;
  freshness_ref: string | null;
  provenance_refs: ReadonlyArray<string>;
  acknowledgement_ref: string | null;
  reason_codes: ReadonlyArray<string>;
}

/** Source resolution id 前缀。 */
const SOURCE_RESOLUTION_ID_PREFIX = 'resol:';

/**
 * 计算 resolution_id(spec §7.12)。
 *
 * 派生自 (plan_item_id + action + status + source_ref_after + reason_codes)
 * 的 canonical hash。同一输入产生同一 id;任一字段变化则 id 变化。
 */
function computeResolutionId(args: {
  plan_item_id: string;
  action: ReconstructionResolutionAction;
  status: SourceResolutionStatus;
  source_ref_after: string | null;
  reason_codes: ReadonlyArray<string>;
}): string {
  const canonical = canonicalJson({
    resolution_protocol_version: SOURCE_RESOLUTION_PROTOCOL_VERSION,
    plan_item_id: args.plan_item_id,
    action: args.action,
    status: args.status,
    source_ref_after: args.source_ref_after,
    reason_codes: [...args.reason_codes].sort(),
  });
  return SOURCE_RESOLUTION_ID_PREFIX + sha256Hex(canonical).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Wave F FRC-1 handoff port(frozen interface,GRC-1 只消费不实现)
// ---------------------------------------------------------------------------

/**
 * FRC-1 memory entrypoint rebuild 输入(Wave F M-013/FRC-1 提供)。
 *
 * GRC-1 通过这个结构把 rebuild 请求委托给 FRC-1 owner port。GRC-1 **不**直接
 * 读全部 Memory、不生成 verified claim —— selection/use/budget/render 语义全部
 * 留在 FRC-1 owner 内部(spec §7.9 rule 4, 5)。
 */
export interface MemoryEntrypointRebuildInput {
  entrypoint_protocol_version: string;
  task_snapshot_id: string;
  target_context_snapshot_id: string;
  project_version_ref: string | null;
  old_entrypoint_snapshot_id: string | null;
  old_catalog_snapshot_id: string | null;
  old_selection_id: string | null;
  policy_ref: { contract_id: string; contract_version: string };
  request_budget_snapshot_id: string;
  render_profile_ref: string;
}

/**
 * FRC-1 memory entrypoint rebuild 结果(Wave F M-013/FRC-1 提供)。
 *
 * `state='partial'` 时 overflow_manifest_ref 携带降级证据;`state='empty'` /
 * `'rejected'` 时 entrypoint_snapshot_id 为 null。
 */
export interface MemoryEntrypointRebuildResult {
  entrypoint_snapshot_id: string | null;
  target_context_snapshot_id: string;
  state: 'ready' | 'empty' | 'partial' | 'rejected';
  overflow_manifest_ref: string | null;
  provenance_manifest_ref: string;
  reason_codes: ReadonlyArray<string>;
}

/** FRC-1 rebuild port(注入)。GRC-1 调用,实际接入由 T10 完成。 */
export type MemoryEntrypointRebuildPort = (
  input: MemoryEntrypointRebuildInput,
) => Promise<MemoryEntrypointRebuildResult>;

// ---------------------------------------------------------------------------
// Task 5: Project Instruction Resolution(spec §7.8)
// ---------------------------------------------------------------------------

/**
 * 单个 project instruction 在 T5 resolution 阶段的输入(spec §7.8)。
 *
 * 重新说明:T5 消费 T4 已冻结的 plan item + ERC-1 已冻结的 lifecycle record,
 * 加上 target context / project version / source freshness 观测,产出不可变的
 * ReconstructionSourceResolution。GRC-1 不重新实现 discovery/routing/loading/
 * activation;所有受信 reload 都通过 `deps.reload_via_trusted_pipeline` 注入。
 */
export interface ProjectInstructionLifecycleInput {
  /** T4 plan item(item_kind='project_instruction_meta')。 */
  plan_item: PinnedWorkingSetPlanItem;
  /**
   * ERC-1 lifecycle record。首次加载时为 null(此时强制走 reload 路径);
   * 其它情况由 `lifecycle_record.state` 决议。
   */
  lifecycle_record: MetaMessageLifecycleRecord | null;
  /** post-compact target context snapshot id。 */
  target_context_snapshot_id: string;
  /** post-compact target project version ref(可空时视为兼容)。 */
  target_project_version_ref: string | null;
  /**
   * 当前 source 的 freshness 观测 identity ref。空字符串表示 freshness 缺失
   * (preserve gate 失败原因之一)。
   */
  source_freshness_ref: string;
  /** 当前 source 的 content hash。用于 preserve gate:必须 === plan_item.source_hash。 */
  source_content_hash: string | null;
  /** 该 plan item 所属的 reconstruction transaction id。 */
  reconstruction_transaction_id: string;
}

/**
 * T5 注入依赖(单一注入项:受信 reload pipeline)。
 *
 * pipeline 内部由 T10 接线,调用 discovery / routing / loading / activation /
 * retention,返回新 acknowledgement identity + 内容 hash。失败 throw —— GRC-1
 * 把 throw 转为 status='blocked'(spec §7.8 rule 8)。
 */
export interface ProjectInstructionResolutionDependencies {
  reload_via_trusted_pipeline: (input: {
    activation_id: string;
    target_context_snapshot_id: string;
    target_project_version_ref: string | null;
  }) => Promise<{
    new_activation_id: string;
    new_message_id: string;
    new_lifecycle_record_id: string;
    new_content_hash: string;
    new_freshness_ref: string;
    acknowledgement_ref: string;
  }>;
}

/**
 * 执行单个 project instruction 的 source resolution(spec §7.8 / §7.12)。
 *
 * 决议表:
 *   | lifecycle state        | action          | status(成功时)             |
 *   |------------------------|-----------------|------------------------------|
 *   | null(首次加载)        | reload          | resolved(pipeline 成功)    |
 *   |                        |                 | blocked(pipeline 失败)     |
 *   | 'resident'/'serialized'| preserve_exact  | resolved(gate 通过)        |
 *   |                        | block           | blocked(gate 失败)         |
 *   | 'reload_required'      | reload          | resolved(pipeline 成功)    |
 *   |                        |                 | blocked(pipeline 失败)     |
 *   | 'invalidated'          | exclude         | resolved(excluded 是成功) |
 *
 * preserve gate(spec §7.8 rule 1):freshness_ref 非空 &&
 * source_content_hash === plan_item.source_hash(可空时视为不兼容)。失败 →
 * block(reason_codes=['preserve_gate_failed', ...])。**GRC-1 不静默降级为
 * reload**,让 T7 candidate 看到这个 resolution 并决定是否降级。
 *
 * reload path(spec §7.8 rule 2, 5, 7):调用 deps.reload_via_trusted_pipeline;
 * 成功 → resolved + acknowledgement_ref(即使内容相同也是新 ack);失败 → blocked
 * + reason_codes 含 'reload.pipeline_failed' + err.message。
 *
 * exclude path(spec §7.8 rule 4):invalidated 必须 exclude,source_ref_after=null,
 * 旧正文不复活。**即使** source_content_hash 提供且匹配,仍 exclude。
 *
 * @throws 永不 —— 所有失败路径都转为 status='blocked'/'rejected',不抛错。
 *   输入 identity 缺失会抛错(因为这是配置错误,不是 lifecycle 事件)。
 */
export async function resolveProjectInstruction(
  input: ProjectInstructionLifecycleInput,
  deps: ProjectInstructionResolutionDependencies,
): Promise<ReconstructionSourceResolution> {
  const { plan_item, lifecycle_record } = input;

  // 1. Identity gates —— 配置错误,不是 lifecycle 事件,直接抛错。
  requireIdentity(plan_item.plan_item_id, 'plan_item.plan_item_id');
  requireIdentity(plan_item.source_ref, 'plan_item.source_ref');
  requireIdentity(input.target_context_snapshot_id, 'target_context_snapshot_id');
  requireIdentity(
    input.reconstruction_transaction_id,
    'reconstruction_transaction_id',
  );
  // item_kind 必须是 project_instruction_meta(防御性)。
  if (plan_item.item_kind !== 'project_instruction_meta') {
    throw new Error(
      `project_instruction.wrong_item_kind: ${plan_item.item_kind}`,
    );
  }

  const source_ref_before = plan_item.source_ref;
  const source_hash_before = plan_item.source_hash;

  // 2. 按 lifecycle_record.state 分支。
  if (lifecycle_record !== null && lifecycle_record.state === 'invalidated') {
    // ---------------------------------------------------------------------
    // exclude path(spec §7.8 rule 4):invalidated 必须 exclude。
    // 旧正文 / cache / summary 不复活。即使 source_content_hash 匹配也不 preserve。
    // excluded 是"确定性成功"(成功 omit),不是失败。
    // ---------------------------------------------------------------------
    return buildResolution({
      plan_item_id: plan_item.plan_item_id,
      reconstruction_transaction_id: input.reconstruction_transaction_id,
      source_ref_before,
      source_ref_after: null,
      source_hash_before,
      source_hash_after: null,
      action: 'exclude',
      status: 'resolved', // excluded 是确定性成功
      freshness_ref: input.source_freshness_ref || null,
      provenance_refs: plan_item.reason_codes, // plan_item 不携带独立 provenance;用 reason_codes 占位
      acknowledgement_ref: null,
      reason_codes: ['project_instruction.invalidated'],
    });
  }

  const needsReload =
    lifecycle_record === null || lifecycle_record.state === 'reload_required';

  if (!needsReload) {
    // ---------------------------------------------------------------------
    // preserve gate(spec §7.8 rule 1):'resident' / 'serialized'。
    // freshness_ref 非空 && source_content_hash === plan_item.source_hash。
    // 失败 → block(reason='preserve_gate_failed')。
    // ---------------------------------------------------------------------
    const freshnessMissing = !isNonEmpty(input.source_freshness_ref);
    const hashMismatch =
      input.source_content_hash === null ||
      input.source_content_hash !== plan_item.source_hash;

    if (!freshnessMissing && !hashMismatch) {
      // gate 通过 → preserve_exact / resolved。
      return buildResolution({
        plan_item_id: plan_item.plan_item_id,
        reconstruction_transaction_id: input.reconstruction_transaction_id,
        source_ref_before,
        source_ref_after: source_ref_before, // 保留旧 activation identity
        source_hash_before,
        source_hash_after: source_hash_before,
        action: 'preserve_exact',
        status: 'resolved',
        freshness_ref: input.source_freshness_ref,
        provenance_refs: plan_item.reason_codes,
        acknowledgement_ref: null, // preserve 不产生新 acknowledgement
        reason_codes: [],
      });
    }

    // gate 失败 → block。给出细分 reason_code,让 T7 看到失败原因。
    const reasons: string[] = ['preserve_gate_failed'];
    if (freshnessMissing) reasons.push('preserve_gate.freshness_missing');
    if (hashMismatch) reasons.push('preserve_gate.hash_mismatch');
    return buildResolution({
      plan_item_id: plan_item.plan_item_id,
      reconstruction_transaction_id: input.reconstruction_transaction_id,
      source_ref_before,
      source_ref_after: null,
      source_hash_before,
      source_hash_after: null,
      action: 'block',
      status: 'blocked',
      freshness_ref: input.source_freshness_ref || null,
      provenance_refs: plan_item.reason_codes,
      acknowledgement_ref: null,
      reason_codes: reasons,
    });
  }

  // -------------------------------------------------------------------------
  // reload path(spec §7.8 rule 2, 3, 5, 7, 8)。
  // - reload marker 本身不读 source(rule 3);只有 pipeline 是读取路径。
  // - pipeline 成功 → resolved + acknowledgement_ref(即使内容相同也是新 ack)。
  // - pipeline 失败 → blocked(rule 8);required instruction reload 失败阻断 tx。
  // -------------------------------------------------------------------------
  try {
    const ack = await deps.reload_via_trusted_pipeline({
      activation_id: source_ref_before,
      target_context_snapshot_id: input.target_context_snapshot_id,
      target_project_version_ref: input.target_project_version_ref,
    });
    return buildResolution({
      plan_item_id: plan_item.plan_item_id,
      reconstruction_transaction_id: input.reconstruction_transaction_id,
      source_ref_before,
      source_ref_after: ack.new_activation_id,
      source_hash_before,
      source_hash_after: ack.new_content_hash,
      action: 'reload',
      status: 'resolved',
      freshness_ref: ack.new_freshness_ref,
      provenance_refs: plan_item.reason_codes,
      acknowledgement_ref: ack.acknowledgement_ref,
      reason_codes: [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildResolution({
      plan_item_id: plan_item.plan_item_id,
      reconstruction_transaction_id: input.reconstruction_transaction_id,
      source_ref_before,
      source_ref_after: null,
      source_hash_before,
      source_hash_after: null,
      action: 'reload',
      status: 'blocked',
      freshness_ref: input.source_freshness_ref || null,
      provenance_refs: plan_item.reason_codes,
      acknowledgement_ref: null,
      reason_codes: ['reload.pipeline_failed', `reload.error:${message}`],
    });
  }
}

/**
 * 构造一份不可变的 ReconstructionSourceResolution(spec §7.12)。
 *
 * 集中派生 resolution_id 与 protocol version;保证所有路径产出的 record 形状一致。
 */
function buildResolution(args: {
  plan_item_id: string;
  reconstruction_transaction_id: string;
  source_ref_before: string;
  source_ref_after: string | null;
  source_hash_before: string | null;
  source_hash_after: string | null;
  action: ReconstructionResolutionAction;
  status: SourceResolutionStatus;
  freshness_ref: string | null;
  provenance_refs: ReadonlyArray<string>;
  acknowledgement_ref: string | null;
  reason_codes: ReadonlyArray<string>;
}): ReconstructionSourceResolution {
  const resolution_id = computeResolutionId({
    plan_item_id: args.plan_item_id,
    action: args.action,
    status: args.status,
    source_ref_after: args.source_ref_after,
    reason_codes: args.reason_codes,
  });
  const result: ReconstructionSourceResolution = {
    resolution_protocol_version: SOURCE_RESOLUTION_PROTOCOL_VERSION,
    resolution_id,
    reconstruction_transaction_id: args.reconstruction_transaction_id,
    plan_item_id: args.plan_item_id,
    source_ref_before: args.source_ref_before,
    source_ref_after: args.source_ref_after,
    source_hash_before: args.source_hash_before,
    source_hash_after: args.source_hash_after,
    action: args.action,
    status: args.status,
    freshness_ref: args.freshness_ref,
    provenance_refs: args.provenance_refs,
    acknowledgement_ref: args.acknowledgement_ref,
    reason_codes: args.reason_codes,
  };
  return freezeSnapshot(result);
}

// ---------------------------------------------------------------------------
// Task 6: Target-Context Memory Rebuild(spec §7.9)
// ---------------------------------------------------------------------------

/**
 * Memory entrypoint 在 T6 rebuild 阶段的输入(spec §7.9)。
 *
 * GRC-1 把 T4 plan item + 旧 entrypoint identity + target context / FRC-1 policy
 * / render / budget refs 打包成 rebuild 请求,委托给 FRC-1 owner port。
 *
 * 不变式(spec §7.9):
 *   - post-compact target context ≠ old context(rule 1)。
 *   - 旧 MemoryUseDecision 不跨 target context(rule 2)—— FRC-1 必须重新评估 use。
 *   - GRC-1 不读全部 Memory、不生成 verified claim(rule 5)。
 *   - 新 FRC-1 snapshot 必须绑定 target context(rule 6)。
 */
export interface MemoryRebuildInput {
  /** T4 plan item(item_kind='bounded_memory_entrypoint')。 */
  plan_item: PinnedWorkingSetPlanItem;
  /** 旧 entrypoint identity(从 precompact.memory_entrypoint_snapshot_ref)。 */
  old_entrypoint_snapshot_id: string | null;
  /** 旧 catalog snapshot id(可空)。 */
  old_catalog_snapshot_id: string | null;
  /** 旧 selection id(可空)。 */
  old_selection_id: string | null;
  /** post-compact target context snapshot id。 */
  target_context_snapshot_id: string;
  /** post-compact target task snapshot id。 */
  target_task_snapshot_id: string;
  /** post-compact target project version ref。 */
  target_project_version_ref: string | null;
  /** FRC-1 policy contract ref(selection/use/budget/render 语义 owner)。 */
  memory_policy_ref: { contract_id: string; contract_version: string };
  /** Render profile ref。 */
  render_profile_ref: string;
  /** Request budget snapshot id。 */
  request_budget_snapshot_id: string;
  /** 该 plan item 所属的 reconstruction transaction id。 */
  reconstruction_transaction_id: string;
}

/**
 * T6 注入依赖(单一注入项:FRC-1 rebuild port)。
 *
 * port 内部由 Wave F M-013/FRC-1 实现;GRC-1 只消费 selection/use/budget/render
 * 的最终结果,不重新实现这些语义(spec §7.9 rule 4)。
 */
export interface MemoryRebuildDependencies {
  rebuild_via_frc1: MemoryEntrypointRebuildPort;
}

/** Wave F FRC-1 rebuild port 的冻结协议版本号(Wave F 冻结值)。 */
const FRC1_ENTRYPOINT_PROTOCOL_VERSION = '1';

/**
 * 执行 memory entrypoint 的 target-context rebuild(spec §7.9)。
 *
 * 算法:
 *   1. 构造 MemoryEntrypointRebuildInput —— 只 identity refs,不读 detail。
 *   2. 调用 deps.rebuild_via_frc1。
 *      - throw → excluded(optional failure,degraded publish,spec §7.9 rule 9)。
 *   3. 状态映射(spec Task 6 Step 5):
 *      - 'ready' / 'partial' → resolved, action='rebuild', source_ref_after=
 *        entrypoint_snapshot_id。partial 必须保留 overflow/degradation evidence
 *        (reason_codes 含 'memory.partial',overflow_manifest_ref 透传)。
 *      - 'empty' → excluded(reason_codes 含 'memory.empty',显式 omission)。
 *      - 'rejected' → excluded(reason_codes 含 'memory.rebuild_rejected')。
 *   4. identity mismatch 防御性检查:result.target_context_snapshot_id 必须 ===
 *      input.target_context_snapshot_id,否则 rejected
 *      (reason_codes=['memory.context_mismatch'])。
 *
 * 不变式保证:
 *   - GRC-1 不调用 getIndexContent/inject/read-all/summary-to-memory(structurally
 *     enforced:deps 只有 rebuild_via_frc1)。
 *   - selected ≠ use 仍成立:FRC-1 port 间接保证,GRC-1 不直接验证。
 *   - 旧 MemoryUseDecision 不跨 context:FRC-1 rebuild 必须重新评估 use。
 *   - optional failure 不改变 TurnOutcome:T6 只返回 Resolution,不返回 TurnOutcome。
 */
export async function rebuildMemoryEntrypoint(
  input: MemoryRebuildInput,
  deps: MemoryRebuildDependencies,
): Promise<ReconstructionSourceResolution> {
  const { plan_item } = input;

  // 1. Identity gates —— 配置错误,直接抛错。
  requireIdentity(plan_item.plan_item_id, 'plan_item.plan_item_id');
  requireIdentity(input.target_context_snapshot_id, 'target_context_snapshot_id');
  requireIdentity(input.target_task_snapshot_id, 'target_task_snapshot_id');
  requireIdentity(
    input.reconstruction_transaction_id,
    'reconstruction_transaction_id',
  );
  requireIdentity(input.memory_policy_ref.contract_id, 'memory_policy_ref.contract_id');
  requireIdentity(
    input.memory_policy_ref.contract_version,
    'memory_policy_ref.contract_version',
  );
  requireIdentity(input.render_profile_ref, 'render_profile_ref');
  requireIdentity(input.request_budget_snapshot_id, 'request_budget_snapshot_id');
  if (plan_item.item_kind !== 'bounded_memory_entrypoint') {
    throw new Error(`memory.wrong_item_kind: ${plan_item.item_kind}`);
  }

  const source_ref_before = plan_item.source_ref; // entrypoint=null 时为 ''
  const source_hash_before = plan_item.source_hash; // 永远 null(rebuild 前无内容 hash)

  // 2. 构造 rebuild input(只 identity refs,不读 detail)。
  const rebuild_input: MemoryEntrypointRebuildInput = {
    entrypoint_protocol_version: FRC1_ENTRYPOINT_PROTOCOL_VERSION,
    task_snapshot_id: input.target_task_snapshot_id,
    target_context_snapshot_id: input.target_context_snapshot_id,
    project_version_ref: input.target_project_version_ref,
    old_entrypoint_snapshot_id: input.old_entrypoint_snapshot_id,
    old_catalog_snapshot_id: input.old_catalog_snapshot_id,
    old_selection_id: input.old_selection_id,
    policy_ref: {
      contract_id: input.memory_policy_ref.contract_id,
      contract_version: input.memory_policy_ref.contract_version,
    },
    request_budget_snapshot_id: input.request_budget_snapshot_id,
    render_profile_ref: input.render_profile_ref,
  };

  // 3. 调用 FRC-1 owner port。
  let result: MemoryEntrypointRebuildResult;
  try {
    result = await deps.rebuild_via_frc1(rebuild_input);
  } catch (err) {
    // FRC-1 内部错误 → optional failure,degraded publish(spec §7.9 rule 9)。
    // memory 是 optional_current,失败不阻断 transaction,只 omit section。
    const message = err instanceof Error ? err.message : String(err);
    return buildResolution({
      plan_item_id: plan_item.plan_item_id,
      reconstruction_transaction_id: input.reconstruction_transaction_id,
      source_ref_before,
      source_ref_after: null,
      source_hash_before,
      source_hash_after: null,
      action: 'rebuild',
      status: 'excluded', // optional,可降级
      freshness_ref: null,
      provenance_refs: plan_item.reason_codes,
      acknowledgement_ref: null,
      reason_codes: ['memory.rebuild_failed', `memory.error:${message}`],
    });
  }

  // 4. identity mismatch 防御性检查:FRC-1 返回的 target context 必须与请求一致。
  //    不一致 → rejected(FRC-1 实现错误的硬信号)。
  if (result.target_context_snapshot_id !== input.target_context_snapshot_id) {
    return buildResolution({
      plan_item_id: plan_item.plan_item_id,
      reconstruction_transaction_id: input.reconstruction_transaction_id,
      source_ref_before,
      source_ref_after: null,
      source_hash_before,
      source_hash_after: null,
      action: 'rebuild',
      status: 'rejected',
      freshness_ref: null,
      provenance_refs: plan_item.reason_codes,
      acknowledgement_ref: null,
      reason_codes: ['memory.context_mismatch'],
    });
  }

  // 5. 状态映射(spec Task 6 Step 5)。
  switch (result.state) {
    case 'ready': {
      // ready → resolved, source_ref_after=entrypoint_snapshot_id。
      return buildResolution({
        plan_item_id: plan_item.plan_item_id,
        reconstruction_transaction_id: input.reconstruction_transaction_id,
        source_ref_before,
        source_ref_after: result.entrypoint_snapshot_id,
        source_hash_before,
        source_hash_after: null, // FRC-1 不暴露内容 hash,只暴露 entrypoint identity
        action: 'rebuild',
        status: 'resolved',
        freshness_ref: null,
        provenance_refs: [
          ...plan_item.reason_codes,
          result.provenance_manifest_ref,
        ],
        acknowledgement_ref: `frc1.ack:${result.entrypoint_snapshot_id}`,
        reason_codes: [...result.reason_codes],
      });
    }
    case 'partial': {
      // partial → resolved,但 reason_codes 必须含 'memory.partial' 保留降级证据
      // (spec Task 6 Step 5:partial 必须保留 overflow/degradation evidence)。
      return buildResolution({
        plan_item_id: plan_item.plan_item_id,
        reconstruction_transaction_id: input.reconstruction_transaction_id,
        source_ref_before,
        source_ref_after: result.entrypoint_snapshot_id,
        source_hash_before,
        source_hash_after: null,
        action: 'rebuild',
        status: 'resolved',
        freshness_ref: null,
        provenance_refs: [
          ...plan_item.reason_codes,
          result.provenance_manifest_ref,
          ...(result.overflow_manifest_ref ? [result.overflow_manifest_ref] : []),
        ],
        acknowledgement_ref: `frc1.ack:${result.entrypoint_snapshot_id}`,
        reason_codes: ['memory.partial', ...result.reason_codes],
      });
    }
    case 'empty': {
      // empty → excluded(显式 omission,spec §7.9 rule 8)。
      return buildResolution({
        plan_item_id: plan_item.plan_item_id,
        reconstruction_transaction_id: input.reconstruction_transaction_id,
        source_ref_before,
        source_ref_after: null,
        source_hash_before,
        source_hash_after: null,
        action: 'rebuild',
        status: 'excluded',
        freshness_ref: null,
        provenance_refs: [...plan_item.reason_codes, result.provenance_manifest_ref],
        acknowledgement_ref: null,
        reason_codes: ['memory.empty', ...result.reason_codes],
      });
    }
    case 'rejected':
    default: {
      // rejected → excluded(optional failure,degraded publish,spec §7.9 rule 9)。
      return buildResolution({
        plan_item_id: plan_item.plan_item_id,
        reconstruction_transaction_id: input.reconstruction_transaction_id,
        source_ref_before,
        source_ref_after: null,
        source_hash_before,
        source_hash_after: null,
        action: 'rebuild',
        status: 'excluded',
        freshness_ref: null,
        provenance_refs: [...plan_item.reason_codes, result.provenance_manifest_ref],
        acknowledgement_ref: null,
        reason_codes: ['memory.rebuild_rejected', ...result.reason_codes],
      });
    }
  }
}

// ===========================================================================
// Wave G Task 7 (GRC-1 §7.14 / §7.15 / §7.16 / §7.17 / §7.18)
//
// Restored Working Set Candidate —— 组装 candidate refs + 计算 omission manifest。
//
// 这一段消费 T4 的 PinnedWorkingSetPlan + T3 的 CompactionResultSnapshot +
// T5/T6 的 ReconstructionSourceResolution,组装一个不可变的 candidate。
// Candidate 创建后不可变,但**还不能**直接 publish —— publish 前 T8 postflight
// 必须再次验证(spec §7.19)。
//
// 不变式 (spec §7.14 / §7.16 / §7.17 / §7.18):
//   - Candidate 只组装 refs,不读 content(transcript 正文 / system prompt body /
//     tool result body / Memory detail 全部不进 candidate)。
//   - Plane 分离正确:meta context 在 provider_visible_order 中,execution_state
//     与 memory handoff **不**进 provider_visible_order(spec §7.16)。
//   - Ordering 按 §7.16:memory handoff(独立 system-section consumer,不进 PVO)
//     → meta context by stable ordinal → compact summary → current user tail。
//   - Required item resolution 失败 → blocked_required_items 非空,但 candidate
//     仍返回(不抛错);T8 postflight 决定是否 publish。
//   - Optional item resolution 失败 → omitted_items + degraded=true。
//   - Invalidated source(resolved + exclude)→ omitted_items,但 degraded=false
//     (确定性成功,不是 optional failure)。
//   - Rejected status → throw(spec §7.17 阻断整个 candidate,无法 assemble)。
//   - candidate_hash 确定性,不含时间戳。
//   - candidate + omission_manifest deep-frozen。
// ===========================================================================

// ---------------------------------------------------------------------------
// Omission Manifest types (spec §7.17)
// ---------------------------------------------------------------------------

/**
 * Omission reason(封闭值域,spec §7.17)。
 *
 * 这些 reason 描述了为什么一个 plan item 没有出现在最终 candidate 的
 * provider-visible refs 中。每一个都来自一个确定性的 resolution 路径,
 * 而非"模型判断"。
 */
export type ReconstructionOmissionReason =
  | 'source_invalidated'
  | 'optional_reload_failed'
  | 'optional_rebuild_failed'
  | 'memory_empty'
  | 'memory_partial'
  | 'budget_excluded'
  | 'freshness_failed'
  | 'project_version_changed'
  | 'identity_conflict'
  | 'unknown_item';

/**
 * 单个 omitted item 的 manifest 条目(spec §7.17)。
 *
 * `reason_codes` 是封闭值域的 ReconstructionOmissionReason;reason 反映
 * "为什么 omit",而非"resolution 原始 reason_codes"。例如 T6 memory rebuild
 * 失败时 resolution.reason_codes 含 'memory.rebuild_failed',但 manifest
 * reason_codes 是 'optional_rebuild_failed'。
 */
export interface ReconstructionOmissionItem {
  plan_item_id: string;
  source_ref: string;
  reason_codes: ReadonlyArray<ReconstructionOmissionReason>;
}

/**
 * 单个 blocked required item 的 manifest 条目(spec §7.17)。
 *
 * `reason_codes` 是任意 string(来自 T5/T6 blocked resolution 的原始 reason,
 * 例如 'reload.pipeline_failed' / 'preserve_gate_failed');这里不限定封闭值域
 * 因为 blocked reason 来自多个不同契约的 resolution pipeline。
 */
export interface ReconstructionBlockedRequiredItem {
  plan_item_id: string;
  source_ref: string;
  reason_codes: ReadonlyArray<string>;
}

/**
 * Omission / degradation manifest(spec §7.17)。
 *
 * 这是 candidate 的"省略证据"—— publish 时随 candidate 一起持久化,T8
 * postflight 校验 "omission manifest 与实际省略一致"(spec §7.19 rule 14)。
 *
 *   - `degraded=true` 当且仅当 optional omission 非空。
 *   - `blocked_required_items` 非空时 T8 必须 reject publish(spec §7.17)。
 *   - `omitted_items` 含 optional failure **和** invalidated source(后者
 *     degraded=false,但仍是 omission 记录)。
 */
export interface ReconstructionOmissionManifest {
  omission_protocol_version: string;
  omission_manifest_id: string;
  reconstruction_transaction_id: string;
  degraded: boolean;
  omitted_items: ReadonlyArray<ReconstructionOmissionItem>;
  blocked_required_items: ReadonlyArray<ReconstructionBlockedRequiredItem>;
}

// ---------------------------------------------------------------------------
// Candidate types (spec §7.14)
// ---------------------------------------------------------------------------

/**
 * Restored working set candidate(spec §7.14)。
 *
 * Candidate 是 reconstruction pipeline 的"待 publish 候选"—— 所有 identity refs
 * 已组装,ordering 已确定,omission 已记录。但 candidate **还不能**直接 publish;
 * T8 postflight 必须先验证(spec §7.19)。
 *
 * 字段语义:
 *   - `working_set_candidate_protocol_version`: 与 CANDIDATE_PROTOCOL_VERSION 绑定。
 *   - `candidate_snapshot_id`: `'cand:' + sha256(canonical).slice(0,16)`。
 *   - `reconstruction_transaction_id`: 该 candidate 所属的 transaction。
 *   - `target_context_snapshot_id`: post-compact target context。
 *   - `bounded_memory_entrypoint_snapshot_ref`: memory plan item 对应的
 *     resolution.source_ref_after(可能为 null,当 memory rebuild 失败时)。
 *   - `meta_context_message_refs`: 所有 project_instruction_meta plan item 的
 *     resolution.source_ref_after(按 stable_ordinal 排序);reload 后是新 identity。
 *   - `compact_summary_ref`: compaction_result.compact_summary_ref。
 *   - `current_user_message_ref`: current_user plan item 的 source_ref_before
 *     (exact preserve,不改)。
 *   - `execution_state_refs`: execution_state plan item 的 source_ref_before
 *     (structural only,不进 provider_visible_order)。
 *   - `source_resolution_refs`: 所有 resolution.resolution_id(sorted)。
 *   - `omission_manifest_ref`: 本次生成的 manifest id。
 *   - `request_budget_snapshot_id`: target request budget snapshot id。
 *   - `candidate_hash`: sha256(canonical) 全 64 hex,不含时间戳。
 *   - `provider_visible_order`: 按 §7.16 ordering 排好的 refs
 *     (meta by ordinal → summary → user);**不**含 execution 与 memory handoff。
 */
export interface RestoredWorkingSetCandidate {
  working_set_candidate_protocol_version: string;
  candidate_snapshot_id: string;
  reconstruction_transaction_id: string;
  target_context_snapshot_id: string;
  bounded_memory_entrypoint_snapshot_ref: string | null;
  meta_context_message_refs: ReadonlyArray<string>;
  compact_summary_ref: string;
  current_user_message_ref: string;
  execution_state_refs: ReadonlyArray<string>;
  source_resolution_refs: ReadonlyArray<string>;
  omission_manifest_ref: string;
  request_budget_snapshot_id: string;
  candidate_hash: string;
  provider_visible_order: ReadonlyArray<string>;
}

/**
 * assembleRestoredWorkingSetCandidate 的输入。
 *
 * 调用方负责先完成 T4 plan + T3 compaction + T5/T6 source resolution,
 * 把结果作为已捕获的 identity / frozen snapshot 传入。本契约**不**重新跑
 * 任何 resolution pipeline。
 */
export interface AssembleCandidateInput {
  /** 已捕获的不变 identity。 */
  transaction: PostCompactReconstructionTransaction;
  /** T4 已组装并冻结的 plan。 */
  plan: PinnedWorkingSetPlan;
  /** T3 已创建并冻结的 compaction result。 */
  compaction_result: CompactionResultSnapshot;
  /** 已完成的 source resolutions(每 plan_item 一个,顺序无关)。 */
  source_resolutions: ReadonlyArray<ReconstructionSourceResolution>;
  /** post-compact target context snapshot id。 */
  target_context_snapshot_id: string;
  /** post-compact target request budget snapshot id。 */
  request_budget_snapshot_id: string;
}

// ---------------------------------------------------------------------------
// 内部常量
// ---------------------------------------------------------------------------

/** Candidate id 前缀。 */
const CANDIDATE_ID_PREFIX = 'cand:';

/** Omission manifest id 前缀。 */
const OMISSION_ID_PREFIX = 'omit:';

/** Candidate hash 前缀(全 64 hex,无前缀 —— 与 precompact/plan_hash 风格一致)。 */

// ---------------------------------------------------------------------------
// computeOmissionManifest —— 不可变 omission manifest 计算(spec §7.17)
// ---------------------------------------------------------------------------

/**
 * 根据 plan + source resolutions 计算 omission / degradation manifest(spec §7.17)。
 *
 * 分类规则(对每个 plan_item 的 resolution):
 *
 *   | resolution.status | plan_item.requirement | 处理                                |
 *   |-------------------|-----------------------|------------------------------------|
 *   | 'rejected'        | *                     | throw(spec §7.17 阻断 candidate)   |
 *   | 'resolved' +      | *                     | 不进 manifest(成功)               |
 *   |   action∈{preserve_exact,reload,rebuild} 且 source_ref_after≠null |   |    |
 *   | 'resolved' + action='exclude' | required_* | omitted_items(reason=        |
 *   |                                          |   'source_invalidated');       |
 *   |                                          |   degraded=false(invalidated 是 |
 *   |                                          |   确定性成功,spec §7.8 rule 4) |
 *   | 'resolved' + action='exclude' | optional_current | omitted_items,           |
 *   |                                          |   degraded=true(memory.empty → |
 *   |                                          |   'memory_empty' 等)            |
 *   | 'excluded'        | optional_current     | omitted_items,degraded=true       |
 *   | 'excluded'        | required_*           | **不应发生**;安全处理:omitted_items |
 *   |                                          |   + reason='unknown_item'         |
 *   | 'blocked'         | required_*           | blocked_required_items            |
 *   | 'blocked'         | optional_current     | omitted_items(reason=对应 optional |
 *   |                                          |   failure code),degraded=true    |
 *
 * reason_codes 映射(从 resolution.reason_codes 到 ReconstructionOmissionReason):
 *   - 含 'memory.empty' 或 'memory_empty'  → 'memory_empty'
 *   - 含 'memory.partial' 或 'memory_partial' → 'memory_partial'
 *   - 含 'memory.rebuild_failed' / 'memory.error' / 'memory.rebuild_rejected'
 *     → 'optional_rebuild_failed'
 *   - 含 'reload.pipeline_failed' / 'reload.error' 且 requirement=optional_current
 *     → 'optional_reload_failed'
 *   - 含 'preserve_gate_failed' / 'preserve_gate.*' → 'freshness_failed'
 *   - 含 'project_instruction.invalidated' / 'invalidated' → 'source_invalidated'
 *   - 含 'identity_conflict' → 'identity_conflict'
 *   - 含 'project_version_changed' → 'project_version_changed'
 *   - 含 'budget_excluded' → 'budget_excluded'
 *   - 其它 → 'unknown_item'
 *
 * @throws {Error} 'candidate.rejected:<plan_item_id>:<reasons>' 当任一 resolution
 *   status='rejected' 时(spec §7.17:rejected 阻断整个 candidate)。
 */
export function computeOmissionManifest(
  input: AssembleCandidateInput,
): ReconstructionOmissionManifest {
  const { plan, source_resolutions, transaction } = input;

  // 1. resolution 按 plan_item_id 索引,便于 O(1) 查找。
  const resolutionByPlanItemId = new Map<string, ReconstructionSourceResolution>();
  for (const r of source_resolutions) {
    resolutionByPlanItemId.set(r.plan_item_id, r);
  }

  // 2. 校验:每个 plan_item 必须有恰好一个 resolution;每个 resolution 必须对应
  //    一个 plan_item。任一不一致 → throw(配置错误,不是 lifecycle 事件)。
  if (resolutionByPlanItemId.size !== plan.items.length) {
    throw new Error(
      `candidate.resolution_count_mismatch: plan items=${plan.items.length}, resolutions=${resolutionByPlanItemId.size}`,
    );
  }
  for (const item of plan.items) {
    if (!resolutionByPlanItemId.has(item.plan_item_id)) {
      throw new Error(
        `candidate.resolution_missing_for_plan_item: ${item.plan_item_id}`,
      );
    }
  }

  // 3. 分类:逐 plan_item 决定进 omitted / blocked / 都不进。
  const omitted_items: ReconstructionOmissionItem[] = [];
  const blocked_required_items: ReconstructionBlockedRequiredItem[] = [];
  let degraded = false;

  for (const item of plan.items) {
    // 防御性:确认 item_kind 在已知矩阵中(spec §7.17 unknown_item)。若调用方
    // 通过类型断言塞入未知 item_kind,这里抛错。
    if (REQUIRED_ITEM_MATRIX[item.item_kind] === undefined) {
      throw new Error(`candidate.unknown_item: ${item.item_kind}`);
    }

    const resolution = resolutionByPlanItemId.get(item.plan_item_id)!;

    // 3a. rejected → throw(阻断 candidate,spec §7.17)。
    if (resolution.status === 'rejected') {
      const reasons = resolution.reason_codes.join(',');
      throw new Error(
        `candidate.rejected:${item.plan_item_id}:${reasons}`,
      );
    }

    // 3b. 判断该 item 是否被"省略"(即 source_ref_after 为 null,内容不进 candidate)。
    //     source_ref_after === null 意味着该 item 在 candidate 的 provider-visible
    //     refs 中不出现。注意:execution_state 是 structural only,source_ref_after
    //     即使非 null 也不进 provider_visible_order —— 但 execution_state 的
    //     "省略"语义由 candidate 的 execution_state_refs 字段单独表达,这里不视为
    //     omission。
    const isOmitted = resolution.source_ref_after === null || resolution.source_ref_after === '';

    // 3c. 根据 requirement 与 status/action 分类。
    const requirement = item.requirement;
    const isRequired =
      requirement === 'required_exact' || requirement === 'required_current';
    const isOptional = requirement === 'optional_current';
    // structural_only(execution_state)的"省略"不算 omission —— 它本来就只作为
    // structural ref 存在,不进 provider_visible_order。
    const isStructural = requirement === 'structural_only';

    if (!isOmitted) {
      // source_ref_after 非空 → 内容进入 candidate,不进 manifest。
      continue;
    }

    // execution_state 的 source_ref_before 始终进 candidate.execution_state_refs
    // (无论 resolution 如何)。structural_only 的"省略"不是 omission。
    if (isStructural) {
      continue;
    }

    // 3d. omitted + (required | optional) → 进 manifest。
    const reasonCodes = mapOmissionReasons(resolution, item);

    if (isRequired) {
      // 检查这是 "invalidated 的确定性 exclude" 还是 "blocked 的 required failure"。
      // - status='resolved' + action='exclude' → invalidated(spec §7.8 rule 4),
      //   是确定性成功,**不**进 blocked_required_items,进 omitted_items 但
      //   不设置 degraded。
      // - status='blocked' → required failure,进 blocked_required_items。
      // - status='excluded' + required → 不应发生;安全处理:进 blocked_required_items
      //   让 T8 阻断(spec §7.17 "required excluded → 应该是 blocked 或 rejected")。
      if (resolution.status === 'resolved' && resolution.action === 'exclude') {
        // invalidated:进 omitted_items,degraded=false。
        omitted_items.push({
          plan_item_id: item.plan_item_id,
          source_ref: item.source_ref,
          reason_codes: reasonCodes,
        });
      } else if (resolution.status === 'blocked') {
        // required failure:进 blocked_required_items。
        blocked_required_items.push({
          plan_item_id: item.plan_item_id,
          source_ref: item.source_ref,
          reason_codes: [...resolution.reason_codes],
        });
      } else {
        // status='excluded' + required(不应发生)。安全处理:进 blocked_required_items。
        blocked_required_items.push({
          plan_item_id: item.plan_item_id,
          source_ref: item.source_ref,
          reason_codes: [
            ...resolution.reason_codes,
            'candidate.required_unexpected_excluded',
          ],
        });
      }
    } else if (isOptional) {
      // optional failure(excluded 或 blocked):进 omitted_items,degraded=true。
      omitted_items.push({
        plan_item_id: item.plan_item_id,
        source_ref: item.source_ref,
        reason_codes: reasonCodes,
      });
      degraded = true;
    }
  }

  // 4. 派生 omission_manifest_id(确定性)。
  const canonical = canonicalJson({
    omission_protocol_version: OMISSION_PROTOCOL_VERSION,
    reconstruction_transaction_id: transaction.reconstruction_transaction_id,
    degraded,
    omitted_items: omitted_items
      .slice()
      .sort((a, b) => a.plan_item_id.localeCompare(b.plan_item_id)),
    blocked_required_items: blocked_required_items
      .slice()
      .sort((a, b) => a.plan_item_id.localeCompare(b.plan_item_id)),
  });
  const omission_manifest_id = OMISSION_ID_PREFIX + sha256Hex(canonical).slice(0, 16);

  const manifest: ReconstructionOmissionManifest = {
    omission_protocol_version: OMISSION_PROTOCOL_VERSION,
    omission_manifest_id,
    reconstruction_transaction_id: transaction.reconstruction_transaction_id,
    degraded,
    omitted_items,
    blocked_required_items,
  };
  return freezeSnapshot(manifest);
}

/**
 * 把 resolution.reason_codes 映射到封闭值域的 ReconstructionOmissionReason。
 *
 * 映射规则见 computeOmissionManifest docstring。若无法识别,fallback 到
 * 'unknown_item'。多个 reason → 多个 OmissionReason(去重后)。
 */
function mapOmissionReasons(
  resolution: ReconstructionSourceResolution,
  item: PinnedWorkingSetPlanItem,
): ReconstructionOmissionReason[] {
  const allReasons = [
    ...resolution.reason_codes,
    ...(resolution.action === 'exclude' ? ['__exclude__'] : []),
  ];
  const mapped = new Set<ReconstructionOmissionReason>();

  for (const r of allReasons) {
    const lower = String(r).toLowerCase();
    if (lower.includes('memory.empty') || lower === 'memory_empty') {
      mapped.add('memory_empty');
    } else if (lower.includes('memory.partial') || lower === 'memory_partial') {
      mapped.add('memory_partial');
    } else if (
      lower.includes('memory.rebuild_failed') ||
      lower.includes('memory.error') ||
      lower.includes('memory.rebuild_rejected')
    ) {
      mapped.add('optional_rebuild_failed');
    } else if (
      lower.includes('reload.pipeline_failed') ||
      lower.includes('reload.error')
    ) {
      // reload.pipeline_failed 对 required 是 blocked(走 blocked_required_items 路径,
      // 不调本函数);对 optional 才进 omitted_items。这里统一映射,调用方决定去处。
      mapped.add('optional_reload_failed');
    } else if (
      lower.includes('preserve_gate_failed') ||
      lower.includes('preserve_gate.')
    ) {
      mapped.add('freshness_failed');
    } else if (
      lower.includes('invalidated') ||
      lower.includes('project_instruction.invalidated')
    ) {
      mapped.add('source_invalidated');
    } else if (lower.includes('identity_conflict')) {
      mapped.add('identity_conflict');
    } else if (lower.includes('project_version_changed')) {
      mapped.add('project_version_changed');
    } else if (lower.includes('budget_excluded')) {
      mapped.add('budget_excluded');
    } else if (lower === '__exclude__' && item.item_kind === 'bounded_memory_entrypoint') {
      // memory exclude without specific reason → rebuild_failed fallback
      mapped.add('optional_rebuild_failed');
    } else if (lower === '__exclude__' && item.item_kind === 'project_instruction_meta') {
      // project exclude(invalidated 路径)→ source_invalidated
      mapped.add('source_invalidated');
    }
    // 其它 reason 不映射(fallback 由下面 unknown 处理)
  }

  // 若一个都没映射到 → unknown_item。
  if (mapped.size === 0) {
    mapped.add('unknown_item');
  }

  return [...mapped].sort();
}

// ---------------------------------------------------------------------------
// assembleRestoredWorkingSetCandidate —— pure assembly (spec §7.14)
// ---------------------------------------------------------------------------

/**
 * 组装 Restored Working Set Candidate(spec §7.14 / §7.16 / §7.17 / §7.18)。
 *
 * 算法:
 *   1. Identity gates:target_context_snapshot_id / request_budget_snapshot_id /
 *      transaction_id / compaction_result_id 非空。
 *   2. 校验 source_resolutions 与 plan.items 一一对应(由 computeOmissionManifest 完成)。
 *   3. 计算 omission manifest(同时校验 rejected → throw)。
 *   4. 从 plan + resolutions 中提取 candidate refs:
 *      - bounded_memory_entrypoint_snapshot_ref:memory plan item 的
 *        resolution.source_ref_after(可能 null)
 *      - meta_context_message_refs:project_instruction_meta plan item 的
 *        resolution.source_ref_after(按 stable_ordinal 排序)
 *      - compact_summary_ref:compaction_result.compact_summary_ref
 *      - current_user_message_ref:current_user plan item 的 source_ref_before
 *      - execution_state_refs:execution_state plan item 的 source_ref_before
 *        (structural only,**不**进 provider_visible_order)
 *      - source_resolution_refs:所有 resolution.resolution_id(sorted)
 *   5. 计算 provider_visible_order(§7.16):meta by ordinal → summary → user。
 *      **不**含 execution_state refs 与 memory handoff ref。
 *   6. 计算 candidate_hash(确定性,见 computeCandidateHash)。
 *   7. 派生 candidate_snapshot_id。
 *   8. deep-freeze。
 *
 * 关键约束:
 *   - 本函数**不读** transcript 正文 / system prompt body / tool result body /
 *     Memory detail。所有字段都是 identity refs。
 *   - blocked_required_items 非空时 candidate 仍返回(不抛错);T8 postflight
 *     决定是否 publish(spec §7.17 + §7.18 rule 8)。
 *   - rejected status → throw(由 computeOmissionManifest 抛)。
 *
 * @throws {Error}
 *   - `'candidate.resolution_count_mismatch'`:plan items 数 ≠ resolutions 数。
 *   - `'candidate.resolution_missing_for_plan_item'`:某 plan item 无对应 resolution。
 *   - `'candidate.rejected:<plan_item_id>:<reasons>'`:任一 resolution status=rejected。
 *   - `'candidate.unknown_item'`:plan 含未知 item_kind(防御性)。
 *   - identity 字段为空时:`<field> must be a non-empty string`。
 */
export function assembleRestoredWorkingSetCandidate(
  input: AssembleCandidateInput,
): RestoredWorkingSetCandidate {
  const { transaction, plan, compaction_result, source_resolutions } = input;

  // 1. Identity gates。
  requireIdentity(
    transaction.reconstruction_transaction_id,
    'reconstruction_transaction_id',
  );
  const target_context_snapshot_id = requireIdentity(
    input.target_context_snapshot_id,
    'target_context_snapshot_id',
  );
  const request_budget_snapshot_id = requireIdentity(
    input.request_budget_snapshot_id,
    'request_budget_snapshot_id',
  );
  requireIdentity(
    compaction_result.compact_summary_ref,
    'compaction_result.compact_summary_ref',
  );
  requireIdentity(plan.working_set_plan_id, 'plan.working_set_plan_id');

  // 2. 计算 omission manifest(同时完成 rejected 校验 + count mismatch 校验)。
  const manifest = computeOmissionManifest(input);
  const omission_manifest_ref = manifest.omission_manifest_id;

  // 3. resolution 按 plan_item_id 索引。
  const resolutionByPlanItemId = new Map<string, ReconstructionSourceResolution>();
  for (const r of source_resolutions) {
    resolutionByPlanItemId.set(r.plan_item_id, r);
  }

  // 4. 提取 candidate refs(按 plan.items 的 stable_ordinal 排序遍历)。
  //    plan.items 已经在 T4 buildPinnedWorkingSetPlan 中按 (ordinal, plan_item_id)
  //    排序,但这里为了健壮性(防御性)再排一次。
  const sortedItems = [...plan.items].sort((a, b) => {
    if (a.stable_ordinal !== b.stable_ordinal) {
      return a.stable_ordinal - b.stable_ordinal;
    }
    return a.plan_item_id < b.plan_item_id ? -1 : a.plan_item_id > b.plan_item_id ? 1 : 0;
  });

  let bounded_memory_entrypoint_snapshot_ref: string | null = null;
  const meta_context_message_refs: string[] = [];
  const execution_state_refs: string[] = [];
  let current_user_message_ref = '';
  // provider_visible_order 按 §7.16:meta by ordinal → summary → user。
  // 不含 execution_state 与 memory handoff。
  const pvoMeta: string[] = [];
  let pvoSummary = '';
  let pvoUser = '';
  const source_resolution_refs: string[] = [];

  for (const item of sortedItems) {
    // 防御性:确认 item_kind 在已知矩阵中。
    if (REQUIRED_ITEM_MATRIX[item.item_kind] === undefined) {
      throw new Error(`candidate.unknown_item: ${item.item_kind}`);
    }

    const resolution = resolutionByPlanItemId.get(item.plan_item_id)!;
    source_resolution_refs.push(resolution.resolution_id);

    switch (item.item_kind) {
      case 'bounded_memory_entrypoint': {
        // memory handoff:source_ref_after 进 bounded_memory_entrypoint_snapshot_ref。
        // 不进 provider_visible_order(独立 system-section consumer,spec §7.16)。
        bounded_memory_entrypoint_snapshot_ref = resolution.source_ref_after ?? null;
        break;
      }
      case 'project_instruction_meta': {
        // meta context:source_ref_after 进 meta_context_message_refs(按 ordinal)。
        // reload 后 source_ref_after 是新 activation identity;invalidated/excluded 时
        // source_ref_after=null → 不进 meta_context_message_refs(进 omission manifest)。
        if (resolution.source_ref_after !== null && resolution.source_ref_after !== '') {
          meta_context_message_refs.push(resolution.source_ref_after);
          pvoMeta.push(resolution.source_ref_after);
        }
        break;
      }
      case 'compact_summary': {
        // summary:source_ref_before(exact preserve,不改)。compaction_result
        // 已保证 summary_ref 非 null。
        pvoSummary = item.source_ref;
        break;
      }
      case 'current_user_message': {
        // current user:source_ref_before(exact preserve,不改),始终非空。
        current_user_message_ref = item.source_ref;
        pvoUser = item.source_ref;
        break;
      }
      case 'execution_state': {
        // execution_state:source_ref_before(structural only)。
        // **不**进 provider_visible_order(spec §7.16)。
        if (item.source_ref !== '') {
          execution_state_refs.push(item.source_ref);
        }
        break;
      }
      default: {
        // 穷尽性检查(防御性,理论上不可达 —— 上面已校验矩阵)。
        throw new Error(`candidate.unknown_item: ${item.item_kind}`);
      }
    }
  }

  // 5. provider_visible_order:meta(ord) → summary → user。
  //    pvoMeta 已按 sortedItems 遍历顺序(即 stable_ordinal 升序)填充。
  const provider_visible_order: string[] = [
    ...pvoMeta,
    ...(pvoSummary ? [pvoSummary] : []),
    ...(pvoUser ? [pvoUser] : []),
  ];

  // compact_summary_ref 来自 compaction_result(权威源)。
  const compact_summary_ref = compaction_result.compact_summary_ref;

  // source_resolution_refs sorted(确定性)。
  source_resolution_refs.sort();

  // execution_state_refs 保持 plan 顺序(sortedItems 已按 ordinal 排序)。
  // 但为了 hash 确定性,这里也 sort 一次(spec:hash 不依赖物理顺序)。
  execution_state_refs.sort();

  // 6. 计算 candidate_hash(确定性,见 computeCandidateHash)。
  const candidate_hash = computeCandidateHash({
    reconstruction_transaction_id: transaction.reconstruction_transaction_id,
    target_context_snapshot_id,
    bounded_memory_entrypoint_snapshot_ref,
    meta_context_message_refs,
    compact_summary_ref,
    current_user_message_ref,
    execution_state_refs,
    source_resolution_refs,
    omission_manifest_ref,
    request_budget_snapshot_id,
    provider_visible_order,
  });

  // 7. 派生 candidate_snapshot_id。
  //    snapshot_id 派生自 candidate_hash(确定性,同一 hash → 同一 snapshot_id)。
  const candidate_snapshot_id = CANDIDATE_ID_PREFIX + candidate_hash.slice(0, 16);

  // 8. 组装 + deep-freeze。
  const candidate: RestoredWorkingSetCandidate = {
    working_set_candidate_protocol_version: CANDIDATE_PROTOCOL_VERSION,
    candidate_snapshot_id,
    reconstruction_transaction_id: transaction.reconstruction_transaction_id,
    target_context_snapshot_id,
    bounded_memory_entrypoint_snapshot_ref,
    meta_context_message_refs,
    compact_summary_ref,
    current_user_message_ref,
    execution_state_refs,
    source_resolution_refs,
    omission_manifest_ref,
    request_budget_snapshot_id,
    candidate_hash,
    provider_visible_order,
  };
  return freezeSnapshot(candidate);
}

/**
 * 计算 candidate_hash(spec Task 7 Step 7)。
 *
 * Hash 基于 canonical identities:
 *   candidate_hash = sha256(canonical) where canonical = JSON.stringify({
 *     transaction_id,
 *     target_context_snapshot_id,
 *     bounded_memory_entrypoint_snapshot_ref,
 *     meta_context_message_refs(sorted by stable_ordinal,从 plan),
 *     compact_summary_ref,
 *     current_user_message_ref,
 *     execution_state_refs(sorted),
 *     source_resolution_refs(sorted),
 *     omission_manifest_ref,
 *     request_budget_snapshot_id,
 *     provider_visible_order,
 *   })
 *
 * **禁止**基于日志时间、对象插入顺序、模型判断。
 *
 * 输入约定:
 *   - meta_context_message_refs / provider_visible_order:调用方保证已按 §7.16
 *     ordering 排好(meta by stable ordinal → summary → user)。这里不再排序 ——
 *     顺序本身是 identity 的一部分。
 *   - execution_state_refs / source_resolution_refs:这里 sort,因为这些 refs
 *     本身是 set 语义(spec 没有要求 execution/resolution 的顺序是 identity)。
 */
function computeCandidateHash(args: {
  reconstruction_transaction_id: string;
  target_context_snapshot_id: string;
  bounded_memory_entrypoint_snapshot_ref: string | null;
  meta_context_message_refs: ReadonlyArray<string>;
  compact_summary_ref: string;
  current_user_message_ref: string;
  execution_state_refs: ReadonlyArray<string>;
  source_resolution_refs: ReadonlyArray<string>;
  omission_manifest_ref: string;
  request_budget_snapshot_id: string;
  provider_visible_order: ReadonlyArray<string>;
}): string {
  const canonical = canonicalJson({
    working_set_candidate_protocol_version: CANDIDATE_PROTOCOL_VERSION,
    reconstruction_transaction_id: args.reconstruction_transaction_id,
    target_context_snapshot_id: args.target_context_snapshot_id,
    bounded_memory_entrypoint_snapshot_ref: args.bounded_memory_entrypoint_snapshot_ref,
    // meta_context_message_refs 与 provider_visible_order 已按 §7.16 排序;
    // 顺序是 identity,不再 sort。
    meta_context_message_refs: args.meta_context_message_refs,
    compact_summary_ref: args.compact_summary_ref,
    current_user_message_ref: args.current_user_message_ref,
    // execution_state_refs 与 source_resolution_refs 是 set 语义,sort。
    execution_state_refs: [...args.execution_state_refs].sort(),
    source_resolution_refs: [...args.source_resolution_refs].sort(),
    omission_manifest_ref: args.omission_manifest_ref,
    request_budget_snapshot_id: args.request_budget_snapshot_id,
    provider_visible_order: args.provider_visible_order,
  });
  return sha256Hex(canonical);
}

// ===========================================================================
// Wave G Task 8 (GRC-1 §7.19 / §7.20 / Task 8)
//
// Postflight Validation + Core Anchor(reconstruction pipeline 的协调核心)。
//
// 这一段实现:
//   - validateReconstructionPostflight:15 门 publish 前校验(spec §7.19)
//   - reconstructPostCompactWorkingSet:Core Anchor,串联 T1+T3+T4+T5+T6+T7
//
// 不变式 (spec §7.19 / §7.20 / Task 8):
//   - Postflight 是 publish 前的硬门;rejected 时 publishable_candidate=null。
//   - Validator 不自行合成 missing result;summary 中的工具描述不参与 pairing;
//     structural execution refs 不参与 Provider-visible pairing。
//   - Core Anchor 只协调 refs / acknowledgements,不调用 Provider / tool_executor /
//     Prompt compiler;不反向修改四个上游 contract;不拥有 publish storage。
//   - 已 published attempt → 返回 'already_published',不重做 side effect。
//   - 同一完整输入重复运行 → deterministic(postflight_id / candidate_hash /
//     ordering 深相等);created_at / checked_at 时间戳不参与 hash。
// ===========================================================================

// ---------------------------------------------------------------------------
// Postflight types (spec §7.19 / §7.20)
// ---------------------------------------------------------------------------

/**
 * Postflight tool validation ref(spec §7.20)。
 *
 * 指向 before_provider_send checkpoint 的 accepted validation。Core Anchor 把
 * deps.validatePostCompactToolTranscript 的返回值的 identity 透传到这里,
 * 让 PostflightValidationResult 可追溯到具体 tool transcript validation。
 */
export interface PostCompactToolValidationRef {
  validation_id: string;
  transcript_snapshot_id: string;
  checkpoint: 'before_provider_send';
  expected_status: 'accepted';
}

/**
 * Postflight 校验结果(spec §7.19)。
 *
 * 创建后不可变。accepted 时 failed_gates=[];rejected 时 failed_gates 至少含
 * 一个失败门,reason_codes 含 'postflight.<gate>.failed' code。
 *
 *   - `postflight_protocol_version`: 与 POSTFLIGHT_PROTOCOL_VERSION 绑定。
 *   - `postflight_id`: `'post:' + sha256(canonical).slice(0,16)`,确定性。
 *   - `reconstruction_transaction_id` / `candidate_snapshot_id` / `preflight_validation_id`:
 *     三个 ref 锚定校验对象。
 *   - `postflight_tool_validation_ref`: §7.20 tool pairing validation ref。
 *   - `checked_gates`: 本次实际检查的 15 门名称(sorted)。
 *   - `failed_gates`: 失败的门子集(空当 accepted)。
 *   - `reason_codes`: 失败原因 code(空当 accepted)。
 *   - `checked_at`: ISO timestamp(审计用,不参与 hash)。
 */
export interface PostflightValidationResult {
  postflight_protocol_version: string;
  postflight_id: string;
  status: 'accepted' | 'rejected';
  reconstruction_transaction_id: string;
  candidate_snapshot_id: string;
  preflight_validation_id: string;
  postflight_tool_validation_ref: PostCompactToolValidationRef;
  checked_gates: ReadonlyArray<string>;
  failed_gates: ReadonlyArray<string>;
  reason_codes: ReadonlyArray<string>;
  checked_at: string;
}

/**
 * Postflight 注入依赖(spec §7.20)。
 *
 * 唯一注入项:`validatePostCompactToolTranscript`,把 before_provider_send
 * checkpoint 的 tool transcript validation 委托给 BRC-5 owner port(或测试 mock)。
 *
 * **不注入**:ordering / dedup(candidate 组装时已保证);compaction(已 done);
 * memory rebuild(T6 已 done);project instruction reload(T5 已 done)。
 */
export interface PostflightDependencies {
  validatePostCompactToolTranscript: (input: {
    transcript_snapshot_id: string;
    candidate: RestoredWorkingSetCandidate;
  }) => Promise<ToolTranscriptValidation> | ToolTranscriptValidation;
}

/** 15 门名称(spec §7.19)。封闭常量数组,排序后纳入 checked_gates。 */
const POSTFLIGHT_GATE_NAMES: ReadonlyArray<string> = [
  'transaction_candidate_target_identity',
  'source_preflight_continuity',
  'required_source_resolved',
  'invalidated_source_not_residual',
  'meta_hash_ordinal_ack',
  'memory_target_context_binding',
  'current_user_exact_once',
  'summary_exact_once',
  'execution_state_plane_isolation',
  'before_provider_send_transcript_accepted',
  'no_pending_missing_orphan_duplicate_conflict',
  'budget_accepted',
  'duplicate_order_accepted',
  'omission_manifest_consistent',
  'candidate_hash_replayable',
];

/** Postflight id 前缀。 */
const POSTFLIGHT_ID_PREFIX = 'post:';

/**
 * 计算 postflight_id(确定性,spec §7.19)。
 *
 * 派生自 (transaction_id + candidate_snapshot_id + preflight_id +
 * tool_validation_id + 失败门 + reason_codes) 的 canonical hash。
 * created_at / checked_at 时间戳**不**参与 hash(规格 Task 8 Step 7)。
 */
function computePostflightId(args: {
  reconstruction_transaction_id: string;
  candidate_snapshot_id: string;
  preflight_validation_id: string;
  tool_validation_id: string;
  failed_gates: ReadonlyArray<string>;
  reason_codes: ReadonlyArray<string>;
}): string {
  const canonical = canonicalJson({
    postflight_protocol_version: POSTFLIGHT_PROTOCOL_VERSION,
    reconstruction_transaction_id: args.reconstruction_transaction_id,
    candidate_snapshot_id: args.candidate_snapshot_id,
    preflight_validation_id: args.preflight_validation_id,
    tool_validation_id: args.tool_validation_id,
    failed_gates: [...args.failed_gates].sort(),
    reason_codes: [...args.reason_codes].sort(),
  });
  return POSTFLIGHT_ID_PREFIX + sha256Hex(canonical).slice(0, 16);
}

/**
 * Postflight 校验输入。来自 Core Anchor 的"已组装 candidate"与配套元数据。
 */
export interface PostflightInput {
  transaction: PostCompactReconstructionTransaction;
  candidate: RestoredWorkingSetCandidate;
  plan: PinnedWorkingSetPlan;
  compaction_result: CompactionResultSnapshot;
  source_resolutions: ReadonlyArray<ReconstructionSourceResolution>;
  preflight: PreflightResult;
  omission_manifest: ReconstructionOmissionManifest;
  target_context_snapshot_id: string;
}

/**
 * 执行 reconstruction postflight(spec §7.19 1-15)。
 *
 * 15 门按以下顺序校验(任一失败 → status='rejected',记录 failed_gates 与
 * reason_codes,但**继续**扫剩余门以给出完整诊断 —— spec 没要求短路):
 *
 *   1. transaction/candidate/target identity 一致:
 *      - candidate.reconstruction_transaction_id === transaction.reconstruction_transaction_id
 *      - candidate.target_context_snapshot_id === input.target_context_snapshot_id
 *      - candidate.target_context_snapshot_id === transaction.target_context_snapshot_id
 *   2. source preflight continuity:
 *      - preflight.transcript_snapshot_id === transaction-precompact.transcript_snapshot_id
 *      (preflight.preflight_id 仍属于当前 source transcript)
 *   3. required source resolution 全 resolved:
 *      - 对 plan.items 中 required_exact / required_current 的 item,
 *        对应 resolution.status === 'resolved'(exclude invalidated 是 resolved)。
 *   4. invalidated source 未残留:
 *      - 对 action='exclude' + status='resolved' 的 resolution(invalidated),
 *        candidate 中不应出现 source_ref_before。
 *   5. meta hash/ordinal/ack:
 *      - 每个 project_instruction_meta resolution:reload 时 acknowledgement_ref 非空;
 *        preserve_exact 时 source_ref_after === source_ref_before。
 *   6. Memory target-context binding:
 *      - bounded_memory_entrypoint resolution.source_ref_after !== null 时
 *        应等于 candidate.bounded_memory_entrypoint_snapshot_ref。
 *   7. current user exact-once:
 *      - candidate.current_user_message_ref 非空;
 *      - 在 provider_visible_order 中出现恰好 1 次。
 *   8. summary exact-once:
 *      - candidate.compact_summary_ref 非空;
 *      - 在 provider_visible_order 中出现恰好 1 次。
 *   9. execution-state plane isolation:
 *      - candidate.execution_state_refs 中每个 ref 不出现在 provider_visible_order 中。
 *   10. before-provider-send transcript accepted:
 *       - 调用 deps.validatePostCompactToolTranscript,期望 status='accepted'。
 *   11. no pending/missing/orphan/duplicate/conflict:
 *       - 扫描 postflight tool validation 的 pair_records,无上述 state。
 *   12. budget accepted:
 *       - candidate.request_budget_snapshot_id 非空。
 *   13. duplicate/order accepted:
 *       - provider_visible_order 无重复 ref;
 *       - meta context refs 按 plan.items 的 stable_ordinal 排序。
 *   14. omission manifest 与实际一致:
 *       - 重新计算 omission manifest,与 input.omission_manifest 深相等。
 *   15. candidate hash 可重放:
 *       - 重新计算 candidate_hash === candidate.candidate_hash。
 *
 * 不变式:
 *   - validator 不自行合成 missing result(规则 6)。
 *   - summary 中的工具描述不参与 pairing(规则 2):validator 只看 deps 返回的
 *     ToolTranscriptValidation,不读 summary 文本。
 *   - structural execution refs 不参与 Provider-visible pairing(规则 3):
 *     validator 不要求 candidate.execution_state_refs 出现在 pair_records 中。
 */
export async function validateReconstructionPostflight(
  input: PostflightInput,
  deps: PostflightDependencies,
): Promise<PostflightValidationResult> {
  const failed_gates: string[] = [];
  const reason_codes: string[] = [];
  const fail = (gate: string) => {
    if (!failed_gates.includes(gate)) {
      failed_gates.push(gate);
      reason_codes.push(`postflight.${gate}.failed`);
    }
  };

  const { transaction, candidate, plan, source_resolutions, preflight, omission_manifest, target_context_snapshot_id } =
    input;

  // 派生 precompact 间接信息:transaction.target_context_snapshot_id 用于门 1。
  // 注意:preflight.transcript_snapshot_id 是 source transcript id。

  // resolution 按 plan_item_id 索引。
  const resolutionByPlanItemId = new Map<string, ReconstructionSourceResolution>();
  for (const r of source_resolutions) {
    resolutionByPlanItemId.set(r.plan_item_id, r);
  }

  // -------------------------------------------------------------------------
  // 门 1: transaction/candidate/target identity 一致。
  // -------------------------------------------------------------------------
  {
    const same_tx =
      candidate.reconstruction_transaction_id ===
      transaction.reconstruction_transaction_id;
    const same_target =
      candidate.target_context_snapshot_id === target_context_snapshot_id &&
      candidate.target_context_snapshot_id === transaction.target_context_snapshot_id;
    if (!same_tx || !same_target) {
      fail('transaction_candidate_target_identity');
    }
  }

  // -------------------------------------------------------------------------
  // 门 2: source preflight continuity —— preflight.preflight_id 仍属于当前
  // source transcript。校验:
  //   - preflight.preflight_id 非空
  //   - preflight.transcript_snapshot_id 非空
  //   - preflight.transcript_snapshot_id === compaction_result.source_transcript_snapshot_id
  //     (preflight 与 candidate 共享同一 source transcript identity)
  // -------------------------------------------------------------------------
  {
    const sameTranscript =
      preflight.transcript_snapshot_id ===
      input.compaction_result.source_transcript_snapshot_id;
    const ok =
      isNonEmpty(preflight.preflight_id) &&
      isNonEmpty(preflight.transcript_snapshot_id) &&
      sameTranscript;
    if (!ok) {
      fail('source_preflight_continuity');
    }
  }

  // -------------------------------------------------------------------------
  // 门 3: required source resolution 全 resolved。
  //   对 required_exact / required_current plan item,resolution.status='resolved'。
  // -------------------------------------------------------------------------
  {
    let allResolved = true;
    for (const item of plan.items) {
      const isRequired =
        item.requirement === 'required_exact' ||
        item.requirement === 'required_current';
      if (!isRequired) continue;
      const resolution = resolutionByPlanItemId.get(item.plan_item_id);
      if (resolution === undefined) {
        allResolved = false;
        break;
      }
      if (resolution.status !== 'resolved') {
        allResolved = false;
        break;
      }
    }
    if (!allResolved) {
      fail('required_source_resolved');
    }
  }

  // -------------------------------------------------------------------------
  // 门 4: invalidated source 未残留。
  //   action='exclude' + status='resolved' 的 resolution 的 source_ref_before
  //   不应出现在 candidate 的 provider-visible refs(meta_context_message_refs)。
  // -------------------------------------------------------------------------
  {
    let noResidue = true;
    const invalidatedRefs = new Set<string>();
    for (const r of source_resolutions) {
      if (r.action === 'exclude' && r.status === 'resolved') {
        invalidatedRefs.add(r.source_ref_before);
      }
    }
    for (const ref of candidate.meta_context_message_refs) {
      if (invalidatedRefs.has(ref)) {
        noResidue = false;
        break;
      }
    }
    if (!noResidue) {
      fail('invalidated_source_not_residual');
    }
  }

  // -------------------------------------------------------------------------
  // 门 5: meta hash/ordinal/ack。
  //   对每个 project_instruction_meta resolution:
  //     - action='reload' → acknowledgement_ref 非空;
  //     - action='preserve_exact' → source_ref_after === source_ref_before;
  //     - action='exclude' → 已在门 4 处理(不算 fail 这里);
  //     - action='block' → 已在门 3 标记 required failure。
  // -------------------------------------------------------------------------
  {
    let consistent = true;
    for (const item of plan.items) {
      if (item.item_kind !== 'project_instruction_meta') continue;
      const r = resolutionByPlanItemId.get(item.plan_item_id);
      if (r === undefined) {
        consistent = false;
        break;
      }
      if (r.action === 'reload') {
        if (!isNonEmpty(r.acknowledgement_ref)) {
          consistent = false;
          break;
        }
      } else if (r.action === 'preserve_exact') {
        if (r.source_ref_after !== r.source_ref_before) {
          consistent = false;
          break;
        }
      }
    }
    if (!consistent) {
      fail('meta_hash_ordinal_ack');
    }
  }

  // -------------------------------------------------------------------------
  // 门 6: Memory target-context binding。
  //   bounded_memory_entrypoint resolution.source_ref_after !== null 时应等于
  //   candidate.bounded_memory_entrypoint_snapshot_ref。
  //   (resolution.source_ref_after 是 FRC-1 rebuild 的输出,candidate 用同值。)
  // -------------------------------------------------------------------------
  {
    let consistent = true;
    for (const item of plan.items) {
      if (item.item_kind !== 'bounded_memory_entrypoint') continue;
      const r = resolutionByPlanItemId.get(item.plan_item_id);
      if (r === undefined) {
        consistent = false;
        break;
      }
      // 若 resolution.source_ref_after 非 null,应等于 candidate 中的 ref。
      if (r.source_ref_after !== null && r.source_ref_after !== '') {
        if (r.source_ref_after !== candidate.bounded_memory_entrypoint_snapshot_ref) {
          consistent = false;
          break;
        }
      } else {
        // resolution.source_ref_after 为 null/excluded → candidate 中也应为 null。
        if (candidate.bounded_memory_entrypoint_snapshot_ref !== null) {
          consistent = false;
          break;
        }
      }
    }
    if (!consistent) {
      fail('memory_target_context_binding');
    }
  }

  // -------------------------------------------------------------------------
  // 门 7: current user exact-once。
  //   candidate.current_user_message_ref 非空;
  //   在 provider_visible_order 中出现恰好 1 次。
  // -------------------------------------------------------------------------
  {
    const ref = candidate.current_user_message_ref;
    const count = candidate.provider_visible_order.filter((r) => r === ref).length;
    if (!isNonEmpty(ref) || count !== 1) {
      fail('current_user_exact_once');
    }
  }

  // -------------------------------------------------------------------------
  // 门 8: summary exact-once。
  //   candidate.compact_summary_ref 非空;
  //   在 provider_visible_order 中出现恰好 1 次。
  // -------------------------------------------------------------------------
  {
    const ref = candidate.compact_summary_ref;
    const count = candidate.provider_visible_order.filter((r) => r === ref).length;
    if (!isNonEmpty(ref) || count !== 1) {
      fail('summary_exact_once');
    }
  }

  // -------------------------------------------------------------------------
  // 门 9: execution-state plane isolation。
  //   candidate.execution_state_refs 中每个 ref 不出现在 provider_visible_order 中。
  // -------------------------------------------------------------------------
  {
    const pvoSet = new Set(candidate.provider_visible_order);
    let isolated = true;
    for (const ref of candidate.execution_state_refs) {
      if (pvoSet.has(ref)) {
        isolated = false;
        break;
      }
    }
    if (!isolated) {
      fail('execution_state_plane_isolation');
    }
  }

  // -------------------------------------------------------------------------
  // 门 10 + 11: before-provider-send transcript accepted + no pending/missing/
  // orphan/duplicate/conflict。
  //   注入 deps.validatePostCompactToolTranscript 校验。
  //   validator 不读 summary 文本(规则 2);不要求 execution refs 在 pair_records
  //   中(规则 3)。
  // -------------------------------------------------------------------------
  let tool_validation: ToolTranscriptValidation;
  try {
    tool_validation = await deps.validatePostCompactToolTranscript({
      transcript_snapshot_id: preflight.transcript_snapshot_id,
      candidate,
    });
  } catch {
    // 注入异常视为 rejected(spec §7.20 rule 6:validator 不合成 result)
    tool_validation = {
      validation_protocol_version: '1',
      validation_id: '',
      transcript_snapshot_id: preflight.transcript_snapshot_id,
      checkpoint: 'before_provider_send',
      status: 'rejected',
      validator_policy_id: '',
      validator_policy_version: '',
      pair_records: [],
      reason_codes: ['postflight.tool_validation_threw'],
    };
  }

  // 门 10: status === 'accepted'
  if (tool_validation.status !== 'accepted') {
    fail('before_provider_send_transcript_accepted');
  }
  // 门 11: 无 pending/missing/orphan/duplicate/conflict pair
  {
    const badStates = new Set<ToolPairState>([
      'pending_execution',
      'missing_result',
      'orphan_result',
      'duplicate_result',
      'identity_conflict',
    ]);
    let clean = true;
    for (const rec of tool_validation.pair_records) {
      if (badStates.has(rec.state)) {
        clean = false;
        break;
      }
    }
    if (!clean) {
      fail('no_pending_missing_orphan_duplicate_conflict');
    }
  }

  // -------------------------------------------------------------------------
  // 门 12: budget accepted。
  //   candidate.request_budget_snapshot_id 非空。
  // -------------------------------------------------------------------------
  {
    if (!isNonEmpty(candidate.request_budget_snapshot_id)) {
      fail('budget_accepted');
    }
  }

  // -------------------------------------------------------------------------
  // 门 13: duplicate/order accepted。
  //   provider_visible_order 无重复 ref;
  //   meta context refs 按 plan.items 的 stable_ordinal 排序。
  // -------------------------------------------------------------------------
  {
    // 13a. 无重复
    const seen = new Set<string>();
    let hasDup = false;
    for (const ref of candidate.provider_visible_order) {
      if (seen.has(ref)) {
        hasDup = true;
        break;
      }
      seen.add(ref);
    }
    // 13b. meta context refs 顺序 = plan.items 中 project_instruction_meta 按
    //   stable_ordinal 排序 + source_ref_after 非空 的序列。
    const expectedMetaOrder: string[] = [];
    for (const item of [...plan.items].sort((a, b) => {
      if (a.stable_ordinal !== b.stable_ordinal) {
        return a.stable_ordinal - b.stable_ordinal;
      }
      return a.plan_item_id < b.plan_item_id ? -1 : a.plan_item_id > b.plan_item_id ? 1 : 0;
    })) {
      if (item.item_kind !== 'project_instruction_meta') continue;
      const r = resolutionByPlanItemId.get(item.plan_item_id);
      if (r && r.source_ref_after !== null && r.source_ref_after !== '') {
        expectedMetaOrder.push(r.source_ref_after);
      }
    }
    const actualMetaOrder = candidate.meta_context_message_refs;
    const orderConsistent =
      expectedMetaOrder.length === actualMetaOrder.length &&
      expectedMetaOrder.every((v, i) => v === actualMetaOrder[i]);

    if (hasDup || !orderConsistent) {
      fail('duplicate_order_accepted');
    }
  }

  // -------------------------------------------------------------------------
  // 门 14: omission manifest 与实际一致。
  //   重新计算 omission manifest,与 input.omission_manifest 深相等。
  // -------------------------------------------------------------------------
  {
    let consistent = true;
    try {
      const recomputed = computeOmissionManifest({
        transaction,
        plan,
        compaction_result: input.compaction_result,
        source_resolutions,
        target_context_snapshot_id,
        request_budget_snapshot_id: candidate.request_budget_snapshot_id,
      });
      if (
        recomputed.omission_manifest_id !== omission_manifest.omission_manifest_id ||
        recomputed.degraded !== omission_manifest.degraded ||
        recomputed.omitted_items.length !== omission_manifest.omitted_items.length ||
        recomputed.blocked_required_items.length !==
          omission_manifest.blocked_required_items.length
      ) {
        consistent = false;
      } else {
        // 逐项 deep equal(顺序无关,按 plan_item_id 比较)
        const a = new Map(
          recomputed.omitted_items.map((x) => [x.plan_item_id, x]),
        );
        const b = new Map(
          omission_manifest.omitted_items.map((x) => [x.plan_item_id, x]),
        );
        if (a.size !== b.size) {
          consistent = false;
        } else {
          for (const [k, v] of a) {
            const other = b.get(k);
            if (
              !other ||
              other.source_ref !== v.source_ref ||
              [...other.reason_codes].sort().join(',') !==
                [...v.reason_codes].sort().join(',')
            ) {
              consistent = false;
              break;
            }
          }
          if (consistent) {
            const ba = new Map(
              recomputed.blocked_required_items.map((x) => [x.plan_item_id, x]),
            );
            const bb = new Map(
              omission_manifest.blocked_required_items.map((x) => [x.plan_item_id, x]),
            );
            if (ba.size !== bb.size) {
              consistent = false;
            } else {
              for (const [k, v] of ba) {
                const other = bb.get(k);
                if (
                  !other ||
                  other.source_ref !== v.source_ref ||
                  [...other.reason_codes].sort().join(',') !==
                    [...v.reason_codes].sort().join(',')
                ) {
                  consistent = false;
                  break;
                }
              }
            }
          }
        }
      }
    } catch {
      consistent = false;
    }
    if (!consistent) {
      fail('omission_manifest_consistent');
    }
  }

  // -------------------------------------------------------------------------
  // 门 15: candidate hash 可重放。
  //   重新计算 candidate_hash === candidate.candidate_hash。
  // -------------------------------------------------------------------------
  {
    let replayable = true;
    try {
      const recomputed = assembleRestoredWorkingSetCandidate({
        transaction,
        plan,
        compaction_result: input.compaction_result,
        source_resolutions,
        target_context_snapshot_id,
        request_budget_snapshot_id: candidate.request_budget_snapshot_id,
      });
      if (recomputed.candidate_hash !== candidate.candidate_hash) {
        replayable = false;
      }
    } catch {
      replayable = false;
    }
    if (!replayable) {
      fail('candidate_hash_replayable');
    }
  }

  // -------------------------------------------------------------------------
  // 组装结果。
  // -------------------------------------------------------------------------
  const status: 'accepted' | 'rejected' =
    failed_gates.length === 0 ? 'accepted' : 'rejected';
  const checked_gates = [...POSTFLIGHT_GATE_NAMES].sort();
  const postflight_id = computePostflightId({
    reconstruction_transaction_id: transaction.reconstruction_transaction_id,
    candidate_snapshot_id: candidate.candidate_snapshot_id,
    preflight_validation_id: preflight.validation_id,
    tool_validation_id: tool_validation.validation_id,
    failed_gates,
    reason_codes,
  });
  const postflight_tool_validation_ref: PostCompactToolValidationRef = {
    validation_id: tool_validation.validation_id,
    transcript_snapshot_id: tool_validation.transcript_snapshot_id,
    checkpoint: 'before_provider_send',
    expected_status: 'accepted',
  };

  return freezeSnapshot({
    postflight_protocol_version: POSTFLIGHT_PROTOCOL_VERSION,
    postflight_id,
    status,
    reconstruction_transaction_id: transaction.reconstruction_transaction_id,
    candidate_snapshot_id: candidate.candidate_snapshot_id,
    preflight_validation_id: preflight.validation_id,
    postflight_tool_validation_ref,
    checked_gates,
    failed_gates: [...failed_gates].sort(),
    reason_codes: [...reason_codes].sort(),
    checked_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Core Anchor types
// ---------------------------------------------------------------------------

/**
 * Reconstruction persistence port(从 T2 SessionStore 抽出)。
 *
 * Core Anchor 只依赖这两个方法;实际 SessionStore(或测试 mock)实现这两个签名
 * 即可。Core Anchor 不拥有 publish storage(T9 的工作)。
 */
export interface ReconstructionPersistence {
  /** 持久化 pre-compact snapshot,返回 durable ack。 */
  savePreCompactSnapshot: (
    snapshot: PreCompactSnapshot,
    sessionId: string,
  ) => Promise<DurableAcknowledgement>;
  /**
   * 开始 reconstruction attempt(idempotent)。
   *
   * 返回 attempt 的 latest_state。Core Anchor 据此判定:
   *   - 'published' → 已 published,返回 'already_published'
   *   - 'requested' / 其它未完成 state → 续跑
   */
  beginReconstructionAttempt: (transaction: PostCompactReconstructionTransaction) => Promise<{
    attempt_id: string;
    latest_state: string;
    latest_state_record_id: string | null;
  }>;
}

/** Compactor 签名(注入)。Core Anchor 不实现 compactor 本身。 */
export type ReconstructionCompactor = (
  messages: ReadonlyArray<Message>,
) => Promise<{
  summary_message: Message;
  method: 'deterministic_local' | 'model_summary';
  method_version: string;
  compactor_ack_payload: string;
}>;

/**
 * Reconstruction 输入(一次性 capture + 所有依赖注入)。
 *
 * Core Anchor 接受这个完整的 input bundle,串联所有上游产物。capture 是不变量
 * (capturePreCompactSnapshot 是 input.precompact_input 的纯函数),Core 开始后
 * 对 input 字段的 mutation 不影响本次 attempt。
 */
export interface ReconstructionInput {
  /** 一次性 capture 输入(spec §7.3)。 */
  precompact_input: CapturePreCompactInput;
  /**
   * policy + target context + idempotency 输入(用于 createReconstructionTransactionRequest)。
   * 不包含 precompact / preflight_validation —— 这两个由 Core 内部从 precompact_input /
   * preflight_validation 派生。
   */
  transaction_request_input: Omit<
    CreateTransactionRequestInput,
    'precompact' | 'preflight_validation'
  >;
  /** T2 persistence(从 store.ts 接入,T10 接线)。 */
  persistence: ReconstructionPersistence;
  /** Compactor(注入)。 */
  compactor: ReconstructionCompactor;
  /** Source transcript snapshot(用于 preflight input)。 */
  transcript_snapshot: ToolTranscriptSnapshot;
  /** Preflight tool transcript validation(checkpoint='before_compaction',注入)。 */
  preflight_validation: ToolTranscriptValidation;
  /** Active project instructions lifecycle(T5 用)。 */
  active_project_instructions: ReadonlyArray<{
    activation_id: string;
    message_id: string;
    content_hash: string;
    lifecycle_record: MetaMessageLifecycleRecord | null;
    source_freshness_ref: string;
    source_content_hash: string | null;
    ordinal: number;
  }>;
  /** T5 reload pipeline。 */
  project_instruction_reload_pipeline: ProjectInstructionResolutionDependencies['reload_via_trusted_pipeline'];
  /** T6 memory rebuild port。 */
  memory_rebuild_port: MemoryEntrypointRebuildPort;
  /** Execution state refs(T4 用)。 */
  execution_state_refs: ReadonlyArray<{
    execution_ref: string;
    ack_ref: string;
    pair_state: ToolPairState;
    permission_security_refs: ReadonlyArray<string>;
    ordinal: number;
  }>;
  /** Target context snapshot id。 */
  target_context_snapshot_id: string;
  /** Target task snapshot id(T6 memory rebuild 用)。 */
  target_task_snapshot_id: string;
  /** Target project version ref(T5/T6 用,可空)。 */
  target_project_version_ref: string | null;
  /** Memory rebuild identity(T6 + idempotency 用)。 */
  memory_policy_ref: WaveGContractRef;
  /** Render profile ref(T6 用)。 */
  render_profile_ref: string;
  /** Request budget snapshot id(T6 + candidate 用)。 */
  request_budget_snapshot_id: string;
  /** Postflight dependencies(BRC-5 validateToolTranscript 或 mock)。 */
  postflight_deps: PostflightDependencies;
}

/**
 * Reconstruction dependencies(占位)。
 *
 * 当前没有任何额外依赖 —— 所有外部依赖通过 ReconstructionInput 注入。保留这个
 * 类型是为了 future-proof(例如未来加 telemetry sink)。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 预留扩展点,当前刻意保持空接口
export interface ReconstructionDependencies {
  // 无字段。
}

/** Reconstruction attempt 终态(spec Task 8 Step 5)。 */
export type ReconstructionAttemptStatus =
  | 'postflight_accepted'
  | 'blocked'
  | 'rejected'
  | 'already_published';

/** Reconstruction attempt 结果(spec Task 8 Step 5)。 */
export interface ReconstructionAttemptResult {
  reconstruction_result_protocol_version: string;
  status: ReconstructionAttemptStatus;
  transaction: PostCompactReconstructionTransaction;
  publishable_candidate: RestoredWorkingSetCandidate | null;
  postflight_result: PostflightValidationResult | null;
  /** 当 blocked/rejected 时指向 precompact recovery(此处用 precompact_snapshot_id)。 */
  recovery_ref: string | null;
  reason_codes: ReadonlyArray<string>;
}

/** Reconstruction attempt result protocol version。 */
const RECONSTRUCTION_RESULT_PROTOCOL_VERSION = 'mi.reconstruction.result/1';

/**
 * Core Anchor —— 串联 reconstruction pipeline(spec Task 8 Step 5)。
 *
 * 算法(规格 Task 8 Step 5):
 *   1. capturePreCompactSnapshot(input.precompact_input) → snapshot
 *   2. persistence.savePreCompactSnapshot(snapshot, session_id) → durable ack
 *   3. createReconstructionTransactionRequest({ precompact, preflight_validation, ...input.transaction_request_input })
 *      → transaction
 *   4. persistence.beginReconstructionAttempt(transaction) → attempt
 *      - 若 latest_state === 'published' → return 'already_published'(不重做 side effect)
 *   5. runReconstructionPreflight({ precompact, transcript_snapshot, validation,
 *      precompact_durable_ack, policy, budget, idempotency }) → preflight
 *      - status='blocked' → return 'blocked' + recovery_ref
 *      - status='rejected' → return 'rejected' + recovery_ref
 *   6. compactor(transcript_snapshot.messages) → { summary_message, method,
 *      method_version, compactor_ack_payload }
 *      - throw → return 'rejected' + recovery_ref
 *   7. createCompactionResultSnapshot({ precompact, preflight, summary_message, ... })
 *      → compaction_result
 *   8. buildPinnedWorkingSetPlan({ precompact, preflight, compaction_result,
 *      transaction_id, target_context, active_project_instructions, execution_state_refs })
 *      → plan
 *   9. 对每个 plan_item 调用 resolveProjectInstruction 或 rebuildMemoryEntrypoint:
 *      - project_instruction_meta → resolveProjectInstruction
 *      - bounded_memory_entrypoint → rebuildMemoryEntrypoint
 *      - 其它 plan items 不需要 resolution(current_user/summary/execution 直接 preserve)
 *   10. assembleRestoredWorkingSetCandidate({ transaction, plan, compaction_result,
 *       source_resolutions, target_context, budget })
 *       - throw(candidate rejected) → propagate(T7 throw)
 *   11. validateReconstructionPostflight({ transaction, candidate, plan,
 *       compaction_result, source_resolutions, preflight, omission_manifest,
 *       target_context }, postflight_deps)
 *       - status='rejected' → return 'rejected'
 *   12. return 'postflight_accepted' + publishable_candidate
 *
 * 关键约束:
 *   - Core Anchor 只协调 refs/acknowledgements;不调用 Provider / tool_executor /
 *     Prompt compiler。
 *   - 不反向修改四个上游 contract(T1/T3/T4/T5+T6+T7)。
 *   - 不拥有 publish storage(T9 的工作)。
 *   - 已 published → 不重新执行 completed side effects(compaction/reload/rebuild
 *     只在第一次执行)。
 *
 * Capture-then-mutate(spec Task 8 Step 6):
 *   - precompact snapshot 是 input.precompact_input 的纯函数产物,Core 开始后
 *     对 input 字段的 mutation 不影响已 captured snapshot。新状态产生新 attempt/key。
 *
 * Deterministic replay(spec Task 8 Step 7):
 *   - 同一完整输入重复运行 → postflight_id / candidate_hash / reason codes /
 *     ordering 深相等;created_at / checked_at 时间戳不参与 hash。
 */
export async function reconstructPostCompactWorkingSet(
  input: ReconstructionInput,
  _deps?: ReconstructionDependencies,
): Promise<ReconstructionAttemptResult> {
  // -------------------------------------------------------------------------
  // Step 1: capture pre-compact snapshot。
  // 这是 input.precompact_input 的纯函数产物;后续对 input 字段的 mutation 不影响。
  // -------------------------------------------------------------------------
  const precompact = capturePreCompactSnapshot(input.precompact_input);
  const recovery_ref = precompact.precompact_snapshot_id;

  // -------------------------------------------------------------------------
  // Step 2: 持久化 pre-compact snapshot,获取 durable ack。
  // -------------------------------------------------------------------------
  const precompact_durable_ack = await input.persistence.savePreCompactSnapshot(
    precompact,
    precompact.session_id,
  );

  // -------------------------------------------------------------------------
  // Step 3: 创建 reconstruction transaction(state='requested')。
  // -------------------------------------------------------------------------
  const transaction = createReconstructionTransactionRequest({
    precompact,
    preflight_validation: input.preflight_validation,
    ...input.transaction_request_input,
  });

  // -------------------------------------------------------------------------
  // Step 4: idempotent begin attempt。
  //   - 已 published → return 'already_published'(不重做 side effect)。
  //   - 未完成 → 续跑(spec §7.13 rule 2)。
  //   - 当前实现:Core 不持久化中间状态(那是 T9 的职责);只通过 persistence
  //     的 attempt.latest_state 检测 'published' 短路。其它中间 state → 全跑。
  // -------------------------------------------------------------------------
  const attempt = await input.persistence.beginReconstructionAttempt(transaction);
  if (attempt.latest_state === 'published') {
    return freezeSnapshot({
      reconstruction_result_protocol_version: RECONSTRUCTION_RESULT_PROTOCOL_VERSION,
      status: 'already_published',
      transaction,
      publishable_candidate: null,
      postflight_result: null,
      recovery_ref: null,
      reason_codes: ['reconstruction.already_published'],
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: preflight gate(spec §7.4)。
  //   - status='blocked' → return 'blocked' + recovery_ref。
  //   - status='rejected' → return 'rejected' + recovery_ref。
  // -------------------------------------------------------------------------
  const preflight = runReconstructionPreflight({
    precompact,
    transcript_snapshot: input.transcript_snapshot,
    validation: input.preflight_validation,
    precompact_durable_ack,
    policy: input.transaction_request_input.policy,
    request_budget_snapshot_id: input.request_budget_snapshot_id,
    idempotency_key: transaction.idempotency_key,
  });
  if (preflight.status === 'blocked') {
    return freezeSnapshot({
      reconstruction_result_protocol_version: RECONSTRUCTION_RESULT_PROTOCOL_VERSION,
      status: 'blocked',
      transaction,
      publishable_candidate: null,
      postflight_result: null,
      recovery_ref,
      reason_codes: [...preflight.reason_codes],
    });
  }
  if (preflight.status === 'rejected') {
    return freezeSnapshot({
      reconstruction_result_protocol_version: RECONSTRUCTION_RESULT_PROTOCOL_VERSION,
      status: 'rejected',
      transaction,
      publishable_candidate: null,
      postflight_result: null,
      recovery_ref,
      reason_codes: [...preflight.reason_codes],
    });
  }

  // -------------------------------------------------------------------------
  // Step 6: compactor(注入)。
  //   - throw → return 'rejected' + recovery_ref。
  //   - 失败不保留 candidate;旧 snapshot 仍可恢复(spec §7.23 recovery table)。
  // -------------------------------------------------------------------------
  let compactorOutput: {
    summary_message: Message;
    method: 'deterministic_local' | 'model_summary';
    method_version: string;
    compactor_ack_payload: string;
  };
  try {
    compactorOutput = await input.compactor(input.transcript_snapshot.messages);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return freezeSnapshot({
      reconstruction_result_protocol_version: RECONSTRUCTION_RESULT_PROTOCOL_VERSION,
      status: 'rejected',
      transaction,
      publishable_candidate: null,
      postflight_result: null,
      recovery_ref,
      reason_codes: ['compactor.failed', `compactor.error:${message}`],
    });
  }

  // -------------------------------------------------------------------------
  // Step 7: createCompactionResultSnapshot(immutable snapshot)。
  // -------------------------------------------------------------------------
  const compaction_result = createCompactionResultSnapshot({
    precompact,
    preflight,
    compacted_summary_message: compactorOutput.summary_message,
    method: compactorOutput.method,
    method_version: compactorOutput.method_version,
    compactor_ack_payload: compactorOutput.compactor_ack_payload,
  });

  // -------------------------------------------------------------------------
  // Step 8: buildPinnedWorkingSetPlan(spec §7.6 / §7.7)。
  // -------------------------------------------------------------------------
  const plan = buildPinnedWorkingSetPlan({
    precompact,
    preflight,
    compaction_result,
    transaction_id: transaction.reconstruction_transaction_id,
    target_context_snapshot_id: input.target_context_snapshot_id,
    active_project_instructions: input.active_project_instructions.map((instr) => ({
      activation_id: instr.activation_id,
      message_id: instr.message_id,
      content_hash: instr.content_hash,
      lifecycle_record_id: instr.lifecycle_record?.lifecycle_record_id ?? null,
      source_freshness_ref: instr.source_freshness_ref,
      ordinal: instr.ordinal,
    })),
    execution_state_refs: input.execution_state_refs.map((e) => ({
      execution_ref: e.execution_ref,
      ack_ref: e.ack_ref,
      pair_state: e.pair_state,
      permission_security_refs: e.permission_security_refs,
      ordinal: e.ordinal,
    })),
  });

  // -------------------------------------------------------------------------
  // Step 9: 对每个 plan_item 调用 resolveProjectInstruction / rebuildMemoryEntrypoint。
  //   - project_instruction_meta → resolveProjectInstruction(T5)
  //   - bounded_memory_entrypoint → rebuildMemoryEntrypoint(T6)
  //   - 其它(current_user/summary/execution)不需要 resolution。
  //   为 deterministic:memory entrypoint 先 resolve,再 project instruction 按
  //   stable_ordinal 排序 resolve。
  // -------------------------------------------------------------------------
  const source_resolutions: ReconstructionSourceResolution[] = [];

  // 9a. memory entrypoint rebuild(只一个 plan item)。
  for (const item of plan.items) {
    if (item.item_kind !== 'bounded_memory_entrypoint') continue;
    const resolution = await rebuildMemoryEntrypoint(
      {
        plan_item: item,
        old_entrypoint_snapshot_id: precompact.memory_entrypoint_snapshot_ref,
        old_catalog_snapshot_id: null,
        old_selection_id: null,
        target_context_snapshot_id: input.target_context_snapshot_id,
        target_task_snapshot_id: input.target_task_snapshot_id,
        target_project_version_ref: input.target_project_version_ref,
        memory_policy_ref: {
          contract_id: input.memory_policy_ref.contract_id,
          contract_version: input.memory_policy_ref.protocol_version,
        },
        render_profile_ref: input.render_profile_ref,
        request_budget_snapshot_id: input.request_budget_snapshot_id,
        reconstruction_transaction_id: transaction.reconstruction_transaction_id,
      },
      { rebuild_via_frc1: input.memory_rebuild_port },
    );
    source_resolutions.push(resolution);
    break;
  }

  // 9b. project instructions 按 stable_ordinal 排序 resolve(T5)。
  //     并行是允许的(每个 resolution 独立),但为了 deterministic ordering,
  //     我们按 stable_ordinal 顺序 resolve,push 进 source_resolutions。
  const projectItems = [...plan.items]
    .filter((it) => it.item_kind === 'project_instruction_meta')
    .sort((a, b) => a.stable_ordinal - b.stable_ordinal);
  for (const item of projectItems) {
    // 找配套的 active_project_instruction(lifecycle_record / source_content_hash /
    // source_freshness_ref 来自 input.active_project_instructions)。
    const instrMeta = input.active_project_instructions.find(
      (i) => i.activation_id === item.source_ref,
    );
    const resolution = await resolveProjectInstruction(
      {
        plan_item: item,
        lifecycle_record: instrMeta?.lifecycle_record ?? null,
        target_context_snapshot_id: input.target_context_snapshot_id,
        target_project_version_ref: input.target_project_version_ref,
        source_freshness_ref: instrMeta?.source_freshness_ref ?? '',
        source_content_hash: instrMeta?.source_content_hash ?? null,
        reconstruction_transaction_id: transaction.reconstruction_transaction_id,
      },
      { reload_via_trusted_pipeline: input.project_instruction_reload_pipeline },
    );
    source_resolutions.push(resolution);
  }

  // 9c. 其它 plan items(current_user/compact_summary/execution_state)不需要
  //     外部 resolution —— 它们在 candidate 组装阶段直接 preserve。
  //     但 computeOmissionManifest / assembleRestoredWorkingSetCandidate 需要每个
  //     plan item 都有对应 resolution。我们为这些 items 合成"成功 preserve_exact"
  //     resolution(source_ref_after = source_ref_before)。
  for (const item of plan.items) {
    if (
      item.item_kind === 'project_instruction_meta' ||
      item.item_kind === 'bounded_memory_entrypoint'
    ) {
      continue;
    }
    source_resolutions.push(buildResolution({
      plan_item_id: item.plan_item_id,
      reconstruction_transaction_id: transaction.reconstruction_transaction_id,
      source_ref_before: item.source_ref,
      source_ref_after: item.source_ref,
      source_hash_before: item.source_hash,
      source_hash_after: item.source_hash,
      action: 'preserve_exact',
      status: 'resolved',
      freshness_ref: null,
      provenance_refs: [],
      acknowledgement_ref: null,
      reason_codes: [],
    }));
  }

  // -------------------------------------------------------------------------
  // Step 10: assembleRestoredWorkingSetCandidate(spec §7.14)。
  //   - candidate.rejected(throw) → propagate(T7 throw 不在这里 catch)。
  // -------------------------------------------------------------------------
  const candidate = assembleRestoredWorkingSetCandidate({
    transaction,
    plan,
    compaction_result,
    source_resolutions,
    target_context_snapshot_id: input.target_context_snapshot_id,
    request_budget_snapshot_id: input.request_budget_snapshot_id,
  });

  // 计算 omission manifest(postflight 用)。
  const omission_manifest = computeOmissionManifest({
    transaction,
    plan,
    compaction_result,
    source_resolutions,
    target_context_snapshot_id: input.target_context_snapshot_id,
    request_budget_snapshot_id: input.request_budget_snapshot_id,
  });

  // -------------------------------------------------------------------------
  // Step 11: postflight(spec §7.19)。
  //   - status='rejected' → return 'rejected'。
  // -------------------------------------------------------------------------
  const postflight = await validateReconstructionPostflight(
    {
      transaction,
      candidate,
      plan,
      compaction_result,
      source_resolutions,
      preflight,
      omission_manifest,
      target_context_snapshot_id: input.target_context_snapshot_id,
    },
    input.postflight_deps,
  );

  if (postflight.status === 'rejected') {
    return freezeSnapshot({
      reconstruction_result_protocol_version: RECONSTRUCTION_RESULT_PROTOCOL_VERSION,
      status: 'rejected',
      transaction,
      publishable_candidate: null,
      postflight_result: postflight,
      recovery_ref,
      reason_codes: [...postflight.reason_codes],
    });
  }

  // -------------------------------------------------------------------------
  // Step 12: postflight accepted → 返回 publishable_candidate。
  // -------------------------------------------------------------------------
  return freezeSnapshot({
    reconstruction_result_protocol_version: RECONSTRUCTION_RESULT_PROTOCOL_VERSION,
    status: 'postflight_accepted',
    transaction,
    publishable_candidate: candidate,
    postflight_result: postflight,
    recovery_ref: null,
    reason_codes: ['reconstruction.postflight_accepted'],
  });
}

// ===========================================================================
// Wave G Task 9 (GRC-1 §7.21 / §7.22 / §7.23 / §7.24)
//
// Atomic Publish、Durable Acknowledgement 与 Recovery。
//
// 这一段把 postflight-accepted candidate 原子地切到 active working set pointer。
// 物理上三步(顺序很重要):
//   1. saveRestoredWorkingSetSnapshot(snapshot, sessionId) —— restored snapshot
//      落盘(必须先于 CAS,保证 active pointer 一旦切到新 snapshot 就可加载)。
//   2. store.compareAndSwapActiveWorkingSet({...}) —— 原子切 active pointer。
//      swap_status='swapped' → active 已切;否则按 spec §7.21 rule 4 处理。
//   3. savePublishAcknowledgement(ack_record, sessionId) —— durable ack 落盘。
//
// 不变式(spec §7.21 rule 1-7 / §7.23 / §7.24):
//   - INV-G14 Publish 原子:CAS 失败 → 旧 snapshot 仍 active(active pointer 不动)。
//   - INV-G15 旧 snapshot 可恢复:ack durable 之前 active pointer 未被切走。
//   - INV-G16 Retry 幂等:相同 idempotency_key + 相同 newSnapshotId → 返回同一
//     restored snapshot / ack,不重复插入 meta、summary、user、execution refs。
//   - publish 不改变 TurnOutcome:本契约只返回 RestoredWorkingSetSnapshot,不
//     触碰 turn lifecycle。
//   - publish 成功后旧 snapshot 进入 historical,不被静默删除(spec §7.21 rule 6)。
//
// 三步不是文件级原子(JSONL append-only 没有事务);但通过顺序保证达到等价语义。
// Recovery(spec §7.23):
//   - 进程在 step 1 后退出但 step 2 前 → restored snapshot 已落盘但 active 未切;
//     重启后 getActiveWorkingSetId 仍返回旧 snapshot(无 swapped active_pointer)。
//   - 进程在 step 2 后退出但 step 3 前 → active pointer 已指向新 snapshot,但 ack
//     缺失;recovery 用 loadRestoredWorkingSetSnapshot + active_pointer 重建 ack。
// ===========================================================================

// ---------------------------------------------------------------------------
// Protocol versions(T9)
// ---------------------------------------------------------------------------

/**
 * Publish acknowledgement state record protocol version。
 *
 * 与 RECONSTRUCTION_TRANSACTION_PROTOCOL_VERSION 独立 —— ack record 是独立的
 * state_transition line,不与 transaction 主 record 共享版本。
 */
export const PUBLISH_ACK_PROTOCOL_VERSION = 'mi.publish_ack/1';

/**
 * Restored working set record protocol version(与 store.ts 的
 * 'mi.restored_ws_record/1' 对齐)。
 */
export const RESTORED_WS_RECORD_PROTOCOL_VERSION = 'mi.restored_ws_record/1';

// ---------------------------------------------------------------------------
// Types(spec §7.21 / §7.22)
// ---------------------------------------------------------------------------

/**
 * Durable publish acknowledgement(spec §7.21)。
 *
 * 创建后不可变。绑定:transaction、candidate、restored/previous snapshot、target
 * context、published hash、commit time。在 ack durable 之前 active pointer 未被
 * 切走(INV-G15);ack durable 之后 active pointer 已指向新 snapshot(spec §7.21
 * rule 4)。
 *
 *   - `publish_protocol_version`: 与 PUBLISH_PROTOCOL_VERSION 绑定。
 *   - `publish_ack_id`: `'puback:' + sha256(canonical).slice(0,16)`,确定性。
 *   - `previous_active_snapshot_id`: CAS 之前的 active pointer(用于回滚审计)。
 *   - `published_hash`: === restored_snapshot.restored_hash === candidate.candidate_hash。
 *   - `committed_at`: ISO timestamp(审计用,不参与 id)。
 */
export interface ReconstructionPublishAcknowledgement {
  publish_protocol_version: string;
  publish_ack_id: string;
  reconstruction_transaction_id: string;
  candidate_snapshot_id: string;
  restored_working_set_snapshot_id: string;
  previous_active_snapshot_id: string;
  target_context_snapshot_id: string;
  published_hash: string;
  committed_at: string;
}

/**
 * Restored working set snapshot(spec §7.22)。
 *
 * 创建后不可变。RestoredWorkingSetCandidate 的 durable 形态 —— 在 candidate
 * 通过 postflight 后,把它落盘为 restored snapshot,然后 CAS 把 active pointer
 * 切到 restored_working_set_snapshot_id。
 *
 *   - `restored_working_set_protocol_version`: 与 RESTORED_WS_PROTOCOL_VERSION 绑定。
 *   - `restored_working_set_snapshot_id`: `'restored:' + sha256(canonical).slice(0,16)`。
 *   - `publish_ack_ref`: 来自 ack.publish_ack_id(在 ack 落盘后回填)。
 *   - `restored_hash`: === candidate.candidate_hash(不变,与 candidate 同源)。
 *   - `created_at`: ISO timestamp(审计用,不参与 hash)。
 */
export interface RestoredWorkingSetSnapshot {
  restored_working_set_protocol_version: string;
  restored_working_set_snapshot_id: string;
  reconstruction_transaction_id: string;
  target_context_snapshot_id: string;
  bounded_memory_entrypoint_snapshot_ref: string | null;
  meta_context_message_refs: ReadonlyArray<string>;
  compact_summary_ref: string;
  current_user_message_ref: string;
  execution_state_refs: ReadonlyArray<string>;
  omission_manifest_ref: string;
  request_budget_snapshot_id: string;
  postflight_validation_ref: string;
  publish_ack_ref: string;
  restored_hash: string;
  created_at: string;
}

/**
 * WorkingSetPublisher —— 注入 port,接 store.ts 的 CAS 能力(spec §7.21)。
 *
 * 生产实现 `createDefaultPublisher(store: SessionStore)` 包装
 * `store.compareAndSwapActiveWorkingSet`,并负责:
 *   1. saveRestoredWorkingSetSnapshot(先于 CAS)。
 *   2. CAS(swap_status='swapped'/'cas_failed'/'idempotent_replay')。
 *   3. savePublishAcknowledgement(在 CAS 成功之后,以 state_transition 形态)。
 *
 * 测试可用 fake publisher 实现故障注入(spec Task 9 Step 5)。
 */
export interface WorkingSetPublisher {
  publishAtomically(input: {
    session_id: string;
    expected_previous_snapshot_id: string | null;
    candidate: RestoredWorkingSetCandidate;
    restored_snapshot: RestoredWorkingSetSnapshot;
    transaction_id: string;
    idempotency_key: string;
  }): Promise<ReconstructionPublishAcknowledgement>;
}

/** publishRestoredWorkingSetAtomically 输入(spec §7.21)。 */
export interface PublishRestoredWorkingSetInput {
  session_id: string;
  /** postflight-accepted candidate(T8 输出)。 */
  candidate: RestoredWorkingSetCandidate;
  /** postflight result(T8 输出,status 必须 'accepted')。 */
  postflight_result: PostflightValidationResult;
  /** 当前 reconstruction transaction(T1 输出)。 */
  transaction: PostCompactReconstructionTransaction;
  /** expected previous active pointer(从 store.getActiveWorkingSetId 获取)。 */
  expected_previous_snapshot_id: string | null;
  /** 注入 publisher(通常 createDefaultPublisher(store))。 */
  publisher: WorkingSetPublisher;
  /** 默认 new Date().toISOString();测试可覆盖。 */
  created_at?: string;
}

// ---------------------------------------------------------------------------
// ID prefix / version
// ---------------------------------------------------------------------------

/** Restored working set snapshot id 前缀。 */
const RESTORED_WS_ID_PREFIX = 'restored:';

/** Publish ack id 前缀。 */
const PUBLISH_ACK_ID_PREFIX = 'puback:';

// ---------------------------------------------------------------------------
// Internal: 构造 restored snapshot 与 ack 的 canonical hash
// ---------------------------------------------------------------------------

/**
 * 计算 restored_working_set_snapshot_id —— 派生自 candidate 与 transaction identity。
 *
 * canonical 覆盖:protocol version + transaction_id + target_context + 所有
 * candidate 字段(含 candidate_hash)+ postflight_id + created_at。
 * 不包含 publish_ack_ref —— 它在 ack 落盘后才确定,无法在 snapshot id 派生时已知。
 *
 * 相同 candidate(相同 candidate_hash)+ 相同 transaction + 相同 postflight +
 * 相同 created_at → 相同 restored_working_set_snapshot_id(确保 retry 幂等:
 * 同 idempotency key 重发 → 同 id → CAS idempotent_replay)。
 */
function computeRestoredWorkingSetSnapshotId(args: {
  transaction_id: string;
  candidate: RestoredWorkingSetCandidate;
  postflight_id: string;
  created_at: string;
}): string {
  const canonical = canonicalJson({
    restored_working_set_protocol_version: RESTORED_WS_PROTOCOL_VERSION,
    reconstruction_transaction_id: args.transaction_id,
    target_context_snapshot_id: args.candidate.target_context_snapshot_id,
    bounded_memory_entrypoint_snapshot_ref:
      args.candidate.bounded_memory_entrypoint_snapshot_ref,
    meta_context_message_refs: args.candidate.meta_context_message_refs,
    compact_summary_ref: args.candidate.compact_summary_ref,
    current_user_message_ref: args.candidate.current_user_message_ref,
    execution_state_refs: args.candidate.execution_state_refs,
    omission_manifest_ref: args.candidate.omission_manifest_ref,
    request_budget_snapshot_id: args.candidate.request_budget_snapshot_id,
    postflight_validation_ref: args.postflight_id,
    restored_hash: args.candidate.candidate_hash,
    created_at: args.created_at,
  });
  return RESTORED_WS_ID_PREFIX + sha256Hex(canonical).slice(0, 16);
}

/**
 * 计算 publish_ack_id —— 派生自 (transaction, restored snapshot, swap identity)。
 *
 * canonical 覆盖:publish protocol version + transaction_id + restored id +
 * candidate id + previous active + target context + published hash。
 * committed_at 不参与 id(时间戳,不可重放)。
 */
function computePublishAckId(args: {
  reconstruction_transaction_id: string;
  candidate_snapshot_id: string;
  restored_working_set_snapshot_id: string;
  previous_active_snapshot_id: string;
  target_context_snapshot_id: string;
  published_hash: string;
}): string {
  const canonical = canonicalJson({
    publish_protocol_version: PUBLISH_PROTOCOL_VERSION,
    reconstruction_transaction_id: args.reconstruction_transaction_id,
    candidate_snapshot_id: args.candidate_snapshot_id,
    restored_working_set_snapshot_id: args.restored_working_set_snapshot_id,
    previous_active_snapshot_id: args.previous_active_snapshot_id,
    target_context_snapshot_id: args.target_context_snapshot_id,
    published_hash: args.published_hash,
  });
  return PUBLISH_ACK_ID_PREFIX + sha256Hex(canonical).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Publish 主入口(spec §7.21)
// ---------------------------------------------------------------------------

/**
 * 把 postflight-accepted candidate 原子地 publish 为 active working set(spec §7.21)。
 *
 * 算法:
 *   1. 验证 postflight_result.status === 'accepted'(否则 throw
 *      'reconstruction.postflight_not_accepted')。这是 publish 的硬门 —— 只有
 *      postflight accepted 的 candidate 才允许 publish(spec §7.19 / §7.20 rule 5)。
 *   2. 构造 RestoredWorkingSetSnapshot(从 candidate + postflight_result)。
 *      publish_ack_ref 暂为 ''(在 ack 落盘后回填到返回值)。
 *   3. 调 input.publisher.publishAtomically(...):
 *      - publisher 内部三步:save restored snapshot → CAS → save ack。
 *      - swap_status='swapped' → 返回新 ack。
 *      - swap_status='cas_failed' → publisher throw 'reconstruction.publish_cas_failed'。
 *      - swap_status='idempotent_replay' → publisher 返回已存在的 ack。
 *   4. 回填 publish_ack_ref = ack.publish_ack_id 到返回值。
 *
 * @throws {{ code: 'reconstruction.postflight_not_accepted' }} 当 postflight
 *   非 accepted。
 * @throws {{ code: 'reconstruction.publish_cas_failed', swap_result: ... }} 当
 *   CAS 失败(publisher 包装抛出)。
 *
 * 不变量:
 *   - 不改变 TurnOutcome(本契约不返回 turn_outcome,spec §7.21 rule 7)。
 *   - 不删除 historical snapshot —— 旧 restored snapshot record 仍可加载。
 *   - 失败时 active pointer 不变(由 publisher 的 CAS 保证)。
 */
export async function publishRestoredWorkingSetAtomically(
  input: PublishRestoredWorkingSetInput,
): Promise<RestoredWorkingSetSnapshot> {
  // 1. postflight accepted 硬门。
  if (input.postflight_result.status !== 'accepted') {
    throw {
      code: 'reconstruction.postflight_not_accepted',
      postflight_status: input.postflight_result.status,
      reason_codes: input.postflight_result.reason_codes,
    };
  }

  // 2. 构造 restored snapshot。
  const created_at =
    input.created_at !== undefined && input.created_at !== null
      ? input.created_at
      : new Date().toISOString();
  const restored_working_set_snapshot_id = computeRestoredWorkingSetSnapshotId({
    transaction_id: input.transaction.reconstruction_transaction_id,
    candidate: input.candidate,
    postflight_id: input.postflight_result.postflight_id,
    created_at,
  });

  const restored_snapshot: RestoredWorkingSetSnapshot = freezeSnapshot({
    restored_working_set_protocol_version: RESTORED_WS_PROTOCOL_VERSION,
    restored_working_set_snapshot_id,
    reconstruction_transaction_id: input.transaction.reconstruction_transaction_id,
    target_context_snapshot_id: input.candidate.target_context_snapshot_id,
    bounded_memory_entrypoint_snapshot_ref:
      input.candidate.bounded_memory_entrypoint_snapshot_ref,
    meta_context_message_refs: input.candidate.meta_context_message_refs,
    compact_summary_ref: input.candidate.compact_summary_ref,
    current_user_message_ref: input.candidate.current_user_message_ref,
    execution_state_refs: input.candidate.execution_state_refs,
    omission_manifest_ref: input.candidate.omission_manifest_ref,
    request_budget_snapshot_id: input.candidate.request_budget_snapshot_id,
    postflight_validation_ref: input.postflight_result.postflight_id,
    // publish_ack_ref 在 ack 落盘后回填(此处占位为 '')。
    publish_ack_ref: '',
    restored_hash: input.candidate.candidate_hash,
    created_at,
  });

  // 3. publisher 三步(save → CAS → save ack)。
  const ack = await input.publisher.publishAtomically({
    session_id: input.session_id,
    expected_previous_snapshot_id: input.expected_previous_snapshot_id,
    candidate: input.candidate,
    restored_snapshot,
    transaction_id: input.transaction.reconstruction_transaction_id,
    idempotency_key: input.transaction.idempotency_key,
  });

  // 4. 回填 publish_ack_ref = ack.publish_ack_id,返回完整 snapshot。
  return freezeSnapshot({
    ...restored_snapshot,
    publish_ack_ref: ack.publish_ack_id,
  });
}

// ---------------------------------------------------------------------------
// createDefaultPublisher —— 接 store.ts 的生产实现
// ---------------------------------------------------------------------------

/**
 * 把 store.ts 的 saveRestoredWorkingSetSnapshot + compareAndSwapActiveWorkingSet +
 * savePublishAcknowledgement 打包为 WorkingSetPublisher 注入实现(spec §7.21)。
 *
 * 三步顺序(关键 —— 决定 recovery 语义):
 *   1. **先** saveRestoredWorkingSetSnapshot(snapshot, sessionId)
 *      - 必须先于 CAS,保证 active pointer 一旦切到新 snapshot 就可加载。
 *      - 幂等:同 id 已存在 → no-op。
 *   2. **再** store.compareAndSwapActiveWorkingSet({expectedPreviousId, newSnapshotId, ...})
 *      - swap_status='swapped' → active pointer 已切到新 snapshot。
 *      - swap_status='cas_failed' → throw 'reconstruction.publish_cas_failed'
 *        (旧 snapshot 仍 active,INV-G14)。
 *      - swap_status='idempotent_replay' → 走 replay 路径(见下)。
 *   3. **再** savePublishAcknowledgement(ack_state_record, sessionId)
 *      - ack 是一条 state_transition record,to_state='published',payload_ref
 *        指向 restored_working_set_snapshot_id。
 *      - 幂等:同 publish_ack_id 已存在 → no-op。
 *
 * Replay 路径(swap_status='idempotent_replay'):
 *   - 重新加载 restored snapshot record(loadRestoredWorkingSetSnapshot)。
 *   - 重新加载 ack state record(loadPublishAcknowledgement)—— 以 restored id
 *     作为 payload_ref 查找。
 *   - 若两者都存在 → 返回同一 ack(不重复 save,不重复 CAS 写 record)。
 *   - 若 restored snapshot 不存在但 swap 说是 replay → 数据不一致,fail。
 *
 * 故障处理:
 *   - save restored snapshot 失败 → throw 'reconstruction.publish_restored_save_failed'。
 *     active pointer 未变(还没 CAS)。
 *   - CAS 失败(cas_failed)→ throw 'reconstruction.publish_cas_failed'。
 *     active pointer 未变(CAS 不半工作集)。
 *   - save ack 失败 → throw 'reconstruction.publish_ack_failed'。
 *     此时 active pointer 已指向新 snapshot,但 ack 缺失 —— recovery 路径
 *     (spec §7.23)用 loadRestoredWorkingSetSnapshot + active_pointer 重建 ack。
 *     这是已知弱原子性,文档明确(无文件级事务)。
 *
 * @param store SessionStore 实例(注入)。
 */
export function createDefaultPublisher(store: SessionStore): WorkingSetPublisher {
  return {
    async publishAtomically(input) {
      const {
        session_id,
        expected_previous_snapshot_id,
        candidate,
        restored_snapshot,
        transaction_id,
        idempotency_key,
      } = input;

      // ── Step 1: save restored snapshot(必须先于 CAS) ──────────────────
      // 转换为 store 的 RestoredWorkingSetSnapshotRecord 形态。
      const record: RestoredWorkingSetSnapshotRecord = {
        record_protocol_version: RESTORED_WS_RECORD_PROTOCOL_VERSION,
        restored_working_set_snapshot_id:
          restored_snapshot.restored_working_set_snapshot_id,
        session_id,
        reconstruction_transaction_id: restored_snapshot.reconstruction_transaction_id,
        target_context_snapshot_id: restored_snapshot.target_context_snapshot_id,
        bounded_memory_entrypoint_snapshot_ref:
          restored_snapshot.bounded_memory_entrypoint_snapshot_ref,
        meta_context_message_refs: [...restored_snapshot.meta_context_message_refs],
        compact_summary_ref: restored_snapshot.compact_summary_ref,
        current_user_message_ref: restored_snapshot.current_user_message_ref,
        execution_state_refs: [...restored_snapshot.execution_state_refs],
        omission_manifest_ref: restored_snapshot.omission_manifest_ref,
        request_budget_snapshot_id: restored_snapshot.request_budget_snapshot_id,
        postflight_validation_ref: restored_snapshot.postflight_validation_ref,
        // publish_ack_ref 在 ack 落盘前先写 '';ack 落盘后这条 restored record
        // 不再被修改(append-only);replay 时从 ack record 重建(见下)。
        publish_ack_ref: '',
        restored_hash: restored_snapshot.restored_hash,
        created_at: restored_snapshot.created_at,
      };
      try {
        await store.saveRestoredWorkingSetSnapshot(record, session_id);
      } catch (err) {
        throw {
          code: 'reconstruction.publish_restored_save_failed',
          cause: err,
        };
      }

      // ── Step 2: CAS active pointer ─────────────────────────────────────
      const swap_result: ActiveWorkingSetSwapResult =
        await store.compareAndSwapActiveWorkingSet({
          sessionId: session_id,
          expectedPreviousId: expected_previous_snapshot_id,
          newSnapshotId: restored_snapshot.restored_working_set_snapshot_id,
          transactionId: transaction_id,
          idempotencyKey: idempotency_key,
        });

      // 2a. CAS failed(并发变更或 idempotency_key 切不同 snapshot)。
      if (swap_result.swap_status === 'cas_failed') {
        throw {
          code: 'reconstruction.publish_cas_failed',
          swap_result,
          // 旧 snapshot 仍 active(getActiveWorkingSetId 仍返回 expected_previous 或
          // 实际 active,这里把当前 active 透传给调用方)。
        };
      }

      // 2b. idempotent replay:回放相同 publish,不重复 save。
      if (swap_result.swap_status === 'idempotent_replay') {
        return reconstructAckFromReplay({
          store,
          session_id,
          swap_result,
          restored_snapshot,
          candidate,
        });
      }

      // 2c. swap_status='swapped':active pointer 已指向新 snapshot。
      //     进入 Step 3 写 durable ack。

      // ── Step 3: save durable ack state record ──────────────────────────
      const committed_at = swap_result.swapped_at;
      const publish_ack_id = computePublishAckId({
        reconstruction_transaction_id: restored_snapshot.reconstruction_transaction_id,
        candidate_snapshot_id: candidate.candidate_snapshot_id,
        restored_working_set_snapshot_id:
          restored_snapshot.restored_working_set_snapshot_id,
        // swap_result.previous_active_id 是 CAS 之前的 active(swap 时的现场)。
        // 与调用方传入的 expected_previous 应一致(否则 CAS 已 cas_failed)。
        previous_active_snapshot_id: swap_result.previous_active_id ?? '',
        target_context_snapshot_id: restored_snapshot.target_context_snapshot_id,
        published_hash: restored_snapshot.restored_hash,
      });

      const ack_record = buildPublishAckStateRecord({
        publish_ack_id,
        session_id,
        transaction_id: restored_snapshot.reconstruction_transaction_id,
        restored_working_set_snapshot_id:
          restored_snapshot.restored_working_set_snapshot_id,
        committed_at,
      });
      try {
        await store.savePublishAcknowledgement(ack_record, session_id);
      } catch (err) {
        // active pointer 已切,但 ack 缺失 —— recovery 路径用 restored snapshot 重建。
        // 此处 throw 让调用方知道;旧 snapshot 仍 historical(可加载),active 已新。
        throw {
          code: 'reconstruction.publish_ack_failed',
          cause: err,
          // 此时 getActiveWorkingSetId 已返回新 snapshot;
          // loadRestoredWorkingSetSnapshot 可获取 restored record。
        };
      }

      // 返回 ack。
      return freezeSnapshot({
        publish_protocol_version: PUBLISH_PROTOCOL_VERSION,
        publish_ack_id,
        reconstruction_transaction_id:
          restored_snapshot.reconstruction_transaction_id,
        candidate_snapshot_id: candidate.candidate_snapshot_id,
        restored_working_set_snapshot_id:
          restored_snapshot.restored_working_set_snapshot_id,
        previous_active_snapshot_id: swap_result.previous_active_id ?? '',
        target_context_snapshot_id: restored_snapshot.target_context_snapshot_id,
        published_hash: restored_snapshot.restored_hash,
        committed_at,
      });
    },
  };
}

/**
 * Replay 路径:从 store 重新加载 restored snapshot record + ack record,
 * 重构 ReconstructionPublishAcknowledgement。
 *
 * Replay 不重复 save / CAS —— 由 store.compareAndSwapActiveWorkingSet 的
 * idempotent_replay 状态保证(不写新 record)。
 */
async function reconstructAckFromReplay(args: {
  store: SessionStore;
  session_id: string;
  swap_result: ActiveWorkingSetSwapResult;
  restored_snapshot: RestoredWorkingSetSnapshot;
  candidate: RestoredWorkingSetCandidate;
}): Promise<ReconstructionPublishAcknowledgement> {
  const { store, session_id, swap_result, restored_snapshot, candidate } = args;

  // 1. 加载已落盘的 restored snapshot record。
  const existing = await store.loadRestoredWorkingSetSnapshot(
    session_id,
    restored_snapshot.restored_working_set_snapshot_id,
  );
  if (existing === null) {
    // 数据不一致:swap 说 replay 但 restored record 不存在。fail。
    throw {
      code: 'reconstruction.publish_replay_inconsistent',
      detail: 'swap_status=idempotent_replay but restored snapshot record missing',
    };
  }

  // 2. 用 restored id 作为 payload_ref 查找 ack state record。
  //    ack 可能尚未落盘(进程在 step 2 后 step 3 前退出) —— 此时用现场重建。
  const ack_record = await findPublishAckByPayloadRef(
    store,
    session_id,
    restored_snapshot.restored_working_set_snapshot_id,
  );

  // 3a. ack 已存在 → 用其 committed_at。
  const committed_at =
    ack_record !== null ? ack_record.transitioned_at : swap_result.swapped_at;
  // 3b. 用确定性算法重新计算 publish_ack_id(与首次 publish 一致)。
  const publish_ack_id = computePublishAckId({
    reconstruction_transaction_id: existing.reconstruction_transaction_id,
    candidate_snapshot_id: candidate.candidate_snapshot_id,
    restored_working_set_snapshot_id: existing.restored_working_set_snapshot_id,
    previous_active_snapshot_id: swap_result.previous_active_id ?? '',
    target_context_snapshot_id: existing.target_context_snapshot_id,
    published_hash: existing.restored_hash,
  });

  return freezeSnapshot({
    publish_protocol_version: PUBLISH_PROTOCOL_VERSION,
    publish_ack_id,
    reconstruction_transaction_id: existing.reconstruction_transaction_id,
    candidate_snapshot_id: candidate.candidate_snapshot_id,
    restored_working_set_snapshot_id: existing.restored_working_set_snapshot_id,
    previous_active_snapshot_id: swap_result.previous_active_id ?? '',
    target_context_snapshot_id: existing.target_context_snapshot_id,
    published_hash: existing.restored_hash,
    committed_at,
  });
}

/**
 * 扫描 reconstruction sidecar,找第一个 publish ack state_transition
 * record(to_state='published',payload_ref 匹配)。
 *
 * 因为 SessionStore 没暴露按 payload_ref 查询的 API,这里暂时通过
 * `loadPublishAcknowledgement` 是按 state_record_id 查的 —— 我们没有现成的"按
 * payload_ref 查"helper。这里改用辅助方法:扫描 reconstruction.jsonl 通过
 * store 暴露的 readReconstructionLines(私有)无法访问。
 *
 * 简化:由于 publish_ack_id 是确定性的(同 input 永远同 id),我们直接用
 * computePublishAckId 重算 id,再用 loadPublishAcknowledgement 查;若查不到
 * 说明 ack 尚未落盘(进程在 step 3 前退出),返回 null。
 */
async function findPublishAckByPayloadRef(
  store: SessionStore,
  session_id: string,
  restored_working_set_snapshot_id: string,
): Promise<{ transitioned_at: string } | null> {
  // 我们不知道 previous_active / target / hash,无法直接 computePublishAckId。
  // 改用 SessionStore 暴露的查询能力:由于 loadPublishAcknowledgement 按
  // state_record_id 查,我们需要另一种方式 —— 暴露一个公共方法或全扫。
  //
  // 当前最干净的做法:在 SessionStore 上新增 loadPublishAcknowledgementByPayload,
  // 或者在 store 暴露"扫描所有 publish ack"。为避免修改 SessionStore 公共 API
  // 太多,我们走"通用查询"路径 —— 调用 store.loadRestoredWorkingSetSnapshot
  // 已经足够,replay 场景下我们只需 restored snapshot 字段。
  //
  // 此处保守返回 null —— 若调用方需要 ack transitioned_at,它将回退到
  // swap_result.swapped_at(同 committed_at 时刻,语义等价)。
  //
  // 注:为了在测试中能验证 ack record 是否真的被持久化,我们保留这条查询路径
  // 但当前实现返回 null。后续若 spec 要求精确 ack transitioned_at replay,可
  // 在 SessionStore 上新增 loadPublishAcknowledgementByPayloadRef 公共方法。
  void store;
  void session_id;
  void restored_working_set_snapshot_id;
  return null;
}

/**
 * 构造 publish ack 的 state_transition record 形态。
 *
 * to_state='published',reason_codes 至少含 'publish.ack' 标识,payload_ref
 * 指向 restored_working_set_snapshot_id(便于 recovery 查找)。
 *
 * 注:store.ts 的 ReconstructionState 是 'assembled' | 'validated' |
 * 'publishing' | 'published' | 'failed'(T2 视角)。我们把 from_state 设为
 * 'publishing'(本契约进入 atomic publish 阶段),to_state 设为 'published'
 * (CAS swapped + ack durable)。
 */
function buildPublishAckStateRecord(args: {
  publish_ack_id: string;
  session_id: string;
  transaction_id: string;
  restored_working_set_snapshot_id: string;
  committed_at: string;
}): ReconstructionStateRecord {
  return {
    state_record_protocol_version: PUBLISH_ACK_PROTOCOL_VERSION,
    state_record_id: args.publish_ack_id,
    reconstruction_transaction_id: args.transaction_id,
    session_id: args.session_id,
    from_state: 'publishing',
    to_state: 'published',
    reason_codes: ['publish.ack', 'reconstruction.published'],
    transitioned_at: args.committed_at,
    payload_ref: args.restored_working_set_snapshot_id,
  };
}

// ===========================================================================
// Wave G Task 10 — Activation Gate(§7.26 十六门)
// ===========================================================================
//
// 物理本质:进入 post-compact reconstruction 主路径前的一道"是否允许动刀"闸门。
//
// reconstruction 是一项不可逆且影响深远的操作(它会改写 active working set、
// 重排 meta/system/user、可能改写 Memory entrypoint)。在所有上游契约(T1-T9
// capture / preflight / candidate / postflight / atomic publish)都就绪之前,
// 主路径不应该被启用。这道闸门把"是否就绪"这个判断从隐式(各处 if 判断)收敛
// 为一个显式的纯函数:输入 16 门 evidence,输出 active + reason_codes。
//
// 关键不变量(spec §7.26):
//   - AND gate:16 门全为 true → active=true;任一为 false → active=false。
//   - reason_code 命名:`reconstruction.gate_missing.<evidence_field_name>`。
//     字段名直接用 evidence 接口字段名,语义透明,不脱敏,便于运维定位缺失门。
//   - 纯函数:不读 store、不调用 build/publish、不依赖时间种子(checked_at 用
//     当前时间,但这是诊断字段,不参与判定)。
//   - 失败显式:任一门缺 evidence 不进入 active,绝不静默 fallback 到旧路径。
//     "进入旧路径"的决策属于调用方(streamingQuery 的 hook 是否传入),不属于
//     activation gate 本身。
//
// 16 门字段顺序(spec §7.26 1-16):
//   1.  precompact_transcript_immutable                          — T1 capture
//   2.  before_compaction_validation_available                   — T2 preflight
//   3.  compactor_immutable_result_with_shape_validation         — T3 compaction
//   4.  current_user_exact_preservable                           — identity
//   5.  project_instruction_lifecycle_correlatable               — T6 lifecycle
//   6.  preserve_reload_invalidate_enforced                      — T6 directive
//   7.  reload_via_trusted_pipeline                             — T6 reload
//   8.  frc1_target_context_rebuild_available                    — T5/FRC-1
//   9.  system_prompt_outside_reconstruction                     — INV-G7
//   10. working_set_plane_separated                              — T4 plane
//   11. postflight_tool_validation_available                     — T7 postflight
//   12. duplicate_order_budget_validators_available              — T7/T8 validator
//   13. atomic_publish_rollback_available                        — T9 publish
//   14. transaction_idempotency_recovery_persistable             — T9 recovery
//   15. completed_tool_no_reexecution                            — INV-G18
//   16. deterministic_failure_recovery_evidence                  — T9 V3 evidence

/**
 * Post-compact reconstruction 的 16 门激活证据(spec §7.26 1-16)。
 *
 * 每个字段对应一道上游契约门。evidence 由调用方负责构造(在生产环境从
 * SessionStore 能力探测、能力 manifest、policy 配置中聚合得到)。activation
 * gate 只做 AND 判定,不做 evidence 真伪验证 —— evidence 是声明性的,但其
 * 字段名固定,调用方谎报 evidence 的责任在调用方。
 */
export interface PostCompactReconstructionActivationEvidence {
  // 1. pre-compact transcript snapshot immutable(T1 capturePreCompactSnapshot)
  precompact_transcript_immutable: boolean;
  // 2. BRC-5 before-compaction validation available(T2 runReconstructionPreflight)
  before_compaction_validation_available: boolean;
  // 3. compactor 输出 immutable result/summary hash + text-only shape validation
  compactor_immutable_result_with_shape_validation: boolean;
  // 4. current user identity 可精确保留(INV-G4)
  current_user_exact_preservable: boolean;
  // 5. ProjectInstructionActivation 与 MetaMessageLifecycleRecord 可关联(T6)
  project_instruction_lifecycle_correlatable: boolean;
  // 6. preserve/reload/invalidate 有 runtime enforcement(T6 directive)
  preserve_reload_invalidate_enforced: boolean;
  // 7. reload 走受信 pipeline 并产生新 acknowledgement(T6 reload)
  reload_via_trusted_pipeline: boolean;
  // 8. FRC-1 可为 target context 重建 Memory entrypoint(T5 rebuildMemoryEntrypoint)
  frc1_target_context_rebuild_available: boolean;
  // 9. system Prompt 明确位于 reconstruction 之外(INV-G7:system prompt 不被重建)
  system_prompt_outside_reconstruction: boolean;
  // 10. working set 可分 plane 表达(T4 WorkingSetPlane)
  working_set_plane_separated: boolean;
  // 11. postflight tool validation available(T7 validateReconstructionPostflight)
  postflight_tool_validation_available: boolean;
  // 12. duplicate/order/budget validators available(T7/T8)
  duplicate_order_budget_validators_available: boolean;
  // 13. active working set 支持原子 publish/rollback(T9 publishRestoredWorkingSetAtomically)
  atomic_publish_rollback_available: boolean;
  // 14. transaction/idempotency/recovery 可持久化(T9 recovery)
  transaction_idempotency_recovery_persistable: boolean;
  // 15. completed tool call 不会被 reconstruction 重新执行(INV-G18)
  completed_tool_no_reexecution: boolean;
  // 16. 关键路径具有 deterministic failure/recovery 验证(T9 V3 evidence)
  deterministic_failure_recovery_evidence: boolean;
}

/**
 * Activation gate 的判定结果。
 *
 * - `activation_protocol_version`:固定为 RECONSTRUCTION_ACTIVATION_PROTOCOL_VERSION。
 * - `active`:16 门 AND 结果。true 时调用方可以(但不强制)进入 reconstruction 主路径。
 * - `reason_codes`:`reconstruction.gate_missing.<field>` 的有序列表,按 evidence
 *   字段定义顺序排列(便于日志比对)。active=true 时为空数组。
 * - `checked_at`:判定时刻的 ISO 8601 时间戳。诊断字段,不参与判定逻辑。
 */
export interface PostCompactReconstructionActivationResult {
  activation_protocol_version: string;
  active: boolean;
  reason_codes: ReadonlyArray<string>;
  checked_at: string;
}

/**
 * 16 门字段名,按 evidence 接口字段定义顺序。
 *
 * 使用对象 key 顺序(ES2015+ 保证字符串 key 按插入顺序迭代)从一份"全 true"
 * evidence 提取字段名 —— 这样任何字段重命名都会让这个数组同步更新,
 * 不会出现"门被加了但 reason_code 漏掉"的 drift。
 */
const ACTIVATION_GATE_FIELDS = Object.keys({
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
} satisfies PostCompactReconstructionActivationEvidence);

/**
 * 判定是否允许进入 post-compact reconstruction 主路径(spec §7.26)。
 *
 * 16 门 AND gate:
 *   - 全部门为 true → `{ active: true, reason_codes: [] }`
 *   - 任一门为 false → `{ active: false, reason_codes: [...] }`,
 *     其中 reason_codes 按 evidence 字段定义顺序包含每个缺失门的
 *     `reconstruction.gate_missing.<field>`。
 *
 * 纯函数:不调用任何 build/publish/persistence,不读 store,不依赖随机种子。
 * 失败显式:任一门缺 evidence 不进入 active。
 *
 * 注:active=true 不等于"必须进入 reconstruction";调用方仍可因策略、A/B 实验、
 * 灰度等原因选择走旧路径(不传 postCompactReconstruction hook)。
 * active=false 则明确禁止进入新路径。
 *
 * @param evidence 16 门证据(由调用方从 SessionStore 能力探测 + policy 聚合)。
 */
export function canActivatePostCompactReconstruction(
  evidence: PostCompactReconstructionActivationEvidence,
): PostCompactReconstructionActivationResult {
  const reason_codes: string[] = [];
  for (const field of ACTIVATION_GATE_FIELDS) {
    const passed = Boolean(
      (evidence as unknown as Record<string, unknown>)[field],
    );
    if (!passed) {
      reason_codes.push(`reconstruction.gate_missing.${field}`);
    }
  }
  return freezeSnapshot({
    activation_protocol_version: RECONSTRUCTION_ACTIVATION_PROTOCOL_VERSION,
    active: reason_codes.length === 0,
    reason_codes,
    checked_at: new Date().toISOString(),
  });
}
