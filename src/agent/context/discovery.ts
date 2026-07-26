/**
 * RC-3 Project Rule Discovery (Wave A, M-010).
 *
 * Discovery only checks file EXISTENCE — it never reads file contents.
 * Outputs are deliberately minimal: they carry source identity and scope
 * metadata, but NO authority, trust, placement, content, or instructions.
 * Promoting candidates to trusted rules, formatting provenance, routing,
 * and content sanitization are Wave B responsibilities (M-011, M-012, M-040).
 */

import { access, stat } from 'node:fs/promises';
import { resolve, relative, normalize, sep, isAbsolute } from 'node:path';
import { requireIdentity } from '../contracts/identities.js';

export interface ProjectRuleDiscoveryInput {
  workspace_root: string;
  repository_root: string | null;
  working_directory: string;
  source_policy_id: string;
}

export interface ProjectRuleSourcePolicy {
  source_policy_id: string;
  candidate_names: readonly string[];
}

export interface DiscoveredRuleSource {
  source_id: string;
  candidate_kind: string;
  absolute_path: string;
  scope_root: string;
  relative_depth: number;
  discovery_order: number;
  diagnostics: string[];
}

/**
 * Returns true if `child` is inside `parent` (or equal to it), comparing
 * absolute paths by string prefix with a separator boundary. This is a pure
 * string check — no symlink resolution, which M-040 handles later.
 */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(parentWithSep);
}

/**
 * Counts the number of path segments between `scopeRoot` and `workingDirectory`.
 * Returns 0 when the two are equal. Uses `relative()` so segment counting is
 * separator-agnostic on the host platform.
 */
function depthBetween(workingDirectory: string, scopeRoot: string): number {
  const rel = relative(scopeRoot, workingDirectory);
  if (rel === '') return 0;
  return rel.split(sep).length;
}

/**
 * Discovers project rule candidate sources within the workspace/repository
 * boundary. See Wave A design spec §9 (RC-3).
 *
 * The algorithm is deterministic:
 *   - resolve and validate all roots and the working directory;
 *   - confirm containment (working_directory inside workspace_root, and also
 *     inside repository_root when set; repository_root inside workspace_root);
 *   - enumerate ancestor directories from the discovery ceiling DOWN to the
 *     working directory inclusive (ceiling-first);
 *   - at each ancestor, probe `candidate_names` in policy order;
 *   - dedupe by normalized absolute path (first discovery wins);
 *   - assign `discovery_order` incrementally in discovery order.
 *
 * Single unreadable candidates never abort discovery — a diagnostic is
 * recorded and the candidate is skipped. Discovery NEVER reads file contents.
 */
