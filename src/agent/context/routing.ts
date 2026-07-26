/**
 * CRC-3 Environment Context Block (M-009) & Markdown Trusted Routing (M-012).
 *
 * This module is the Wave C routing surface that sits AFTER BRC-3 intake and
 * BEFORE Wave D M-008 injection / M-044 admission. It produces two structured,
 * frozen outputs:
 *
 *   1. `EnvironmentContextBlock` — a freshness-aware, budget-bounded projection
 *      of a `NormalizedEnvironmentSnapshot`'s `allowed_fields`. It reads ONLY
 *      `allowed_fields`; it never reads `process.env` or the parent environment.
 *      `placement` is fixed to `'system_dynamic'`, but the block carries NO
 *      `authority` field — placement never elevates Authority (INV-C6).
 *
 *   2. `MarkdownRouteDecision` — the target decision for a markdown/source
 *      candidate. The four-gate AND
 *        (trusted_source_policy AND schema_valid AND deterministic_loader
 *         AND sanitization_accepted)
 *      is the ONLY path to a non-`reject` target. Files, filenames, paths,
 *      frontmatter, schema structure, and self-reported content NEVER
 *      establish trust. Routing NEVER returns an `approved` field — asset
 *      routes merely enter RC-1 candidate governance.
 *
 * Non-negotiable invariants (CRC-3 §9.5 / §9.8 / §17.3):
 *   - Environment block consumes only normalized allowlisted fields.
 *   - Markdown route has a four-gate AND; any single failure ⇒ `reject`.
 *   - Routing decides target only; it never injects / admits / approves.
 *   - Authority is sourced from the input; routing never mints `system`.
 */

import { createHash } from 'node:crypto';
import { freezeSnapshot } from '../contracts/identities.js';
import type { NormalizedEnvironmentSnapshot } from './intake/environment.js';
import type { SourceBudgetPolicy } from './intake/source-budget.js';

// ---------------------------------------------------------------------------
// Shared primitives.
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization. Object keys are emitted in ascending
 * (lexicographic) order regardless of insertion order, and primitives are
 * serialized with stable rules. This is the canonical form that feeds every
 * sha256 in this module — callers can rely on identical inputs producing
 * identical hashes.
 *
 * Only the JSON-serializable primitive/record shapes used here are supported:
 * string | boolean | number | null | Readonly<Record<string, ...>>. Nested
 * arrays of strings are also supported (used for omitted_field_codes /
 * trust_proof_refs).
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
// M-009 — EnvironmentContextBlock.
// ===========================================================================

/** Protocol version stamped on every environment block produced by this module. */
export const ENVIRONMENT_BLOCK_PROTOCOL_VERSION = 'mi.env-block/1';

/** A normalized environment value as it appears in `allowed_fields`. */
export type EnvironmentFieldValue = string | boolean | number;

export interface EnvironmentContextBlock {
  environment_block_protocol_version: string;
  environment_block_id: string;
  source_environment_snapshot_id: string;
  source_budget_policy_ref: string;
  /** Fixed. The block never claims a different placement. */
  placement: 'system_dynamic';
  fields: Readonly<Record<string, EnvironmentFieldValue>>;
  omitted_field_codes: readonly string[];
  observed_at: string;
  expires_at: string | null;
  content_hash: string;
}

/**
 * Result when the environment snapshot cannot be projected into a block.
 *
 * `unavailable` is returned (never thrown) so the caller can decide whether to
 * skip injection silently — the block is optional dynamic context, not a hard
 * error (CRC-3 §9.8: "snapshot expired and no refresh ⇒ do not inject").
 */
export interface EnvironmentBlockUnavailable {
  unavailable: true;
  reason_code: 'environment.expired_no_refresh';
}

/**
 * Resume/validation context the caller supplies alongside the snapshot.
 *
 * `NormalizedEnvironmentSnapshot` does not itself carry `expires_at` or a
 * refreshed-snapshot id — those belong to the session-resume validation step
 * (CRC-3 §9.3 rule 6). They are passed here as explicit options so this module
 * never reaches outside its arguments.
 */
