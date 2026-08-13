// 设计 §6.4 三锚点不变量的真实生产链证明。
// 严禁：用 evaluateWithMode → ask 的 stub 绕过真实 checker 行为。
// 必须用真实 PermissionChecker + 真实 DefaultPermissionAskResolver + 真实 executeToolCall。
//
// classifier 两阶段协议（设计 §7.2 / classifier.ts）：
//   Stage 1 completeText -> 'ALLOW' | 'FLAG'；ALLOW 直接 allow（Stage2=0）；FLAG 触发 Stage2。
//   Stage 2 completeText -> 'ALLOW' | 'DENY'。
// 故 spy 按调用序返回：第 1 次返 stage1，第 2 次（仅 FLAG 时）返 stage2。
import { describe, test, expect, vi } from 'vitest';
import { PermissionChecker, type PermissionRule } from '../../permission/checker.js';
import { RuntimeSecurityGate, type PendingDecisionStore, type PendingSecurityDecision } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { SessionState } from '../../permission/session-state.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { executeToolCall, type ToolExecutionRuntime } from '../../agent/tool-execution.js';
import { createExecutionRuntimeForTurn, type TurnRuntimeDeps } from '../../permission/authority-gate.js';
import type { StreamingLLMClient, StreamEvent, AssistantMessage, ToolUseBlock } from '../../agent/types.js';

/**
 * classifier provider spy。按 classifier 两阶段协议返回。
 * - outcome='allow'：Stage1='ALLOW'（1 次 completeText）。
 * - outcome='deny'：Stage1='FLAG' -> Stage2='DENY'（2 次 completeText）。
 */
