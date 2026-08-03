// Task 11: API Retry 与工具单次执行（A57-A63）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §9（retry）、§10 A57-A63。
//
// 锁定行为：
//   - retry 只用于 API/classifier RPC，工具 executor 绝不重试（A57）
//   - ordinary 400 不可重试；400 context overflow 可重试；529/429 可重试（A58）
//   - base delay cap 32000ms，jitter 后 [32000, 40000)，Retry-After 优先（A59）
//   - classifier 529 与 foreground 用同一 retry schedule（A60）
//   - classifier retry 固定复用同一已绑定 ModelRef（A60/A62/A63）
//   - streaming reconnect 保留当前 attempt number（A61）
//   - foreground 3 次 529 后 fallback；classifier 永不跨模型 fallback（A62）
//   - classifier retry 耗尽后 deny，reason_code = classifier_unavailable（A63）
//   - AbortError 不可重试（A58 补充）
//   - 同一 per-resolution AbortSignal 贯穿 provider RPC 和 retry sleep
//   - abort 后 retry wait 立即终止，后续 provider 调用不增加，不进 Stage 2/gate/executor
import { describe, test, expect, vi } from 'vitest';
import {
  getRetryDelay,
  isRetryableApiError,
  RetrySleeper,
  type RetrySleeperInterface,
} from '../../agent/backoff.js';
import {
  DefaultPermissionClassifier,
  type ClassifierDecision,
} from '../../permission/classifier.js';
import {
  type PermissionClassifierProvider,
  type ClassifierProviderRequest,
  type ClassifierProviderCapabilities,
} from '../../permission/classifier-provider.js';
import {
  DefaultClassifierModelPolicy,
  type ModelRef,
  type ClassifierModelContext,
} from '../../permission/classifier-model-policy.js';
import type { PermissionClassifierInput } from '../../permission/classifier-input.js';
import { executeToolCall, ToolOperationalError } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type { ToolUseBlock } from '../../agent/types.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function modelRef(id: string): ModelRef {
  return { providerId: 'test', modelId: id };
}

function modelContext(opts: {
  classifierModel?: string;
  selectable?: string[];
  sessionMainModel?: string;
}): ClassifierModelContext {
  const selectable = (opts.selectable ?? []).map(modelRef);
  return {
    classifierModel: opts.classifierModel !== undefined ? modelRef(opts.classifierModel) : undefined,
    staticallySelectableModels: selectable,
    sessionMainModel: modelRef(opts.sessionMainModel ?? 'main'),
  };
}

/** HTTP 错误（含 status 与 message） */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}
function httpError(status: number, message: string): HttpError {
  return new HttpError(status, message);
}
function http529(): HttpError {
  return new HttpError(529, 'Overloaded');
}
function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** 构造 classifier input（含一个 authentic user message） */
function classifierInput(): PermissionClassifierInput {
  return {
    authenticUserMessages: [
      { role: 'user', source: 'user', authoredByUser: true as const, content: 'edit src/a.ts' },
    ],
    executableToolCall: { callId: 'call-a', canonicalToolName: 'write_file', input: { path: 'src/a.ts' } },
  };
}

/** scripted provider：按脚本依次返回值或抛错 */
interface ScriptedProvider extends PermissionClassifierProvider {
  calls: ClassifierProviderRequest[];
  models: string[];
}
function scriptedProvider(
  script: Array<string | Error | { raw: unknown }>,
  options: { capabilities?: ClassifierProviderCapabilities } = {},
): ScriptedProvider {
  const calls: ClassifierProviderRequest[] = [];
  const models: string[] = [];
  let idx = 0;
  const caps: ClassifierProviderCapabilities = options.capabilities ?? {
    reasoningControl: false,
    decodingControl: false,
    promptCache: false,
  };
  return {
    capabilities: caps,
    async invoke(req: ClassifierProviderRequest): Promise<unknown> {
      calls.push(req);
      models.push(req.model.modelId);
      const step = script[idx++];
      if (step instanceof Error) throw step;
      if (typeof step === 'string') return step;
      if (step && typeof step === 'object' && 'raw' in step) return step.raw;
      return step;
    },
    get calls() { return calls; },
    get models() { return models; },
  };
}

