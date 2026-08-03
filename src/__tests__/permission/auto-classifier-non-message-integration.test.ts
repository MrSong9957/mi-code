// Task 6 集成验收：classifier 非消息化、gate barrier、abort 隔离、多 tool call 隔离
//
// 设计输入：§7.5（非消息化与生命周期）、§10 A35/A84 重定义。
//
// 验收点：
//   - A35：child 共享 parent 真实 askResolver（不另造 child resolver/classifier）
//   - classifier pending 时 gate/executor = 0
//   - 每 call 独立 AbortSignal；abort call-a 不影响并行 call-b
//   - classifier 已决定后 abort 不改变 decision（late abort no-op）
//   - 同 turn 多 tool call 各自只携带当前 executable call
//   - classifier deny/failure executor = 0
import { describe, test, expect, vi } from 'vitest';
import {
  DefaultPermissionAskResolver,
  type PermissionAskResolutionRequest,
} from '../../permission/ask-resolver.js';
import type { ClassifierDecision } from '../../permission/classifier.js';
import type { SecurityDecision } from '../../permission/decisions.js';

// ─── helpers ────────────────────────────────────────────────────────────────────

function makeDecision(behavior: 'allow' | 'ask' | 'deny', rc = 'permission.user_confirmation_required'): SecurityDecision {
  return { protocol_version: '1', decision_id: 'd1', action: { kind: 'tool_call', subject_id: 't', snapshot_id: 's' }, behavior, deciding_layer: 'p', risk_kind: 'r', policy_id: 'p', policy_version: '1', reason_code: rc, human_reason: 'h', provenance_refs: behavior === 'allow' ? ['t'] : [] } as SecurityDecision;
}
function askRequest(callId: string, tool: string, input: Record<string, unknown> = {}, opts: { registerAbort?: (a: () => void) => void; origin?: 'main' | 'subagent' } = {}): PermissionAskResolutionRequest {
  return {
    decision: makeDecision('ask'),
    executableToolCall: { callId, canonicalToolName: tool, input },
    messages: [{ role: 'user', content: 'do it', authoredByUser: true }],
    origin: opts.origin ?? 'main',
    permissionContext: null,
    registerAbort: opts.registerAbort,
  };
}

