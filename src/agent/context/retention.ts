/**
 * ERC-1 §7 — Meta Context Retention (M-038).
 *
 * This module is the Wave E retention surface that sits AFTER DRC-2
 * `MetaContextActivation` and BEFORE Wave G M-049 reconstruction. It turns a
 * frozen `MetaContextActivation` plus its current source-freshness observation
 * into a closed-form `MetaRetentionDecision`, and projects that decision into
 * the initial `MetaMessageLifecycleRecord` for downstream serializer,
 * compressor, and (deferred) M-049 consumers.
 *
 * Non-negotiable invariants (spec ERC-1 §7 / INV-E2 / INV-E3 / INV-E5):
 *   - Retention NEVER changes Authority/Trust (INV-E3). It only decides
 *     lifecycle. Authority and Trust are copied verbatim from the activation.
 *   - `reload_required` only registers a marker — it does NOT read the source,
 *     inject messages, or claim M-049 reconstruction is done (INV-E5).
 *   - Meta lifecycle is bound to session/message/activation/retention identity.
 *     Old records are immutable; new observations mint new records.
 *   - Unknown freshness must defer (`mark_reload_required`) — it must NOT
 *     optimistically preserve stale content.
 *   - Content hash drift forces `invalidate`; the source the activation
 *     captured is no longer the source on disk (spec §7.8).
 *
 * What this module does NOT do:
 *   - M-049 post-compact reconstruction (only outputs a marker/identity).
 *   - Source reads, message injection, or compressor/serializer invocation.
 *   - Wave F direct edges — M-038 is consumed only by Wave G M-049.
 */

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';
import type { MetaContextActivation } from './activation.js';

// ---------------------------------------------------------------------------
// Shared primitives.
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization. Object keys are emitted in ascending
 * (lexicographic) order regardless of insertion order. This canonical form
 * feeds every sha256 in this module. Mirrors `activation.ts` so identity
 * digests are computed identically across the meta pipeline.
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
// ERC-1 §7.2 — Retention policy.
// ===========================================================================

/**
 * Trusted retention policy. Must come from trusted runtime/configuration —
 * source content, Prompt, or Agent cannot declare permanent retention
 * (spec ERC-1 §7.2).
 *
 * `fresh_threshold_ms` is the upper bound on how recent a `fresh` observation
 * may be before it should be re-evaluated as `stale_refreshable`. The actual
 * freshness classification is supplied by the caller via
 * `MetaRetentionInput.source_freshness_state`; this module does not compute
 * freshness from timestamps.
 */
export interface MetaRetentionPolicy {
  policy_id: string;
  policy_version: string;
  /** Fresh threshold in milliseconds. Exceeding it yields stale_refreshable. */
  fresh_threshold_ms: number;
}

// ===========================================================================
// ERC-1 §7.3 — Retention decision.
// ===========================================================================

/** Closed set of retention actions (spec ERC-1 §7.2 / §7.3). */
export type MetaRetentionAction =
  | 'preserve'
  | 'mark_reload_required'
  | 'invalidate';

/**
 * Freshness classification of the activation's source, supplied by the caller.
 * Retention does not derive freshness from timestamps; it consumes an already-
 * classified observation so that freshness policy stays in its own module.
 */
export type SourceFreshnessState =
  | 'fresh'
  | 'stale_refreshable'
  | 'invalidated_source'
  | 'unknown';

/** Input to `decideMetaRetention`. */
export interface MetaRetentionInput {
  retention_protocol_version: string;
  /** DRC-2 activation product; authority/trust are copied verbatim. */
  meta_activation: MetaContextActivation;
  session_snapshot_id: string;
  source_freshness_state: SourceFreshnessState;
  /** Current source content hash (used to detect drift). */
  source_content_hash: string;
  /** Hash recorded on the activation when it was captured. */
  activation_content_hash: string;
  /** ISO-8601 timestamp at which the decision is being made. */
  current_time: string;
}

/**
 * Frozen retention decision (spec ERC-1 §7.3).
 *
 * `authority`, `trust`, and `message_id` are copied verbatim from the
 * activation; retention does not promote, demote, or invent them (INV-E3).
 * `message_id` is carried so the lifecycle record can bind session/message/
 * activation/retention identity without reaching back into the activation
 * (spec ERC-1 §7.4).
 */