/** 记录 delay 的 retrySleeper */
function recordingSleeper(): RetrySleeper & { delays: number[]; abortedWaits: number } {
  const delays: number[] = [];
  let abortedWaits = 0;
  return {
    async wait(delayMs: number, signal?: AbortSignal): Promise<void> {
      delays.push(delayMs);
      if (signal?.aborted) {
        abortedWaits++;
        throw abortError();
      }
      // 立即返回（测试不真正 sleep）
      return new Promise<void>((resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            abortedWaits++;
            reject(abortError());
          }, { once: true });
        }
        // 测试中立即 resolve（不真正等待）
        resolve();
      });
    },
    get delays() { return delays; },
    get abortedWaits() { return abortedWaits; },
  };
}

/** 可控 deferred sleeper：不自动 resolve，测试手动控制 */
interface DeferredSleeper extends RetrySleeper {
  pendingWaits: number;
  abortedWaits: number;
  resolveAll(): void;
}
function deferredSleeper(): DeferredSleeper {
  let pendingWaits = 0;
  let abortedWaits = 0;
  const waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  return {
    async wait(_delayMs: number, signal?: AbortSignal): Promise<void> {
      pendingWaits++;
      return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
        if (signal) {
          signal.addEventListener('abort', () => {
            abortedWaits++;
            reject(abortError());
          }, { once: true });
        }
      });
    },
    resolveAll() {
      while (waiters.length > 0) {
        waiters.shift()!.resolve();
      }
    },
    get pendingWaits() { return pendingWaits; },
    get abortedWaits() { return abortedWaits; },
  };
}

/** 运行 classifier 并收集 model 序列与 delays */
async function runClassifierWith(
  script: Array<string | Error | { raw: unknown }>,
  options: {
    boundModel?: string;
    fallbackModel?: string;
    retrySleeper?: RetrySleeperInterface;
    signal?: AbortSignal;
    random?: () => number;
  } = {},
): Promise<{ models: string[]; delays: number[]; decision: ClassifierDecision }> {
  const provider = scriptedProvider(script);
  const sleeper = options.retrySleeper ?? recordingSleeper();
  const boundModel = options.boundModel ?? 'classifier-model';
  const ctx = modelContext({
    classifierModel: boundModel,
    selectable: [boundModel, options.fallbackModel].filter(Boolean) as string[],
    sessionMainModel: options.fallbackModel ?? 'main',
  });
  const classifier = new DefaultPermissionClassifier({
    provider,
    modelPolicy: new DefaultClassifierModelPolicy(),
    modelContext: ctx,
    retrySleeper: sleeper,
    ...(options.random !== undefined ? { retryRandom: options.random } : {}),
  });
  const signal = options.signal ?? new AbortController().signal;
  const decision = await classifier.classify(classifierInput(), signal);
  return {
    models: provider.models,
    delays: 'delays' in sleeper ? (sleeper as { delays: number[] }).delays : [],
    decision,
  };
}

