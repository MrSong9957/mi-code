// Task 11 补充：A61/A62 foreground streaming retry 真实路径验证
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §9、§10 A61/A62。
//
// 这两个测试针对真实的 streamingQuery retry 路径（不是 classifier delay 替代）：
//   - A61: streaming retry 期间 attempt number 连续递增，不重置
//   - A62: 连续 3 次 529 后 foreground 实际使用 fallback model
//
// 调用链证据（foreground fallback 当前是死代码）：
//   streaming-query.ts:450  new QueryEngine(client)  ← client 固定
//   streaming-query.ts:603  engine.submit(messages, queryOptions)
//   query-engine.ts:105     this.client.stream(messages, tools, options)  ← 无 model 参数
//   recovery.ts:184         state.currentModel = FALLBACK_MODEL  ← 从不被消费
//   types.ts:255            StreamingLLMClient.stream 签名无 model
//   types.ts:248            StreamOptions 无 model 字段
//
// 因此 A62 需要在 retry 时用 fallback model 构造新 client。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamingQuery, type StreamingQueryOptions } from '../../agent/streaming-query.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import * as backoffModule from '../../agent/backoff.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
} from '../../agent/types.js';

// ─── mock client：按脚本抛错或返回成功，记录所用 model ────────────────────────

type ScriptStep =
  | { kind: 'error'; error: Error }
  | { kind: 'text'; text: string };

/** 记录型 client：每次 stream 调用按脚本 step 执行，记录自己的 model 标签 */
class RecordingClient implements StreamingLLMClient {
  readonly modelLabel: string;
  private script: ScriptStep[];
  private callIndex = 0;
  readonly calls: number[] = []; // 每次调用的 index

  constructor(modelLabel: string, script: ScriptStep[]) {
    this.modelLabel = modelLabel;
    this.script = script;
  }

  get callCount(): number { return this.callIndex; }

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    const step = this.script[this.callIndex];
    this.calls.push(this.callIndex);
    this.callIndex++;
    if (!step) {
      // 脚本耗尽：返回空文本结束
      yield { type: 'message_start', messageId: `msg_${this.modelLabel}`, model: this.modelLabel, inputTokens: 1 };
      yield { type: 'content_block_start', index: 0, blockType: 'text' };
      yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: '' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
      yield { type: 'message_stop' };
      return;
    }
    if (step.kind === 'error') throw step.error;
    // text：正常流式返回
    yield { type: 'message_start', messageId: `msg_${this.modelLabel}`, model: this.modelLabel, inputTokens: 1 };
    yield { type: 'content_block_start', index: 0, blockType: 'text' };
    yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: step.text };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
    yield { type: 'message_stop' };
  }
}

function http529(): Error {
  const e = new Error('529 Overloaded');
  e.name = 'Error';
  return e;
}

/** 收集 streamingQuery 的所有 yield */
async function consumeStream(gen: AsyncGenerator): Promise<void> {
  for await (const _ of gen) void _;
}

// ─── mock backoff sleep 避免实际等待 ──────────────────────────────────────────

let sleepSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // 拦截 sleep 避免测试实际等待 backoff delay
  sleepSpy = vi.spyOn(backoffModule, 'sleep').mockResolvedValue(undefined);
});

afterEach(() => {
  sleepSpy?.mockRestore();
});

// ─── A62: foreground fallback model 真正接通 ──────────────────────────────────