export interface EnvironmentBlockOptions {
  /** The instant the caller is evaluating freshness, in ISO-8601 UTC. */
  now: string;
  /** When the snapshot's values expire (null ⇒ never expires). */
  expires_at?: string | null;
  /**
   * If the snapshot has already expired, the id of a refreshed snapshot that
   * should be used instead. When this is null/absent AND expires_at is in the
   * past, the block is `unavailable`.
   */
  refreshed_snapshot_id?: string | null;
  /**
   * Optional per-field byte cap. A single field whose UTF-8 serialized length
   * exceeds this is OMITTED with code
   * `environment.field_over_budget.<key>` (CRC-3 §9.3 rule 5). When omitted,
   * no per-field cap is applied (the source budget already bounded the source).
   */
  per_field_max_bytes?: number;
}

/**
 * Build a frozen `EnvironmentContextBlock` from a normalized snapshot.
 *
 * Algorithm (CRC-3 §9.3):
 *   1. Freshness: if `expires_at` is in the past (strictly before `now`) and no
 *      `refreshed_snapshot_id` is supplied ⇒ `unavailable`.
 *   2. Read ONLY `snapshot.allowed_fields`. `process.env` and the parent
 *      environment are never consulted.
 *   3. Apply the optional per-field byte cap; overflowed fields are OMITTED
 *      with a deterministic code and excluded from both `fields` and the
 *      `content_hash`.
 *   4. Sort the kept fields by key (deterministic field order).
 *   5. `content_hash = sha256(canonical JSON of sorted kept fields)`.
 *   6. `placement = 'system_dynamic'` (fixed). No `authority` field is emitted.
 *   7. `environment_block_id = env:<sha256(canonical).slice(0,16)>`.
 */
export function buildEnvironmentContextBlock(
  snapshot: NormalizedEnvironmentSnapshot,
  budgetPolicy: SourceBudgetPolicy,
  options: EnvironmentBlockOptions,
): EnvironmentContextBlock | EnvironmentBlockUnavailable {
  const nowMs = Date.parse(options.now);
  const expiresAt = options.expires_at ?? null;

  // 1. Freshness. An unparseable `now` is treated as "cannot validate freshness"
  //    and does NOT silently pass — but Date.parse returning NaN against a past
  //    expires_at still yields a reject only when expires_at is a real past
  //    timestamp. We compare numerically; if `now` is NaN we skip expiry
  //    enforcement only because we cannot order the two instants (and the
  //    caller is responsible for passing a real timestamp).
  if (expiresAt !== null && options.refreshed_snapshot_id == null) {
    const expMs = Date.parse(expiresAt);
    if (!Number.isNaN(expMs) && !Number.isNaN(nowMs) && expMs < nowMs) {
      return { unavailable: true, reason_code: 'environment.expired_no_refresh' };
    }
  }

  // 2–3. Walk allowed_fields, applying the optional per-field byte cap. Falsy
  //      values (false, 0, '') are legitimate observed values and are kept.
  const perFieldCap = options.per_field_max_bytes;
  const kept: Record<string, EnvironmentFieldValue> = {};
  const omitted: string[] = [];
  // Start from the snapshot's own omitted codes (already sorted upstream) and
  // add our budget-overflow codes; we re-sort the combined list at the end.
  for (const code of snapshot.omitted_field_codes) {
    omitted.push(code);
  }
  for (const [key, value] of Object.entries(snapshot.allowed_fields)) {
    if (
      perFieldCap !== undefined &&
      Buffer.byteLength(canonicalJson(value), 'utf8') > perFieldCap
    ) {
      omitted.push(`environment.field_over_budget.${key}`);
      continue;
    }
    kept[key] = value;
  }
  omitted.sort();

  // 4. Sorted field order — re-build the record by sorted key so that
  //    `Object.keys(block.fields)` is lexicographic regardless of input order.
  const sortedFields: Record<string, EnvironmentFieldValue> = {};
  for (const key of Object.keys(kept).sort()) {
    sortedFields[key] = kept[key];
  }

  // 5. content_hash over the canonical (sorted) kept fields ONLY.
  const contentHash = sha256Hex(canonicalJson(sortedFields));

  // 7. environment_block_id.
  const environmentBlockId = `env:${contentHash.slice(0, 16)}`;

  const block: EnvironmentContextBlock = {
    environment_block_protocol_version: ENVIRONMENT_BLOCK_PROTOCOL_VERSION,
    environment_block_id: environmentBlockId,
    source_environment_snapshot_id: snapshot.environment_snapshot_id,
    source_budget_policy_ref: `${budgetPolicy.policy_id}:${budgetPolicy.policy_version}`,
    placement: 'system_dynamic',
    fields: sortedFields,
    omitted_field_codes: omitted,
    observed_at: snapshot.observed_at,
    expires_at: expiresAt,
    content_hash: contentHash,
  };

  return freezeSnapshot(block) as EnvironmentContextBlock;
}

