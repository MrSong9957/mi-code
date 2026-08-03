// Task 4 Step 3: 两阶段 PermissionClassifier 状态机（A28、A29、A84 + 非消息化）
//
// 设计输入：§7.2（两阶段裁决协议）、§7.5（非消息化与生命周期）、§10 A28/A29/A84 重定义。
//
// classifier.ts 是唯一 decision parser + Stage1/Stage2 状态机：
//   - Stage 1：严格单个 ALLOW|FLAG；ALLOW -> allow（Stage2=0），FLAG -> Stage2 exactly once；
//   - Stage 2：严格单个 ALLOW|DENY；
//   - 任一 failure（额外文本/空白/JSON/unknown/timeout/provider/input-limit/protocol）-> deny；
//   - classify 最终类型只有 allow/deny，不返回 ask；
//   - 无 authentic user message -> provider 0 调用并 deny；
//   - classify(input, signal) 使用调用方传入的 per-resolution AbortSignal；
//   - 不创建 Agent/subagent/tool registry/streamingQuery/assistant/thinking/tool_result/TUI。
import { describe, test, expect } from 'vitest';
import {
  DefaultPermissionClassifier,
  parseStage1Decision,
  parseStage2Decision,
} from '../../permission/classifier.js';
import type { PermissionClassifierInput } from '../../permission/classifier-input.js';
import type { PermissionClassifierProvider, ClassifierProviderCapabilities } from '../../permission/classifier-provider.js';
import type { ClassifierModelPolicy, ModelRef, ClassifierModelContext } from '../../permission/classifier-model-policy.js';

// ─── fixture helpers ────────────────────────────────────────────────────────────

function modelRef(id: string): ModelRef {
  return { providerId: 'test', modelId: id };
}
function classifierInput(): PermissionClassifierInput {
  return {
    authenticUserMessages: [{ role: 'user', content: 'edit src/a.ts' }],
    executableToolCall: { callId: 'call-a', canonicalToolName: 'write_file', input: { path: 'a.ts' } },
  };
}
function inputWithoutAuthenticUser(): PermissionClassifierInput {
  return {
    authenticUserMessages: [],
    executableToolCall: { callId: 'call-a', canonicalToolName: 'write_file', input: { path: 'a.ts' } },
  };
}
function signal(): AbortSignal {
  return new AbortController().signal;
}
function unsupportedCaps(): ClassifierProviderCapabilities {
  return { reasoningControl: false, decodingControl: false, promptCache: false };
}

/**
 * scripted provider：按脚本依次返回 raw response。
 * 记录每次 invoke 的 stage/model/prefix/reasoning，供调用次数与一致性断言。
 */
