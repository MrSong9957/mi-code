/**
 * M-040 Deterministic Context Sanitization (spec §9.4 / BRC-3).
 *
 * The sanitizer is the single deterministic gate between raw context content
 * and the rest of the agent. It reads the raw content via a caller-supplied
 * `readContent` hook (the caller controls all I/O), inspects it for findings
 * via a caller-supplied deterministic scanner, optionally transforms it, and
 * optionally stores the sanitized result. It then returns a frozen
 * `ContextSanitizationResult` describing what happened — without ever leaking
 * raw content or secret material into the result.
 *
 * Non-negotiable rules (spec §9.4):
 *
 * 1. Fail closed. Any error in `readContent` / `inspect` / `transform` causes
 *    a `rejected` result. The sanitizer NEVER returns raw content as a
 *    fallback. If a step threw, the result carries NO content field at all.
 * 2. Deterministic only. The sanitizer MUST NOT invoke a model as its
 *    `inspect`. Providing a deterministic inspector is the caller's
 *    responsibility; this module never performs a model call.
 * 3. Model output cannot override a deterministic rejection. There is no hook
 *    here for a model "soft warning" or veto; M-069 lives in Wave C.
 * 4. Trust is never promoted. The sanitizer does not modify the input
 *    envelope, and `ContextSanitizationResult` carries NO `trust` field —
 *    trust stays on the envelope and is decided by `createContextSourceEnvelope`
 *    (BRC-3 / Wave B Task 5).
 * 5. New trusted structured data can only be minted by `extractTrustedStructure`
 *    below, which requires ALL THREE gates of the Wave A frozen trusted-
 *    extraction gate to be `true`. The three-gate is the caller's policy
 *    decision; the source envelope's existing `trust` label is NOT consulted
 *    and NOT mutated.
 * 6. The sanitizer does not decide final Authority or Placement (Wave C M-012).
 *
 * ToolResultEnvelope cannot be promoted to trusted: `createContextSourceEnvelope`
 * already forces the three unsafe source classes (`tool_result`, `attachment`,
 * `external_content`) to `trust: 'untrusted'`, and this module never changes
 * that label.
 */

import { freezeSnapshot, requireIdentity } from '../../contracts/identities.js';
import type { ContextSourceEnvelope } from '../intake.js';

// ---------------------------------------------------------------------------
// Result / dependency types (spec §9.4).
// ---------------------------------------------------------------------------

export interface ContextSanitizationResult {
  context_source_id: string;
  sanitization_policy_id: string;
  sanitization_policy_version: string;
  status: 'accepted' | 'transformed' | 'rejected';
  transformation_codes: string[];
  finding_codes: string[];
  sanitized_content_ref: string | null;
}

export interface SanitizationPolicyIdentity {
  policy_id: string;
  policy_version: string;
}

export interface SanitizationDependencies {
  policy_id: string;
  policy_version: string;
  /** Read the raw content. Caller controls I/O. Returns the content string. */
  readContent: () => Promise<string>;
  /**
   * Inspect content for findings (e.g. 'secret.api_key', 'path.escape').
   *
   * MUST be deterministic. MUST NOT be a model call — providing a deterministic
   * inspector is the caller's responsibility. The sanitizer enforces fail-
   * closed on any thrown error from this hook but does NOT verify its
   * determinism at runtime.
   */
  inspect: (content: string) => string[] | Promise<string[]>;
  /**
   * Optional: apply deterministic transformations (e.g. redact). Returns the
   * transformed content and a list of transformation codes. If omitted, no
   * transformation occurs.
   */
  transform?: (
    content: string,
  ) => { content: string; codes: string[] } | Promise<{ content: string; codes: string[] }>;
  /**
   * Optional: store the sanitized content and return a content_ref string. If
   * omitted and status is accepted/transformed, `sanitized_content_ref` is
   * `null`.
   */
  store?: (content: string) => Promise<string>;
}

export interface TrustedStructuredContext {
  context_source_id: string;
  trusted_extraction_policy_id: string;
  trusted: true;
  schema_id: string;
  /** The structured data itself (opaque to the sanitizer — caller decides shape). */
  data: unknown;
}

