// §7.2 adapter behavior. Depends ONLY on Task 4 (auto-permission-dialog.ts).
import { describe, test, expect } from 'vitest';
import { createAutoPermissionDialogProvider } from '../../permission/auto-permission-dialog.js';
import {
  ALLOW_ONCE_LABEL,
  ALLOW_EXACT_LABEL,
  ALLOW_ALWAYS_LABEL,
} from '../../permission/permission-answer-mapping.js';
import type { AskQuestionOutcome, AskQuestionRequest } from '../../agent/ask-user-types.js';
import type { DialogResult } from '../../permission/interactive-ask.js';

class ScriptedAskManager {
  constructor(private readonly outcome: AskQuestionOutcome) {}
  async ask(_request: AskQuestionRequest): Promise<AskQuestionOutcome> { return this.outcome; }
}

const askInput = {
  decision: { decision_id: 'd1', behavior: 'ask' as const, reason_code: 'x', human_reason: 'r' },
  toolName: 'run_bash',
  input: { command: 'echo hi' },
  origin: 'main' as const,
};

describe('[auto-dialog] adapter behavior (§7.2)', () => {
  test('A1: cancelled -> adapter returns DialogResult.escape', async () => {
    const mgr = new ScriptedAskManager({ kind: 'cancelled' });
    const dialog = createAutoPermissionDialogProvider(mgr as never);
    expect(await dialog(askInput as never)).toEqual({ kind: 'escape' });
  });
  test('A2: submitted labels -> corresponding DialogResult', async () => {
    const cases: Array<[string, DialogResult]> = [
      [ALLOW_ONCE_LABEL, { kind: 'approved_once' }],
      [ALLOW_EXACT_LABEL, { kind: 'approved_session' }],
      [ALLOW_ALWAYS_LABEL, { kind: 'approved_always' }],
      ['Reject', { kind: 'rejected' }],
    ];
    for (const [label, expected] of cases) {
      const mgr = new ScriptedAskManager({ kind: 'submitted', answers: { q: label } });
      const dialog = createAutoPermissionDialogProvider(mgr as never);
      expect(await dialog(askInput as never)).toEqual(expected);
    }
  });
  test('A3: chat -> rejected', async () => {
    const mgr = new ScriptedAskManager({ kind: 'chat', feedback: 'later' });
    const dialog = createAutoPermissionDialogProvider(mgr as never);
    expect(await dialog(askInput as never)).toEqual({ kind: 'rejected' });
  });
});
