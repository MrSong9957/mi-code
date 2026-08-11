// streamingQuery 的 L4 压缩接入测试
//
// 物理本质：验证"办公桌满了会自动请临时秘书(小模型)整理"。
// 主模型是日常办公的员工，小模型是被叫来帮忙整理桌子的秘书。
// 这个测试验证：桌子堆满(>100KB)时，秘书真的被叫来了，而不是只在墙上贴张告示。
import { describe, it, expect, vi } from 'vitest';
import { streamingQuery } from '../agent/streaming-query.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import * as backoff from '../agent/backoff.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
  ContentBlock,
} from '../agent/types.js';
import { createToolExecutionRuntime } from './helpers/tool-execution-runtime.js';
import { StreamEventBus } from '../agent/stream-event-bus.js';

/**
 * 录制式流式 fake client。
 * 物理本质：一个"按剧本念台词"的演员——你给它一沓台词卡(每张是一轮要念的内容)，
 * 它一张张念出来。念的台词会原样变成 AssistantMessage 事件。
 */
/** 脚本块：ContentBlock 或 thinking 块（测试用，thinking 不在 ContentBlock 联合里） */
type ScriptBlock = ContentBlock | { type: 'thinking'; thinking: string };

class ScriptedStreamClient implements StreamingLLMClient {
  private callCount = 0;
  constructor(private scripts: ScriptBlock[][]) {}