function scriptedProvider(
  scripts: Array<string | Error>,
  caps: ClassifierProviderCapabilities = unsupportedCaps(),
): PermissionClassifierProvider & {
  calls: Array<{ stage: 1 | 2; model: ModelRef; prefix: string; reasoning?: string }>;
  callsForStage: (s: 1 | 2) => Array<{ stage: 1 | 2 }>;
} {
  const calls: Array<{ stage: 1 | 2; model: ModelRef; prefix: string; reasoning?: string }> = [];
  let idx = 0;
  const provider: PermissionClassifierProvider = {
    capabilities: caps,
    async invoke(req) {
      calls.push({ stage: req.stage, model: req.model, prefix: req.prefix, reasoning: req.reasoning });
      const next = scripts[idx++];
      idx = Math.min(idx, scripts.length); // 超出脚本范围重复最后一个（或抛）
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return Object.assign(provider, {
    calls,
    callsForStage: (s: 1 | 2) => calls.filter((c) => c.stage === s),
  });
}

/** 构造 classifier，注入 policy/provider/modelContext */
function classifier(opts: {
  provider: PermissionClassifierProvider;
  modelPolicy?: ClassifierModelPolicy;
  modelContext?: ClassifierModelContext;
  rules?: string[];
}): DefaultPermissionClassifier {
  return new DefaultPermissionClassifier({
    provider: opts.provider,
    modelPolicy:
      opts.modelPolicy ??
      ({
        selectStage1: (ctx) => ctx.sessionMainModel,
        selectStage2: (_ctx, s1) => s1,
      } as ClassifierModelPolicy),
    modelContext: opts.modelContext ?? { staticallySelectableModels: [], sessionMainModel: modelRef('main') },
    rules: opts.rules ?? [],
  });
}

// ─── 严格协议 parser 单测 ───────────────────────────────────────────────────────

describe('strict protocol parsers', () => {
  test('parseStage1Decision only accepts exact ALLOW or FLAG', () => {
    expect(parseStage1Decision('ALLOW')).toBe('ALLOW');
    expect(parseStage1Decision('FLAG')).toBe('FLAG');
    // 以下全部抛 protocol failure
    expect(() => parseStage1Decision('ALLOW ')).toThrow(); // 尾部空白
    expect(() => parseStage1Decision(' ALLOW')).toThrow(); // 前导空白
    expect(() => parseStage1Decision('ALLOW\n')).toThrow(); // 换行
    expect(() => parseStage1Decision('ALLOW because safe')).toThrow(); // 额外文本
    expect(() => parseStage1Decision('')).toThrow(); // 空
    expect(() => parseStage1Decision('DENY')).toThrow(); // Stage1 不接受 DENY
    expect(() => parseStage1Decision('{"decision":"ALLOW"}')).toThrow(); // JSON
    expect(() => parseStage1Decision(123 as never)).toThrow(); // 非字符串
    expect(() => parseStage1Decision(null as never)).toThrow();
  });

  test('parseStage2Decision only accepts exact ALLOW or DENY', () => {
    expect(parseStage2Decision('ALLOW')).toBe('ALLOW');
    expect(parseStage2Decision('DENY')).toBe('DENY');
    expect(() => parseStage2Decision('FLAG')).toThrow(); // Stage2 不接受 FLAG
    expect(() => parseStage2Decision('DENY extra')).toThrow();
    expect(() => parseStage2Decision('')).toThrow();
    expect(() => parseStage2Decision('ALLOW\n')).toThrow();
  });
});

// ─── 两阶段状态机 ───────────────────────────────────────────────────────────────

describe('two-stage permission classifier', () => {
  test('[A29] Stage 1 ALLOW returns allow with zero Stage 2 calls', async () => {
    const provider = scriptedProvider(['ALLOW']);
    const result = await classifier({ provider }).classify(classifierInput(), signal());
    expect(result.behavior).toBe('allow');
    expect(provider.callsForStage(1)).toHaveLength(1);
    expect(provider.callsForStage(2)).toHaveLength(0);
  });

  test('[A29] Stage 1 FLAG invokes Stage 2 exactly once with same prefix and model', async () => {
    const provider = scriptedProvider(['FLAG', 'ALLOW']);
    const mc: ClassifierModelContext = {
      staticallySelectableModels: [modelRef('bound-model')],
      sessionMainModel: modelRef('bound-model'),
    };
    const result = await classifier({ provider, modelContext: mc }).classify(classifierInput(), signal());
    expect(result.behavior).toBe('allow');
    expect(provider.callsForStage(2)).toHaveLength(1);
    // 同 prefix（Stage1/Stage2 共用不可变输入前缀）
    expect(provider.calls[1].prefix).toBe(provider.calls[0].prefix);
    // 同模型（Stage2 默认复用 Stage1 绑定）
    expect(provider.calls.map((c) => c.model.modelId)).toEqual(['bound-model', 'bound-model']);
    // Stage2 reasoning 可启用（此处 caps unsupported 故无 reasoning 字段；只断言调用次数）
  });

  test('auto works with only the session main model available', async () => {
    const provider = scriptedProvider(['FLAG', 'ALLOW']);
    const mc: ClassifierModelContext = {
      staticallySelectableModels: [modelRef('main-expensive')],
      sessionMainModel: modelRef('main-expensive'),
    };
    const result = await classifier({ provider, modelContext: mc }).classify(classifierInput(), signal());
    expect(result.behavior).toBe('allow');
    expect(provider.calls.map((c) => c.model.modelId)).toEqual(['main-expensive', 'main-expensive']);
  });

  test('[A28] every Stage 1 failure denies (extra text/empty/JSON/timeout/provider error)', async () => {
    const failures: Array<string | Error> = [
      '', // 空
      'DENY', // Stage1 不接受 DENY
      'ALLOW\n', // 换行
      'ALLOW because safe', // 额外文本
      '{"decision":"ALLOW"}', // JSON
      new Error('provider timeout'), // provider error
      new Error('input limit exceeded'), // input-limit
    ];
    for (const script of failures) {
      const provider = scriptedProvider([script]);
      const result = await classifier({ provider }).classify(classifierInput(), signal());
      expect(result.behavior, String(script)).toBe('deny');
    }
  });

  test('[A28] every Stage 2 failure denies and never changes the bound model', async () => {
    // Stage1 FLAG -> Stage2 failure
    const provider = scriptedProvider(['FLAG', new Error('stage2 rpc failed')]);
    const mc: ClassifierModelContext = {
      staticallySelectableModels: [modelRef('explicit-secure')],
      sessionMainModel: modelRef('explicit-secure'),
    };
    const result = await classifier({ provider, modelContext: mc }).classify(classifierInput(), signal());
    expect(result.behavior).toBe('deny');
    // 模型未跨阶段切换
    expect(provider.calls.map((c) => c.model.modelId)).toEqual(['explicit-secure', 'explicit-secure']);
  });

  test('[A28] unavailable explicit model denies before provider call without fallback', async () => {
    const provider = scriptedProvider(['ALLOW']);
    // 显式模型不可选 -> selectStage1 抛错 -> deny，provider 0 调用
    const policy: ClassifierModelPolicy = {
      selectStage1: () => {
        throw new Error('model unavailable');
      },
      selectStage2: (_c, s1) => s1,
    };
    const result = await classifier({ provider, modelPolicy: policy }).classify(classifierInput(), signal());
    expect(result.behavior).toBe('deny');
    expect(provider.calls).toHaveLength(0);
  });

  test('[A84] strict protocol matrix returns only allow or deny with exact call counts', async () => {
    const cases = [
      { script: ['ALLOW'], behavior: 'allow' as const, stages: [1] },
      { script: ['FLAG', 'ALLOW'], behavior: 'allow' as const, stages: [1, 2] },
      { script: ['FLAG', 'DENY'], behavior: 'deny' as const, stages: [1, 2] },
      { script: ['FLAG', 'DENY extra'], behavior: 'deny' as const, stages: [1, 2] },
    ];
    for (const sample of cases) {
      const provider = scriptedProvider(sample.script);
      const result = await classifier({ provider }).classify(classifierInput(), signal());
      expect(result.behavior, String(sample.script)).toBe(sample.behavior);
      expect(provider.calls.map((c) => c.stage)).toEqual(sample.stages);
      // classifier 最终类型不含 ask
      expect(result.behavior).not.toBe('ask');
    }
  });

  test('[A84] no authentic user message denies with provider and output sinks untouched', async () => {
    const provider = scriptedProvider(['ALLOW']);
    const result = await classifier({ provider }).classify(inputWithoutAuthenticUser(), signal());
    expect(result.behavior).toBe('deny');
    expect(result.reason_code).toBe('permission.classifier_missing_user_authorization');
    // provider 0 调用
    expect(provider.calls).toHaveLength(0);
  });

  test('Stage 1 FLAG -> Stage 2 DENY returns deny', async () => {
    const provider = scriptedProvider(['FLAG', 'DENY']);
    const result = await classifier({ provider }).classify(classifierInput(), signal());
    expect(result.behavior).toBe('deny');
    expect(provider.callsForStage(2)).toHaveLength(1);
  });

  test('classifier returns frozen ClassifierDecision', async () => {
    const provider = scriptedProvider(['ALLOW']);
    const result = await classifier({ provider }).classify(classifierInput(), signal());
    expect(Object.isFrozen(result)).toBe(true);
  });
});
