// Task 4 Step 2: model policy + prompt + provider direct RPC（A33 + capability）
//
// 设计输入：§7.3（PermissionClassifierProvider 边界）、§7.4（ClassifierModelPolicy）、
//          §10 A33 重定义。
//
// 职责物理隔离：
//   - classifier-model-policy.ts：只选择并冻结模型，不调用 provider；
//   - classifier-prompt.ts：只构建固定 prefix / stage instruction；
//   - classifier-provider.ts：只做一次底层 direct provider RPC，返回 raw response，不解析。
import { describe, test, expect, vi } from 'vitest';
import {
  DefaultClassifierModelPolicy,
  ClassifierModelUnavailableError,
  type ClassifierModelContext,
} from '../../permission/classifier-model-policy.js';
import {
  buildClassifierPromptPrefix,
  buildClassifierSystemInstruction,
  renderClassifierRuleSections,
  STAGE1_INSTRUCTION,
  STAGE2_INSTRUCTION,
} from '../../permission/classifier-prompt.js';
import {
  buildClassifierProviderRequest,
  unsupportedClassifierCapabilities,
  normalizeStaticClassifierCapabilities,
  type ClassifierProviderCapabilities,
  type ClassifierProviderRequest,
  type PermissionClassifierProvider,
} from '../../permission/classifier-provider.js';
import type { ModelRef } from '../../permission/classifier-model-policy.js';
import type { PermissionClassifierInput } from '../../permission/classifier-input.js';

// ─── fixture helpers ────────────────────────────────────────────────────────────

function modelRef(id: string): ModelRef {
  return { providerId: 'test', modelId: id };
}
function modelContext(opts: {
  classifierModel?: string;
  fastModel?: string;
  selectable?: string[];
  sessionMainModel?: string;
}): ClassifierModelContext {
  const selectable = (opts.selectable ?? []).map(modelRef);
  return {
    classifierModel: opts.classifierModel !== undefined ? modelRef(opts.classifierModel) : undefined,
    providerFastClassifierModel: opts.fastModel !== undefined ? modelRef(opts.fastModel) : undefined,
    staticallySelectableModels: selectable,
    sessionMainModel: modelRef(opts.sessionMainModel ?? 'main'),
  };
}
function staticCapabilities(
  overrides: Partial<ClassifierProviderCapabilities> = {},
): ClassifierProviderCapabilities {
  return {
    reasoningControl: false,
    decodingControl: false,
    promptCache: false,
    ...overrides,
  };
}
function classifierInput(): PermissionClassifierInput {
  return {
    authenticUserMessages: [{ role: 'user', content: 'edit src/a.ts' }],
    executableToolCall: { callId: 'call-a', canonicalToolName: 'write_file', input: { path: 'a.ts' } },
  };
}
function signal(): AbortSignal {
  return new AbortController().signal;
}

// ─── model policy（A33 不覆盖；显式不可用 deny；fast advisory；Stage2 复用）────────