  get calls(): number {
    return this.callCount;
  }

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    const blocks = this.scripts[this.callCount++] ?? [];
    yield { type: 'message_start', messageId: `msg_${this.callCount}`, model: 'fake', inputTokens: 1 };
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as ContentBlock | { type: 'thinking'; thinking: string };
      if (block.type === 'text') {
        yield { type: 'content_block_start', index: i, blockType: 'text' };
        yield { type: 'content_block_delta', index: i, deltaType: 'text', content: block.text };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'thinking') {
        yield { type: 'content_block_start', index: i, blockType: 'thinking' };
        yield { type: 'content_block_delta', index: i, deltaType: 'thinking', content: block.thinking };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, blockType: 'tool_use', blockId: block.id };
        // tool_use 的 input 以 JSON 流式发送
        const json = JSON.stringify(block.input);
        yield { type: 'content_block_delta', index: i, deltaType: 'input_json', content: json };
        yield { type: 'content_block_stop', index: i };
      }
    }
    yield { type: 'message_delta', stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', outputTokens: blocks.length };
    yield { type: 'message_stop' };

    // 发出完整 AssistantMessage（QueryEngine 依赖它产出 NormalizedMessage）
    // thinking 块不进 assistant content（真实 API 里 thinking 是独立块，这里只过滤给 content 用）
    const contentBlocks = blocks.filter((b): b is ContentBlock => b.type !== 'thinking');
    yield {
      type: 'assistant',
      content: contentBlocks,
      usage: { input_tokens: 1, output_tokens: blocks.length },
      stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      uuid: `asst_${this.callCount}`,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * 间谍式 client：记录是否被 stream 调用过。
 * 用来验证 compactClient（小模型）在 needsL4 时被触发。
 */
class SpyStreamClient implements StreamingLLMClient {
  streamCalled = false;
  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    this.streamCalled = true;
    yield { type: 'message_start', messageId: 'compact_1', model: 'small', inputTokens: 1 };
    yield { type: 'content_block_start', index: 0, blockType: 'text' };
    yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: 'Compacted summary.' };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
    yield { type: 'message_stop' };
    yield {
      type: 'assistant',
      content: [{ type: 'text', text: 'Compacted summary.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
      uuid: 'compact_asst',
      timestamp: new Date().toISOString(),
    };
  }
}

/** 构造一个注册了"返回超大结果"工具的 registry，用来撑爆上下文触发 needsL4 */
function makeRegistryWithBigTool(): ToolRegistry {
  const registry = new ToolRegistry();
  const bigDef: ToolDefinition = {
    name: 'big_output',
    description: 'Returns a huge string to bloat context',
    parameters: { type: 'object', properties: {} },
  };
  // 200KB 的工具结果，足以让 estimateContextSize 超过 100000 阈值
  const bigExec = async () => 'x'.repeat(200_000);
  registry.register(bigDef, bigExec);
  return registry;
}

/** 收集 generator 的所有产出 */
async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe('streamingQuery L4 压缩接入', () => {
  it('提供 compactClient 时，上下文爆满应触发小模型压缩', async () => {
    // 主模型剧本：第一轮调用 big_output 工具，第二轮返回纯文本结束
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'big_output', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const compactClient = new SpyStreamClient();
    const registry = makeRegistryWithBigTool();

    const ac = new AbortController();
    await drain(streamingQuery(mainClient, registry, 'do big thing', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      // A15 后 auto 模式 big_output 返回 ask；本测试验证 L4 压缩，显式 allow 以隔离权限。
      executionRuntime: createToolExecutionRuntime({ rules: [{ tool: 'big_output', behavior: 'allow' }] }),
      maxTurns: 5,
      enableStreamingExecution: false, // 走串行执行路径，更可控
      compactClient,
    }));

    // 核心断言：小模型被叫来整理了
    expect(compactClient.streamCalled).toBe(true);
  });

  it('未提供 compactClient 时，上下文爆满不崩溃（保持旧行为：仅警告）', async () => {
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'big_output', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const registry = makeRegistryWithBigTool();
    const ac = new AbortController();

    // 不传 compactClient → 应优雅降级，不抛错
    const results = await drain(streamingQuery(mainClient, registry, 'do big thing', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      executionRuntime: createToolExecutionRuntime(),
      maxTurns: 5,
      enableStreamingExecution: false,
    }));

    // 能正常产出消息流，没崩
    expect(results.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// thinking 块的事件序列（Thought for Ns 位置错乱 bug 的前提验证）
//
// 物理本质：Anthropic API 对每个 content block 产出精确边界事件：
//   content_block_start (blockType) → deltas → content_block_stop
// 模型回复顺序常为「thinking 块 → tool_use 块（无文本）」。
// 此时 thinking 块的 content_block_stop 是「思考结束」的精确信号，
// 且它在 tool_use 块的 content_block_start（→ emitToolCall → pipeline.emit tool_call）之前。
// 消费方（index.ts）应在 thinking 的 content_block_stop 时触发 thinking_end，
// 而非等 text delta（那会推迟到所有工具调用之后，导致位置错乱）。
// ════════════════════════════════════════════════════════════════════
describe('thinking 块事件序列（Thought for Ns 时序前提）', () => {
  it('thinking + tool_use 场景：thinking 的 content_block_stop 在 tool_use 相关事件之前', async () => {
    // 模拟模型「先思考，再调工具」（无文本）的真实序列
    const client = new ScriptedStreamClient([
      [
        { type: 'thinking', thinking: '分析问题，决定调用工具' } as { type: 'thinking'; thinking: string },
        { type: 'tool_use', id: 'call_1', name: 'big_output', input: {} },
      ],
      [{ type: 'text', text: '完成。' }],
    ]);
    const registry = makeRegistryWithBigTool();

    const ac = new AbortController();
    const events = await drain(streamingQuery(client, registry, 'do thing', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      executionRuntime: createToolExecutionRuntime(),
      maxTurns: 3,
      enableStreamingExecution: false,
    })) as Array<{ type: string; index?: number; blockType?: string }>;

    // 找 thinking 块的 content_block_stop 位置
    const thinkingStopIdx = events.findIndex(
      e => e.type === 'content_block_stop' && events.some(
        (ev, i) => i < events.indexOf(e) && ev.type === 'content_block_start' && ev.blockType === 'thinking',
      ),
    );
    // 找 tool_use 块的 content_block_start 位置
    const toolUseStartIdx = events.findIndex(
      e => e.type === 'content_block_start' && e.blockType === 'tool_use',
    );

    expect(thinkingStopIdx, '应有 thinking 块的 content_block_stop 事件').toBeGreaterThanOrEqual(0);
    expect(toolUseStartIdx, '应有 tool_use 块的 content_block_start 事件').toBeGreaterThanOrEqual(0);
    // 关键断言：thinking 结束信号在 tool_use 开始之前（保证 thinking_end 能在 tool_call 前 emit）
    expect(thinkingStopIdx, `thinking 的 content_block_stop(${thinkingStopIdx}) 应在 tool_use 的 content_block_start(${toolUseStartIdx}) 之前`).toBeLessThan(toolUseStartIdx);
  });
});

// ════════════════════════════════════════════════════════════════════
// 429 限流退避测试
//
// 物理本质：打电话遇到"对方占线(429)"，不能立刻重拨，得等一会。
// 否则对方(Anthropic API)会觉得你在轰炸它，加重限流甚至封禁。
// 这个测试验证：遇到 429 时，重试前真的 sleep 了一段时间（退避）。
// ════════════════════════════════════════════════════════════════════
describe('streamingQuery 429 限流退避', () => {
  /** 第一次调用抛 429 错误，第二次正常返回的 client */
  class RetryAfter429Client implements StreamingLLMClient {
    callCount = 0;
    async *stream(
      _messages: Message[],
      _tools: ToolDefinition[],
      _options: StreamOptions,
    ): AsyncGenerator<StreamEvent | AssistantMessage> {
      this.callCount++;
      if (this.callCount === 1) {
        throw new Error('429 rate_limit_exceeded: too many requests');
      }
      // 第二次：正常返回结束
      yield { type: 'message_start', messageId: 'msg_1', model: 'fake', inputTokens: 1 };
      yield { type: 'content_block_start', index: 0, blockType: 'text' };
      yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: 'OK after retry.' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
      yield { type: 'message_stop' };
      yield {
        type: 'assistant',
        content: [{ type: 'text', text: 'OK after retry.' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stopReason: 'end_turn',
        uuid: 'asst_1',
        timestamp: new Date().toISOString(),
      };
    }
  }

  it('遇到 429 错误时，重试前应调用 sleep 退避', async () => {
    // 用 spy 监视 backoff.sleep，避免真等（jitteredBackoff(0) 最多 1s）
    const sleepSpy = vi.spyOn(backoff, 'sleep').mockResolvedValue(undefined);

    const client = new RetryAfter429Client();
    const registry = new ToolRegistry();
    const ac = new AbortController();

    await drain(streamingQuery(client, registry, 'do thing', {
      systemPrompt: 'sys',
      tools: [],
      signal: ac.signal,
      maxTurns: 5,
      enableStreamingExecution: false,
    }));

    // 核心断言：429 重试前 sleep 被调用了
    expect(sleepSpy).toHaveBeenCalled();
    // handleError 会先 retryAttempt++（变 1），故第一次退避用 jitteredBackoff(1) = random(0, 2000)
    const delay = sleepSpy.mock.calls[0]?.[0];
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(2000);
    // client 被调用了两次（第一次失败 + 第二次成功）
    expect(client.callCount).toBe(2);

    sleepSpy.mockRestore();
  });

  it('非限流错误（如 unknown）不应触发 sleep 退避', async () => {
    // unknown 错误 handleError 返回 false（不可重试），不会到 continue/sleep 分支
    class UnknownErrorClient implements StreamingLLMClient {
      async *stream(): AsyncGenerator<StreamEvent | AssistantMessage> {
        // 在产出任何事件前就抛错；yield 仅为满足 AsyncGenerator 契约，永不实际到达
        throw new Error('something completely unexpected happened');
        yield { type: 'message_stop' } as StreamEvent;
      }
    }
    const sleepSpy = vi.spyOn(backoff, 'sleep').mockResolvedValue(undefined);

    const registry = new ToolRegistry();
    const ac = new AbortController();

    // unknown 错误不可恢复，应抛出
    await expect(
      drain(streamingQuery(new UnknownErrorClient(), registry, 'do thing', {
        systemPrompt: 'sys',
        tools: [],
        signal: ac.signal,
        maxTurns: 3,
        enableStreamingExecution: false,
      })),
    ).rejects.toThrow();

    // 非 429 错误不应触发 sleep
    expect(sleepSpy).not.toHaveBeenCalled();
    sleepSpy.mockRestore();
  });
});

describe('streamingQuery 用户取消', () => {
  it('provider 已开始后 abort 时以 user_abort 结束，不报告或重试 API 错误', async () => {
    class InFlightAbortClient implements StreamingLLMClient {
      calls = 0;
      private resolveStarted!: () => void;
      readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });

      async *stream(
        _messages: Message[],
        _tools: ToolDefinition[],
        options: StreamOptions,
      ): AsyncGenerator<StreamEvent | AssistantMessage> {
        this.calls++;
        yield { type: 'message_start', messageId: 'in_flight', model: 'fake', inputTokens: 1 };
        this.resolveStarted();
        await new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('API error: Request was aborted.')), { once: true });
        });
      }
    }

    const client = new InFlightAbortClient();
    const eventBus = new StreamEventBus();
    const errors: string[] = [];
    const loopEnds: string[] = [];
    eventBus.onError((event) => errors.push(event.message));
    eventBus.onLoopEnd((event) => loopEnds.push(event.reason));
    const controller = new AbortController();

    const running = drain(streamingQuery(client, new ToolRegistry(), 'cancel me', {
      systemPrompt: 'sys',
      tools: [],
      signal: controller.signal,
      maxTurns: 3,
      enableStreamingExecution: false,
      eventBus,
    }));
    await client.started;
    controller.abort();

    await expect(running).resolves.toHaveLength(1);
    expect(loopEnds).toEqual(['user_abort']);
    expect(errors).toEqual([]);
    expect(client.calls).toBe(1);
  });

  it('provider 在 abort 后正常结束 iterator 时仍以 user_abort 结束', async () => {
    class GracefulAbortClient implements StreamingLLMClient {
      calls = 0;
      private resolveStarted!: () => void;
      readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });

      async *stream(
        _messages: Message[],
        _tools: ToolDefinition[],
        options: StreamOptions,
      ): AsyncGenerator<StreamEvent | AssistantMessage> {
        this.calls++;
        yield { type: 'message_start', messageId: 'graceful_abort', model: 'fake', inputTokens: 1 };
        this.resolveStarted();
        await new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', resolve, { once: true });
        });
      }
    }

    const client = new GracefulAbortClient();
    const eventBus = new StreamEventBus();
    const errors: string[] = [];
    const loopEnds: string[] = [];
    eventBus.onError((event) => errors.push(event.message));
    eventBus.onLoopEnd((event) => loopEnds.push(event.reason));
    const controller = new AbortController();

    const running = drain(streamingQuery(client, new ToolRegistry(), 'cancel me', {
      systemPrompt: 'sys',
      tools: [],
      signal: controller.signal,
      maxTurns: 3,
      enableStreamingExecution: false,
      eventBus,
    }));
    await client.started;
    controller.abort();

    await expect(running).resolves.toHaveLength(1);
    expect(loopEnds).toEqual(['user_abort']);
    expect(errors).toEqual([]);
    expect(client.calls).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// AUTO-0030:end_turn 时 assistant 消息必须进 onMessages 回调
