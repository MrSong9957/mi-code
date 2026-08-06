import { describe, test, expect, vi } from 'vitest';
import { executeToolCall } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { StreamingToolExecutor } from '../../agent/streaming-executor.js';
import { createConfiguredExecutionRuntimeForTurn } from '../../permission/authority-gate.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { SessionState } from '../../permission/session-state.js';
import type { PendingSecurityDecision, PendingDecisionStore } from '../../permission/runtime-gate.js';
import type { ToolUseBlock } from '../../agent/types.js';

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

  // helpers (add inside the describe or above tests)
  function makeRuntime(opts: {
    dialogResult: { kind: 'approved_once' } | { kind: 'approved_session' } | { kind: 'approved_always' } | { kind: 'rejected' } | { kind: 'escape' };
    dialogDelayMs?: number;
    onSessionAllow?: (t: string, i: Record<string, unknown>) => void;
    onPersistRule?: (u: { type: 'addRules'; destination: string; rule: unknown }) => void;
    recheck?: (t: string, i: Record<string, unknown>) => { behavior: 'allow' | 'deny'; reason_code: string };
    classifierCompleteText?: () => Promise<string>;
    sessionAllowlist?: SessionAllowlist;
  }) {
    return createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient: opts.classifierCompleteText ? { completeText: opts.classifierCompleteText } as never : pendingClassifier(),
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: opts.sessionAllowlist ?? new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
      dialogProvider: async () => opts.dialogResult,
      dialogDelayMs: opts.dialogDelayMs ?? 0,
      onSessionAllow: opts.onSessionAllow,
      onPersistRule: opts.onPersistRule,
      recheck: opts.recheck,
    });
  }
  function runBashRegistry(executor = vi.fn().mockResolvedValue('ran')) {
    const r = new ToolRegistry();
    r.register({ name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } }, executor);
    return { registry: r, executor };
  }
  const userMsg = [{ role: 'user' as const, content: 'run echo hi', authoredByUser: true }];
  const bashCall = { type: 'tool_use' as const, id: 'c1', name: 'run_bash', input: { command: 'echo hi' } };

  test('#2 approved_session -> same SessionAllowlist hit', async () => {
    const sessionAllowlist = new SessionAllowlist();
    const runtime = makeRuntime({ dialogResult: { kind: 'approved_session' }, sessionAllowlist, onSessionAllow: (t, i) => sessionAllowlist.add(t, i) });
    const { registry } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(sessionAllowlist.has('run_bash', { command: 'echo hi' })).toBe(true);
    expect(sessionAllowlist.has('run_bash', { command: 'echo different' })).toBe(false);
  });

  test('#3 gate does NOT call legacy channel', async () => {
    const channelRequest = vi.fn(async () => ({ response: 'approved_once' }));
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced', streamClient: pendingClassifier(),
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: { request: channelRequest as never } }),
      sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
      dialogProvider: async () => ({ kind: 'approved_once' }), dialogDelayMs: 0,
    });
    const { registry } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(channelRequest).not.toHaveBeenCalled();
  });

  test('#4 approved_always -> persist + recheck(tool,input) + hard deny blocks executor', async () => {
    const onPersistRule = vi.fn();
    const recheck = vi.fn(() => ({ behavior: 'deny' as const, reason_code: 'permission.dangerous_command' }));
    const runtime = makeRuntime({ dialogResult: { kind: 'approved_always' }, onPersistRule, recheck });
    const { registry, executor } = runBashRegistry();
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(onPersistRule).toHaveBeenCalled();
    expect(recheck).toHaveBeenCalledWith('run_bash', { command: 'echo hi' });
    expect(executor).not.toHaveBeenCalled();
    expect(r.status).toBe('failure');
  });

  test('#5 escape -> classifier aborted + executor=0 + failure.code=user_cancelled', async () => {
    const classifierCalls: Array<{ signal: AbortSignal }> = [];
    const streamClient = {
      completeText: (r: { signal: AbortSignal }) => { classifierCalls.push({ signal: r.signal }); return new Promise<string>(() => {}); },
    } as never;
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced', streamClient,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
      dialogProvider: async () => ({ kind: 'escape' }), dialogDelayMs: 0,
    });
    const { registry, executor } = runBashRegistry();
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(classifierCalls[0]?.signal.aborted).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(r.status).toBe('failure');
    expect(r.failure?.code).toBe('permission.user_cancelled');
  });

  test('#6 rejected -> classifier aborted + executor=0 + failure.code=user_denied', async () => {
    const classifierCalls: Array<{ signal: AbortSignal }> = [];
    const streamClient = {
      completeText: (r: { signal: AbortSignal }) => { classifierCalls.push({ signal: r.signal }); return new Promise<string>(() => {}); },
    } as never;
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced', streamClient,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
      dialogProvider: async () => ({ kind: 'rejected' }), dialogDelayMs: 0,
    });
    const { registry, executor } = runBashRegistry();
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(classifierCalls[0]?.signal.aborted).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(r.status).toBe('failure');
    expect(r.failure?.code).toBe('permission.user_denied');
  });

  test('#7 classifier resolves inside delay -> dialog NOT invoked', async () => {
    let dialogCalls = 0;
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced', streamClient: { completeText: async () => 'ALLOW' } as never,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
      dialogProvider: async () => { dialogCalls++; return { kind: 'approved_once' }; }, dialogDelayMs: 5000,
    });
    const { registry, executor } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(dialogCalls).toBe(0);
    expect(executor).toHaveBeenCalled();
  });
});

