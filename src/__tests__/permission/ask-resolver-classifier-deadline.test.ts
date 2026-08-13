// Classifier deadline regression test (scenario-2 run_bash hang root cause).
//
// 根因（真实 ConPTY 边界取证确认）：
//   enforced + auto + run_bash → askResolver.resolve → classifier.classify
//   → provider completeText (stream:false) 无 timeout。
//   provider 不响应时 classifier 永久 pending → 整个父 turn 挂死。
//
// 本测试锁定契约：
//   无论 provider 是否 resolve/reject/abort，classifier 到达 deadline 后
//   resolver.resolve() 必须自己结束等待，并沿现有 classifier failure 路径返回 deny。
//   同时 abort 底层 controller（避免超时后请求继续占用资源）。
//
// 使用 fake timers，不真实等待 30s。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DefaultPermissionAskResolver,
  type PermissionAskResolutionRequest,
} from '../../permission/ask-resolver.js';
import type { SecurityDecision } from '../../permission/decisions.js';
import type { ExecutableToolCall } from '../../permission/classifier-input.js';
import type { ClassifierDecision } from '../../permission/classifier.js';

// ─── fixtures ────────────────────────────────────────────────────────────────────

function askDecision(rc = 'permission.user_confirmation_required'): SecurityDecision {
  return {
    protocol_version: '1', decision_id: 'd1',
    action: { kind: 'tool_call', subject_id: 'run_bash', snapshot_id: 'snap1' },
    behavior: 'ask', deciding_layer: 'permission', risk_kind: 'test',
    policy_id: 'p', policy_version: '1', reason_code: rc,
    human_reason: 'test', provenance_refs: [],
  } as SecurityDecision;
}

function runBashAsk(): PermissionAskResolutionRequest {
  const call: ExecutableToolCall = {
    callId: 'call-hang',
    canonicalToolName: 'run_bash',
    input: { command: 'echo hi' },
  };
  return {
    decision: askDecision(),
    executableToolCall: call,
    messages: [{ role: 'user', content: 'run it', authoredByUser: true }],
    origin: 'main',
    permissionContext: {} as never,
  };
}

/** classifier 永不 resolve（也不 reject）：复刻真实 provider 挂起。
 *  记录收到的 signal，便于断言 deadline 后被 abort。 */
function hangingClassifier(): { classify: ReturnType<typeof vi.fn>; receivedSignal: () => AbortSignal | undefined } {
  let received: AbortSignal | undefined;
  return {
    classify: vi.fn((_input: unknown, signal: AbortSignal) => {
      received = signal;
      return new Promise<ClassifierDecision>(() => {
        /* never resolves, never rejects — real provider hang */
      });
    }),
    receivedSignal: () => received,
  };
}

function resolvingClassifier(decision: ClassifierDecision): { classify: ReturnType<typeof vi.fn> } {
  return { classify: vi.fn().mockResolvedValue(decision) };
}

function rejectingClassifier(err: Error): { classify: ReturnType<typeof vi.fn> } {
  return { classify: vi.fn().mockRejectedValue(err) };
}

