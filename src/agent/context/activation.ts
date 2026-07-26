/**
 * DRC-2 §8 — Project Instruction Activation (M-008).
 *
 * This module is the Wave D activation surface that sits AFTER CRC-3
 * `MarkdownRouteDecision` and BEFORE Wave E M-038 retention. It lifts a
 * routed `project_instruction_context` candidate into a frozen
 * `MetaContextActivation` for the RC-2 `meta_context` plane.
 *
 * The channel boundary is load-bearing: Project Instruction and Auto Memory
 * never elevate, copy, or convert into each other. Only the
 * `project_instruction` channel can flow through this function.
 *
 * Non-negotiable invariants (spec §8.5 / §8.12 / INV-D4 / INV-D5 / INV-D8):
 *   - `is_meta=true` does NOT promote Authority / Trust / Retention.
 *   - Output NEVER carries `memory_candidate_id` / `admission_decision_id`
 *     / a memory writer (channel separation).
 *   - meta context lands ONLY in `meta_context`, never in
 *     `system_static` / `system_dynamic`, and never replaces the current
 *     user turn.
 *   - The four-gate trust AND is re-checked here because route target,
 *     trust proof, sanitizer acceptance, and source budget must all be
 *     present and consistent before any meta message can be minted.
 *   - `retention_state='unassigned'` is fixed; M-038 is not done here.
 *   - Bounded content is consumed verbatim — no second silent truncation.
 */

import { createHash } from 'node:crypto';
import { freezeSnapshot } from '../contracts/identities.js';
import {
  buildSemanticRequestSnapshot,
  type BuildSemanticRequestSnapshotInput,
  type SemanticMessage,
  type SemanticRequestSnapshot,
} from '../contracts/request-snapshot.js';
import {
  decideMemoryAdmission,
  decideMemoryUse,
  type MemoryAdmissionDecision,
  type MemoryAdmissionInput,
  type MemoryAdmissionPolicy,
  type MemoryUseDecision,
  type MemoryUseInput,
} from '../../memory/admission.js';

// ---------------------------------------------------------------------------
// Shared primitives.
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization. Object keys are emitted in ascending
 * (lexicographic) order regardless of insertion order. This canonical form
 * feeds every sha256 in this module.
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
// M-008 — Project Instruction Activation.
// ===========================================================================

/** Protocol version stamped on every activation produced by this module. */
export const ACTIVATION_PROTOCOL_VERSION = 'mi.activation/1';

/**
 * The closed set of trusted context channels (spec §8.2). Channel is decided
 * by CRC-3 `MarkdownRouteDecision.target`; nobody downstream may rewrite it.
 */
export type TrustedContextChannel = 'project_instruction' | 'auto_memory';

/**
 * Identity carried alongside an activation. The fields here MUST be consistent
 * with the routing decision and the source envelope; this function verifies
 * that consistency rather than trusting it.
 */
export interface ContextActivationIdentity {
  activation_protocol_version: string;
  activation_id: string;
  request_snapshot_id: string;
  source_context_id: string;
  route_decision_id: string;
  channel: TrustedContextChannel;
}

/**
 * Input to `activateProjectInstruction`. Every field is required unless noted;
 * the four-gate trust AND is enforced by re-checking each load-bearing field.
 */
export interface ProjectInstructionActivationInput {
  activation_identity: ContextActivationIdentity;
  context_source_id: string;
  route_decision_id: string;
  /** Must be `project_instruction_context` (CRC-3 MarkdownRouteDecision.target). */
  route_target: string;
  bounded_content_ref: string;
  content_hash: string;
  /** CRC-3 four-gate trust proof; cannot be empty. */
  trust_proof_ref: string;
  /** BRC-3 sanitizer verdict; only `accepted` / `transformed` may pass. */
  sanitization_status: 'accepted' | 'rejected' | 'transformed';
  /** Source budget reference; cannot be empty. */
  source_budget_ref: string;
  provenance_refs: string[];
  authority: string;
  trust: string;
  freshness_ref: string;
  overflow_metadata_ref: string | null;
  /**
   * Stable ordinal. Caller guarantees uniqueness across activations in a turn;
   * this function only receives it (does not invent or guess order).
   */
  ordinal: number;
}

