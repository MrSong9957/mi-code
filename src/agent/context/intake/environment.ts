/**
 * BRC-3 Environment normalization (spec §9.3).
 *
 * The NormalizedEnvironmentSnapshot is the ONLY surface by which collected
 * environment values reach the Prompt. Three hard rules hold here:
 *
 * 1. NEVER receive `process.env` directly. The caller passes an explicit
 *    `collected_fields` map (an allowlisted projection of whatever the caller
 *    chose to observe). This module does not import or read `process.env`.
 *
 * 2. Parent environment is NOT copied into the snapshot. There is no ambient
 *    inheritance — only what the caller explicitly enumerates in
 *    `collected_fields`, and only the subset that survives the allowlist AND
 *    privacy policy, ends up in `allowed_fields`.
 *
 * 3. Unknown fields are OMITTED with a code, never injected as a guess.
 *    Privacy may only DELETE fields, never restore a policy-forbidden one
 *    (privacy is checked BEFORE allowlist inclusion, so a privacy-omitted
 *    field is dropped even if it is also allowlisted).
 *
 * Resume freshness is recorded via `observed_at` only; re-validation of
 * volatile fields belongs to later lifecycle wiring (Wave E).
 */

import { normalize, resolve } from 'node:path';
import { freezeSnapshot, requireIdentity } from '../../contracts/identities.js';

// ---------------------------------------------------------------------------
// Public types — frozen per spec §9.3.
// ---------------------------------------------------------------------------

export interface NormalizedEnvironmentSnapshot {
  environment_snapshot_id: string;
  platform_family: string;
  shell_family: string | null;
  workspace_root: string;
  working_directory: string;
  repository_present: boolean;
  allowed_fields: Readonly<Record<string, string | boolean | number>>;
  omitted_field_codes: string[];
  observed_at: string;
}

export interface EnvironmentCollectionInput {
  environment_snapshot_id: string;
  platform_family: string;
  shell_family: string | null;
  workspace_root: string;
  working_directory: string;
  repository_present: boolean;
  observed_at: string;
  collected_fields: Record<string, string | boolean | number>;
}

export interface EnvironmentAllowlistPolicy {
  allowed_fields: ReadonlySet<string>;
  privacy_omitted_fields: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Path canonicalization.
//
// Choice (documented): we apply `resolve` then `normalize`.
//   - `resolve(p)` makes `p` absolute relative to `process.cwd()` if it isn't
//     already, mirroring how the agent itself would interpret a relative path.
//     We do NOT call `process.cwd()` ourselves; resolve() handles it. The
//     caller already provides a path; if it is relative it is the caller's
//     intent that it be interpreted against the current working directory.
//   - `normalize` collapses `.` / `..` segments.
// Already-absolute inputs round-trip unchanged (modulo `..` collapse).
// We do NOT reject relative inputs: spec §9.3 explicitly allows resolve-based
// canonicalization.
// ---------------------------------------------------------------------------

function canonicalizePath(p: string): string {
  return normalize(resolve(p));
}

// ---------------------------------------------------------------------------
// Field bucketing.
//
// Iteration order of `collected_fields` is whatever JS gives us for an object
// (insertion order for string keys); we therefore sort `omitted_field_codes`
// explicitly to make output deterministic regardless of input order.
//
// Bucket order (per-field, applied in this exact precedence):
//   1. privacy_omitted_fields        → drop, code `field.privacy_omitted.<k>`
//   2. NOT in allowed_fields         → drop, code `field.not_allowlisted.<k>`
//   3. otherwise                     → include in `allowed_fields`
// Privacy is checked FIRST so that a privacy-forbidden field is never restored
// by also being in the allowlist.
// ---------------------------------------------------------------------------

function bucketCollectedFields(
  collected: Record<string, string | boolean | number>,
  policy: EnvironmentAllowlistPolicy,
): { allowed: Record<string, string | boolean | number>; omitted: string[] } {
  const allowed: Record<string, string | boolean | number> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(collected)) {
    if (policy.privacy_omitted_fields.has(key)) {
      omitted.push(`field.privacy_omitted.${key}`);
      continue;
    }
    if (!policy.allowed_fields.has(key)) {
      omitted.push(`field.not_allowlisted.${key}`);
      continue;
    }
    // Copy the value verbatim. Falsy values (false, 0, '') are legitimate
    // observed values and MUST be preserved — they are not "missing".
    allowed[key] = value;
  }
  omitted.sort();
  return { allowed, omitted };
}

