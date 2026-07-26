/**
 * BRC-3 ContextSourceEnvelope & writer separation (spec §9.2 / §9.9).
 *
 * The envelope is the ONLY entry point for context material entering the agent.
 * It never carries content — only a `raw_content_ref` (a reference string).
 * Each envelope carries a `writer_kind` drawn from a CLOSED enum, and the
 * `(source_class, writer_kind)` pair MUST be one of the legal combinations in
 * the mapping table below. Authority, Trust, and Placement are explicit fields;
 * they are NEVER inferred from `source_ref` / `raw_content_ref` strings.
 *
 * Three unsafe source classes (tool_result, attachment, external_content) are
 * forced to `trust: 'untrusted'` regardless of caller input — this is the
 * single chokepoint that prevents a forged tool result or attachment from
 * masquerading as trusted context.
 */

import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';
import { sanitizeContextSource, type SanitizationDependencies } from './intake/sanitizer.js';
import {
  buildBoundedContextSource,
  type BoundedContextSource,
  type SourceBudgetPolicy,
} from './intake/source-budget.js';

// Re-export so callers can reach the budget builder & types from the intake
// facade without reaching into the sub-module path.
export { buildBoundedContextSource } from './intake/source-budget.js';
export type { BoundedContextSource, SourceBudgetPolicy } from './intake/source-budget.js';
export type { ContextSanitizationResult, SanitizationDependencies } from './intake/sanitizer.js';

// ---------------------------------------------------------------------------
// Closed enums. These are intentionally defined as frozen tuple types so that
// a smuggled `'super_instruction' as any` is rejected at runtime, not just at
// compile time.
// ---------------------------------------------------------------------------

export type ContextWriterKind =
  | 'user'
  | 'trusted_instruction_loader'
  | 'auto_memory_writer'
  | 'runtime_collector'
  | 'tool_executor'
  | 'external_ingress';

export type ContextSourceClass =
  | 'instruction_candidate'
  | 'auto_memory'
  | 'environment'
  | 'tool_result'
  | 'attachment'
  | 'external_content';

export type ContextTrust = 'trusted' | 'untrusted' | 'unknown';

const CONTEXT_WRITER_KINDS: readonly ContextWriterKind[] = [
  'user',
  'trusted_instruction_loader',
  'auto_memory_writer',
  'runtime_collector',
  'tool_executor',
  'external_ingress',
];

const CONTEXT_SOURCE_CLASSES: readonly ContextSourceClass[] = [
  'instruction_candidate',
  'auto_memory',
  'environment',
  'tool_result',
  'attachment',
  'external_content',
];

/**
 * Legal `(source_class, writer_kind)` mapping (spec §9.2 — CLOSED domain).
 *
 * Instruction and auto_memory do NOT share a writer: instruction_candidate is
 * written by user or trusted_instruction_loader only; auto_memory is written
 * exclusively by auto_memory_writer. This separation is what stops an
 * instruction-style loader from silently rewriting the agent's memory.
 */
const LEGAL_WRITERS_BY_SOURCE_CLASS: Readonly<
  Record<ContextSourceClass, readonly ContextWriterKind[]>
> = Object.freeze({
  instruction_candidate: Object.freeze<ContextWriterKind[]>(['user', 'trusted_instruction_loader']),
  auto_memory: Object.freeze<ContextWriterKind[]>(['auto_memory_writer']),
  environment: Object.freeze<ContextWriterKind[]>(['runtime_collector']),
  tool_result: Object.freeze<ContextWriterKind[]>(['tool_executor']),
  attachment: Object.freeze<ContextWriterKind[]>(['external_ingress']),
  external_content: Object.freeze<ContextWriterKind[]>(['external_ingress']),
});

/**
 * Source classes that are ALWAYS forced to `untrusted`, regardless of what the
 * caller passes. These are the three classes whose content originates outside
 * the agent's trust boundary (tool output, user-supplied attachments, and any
 * external ingress).
 */
const FORCED_UNTRUSTED_SOURCE_CLASSES: ReadonlySet<ContextSourceClass> = new Set([
  'tool_result',
  'attachment',
  'external_content',
]);

