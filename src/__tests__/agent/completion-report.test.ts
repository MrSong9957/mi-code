import { describe, expect, it } from 'vitest';
import {
  createCompletionReport,
  createDispatchReceipt,
} from '../../agent/contracts/completion-report.js';

// ---- Shared fixtures ---------------------------------------------------------

const passedV2 = {
  required_level: 'V2' as const,
  achieved_level: 'V2' as const,
  status: 'passed' as const,
  evidence_refs: ['test:unit-and-integration'],
  failure_kind: null,
};

const verifiedDeliverable = {
  deliverable_id: 'deliv-1',
  description: 'implements contract',
  verification_level: 'V2' as const,
  evidence_refs: ['test:contract'],
};

// ---- createCompletionReport --------------------------------------------------

describe('createCompletionReport', () => {
  it('allows completed only with sufficient verification evidence', () => {
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'subagent', id: 'subagent-1' },
      outcome: 'completed',
      termination_reason: 'end_turn',
      verification: passedV2,
      deliverables: [],
      summary: 'implemented contract',
      remaining_uncertainty: [],
    });
    expect(report.outcome).toBe('completed');
    expect(report.execution_mode).toBe('foreground');
  });

  it('rejects cancelled without user abort', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 'turn-1' },
        outcome: 'cancelled',
        termination_reason: 'provider_error',
        verification: { ...passedV2, status: 'blocked' },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow('cancelled');
  });

  it('rejects completed when achieved level is below required level', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 'turn-1' },
        outcome: 'completed',
        termination_reason: 'end_turn',
        verification: {
          ...passedV2,
          achieved_level: 'V1',
          required_level: 'V2',
        },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow(/completed|level/);
  });

  it('rejects completed when evidence_refs is empty despite sufficient level', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 'turn-1' },
        outcome: 'completed',
        termination_reason: 'end_turn',
        verification: { ...passedV2, evidence_refs: [] },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow('evidence');
  });

  it('rejects completed when verification status is failed', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 'turn-1' },
        outcome: 'completed',
        termination_reason: 'end_turn',
        verification: { ...passedV2, status: 'failed' },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow('completed');
  });

  it('rejects partial when there are no deliverables', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 'turn-1' },
        outcome: 'partial',
        termination_reason: 'end_turn',
        verification: passedV2,
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow('partial');
  });

  it('rejects partial when deliverables have no evidence', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 'turn-1' },
        outcome: 'partial',
        termination_reason: 'end_turn',
        verification: passedV2,
        deliverables: [{ ...verifiedDeliverable, evidence_refs: [] }],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow('partial');
  });

  it('accepts partial when at least one deliverable has evidence', () => {
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'partial',
      termination_reason: 'end_turn',
      verification: passedV2,
      deliverables: [verifiedDeliverable],
      summary: '',
      remaining_uncertainty: [],
    });
    expect(report.outcome).toBe('partial');
  });

  it('rejects failed when a deliverable has independent evidence', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 'turn-1' },
        outcome: 'failed',
        termination_reason: 'error',
        verification: { ...passedV2, status: 'failed' },
        deliverables: [verifiedDeliverable],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow('failed');
  });

  it('accepts failed when no deliverable is independently verified', () => {
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'failed',
      termination_reason: 'error',
      verification: { ...passedV2, status: 'failed' },
      deliverables: [{ ...verifiedDeliverable, evidence_refs: [] }],
      summary: '',
      remaining_uncertainty: [],
    });
    expect(report.outcome).toBe('failed');
  });

  it('accepts cancelled when termination_reason is user_abort', () => {
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'cancelled',
      termination_reason: 'user_abort',
      verification: { ...passedV2, status: 'blocked' },
      deliverables: [],
      summary: '',
      remaining_uncertainty: [],
    });
    expect(report.outcome).toBe('cancelled');
  });

  it('rejects cancelled when termination_reason is end_turn', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 'turn-1' },
        outcome: 'cancelled',
        termination_reason: 'end_turn',
        verification: { ...passedV2, status: 'blocked' },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow();
  });

  it('accepts provider_error + partial with a verified deliverable', () => {
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'partial',
      termination_reason: 'provider_error',
      verification: { ...passedV2, status: 'blocked' },
      deliverables: [verifiedDeliverable],
      summary: '',
      remaining_uncertainty: [],
    });
    expect(report.outcome).toBe('partial');
  });

  it('accepts provider_error + failed with no verified deliverable', () => {
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'failed',
      termination_reason: 'provider_error',
      verification: { ...passedV2, status: 'failed' },
      deliverables: [],
      summary: '',
      remaining_uncertainty: [],
    });
    expect(report.outcome).toBe('failed');
  });

  it('accepts max_turns + failed with no verified deliverable', () => {
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'failed',
      termination_reason: 'max_turns',
      verification: { ...passedV2, status: 'blocked' },
      deliverables: [],
      summary: '',
      remaining_uncertainty: [],
    });
    expect(report.outcome).toBe('failed');
  });

  it('accepts max_turns + partial with a verified deliverable', () => {
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'partial',
      termination_reason: 'max_turns',
      verification: { ...passedV2, status: 'blocked' },
      deliverables: [verifiedDeliverable],
      summary: '',
      remaining_uncertainty: [],
    });
    expect(report.outcome).toBe('partial');
  });

  it('rejects empty protocol_version', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '',
        subject: { kind: 'turn', id: 'turn-1' },
        outcome: 'failed',
        termination_reason: 'error',
        verification: { ...passedV2, status: 'failed' },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow('protocol_version');
  });

  it('rejects empty subject.id', () => {
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: '' },
        outcome: 'failed',
        termination_reason: 'error',
        verification: { ...passedV2, status: 'failed' },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow('subject');
  });

  // Background is structurally impossible at the type level: CreateCompletionReportInput
  // does not expose an `execution_mode` field, and CompletionReport.execution_mode is the
  // literal type 'foreground'. So no runtime test can construct this case from typed input.
  it.skip('background via createCompletionReport is rejected by the type system', () => {
    // The CreateCompletionReportInput type has no execution_mode field; the output
    // CompletionReport.execution_mode is fixed to 'foreground'. TypeScript refuses to
    // compile any caller attempting to pass execution_mode: 'background' here.
  });

  it('freezes the report and its nested verification and deliverables objects', () => {
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'partial',
      termination_reason: 'end_turn',
      verification: passedV2,
      deliverables: [verifiedDeliverable],
      summary: '',
      remaining_uncertainty: ['open-question'],
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.deliverables)).toBe(true);
    expect(Object.isFrozen(report.verification)).toBe(true);
  });

  it('does not mutate the caller-supplied deliverables array', () => {
    const inputDeliverables = [
      { ...verifiedDeliverable, evidence_refs: ['test:one'] },
    ];
    const snapshotBefore = inputDeliverables.map((d) => ({
      ...d,
      evidence_refs: [...d.evidence_refs],
    }));
    createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'partial',
      termination_reason: 'end_turn',
      verification: passedV2,
      deliverables: inputDeliverables,
      summary: '',
      remaining_uncertainty: [],
    });
    expect(inputDeliverables).toEqual(snapshotBefore);
    // Caller can still mutate their own copy after the call.
    inputDeliverables[0].evidence_refs.push('test:two');
    expect(inputDeliverables[0].evidence_refs).toContain('test:two');
  });

  it('does not let summary text influence outcome computation', () => {
    const base = {
      protocol_version: '1',
      subject: { kind: 'turn', id: 'turn-1' },
      outcome: 'completed' as const,
      termination_reason: 'end_turn',
      verification: passedV2,
      deliverables: [],
      remaining_uncertainty: [],
    };
    const withSummary = createCompletionReport({ ...base, summary: 'DONE' });
    const withEmptySummary = createCompletionReport({ ...base, summary: '' });
    expect(withSummary.outcome).toBe('completed');
    expect(withEmptySummary.outcome).toBe('completed');

    // Both a "happy" summary and a "sad" summary produce the same outcome because
    // summary is descriptive-only and must not flow into verification logic.
    const happy = createCompletionReport({ ...base, summary: 'all green, perfect' });
    const sad = createCompletionReport({ ...base, summary: 'crashed, total failure' });
    expect(happy.outcome).toBe(sad.outcome);
  });
});