//
// 物理本质:LLM 以纯文本回复(无工具调用)收尾时,streamingQuery 的 finally
// 通过 onMessages 把 messages 数组甩给持久化层。原 bug:end_turn 提前 return
// 跳过了把 assistantMessages 合并进 messages 的步骤,导致 JSONL 只存 user 不存 assistant。
// ════════════════════════════════════════════════════════════════════
describe('AUTO-0030:end_turn 时 onMessages 应含 assistant 消息', () => {
  it('纯文本回复:end_turn 收尾,onMessages 收到的 messages 应含本轮 assistant', async () => {
    // 主模型剧本:单轮纯文本回复,end_turn
    const client = new ScriptedStreamClient([
      [{ type: 'text', text: '你好,这是回复。' }],
    ]);
    const registry = new ToolRegistry();
    const ac = new AbortController();

    let capturedMessages: Message[] | undefined;
    await drain(streamingQuery(client, registry, '你好', {
      systemPrompt: 'sys',
      tools: [],
      signal: ac.signal,
      maxTurns: 5,
      enableStreamingExecution: false,
      onMessages: (msgs) => { capturedMessages = msgs; },
    }));

    // 核心断言:onMessages 收到 2 条消息:user + assistant
    expect(capturedMessages).toBeDefined();
    expect(capturedMessages!.length).toBe(2);
    expect(capturedMessages![0].role).toBe('user');
    expect(capturedMessages![1].role).toBe('assistant');
    // assistant 内容是本轮回复的文本
    const asstContent = capturedMessages![1].content;
    expect(Array.isArray(asstContent)).toBe(true);
    const textBlock = (asstContent as ContentBlock[]).find(b => b.type === 'text') as { text: string } | undefined;
    expect(textBlock?.text).toBe('你好,这是回复。');
  });

  it('多轮工具调用:最后 end_turn 那轮的 assistant 也应进 messages', async () => {
    // 剧本:第一轮 tool_use,第二轮 纯文本 end_turn
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'echo', input: { x: 'hi' } }],
      [{ type: 'text', text: '完成。' }],
    ]);
    const registry = new ToolRegistry();
    const echoDef: ToolDefinition = {
      name: 'echo',
      description: 'echo input',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
    };
    registry.register(echoDef, async () => 'ok');
    const ac = new AbortController();

    let capturedMessages: Message[] | undefined;
    await drain(streamingQuery(client, registry, '做一下', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: ac.signal,
      executionRuntime: createToolExecutionRuntime(),
      maxTurns: 5,
      enableStreamingExecution: false,
      onMessages: (msgs) => { capturedMessages = msgs; },
    }));

    // 期望 4 条:user → assistant(tool_use) → user(tool_result) → assistant(text 结尾)
    expect(capturedMessages).toBeDefined();
    expect(capturedMessages!.length).toBe(4);
    expect(capturedMessages!.map(m => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ]);
    // 最后一条 assistant 应含本轮的「完成。」文本
    const lastAsst = capturedMessages![3];
    const textBlock = (lastAsst.content as ContentBlock[]).find(b => b.type === 'text') as { text: string } | undefined;
    expect(textBlock?.text).toBe('完成。');
  });
});

