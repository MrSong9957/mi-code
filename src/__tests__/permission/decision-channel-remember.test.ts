import { describe, it, expect } from 'vitest';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { createSecurityDecision, SECURITY_PROTOCOL_VERSION, type UserDecision } from '../../permission/decisions.js';

class MemStore { async save() {} async load() { return []; } async update() {} }

describe('remember → allowlist 回归', () => {
  it('remember=true 经 onAuthorized 写 allowlist', async () => {
    const allowlist = new SessionAllowlist();
    let resolveReq: ((u: UserDecision) => void) | null = null;
    const gate = new RuntimeSecurityGate({
      pendingStore: new MemStore() as any,
      channel: { request: () => new Promise<UserDecision>(r => { resolveReq = r; }) } as any,
    });
    const decision = createSecurityDecision({
      protocol_version: SECURITY_PROTOCOL_VERSION, decision_id: 'd1',
      action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 's1' },
      behavior: 'ask', deciding_layer: 'permission', risk_kind: 'workspace_mutation',
      policy_id: 'p', policy_version: '1',
      reason_code: 'permission.user_confirmation_required', human_reason: 't',
      provenance_refs: ['t'],
    });
    const input = { path: 'a.txt', content: 'x' };
    const p = gate.execute(decision, async () => 'ok', {
      onAuthorized: (a) => { if (a.remember) allowlist.add('write_file', input); },
    });
    await new Promise(r => setTimeout(r, 10));
    resolveReq!({ protocol_version: SECURITY_PROTOCOL_VERSION, decision_id: 'd1', response: 'approved_once', decided_at: new Date().toISOString(), remember: true });
    expect(await p).toBe('ok');
    expect(allowlist.has('write_file', input)).toBe(true);
  });
});