/**
 * Frozen meta context activation (spec §8.4). Fixed fields are literal:
 *   - `semantic_role='user'` is Provider message-plane encoding, NOT a claim
 *     that the content is from the current user.
 *   - `placement='meta_context'` — never system_static/system_dynamic.
 *   - `is_meta=true` — distinguishes the message category only.
 *   - `retention_state='unassigned'` — M-038 has not run yet.
 *
 * Authority and Trust are sourced verbatim from the input; this struct never
 * promotes them. There is no memory field on this struct by design (INV-D5).
 */
export interface MetaContextActivation {
  activation_protocol_version: string;
  activation_id: string;
  request_snapshot_id: string;
  message_id: string;
  semantic_role: 'user';
  placement: 'meta_context';
  is_meta: true;
  source_context_id: string;
  route_decision_id: string;
  content_ref: string;
  content_hash: string;
  authority: string;
  trust: string;
  provenance_refs: string[];
  freshness_ref: string;
  overflow_metadata_ref: string | null;
  retention_state: 'unassigned';
  ordinal: number;
}

/**
 * Activate a project-instruction candidate into a `MetaContextActivation`.
 *
 * Algorithm (spec §8.3 / §8.5 / §8.12):
 *   1. Four-gate trust AND (every failure throws — no silent skip, no inject):
 *        a. route_target must equal `project_instruction_context`.
 *        b. trust_proof_ref must be non-empty.
 *        c. sanitization_status must be `accepted` or `transformed`.
 *        d. source_budget_ref must be non-empty.
 *   2. Identity consistency: activation_identity.source_context_id must equal
 *      context_source_id, and route_decision_id must match.
 *   3. Channel must be `project_instruction` (channel boundary).
 *   4. ordinal must be a non-negative integer (caller owns uniqueness).
 *   5. Mint a deterministic `message_id = meta:<sha256(canonical).slice(0,16)>`.
 *   6. Copy Authority / Trust / content / provenance / freshness / overflow
 *      verbatim — never promote, never re-truncate (INV-D4 / INV-D8).
 *   7. Freeze the result.
 */
export function activateProjectInstruction(
  input: ProjectInstructionActivationInput,
): MetaContextActivation {
  const identity = input.activation_identity;

  // 1. Four-gate trust AND. Order matches spec §8.12 for stable diagnostics.
  if (input.route_target !== 'project_instruction_context') {
    throw new Error('activation.wrong_route');
  }
  if (!input.trust_proof_ref) {
    throw new Error('activation.missing_trust');
  }
  if (input.sanitization_status === 'rejected') {
    throw new Error('activation.sanitizer_rejected');
  }
  if (!input.source_budget_ref) {
    throw new Error('activation.missing_budget');
  }

  // 2. Identity consistency.
  if (identity.source_context_id !== input.context_source_id) {
    throw new Error(
      `activation.identity_mismatch: source_context_id ${identity.source_context_id} !== ${input.context_source_id}`,
    );
  }
  if (identity.route_decision_id !== input.route_decision_id) {
    throw new Error(
      `activation.identity_mismatch: route_decision_id ${identity.route_decision_id} !== ${input.route_decision_id}`,
    );
  }

  // 3. Channel boundary.
  if (identity.channel !== 'project_instruction') {
    throw new Error(
      `activation.wrong_channel: expected project_instruction, got ${identity.channel}`,
    );
  }

  // 4. ordinal sanity. Uniqueness is the caller's responsibility.
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error(
      `activation.invalid_ordinal: ordinal must be a non-negative integer, got ${input.ordinal}`,
    );
  }

  // 5. Deterministic message_id. Canonical input covers everything that defines
  //    this activation's identity and content, so identical inputs collide and
  //    differing content diverges.
  const canonical = canonicalJson({
    activation_protocol_version: identity.activation_protocol_version,
    activation_id: identity.activation_id,
    request_snapshot_id: identity.request_snapshot_id,
    source_context_id: input.context_source_id,
    route_decision_id: input.route_decision_id,
    content_ref: input.bounded_content_ref,
    content_hash: input.content_hash,
    authority: input.authority,
    trust: input.trust,
    provenance_refs: input.provenance_refs,
    freshness_ref: input.freshness_ref,
    overflow_metadata_ref: input.overflow_metadata_ref,
    ordinal: input.ordinal,
  });
  const messageId = `meta:${sha256Hex(canonical).slice(0, 16)}`;

  // 6–7. Build & freeze. Fixed fields are literals — they cannot be promoted.
  const result: MetaContextActivation = {
    activation_protocol_version: identity.activation_protocol_version,
    activation_id: identity.activation_id,
    request_snapshot_id: identity.request_snapshot_id,
    message_id: messageId,
    semantic_role: 'user',
    placement: 'meta_context',
    is_meta: true,
    source_context_id: input.context_source_id,
    route_decision_id: input.route_decision_id,
    content_ref: input.bounded_content_ref,
    content_hash: input.content_hash,
    authority: input.authority,
    trust: input.trust,
    provenance_refs: input.provenance_refs,
    freshness_ref: input.freshness_ref,
    overflow_metadata_ref: input.overflow_metadata_ref,
    retention_state: 'unassigned',
    ordinal: input.ordinal,
  };

  return freezeSnapshot(result) as MetaContextActivation;
}