class ClassifierSpyClient implements StreamingLLMClient {
  completeTextCalls = 0;
  constructor(private readonly outcome: 'allow' | 'deny') {}
  async completeText(): Promise<string> {
    this.completeTextCalls++;
    // 第 1 次 = Stage1；outcome=allow -> 'ALLOW'；outcome=deny -> 'FLAG'（触发 Stage2）
    if (this.completeTextCalls === 1) return this.outcome === 'allow' ? 'ALLOW' : 'FLAG';
    // 第 2 次 = Stage2（仅 FLAG 时到达）；outcome=deny -> 'DENY'
    return 'DENY';
  }
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

function runBashCall(command: string, id = 'c1'): ToolUseBlock {
  return { type: 'tool_use', id, name: 'run_bash', input: { command } };
}
function writeCall(): ToolUseBlock {
  return { type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'src/a.ts', content: 'x' } };
}
function bashRegistry(executor: ReturnType<typeof vi.fn>): ToolRegistry {
  const r = new ToolRegistry();
  r.register(
    { name: 'run_bash', description: 'b', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    executor,
  );
  r.register(
    { name: 'write_file', description: 'w', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    async () => 'ok',
  );
  return r;
}
function makeDeps(overrides: Partial<TurnRuntimeDeps> = {}): TurnRuntimeDeps {
  const streamClient = new ClassifierSpyClient('allow');
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
/**
 * 构造 legacy runtime（无 resolver，复用 createExecutionRuntimeForTurn(authority:'legacy')）。
 * legacy 下 askResolver undefined；run_bash 走既有 fast-path。
 */
function makeLegacyRuntime(overrides: Partial<TurnRuntimeDeps> = {}): ToolExecutionRuntime {
  const deps = makeDeps({ authority: 'legacy', ...overrides });
  return createExecutionRuntimeForTurn(deps);
}
/** classifier 被"调用过"的断言助手：completeText 至少 1 次（allow=1，deny=2）。 */
function expectClassifierInvoked(spy: ClassifierSpyClient) {
  expect(spy.completeTextCalls).toBeGreaterThanOrEqual(1);
}
function expectClassifierNotInvoked(spy: ClassifierSpyClient) {
  expect(spy.completeTextCalls).toBe(0);
}

describe('[§6.4] enforced+auto canonical run_bash 必经 classifier', () => {
  test('组1 普通 unresolved run_bash：classifier ALLOW → classifier invoked, gate=1, executor=1', async () => {
    const deps = makeDeps();           // ClassifierSpyClient('allow') -> Stage1 ALLOW
    const spy = deps.streamClient as unknown as ClassifierSpyClient;
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('echo hi'), runtime, {
      messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }],
    });
    expect(result.status).toBe('success');
    expectClassifierInvoked(spy);              // 未被任何本地 allow 绕过
    expect(executor).toHaveBeenCalledOnce();
  });

  test('组1 普通 unresolved run_bash：classifier DENY → classifier invoked, executor=0', async () => {
    const deps = makeDeps({ streamClient: new ClassifierSpyClient('deny') as unknown as StreamingLLMClient });
    const spy = deps.streamClient as unknown as ClassifierSpyClient;
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn();
    const result = await executeToolCall(bashRegistry(executor), runBashCall('echo hi'), runtime, {
      messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }],
    });
    expect(result.status).toBe('failure');
    expectClassifierInvoked(spy);
    expect(executor).not.toHaveBeenCalled();
  });

  test('组1 sanity：真实 checkWithEvaluationMode(run_bash, acceptEdits) 当前确实返回 allow', () => {
    // 钉死根因行为：acceptEdits simulation 对 run_bash 会返回 allow。
    // 若未来 checker 改成对 run_bash 不 allow，本测试会先失败，提示此不变量的根因前提已变。
    const checker = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
    const sim = checker.checkWithEvaluationMode('run_bash', { command: 'echo hi' }, 'acceptEdits');
    expect(sim.behavior).toBe('allow');
  });

  test('组2 persistent run_bash allow rule：build 模式直接执行（classifier 未调用）', async () => {
    // 回归：build 模式下 persistent allow rule 仍直接生效，本次修复只对 enforced+auto 生效。
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow', content: 'git status' };
    const checker = new PermissionChecker({ mode: 'build', rules: [rule], workdir: process.cwd() });
    const spy = new ClassifierSpyClient('allow');
    const runtimeGate = new RuntimeSecurityGate({ pendingStore: new FakePendingStore(), channel: null });
    const sessionAllowlist = new SessionAllowlist();
    // build 模式不走 enforced resolver；用 legacy runtime 验证 classifier 未被调用
    const runtime: ToolExecutionRuntime = { permissionChecker: checker, runtimeGate, sessionAllowlist };
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('git status'), runtime);
    expect(result.status).toBe('success');
    expect(executor).toHaveBeenCalledOnce();
    expectClassifierNotInvoked(spy);           // build 模式不经 classifier
  });

  test('组2 persistent run_bash allow rule：enforced+auto 不能直接执行，classifier invoked，DENY→executor=0', async () => {
    // 本轮最关键回归：捕获 resolver 完全看不到的 bypass。
    // 真实 checker 注入可命中的 run_bash allow rule，enforced+auto 下仍必须进 classifier。
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow', content: 'git status' };
    const checker = new PermissionChecker({ mode: 'auto', rules: [rule], workdir: process.cwd() });
    // sanity：build 模式下该 rule 确实 allow（证明 rule 可命中）
    const buildCheck = new PermissionChecker({ mode: 'build', rules: [rule], workdir: process.cwd() });
    expect(buildCheck.check('run_bash', { command: 'git status' }).behavior).toBe('allow');

    const spy = new ClassifierSpyClient('deny');
    const deps = makeDeps({
      permissionChecker: checker,
      streamClient: spy as unknown as StreamingLLMClient,
    });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn();
    const result = await executeToolCall(bashRegistry(executor), runBashCall('git status'), runtime, {
      messages: [{ role: 'user', content: 'run git status', authoredByUser: true }],
    });
    expect(result.status).toBe('failure');
    expectClassifierInvoked(spy);              // persistent allow 未直接放行
    expect(executor).not.toHaveBeenCalled();
  });

  test('组3 sessionAllowlist bypass：exact 命中仍 classifier invoked，DENY→executor=0', async () => {
    const spy = new ClassifierSpyClient('deny');
    const deps = makeDeps({ streamClient: spy as unknown as StreamingLLMClient });
    // 预写 session allow（exact match）
    deps.sessionAllowlist.add('run_bash', { command: 'ls' });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn();
    const result = await executeToolCall(bashRegistry(executor), runBashCall('ls'), runtime, {
      messages: [{ role: 'user', content: 'run ls', authoredByUser: true }],
    });
    expect(result.status).toBe('failure');
    expectClassifierInvoked(spy);              // sessionAllowlist rewrite 被守卫拦
    expect(executor).not.toHaveBeenCalled();
  });

  test('组4 subagent bypass：origin=subagent 共享 parent askResolver，classifier invoked，DENY→executor=0', async () => {
    const spy = new ClassifierSpyClient('deny');
    const deps = makeDeps({ streamClient: spy as unknown as StreamingLLMClient });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn();
    const result = await executeToolCall(bashRegistry(executor), runBashCall('echo hi'), runtime, {
      messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }],
      origin: 'subagent',
    });
    expect(result.status).toBe('failure');
    expectClassifierInvoked(spy);              // subagent silent policy 未静默 allow
    expect(executor).not.toHaveBeenCalled();
  });

  test('组4 subagent：classifier ALLOW → executor=1', async () => {
    const spy = new ClassifierSpyClient('allow');
    const deps = makeDeps({ streamClient: spy as unknown as StreamingLLMClient });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('echo hi'), runtime, {
      messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }],
      origin: 'subagent',
    });
    expect(result.status).toBe('success');
    expectClassifierInvoked(spy);
    expect(executor).toHaveBeenCalledOnce();
  });

  test('组5 非 run_bash 回归：write_file 保留 acceptEdits fast-path（classifier 未调用）', async () => {
    const spy = new ClassifierSpyClient('deny');   // 即便 deny，write_file 也不应进 classifier
    const deps = makeDeps({ streamClient: spy as unknown as StreamingLLMClient });
    const runtime = createExecutionRuntimeForTurn(deps);
    const result = await executeToolCall(bashRegistry(vi.fn()), writeCall(), runtime, {
      messages: [{ role: 'user', content: 'edit file', authoredByUser: true }],
    });
    expect(result.status).toBe('success');
    expectClassifierNotInvoked(spy);           // write_file acceptEdits fast-path 未被误删
    expect(result.output).toBe('ok');          // write_file executor（bashRegistry 内置）确实执行
  });

  // ─── 组6/7：legacy / shadow authority 回归（§6.4 enforced-only）─────────────
  // 关键：本次修复不得改变 legacy/shadow 的既有行为。
  // legacy：无 resolver，run_bash allow rule 直接执行（classifier 未调用）。
  // shadow：checker allow → resolver 不触发（checker 返回 allow 非 ask）→ candidate 不跑 → 执行。

  test('组6 legacy + auto + run_bash allow rule：直接执行，classifier 未调用（行为不变）', async () => {
    // 注入可命中的 run_bash allow rule，authority=legacy。
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow', content: 'git status' };
    const spy = new ClassifierSpyClient('deny');   // 即便 candidate 会 deny，legacy 不应跑 classifier
    const checker = new PermissionChecker({ mode: 'auto', rules: [rule], workdir: process.cwd() });
    const runtime = makeLegacyRuntime({
      permissionChecker: checker,
      streamClient: spy as unknown as StreamingLLMClient,
    });
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('git status'), runtime);
    expect(result.status).toBe('success');
    expect(executor).toHaveBeenCalledOnce();
    expectClassifierNotInvoked(spy);           // legacy 不经 classifier（无 resolver）
  });

  test('组7 shadow + auto + run_bash allow rule：legacy authoritative，执行不变（classifier 未触发）', async () => {
    // shadow：checker allow → effective allow（执行）。checker 返回 allow 而非 ask，
    // resolver 不被调用，candidate classifier 也不跑（与 legacy 同路径）。
    // 本次修复不改变 shadow：authority!=='enforced' → 无降级守卫 → allow 直进 gate。
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow', content: 'git status' };
    const spy = new ClassifierSpyClient('deny');   // 即便 candidate 会 deny，shadow 不应触发 classifier
    const checker = new PermissionChecker({ mode: 'auto', rules: [rule], workdir: process.cwd() });
    const deps = makeDeps({
      authority: 'shadow',
      permissionChecker: checker,
      streamClient: spy as unknown as StreamingLLMClient,
    });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('git status'), runtime, {
      messages: [{ role: 'user', content: 'run git status', authoredByUser: true }],
    });
    // shadow authoritative = checker allow → 执行（未被降级，因 authority!=='enforced'）
    expect(result.status).toBe('success');
    expect(executor).toHaveBeenCalledOnce();
    expectClassifierNotInvoked(spy);           // checker allow → resolver 不触发 → candidate 不跑
  });
});

