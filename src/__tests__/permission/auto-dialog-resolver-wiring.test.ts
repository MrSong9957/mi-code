import { describe, test, expect, vi } from 'vitest';
import { executeToolCall } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { createConfiguredExecutionRuntimeForTurn } from '../../permission/authority-gate.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { SessionState } from '../../permission/session-state.js';
import type { PendingSecurityDecision, PendingDecisionStore } from '../../permission/runtime-gate.js';

class FakeStore implements PendingDecisionStore {
  async save(): Promise<void> {}
  async load(): Promise<readonly PendingSecurityDecision[]> { return []; }
  async update(): Promise<void> {}
}
function pendingClassifier() { return { completeText: () => new Promise<string>(() => {}) } as never; }

describe('[auto-dialog] resolver/executeToolCall end-to-end (§7.3)', () => {
  test('#1 unresolved ask past delay -> dialog invoked (wiring present)', async () => {
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient: pendingClassifier(),
      providerId: 'test', modelId: 'm', providerModelIds: ['m'],
      classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
      dialogProvider: async () => ({ kind: 'approved_once' }),
      dialogDelayMs: 0,
    });
    const registry = new ToolRegistry();
    registry.register(
      { name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
      vi.fn().mockResolvedValue('ran'),
    );
    const r = await executeToolCall(registry, { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime,
      { messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }] });
    expect(r.status).toBe('success'); // dialog wired -> approved_once -> allow -> execute
  });
});
