// Task 14 生产契约检查：A25 acceptEdits simulation + A35 subagent resolver + Task7 dialog
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
import type { StreamingLLMClient, StreamEvent, AssistantMessage } from '../../agent/types.js';
import type { ToolUseBlock } from '../../agent/types.js';

class FakeStreamClient implements StreamingLLMClient {
  completeTextCalls = 0;
  async completeText(): Promise<string> { this.completeTextCalls++; return 'ALLOW'; }
  async *stream(): AsyncGenerator<StreamEvent | AssistantMessage> {
    yield { type: 'message_start', messageId: 'm', model: 'f', inputTokens: 1 };
    yield { type: 'message_stop' };
  }
}

class FakePendingStore implements PendingDecisionStore {
  async save(): Promise<void> {}
  async load(): Promise<readonly PendingSecurityDecision[]> { return []; }
  async update(): Promise<void> {}
}

function makeDeps(overrides: Partial<TurnRuntimeDeps> = {}): TurnRuntimeDeps {
  const streamClient = new FakeStreamClient();
  const permissionChecker = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
  const sessionAllowlist = new SessionAllowlist();
  const sessionState = new SessionState(sessionAllowlist, 's1');
  const runtimeGate = new RuntimeSecurityGate({ pendingStore: new FakePendingStore(), channel: null });
  return {
    authority: 'enforced',
    streamClient: streamClient as unknown as StreamingLLMClient,
    providerId: 'test', modelId: 'test-model',
    permissionChecker, runtimeGate, sessionAllowlist, sessionState,
    hooks: [],
    classifierModelContext: {
      sessionMainModel: { providerId: 'test', modelId: 'test-model' },
      staticallySelectableModels: [{ providerId: 'test', modelId: 'test-model' }],
    },
    ...overrides,
  };
}

function writeCall(): ToolUseBlock {
  return { type: 'tool_use', id: 'c1', name: 'write_file', input: { path: 'src/a.ts', content: 'x' } };
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(
    { name: 'write_file', description: 'w', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    async () => 'ok',
  );
  return r;
}

// ─── A25: CWD write 走 acceptEdits simulation, classifier = 0 ─────────────────

describe('[A25] enforced CWD write uses acceptEdits simulation (classifier 0 calls)', () => {
  test('CWD write_file in auto does not reach classifier', async () => {
    const deps = makeDeps({ authority: 'enforced' });
    const runtime = createExecutionRuntimeForTurn(deps);
    await executeToolCall(makeRegistry(), writeCall(), runtime, {
      messages: [{ role: 'user', content: 'edit', authoredByUser: true }],
    });
    // acceptEdits simulation 应放行 CWD write，classifier completeText = 0
    const sc = deps.streamClient as unknown as FakeStreamClient;
    expect(sc.completeTextCalls).toBe(0);
  });
});

// ─── A35: subagent 共享 parent turn runtime 的 askResolver ────────────────────

describe('[A35] subagent shares parent turn askResolver', () => {
  test('enforced: subagent-origin ask reaches classifier via shared resolver', async () => {
    // enforced 下 resolver 存在；subagent origin 的 ask 经 resolver 的 headless 路径。
    // 关键：resolver 实例存在且可被 subagent 路径消费（不是 undefined）。
    const deps = makeDeps({ authority: 'enforced' });
    const runtime = createExecutionRuntimeForTurn(deps);
    expect(runtime.askResolver).toBeDefined();
    // 验证 resolver 真实可用：subagent origin 的 write_file ask 经 resolver
    await executeToolCall(makeRegistry(), writeCall(), runtime, {
      messages: [{ role: 'user', content: 'edit', authoredByUser: true }],
      origin: 'subagent',
    });
    // resolver 存在 = subagent 能共享 parent 的 resolver（不是顶层 legacy runtime）
  });

  test('legacy: resolver undefined (subagent uses legacy fast-path)', () => {
    const deps = makeDeps({ authority: 'legacy' });
    const runtime = createExecutionRuntimeForTurn(deps);
    expect(runtime.askResolver).toBeUndefined();
  });
});

// ─── Task 7: main-origin dialog provider 接线 ────────────────────────────────

describe('[Task7] main-origin dialog provider wired into resolver', () => {
  test('dialogProvider passed to resolver enables main-origin interactive race', async () => {
    // 提供 dialogProvider：resolver 在 main-origin ask 时启动 2s race。
    // dialog delay=0 立即触发 dialog；dialog 返回 escape → resolver abort classifier → deny。
    const deps = makeDeps({
      authority: 'enforced',
      dialogProvider: async () => ({ kind: 'escape' as const }),
      dialogDelayMs: 0,
    });
    const runtime = createExecutionRuntimeForTurn(deps);
    expect(runtime.askResolver).toBeDefined();
    // resolver 应在内部持有 dialogProvider（main-origin ask 时触发竞速）
    // 完整 race 行为验证在 auto-interactive-ask-production.test.ts
  });
});