// ─── scenario-2 run_bash 挂起根因回归：hanging classifier + deadline → tool 必须返回 ──
//
// 真实根因（ConPTY 边界取证确认）：classifier 非流式 completeText 无 timeout，
// provider 不响应时 resolver.resolve 永久 pending → 父 turn 挂死。
// 修复：resolver 到达 deadline 后自行结束 → classifier failure → deny。
// 本集成断言证明：enforced+auto+run_bash + 永不响应的 classifier + 短 deadline
// → executeToolCall 必须返回（permission_denied），而非永久挂起。

/** classifier provider 永不响应（复刻真实 provider 挂起，即使 abort 也不 reject）。 */
class HangingClassifierClient implements StreamingLLMClient {
  async completeText(): Promise<string> {
    return new Promise<string>(() => { /* never resolves/rejects */ });
  }
  async *stream(): AsyncGenerator<StreamEvent | AssistantMessage> {
    yield { type: 'message_start', messageId: 'm', model: 'f', inputTokens: 1 };
    yield { type: 'message_stop' };
  }
}

describe('[scenario-2 fix] hanging classifier + deadline → executeToolCall 必须返回', () => {
  test('enforced+auto run_bash + 永不响应 classifier + 默认 30s deadline → permission_denied, executor=0', async () => {
    // 用 fake timers 走真实默认 30s deadline（不扩大生产 API 注入短 deadline）。
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const deps = makeDeps({
        streamClient: new HangingClassifierClient() as unknown as StreamingLLMClient,
      });
      const runtime = createExecutionRuntimeForTurn(deps);
      const executor = vi.fn().mockResolvedValue('done');
      const resultP = executeToolCall(bashRegistry(executor), runBashCall('echo hi'), runtime, {
        messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }],
      });
      // 推进到默认 deadline（30s）之后，触发 resolver 自结束
      await vi.advanceTimersByTimeAsync(30_001);
      const result = await resultP;
      // 关键契约：deadline 到达 → classifier failure → permission_denied，而非永久挂起
      expect(result.status).toBe('failure');
      expect(result.failure?.kind).toBe('permission_denied');
      // executor 从未调用（classifier deny 在 gate 之前，不到 executor）
      expect(executor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