export interface MetaRetentionDecision {
  retention_protocol_version: string;
  retention_decision_id: string;
  activation_id: string;
  /** Verbatim from the activation; binds the meta message identity. */
  message_id: string;
  session_snapshot_id: string;
  action: MetaRetentionAction;
  /** Verbatim from the activation; retention never rewrites it. */
  authority: string;
  /** Verbatim from the activation; retention never rewrites it. */
  trust: string;
  reason_codes: string[];
}

// ===========================================================================
// ERC-1 §7.4 — Lifecycle record.
// ===========================================================================

/** Closed set of meta lifecycle states (spec ERC-1 §7.4). */
export type MetaLifecycleState =
  | 'resident'
  | 'serialized'
  | 'reload_required'
  | 'invalidated';

/**
 * Optional identity refs that the lifecycle record binds when a serializer or
 * compressor has produced its own snapshot. They are `null` on the initial
 * transition and supplied by the serializer/compressor when they run.
 */
export interface MetaLifecycleRecordOptions {
  serializer_identity_ref?: string | null;
  compressor_identity_ref?: string | null;
  /** Previous state, if this is a transition from an existing record. */
  previous_state?: MetaLifecycleState | null;
  /** ISO-8601 timestamp at which the transition occurred. */
  transitioned_at: string;
}

/**
 * Frozen lifecycle record (spec ERC-1 §7.4).
 *
 * Binds session/message/activation/retention identity plus optional
 * serializer/compressor identity refs. Old records are immutable; new
 * transitions mint new records.
 */
export interface MetaMessageLifecycleRecord {
  lifecycle_protocol_version: string;
  lifecycle_record_id: string;
  session_snapshot_id: string;
  message_id: string;
  activation_id: string;
  retention_decision_id: string;
  serializer_identity_ref: string | null;
  compressor_identity_ref: string | null;
  state: MetaLifecycleState;
  previous_state: MetaLifecycleState | null;
  transitioned_at: string;
}

// ===========================================================================
// Protocol versions.
// ===========================================================================

/** Protocol version stamped on every retention decision. */
export const META_RETENTION_PROTOCOL_VERSION = 'mi.meta.retention/1';

/** Protocol version stamped on every lifecycle record. */
export const META_LIFECYCLE_PROTOCOL_VERSION = 'mi.meta.lifecycle/1';

// ===========================================================================
// decideMetaRetention — algorithm (spec ERC-1 §7.3 / §7.8).
// ===========================================================================

/**
 * Decide the retention action for a meta activation.
 *
 * Algorithm (spec ERC-1 §7.3 / §7.8):
 *   1. Identity gates:
 *        a. retention_protocol_version, session_snapshot_id, and
 *           meta_activation.activation_id must all be non-empty — otherwise
 *           throw `retention.missing_identity`.
 *   2. Policy gate: policy_id and policy_version must both be non-empty —
 *      otherwise throw `retention.invalid_policy`.
 *   3. Content hash drift: if source_content_hash !== activation_content_hash,
 *      action='invalidate' with reason 'retention.content_hash_mismatch'.
 *      (Hash drift wins over freshness — spec §7.8.)
 *   4. Otherwise map source_freshness_state (does NOT change authority/trust):
 *        - 'fresh'               → 'preserve'
 *        - 'stale_refreshable'   → 'mark_reload_required'
 *        - 'invalidated_source'  → 'invalidate'
 *        - 'unknown'             → 'mark_reload_required' (conservative;
 *          never optimistically preserve when freshness is unverified).
 *   5. Copy authority/trust verbatim from the activation.
 *   6. Mint deterministic `retention_decision_id = ret:<sha256(canonical).slice(0,16)>`.
 *   7. Freeze the result.
 *
 * @throws {Error} `retention.missing_identity` when any identity field is empty.
 * @throws {Error} `retention.invalid_policy` when policy_id/policy_version empty.
 */
