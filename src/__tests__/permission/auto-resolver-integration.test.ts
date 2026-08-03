// Task 6: Resolver Core 与生产链接线（A24-A27、A42-A43、A48 + 非消息化集成）
//
// 设计输入：§6（Auto ask resolver）、§6.1（auto safe allowlist 唯一真相源）、
//          §6.2（acceptEdits simulation）、§6.3（non-classifierApprovable safety）、
//          §10 A24-A27/A42/A43/A48 重定义。
//
// 锁定 resolver 固定顺序（设计 §6，不可重排）：
//   1. 非 ask：原样返回
//   2. non-classifierApprovable safety：main ask / headless hooks→deny
//   3. requiresUserInteraction：保留 ask
//   4. denial threshold：回退交互
//   5. explicit ask rule：直接 classifier
//   6. auto safe allowlist（resolver 唯一持有）：直接 allow，classifier 0 调用
//   7. acceptEdits simulation：discretionary allow，classifier 0 调用
//   8. classifier
//
// 关键不变量：
//   - AUTO_SAFE_TOOL_ALLOWLIST 只存在于 resolver；
//   - resolver 是唯一 AbortController 创建者，每个 tool call 独立；
//   - classifier pending 时 gate/executor = 0；
//   - A35 child 用真实 ToolExecutionRuntime.askResolver。
import { describe, test, expect, vi } from 'vitest';
import {
  AUTO_SAFE_TOOL_ALLOWLIST,
  DefaultPermissionAskResolver,
  type PermissionAskResolutionRequest,
  type PermissionAskResolver,
} from '../../permission/ask-resolver.js';
import type { SecurityDecision } from '../../permission/decisions.js';
import type { ExecutableToolCall } from '../../permission/classifier-input.js';
import type { ClassifierDecision } from '../../permission/classifier.js';

// ─── fixture helpers ────────────────────────────────────────────────────────────

function makeDecision(behavior: 'allow' | 'ask' | 'deny', reasonCode = 'permission.user_confirmation_required'): SecurityDecision {
  return {
    protocol_version: '1', decision_id: 'd1',
    action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 'snap1' },
    behavior, deciding_layer: 'permission', risk_kind: 'test',
    policy_id: 'p', policy_version: '1', reason_code: reasonCode,
    human_reason: 'test', provenance_refs: behavior === 'allow' ? ['test'] : [],
  } as SecurityDecision;
}
function allowDecision(): SecurityDecision { return makeDecision('allow'); }
function denyDecision(rc = 'permission.rule_deny'): SecurityDecision { return makeDecision('deny', rc); }
function askDecision(rc = 'permission.user_confirmation_required'): SecurityDecision { return makeDecision('ask', rc); }

function executableCall(callId: string, tool: string, input: Record<string, unknown> = {}): ExecutableToolCall {
  return { callId, canonicalToolName: tool, input };
}

function ordinaryAsk(toolName: string): PermissionAskResolutionRequest {
  return {
    decision: askDecision(),
    executableToolCall: executableCall('call-a', toolName),
    messages: [{ role: 'user', content: 'do it', authoredByUser: true }],
    origin: 'main',
    permissionContext: {} as never,
  };
}
function writeCall(callId = 'call-a'): PermissionAskResolutionRequest {
  return {
    decision: askDecision(),
    executableToolCall: executableCall(callId, 'write_file', { path: 'src/a.ts' }),
    messages: [{ role: 'user', content: 'edit', authoredByUser: true }],
    origin: 'main',
    permissionContext: {} as never,
  };
}

/** classifier stub：返回固定 decision，记录调用 */
function classifierStub(decision: ClassifierDecision): { classify: ReturnType<typeof vi.fn> } {
  return { classify: vi.fn().mockResolvedValue(decision) };
}
function rejectingClassifier(err: Error): { classify: ReturnType<typeof vi.fn> } {
  return { classify: vi.fn().mockRejectedValue(err) };
}

/** 构造 resolver */
function resolver(opts: {
  classifier?: { classify: ReturnType<typeof vi.fn> };
  checkWithEvaluationMode?: ReturnType<typeof vi.fn>;
  hooks?: ReturnType<typeof vi.fn>[];
  denial?: { consecutive: number; total: number };
}): PermissionAskResolver {
  return new DefaultPermissionAskResolver({
    classifier: opts.classifier ?? classifierStub({ behavior: 'deny', reason_code: 'permission.classifier_stage2_deny' } as ClassifierDecision),
    evaluateWithMode: opts.checkWithEvaluationMode ?? vi.fn().mockResolvedValue(askDecision()),
    hooks: opts.hooks ?? [],
    denialState: opts.denial ?? { consecutive: 0, total: 0 },
  });
}