/** 运行 foreground retry（模拟 loop.ts 的 529 + backoff 路径）以收集 delays */
async function runForegroundWith(
  script: Array<string | Error>,
  options: { retrySleeper?: RetrySleeper; random?: () => number } = {},
): Promise<{ delays: number[] }> {
  const sleeper = options.retrySleeper ?? recordingSleeper();
  const random = options.random ?? Math.random;
  let idx = 0;
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const step = script[idx++];
    try {
      if (step instanceof Error) throw step;
      // success
      break;
    } catch (error) {
      if (attempt < maxRetries && isRetryableApiError(error)) {
        const delay = getRetryDelay(attempt, random);
        await sleeper.wait(delay);
      } else {
        throw error;
      }
    }
  }
  return { delays: 'delays' in sleeper ? (sleeper as { delays: number[] }).delays : [] };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until() timed out`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ─── A57: side-effect tool failure executes exactly once ──────────────────────

describe('[A57] side-effect tool failure executes exactly once', () => {
  test('failing tool executor is called exactly once (no retry)', async () => {
    // 用 ToolOperationalError 让 executeToolCall 分类为 failure（不 re-throw）。
    // executeToolCall 内部无 retry 逻辑——executor 失败后直接返回 failure。
    const write = vi.fn().mockRejectedValue(new ToolOperationalError('disk failure', 'EDISK'));
    const registry = new ToolRegistry();
    registry.register(
      { name: 'write_file', description: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
      write,
    );
    const call: ToolUseBlock = { type: 'tool_use', id: 'c1', name: 'write_file', input: { path: 'a.ts', content: 'x' } };
    const result = await executeToolCall(
      registry,
      call,
      createToolExecutionRuntime({ mode: 'build', rules: [{ tool: 'write_file', behavior: 'allow' }] }),
    );
    expect(write).toHaveBeenCalledOnce();
    expect(result.status).toBe('failure');
  });
});

// ─── A58: error retryability classification ───────────────────────────────────

describe('[A58] error retryability classification', () => {
  test('ordinary 400 is not retryable', () => {
    expect(isRetryableApiError(httpError(400, 'bad request'))).toBe(false);
  });

  test('400 context overflow is retryable', () => {
    expect(isRetryableApiError(httpError(400, 'context overflow'))).toBe(true);
  });

  test('429 is retryable', () => {
    expect(isRetryableApiError(httpError(429, 'Too Many Requests'))).toBe(true);
  });

  test('529 is retryable', () => {
    expect(isRetryableApiError(http529())).toBe(true);
  });

  test('AbortError is not retryable', () => {
    expect(isRetryableApiError(abortError())).toBe(false);
  });

  test('500 is not retryable', () => {
    expect(isRetryableApiError(httpError(500, 'internal server error'))).toBe(false);
  });
});

// ─── A59: retry delay cap + jitter + Retry-After ──────────────────────────────

describe('[A59] getRetryDelay base cap, jitter range, Retry-After', () => {
  test('base caps at 32000ms', () => {
    expect(getRetryDelay(20, () => 0)).toBe(32_000);
  });

  test('jitter stays below 40000ms', () => {
    const delay = getRetryDelay(20, () => 0.999);
    expect(delay).toBeGreaterThan(39_000);
    expect(delay).toBeLessThan(40_000);
  });

  test('Retry-After wins over computed delay', () => {
    expect(getRetryDelay(0, () => 0.5, 7_000)).toBe(7_000);
  });

  test('Retry-After of 0 or negative is ignored (uses computed delay)', () => {
    // 非正 Retry-After 不应覆盖计算延迟
    expect(getRetryDelay(0, () => 0, 0)).toBe(getRetryDelay(0, () => 0));
  });

  test('exponential growth up to cap', () => {
    expect(getRetryDelay(0, () => 0)).toBe(1_000);
    expect(getRetryDelay(1, () => 0)).toBe(2_000);
    expect(getRetryDelay(2, () => 0)).toBe(4_000);
    expect(getRetryDelay(3, () => 0)).toBe(8_000);
    expect(getRetryDelay(4, () => 0)).toBe(16_000);
    expect(getRetryDelay(5, () => 0)).toBe(32_000);
  });
});

// ─── A60: classifier 529 uses same retry schedule as foreground ───────────────

describe('[A60] classifier 529 uses the same retry schedule as foreground', () => {
  test('classifier and foreground produce identical delays for 529', async () => {
    // 两者用同一确定 random（=0.5），证明 delay 来自同一 getRetryDelay 公式
    const fixedRandom = () => 0.5;
    const classifierRun = await runClassifierWith([http529(), 'ALLOW'], {
      boundModel: 'classifier-model',
      random: fixedRandom,
    });
    const foregroundRun = await runForegroundWith([http529(), 'success'], { random: fixedRandom });
    expect(classifierRun.delays).toEqual(foregroundRun.delays);
  });

  test('classifier uses the same bound model for all retries', async () => {
    const result = await runClassifierWith([http529(), 'ALLOW'], {
      boundModel: 'classifier-model',
    });
    expect(result.models).toEqual(['classifier-model', 'classifier-model']);
  });
});

// ─── A61: retry attempt continuity ────────────────────────────────────────────

describe('[A61] retry attempt number stays continuous across retries', () => {
  test('delays grow exponentially (attempt 0,1,2... not reset)', async () => {
    // 用固定 random=0 证明 delay 纯由 attempt 决定（1000, 2000, 4000...）
    // 这间接证明 attempt number 连续递增，不在重试间重置
    const result = await runClassifierWith(
      [http529(), http529(), http529(), http529()],
      { boundModel: 'classifier-model', random: () => 0 },
    );
    // 4 次 529 -> 3 次 retry sleep（attempt 0,1,2），第 4 次耗尽 deny
    // getRetryDelay(0, =0) = 1000, getRetryDelay(1, =0) = 2000, getRetryDelay(2, =0) = 4000
    expect(result.delays).toEqual([1000, 2000, 4000]);
  });
});

// ─── A62: foreground fallback vs classifier never switches ────────────────────

describe('[A62] foreground fallback vs classifier never switches model', () => {
  test('classifier never cross-model fallbacks even after many 529s', async () => {
    const result = await runClassifierWith(
      [http529(), http529(), http529(), http529()],
      { boundModel: 'classifier-model', fallbackModel: 'forbidden-fallback' },
    );
    // 所有调用都用 classifier-model，永不切换到 fallback
    expect(result.models).toEqual(Array(result.models.length).fill('classifier-model'));
    expect(result.decision.behavior).toBe('deny');
  });

  test('unaborted classifier retry still uses the same bound ModelRef', async () => {
    const result = await runClassifierWith(
      [http529(), http529(), 'ALLOW'],
      { boundModel: 'classifier-model', fallbackModel: 'forbidden-fallback' },
    );
    expect(result.models).toEqual(['classifier-model', 'classifier-model', 'classifier-model']);
    expect(result.decision.behavior).toBe('allow');
  });
});

// ─── A63: exhausted classifier retry denies ───────────────────────────────────

describe('[A63] exhausted classifier retry stays on bound model then denies', () => {
  test('classifier denies with classifier_unavailable after exhausting retries', async () => {
    const result = await runClassifierWith(
      [http529(), http529(), http529(), http529()],
      { boundModel: 'classifier-model', fallbackModel: 'forbidden-fallback' },
    );
    expect(result.models).toEqual(Array(result.models.length).fill('classifier-model'));
    expect(result.decision).toMatchObject({
      behavior: 'deny',
      reason_code: 'permission.classifier_unavailable',
    });
  });
});

// ─── abort during retry wait ──────────────────────────────────────────────────

describe('classifier 529 backoff aborted mid-wait', () => {
  test('abort terminates retry wait, no further provider call, denies', async () => {
    const sleeper = deferredSleeper();
    const provider = scriptedProvider([http529()]);
    const controller = new AbortController();
    const ctx = modelContext({ classifierModel: 'classifier-model', selectable: ['classifier-model'] });
    const classifier = new DefaultPermissionClassifier({
      provider,
      modelPolicy: new DefaultClassifierModelPolicy(),
      modelContext: ctx,
      retrySleeper: sleeper,
    });
    const run = classifier.classify(classifierInput(), controller.signal);
    await until(() => provider.calls.length === 1);
    await until(() => sleeper.pendingWaits === 1);
    controller.abort();
    const decision = await run;
    expect(provider.calls).toHaveLength(1);
    expect(decision.behavior).toBe('deny');
    expect(sleeper.abortedWaits).toBeGreaterThanOrEqual(1);
  });

  test('provider RPC aborted via signal is not retried', async () => {
    // provider RPC 本身抛 AbortError（模拟 provider 内部因 signal abort 失败）。
    // AbortError 不触发 retry——provider 只调用一次，结果 deny。
    const provider = scriptedProvider([abortError()]);
    const controller = new AbortController();
    const ctx = modelContext({ classifierModel: 'classifier-model', selectable: ['classifier-model'] });
    const classifier = new DefaultPermissionClassifier({
      provider,
      modelPolicy: new DefaultClassifierModelPolicy(),
      modelContext: ctx,
    });
    // signal 未预先 abort——provider 被调用后抛 AbortError
    const decision = await classifier.classify(classifierInput(), controller.signal);
    expect(provider.calls).toHaveLength(1);
    expect(decision.behavior).toBe('deny');
  });
});

// ─── RetrySleeper: signal abort behavior ──────────────────────────────────────

describe('RetrySleeper signal abort behavior', () => {
  test('wait rejects immediately when signal already aborted', async () => {
    const sleeper = new RetrySleeper();
    const controller = new AbortController();
    controller.abort();
    await expect(sleeper.wait(1000, controller.signal)).rejects.toThrow();
  });

  test('wait rejects when signal aborts during sleep', async () => {
    const sleeper = new RetrySleeper();
    const controller = new AbortController();
    const promise = sleeper.wait(10000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  test('wait without signal completes normally', async () => {
    const sleeper = new RetrySleeper();
    // 用 0ms 避免实际等待
    await expect(sleeper.wait(0)).resolves.toBeUndefined();
  });
});
