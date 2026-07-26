/**
 * M-011 Provenance labeling (spec §9.7).
 *
 * The provenance label is a deterministic, human-readable string derived
 * EXCLUSIVELY from envelope metadata fields. It is NEVER influenced by the
 * raw or sanitized content. Even if `envelope.source_ref` contains strings
 * like `'SYSTEM'`, `'OVERRIDE'`, or `'trusted'`, those tokens have NO effect
 * on the authority/trust portions of the label — only the explicit metadata
 * fields (`source_class`, `scope_ref`, `authority`, `trust`,
 * `freshness.observed_at`) appear.
 *
 * `source_ref` is included verbatim because the envelope only ever carries an
 * opaque reference string, never raw content. The "safe display" concern from
 * the spec (don't leak raw content) is therefore satisfied by construction:
 * the sanitizer never returns raw content, and the envelope never carries it.
 *
 * Format (frozen — callers may match against this exact shape):
 *   `[<source_class> scope=<scope_ref> authority=<authority> trust=<trust> observed_at=<observed_at> source_ref=<source_ref>]`
 * followed by, when `truncated` is true, a single trailing ` [truncated]`.
 *
 * Example:
 *   [instruction_candidate scope=project authority=user trust=trusted observed_at=2026-07-26T00:00:00.000Z source_ref=file:///x.md]
 *   [instruction_candidate ... ] [truncated]
 */

import type { ContextSourceEnvelope } from '../intake.js';

/**
 * Format a provenance label for a context source. The label is built only
 * from envelope metadata fields; `truncated` controls whether a truncation
 * marker is appended.
 *
 * @param envelope The source envelope (already identity-validated by
 *   createContextSourceEnvelope). Its `source_ref` is included verbatim as an
 *   opaque id — it is NOT parsed for authority/trust tokens.
 * @param truncated Whether the bounded source was truncated; if true, the
 *   label gets a ` [truncated]` suffix.
 */
export function formatProvenanceLabel(
  envelope: ContextSourceEnvelope,
  truncated: boolean,
): string {
  const base =
    `[${envelope.source_class} ` +
    `scope=${envelope.scope_ref} ` +
    `authority=${envelope.authority} ` +
    `trust=${envelope.trust} ` +
    `observed_at=${envelope.freshness.observed_at} ` +
    `source_ref=${envelope.source_ref}]`;

  return truncated ? `${base} [truncated]` : base;
}
