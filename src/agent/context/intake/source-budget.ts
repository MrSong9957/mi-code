/**
 * M-050 / M-011 Source size guard (spec §9.6).
 *
 * The source budget is the deterministic size guard applied to sanitized
 * context content AFTER the sanitizer has accepted/transformed it and BEFORE
 * it can be considered a `BoundedContextSource`. Truncation is deterministic
 * and explicit: any truncated result MUST carry overflow metadata
 * (`truncated=true` ⇒ `overflow_ref` non-null). A missing policy, a sanitizer
 * rejection, or a missing overflow marker on a truncated result is rejected
 * (thrown) — there is NO infinite-budget fallback.
 *
 * Non-negotiable rules (spec §9.6):
 *
 * 1. Budget is per-source-class. `policy.source_class` MUST equal the
 *    envelope's `source_class`; mismatch throws.
 * 2. Sanitization must be for THIS source (`sanitization.context_source_id`
 *    === `envelope.context_source_id`) and must NOT be `rejected`. A rejected
 *    sanitization result cannot be rescued by the budget.
 * 3. `overflow_behavior: 'reject'` ⇒ throw on overflow (do NOT truncate).
 * 4. `overflow_behavior: 'deterministic_truncate'` ⇒ truncate at line
 *    boundaries first (if `max_lines` set), then at byte boundaries without
 *    splitting a multi-byte UTF-8 character. `truncated=true` and a
 *    deterministic `overflow_ref`.
 * 5. `truncated=true` ALWAYS carries `overflow_ref`. There is no path that
 *    sets `truncated=true` without `overflow_ref`.
 *
 * A bounded source is NOT auto-injected into the Prompt. Placement is decided
 * in Wave C (M-012).
 */

import { Buffer } from 'node:buffer';
import { freezeSnapshot, requireIdentity } from '../../contracts/identities.js';
import type { ContextSourceEnvelope } from '../intake.js';
import type { ContextSanitizationResult } from './sanitizer.js';
import { formatProvenanceLabel } from './provenance.js';

// ---------------------------------------------------------------------------
// Types (spec §9.6).
// ---------------------------------------------------------------------------

export interface SourceBudgetPolicy {
  source_class: string;
  max_bytes: number;
  max_lines: number | null;
  overflow_behavior: 'reject' | 'deterministic_truncate';
  policy_id: string;
  policy_version: string;
}

export interface BoundedContextSource {
  context_source_id: string;
  sanitization_result_ref: string;
  budget_policy_ref: string;
  content_ref: string;
  bytes_included: number;
  lines_included: number | null;
  truncated: boolean;
  overflow_ref: string | null;
  provenance_label: string;
}

export interface BuildBoundedContextSourceInput {
  envelope: ContextSourceEnvelope;
  sanitization: ContextSanitizationResult;
  content: string;
  policy: SourceBudgetPolicy;
}

// ---------------------------------------------------------------------------
// buildBoundedContextSource
// ---------------------------------------------------------------------------

/**
 * Apply a `SourceBudgetPolicy` to sanitized content and produce a frozen
 * `BoundedContextSource`. See module docstring for the non-negotiable rules.
 *
 * Truncation algorithm (deterministic):
 *   1. If `max_lines` is set and `lines > max_lines`: keep the first
 *      `max_lines` complete lines. The truncation point is AFTER the
 *      `max_lines`-th newline, NOT including any partial next line.
 *   2. After line truncation (or if `max_lines` is null): if bytes still
 *      exceed `max_bytes`, walk character-by-character from the start,
 *      accumulating until adding the next character would exceed `max_bytes`.
 *      This guarantees the result is a valid UTF-8 prefix (no multi-byte char
 *      is split) because we only ever append whole characters.
 *
 * `lines_included` is always computed (even when `max_lines` is null) and
 * reflects the actual line count of the (possibly truncated) content. This
 * keeps the output deterministic and observable for downstream budget
 * accounting.
 */