export function decideMetaRetention(
  input: MetaRetentionInput,
  policy: MetaRetentionPolicy,
): MetaRetentionDecision {
  // 1. Identity gates. These run first because everything downstream binds to
  //    these identities; an empty identity means the decision cannot be linked.
  requireIdentity(input.retention_protocol_version, 'retention.retention_protocol_version');
  requireIdentity(input.session_snapshot_id, 'retention.session_snapshot_id');
  requireIdentity(
    input.meta_activation.activation_id,
    'retention.meta_activation.activation_id',
  );

  // 2. Policy gate. Policy must come from trusted runtime/config; an empty
  //    policy identity means we cannot prove retention came from a trusted
  //    source. Throw rather than silently treat as invalid action, because
  //    "invalid policy" is a configuration error, not a meta-lifecycle event.
  if (!policy.policy_id || !policy.policy_version) {
    throw new Error('retention.invalid_policy: policy_id and policy_version required');
  }

  // 3. Content hash drift. Wins over freshness — even a 'fresh' source whose
  //    on-disk content no longer matches what the activation captured must be
  //    invalidated, because the activation is now pointing at content that
  //    does not exist anymore.
  const hashDrift = input.source_content_hash !== input.activation_content_hash;

  let action: MetaRetentionAction;
  let reasonCodes: string[];
  if (hashDrift) {
    action = 'invalidate';
    reasonCodes = ['retention.content_hash_mismatch'];
  } else {
    // 4. Source state mapping. Unknown defers to reload rather than preserve,
    //    because we cannot prove staleness is fine (spec §7.8).
    switch (input.source_freshness_state) {
      case 'fresh':
        action = 'preserve';
        reasonCodes = ['retention.fresh_preserved'];
        break;
      case 'stale_refreshable':
        action = 'mark_reload_required';
        reasonCodes = ['retention.stale_reload_required'];
        break;
      case 'invalidated_source':
        action = 'invalidate';
        reasonCodes = ['retention.source_invalidated'];
        break;
      case 'unknown':
        action = 'mark_reload_required';
        reasonCodes = ['retention.freshness_unknown'];
        break;
    }
  }

  // Sanity: the switch above is exhaustive over SourceFreshnessState. If a
  // future edit adds a variant without a case, TS narrows action to never here
  // and the assignment below would fail to type-check. The runtime guard is
  // belt-and-suspenders for untyped callers.
  if (action === undefined) {
    throw new Error(
      `retention.unknown_freshness: ${input.source_freshness_state}`,
    );
  }

  const activation = input.meta_activation;

  // 6. Deterministic retention_decision_id. Canonical input covers protocol
  //    version, identities, action, authority/trust (verbatim from activation),
  //    reason codes, and the freshness/hash inputs — so identical observations
  //    collide and differing ones diverge.
  const canonical = canonicalJson({
    retention_protocol_version: input.retention_protocol_version,
    activation_id: activation.activation_id,
    message_id: activation.message_id,
    session_snapshot_id: input.session_snapshot_id,
    action,
    authority: activation.authority,
    trust: activation.trust,
    source_freshness_state: input.source_freshness_state,
    source_content_hash: input.source_content_hash,
    activation_content_hash: input.activation_content_hash,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    reason_codes: reasonCodes,
  });
  const retentionDecisionId = `ret:${sha256Hex(canonical).slice(0, 16)}`;

  // 5 + 7. Build & freeze. authority/trust/message_id copied verbatim — never
  //        promoted.
  const result: MetaRetentionDecision = {
    retention_protocol_version: input.retention_protocol_version,
    retention_decision_id: retentionDecisionId,
    activation_id: activation.activation_id,
    message_id: activation.message_id,
    session_snapshot_id: input.session_snapshot_id,
    action,
    authority: activation.authority,
    trust: activation.trust,
    reason_codes: reasonCodes,
  };

  return freezeSnapshot(result) as MetaRetentionDecision;
}

// ===========================================================================
// createMetaLifecycleRecord — algorithm (spec ERC-1 §7.4).
// ===========================================================================

/** Map a retention action to its initial lifecycle state. */
function initialStateForAction(action: MetaRetentionAction): MetaLifecycleState {
  switch (action) {
    case 'preserve':
      return 'resident';
    case 'mark_reload_required':
      return 'reload_required';
    case 'invalidate':
      return 'invalidated';
  }
}

/**
 * Project a retention decision into a `MetaMessageLifecycleRecord`.
 *
 * Algorithm (spec ERC-1 §7.4):
 *   1. Initial state is derived from the decision's action:
 *        - preserve             → 'resident'
 *        - mark_reload_required → 'reload_required'
 *        - invalidate           → 'invalidated'
 *      (The 'serialized' state is reached only after the serializer runs and
 *      is supplied via `previous_state` on subsequent transitions; this
 *      function mints the initial transition.)
 *   2. previous_state is taken verbatim from options; defaults to null on the
 *      first transition.
 *   3. serializer_identity_ref / compressor_identity_ref are bound when
 *      available; null on the initial transition.
 *   4. Bind session/message/activation/retention identity from the decision.
 *   5. Mint deterministic `lifecycle_record_id = life:<sha256(canonical).slice(0,16)>`.
 *   6. Freeze the result.
 *
 * Note: this function does NOT read the source, inject messages, or call
 * M-049. `reload_required` only registers a marker for the deferred consumer.
 */