describe('classifier model binding and provider adapter', () => {
  const policy = new DefaultClassifierModelPolicy();

  test('explicit classifierModel binds exactly and unavailable explicit model does not fallback', () => {
    expect(
      policy.selectStage1(modelContext({ classifierModel: 'secure-review', selectable: ['secure-review'] })),
    ).toEqual(modelRef('secure-review'));
    // 显式模型不可选 -> 抛错（不静默 fallback）；classifier 据此 deny
    expect(() =>
      policy.selectStage1(
        modelContext({ classifierModel: 'missing', selectable: [], sessionMainModel: 'main-expensive' }),
      ),
    ).toThrow(ClassifierModelUnavailableError);
  });

  test('static fast model is advisory; known-unselectable fast model falls back to session main', () => {
    // fast 可选 -> 用 fast
    expect(policy.selectStage1(modelContext({ fastModel: 'fast-safe', selectable: ['fast-safe'] }))).toEqual(
      modelRef('fast-safe'),
    );
    // fast 不可选 -> 回退 session main
    expect(
      policy.selectStage1(modelContext({ fastModel: 'fast-missing', selectable: [], sessionMainModel: 'main' })),
    ).toEqual(modelRef('main'));
    // 无 fast -> session main
    expect(policy.selectStage1(modelContext({ sessionMainModel: 'main' }))).toEqual(modelRef('main'));
  });

  test('Stage 2 defaults to the exact Stage 1 binding', () => {
    const stage1 = modelRef('bound-model');
    expect(policy.selectStage2(modelContext({ sessionMainModel: 'changed-main' }), stage1)).toBe(stage1);
  });

  test('selectStage1 returns frozen ModelRef', () => {
    const ref = policy.selectStage1(modelContext({ sessionMainModel: 'main' }));
    expect(Object.isFrozen(ref)).toBe(true);
  });

  // ─── capability 静态声明 ─────────────────────────────────────────────────────

  test('unknown/missing capabilities are unsupported and normalized without discovery RPC', () => {
    expect(unsupportedClassifierCapabilities()).toEqual({
      reasoningControl: false,
      decodingControl: false,
      promptCache: false,
    });
    // undefined -> unsupported
    expect(normalizeStaticClassifierCapabilities(undefined)).toEqual(unsupportedClassifierCapabilities());
    // 已声明 -> 透传
    const caps = staticCapabilities({ reasoningControl: true, minimumOutputTokens: 2, decodingControl: true });
    expect(normalizeStaticClassifierCapabilities(caps)).toMatchObject({
      reasoningControl: true,
      minimumOutputTokens: 2,
      decodingControl: true,
    });
  });

  // ─── provider request 构建：supported/unsupported hints ───────────────────────

  test('unsupported capabilities omit reasoning/maxOutputTokens/temperature hints', () => {
    const req = buildClassifierProviderRequest(
      1,
      modelRef('main'),
      'prefix',
      signal(),
      unsupportedClassifierCapabilities(),
    );
    expect(req.reasoning).toBeUndefined();
    expect(req.maxOutputTokens).toBeUndefined();
    expect(req.temperature).toBeUndefined();
  });

  test('supported hints are translated: Stage1 disables reasoning, Stage2 enables', () => {
    const caps = staticCapabilities({ reasoningControl: true, minimumOutputTokens: 2, decodingControl: true });
    const stage1 = buildClassifierProviderRequest(1, modelRef('main'), 'prefix', signal(), caps);
    expect(stage1.reasoning).toBe('disabled');
    expect(stage1.maxOutputTokens).toBe(2);
    expect(stage1.temperature).toBe(0);
    const stage2 = buildClassifierProviderRequest(2, modelRef('main'), 'prefix', signal(), caps);
    expect(stage2.reasoning).toBe('enabled');
  });

  test('minimum output budget uses provider-declared minimum, including value 1', () => {
    const capsMin1 = staticCapabilities({ reasoningControl: true, minimumOutputTokens: 1, decodingControl: true });
    const capsMin8 = staticCapabilities({ reasoningControl: true, minimumOutputTokens: 8, decodingControl: true });
    expect(
      buildClassifierProviderRequest(1, modelRef('m'), 'p', signal(), capsMin1).maxOutputTokens,
    ).toBe(1);
    expect(
      buildClassifierProviderRequest(1, modelRef('m'), 'p', signal(), capsMin8).maxOutputTokens,
    ).toBe(8);
  });

  // ─── prompt：固定 prefix + stage instruction ─────────────────────────────────

  test('[A33] trusted user rules replace defaults and both stages reuse one prefix', () => {
    // 非空 user 段替换 defaults；空 user 段回退 defaults
    expect(renderClassifierRuleSections({ defaults: ['D'], organization: ['O'], user: ['U'] })).toEqual(['U', 'O']);
    expect(renderClassifierRuleSections({ defaults: ['D'], organization: ['O'], user: [] })).toEqual(['D', 'O']);
    const prompt = buildClassifierPromptPrefix(classifierInput());
    const si1 = buildClassifierSystemInstruction(STAGE1_INSTRUCTION, ['U', 'O']);
    const si2 = buildClassifierSystemInstruction(STAGE2_INSTRUCTION, ['U', 'O']);
    const stage1 = buildClassifierProviderRequest(1, modelRef('main'), prompt, signal(), staticCapabilities(), si1);
    const stage2 = buildClassifierProviderRequest(2, modelRef('main'), prompt, signal(), staticCapabilities(), si2);
    // prompt (data region) shared across stages
    expect(stage1.prefix).toBe(stage2.prefix);
    // system instruction contains additional rules
    expect(stage1.instruction).toContain('U');
    expect(stage1.instruction).toContain('O');
    expect(STAGE1_INSTRUCTION).toContain('ALLOW');
    expect(STAGE1_INSTRUCTION).toContain('FLAG');
    expect(STAGE2_INSTRUCTION).toContain('ALLOW');
    expect(STAGE2_INSTRUCTION).toContain('DENY');
  });

  test('decision protocol is enum-based and makes no tokenizer/byte promise', () => {
    // instruction 不承诺固定 token/byte 数；只约束单枚举
    expect(STAGE1_INSTRUCTION).not.toMatch(/token/i);
    expect(STAGE1_INSTRUCTION).not.toMatch(/byte/i);
    expect(STAGE2_INSTRUCTION).not.toMatch(/token/i);
    expect(STAGE2_INSTRUCTION).not.toMatch(/byte/i);
  });

  test('prefix is frozen immutable', () => {
    const prefix = buildClassifierPromptPrefix(classifierInput());
    expect(Object.isFrozen(prefix)).toBe(true);
  });
});

// ─── provider direct RPC：返回 raw response，不解析 ──────────────────────────────

describe('PermissionClassifierProvider direct RPC', () => {
  test('invoke returns raw response string, does not parse ALLOW/FLAG', async () => {
    // provider 包装一个 fake text client，返回 raw 'ALLOW\nextra'
    const fakeTextClient = {
      completeText: vi.fn().mockResolvedValue('ALLOW\nextra'),
    };
    const provider: PermissionClassifierProvider = {
      capabilities: unsupportedClassifierCapabilities(),
      invoke: async (req) => {
        return fakeTextClient.completeText(req);
      },
    };
    const req: ClassifierProviderRequest = buildClassifierProviderRequest(
      1,
      modelRef('main'),
      'prefix',
      signal(),
      unsupportedClassifierCapabilities(),
    );
    const raw = await provider.invoke(req);
    // 返回 raw response，未解析（含额外文本）；解析由 classifier.ts 负责
    expect(raw).toBe('ALLOW\nextra');
    expect(fakeTextClient.completeText).toHaveBeenCalledWith(req);
  });

  test('provider does not hold ToolRegistry/RuntimeSecurityGate/Agent state', () => {
    // PermissionClassifierProvider 接口结构上只有 capabilities + invoke，
    // 不接受 ToolRegistry/RuntimeSecurityGate/messageSink/TuiCallback
    const provider: PermissionClassifierProvider = {
      capabilities: unsupportedClassifierCapabilities(),
      invoke: async () => 'ALLOW',
    };
    expect(provider.capabilities).toBeDefined();
    expect(typeof provider.invoke).toBe('function');
  });
});