// ---------------------------------------------------------------------------
// Envelope shape.
// ---------------------------------------------------------------------------

export interface ContextSourceEnvelope {
  context_protocol_version: string;
  context_source_id: string;
  source_class: ContextSourceClass;
  source_ref: string;
  scope_ref: string;
  authority: string;
  trust: ContextTrust;
  freshness: {
    observed_at: string;
    expires_at: string | null;
  };
  requested_placement: string | null;
  retention: string;
  writer_kind: ContextWriterKind;
  raw_content_ref: string;
  provenance_refs: string[];
}

export interface CreateContextSourceEnvelopeInput {
  context_protocol_version: string;
  context_source_id: string;
  source_class: ContextSourceClass;
  source_ref: string;
  scope_ref: string;
  authority: string;
  trust: ContextTrust;
  freshness: {
    observed_at: string;
    expires_at: string | null;
  };
  requested_placement: string | null;
  retention: string;
  writer_kind: ContextWriterKind;
  raw_content_ref: string;
  provenance_refs: string[];
}

function isContextSourceClass(value: unknown): value is ContextSourceClass {
  return (CONTEXT_SOURCE_CLASSES as readonly string[]).includes(value as string);
}

function isContextWriterKind(value: unknown): value is ContextWriterKind {
  return (CONTEXT_WRITER_KINDS as readonly string[]).includes(value as string);
}

/**
 * Create a frozen `ContextSourceEnvelope`.
 *
 * Rules (spec §9.2 / §9.9):
 * 1. Identity fields validated non-empty via `requireIdentity`.
 * 2. `source_class` and `writer_kind` validated against the closed enums.
 * 3. The `(source_class, writer_kind)` pair validated against the mapping table.
 * 4. Unsafe source classes are forced to `trust: 'untrusted'`.
 * 5. `raw_content_ref` is just a string — no file read or content fetch happens.
 * 6. `provenance_refs` and `freshness` are deep-copied then frozen.
 * 7. The output has no `content` field.
 */
export function createContextSourceEnvelope(
  input: CreateContextSourceEnvelopeInput,
): ContextSourceEnvelope {
  // 1. Identity validation. None of these strings carry authority or trust —
  //    they are opaque identifiers that must be set explicitly by the caller.
  requireIdentity(input.context_protocol_version, 'context_protocol_version');
  requireIdentity(input.context_source_id, 'context_source_id');
  requireIdentity(input.source_ref, 'source_ref');
  requireIdentity(input.scope_ref, 'scope_ref');
  requireIdentity(input.authority, 'authority');
  requireIdentity(input.retention, 'retention');
  requireIdentity(input.raw_content_ref, 'raw_content_ref');

  // 2. Closed-enum validation. Reject smuggled strings.
  if (!isContextSourceClass(input.source_class)) {
    throw new Error(
      `source_class must be one of ${CONTEXT_SOURCE_CLASSES.join(', ')}, got: ${String(input.source_class)}`,
    );
  }
  if (!isContextWriterKind(input.writer_kind)) {
    throw new Error(
      `writer_kind must be one of ${CONTEXT_WRITER_KINDS.join(', ')}, got: ${String(input.writer_kind)}`,
    );
  }

  // 3. Writer-separation check. The error message names the offending
  //    writer_kind so callers can diagnose a misconfigured loader. For the
  //    auto_memory + trusted_instruction_loader case the plan requires the
  //    message to contain `auto_memory_writer` (the only legal writer for
  //    that source_class), so we include both the violating and the legal
  //    writer in the message.
  const legalWriters = LEGAL_WRITERS_BY_SOURCE_CLASS[input.source_class];
  if (!(legalWriters as readonly string[]).includes(input.writer_kind)) {
    throw new Error(
      `source_class "${input.source_class}" must be written by ${legalWriters.join(' or ')} ` +
        `(got writer_kind "${input.writer_kind}"); ` +
        `auto_memory_writer is reserved for auto_memory and must not be shared with instruction loaders`,
    );
  }

  // 4. Force trust downgrade for the three unsafe source classes.
  const trust: ContextTrust = FORCED_UNTRUSTED_SOURCE_CLASSES.has(input.source_class)
    ? 'untrusted'
    : input.trust;

  // 5/6/7. Defensive copies, then freeze. raw_content_ref is a string — it is
  //        never dereferenced here.
  const envelope: ContextSourceEnvelope = {
    context_protocol_version: input.context_protocol_version,
    context_source_id: input.context_source_id,
    source_class: input.source_class,
    source_ref: input.source_ref,
    scope_ref: input.scope_ref,
    authority: input.authority,
    trust,
    freshness: {
      observed_at: input.freshness.observed_at,
      expires_at: input.freshness.expires_at,
    },
    requested_placement: input.requested_placement,
    retention: input.retention,
    writer_kind: input.writer_kind,
    raw_content_ref: input.raw_content_ref,
    provenance_refs: [...input.provenance_refs],
  };

  return freezeSnapshot(envelope) as ContextSourceEnvelope;
}