export function buildBoundedContextSource(
  input: BuildBoundedContextSourceInput,
): BoundedContextSource {
  const { envelope, sanitization, content, policy } = input;

  // 1. Identity validation. None of these carry authority.
  requireIdentity(envelope.context_source_id, 'context_source_id');
  requireIdentity(policy.policy_id, 'policy_id');
  requireIdentity(policy.policy_version, 'policy_version');

  // 2. Per-source-class budget: mismatch throws.
  if (policy.source_class !== envelope.source_class) {
    throw new Error(
      `source budget source_class mismatch: policy has "${policy.source_class}", ` +
        `envelope has "${envelope.source_class}" — budget is per-source-class`,
    );
  }

  // 3. Sanitization must be for THIS source.
  if (sanitization.context_source_id !== envelope.context_source_id) {
    throw new Error(
      `sanitization was performed for "${sanitization.context_source_id}", ` +
        `cannot be applied to envelope "${envelope.context_source_id}"`,
    );
  }

  // 4. Sanitizer rejection cannot be bypassed by the budget.
  if (sanitization.status === 'rejected') {
    throw new Error(
      `source budget cannot be applied: sanitization rejected source ` +
        `"${envelope.context_source_id}" (findings: ${sanitization.finding_codes.join(', ') || '<none>'})`,
    );
  }

  // 5/6. Byte and line counts.
  const totalBytes = Buffer.byteLength(content, 'utf8');
  const totalLines = countLines(content);

  const maxBytes = policy.max_bytes;
  const maxLines = policy.max_lines;

  const bytesOverflow = totalBytes > maxBytes;
  const linesOverflow = maxLines !== null && totalLines > maxLines;
  const overflow = bytesOverflow || linesOverflow;

  // 7. No overflow → use content as-is.
  if (!overflow) {
    return freezeBoundedSource({
      context_source_id: envelope.context_source_id,
      sanitization_result_ref: `${sanitization.sanitization_policy_id}:${sanitization.sanitization_policy_version}`,
      budget_policy_ref: `${policy.policy_id}:${policy.policy_version}`,
      content_ref:
        sanitization.sanitized_content_ref ?? `content:${envelope.context_source_id}`,
      bytes_included: totalBytes,
      lines_included: totalLines,
      truncated: false,
      overflow_ref: null,
      provenance_label: formatProvenanceLabel(envelope, false),
    });
  }

  // 8. Overflow + reject → throw (do not truncate).
  if (policy.overflow_behavior === 'reject') {
    throw new Error(
      `source budget rejected: content for "${envelope.context_source_id}" ` +
        `exceeds budget (bytes ${totalBytes} > ${maxBytes}` +
        `${maxLines !== null ? `, lines ${totalLines} > ${maxLines}` : ''}) ` +
        `and policy overflow_behavior is "reject"`,
    );
  }

  // 9. Overflow + deterministic_truncate.
  // 9a. Line-boundary truncation first.
  let truncatedContent = content;
  if (maxLines !== null && totalLines > maxLines) {
    truncatedContent = truncateToLineBoundary(content, maxLines);
  }

  // 9b. Byte-boundary truncation if still over max_bytes. Walk whole
  //     characters so we never split a multi-byte UTF-8 sequence.
  if (Buffer.byteLength(truncatedContent, 'utf8') > maxBytes) {
    truncatedContent = truncateToByteBoundary(truncatedContent, maxBytes);
  }

  const bytesIncluded = Buffer.byteLength(truncatedContent, 'utf8');
  const linesIncluded = countLines(truncatedContent);

  // 9c. Deterministic overflow metadata — `truncated=true` ⇒ `overflow_ref`
  //     MUST be set. There is no path that sets truncated without overflow_ref.
  return freezeBoundedSource({
    context_source_id: envelope.context_source_id,
    sanitization_result_ref: `${sanitization.sanitization_policy_id}:${sanitization.sanitization_policy_version}`,
    budget_policy_ref: `${policy.policy_id}:${policy.policy_version}`,
    content_ref:
      sanitization.sanitized_content_ref ?? `content:${envelope.context_source_id}`,
    bytes_included: bytesIncluded,
    lines_included: linesIncluded,
    truncated: true,
    overflow_ref: `overflow:${envelope.context_source_id}`,
    provenance_label: formatProvenanceLabel(envelope, true),
  });
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Count complete lines in `content`. A line is a maximal substring terminated
 * by `\n` (the terminator is included in the line). A final line WITHOUT a
 * trailing `\n` still counts as one line. Empty string counts as 0 lines.
 *
 * Examples:
 *   ''            → 0
 *   'one'         → 1   (one unterminated line)
 *   'one\ntwo'    → 2   (one terminated + one unterminated)
 *   'one\ntwo\n'  → 2   (two terminated lines; the trailing \n does NOT add a phantom empty line)
 *   'one\n\n'     → 2
 *
 * This is the same convention the truncator uses: keeping the first `maxLines`
 * lines means keeping `maxLines` newline-terminated segments (so the result
 * ends in `\n` and `countLines` returns exactly `maxLines`).
 */
function countLines(content: string): number {
  if (content === '') {
    return 0;
  }
  // Count newlines. If the content does NOT end with a newline, there is one
  // extra (unterminated) line; if it DOES end with a newline, every line is
  // terminated and the count is exactly the newline count.
  let newlines = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0a /* \n */) {
      newlines++;
    }
  }
  return content.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * Keep the first `maxLines` complete lines of `content`. A "complete line"
 * includes its trailing newline if present; truncation happens immediately
 * after the `maxLines`-th newline (or, if there is no trailing newline on the
 * last kept line, after that line's content). No partial next line is kept.
 *
 * Empty content always returns empty. `maxLines <= 0` returns empty string.
 */
function truncateToLineBoundary(content: string, maxLines: number): string {
  if (content === '' || maxLines <= 0) {
    return '';
  }
  let linesConsumed = 0;
  let cutIndex = -1;
  // Walk through newlines; each newline consumes one line.
  for (let i = 0; i < content.length && linesConsumed < maxLines; i++) {
    if (content.charCodeAt(i) === 0x0a /* \n */) {
      linesConsumed++;
      // Cut AFTER this newline so the kept prefix includes the line terminator.
      cutIndex = i + 1;
    }
  }
  // If we didn't see maxLines newlines, the whole content is fewer than
  // maxLines lines — caller shouldn't have called us, but be safe.
  if (linesConsumed < maxLines) {
    // We did not hit the line cap via newlines; the remaining text is the
    // (maxLines - linesConsumed)-th line and should be kept. So return content
    // unchanged.
    return content;
  }
  // linesConsumed === maxLines. cutIndex points just after the maxLines-th
  // newline. The content up to cutIndex contains exactly maxLines lines (each
  // terminated by \n).
  return content.slice(0, cutIndex);
}

/**
 * Truncate `content` to the largest prefix whose UTF-8 byte length is
 * `<= maxBytes`, without splitting a multi-byte character. This walks
 * character-by-character (using string iteration which respects UTF-16 code
 * units, but for supplementary-plane characters we use code-point-aware
 * iteration via `Array.from`).
 *
 * The returned string is always a valid UTF-8 prefix of the input.
 */
function truncateToByteBoundary(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return content;
  }
  // Code-point-aware iteration so supplementary-plane characters (4-byte
  // UTF-8) are never split.
  const codePoints = Array.from(content);
  let result = '';
  for (const cp of codePoints) {
    const candidate = result + cp;
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) {
      break;
    }
    result = candidate;
  }
  return result;
}

function freezeBoundedSource(source: BoundedContextSource): BoundedContextSource {
  return freezeSnapshot(source) as BoundedContextSource;
}