// ===========================================================================
// DRC-2 Task 4 — Meta Context Request Integration.
// ===========================================================================

/**
 * Request input for `attachMetaContext`. This is `BuildSemanticRequestSnapshotInput`
 * MINUS the `meta_context` field — that plane is derived from `activations`, not
 * supplied by the caller, so the channel boundary (spec §8.5-1) cannot be
 * bypassed by smuggling meta into the input.
 */
export type AttachMetaContextRequestInput = Omit<
  BuildSemanticRequestSnapshotInput,
  'meta_context'
>;

/**
 * Attach a batch of `MetaContextActivation`s to an RC-2 request snapshot as the
 * `meta_context` plane, then bake the full four-plane snapshot.
 *
 * Algorithm (spec §8.5):
 *   1. Detect ordinal conflicts up front → throw `meta.ordinal_conflict`.
 *      Ordering is ordinal-driven only; this function never guesses from path
 *      strings, content, or insertion order (spec §8.5-5).
 *   2. Sort activations by `ordinal` ascending (stable for equal ordinals is
 *      unreachable because step 1 rejects duplicates).
 *   3. Project each activation to a `SemanticMessage` placed in `meta_context`:
 *        - `message_id` ← activation.message_id (verbatim, deterministic).
 *        - `role='user'` ← activation.semantic_role (Provider message plane
 *          encoding; NOT a claim that the content is from the current user).
 *        - `content` ← activation.content_ref (bounded content ref, verbatim —
 *          no second silent truncation, spec §8.5-8).
 *        - `is_meta=true` ← activation.is_meta (category flag only).
 *      Authority / Trust / Placement from the activation are attached as
 *      out-of-band fields on the record so downstream provenance consumers can
 *      read them; they are NOT promoted by `is_meta=true` (INV-D4 / INV-D8).
 *   4. Call `buildSemanticRequestSnapshot` with the projected `meta_context`
 *      plus the caller's system / conversation / tools. The builder re-checks
 *      every cross-plane invariant (registry alignment, is_meta flags, JSON
 *      compatibility, deep freeze).
 *
 * Non-negotiable invariants enforced here + by the builder:
 *   - meta lands ONLY in `meta_context`, never in `system_static` /
 *     `system_dynamic`, and never replaces the current user turn.
 *   - `retention_state='unassigned'` is fixed; M-038 is not done here.
 *   - Provider adapters downstream must not rewrite role / placement /
 *     authority / trust (spec §8.5-6) — they only encode the semantic message.
 *
 * @throws {Error} `meta.ordinal_conflict` when two activations share an ordinal.
 * @throws re-throws any error from `buildSemanticRequestSnapshot`
 *         (identity / alignment / invariant violations).
 */
export function attachMetaContext(
  requestInput: AttachMetaContextRequestInput,
  activations: ReadonlyArray<MetaContextActivation>,
): SemanticRequestSnapshot {
  // 1. Ordinal conflict detection. Using a Set keeps this O(n) and avoids any
  //    ambiguity from sort-stable tie-breaking — ties are simply invalid.
  const seenOrdinals = new Set<number>();
  for (const a of activations) {
    if (seenOrdinals.has(a.ordinal)) {
      throw new Error(
        `meta.ordinal_conflict: duplicate ordinal ${a.ordinal} (activations ${a.activation_id})`,
      );
    }
    seenOrdinals.add(a.ordinal);
  }

  // 2. Stable ascending sort by ordinal. Conflicts already rejected, so the
  //    order is total.
  const ordered = [...activations].sort((x, y) => x.ordinal - y.ordinal);

  // 3. Project each activation to a SemanticMessage placed in meta_context.
  //    Authority / trust / placement ride along as provenance fields; the
  //    SemanticMessage type only exposes the Provider-neutral surface, but the
  //    runtime record retains activation fields for downstream tracing.
  const metaContext: SemanticMessage[] = ordered.map((a) => {
    const message = {
      message_id: a.message_id,
      role: a.semantic_role,
      content: a.content_ref,
      is_meta: true,
      // Out-of-band provenance, verbatim from activation (never promoted).
      placement: a.placement,
      authority: a.authority,
      trust: a.trust,
      content_hash: a.content_hash,
      provenance_refs: a.provenance_refs,
      retention_state: a.retention_state,
      ordinal: a.ordinal,
    } as unknown as SemanticMessage;
    return message;
  });

  // 4. Bake the four-plane snapshot. The builder deep-copies, validates
  //    is_meta flags, checks registry alignment, and freezes — so this function
  //    does not duplicate that work.
  return buildSemanticRequestSnapshot({
    ...requestInput,
    meta_context: metaContext,
  });
}