export function createMetaLifecycleRecord(
  decision: MetaRetentionDecision,
  options: MetaLifecycleRecordOptions,
): MetaMessageLifecycleRecord {
  const state = initialStateForAction(decision.action);
  const previousState = options.previous_state ?? null;
  const serializerIdentityRef = options.serializer_identity_ref ?? null;
  const compressorIdentityRef = options.compressor_identity_ref ?? null;

  // 5. Deterministic lifecycle_record_id. Covers every load-bearing identity
  //    so the record is uniquely keyed by what it binds. Two records that
  //    differ in any identity, state, previous_state, or transitioned_at
  //    produce different ids.
  const canonical = canonicalJson({
    lifecycle_protocol_version: META_LIFECYCLE_PROTOCOL_VERSION,
    retention_decision_id: decision.retention_decision_id,
    session_snapshot_id: decision.session_snapshot_id,
    activation_id: decision.activation_id,
    state,
    previous_state: previousState,
    serializer_identity_ref: serializerIdentityRef,
    compressor_identity_ref: compressorIdentityRef,
    transitioned_at: options.transitioned_at,
  });
  const lifecycleRecordId = `life:${sha256Hex(canonical).slice(0, 16)}`;

  const result: MetaMessageLifecycleRecord = {
    lifecycle_protocol_version: META_LIFECYCLE_PROTOCOL_VERSION,
    lifecycle_record_id: lifecycleRecordId,
    session_snapshot_id: decision.session_snapshot_id,
    // message_id is sourced verbatim from the activation through the decision
    // (spec ERC-1 §7.4 — lifecycle record binds the meta message identity).
    message_id: decision.message_id,
    activation_id: decision.activation_id,
    retention_decision_id: decision.retention_decision_id,
    serializer_identity_ref: serializerIdentityRef,
    compressor_identity_ref: compressorIdentityRef,
    state,
    previous_state: previousState,
    transitioned_at: options.transitioned_at,
  };

  return freezeSnapshot(result) as MetaMessageLifecycleRecord;
}

// ===========================================================================
// ERC-1 §7.5 — Session serializer round-trip.
// ===========================================================================
//
// `serializeMetaLifecycleRecord` / `deserializeMetaLifecycleRecord` are the
// canonical round-trip gate between a frozen `MetaMessageLifecycleRecord` and
// its on-disk form. The envelope carries:
//   - `serializer_protocol_version` — the envelope protocol (fail closed when
//     unknown, spec ERC-1 §7.5 rule 4 / §7.8).
//   - `serialized_at` / `serializer_identity` — provenance for the envelope;
//     NOT part of the canonical record, so re-signing is stable across time.
//   - `content_hash` — sha256 over the canonical record. Any drift (tampered
//     field, swapped identity, mutated ordinal) is caught here.
//
// Non-negotiable:
//   - unknown protocol version → throw (never silently degrade to user msg).
//   - hash mismatch on any load-bearing field → throw.
//   - record body itself must still carry the lifecycle protocol stamp.

/** Protocol version stamped on every serialized envelope. */
export const META_SERIALIZER_PROTOCOL_VERSION = 'mi.meta.serializer/1';

/**
 * Serialized envelope wrapping a `MetaMessageLifecycleRecord`.
 *
 * `serialized_at` and `serializer_identity` describe the envelope, not the
 * record — they are excluded from `content_hash` so the same record always
 * signs identically regardless of when/who serialized it.
 */
export interface SerializedMetaLifecycleRecord {
  serializer_protocol_version: string;
  serialized_at: string;
  serializer_identity: string;
  content_hash: string;
  record: MetaMessageLifecycleRecord;
}

/**
 * Canonical record body used for signing. Identical to
 * `MetaMessageLifecycleRecord` but explicitly enumerated so the signed fields
 * are auditable independent of the public interface.
 */
