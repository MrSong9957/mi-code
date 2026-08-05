// Task 9 wiring test: prove that projectClassifierConfigSources output
// reaches the production classifier via createExecutionRuntimeForTurn.
//
// This test FAILS until src/index.ts + authority-gate.ts wire the config.
import { describe, test, expect, vi } from 'vitest';
import { createExecutionRuntimeForTurn, type TurnRuntimeDeps } from '../../permission/authority-gate.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate, type PendingDecisionStore, type PendingSecurityDecision } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { SessionState } from '../../permission/session-state.js';
import type { StreamingLLMClient, StreamEvent, AssistantMessage } from '../../agent/types.js';

class RecordingStreamClient implements StreamingLLMClient {
  completeTextCalls = 0;
  lastSystemPrompt = '';
  lastPrompt = '';
  async completeText(req: { systemPrompt?: string; prompt?: string }): Promise<string> {
    this.completeTextCalls++;
    if (req.systemPrompt !== undefined) this.lastSystemPrompt = req.systemPrompt;
    if (req.prompt !== undefined) this.lastPrompt = req.prompt;
    return 'ALLOW';
  }
  async *stream(): AsyncGenerator<StreamEvent | AssistantMessage> {
    yield { type: 'message_start', messageId: 'm', model: 'f', inputTokens: 1 };
    yield { type: 'message_stop' };
  }
}
class FakeStore implements PendingDecisionStore {
  async save(): Promise<void> {}
  async load(): Promise<readonly PendingSecurityDecision[]> { return []; }
  async update(): Promise<void> {}
}

function makeDeps(overrides: Partial<TurnRuntimeDeps> = {}): TurnRuntimeDeps {
  const streamClient = new RecordingStreamClient();
  return {
    authority: 'enforced',
    streamClient: streamClient as unknown as StreamingLLMClient,
    providerId: 'test', modelId: 'test-model',
    permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
    runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
    sessionAllowlist: new SessionAllowlist(),
    sessionState: new SessionState(new SessionAllowlist(), 's1'),
    hooks: [],
    ...overrides,
  };
}

describe('[Task 9 wiring] classifier config sources reach production classifier', () => {
  test('classifier rules from trusted config appear in classifier systemPrompt', async () => {
    // Inject classifier rules via TurnRuntimeDeps (as index.ts should do).
    const deps = makeDeps({
      classifierRules: ['CUSTOM_RULE: deny all writes to /prod'],
    });
    const runtime = createExecutionRuntimeForTurn(deps);
    const sc = deps.streamClient as unknown as RecordingStreamClient;

    // Execute a run_bash call to trigger classifier.
    const { ToolRegistry } = await import('../../agent/tool-registry.js');
    const { executeToolCall } = await import('../../agent/tool-execution.js');
    const registry = new ToolRegistry();
    registry.register(
      { name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
      vi.fn().mockResolvedValue('ok'),
    );
    await executeToolCall(
      registry,
      { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } },
      runtime,
      { messages: [{ role: 'user', content: 'run echo', authoredByUser: true }] },
    );

    // The classifier was invoked
    expect(sc.completeTextCalls).toBeGreaterThanOrEqual(1);
    // The custom rule from classifier config reached the classifier.
    // At 10702c5, rules are in the prompt prefix (Rules: section);
    // after e1a1da3 they move to systemPrompt. Check whichever is populated.
    const rulePresent = sc.lastSystemPrompt.includes('CUSTOM_RULE: deny all writes to /prod')
      || sc.lastPrompt.includes('CUSTOM_RULE: deny all writes to /prod');
    expect(rulePresent).toBe(true);
  });
});