export async function discoverProjectRuleSources(
  input: ProjectRuleDiscoveryInput,
  policy: ProjectRuleSourcePolicy,
): Promise<readonly DiscoveredRuleSource[]> {
  // 1. Reject relative inputs first — a relative root is a configuration
  //    error regardless of cwd. We check the INPUT (before resolve) because
  //    resolve() would silently anchor a relative input to the process cwd,
  //    masking the mistake. After validating absoluteness we resolve to a
  //    canonical form for downstream containment/dedup checks.
  if (!isAbsolute(input.workspace_root)) {
    throw new Error('workspace_root must be an absolute path');
  }
  if (!isAbsolute(input.working_directory)) {
    throw new Error('working_directory must be an absolute path');
  }
  if (
    input.repository_root !== null &&
    !isAbsolute(input.repository_root)
  ) {
    throw new Error('repository_root must be an absolute path');
  }

  const workspaceRoot = resolve(input.workspace_root);
  const workingDirectory = resolve(input.working_directory);
  const repositoryRoot =
    input.repository_root === null ? null : resolve(input.repository_root);

  // Defensive invariant: resolve() must yield an absolute path for an input
  // we already confirmed is absolute. This guards against any future platform
  // quirk and keeps the contract explicit.
  if (!isAbsolute(workspaceRoot)) {
    throw new Error('workspace_root must be an absolute path');
  }
  if (!isAbsolute(workingDirectory)) {
    throw new Error('working_directory must be an absolute path');
  }
  if (repositoryRoot !== null && !isAbsolute(repositoryRoot)) {
    throw new Error('repository_root must be an absolute path');
  }

  // 2. Validate the source_policy_id (non-empty string) and confirm input
  //    matches policy. Mismatch is a configuration error, NOT empty success.
  requireIdentity(input.source_policy_id, 'source_policy_id');
  if (input.source_policy_id !== policy.source_policy_id) {
    throw new Error('unknown source_policy_id');
  }

  // 3. working_directory must be inside workspace_root.
  if (!isWithin(workingDirectory, workspaceRoot)) {
    throw new Error('working directory outside workspace');
  }

  // 4. repository_root containment, if set.
  let ceiling: string;
  if (repositoryRoot !== null) {
    if (!isWithin(workingDirectory, repositoryRoot)) {
      throw new Error('working directory outside repository');
    }
    if (!isWithin(repositoryRoot, workspaceRoot)) {
      throw new Error('repository_root outside workspace');
    }
    ceiling = repositoryRoot;
  } else {
    ceiling = workspaceRoot;
  }

  // 5. Build the ancestor chain from the ceiling DOWN to working_directory,
  //    inclusive. Ceiling comes first so the rootmost candidate is discovered
  //    first (matches the plan's [root/CLAUDE.md, child/AGENTS.md] ordering).
  const ancestors: string[] = [];
  let cursor: string = workingDirectory;
  ancestors.push(cursor);
  // Walk up via dirname until we reach the ceiling.
  // Use string prefix containment to decide when to stop, so we don't depend
  // on the platform's root-drive semantics beyond resolve()'s normalization.
  while (cursor !== ceiling && isWithin(cursor, ceiling)) {
    const parent = resolve(cursor, '..');
    if (parent === cursor) {
      // Reached a filesystem root without hitting the ceiling — should not
      // happen after containment checks, but guard against infinite loops.
      break;
    }
    ancestors.push(parent);
    cursor = parent;
  }
  // Reverse so the ceiling is first, working_directory last.
  ancestors.reverse();

  // 6 & 7. Probe candidate_names at each ancestor, in order. Dedupe by the
  //        normalized absolute path (first discovery wins, preserving the
  //        lowest discovery_order).
  const seen = new Set<string>();
  const results: DiscoveredRuleSource[] = [];
  let discoveryOrder = 0;

  for (const ancestor of ancestors) {
    for (const candidateName of policy.candidate_names) {
      const absolutePathRaw = resolve(ancestor, candidateName);
      const absolutePath = normalize(absolutePathRaw);
      if (seen.has(absolutePath)) {
        // First discovery wins; keep the lowest discovery_order.
        continue;
      }

      let exists = false;
      let diagnostics: string[] = [];
      try {
        await access(absolutePath);
        const info = await stat(absolutePath);
        exists = true;
        if (!info.isFile()) {
          // A directory (or other non-file entry) at a candidate name is not
          // a rule file. Skip it but record a diagnostic so callers can tell
          // misconfiguration apart from absence. We do NOT treat this as
          // fatal and do NOT promote it to a candidate.
          diagnostics = [`not-a-file: ${candidateName}`];
          exists = false;
        }
      } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ENOENT') {
          // Simply absent — no diagnostic, no candidate.
          continue;
        }
        // Any other probe error (EACCES, EPERM, ...) — record a diagnostic
        // and skip this candidate. Discovery never throws fatal on a single
        // unreadable candidate.
        const message = err instanceof Error ? err.message : String(err);
        diagnostics = [`unreadable: ${message}`];
        exists = false;
      }

      if (exists) {
        seen.add(absolutePath);
        const rel = relative(workspaceRoot, absolutePath);
        results.push(
          Object.freeze({
            source_id: `project-rule:${rel}`,
            candidate_kind: candidateName,
            absolute_path: absolutePath,
            scope_root: ancestor,
            relative_depth: depthBetween(workingDirectory, ancestor),
            discovery_order: discoveryOrder,
            diagnostics,
          }) as DiscoveredRuleSource,
        );
        discoveryOrder += 1;
      }
      // Non-existent or non-file candidates are simply absent: no diagnostic
      // recorded on the output for them (spec §9.4: "absent → simply absent").
    }
  }

  return Object.freeze(results);
}
