/**
 * RC-4 Completion Contract (Wave A).
 *
 * Two builders live here:
 *  - {@link createCompletionReport} builds a foreground `CompletionReport`: a frozen,
 *    validated snapshot of how a turn/subagent finished.
 *  - {@link createDispatchReceipt} builds a background `DispatchReceipt`: a frozen,
 *    minimal acknowledgement that a background task was accepted.
 *
 * The CompletionReport builder is a VALIDATOR, not a CLASSIFIER. The caller picks the
 * outcome; the builder only enforces that the chosen outcome is consistent with the
 * supplied verification evidence and deliverables. (Task 8 will layer a
 * `classifySubagentCompletion` classifier on top of this builder.)
 *
 * Invariants enforced here, per spec §10:
 *  - Verification levels are compared by an explicit LEVEL_RANK map, never by string
 *    comparison. ('V3' must outrank 'V2' because the map says so, not because of
 *    lexicographic order.)
 *  - `summary` is purely descriptive: it MUST NOT participate in any outcome or
 *    verification computation.
 *  - Memory writes are not verification evidence. Only `evidence_refs` strings count.
 *  - `asset_version` bumps never change `protocol_version` (the caller passes
 *    `protocol_version` explicitly; we never derive it).
 *  - The output is deep-frozen via {@link freezeSnapshot}, and nested arrays
 *    (`evidence_refs`, `deliverables`, `remaining_uncertainty`) are deep-copied so the
 *    caller cannot mutate the snapshot after construction.
 *  - Background dispatch is NOT a CompletionReport. The TS input type fixes
 *    `execution_mode` to the literal `'foreground'` and exposes no field to override it,
 *    so constructing a background `CompletionReport` is rejected at compile time. This
 *    is by design — use {@link createDispatchReceipt} for background dispatch.
 */

import { freezeSnapshot, requireIdentity } from './identities.js';

// ---- Public types ------------------------------------------------------------

export type CompletionOutcome = 'completed' | 'partial' | 'failed' | 'cancelled';

export type VerificationLevel = 'V0' | 'V1' | 'V2' | 'V3';

export type VerificationStatus = 'passed' | 'failed' | 'blocked' | 'not_run';

export type VerificationFailureKind = 'repairable' | 'blocked' | 'unrecoverable';

export interface VerificationReport {
  required_level: VerificationLevel;
  achieved_level: VerificationLevel | null;
  status: VerificationStatus;
  evidence_refs: string[];
  failure_kind: VerificationFailureKind | null;
}

export interface DeliverableReport {
  deliverable_id: string;
  description: string;
  verification_level: VerificationLevel;
  evidence_refs: string[];
}

export interface SubjectRef {
  kind: 'turn' | 'subagent';
  id: string;
}

/**
 * A foreground completion report. `execution_mode` is the literal `'foreground'`;
 * there is no background variant of this type — background dispatch uses
 * {@link DispatchReceipt} instead.
 */
export interface CompletionReport {
  protocol_version: string;
  subject: SubjectRef;
  outcome: CompletionOutcome;
  termination_reason: string;
  execution_mode: 'foreground';
  verification: VerificationReport;
  deliverables: DeliverableReport[];
  summary: string;
  remaining_uncertainty: string[];
}

/**
 * A background dispatch acknowledgement. Deliberately has NO `outcome` field: a
 * background task has not finished, so it cannot have an outcome yet.
 */
export interface DispatchReceipt {
  protocol_version: string;
  execution_mode: 'background';
  task_id: string;
  accepted: boolean;
}

export interface CreateCompletionReportInput {
  protocol_version: string;
  subject: SubjectRef;
  outcome: CompletionOutcome;
  termination_reason: string;
  verification: VerificationReport;
  deliverables: DeliverableReport[];
  summary: string;
  remaining_uncertainty: string[];
}

export interface CreateDispatchReceiptInput {
  protocol_version: string;
  task_id: string;
  accepted: boolean;
}

// ---- Level ranking (explicit, never string-compare) -------------------------

/**
 * Explicit rank map for {@link VerificationLevel}. Use this whenever levels must be
 * compared — never compare the string forms directly. Adding a level means adding an
 * entry here; the map is the single source of truth for ordering.
 */
const LEVEL_RANK: Record<VerificationLevel, number> = {
  V0: 0,
  V1: 1,
  V2: 2,
  V3: 3,
};

// ---- Builders ----------------------------------------------------------------

/**
 * Construct a validated, frozen {@link CompletionReport}.
 *
 * Throws with a message naming the offending concept when the (caller-chosen) outcome
 * is inconsistent with the supplied evidence. See file header for the full invariant
 * list.
 */