// ════════════════════════════════════════════════════════════════════
// 子代理工作日志 checkpoint seam:awaited onMessageCheckpoint
//
// 物理本质:子代理需要一个"每完成一条消息边界就落盘"的钩子,这样即使 provider
// 在下一轮崩溃,已完成的工作也能从 JSONL 日志恢复。这个钩子必须 awaited ——
// 落盘返回前不能启动下一轮 provider 调用(否则崩溃会抹掉未落盘的工作)。
// ════════════════════════════════════════════════════════════════════
describe('streamingQuery 子代理 checkpoint seam', () => {
  it('awaits a checkpoint after the completed tool round and final assistant', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
      },
      async input => String(input.value),
    );
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'tool-1', name: 'echo', input: { value: 'saved' } }],
      [{ type: 'text', text: 'final summary' }],
    ]);
    const snapshots: Message[][] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve; });

    const consume = (async () => {
      for await (const _ of streamingQuery(client, registry, 'work', {
        systemPrompt: 'test',
        tools: registry.getDefinitions(),
        signal: new AbortController().signal,
        // A15 后 auto 模式 echo 返回 ask；本测试验证 checkpoint seam，显式 allow 以隔离权限。
        executionRuntime: createToolExecutionRuntime({ rules: [{ tool: 'echo', behavior: 'allow' }] }),
        onMessageCheckpoint: async messages => {
          snapshots.push(structuredClone(messages) as Message[]);
          if (snapshots.length === 1) await firstWrite;
        },
      })) { /* consume */ }
    })();

    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    expect(snapshots[0]?.at(-1)?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'saved' },
    ]);
    expect(client.calls).toBe(1);

    releaseFirst();
    await consume;

    expect(snapshots.at(-1)?.at(-1)?.role).toBe('assistant');
    expect(snapshots.at(-1)?.at(-1)?.content).toEqual([
      { type: 'text', text: 'final summary' },
    ]);
  });

  it('does not start another provider turn when checkpoint persistence fails', async () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: 'echo', description: 'echo', parameters: { type: 'object' } },
      async () => 'saved',
    );
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'tool-1', name: 'echo', input: {} }],
      [{ type: 'text', text: 'must not run' }],
    ]);

    const consume = async () => {
      for await (const _ of streamingQuery(client, registry, 'work', {
        systemPrompt: 'test',
        tools: registry.getDefinitions(),
        signal: new AbortController().signal,
        executionRuntime: createToolExecutionRuntime(),
        onMessageCheckpoint: async () => {
          throw new Error('journal disk unavailable');
        },
      })) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow('journal disk unavailable');
    expect(client.calls).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// Stage 3 用户取消：父 provider 正常 EOF 后，等待/执行工具期间用户 abort。
//
// 物理本质：父流已经念完台词(正常 EOF, message_stop)，进入"等工具出结果"
// 的阶段(Stage 3)。此时用户 ESC。工具(或子代理)因共享 signal 迅速 resolve，
// 但 Stage 3 不应把这个 abort 后的结果当作成功 tool_result 发布——否则
// index.ts 的 onToolResult 会删掉 activeToolId、block-pipeline 标记 resolved，
// 后续 user_abort 无法再生成 cancelled ToolBlock。
//
// 区别于已有的"streamingQuery 用户取消"用例(那些 tools:[] / enableStreamingExecution:false
// 只覆盖 Stage 1 中途 abort，从不进入 Stage 3)和 verify-esc-subagent.cjs(保持
// 父连接打开，ESC 在 Stage 1)。本组覆盖 reviewer Critical：父正常 EOF + Stage 3。
//
// 覆盖 Stage 3 两个分支：
//   - streaming-executor 分支 (enableStreamingExecution: true)
//   - 传统串行分支 (enableStreamingExecution: false)
// ════════════════════════════════════════════════════════════════════
describe('streamingQuery Stage 3 用户取消（父 EOF 后等待工具期间 abort）', () => {
  /** 构造一个"进入后等 signal abort 才 resolve 成功结果"的工具 executor。
   *  模拟 spawn_agent 子代理在共享 signal abort 后以 user_abort 返回摘要文本——
   *  返回的是正常 string(executeToolCall 不抛错)，Stage 3 若不 guard 会当成功结果发布。 */
  function makeAbortAwaitingTool() {
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const executor = async (_input: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<string> => {
      resolveStarted();
      await new Promise<void>(resolve => {
        if (ctx?.signal?.aborted) resolve();
        else ctx?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return 'result produced after abort';
    };
    return { started, executor };
  }

  it('streaming-executor 分支：父正常 EOF 后 Stage 3 等待中 abort，不发布 abort 后的工具成功结果', async () => {
    const tool = makeAbortAwaitingTool();
    const registry = new ToolRegistry();
    registry.register(
      { name: 'slow_tool', description: 'resolves after abort', parameters: { type: 'object' } },
      tool.executor,
    );

    // 父：单轮 tool_use + 正常 EOF(message_stop)——关键区别于 ConPTY 脚本保持连接打开
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'tool-1', name: 'slow_tool', input: {} }],
    ]);

    const eventBus = new StreamEventBus();
    const emittedToolResults: string[] = [];
    const loopEnds: string[] = [];
    eventBus.onToolResult(event => emittedToolResults.push(event.toolUseId));
    eventBus.onLoopEnd(event => loopEnds.push(event.reason));

    const controller = new AbortController();
    const running = drain(streamingQuery(client, registry, 'do work', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: controller.signal,
      executionRuntime: createToolExecutionRuntime({ rules: [{ tool: 'slow_tool', behavior: 'allow' }] }),
      maxTurns: 3,
      enableStreamingExecution: true,
      eventBus,
    }));

    // 工具 executor 已在后台 in-flight（addTool → processQueue 已跑）。
    await tool.started;
    // macrotask 边界冲刷所有微任务：确保 streamingQuery 同步路径跑完
    // (for-await 退出 → :723 signal check → Stage 3 → getRemainingResults 阻塞)。
    // executor 在后台 microtask 中启动，需冲刷完才能确定 Stage 3 已在等待，
    // 否则 abort 可能被 :723 拦截而不进入 Stage 3（测试就不是真 RED）。
    await new Promise(resolve => setTimeout(resolve, 0));

    // 此时父已 EOF、Stage 3 在 getRemainingResults 等待 → 模拟用户 ESC
    controller.abort();
    const outputs = (await running) as Array<{ type: string; toolUseId?: string }>;

    // 核心：abort 后的工具成功结果不得通过 eventBus 发布
    expect(emittedToolResults, 'abort 后不应 emitToolResult').not.toContain('tool-1');
    // 也不得作为成功 tool_result 被 yield
    expect(outputs.filter(m => m.type === 'tool_result'), 'abort 后不应 yield tool_result').toHaveLength(0);
    // 正常以 user_abort 收尾
    expect(loopEnds).toEqual(['user_abort']);
  });

  it('传统串行分支：父正常 EOF 后 Stage 3 执行工具期间 abort，不发布 abort 后的工具成功结果', async () => {
    const tool = makeAbortAwaitingTool();
    const registry = new ToolRegistry();
    registry.register(
      { name: 'slow_tool', description: 'resolves after abort', parameters: { type: 'object' } },
      tool.executor,
    );

    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'tool-1', name: 'slow_tool', input: {} }],
    ]);

    const eventBus = new StreamEventBus();
    const emittedToolResults: string[] = [];
    const loopEnds: string[] = [];
    eventBus.onToolResult(event => emittedToolResults.push(event.toolUseId));
    eventBus.onLoopEnd(event => loopEnds.push(event.reason));

    const controller = new AbortController();
    const running = drain(streamingQuery(client, registry, 'do work', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: controller.signal,
      executionRuntime: createToolExecutionRuntime({ rules: [{ tool: 'slow_tool', behavior: 'allow' }] }),
      maxTurns: 3,
      enableStreamingExecution: false,
      eventBus,
    }));

    // 传统分支：executor 只在 Stage 3 executeToolCall(:861) 时才启动，
    // 故 started resolve 必定意味着已在 Stage 3、过了 :723。
    await tool.started;
    controller.abort();
    const outputs = (await running) as Array<{ type: string; toolUseId?: string }>;

    expect(emittedToolResults, 'abort 后不应 emitToolResult').not.toContain('tool-1');
    expect(outputs.filter(m => m.type === 'tool_result'), 'abort 后不应 yield tool_result').toHaveLength(0);
    expect(loopEnds).toEqual(['user_abort']);
  });
});