export interface TrustedExtractionGate {
  trusted_source_policy: boolean;
  schema_valid: boolean;
  deterministic_loader: boolean;
}

/**
 * Identity of the Wave A frozen three-gate trusted-extraction policy. This is
 * the ONLY policy that can mint new trusted structured data. Callers cannot
 * override it — the gate fields are the caller's per-call policy decision, but
 * the policy *identity* is fixed.
 */
const TRUSTED_EXTRACTION_POLICY_ID = 'wave-a-frozen-three-gate';

// ---------------------------------------------------------------------------
// sanitizeContextSource
// ---------------------------------------------------------------------------

/**
 * Deterministically sanitize a context source's raw content.
 *
 * Returns a frozen `ContextSanitizationResult`. The result NEVER carries raw
 * content or secret material — only codes (finding_codes / transformation_codes)
 * and an optional sanitized_content_ref produced by the caller's `store` hook.
 *
 * The input `envelope` is NEVER mutated. The result carries NO `trust` field;
 * trust stays on the envelope (BRC-3).
 */
export async function sanitizeContextSource(
  envelope: ContextSourceEnvelope,
  dependencies: SanitizationDependencies,
): Promise<ContextSanitizationResult> {
  // Validate policy identity up front. A missing/blank policy id is a
  // protocol error — throw rather than silently producing a result.
  requireIdentity(dependencies.policy_id, 'policy_id');
  requireIdentity(dependencies.policy_version, 'policy_version');

  const context_source_id = envelope.context_source_id;

  // 1. Read raw content. Caller controls I/O. On failure → reject with
  //    read.failure. The result carries no content field at all.
  let content: string;
  try {
    content = await dependencies.readContent();
  } catch {
    return freezeResult({
      context_source_id,
      sanitization_policy_id: dependencies.policy_id,
      sanitization_policy_version: dependencies.policy_version,
      status: 'rejected',
      transformation_codes: [],
      finding_codes: ['read.failure'],
      sanitized_content_ref: null,
    });
  }

  // 2. Inspect for findings. On failure → reject with inspect.error. The
  //    result MUST NOT contain the raw content or secret (no `content` field
  //    is ever set on the result object).
  let findings: string[];
  try {
    findings = await dependencies.inspect(content);
  } catch {
    return freezeResult({
      context_source_id,
      sanitization_policy_id: dependencies.policy_id,
      sanitization_policy_version: dependencies.policy_version,
      status: 'rejected',
      transformation_codes: [],
      finding_codes: ['inspect.error'],
      sanitized_content_ref: null,
    });
  }

  // 3. Findings block acceptance unless a transform path explicitly handles
  //    them. There is no implicit transform-on-finding: findings → reject.
  if (findings.length > 0) {
    return freezeResult({
      context_source_id,
      sanitization_policy_id: dependencies.policy_id,
      sanitization_policy_version: dependencies.policy_version,
      status: 'rejected',
      transformation_codes: [],
      finding_codes: [...findings],
      sanitized_content_ref: null,
    });
  }

  // 4. No findings. If a transform is provided, apply it (fail-closed on
  //    error), then store the transformed content.
  if (dependencies.transform) {
    let transformed: { content: string; codes: string[] };
    try {
      transformed = await dependencies.transform(content);
    } catch {
      return freezeResult({
        context_source_id,
        sanitization_policy_id: dependencies.policy_id,
        sanitization_policy_version: dependencies.policy_version,
        status: 'rejected',
        transformation_codes: [],
        finding_codes: ['transform.error'],
        sanitized_content_ref: null,
      });
    }

    let sanitized_content_ref: string | null = null;
    if (dependencies.store) {
      // Store is part of the accepted/transformed path; if it throws we treat
      // it as a sanitizer failure and reject (fail closed) — we cannot return
      // a sanitized_content_ref, and we MUST NOT fall back to returning the
      // transformed content inline.
      try {
        sanitized_content_ref = await dependencies.store(transformed.content);
      } catch {
        return freezeResult({
          context_source_id,
          sanitization_policy_id: dependencies.policy_id,
          sanitization_policy_version: dependencies.policy_version,
          status: 'rejected',
          transformation_codes: [],
          finding_codes: ['store.error'],
          sanitized_content_ref: null,
        });
      }
    }

    return freezeResult({
      context_source_id,
      sanitization_policy_id: dependencies.policy_id,
      sanitization_policy_version: dependencies.policy_version,
      status: 'transformed',
      transformation_codes: [...transformed.codes],
      finding_codes: [],
      sanitized_content_ref,
    });
  }

  // 5. No findings, no transform → accepted. Store original content if store
  //    is provided (fail closed on store error).
  let sanitized_content_ref: string | null = null;
  if (dependencies.store) {
    try {
      sanitized_content_ref = await dependencies.store(content);
    } catch {
      return freezeResult({
        context_source_id,
        sanitization_policy_id: dependencies.policy_id,
        sanitization_policy_version: dependencies.policy_version,
        status: 'rejected',
        transformation_codes: [],
        finding_codes: ['store.error'],
        sanitized_content_ref: null,
      });
    }
  }

  return freezeResult({
    context_source_id,
    sanitization_policy_id: dependencies.policy_id,
    sanitization_policy_version: dependencies.policy_version,
    status: 'accepted',
    transformation_codes: [],
    finding_codes: [],
    sanitized_content_ref,
  });
}