// ===========================================================================
// DRC-2 Task 7 — Trusted Context Anchor (Core Orchestrator).
//
// 物理本质:Core Anchor 是确定性编排器,不是中央 Context Runtime (spec §8.1)。
// 它只做三件事:
//   1. 按 channel 分发到对应底层纯函数(activateProjectInstruction /
//      decideMemoryAdmission / decideMemoryUse)。
//   2. 把成功结果封进对应的 discriminated union 变体。
//   3. 把任何抛出转成结构化 failure(reason_codes),不 fallback 到另一 channel。
//
// 这个段 *不* 做的事 (INV-D5 / INV-D16 / §8.11):
//   - 不创建新的 trust / Authority / Placement / Retention / persistence / selection。
//   - 不把 project_instruction 改写为 auto_memory,反之亦然。
//   - 不让一个 channel 的 failure 升级到另一个 channel。
//   - 不让 Project instruction activation 产生 Memory admission。
//   - 不让 Memory admission 产生 Prompt placement。
//
// 规格来源:§8.1 / §8.2 / §8.11 / §8.12。
// ===========================================================================

/**
 * 封闭 channel 输入 — discriminated union。每个 channel 只携带它需要的 input,
 * 其余字段必须为 null。这样 TS 在编译期就排除了"project_instruction channel
 * 同时携带 memory_input"的形状,但本函数仍在运行期做一次守门(§8.12)。
 */
export type TrustedContextActivationInput =
  | {
      channel: 'project_instruction';
      project_instruction_input: ProjectInstructionActivationInput;
      memory_candidate: null;
      memory_admission_input: null;
      memory_use_input: null;
    }
  | {
      channel: 'auto_memory_admission';
      project_instruction_input: null;
      memory_candidate: null;
      memory_admission_input: MemoryAdmissionInput;
      memory_use_input: null;
    }
  | {
      channel: 'auto_memory_use';
      project_instruction_input: null;
      memory_candidate: null;
      memory_admission_input: null;
      memory_use_input: MemoryUseInput;
    };

/**
 * 封闭 channel 输出 — discriminated union。每个 kind 对应一个底层纯函数的成功产物,
 * failure 是兜底变体。变体之间互不携带对方的字段(INV-D5)。
 */
export type TrustedContextActivationOutcome =
  | { kind: 'meta_context_activation'; value: MetaContextActivation }
  | { kind: 'memory_admission_decision'; value: MemoryAdmissionDecision }
  | { kind: 'memory_use_decision'; value: MemoryUseDecision }
  | { kind: 'failure'; reason_codes: string[] };

/** 向后兼容别名 —— 计划文档使用的旧名,语义与 outcome 完全一致。 */
export type TrustedContextActivationResult = TrustedContextActivationOutcome;

/**
 * Core Anchor 的依赖。policy 注入而非全局查找,保持纯函数性。
 */
export interface TrustedContextDependencies {
  memory_admission_policy: MemoryAdmissionPolicy;
}

/**
 * 把底层抛出的 error 转成结构化 failure。reason_codes[0] 是 channel-specific 前缀,
 * 便于下游 programmatic 消费;后续元素携带原始诊断信息。
 *
 * 关键不变量 (INV-D16):失败只产生 failure 变体,**不会** fallback 到另一 channel,
 * 也**不会**铸造新的 trust/Authority/Placement 来"补救"。
 */
function toFailure(channelPrefix: string, error: unknown): Extract<TrustedContextActivationOutcome, { kind: 'failure' }> {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'unknown_error';
  return {
    kind: 'failure',
    reason_codes: [channelPrefix, message],
  };
}