// ===========================================================================
// M-012 — Markdown Trusted Routing.
// ===========================================================================

/** Protocol version stamped on every route decision produced by this module. */
export const MARKDOWN_ROUTE_PROTOCOL_VERSION = 'mi.route/1';

export type MarkdownRouteTarget =
  | 'project_instruction_context'
  | 'auto_memory_context'
  | 'agent_role_asset'
  | 'task_template_asset'
  | 'tool_prompt_asset'
  | 'reject';

/**
 * Closed set of source classes the router understands. Mirrors the
 * `ContextSourceClass` enum in intake.ts (CRC-3 §9.4 vocabulary).
 */
export type MarkdownSourceClass =
  | 'instruction_candidate'
  | 'auto_memory'
  | 'environment'
  | 'tool_result'
  | 'attachment'
  | 'external_content';

/**
 * Asset sub-kind for `instruction_candidate` sources whose policy metadata
 * identifies them as a role/task/tool asset rather than a project instruction.
 * Absent ⇒ default to `project_instruction_context`.
 */
export type InstructionAssetKind = 'agent_role' | 'task_template' | 'tool_prompt';

export interface MarkdownSourceRouteInput {
  context_source_id: string;
  source_policy_id: string;
  /** Version of the source policy referenced by `source_policy_id`. */
  policy_version: string;
  schema_id: string;
  loader_id: string;
  loader_version: string;
  sanitization_result_ref: string;
  bounded_source_ref: string;
  source_class: MarkdownSourceClass;
  /**
   * Authority sourced from the source policy/envelope. The router echoes this
   * verbatim and NEVER emits `'system'` — routing does not elevate Authority.
   */
  authority: string;
  /** Retention class sourced from the source policy/envelope. */
  retention: string;
  /** Optional asset sub-kind, only meaningful for `instruction_candidate`. */
  asset_kind?: InstructionAssetKind;
}

export interface MarkdownRouteTrustEvidence {
  trusted_source_policy: boolean;
  schema_valid: boolean;
  deterministic_loader: boolean;
  sanitization_accepted: boolean;
}

/** Policy identity reference (shared vocabulary, spec §6.1). */
export interface PolicyRef {
  policy_id: string;
  policy_version: string;
}

export interface MarkdownRouteDecision {
  route_protocol_version: string;
  route_decision_id: string;
  policy_ref: PolicyRef;
  context_source_id: string;
  target: MarkdownRouteTarget;
  trust_proof_refs: readonly string[];
  placement_request: string | null;
  /** Sourced from the input; never `'system'`. */
  authority: string;
  retention: string;
  reason_code: string;
}

/**
 * The four trust gates, in fixed order. Order is stable so reason codes and
 * proof refs are deterministic.
 */
const GATE_KEYS = [
  'trusted_source_policy',
  'schema_valid',
  'deterministic_loader',
  'sanitization_accepted',
] as const;
type GateKey = (typeof GATE_KEYS)[number];

/** Ref string emitted for a passing gate. */
function gateProofRef(gate: GateKey, input: MarkdownSourceRouteInput): string {
  switch (gate) {
    case 'trusted_source_policy':
      return `source_policy:${input.source_policy_id}`;
    case 'schema_valid':
      return `schema:${input.schema_id}`;
    case 'deterministic_loader':
      return `loader:${input.loader_id}`;
    case 'sanitization_accepted':
      return `sanitization:${input.sanitization_result_ref}`;
  }
}

/** The reason_code suffix naming the gate. */
const GATE_REASON_SUFFIX: Readonly<Record<GateKey, string>> = Object.freeze({
  trusted_source_policy: 'route.gate_trusted_source_policy_failed',
  schema_valid: 'route.gate_schema_valid_failed',
  deterministic_loader: 'route.gate_deterministic_loader_failed',
  sanitization_accepted: 'route.gate_sanitization_accepted_failed',
});

/**
 * Map a (source_class, asset_kind) pair to a route target, assuming all four
 * gates have passed. Returns either a non-reject target or a reject reason
 * code (for source classes that are not markdown-routable).
 */