describe('[A62] foreground fallback model activated after three 529s', () => {
  test('after three 529s, fourth request uses fallback model client', async () => {
    // 主 client：前 3 次 529，第 4 次无脚本（如果主 client 被调用第 4 次说明 fallback 没生效）
    const primaryClient = new RecordingClient('primary-model', [
      { kind: 'error', error: http529() },
      { kind: 'error', error: http529() },
      { kind: 'error', error: http529() },
    ]);
    // fallback client：返回成功文本
    const fallbackClient = new RecordingClient('fallback-model', [
      { kind: 'text', text: 'recovered via fallback' },
    ]);

    const clientForModel = vi.fn((model: string): StreamingLLMClient => {
      if (model === 'claude-3-5-haiku') return fallbackClient;
      return primaryClient;
    });

    const options: StreamingQueryOptions = {
      systemPrompt: 'test',
      tools: [],
      signal: new AbortController().signal,
      model: 'primary-model',
      clientForModel,
      maxTurns: 10,
    };

    await consumeStream(streamingQuery(primaryClient, new ToolRegistry(), 'hello', options));

    // 主 client 应被调用 3 次（全部 529）
    expect(primaryClient.callCount).toBe(3);
    // fallback client 应被调用至少 1 次（第 4 次请求用 fallback model）
    expect(fallbackClient.callCount).toBeGreaterThanOrEqual(1);
    // clientForModel 应被调用，请求 fallback model
    expect(clientForModel).toHaveBeenCalledWith('claude-3-5-haiku');
  });

  test('fewer than three 529s does not activate fallback', async () => {
    // 只 2 次 529，第 3 次成功——不应触发 fallback
    const primaryClient = new RecordingClient('primary-model', [
      { kind: 'error', error: http529() },
      { kind: 'error', error: http529() },
      { kind: 'text', text: 'success on third' },
    ]);
    const fallbackClient = new RecordingClient('fallback-model', []);

    const clientForModel = vi.fn((model: string): StreamingLLMClient => {
      if (model === 'claude-3-5-haiku') return fallbackClient;
      return primaryClient;
    });

    const options: StreamingQueryOptions = {
      systemPrompt: 'test',
      tools: [],
      signal: new AbortController().signal,
      model: 'primary-model',
      clientForModel,
      maxTurns: 10,
    };

    await consumeStream(streamingQuery(primaryClient, new ToolRegistry(), 'hello', options));

    // 主 client 恢复成功，fallback 从未被调用
    expect(fallbackClient.callCount).toBe(0);
    expect(clientForModel).not.toHaveBeenCalled();
  });
});

// ─── A61: streaming retry attempt 连续性 ──────────────────────────────────────

describe('[A61] streaming retry attempt number stays continuous', () => {
  test('retryAttempt increments across consecutive 529s without reset', async () => {
    // 通过 jitteredBackoff 的调用参数间接证明 attempt 连续递增。
    // jitteredBackoff(attempt) 传入的 attempt 值序列应为连续递增（不重置为 0）。
    // retry 不应消耗 turn 配额（A61 核心：attempt 连续 + turn 不被 retry 吃掉）。
    const backoffSpy = vi.spyOn(backoffModule, 'jitteredBackoff').mockReturnValue(0);

    const primaryClient = new RecordingClient('primary-model', [
      { kind: 'error', error: http529() },
      { kind: 'error', error: http529() },
      { kind: 'error', error: http529() },
      { kind: 'error', error: http529() }, // 第 4 次 529 超出 retry limit
    ]);

    const options: StreamingQueryOptions = {
      systemPrompt: 'test',
      tools: [],
      signal: new AbortController().signal,
      model: 'primary-model',
      maxTurns: 10, // 给足够 turn 空间，排除 maxTurns 干扰
    };

    try {
      await consumeStream(streamingQuery(primaryClient, new ToolRegistry(), 'hello', options));
    } catch {
      // 预期可能抛错（retry limit 耗尽）
    }

    // jitteredBackoff 应被调用 3 次，参数（attempt）连续递增：1, 2, 3
    const attemptArgs = backoffSpy.mock.calls.map((c) => c[0]);
    expect(attemptArgs).toEqual([1, 2, 3]);
    // provider 应被调用 4 次（3 次 retry + 第 4 次超限抛错）
    expect(primaryClient.callCount).toBe(4);

    backoffSpy.mockRestore();
  });
});