function canonicalRecordBody(record: MetaMessageLifecycleRecord): string {
  return canonicalJson({
    lifecycle_protocol_version: record.lifecycle_protocol_version,
    lifecycle_record_id: record.lifecycle_record_id,
    session_snapshot_id: record.session_snapshot_id,
    message_id: record.message_id,
    activation_id: record.activation_id,
    retention_decision_id: record.retention_decision_id,
    serializer_identity_ref: record.serializer_identity_ref,
    compressor_identity_ref: record.compressor_identity_ref,
    state: record.state,
    previous_state: record.previous_state,
    transitioned_at: record.transitioned_at,
  });
}

/**
 * Serialize a `MetaMessageLifecycleRecord` into a stable JSON envelope.
 *
 * The envelope is deterministic in its signed portion: identical records
 * produce identical `content_hash` and identical `record` body. `serialized_at`
 * and `serializer_identity` are caller-supplied envelope metadata and are NOT
 * part of the hash, so the same record serializes byte-identically across
 * repeat calls (spec ERC-1 §7.5 rule 3).
 *
 * @param record the frozen lifecycle record to serialize.
 * @param options optional envelope metadata (provenance only, not signed).
 */
export function serializeMetaLifecycleRecord(
  record: MetaMessageLifecycleRecord,
  options: { serialized_at?: string; serializer_identity?: string } = {},
): string {
  const contentHash = sha256Hex(canonicalRecordBody(record));
  const envelope: SerializedMetaLifecycleRecord = {
    serializer_protocol_version: META_SERIALIZER_PROTOCOL_VERSION,
    serialized_at: options.serialized_at ?? '',
    serializer_identity: options.serializer_identity ?? '',
    content_hash: contentHash,
    record,
  };
  return JSON.stringify(envelope);
}

/**
 * Deserialize a `SerializedMetaLifecycleRecord` envelope back into a
 * `MetaMessageLifecycleRecord`.
 *
 * Fail-closed checks (spec ERC-1 §7.5 rule 4 / §7.8):
 *   1. Envelope must be a non-null object carrying `serializer_protocol_version`,
 *      `content_hash`, and a non-null `record` body. Anything else → throw
 *      `serializer.malformed_envelope`.
 *   2. `serializer_protocol_version` must equal the current protocol — unknown
 *      versions do NOT silently degrade to a user message → throw
 *      `serializer.unknown_protocol_version`.
 *   3. `record.lifecycle_protocol_version` must equal the current lifecycle
 *      protocol — an unknown inner protocol cannot be trusted → throw
 *      `serializer.unknown_lifecycle_version`.
 *   4. Recompute `sha256(canonicalRecordBody(record))` and require equality
 *      with `envelope.content_hash` — any tampered identity/ordinal/state →
 *      throw `serializer.content_hash_mismatch`.
 *
 * On success, returns a frozen `MetaMessageLifecycleRecord`.
 */
export function deserializeMetaLifecycleRecord(serialized: string): MetaMessageLifecycleRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('serializer.malformed_envelope: not valid JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('serializer.malformed_envelope: envelope must be an object');
  }
  const envelope = parsed as Partial<SerializedMetaLifecycleRecord> & Record<string, unknown>;

  if (
    typeof envelope.serializer_protocol_version !== 'string' ||
    typeof envelope.content_hash !== 'string' ||
    envelope.record === null ||
    typeof envelope.record !== 'object' ||
    Array.isArray(envelope.record)
  ) {
    throw new Error('serializer.malformed_envelope: missing protocol_version/content_hash/record');
  }

  if (envelope.serializer_protocol_version !== META_SERIALIZER_PROTOCOL_VERSION) {
    throw new Error(
      `serializer.unknown_protocol_version: ${envelope.serializer_protocol_version}`,
    );
  }

  const record = envelope.record as MetaMessageLifecycleRecord;

  if (
    typeof record.lifecycle_protocol_version !== 'string' ||
    record.lifecycle_protocol_version !== META_LIFECYCLE_PROTOCOL_VERSION
  ) {
    throw new Error(
      `serializer.unknown_lifecycle_version: ${String(record.lifecycle_protocol_version)}`,
    );
  }

  const recomputed = sha256Hex(canonicalRecordBody(record));
  if (recomputed !== envelope.content_hash) {
    throw new Error('serializer.content_hash_mismatch');
  }

  return freezeSnapshot({ ...record }) as MetaMessageLifecycleRecord;
}