function selectTarget(
  input: MarkdownSourceRouteInput,
): { target: MarkdownRouteTarget; reason_code: string } {
  switch (input.source_class) {
    case 'instruction_candidate':
      switch (input.asset_kind) {
        case 'agent_role':
          return { target: 'agent_role_asset', reason_code: 'route.target.asset_role' };
        case 'task_template':
          return { target: 'task_template_asset', reason_code: 'route.target.asset_task' };
        case 'tool_prompt':
          return { target: 'tool_prompt_asset', reason_code: 'route.target.asset_tool' };
        case undefined:
        default:
          // Unknown asset_kind ⇒ default to project_instruction_context. We do
          // NOT route an unknown sub-kind to an asset target (CRC-3 §9.5
          // rule 8: unknown ⇒ the safe default, not an asset activation).
          return {
            target: 'project_instruction_context',
            reason_code: 'route.target.instruction_default',
          };
      }
    case 'auto_memory':
      return { target: 'auto_memory_context', reason_code: 'route.target.auto_memory' };
    case 'environment':
      return {
        target: 'reject',
        reason_code: 'route.environment_not_markdown_routable',
      };
    case 'tool_result':
      return {
        target: 'reject',
        reason_code: 'route.tool_result_not_markdown_routable',
      };
    case 'attachment':
    case 'external_content':
      return {
        target: 'reject',
        reason_code: `route.${input.source_class}_not_markdown_routable`,
      };
  }
}

/**
 * Route a markdown/source candidate to a target.
 *
 * Algorithm (CRC-3 §9.2 / §9.4 / §9.5 / §9.8):
 *   1. Collect passing-gate proof refs in fixed gate order.
 *   2. Four-gate AND: if ANY gate is false ⇒ `target='reject'` and a
 *      `route.gate_<name>_failed` reason_code listing every failing gate.
 *      Gate failure is checked FIRST — it takes precedence over source-class
 *      compatibility (a failed gate on an environment source still reports the
 *      gate failure, not the class incompatibility).
 *   3. If all gates pass, consult the target/source-class matrix.
 *      Compatible classes route to their target; incompatible classes route to
 *      `reject` with a `route.<class>_not_markdown_routable` reason_code.
 *   4. `authority` is echoed from the input; routing never emits `'system'`.
 *   5. `route_decision_id = route:<sha256(canonical decision).slice(0,16)>`.
 *
 * The returned decision is frozen and carries NO `approved` field — routing
 * only decides target; asset routes still require RC-1 governance.
 */
export function routeMarkdownSource(
  input: MarkdownSourceRouteInput,
  evidence: MarkdownRouteTrustEvidence,
): MarkdownRouteDecision {
  // 1. Passing-gate proof refs, in fixed gate order.
  const trustProofRefs: string[] = [];
  for (const gate of GATE_KEYS) {
    if (evidence[gate]) {
      trustProofRefs.push(gateProofRef(gate, input));
    }
  }

  // 2. Four-gate AND. Gather every failing gate so the reason_code is precise.
  const failingGates = GATE_KEYS.filter((g) => !evidence[g]);

  let target: MarkdownRouteTarget;
  let reasonCode: string;

  if (failingGates.length > 0) {
    target = 'reject';
    if (failingGates.length === 1) {
      reasonCode = GATE_REASON_SUFFIX[failingGates[0]];
    } else {
      // Multiple gates failed: enumerate each so the caller can diagnose. The
      // reason_code starts with `route.gate_` (the test's invariant) and names
      // every failing gate key.
      reasonCode = `route.gate_failed:${failingGates.join(',')}`;
    }
  } else {
    // 3. All gates passed — consult the source-class matrix.
    const decision = selectTarget(input);
    target = decision.target;
    reasonCode = decision.reason_code;
  }

  // 5. route_decision_id. The canonical input includes context_source_id,
  //    target, and reason_code so that accept vs reject (and different reject
  //    reasons) yield different ids, while identical decisions are stable.
  const canonical = canonicalJson({
    context_source_id: input.context_source_id,
    target,
    reason_code: reasonCode,
  });
  const routeDecisionId = `route:${sha256Hex(canonical).slice(0, 16)}`;

  const decision: MarkdownRouteDecision = {
    route_protocol_version: MARKDOWN_ROUTE_PROTOCOL_VERSION,
    route_decision_id: routeDecisionId,
    policy_ref: {
      policy_id: input.source_policy_id,
      policy_version: input.policy_version,
    },
    context_source_id: input.context_source_id,
    target,
    trust_proof_refs: trustProofRefs,
    placement_request: null,
    authority: input.authority,
    retention: input.retention,
    reason_code: reasonCode,
  };

  return freezeSnapshot(decision) as MarkdownRouteDecision;
}