// ---- createDispatchReceipt ---------------------------------------------------

describe('createDispatchReceipt', () => {
  it('returns no outcome for background dispatch', () => {
    expect(
      createDispatchReceipt({
        protocol_version: '1',
        task_id: 'task-1',
        accepted: true,
      }),
    ).toEqual({
      protocol_version: '1',
      execution_mode: 'background',
      task_id: 'task-1',
      accepted: true,
    });
  });

  it('does not expose an outcome property on the receipt', () => {
    const receipt = createDispatchReceipt({
      protocol_version: '1',
      task_id: 'task-1',
      accepted: true,
    });
    expect(receipt).not.toHaveProperty('outcome');
  });

  it('rejects empty task_id', () => {
    expect(() =>
      createDispatchReceipt({
        protocol_version: '1',
        task_id: '',
        accepted: true,
      }),
    ).toThrow('task_id');
  });

  it('rejects empty protocol_version', () => {
    expect(() =>
      createDispatchReceipt({
        protocol_version: '',
        task_id: 'task-1',
        accepted: true,
      }),
    ).toThrow('protocol_version');
  });

  it('hardcodes execution_mode to background and freezes the receipt', () => {
    const receipt = createDispatchReceipt({
      protocol_version: '1',
      task_id: 'task-1',
      accepted: false,
    });
    expect(receipt.execution_mode).toBe('background');
    expect(Object.isFrozen(receipt)).toBe(true);
  });
});