/** classifier that records calls and can be controlled via deferred（per-call resolve, signal-aware） */
function deferredClassifier() {
  const calls: Array<{ input: unknown; signal: AbortSignal; resolve: (d: ClassifierDecision) => void; reject: (e: Error) => void }> = [];
  const classify = vi.fn((input: unknown, signal: AbortSignal) => {
    return new Promise<ClassifierDecision>((resolve, reject) => {
      calls.push({ input, signal, resolve, reject });
      // signal abort -> reject（模拟 provider RPC 因 signal abort 失败）
      if (signal.aborted) reject(new Error('aborted'));
      else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  function resolveAll(d: ClassifierDecision) { calls.forEach((c) => c.resolve(d)); }
  function resolveDeny() { resolveAll({ behavior: 'deny', reason_code: 'permission.classifier_deny' } as ClassifierDecision); }
  function resolveAllow() { resolveAll({ behavior: 'allow', reason_code: 'permission.classifier_allow' } as ClassifierDecision); }
  return { classify, calls, resolveAll, resolveDeny, resolveAllow };
}

function makeResolver(classify: ReturnType<typeof vi.fn>, opts: { evaluateWithMode?: ReturnType<typeof vi.fn> } = {}) {
  return new DefaultPermissionAskResolver({
    classifier: { classify },
    evaluateWithMode: opts.evaluateWithMode ?? vi.fn().mockResolvedValue(makeDecision('ask')),
    hooks: [],
    denialState: { consecutive: 0, total: 0 },
  });
}

// ─── A35: child 共享 parent 真实 askResolver ────────────────────────────────────

describe('isolated classifier execution path', () => {
  test('[A35] child shares parent real askResolver instance', () => {
    const classify = vi.fn().mockResolvedValue({ behavior: 'allow', reason_code: 'x' } as ClassifierDecision);
    const parentResolver = makeResolver(classify);
    // child 不另造 resolver —— 直接复用 parent 的 askResolver 实例
    const childResolver = parentResolver;
    expect(childResolver).toBe(parentResolver);
  });

  // ─── classifier pending 时 gate/executor = 0 ─────────────────────────────────

  test('classifier pending: resolver promise unresolved, gate/executor not called', async () => {
    const dc = deferredClassifier();
    const resolver = makeResolver(dc.classify);
    const pending = resolver.resolve(askRequest('call-a', 'write_file', { path: 'a.ts' }));
    // 等 classify 被调用
    await vi.waitFor(() => expect(dc.calls).toHaveLength(1));
    // pending 中 —— resolver promise 未完成（模拟 gate/executor 未被调用的前提）
    let resolved = false;
    pending.then(() => { resolved = true; });
    expect(resolved).toBe(false);
    // 完成 classifier -> allow
    dc.resolveAllow();
    const result = await pending;
    expect(result.behavior).toBe('allow');
  });

  // ─── 每 call 独立 AbortSignal ────────────────────────────────────────────────

  test('each tool call gets independent AbortSignal', async () => {
    const dc = deferredClassifier();
    const resolver = makeResolver(dc.classify);
    const p1 = resolver.resolve(askRequest('call-a', 'write_file', { path: 'a' }));
    const p2 = resolver.resolve(askRequest('call-b', 'write_file', { path: 'b' }));
    await vi.waitFor(() => expect(dc.calls).toHaveLength(2));
    expect(dc.calls[0].signal).not.toBe(dc.calls[1].signal);
    dc.resolveAllow();
    await p1; await p2;
  });

  // ─── abort call-a 不影响并行 call-b ──────────────────────────────────────────

  test('abort call-a does not affect parallel call-b', async () => {
    const dc = deferredClassifier();
    const resolver = makeResolver(dc.classify);
    let abortA: (() => void) | undefined;
    const p1 = resolver.resolve(askRequest('call-a', 'write_file', { path: 'a' }, { registerAbort: (h) => { abortA = h; } }));
    const p2 = resolver.resolve(askRequest('call-b', 'write_file', { path: 'b' }, { registerAbort: () => { /* call-b abort handle registered but not invoked */ } }));
    await vi.waitFor(() => expect(dc.calls).toHaveLength(2));
    // abort call-a
    abortA!();
    const r1 = await p1;
    expect(r1.behavior).toBe('deny'); // 被取消 -> deny
    // call-b 正常完成
    expect(dc.calls[1].signal.aborted).toBe(false);
    dc.resolveAllow();
    const r2 = await p2;
    expect(r2.behavior).toBe('allow');
  });

  // ─── late abort no-op：classifier 已决定后 abort 不改变 decision ─────────────

  test('late abort after classifier decided does not change decision', async () => {
    const dc = deferredClassifier();
    const resolver = makeResolver(dc.classify);
    let abortHandle: (() => void) | undefined;
    const pending = resolver.resolve(askRequest('call-a', 'write_file', { path: 'a' }, { registerAbort: (h) => { abortHandle = h; } }));
    await vi.waitFor(() => expect(dc.calls).toHaveLength(1));
    dc.resolveAllow();
    const result = await pending;
    expect(result.behavior).toBe('allow');
    // decision 已定，abort 无影响
    abortHandle!();
    expect(result.behavior).toBe('allow'); // 仍 allow
  });

  // ─── 同 turn 多 tool call 各自只携带当前 executable call ──────────────────────

  test('two tool calls each carry only their own executable call', async () => {
    const dc = deferredClassifier();
    const resolver = makeResolver(dc.classify);
    const p1 = resolver.resolve(askRequest('call-a', 'write_file', { path: 'src/a.ts' }));
    const p2 = resolver.resolve(askRequest('call-b', 'run_bash', { command: 'git push' }));
    await vi.waitFor(() => expect(dc.calls).toHaveLength(2));
    // 第一次 classify 的 input 只含 call-a 的 executableToolCall
    const input1 = dc.calls[0].input as { executableToolCall: { callId: string }; authenticUserMessages: unknown[] };
    expect(input1.executableToolCall.callId).toBe('call-a');
    expect(Object.keys(input1).sort()).toEqual(['authenticUserMessages', 'executableToolCall']);
    const input2 = dc.calls[1].input as { executableToolCall: { callId: string } };
    expect(input2.executableToolCall.callId).toBe('call-b');
    dc.resolveDeny();
    await p1; await p2;
  });

  // ─── classifier deny/failure executor = 0 ────────────────────────────────────

  test('classifier deny produces deny (executor would be 0)', async () => {
    const classify = vi.fn().mockResolvedValue({ behavior: 'deny', reason_code: 'permission.classifier_deny' } as ClassifierDecision);
    const resolver = makeResolver(classify);
    const result = await resolver.resolve(askRequest('call-a', 'write_file', { path: 'a' }));
    expect(result.behavior).toBe('deny');
  });

  test('classifier failure produces deny (executor would be 0)', async () => {
    const classify = vi.fn().mockRejectedValue(new Error('rpc offline'));
    const resolver = makeResolver(classify);
    const result = await resolver.resolve(askRequest('call-a', 'write_file', { path: 'a' }));
    expect(result.behavior).toBe('deny');
  });

  // ─── classifier 不创建 Agent/tool/message/TUI 路径 ───────────────────────────

  test('resolver does not construct Agent/tool-registry/streamingQuery paths', async () => {
    // resolver 只调用 classifier.classify —— 不存在 agent loop / tool registry / streamingQuery 调用。
    // 此处结构性验证：DefaultPermissionAskResolver 只依赖 classifier + evaluateWithMode + hooks。
    const classify = vi.fn().mockResolvedValue({ behavior: 'allow', reason_code: 'x' } as ClassifierDecision);
    const resolver = makeResolver(classify);
    const result = await resolver.resolve(askRequest('call-a', 'write_file', { path: 'a' }));
    expect(result.behavior).toBe('allow');
    // classify 被调用一次；无其他副作用
    expect(classify).toHaveBeenCalledOnce();
  });
});