// ===========================================================================
// ERC-1 §7.6 — Compressor enforcement (M-038).
//
// `applyMetaRetentionToCompression` is the single function that turns a frozen
// `MetaMessageLifecycleRecord` into a closed `MetaCompressionDirective`. The
// directive tells the compressor how a meta message must survive history
// eviction. The compressor itself lives in `compression.ts`; this function
// only emits the directive. It does NOT read project files, change Authority,
// or touch tool pairing / current-user Pinned Working Set (spec ERC-1 §7.6).
//
// `reload_required` / `invalidated` directives emit MARKERS ONLY — they do
// not claim M-049 reconstruction is done and they carry no Wave F edge
// (spec ERC-1 §7 / INV-E5).
// ===========================================================================

/** Protocol version stamped on every compression directive result. */
export const META_COMPRESSION_PROTOCOL_VERSION = 'mi.meta.compression/1';

/**
 * Closed set of compressor directives (spec ERC-1 §7.6).
 *
 *   - `preserve_body`             — ordinary history eviction MUST NOT drop
 *                                    the meta message body.
 *   - `emit_reload_marker`        — body MAY be omitted, but the marker /
 *                                    source / provenance / freshness / ordinal
 *                                    MUST survive for M-049 to pick up later.
 *   - `emit_invalidation_marker`  — keep the invalidation reason; the meta
 *                                    message must not silently disappear.
 */
export type MetaCompressionDirective =
  | 'preserve_body'
  | 'emit_reload_marker'
  | 'emit_invalidation_marker';

/** Input to `applyMetaRetentionToCompression`. */
export interface MetaRetentionCompressionInput {
  lifecycle_record: MetaMessageLifecycleRecord;
}

/**
 * Frozen compression directive (spec ERC-1 §7.6).
 *
 * `reason_codes` carries `compression.*` codes explaining why the directive
 * was chosen. `result_id` is deterministic over the lifecycle record identity
 * and the directive, so identical inputs collide and differing ones diverge.
 */
export interface MetaRetentionCompressionResult {
  compression_protocol_version: string;
  result_id: string;
  meta_directive: MetaCompressionDirective;
  reason_codes: string[];
}

/**
 * Decide the compressor directive for a meta lifecycle record.
 *
 * Algorithm (spec ERC-1 §7.6):
 *   1. Map lifecycle state to directive:
 *        - 'resident'         → 'preserve_body'
 *        - 'serialized'       → 'preserve_body'
 *        - 'reload_required'  → 'emit_reload_marker'
 *        - 'invalidated'      → 'emit_invalidation_marker'
 *   2. Reason codes follow the directive, namespaced `compression.*`.
 *   3. Mint deterministic `result_id = mcomp:<sha256(canonical).slice(0,16)>`.
 *   4. Freeze the result.
 *
 * What this function does NOT do:
 *   - Read project files, source content, or M-049 state.
 *   - Change Authority/Trust (INV-E3).
 *   - Emit a "reconstruction complete" flag — the reload marker is a marker
 *     only (INV-E5 / no Wave F edge).
 */
export function applyMetaRetentionToCompression(
  input: MetaRetentionCompressionInput,
): MetaRetentionCompressionResult {
  const record = input.lifecycle_record;
  requireIdentity(
    record.lifecycle_record_id,
    'compression.lifecycle_record.lifecycle_record_id',
  );

  // 1. State → directive. The switch is exhaustive over MetaLifecycleState;
  //    TS narrows `directive` to never if a future variant is added without a
  //    case. The runtime guard below is belt-and-suspenders for untyped
  //    callers.
  let directive: MetaCompressionDirective;
  let reasonCode: string;
  switch (record.state) {
    case 'resident':
      directive = 'preserve_body';
      reasonCode = 'compression.resident_preserve_body';
      break;
    case 'serialized':
      directive = 'preserve_body';
      reasonCode = 'compression.serialized_preserve_body';
      break;
    case 'reload_required':
      directive = 'emit_reload_marker';
      reasonCode = 'compression.reload_required_emit_marker';
      break;
    case 'invalidated':
      directive = 'emit_invalidation_marker';
      reasonCode = 'compression.invalidated_emit_marker';
      break;
  }
  if (directive === undefined) {
    throw new Error(`compression.unknown_state: ${record.state}`);
  }

  // 3. Deterministic result_id. Canonical input covers protocol version,
  //    lifecycle record identity, state, and directive — so identical records
  //    collide and differing ones diverge.
  const canonical = canonicalJson({
    compression_protocol_version: META_COMPRESSION_PROTOCOL_VERSION,
    lifecycle_record_id: record.lifecycle_record_id,
    session_snapshot_id: record.session_snapshot_id,
    message_id: record.message_id,
    activation_id: record.activation_id,
    retention_decision_id: record.retention_decision_id,
    state: record.state,
    meta_directive: directive,
  });
  const resultId = `mcomp:${sha256Hex(canonical).slice(0, 16)}`;

  const result: MetaRetentionCompressionResult = {
    compression_protocol_version: META_COMPRESSION_PROTOCOL_VERSION,
    result_id: resultId,
    meta_directive: directive,
    reason_codes: [reasonCode],
  };

  return freezeSnapshot(result) as MetaRetentionCompressionResult;
}