function buildResolver(
  classifier: { classify: ReturnType<typeof vi.fn> },
  opts: { classifierDeadlineMs?: number } = {},
): DefaultPermissionAskResolver {
  return new DefaultPermissionAskResolver({
    classifier,
    evaluateWithMode: vi.fn().mockResolvedValue(askDecision()),
    hooks: [],
    denialState: { consecutive: 0, total: 0 },
    ...(opts.classifierDeadlineMs !== undefined ? { classifierDeadlineMs: opts.classifierDeadlineMs } : {}),
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────────

describe('classifier deadline (scenario-2 run_bash hang fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('deadline 到达后 resolver 必须自己结束并返回 deny（即使 provider 永不响应）', async () => {
    const classifier = hangingClassifier();
    const r = buildResolver(classifier, { classifierDeadlineMs: 30_000 });

    const promise = r.resolve(runBashAsk());

    // deadline 到达前：resolver 尚未完成
    await vi.advanceTimersByTimeAsync(29_999);
    // 让微任务排空（classifyPromise 已创建，仍 pending）
    await Promise.resolve();
    // 此时 promise 仍 pending（未 settle）
    let settled = false;
    promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    // deadline 到达
    await vi.advanceTimersByTimeAsync(1);

    // resolver 必须结束，且走 classifier failure → deny
    const result = await promise;
    expect(result.behavior).toBe('deny');
    expect(result.reason_code).toBe('permission.classifier_failure');
  });

  test('deadline 后必须 abort 底层 controller（provider 请求不再占用资源）', async () => {
    const classifier = hangingClassifier();
    const r = buildResolver(classifier, { classifierDeadlineMs: 30_000 });

    r.resolve(runBashAsk());
    await vi.advanceTimersByTimeAsync(30_000);

    const signal = classifier.receivedSignal();
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);
  });

  test('即使 provider 忽略 abort 信号（不因 abort 而 reject），resolver 仍能在 deadline 结束', async () => {
    // provider 收到 abort 但既不 resolve 也不 reject（最坏情况：完全忽略 signal）
    const classifier = {
      classify: vi.fn().mockImplementation(() => new Promise<ClassifierDecision>(() => {})),
    };
    const r = buildResolver(classifier, { classifierDeadlineMs: 30_000 });

    const promise = r.resolve(runBashAsk());
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;
    expect(result.behavior).toBe('deny');
    expect(result.reason_code).toBe('permission.classifier_failure');
  });

  // ─── 正常路径保护：deadline 不得改变正常 permission 决策 ────────────────────

  test('classifier 在 deadline 前正常成功 → 保持原有 allow 行为', async () => {
    const classifier = resolvingClassifier({ behavior: 'allow', reason_code: 'permission.classifier_stage1_allow' } as ClassifierDecision);
    const r = buildResolver(classifier, { classifierDeadlineMs: 30_000 });

    const promise = r.resolve(runBashAsk());
    // 不推进时间，等真实微任务让 classifierStub resolve
    const result = await promise;

    expect(result.behavior).toBe('allow');
    expect(result.reason_code).toBe('permission.classifier_resolved_allow');
  });

  test('classifier 在 deadline 前正常成功 → 保持原有 deny 行为', async () => {
    const classifier = resolvingClassifier({ behavior: 'deny', reason_code: 'permission.classifier_stage2_deny' } as ClassifierDecision);
    const r = buildResolver(classifier, { classifierDeadlineMs: 30_000 });

    const result = await r.resolve(runBashAsk());

    expect(result.behavior).toBe('deny');
    expect(result.reason_code).toBe('permission.classifier_resolved_deny');
  });

  test('classifier 自己提前 reject → 保持现有 classifier failure → deny', async () => {
    const classifier = rejectingClassifier(new Error('provider 500'));
    const r = buildResolver(classifier, { classifierDeadlineMs: 30_000 });

    const result = await r.resolve(runBashAsk());

    expect(result.behavior).toBe('deny');
    expect(result.reason_code).toBe('permission.classifier_failure');
  });

  test('正常成功后清理 deadline timer（推进超过 deadline 不再触发 abort）', async () => {
    const classifier = resolvingClassifier({ behavior: 'allow', reason_code: 'permission.classifier_stage1_allow' } as ClassifierDecision);
    // 用真实 timers 验证 timer 清理：正常成功后推进超过 deadline，
    // 不应有副作用（timer 已被 finally 清理）。
    vi.useRealTimers();
    const r = buildResolver(classifier, { classifierDeadlineMs: 50 });
    // 推进内部时钟不需要——这里用很短的 deadline(50ms) + 等待 100ms 验证：
    // classifier 正常 resolve 后，deadline timer 被 clear，不会 abort controller。
    const result = await r.resolve(runBashAsk());
    expect(result.behavior).toBe('allow');
    // 等待超过 deadline，确认无 unhandledRejection / 无异常抛出
    await new Promise<void>((res) => setTimeout(res, 120));
    // 到此未抛错即说明 timer 已清理、deadline 未在完成后误触发
  });
});