/**
 * Core Anchor —— 把 CRC-3 已路由的 candidate 派发到对应 channel 的底层纯函数,
 * 然后把结果封进 discriminated union。
 *
 * 算法 (spec §8.2 / §8.11 / §8.12):
 *   1. Runtime channel 守门:
 *        a. channel 必须是封闭 set 之一,否则 → failure('activation.unknown_channel')。
 *        b. 每个 channel 的 input 字段必须匹配(非 null 的对应 channel 自身的 input,
 *           其余 input 字段必须为 null),否则 → failure('activation.channel_field_mismatch')。
 *   2. 按 channel 分发到底层纯函数:
 *        - 'project_instruction'     → activateProjectInstruction → meta_context_activation
 *        - 'auto_memory_admission'   → decideMemoryAdmission      → memory_admission_decision
 *        - 'auto_memory_use'         → decideMemoryUse            → memory_use_decision
 *      任一抛出 → failure(channel-specific 前缀 + error.message),不 fallback。
 *   3. 把结果直接封进对应变体 —— Core Anchor 不铸造新 trust/Authority/Placement/
 *      Retention/persistence/selection,也不重写底层 value。
 *
 * 不变量:
 *   - INV-D5:project_instruction 与 auto_memory 互不升格、复制、转换。
 *   - INV-D16:failure 不 fallback 到另一 channel,也不改变任何状态。
 *   - §8.11-4:Project instruction activation 不产生 Memory admission。
 *   - §8.11-5:Memory admission 不产生 Prompt placement。
 */
export function activateTrustedContext(
  input: TrustedContextActivationInput,
  dependencies: TrustedContextDependencies,
): TrustedContextActivationOutcome {
  // 1a. Runtime channel 守门。即便 TS 在编译期排除了未知 channel,运行期仍要验证
  //     (下游可能从 untyped 边界传入),不能信任 channel 字符串。
  const knownChannels: ReadonlySet<string> = new Set([
    'project_instruction',
    'auto_memory_admission',
    'auto_memory_use',
  ]);
  if (!knownChannels.has(input.channel)) {
    return {
      kind: 'failure',
      reason_codes: ['activation.unknown_channel'],
    };
  }

  // 1b. Field consistency 守门。每个 channel 只允许携带它自己的 input,其余必须为 null。
  //     这道守门是 INV-D5 的运行期防线 —— 阻止"project_instruction channel 夹带 memory input"
  //     这类跨 channel 走私。
  const fieldMismatch: boolean = (() => {
    switch (input.channel) {
      case 'project_instruction':
        return (
          input.project_instruction_input === null ||
          input.memory_admission_input !== null ||
          input.memory_use_input !== null
        );
      case 'auto_memory_admission':
        return (
          input.project_instruction_input !== null ||
          input.memory_admission_input === null ||
          input.memory_use_input !== null
        );
      case 'auto_memory_use':
        return (
          input.project_instruction_input !== null ||
          input.memory_admission_input !== null ||
          input.memory_use_input === null
        );
      default:
        return true;
    }
  })();
  if (fieldMismatch) {
    return {
      kind: 'failure',
      reason_codes: ['activation.channel_field_mismatch'],
    };
  }

  // 2. 按 channel 分发。任一抛出 → failure(channel-specific 前缀),不 fallback。
  //    narrow union via switch on channel (TS narrows input shape here).
  switch (input.channel) {
    case 'project_instruction': {
      try {
        const value = activateProjectInstruction(input.project_instruction_input);
        return { kind: 'meta_context_activation', value };
      } catch (error) {
        return toFailure('project_instruction.activation_failed', error);
      }
    }
    case 'auto_memory_admission': {
      try {
        const value = decideMemoryAdmission(
          input.memory_admission_input,
          dependencies.memory_admission_policy,
        );
        return { kind: 'memory_admission_decision', value };
      } catch (error) {
        return toFailure('memory_admission.activation_failed', error);
      }
    }
    case 'auto_memory_use': {
      try {
        const value = decideMemoryUse(input.memory_use_input);
        return { kind: 'memory_use_decision', value };
      } catch (error) {
        return toFailure('memory_use.activation_failed', error);
      }
    }
    default: {
      // exhaustive: TS 在此处已 narrow,但运行期仍兜底,以防 untyped 边界。
      return {
        kind: 'failure',
        reason_codes: ['activation.unknown_channel'],
      };
    }
  }
}