function toolBlock(id: string, name: string, input: Record<string, unknown>): ToolUseBlock { return { type: 'tool_use', id, name, input }; }

async function schedulingScenario(secondTool: string) {
  let askCalls = 0;
  let pendingResolve: ((o: { kind: 'submitted'; answers: Record<string, string> }) => void) | null = null;
  let dialogSeenCancelled = false;
  const sharedMgr = {
    ask: async (_req: unknown) => {
      askCalls++;
      if (askCalls === 1) return new Promise<{ kind: 'submitted'; answers: Record<string, string> } | { kind: 'cancelled' }>((res) => { pendingResolve = res as () => void; });
      return { kind: 'submitted' as const, answers: {} };
    },
  };
  const dialogProvider = async (): Promise<{ kind: 'approved_once' } | { kind: 'escape' }> => {
    const o = await sharedMgr.ask({});
    if (o.kind === 'cancelled') { dialogSeenCancelled = true; return { kind: 'escape' }; }
    return { kind: 'approved_once' };
  };
  const runtime = createConfiguredExecutionRuntimeForTurn({
    authority: 'enforced', streamClient: { completeText: () => new Promise<string>(() => {}) } as never,
    providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
    permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
    runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
    sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
    dialogProvider, dialogDelayMs: 0,
  });
  const secondExec = vi.fn(async () => 'second-done');
  const runBashExec = vi.fn(async () => 'ran');
  const registry = new ToolRegistry();
  registry.register({ name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } }, runBashExec);
  registry.register({ name: secondTool, description: 's', parameters: { type: 'object' as const, properties: {}, required: [] as const } }, secondExec);
  const exec = new StreamingToolExecutor(registry, runtime, new AbortController().signal, 'main', [{ role: 'user', content: 'run echo hi', authoredByUser: true }]);

  exec.addTool(toolBlock('c1', 'run_bash', { command: 'echo hi' }));
  await new Promise((r) => setTimeout(r, 40));
  expect(askCalls, 'run_bash triggered exactly 1 askManager.ask').toBe(1);

  exec.addTool(toolBlock('c2', secondTool, {}));
  await new Promise((r) => setTimeout(r, 40));
  expect(secondExec, `${secondTool} NOT scheduled while permission pending`).not.toHaveBeenCalled();
  expect(askCalls, 'no 2nd askManager.ask during permission pending').toBe(1);
  expect(dialogSeenCancelled, 'permission dialog NOT cancelled (no preempt)').toBe(false);
  expect(runBashExec, 'run_bash not executed while dialog pending').not.toHaveBeenCalled();

  pendingResolve?.({ kind: 'submitted', answers: {} });
  await new Promise((r) => setTimeout(r, 200));
  expect(runBashExec, 'run_bash executed after dialog approved').toHaveBeenCalled();
}

describe('[auto-dialog] scheduling invariant (§7.3 #8)', () => {
  test('#8a: permission dialog pending blocks ask_user_question (no preempt)', async () => {
    await schedulingScenario('ask_user_question');
  }, 15000);
  test('#8b: permission dialog pending blocks exit_plan_mode (no preempt)', async () => {
    await schedulingScenario('exit_plan_mode');
  }, 15000);
});