// ---------------------------------------------------------------------------
// extractTrustedStructure — the Wave A frozen three-gate.
// ---------------------------------------------------------------------------

/**
 * Mint a new `TrustedStructuredContext` from a context source.
 *
 * This is the ONLY way to produce trusted structured data, and it requires
 * ALL THREE gates to be `true`:
 *   - `trusted_source_policy`: the caller's policy decision that this source
 *     is eligible for trusted extraction (callers SHOULD set this to `false`
 *     for any envelope whose `trust` is `untrusted`, e.g. tool_result /
 *     attachment / external_content).
 *   - `schema_valid`: the structured `data` validates against `schemaId`.
 *   - `deterministic_loader`: the loader that produced `data` is deterministic
 *     (no model in the loop).
 *
 * If any gate is `false`, this function THROWS — it never returns an untrusted
 * fallback. The source envelope is NOT mutated: its existing `trust` field is
 * neither consulted nor changed. The gate is the authority here.
 *
 * The returned `TrustedStructuredContext.trusted` is always `true` because the
 * type is only constructable via this gate.
 */
export function extractTrustedStructure(
  source: ContextSourceEnvelope,
  gate: TrustedExtractionGate,
  data: unknown,
  schemaId: string,
): TrustedStructuredContext {
  if (!gate.trusted_source_policy) {
    throw new Error(
      'extractTrustedStructure rejected: trusted_source_policy gate is false — ' +
        'source is not eligible for trusted extraction',
    );
  }
  if (!gate.schema_valid) {
    throw new Error(
      'extractTrustedStructure rejected: schema_valid gate is false — ' +
        'data does not validate against schema',
    );
  }
  if (!gate.deterministic_loader) {
    throw new Error(
      'extractTrustedStructure rejected: deterministic_loader gate is false — ' +
        'data was not produced by a deterministic loader',
    );
  }

  requireIdentity(schemaId, 'schema_id');

  const trusted: TrustedStructuredContext = {
    context_source_id: source.context_source_id,
    trusted_extraction_policy_id: TRUSTED_EXTRACTION_POLICY_ID,
    trusted: true,
    schema_id: schemaId,
    // Defensive copy of the data is the caller's concern; we freeze what we
    // are given in place (consistent with freezeSnapshot semantics) so the
    // returned TrustedStructuredContext is immutable. Callers that need to
    // keep a mutable copy should deep-clone before calling.
    data,
  };

  return freezeSnapshot(trusted) as TrustedStructuredContext;
}

// ---------------------------------------------------------------------------
// Internal helper.
// ---------------------------------------------------------------------------

/**
 * Freeze a sanitization result (object + its array fields) and return it.
 * `freezeSnapshot` already recurses, so this is mostly a thin wrapper for
 * readability at the call sites.
 */
function freezeResult(result: ContextSanitizationResult): ContextSanitizationResult {
  return freezeSnapshot(result) as ContextSanitizationResult;
}