export function createCompletionReport(
  input: CreateCompletionReportInput,
): CompletionReport {
  // 1. Identity checks.
  requireIdentity(input.protocol_version, 'protocol_version');
  requireIdentity(input.subject.id, 'subject.id');

  const verification = input.verification;
  const outcome = input.outcome;

  // 2. Outcome-vs-evidence consistency. `summary` is intentionally NOT consulted here.
  enforceOutcomeConsistency(outcome, input.termination_reason, verification, input.deliverables);

  // 3. Deep-copy nested arrays so the caller cannot mutate the snapshot later, then
  //    freeze the whole structure.
  const report: CompletionReport = {
    protocol_version: input.protocol_version,
    subject: { ...input.subject },
    outcome,
    termination_reason: input.termination_reason,
    // execution_mode is fixed to 'foreground' for CompletionReport. Background dispatch
    // is a DispatchReceipt, not a CompletionReport, and the input type gives callers no
    // way to override this — so this is enforced structurally by TypeScript.
    execution_mode: 'foreground',
    verification: deepCopyVerification(verification),
    deliverables: input.deliverables.map(deepCopyDeliverable),
    // summary is stored verbatim and never feeds back into outcome logic.
    summary: input.summary,
    remaining_uncertainty: [...input.remaining_uncertainty],
  };

  return freezeSnapshot(report) as CompletionReport;
}

/**
 * Construct a validated, frozen {@link DispatchReceipt} for a background dispatch.
 *
 * `execution_mode` is hardcoded to `'background'`; the input type intentionally has no
 * field to override it. The receipt has no `outcome` property — background tasks have
 * not finished.
 */
export function createDispatchReceipt(
  input: CreateDispatchReceiptInput,
): DispatchReceipt {
  requireIdentity(input.protocol_version, 'protocol_version');
  requireIdentity(input.task_id, 'task_id');

  const receipt: DispatchReceipt = {
    protocol_version: input.protocol_version,
    execution_mode: 'background',
    task_id: input.task_id,
    accepted: input.accepted,
  };

  return freezeSnapshot(receipt) as DispatchReceipt;
}

// ---- Internal helpers --------------------------------------------------------

function enforceOutcomeConsistency(
  outcome: CompletionOutcome,
  terminationReason: string,
  verification: VerificationReport,
  deliverables: DeliverableReport[],
): void {
  switch (outcome) {
    case 'completed': {
      // Rule #3: completed requires verification.status === 'passed'.
      if (verification.status !== 'passed') {
        throw new Error(
          `outcome 'completed' requires verification.status 'passed' (got '${verification.status}')`,
        );
      }
      // Rule #5: passed requires at least one evidence_ref.
      if (verification.evidence_refs.length === 0) {
        throw new Error(
          `outcome 'completed' with status 'passed' requires non-empty evidence_refs`,
        );
      }
      // Rule #4: achieved_level must meet or exceed required_level. Use LEVEL_RANK,
      // never string comparison.
      if (
        verification.achieved_level === null ||
        LEVEL_RANK[verification.achieved_level] < LEVEL_RANK[verification.required_level]
      ) {
        const achieved = verification.achieved_level ?? 'null';
        throw new Error(
          `outcome 'completed' requires verification level ${verification.required_level} to be reached (achieved ${achieved})`,
        );
      }
      return;
    }
    case 'partial': {
      // Rule #6: partial requires at least one deliverable with non-empty evidence_refs.
      // The deliverable's own verification_level need not match the report's required_level.
      const hasVerifiedDeliverable = deliverables.some(
        (d) => d.evidence_refs.length > 0,
      );
      if (!hasVerifiedDeliverable) {
        throw new Error(
          `outcome 'partial' requires at least one deliverable with independent evidence`,
        );
      }
      return;
    }
    case 'failed': {
      // Rule #7 / spec §10.3.3: failed = no independently-verifiable verified result.
      const hasVerifiedDeliverable = deliverables.some(
        (d) => d.evidence_refs.length > 0,
      );
      if (hasVerifiedDeliverable) {
        throw new Error(
          `outcome 'failed' must not have any deliverable with independent evidence`,
        );
      }
      return;
    }
    case 'cancelled': {
      // Rule #8: cancelled requires termination_reason === 'user_abort'.
      if (terminationReason !== 'user_abort') {
        throw new Error(
          `outcome 'cancelled' requires termination_reason 'user_abort' (got '${terminationReason}')`,
        );
      }
      return;
    }
  }
}

function deepCopyVerification(v: VerificationReport): VerificationReport {
  return {
    required_level: v.required_level,
    achieved_level: v.achieved_level,
    status: v.status,
    evidence_refs: [...v.evidence_refs],
    failure_kind: v.failure_kind,
  };
}

function deepCopyDeliverable(d: DeliverableReport): DeliverableReport {
  return {
    deliverable_id: d.deliverable_id,
    description: d.description,
    verification_level: d.verification_level,
    evidence_refs: [...d.evidence_refs],
  };
}
