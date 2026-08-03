// Task 14 blocker: authority 真实生产 gate
//
// 验证 enforced/legacy/shadow 三种模式下 resolver/classifier 的真实调用行为。
// 不新增第二套 permission chain——复用 Task 4/6/7 的 DefaultPermissionClassifier +
// DefaultPermissionAskResolver + classifierProviderFromTextClient。
import { describe, test, expect } from 'vitest';
import {
  createExecutionRuntimeForTurn,
  type TurnRuntimeDeps,
} from '../../permission/authority-gate.js';
import { executeToolCall } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate, type PendingDecisionStore, type PendingSecurityDecision } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { SessionState } from '../../permission/session-state.js';
import { resolveAuthority } from '../../permission/cutover.js';
import type { ToolUseBlock } from '../../agent/types.js';
import type { StreamingLLMClient, Message, ToolDefinition, StreamEvent, AssistantMessage, StreamOptions } from '../../agent/types.js';

// ─── mock: 记录 completeText 调用的 fake stream client ────────────────────────

class FakeStreamClient implements StreamingLLMClient {
  readonly completeTextCalls: Array<{ model: unknown; prompt: string }> = [];
  readonly streamCalls: number[] = [];

  async completeText(req: { model: unknown; prompt: string }): Promise<string> {
    this.completeTextCalls.push({ model: req.model, prompt: req.prompt });
    return 'ALLOW'; // Stage 1 ALLOW -> classifier allow
  }

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    this.streamCalls.push(this.streamCalls.length);
    yield { type: 'message_start', messageId: 'msg', model: 'fake', inputTokens: 1 };
    yield { type: 'message_stop' };
  }
}

// ─── mock pending store ───────────────────────────────────────────────────────

class FakePendingStore implements PendingDecisionStore {
  async save(_p: PendingSecurityDecision): Promise<void> {}
  async load(): Promise<readonly PendingSecurityDecision[]> { return []; }
  async update(): Promise<void> {}
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<TurnRuntimeDeps> = {}): TurnRuntimeDeps {
  const streamClient = new FakeStreamClient();
  const permissionChecker = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
  const sessionAllowlist = new SessionAllowlist();
  const sessionState = new SessionState(sessionAllowlist, 's1');
  const runtimeGate = new RuntimeSecurityGate({
    pendingStore: new FakePendingStore(),
    channel: null,
  });
  return {
    authority: 'enforced',
    streamClient: streamClient as unknown as StreamingLLMClient,
    providerId: 'test',
    modelId: 'test-model',
    permissionChecker,
    runtimeGate,
    sessionAllowlist,
    sessionState,
    hooks: [],
    ...overrides,
  };
}

function writeCall(id = 'call-1'): ToolUseBlock {
  // protected settings path：acceptEdits 下闸门 3d 仍 ask（不被 fast-path 放行），
  // 继续到 classifier。用此验证 classifier 被调用。
  return { type: 'tool_use', id, name: 'write_file', input: { path: '.micode/config.json', content: 'x' } };
}

async function runToolCall(runtime: ReturnType<typeof createExecutionRuntimeForTurn>): Promise<void> {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'write_file', description: 'w', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } },
    async () => 'written',
  );
  await executeToolCall(registry, writeCall(), runtime, { messages: [{ role: 'user', content: 'edit src/a.ts', authoredByUser: true }] });
}

// ─── enforced: resolver + classifier 被调用 ───────────────────────────────────

describe('enforced authority: resolver + classifier activated', () => {
  test('default (env unset) resolves to enforced and activates classifier', async () => {
    expect(resolveAuthority(undefined)).toBe('enforced');
    const deps = makeDeps({ authority: resolveAuthority(undefined) });
    const runtime = createExecutionRuntimeForTurn(deps);
    expect(runtime.askResolver).toBeDefined();
    await runToolCall(runtime);
    // classifier provider completeText 被调用（Stage 1）
    const streamClient = deps.streamClient as unknown as FakeStreamClient;
    expect(streamClient.completeTextCalls.length).toBeGreaterThan(0);
  });

  test('explicit enforced activates classifier', async () => {
    const deps = makeDeps({ authority: 'enforced' });
    const runtime = createExecutionRuntimeForTurn(deps);
    expect(runtime.askResolver).toBeDefined();
    await runToolCall(runtime);
    const streamClient = deps.streamClient as unknown as FakeStreamClient;
    expect(streamClient.completeTextCalls.length).toBeGreaterThan(0);
  });
});

// ─── legacy: classifier 0 调用 ────────────────────────────────────────────────

describe('legacy authority: classifier not constructed', () => {
  test('legacy produces runtime without askResolver', () => {
    const deps = makeDeps({ authority: 'legacy' });
    const runtime = createExecutionRuntimeForTurn(deps);
    expect(runtime.askResolver).toBeUndefined();
  });

  test('legacy: classifier completeText never called', async () => {
    const deps = makeDeps({ authority: 'legacy' });
    const runtime = createExecutionRuntimeForTurn(deps);
    const streamClient = deps.streamClient as unknown as FakeStreamClient;
    await runToolCall(runtime);
    expect(streamClient.completeTextCalls).toHaveLength(0);
  });
});

// ─── shadow: candidate 被调用，但 legacy 决定 ─────────────────────────────────

describe('shadow authority: candidate runs but legacy decides', () => {
  test('shadow produces runtime with askResolver (candidate runs)', async () => {
    const deps = makeDeps({ authority: 'shadow' });
    const runtime = createExecutionRuntimeForTurn(deps);
    expect(runtime.askResolver).toBeDefined();
    await runToolCall(runtime);
    // candidate classifier 被调用
    const streamClient = deps.streamClient as unknown as FakeStreamClient;
    expect(streamClient.completeTextCalls.length).toBeGreaterThan(0);
  });

  test('shadow: final authorization is legacy (ask -> gate deny, not classifier allow)', async () => {
    // auto 模式下 write_file 是 ask。legacy（无 resolver）→ ask → gate no_channel → deny。
    // shadow 的 candidate（classifier）可能 allow，但最终应由 legacy 决定。
    // 由于 shadow 的 askResolver 返回 legacy decision，gate 收到的是 ask（不是 classifier allow），
    // gate no_channel → deny。如果 candidate 决定了结果，gate 会收到 allow → authorized。
    const deps = makeDeps({ authority: 'shadow' });
    const runtime = createExecutionRuntimeForTurn(deps);
    const result = await executeToolCall(
      makeRegistry(),
      writeCall(),
      runtime,
      { messages: [{ role: 'user', content: 'edit', authoredByUser: true }] },
    );
    // shadow 下 legacy 决定：ask → gate deny（no_channel）
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.failure.kind).toBe('permission_denied');
    }
  });
});

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'write_file', description: 'w', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    async () => 'written',
  );
  return registry;
}