/**
 * Normalize a collected environment observation against an allowlist policy.
 *
 * Returns a deep-frozen NormalizedEnvironmentSnapshot. The snapshot contains:
 *   - canonicalized core fields (paths resolved+normalized),
 *   - only allowlisted, non-privacy-omitted collected fields,
 *   - alphabetically sorted omitted_field_codes for the rest.
 *
 * Throws if any required identity field is empty/blank. `shell_family` may be
 * null (it is skipped when null).
 */
export function normalizeEnvironmentSnapshot(
  input: EnvironmentCollectionInput,
  policy: EnvironmentAllowlistPolicy,
): NormalizedEnvironmentSnapshot {
  // Rule 1: validate required identities. shell_family may be null.
  requireIdentity(input.environment_snapshot_id, 'environment_snapshot_id');
  requireIdentity(input.platform_family, 'platform_family');
  requireIdentity(input.workspace_root, 'workspace_root');
  requireIdentity(input.working_directory, 'working_directory');
  requireIdentity(input.observed_at, 'observed_at');
  if (input.shell_family !== null) {
    requireIdentity(input.shell_family, 'shell_family');
  }

  // Rule 2: canonicalize paths (resolve+normalize). No process.cwd() call.
  const workspace_root = canonicalizePath(input.workspace_root);
  const working_directory = canonicalizePath(input.working_directory);

  // Rule 3-5: bucket + sort. allowed_fields is a fresh copy.
  const { allowed, omitted } = bucketCollectedFields(input.collected_fields, policy);

  const snapshot: NormalizedEnvironmentSnapshot = {
    environment_snapshot_id: input.environment_snapshot_id,
    platform_family: input.platform_family,
    shell_family: input.shell_family,
    workspace_root,
    working_directory,
    repository_present: input.repository_present,
    allowed_fields: allowed,
    omitted_field_codes: omitted,
    observed_at: input.observed_at,
  };

  // Rule 7: deep-freeze. freezeSnapshot recurses into allowed_fields and
  // omitted_field_codes (and their primitives).
  return freezeSnapshot(snapshot) as NormalizedEnvironmentSnapshot;
}

// ---------------------------------------------------------------------------
// Formatting.
//
// Format (documented): a deterministic, line-oriented block. Field order is
// fixed: core fields first (platform_family, shell_family, workspace_root,
// working_directory, repository_present, observed_at), then `allowed_fields`
// in sorted key order. Only allowlisted-and-kept fields appear; omitted
// fields are not in the snapshot, so their values can never leak.
//
// This function MUST NOT consult process.cwd(), process.platform, or
// process.env — it reads only from the snapshot. The tests assert this
// indirectly by feeding a synthetic snapshot whose values disagree with the
// real runner environment and checking the formatter echoes the snapshot.
// ---------------------------------------------------------------------------

export function formatNormalizedEnvironment(snapshot: NormalizedEnvironmentSnapshot): string {
  const lines: string[] = [];
  lines.push('Environment:');
  lines.push(`  platform_family: ${snapshot.platform_family}`);
  lines.push(`  shell_family: ${snapshot.shell_family ?? 'null'}`);
  lines.push(`  workspace_root: ${snapshot.workspace_root}`);
  lines.push(`  working_directory: ${snapshot.working_directory}`);
  lines.push(`  repository_present: ${String(snapshot.repository_present)}`);
  lines.push(`  observed_at: ${snapshot.observed_at}`);
  // allowed_fields in sorted key order — deterministic.
  const keys = Object.keys(snapshot.allowed_fields).sort();
  for (const k of keys) {
    lines.push(`  ${k}: ${String(snapshot.allowed_fields[k])}`);
  }
  return lines.join('\n');
}