// ===========================================================================
// ERC-1 §7.7 — Activation gate (M-038).
//
// `canActivateMetaRetention` is the closed-form six-gate predicate that must
// pass before any meta retention directive is allowed to take effect on the
// compressor / serializer path. Gates are NOT replaceable by a Prompt
// reminder (spec ERC-1 §7.7). The output lists every failing gate by its
// canonical capability name, in canonical order, so diagnostics are stable.
// ===========================================================================

/**
 * Six independent capability gates (spec ERC-1 §7.7 / plan Step 4).
 *
 * Each gate is a boolean observation supplied by the caller — this function
 * does not derive them. The gates are:
 *   1. `message_model_supports_is_meta`           — provider message model
 *      carries the `is_meta` / lifecycle identity flag.
 *   2. `serializer_round_trip_verified`           — serialize/deserialize
 *      round-trips losslessly (verified elsewhere).
 *   3. `compressor_handles_all_three_actions`     — compressor honors
 *      preserve / reload-marker / invalidation-marker.
 *   4. `resume_compaction_keeps_user_turn_count`  — compaction resume does
 *      not silently drop user turns.
 *   5. `unknown_metadata_fails_closed`            — unknown metadata throws
 *      instead of degrading to a user message.
 *   6. `message_source_identity_matches`          — M-008 / M-038 message ↔
 *      source identity match.
 */
export interface MetaRetentionActivationInput {
  message_model_supports_is_meta: boolean;
  serializer_round_trip_verified: boolean;
  compressor_handles_all_three_actions: boolean;
  resume_compaction_keeps_user_turn_count: boolean;
  unknown_metadata_fails_closed: boolean;
  message_source_identity_matches: boolean;
}

/**
 * Frozen activation decision (spec ERC-1 §7.7).
 *
 * `activated` is true iff every gate passed. `missing` lists the canonical
 * names of every failing gate, in canonical order. It is empty when
 * `activated` is true.
 */
export interface MetaRetentionActivationResult {
  activated: boolean;
  missing: string[];
}

/**
 * Canonical gate order. Output `missing` is always emitted in this order
 * regardless of the input object's key order, so diagnostics are stable.
 */
const ACTIVATION_GATE_ORDER = [
  'message_model_supports_is_meta',
  'serializer_round_trip_verified',
  'compressor_handles_all_three_actions',
  'resume_compaction_keeps_user_turn_count',
  'unknown_metadata_fails_closed',
  'message_source_identity_matches',
] as const satisfies ReadonlyArray<keyof MetaRetentionActivationInput>;

/**
 * Evaluate the six-gate activation predicate.
 *
 * Algorithm (spec ERC-1 §7.7):
 *   1. Walk gates in canonical order.
 *   2. For each gate whose value is not strictly `true`, append its canonical
 *      name to `missing`.
 *   3. `activated` is true iff `missing` is empty.
 *   4. Freeze the result.
 *
 * Gates are independent — flipping one to false never flips another. No gate
 * may be replaced by a Prompt reminder; the predicate refuses activation
 * loudly rather than degrade.
 */
export function canActivateMetaRetention(
  input: MetaRetentionActivationInput,
): MetaRetentionActivationResult {
  const missing: string[] = [];
  for (const gate of ACTIVATION_GATE_ORDER) {
    if (input[gate] !== true) {
      missing.push(gate);
    }
  }

  const result: MetaRetentionActivationResult = {
    activated: missing.length === 0,
    missing,
  };

  return freezeSnapshot(result) as MetaRetentionActivationResult;
}