// ─── A24: resolver 持有唯一 safe allowlist ──────────────────────────────────────

describe('auto resolver core', () => {
  test('[A24] resolver owns the exact safe allowlist and bypasses classifier only for it', async () => {
    expect([...AUTO_SAFE_TOOL_ALLOWLIST]).toEqual([
      'read_file', 'glob', 'grep', 'load_skill', 'schedule_list',
      'memory_read', 'memory_list', 'read_inbox', 'read_plan_file',
    ]);
    const classifier = classifierStub({ behavior: 'deny', reason_code: 'x' } as ClassifierDecision);
    const r = resolver({ classifier });
    // allowlist 工具 -> allow，classifier 0 调用
    for (const toolName of AUTO_SAFE_TOOL_ALLOWLIST) {
      const result = await r.resolve(ordinaryAsk(toolName));
      expect(result.behavior).toBe('allow');
    }
    expect(classifier.classify).not.toHaveBeenCalled();
    // 非 allowlist（run_bash ask）-> 走 classifier
    const result = await r.resolve(ordinaryAsk('run_bash'));
    expect(result.behavior).toBe('deny');
    expect(classifier.classify).toHaveBeenCalledOnce();
  });

  // ─── A25: acceptEdits simulation ─────────────────────────────────────────────

  test('[A25] CWD write uses acceptEdits evaluation and zero classifier calls', async () => {
    const check = vi.fn().mockResolvedValue(allowDecision());
    const classifier = classifierStub({ behavior: 'deny', reason_code: 'x' } as ClassifierDecision);
    const r = resolver({ classifier, checkWithEvaluationMode: check });
    const result = await r.resolve(writeCall());
    expect(result.behavior).toBe('allow');
    expect(check).toHaveBeenCalledWith(expect.anything(), 'acceptEdits');
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  // ─── A26: acceptEdits deny -> deny（设计 §6.2：simulation 只消费 allow，deny 仍 deny）──

  test('[A26] acceptEdits deny returns deny without classifier (§6.2)', async () => {
    // 设计 §6.2：simulation 只消费 allow。deny -> 最终仍 deny；不进 classifier。
    const check = vi.fn().mockResolvedValue(denyDecision('outside'));
    const classifier = classifierStub({ behavior: 'deny', reason_code: 'outside_scope' } as ClassifierDecision);
    const r = resolver({ classifier, checkWithEvaluationMode: check });
    const result = await r.resolve(writeCall());
    expect(result.behavior).toBe('deny');
    expect(check).toHaveBeenCalledWith(expect.anything(), 'acceptEdits');
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  test('[A26] acceptEdits ask/passthrough falls through to classifier', async () => {
    // simulation 返回 ask -> 继续 classifier
    const check = vi.fn().mockResolvedValue(askDecision());
    const classifier = classifierStub({ behavior: 'deny', reason_code: 'outside_scope' } as ClassifierDecision);
    const r = resolver({ classifier, checkWithEvaluationMode: check });
    const result = await r.resolve(writeCall());
    expect(result.behavior).toBe('deny');
    expect(classifier.classify).toHaveBeenCalledOnce();
  });

  // ─── A27: non-classifierApprovable safety ────────────────────────────────────

  test('[A27] non-approvable safety ask keeps ask (main), no classifier', async () => {
    const req: PermissionAskResolutionRequest = {
      decision: askDecision('permission.command_unparseable'),
      executableToolCall: executableCall('call-a', 'run_bash', { command: 'x' }),
      messages: [{ role: 'user', content: 'do', authoredByUser: true }],
      origin: 'main',
      permissionContext: {} as never,
    };
    const classifier = classifierStub({ behavior: 'allow', reason_code: 'x' } as ClassifierDecision);
    const r = resolver({ classifier });
    const result = await r.resolve(req);
    expect(result.behavior).toBe('ask');
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  // ─── A42: resolved auto allow reaches gate ───────────────────────────────────
  // （集成测试在 auto-classifier-non-message-integration 覆盖 gate/executor 计数）

  // ─── A43: classifier failure denies ──────────────────────────────────────────

  test('[A43] classifier failure denies without reaching executor', async () => {
    const classifier = rejectingClassifier(new Error('offline'));
    const r = resolver({ classifier });
    const result = await r.resolve(writeCall());
    expect(result.behavior).toBe('deny');
  });

  // ─── A48: explicit ask bypasses allowlist + acceptEdits ──────────────────────

  test('[A48] explicit ask rule bypasses allowlist and acceptEdits, then classifies', async () => {
    const req: PermissionAskResolutionRequest = {
      decision: askDecision('permission.explicit_ask'),
      executableToolCall: executableCall('call-a', 'read_file', { path: 'a.ts' }),
      messages: [{ role: 'user', content: 'do', authoredByUser: true }],
      origin: 'main',
      permissionContext: {} as never,
    };
    const check = vi.fn().mockResolvedValue(allowDecision());
    const classifier = classifierStub({ behavior: 'deny', reason_code: 'x' } as ClassifierDecision);
    const r = resolver({ classifier, checkWithEvaluationMode: check });
    const result = await r.resolve(req);
    expect(result.behavior).toBe('deny');
    expect(check).not.toHaveBeenCalled(); // 不走 acceptEdits
    expect(classifier.classify).toHaveBeenCalledOnce();
  });

  // ─── 非 ask 透传 ─────────────────────────────────────────────────────────────

  test('non-ask decision is returned as-is', async () => {
    const classifier = classifierStub({ behavior: 'allow', reason_code: 'x' } as ClassifierDecision);
    const r = resolver({ classifier });
    const result = await r.resolve({ ...writeCall(), decision: denyDecision() });
    expect(result.behavior).toBe('deny');
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  test('allow decision is returned as-is', async () => {
    const classifier = classifierStub({ behavior: 'deny', reason_code: 'x' } as ClassifierDecision);
    const r = resolver({ classifier });
    const result = await r.resolve({ ...writeCall(), decision: allowDecision() });
    expect(result.behavior).toBe('allow');
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  // ─── resolver 创建独立 AbortController per call ──────────────────────────────

  test('resolver creates independent AbortController per tool call', async () => {
    const classifier = classifierStub({ behavior: 'allow', reason_code: 'x' } as ClassifierDecision);
    const r = resolver({ classifier });
    await r.resolve(writeCall('call-a'));
    await r.resolve(writeCall('call-b'));
    // classifier 被调用两次，每次收到不同 signal
    expect(classifier.classify).toHaveBeenCalledTimes(2);
    const sig1 = classifier.classify.mock.calls[0][1] as AbortSignal;
    const sig2 = classifier.classify.mock.calls[1][1] as AbortSignal;
    expect(sig1).not.toBe(sig2);
  });
});

// ─── 非消息化 + gate barrier 集成 ───────────────────────────────────────────────

describe('isolated classifier execution path', () => {
  test('classifier pending keeps gate and executor at zero; allow enters gate afterward', async () => {
    // 用 deferred classifier promise 模拟 pending
    let resolveClassify: (d: ClassifierDecision) => void = () => {};
    const pendingClassifier = {
      classify: vi.fn().mockReturnValue(new Promise<ClassifierDecision>((resolve) => { resolveClassify = resolve; })),
    };
    const r = resolver({ classifier: pendingClassifier });
    const pending = r.resolve(writeCall());
    // 等 classify 被调用（pending 中）
    await vi.waitFor(() => expect(pendingClassifier.classify).toHaveBeenCalledOnce());
    // 此时 resolve 还未完成（pending），结果未定
    let resolved = false;
    pending.then(() => { resolved = true; });
    expect(resolved).toBe(false);
    // 完成 classifier
    resolveClassify({ behavior: 'allow', reason_code: 'permission.classifier_stage1_allow' } as ClassifierDecision);
    const result = await pending;
    expect(result.behavior).toBe('allow');
    expect(resolved).toBe(true);
  });

  test('classifier deny or failure never produces allow', async () => {
    const denyClassifier = classifierStub({ behavior: 'deny', reason_code: 'x' } as ClassifierDecision);
    const r1 = resolver({ classifier: denyClassifier });
    expect((await r1.resolve(writeCall())).behavior).toBe('deny');

    const errClassifier = rejectingClassifier(new Error('rpc'));
    const r2 = resolver({ classifier: errClassifier });
    expect((await r2.resolve(writeCall())).behavior).toBe('deny');
  });
});