// ---------------------------------------------------------------------------
// runContextIntake — fixed intake order pipeline (spec §9.8).
//
// The intake pipeline runs in a FIXED order:
//   identity → normalization → sanitization → writer separation
//   → source budget → provenance → bounded output
//
// For `runContextIntake`:
//   1. identity: the envelope itself (already created by
//      createContextSourceEnvelope, which validated identity, writer-kind,
//      and the closed source-class enum).
//   2. normalization: a no-op here beyond what the envelope already carries
//      (identity/freshness). Environment normalization is a separate Task 6
//      path (normalizeEnvironmentSnapshot) and is NOT invoked from
//      runContextIntake.
//   3. sanitization: `sanitizeContextSource(envelope, deps.sanitization)`.
//   4. writer separation: already enforced by createContextSourceEnvelope (the
//      envelope's writer_kind matches its source_class per the closed table).
//   5. source budget: if sanitization rejected → throw (no budget bypass).
//      Otherwise read the raw content via `deps.sanitization.readContent()`
//      and feed it to buildBoundedContextSource. The content read here is the
//      same raw content the sanitizer would have read — both call the same
//      caller-supplied hook.
//   6. provenance: baked into the bounded source by buildBoundedContextSource
//      via formatProvenanceLabel.
//   7. bounded output: the returned BoundedContextSource.
//
// A bounded source is NOT auto-injected into the Prompt (placement is Wave C
// M-012).
// ---------------------------------------------------------------------------

export interface ContextIntakeDependencies {
  sanitization: SanitizationDependencies;
  budget_policy: SourceBudgetPolicy;
}

/**
 * Run the fixed-order context intake pipeline and return a frozen
 * `BoundedContextSource`. Throws if sanitization rejected the source, if the
 * budget policy is missing identity fields, or if the budget overflowed with
 * `overflow_behavior: 'reject'`. There is no infinite-budget fallback.
 */
export async function runContextIntake(
  envelope: ContextSourceEnvelope,
  dependencies: ContextIntakeDependencies,
): Promise<BoundedContextSource> {
  // 3. Sanitization.
  const sanitization = await sanitizeContextSource(envelope, dependencies.sanitization);

  // 5. Source budget. Sanitizer rejection ⇒ throw (do not proceed to budget).
  if (sanitization.status === 'rejected') {
    throw new Error(
      `runContextIntake: sanitization rejected source "${envelope.context_source_id}" ` +
        `(findings: ${sanitization.finding_codes.join(', ') || '<none>'}) — ` +
        `cannot proceed to source budget`,
    );
  }

  // Read the same raw content the sanitizer would have read (both call the
  // same caller-supplied hook). If read fails now, propagate — there is no
  // fallback content.
  const content = await dependencies.sanitization.readContent();

  // buildBoundedContextSource handles identity checks, per-source-class
  // matching, overflow behavior, and provenance labeling. A missing policy,
  // a sanitizer/source mismatch, or a rejected sanitization all throw there
  // too (defense in depth).
  return buildBoundedContextSource({
    envelope,
    sanitization,
    content,
    policy: dependencies.budget_policy,
  });
}
