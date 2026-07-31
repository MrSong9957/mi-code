/**
 * GRC-1 §7.26 / Wave G Task 10 — streamingQuery post-compact reconstruction
 * cutover 集成测试。
 *
 * 这一段测试覆盖 StreamingQueryOptions.postCompactReconstruction hook 的接入行为:
 *
 *   5. streamingQuery 不传 postCompactReconstruction → 走旧路径(LEGACY)
 *   6. streamingQuery 传 postCompactReconstruction → 每轮阶段 4 后调用 hook
 *   7. hook 返回 restored_snapshot + next_messages → 替换 messages(onMessages 可见)
 *   8. hook 抛错 → 静默失败,messages 不变(不抛错给 generator)
 *   9. hook 返回 null restored_snapshot → 不替换(LEGACY 行为)
 *   10. completed tool executor 调用次数不增加(reconstruction 不重新执行已完成工具)
 *
 * 关键不变量(spec §7.26 / §7.21):
 *   - LEGACY:不传 hook → 行为完全不变(向后兼容)。
 *   - 失败静默:hook 抛错绝不传播给 generator,保留 compacted messages。
 *   - restored_snapshot=null → 调用方主动放弃,保留 compacted messages。
 *   - 不重新执行已完成工具:hook 接入点在阶段 4(消息合并)之后,工具执行
 *     已结束;hook 只是替换 messages 列表,不会触发 executor 重新执行。
 *   - cutover 是唯一接入点:只在 runCompaction + L4 完成后调用一次。
 *
 * 测试用 ScriptedStreamClient(与 streaming-query.test.ts 同款 fake)模拟主模型
 * 剧本,用 postCompactReconstruction hook 的 spy / fake 验证调用与替换行为。
 */
import { describe, it, expect, vi } from 'vitest';
import { streamingQuery } from '../../agent/streaming-query.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
  ContentBlock,
} from '../../agent/types.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';

// ---------------------------------------------------------------------------
// Fake client(与 streaming-query.test.ts 同款,保持一致)
// ---------------------------------------------------------------------------

type ScriptBlock = ContentBlock;

class ScriptedStreamClient implements StreamingLLMClient {
  private callCount = 0;
  public submitCalls: Message[][] = [];
  constructor(private scripts: ScriptBlock[][]) {}

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    // 记录每次 submit 时收到的 messages(便于断言 hook 替换是否生效)
    this.submitCalls.push(_messages.map((m) => ({ ...m })));
    const blocks = this.scripts[this.callCount++] ?? [];
    yield { type: 'message_start', messageId: `msg_${this.callCount}`, model: 'fake', inputTokens: 1 };
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as ContentBlock;
      if (block.type === 'text') {
        yield { type: 'content_block_start', index: i, blockType: 'text' };
        yield { type: 'content_block_delta', index: i, deltaType: 'text', content: block.text };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, blockType: 'tool_use', blockId: block.id };
        const json = JSON.stringify(block.input);
        yield { type: 'content_block_delta', index: i, deltaType: 'input_json', content: json };
        yield { type: 'content_block_stop', index: i };
      }
    }
    yield {
      type: 'message_delta',
      stopReason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      outputTokens: blocks.length,
    };
    yield { type: 'message_stop' };
    const contentBlocks = blocks;
    yield {
      type: 'assistant',
      content: contentBlocks,
      usage: { input_tokens: 1, output_tokens: blocks.length },
      stopReason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      uuid: `asst_${this.callCount}`,
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 注册一个简单工具,便于构造"调用过工具"的场景。 */
function makeRegistryWithEchoTool(): {
  registry: ToolRegistry;
  execSpy: ReturnType<typeof vi.fn>;
} {
  const registry = new ToolRegistry();
  const def: ToolDefinition = {
    name: 'echo',
    description: 'echoes input',
    parameters: { type: 'object', properties: {} },
  };
  const execSpy = vi.fn(async () => 'echo_result');
  registry.register(def, execSpy);
  return { registry, execSpy };
}

/** 收集 generator 所有产出。 */
async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wave G Task 10 — streamingQuery postCompactReconstruction hook', () => {
  it('5. 不传 postCompactReconstruction → 走旧路径(LEGACY,onMessages 反映 compacted)', async () => {
    // 主模型:第一轮纯文本结束(无工具,无 compaction 触发)
    const mainClient = new ScriptedStreamClient([
      [{ type: 'text', text: 'Hello, done.' }],
    ]);
    const { registry } = makeRegistryWithEchoTool();
    const ac = new AbortController();
    let finalMessages: Message[] = [];
    await drain(
      streamingQuery(mainClient, registry, 'hi', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        executionRuntime: createToolExecutionRuntime(),
        maxTurns: 2,
        enableStreamingExecution: false,
        onMessages: (m) => {
          finalMessages = m;
        },
        // 不传 postCompactReconstruction
      }),
    );
    // LEGACY:final messages 仍是 user + assistant(无 reconstruction 替换)
    expect(finalMessages.length).toBe(2);
    expect(finalMessages[0].role).toBe('user');
    expect(finalMessages[1].role).toBe('assistant');
  });

  it('6. 传 postCompactReconstruction → hook 在阶段 4 后被调用(收到 messages/sessionId/turnId)', async () => {
    // 第一轮调用工具(触发阶段 4 messages 合并),第二轮结束。
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      [{ type: 'text', text: 'Done after tool.' }],
    ]);
    const { registry } = makeRegistryWithEchoTool();
    const ac = new AbortController();

    const hookCalls: Array<{
      messagesLen: number;
      sessionId: string;
      turnId: string;
    }> = [];

    await drain(
      streamingQuery(mainClient, registry, 'do echo', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        executionRuntime: createToolExecutionRuntime(),
        maxTurns: 5,
        enableStreamingExecution: false,
        postCompactReconstruction: async ({ messages, sessionId, turnId }) => {
          hookCalls.push({
            messagesLen: messages.length,
            sessionId,
            turnId,
          });
          // 默认返回 null(LEGACY-safe),只验证 hook 被调用
          return {
            restored_snapshot: null,
            next_messages: messages,
          };
        },
      }),
    );

    // 第一轮(调用工具)后会进入阶段 4,hook 应被调用至少一次。
    expect(hookCalls.length).toBeGreaterThanOrEqual(1);
    // sessionId 是 streamingQuery 的内部 constant
    expect(hookCalls[0].sessionId).toBe('sess:streaming-query');
    // turnId 形如 "turn:N"
    expect(hookCalls[0].turnId).toMatch(/^turn:\d+$/);
    // 调用 hook 时,messages 至少包含 user + assistant(tool_use) + tool_result
    expect(hookCalls[0].messagesLen).toBeGreaterThanOrEqual(3);
  });

  it('7. hook 返回 restored_snapshot + next_messages → 替换 messages(下一轮 submit 收到替换后内容)', async () => {
    // 第一轮调用工具(进入阶段 4 + compaction + reconstruction),第二轮结束。
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      [{ type: 'text', text: 'Final answer.' }],
    ]);
    const { registry } = makeRegistryWithEchoTool();
    const ac = new AbortController();

    // 准备一份"重建后"的 messages:用户消息 + meta 消息 + 当前用户精确消息
    const reconstructedMessages: Message[] = [
      { role: 'user', content: 'restored_meta_context' },
      { role: 'assistant', content: 'restored_working_set_summary' },
      { role: 'user', content: 'do echo' },
    ];

    let finalMessages: Message[] = [];
    await drain(
      streamingQuery(mainClient, registry, 'do echo', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        executionRuntime: createToolExecutionRuntime(),
        maxTurns: 5,
        enableStreamingExecution: false,
        onMessages: (m) => {
          finalMessages = m;
        },
        postCompactReconstruction: async () => ({
          restored_snapshot: {
            restored_working_set_snapshot_id: 'rws_test_1',
            // 其余字段在 structural shape 上符合,streamingQuery 不解析它们
          },
          next_messages: reconstructedMessages,
        }),
      }),
    );

    // 第二轮 submit 应该收到 reconstructedMessages(由 hook 返回)
    // streamingQuery 会把第二轮 assistant 追加到 messages,所以最终消息包含:
    // [restored_meta, restored_summary, 'do echo', 'Final answer.']
    expect(finalMessages.length).toBe(4);
    expect(finalMessages[0]).toEqual(reconstructedMessages[0]);
    expect(finalMessages[1]).toEqual(reconstructedMessages[1]);
    expect(finalMessages[2]).toEqual(reconstructedMessages[2]);
    expect(finalMessages[3].role).toBe('assistant');

    // 第二轮 submit 收到的 messages 应是 reconstructedMessages(不是 compacted)
    expect(mainClient.submitCalls.length).toBe(2);
    const secondSubmitMessages = mainClient.submitCalls[1];
    expect(secondSubmitMessages[0]).toEqual(reconstructedMessages[0]);
    expect(secondSubmitMessages[1]).toEqual(reconstructedMessages[1]);
  });

  it('8. hook 抛错 → 静默失败,messages 不变(generator 不抛错,TurnOutcome 不变)', async () => {
    // 第一轮调用工具,第二轮结束。
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const { registry } = makeRegistryWithEchoTool();
    const ac = new AbortController();

    let finalMessages: Message[] = [];
    // generator 不应抛错(hook 抛错被静默吞掉)
    await expect(
      drain(
        streamingQuery(mainClient, registry, 'do echo', {
          systemPrompt: 'sys',
          tools: registry.getDefinitions(),
          signal: ac.signal,
          executionRuntime: createToolExecutionRuntime(),
          maxTurns: 5,
          enableStreamingExecution: false,
          onMessages: (m) => {
            finalMessages = m;
          },
          postCompactReconstruction: async () => {
            throw new Error('reconstruction simulation failure');
          },
        }),
      ),
    ).resolves.toBeDefined();

    // 静默失败后 messages 保持 compacted(未替换):
    // user + assistant(tool_use) + user(tool_result) + assistant(Done.)
    expect(finalMessages.length).toBe(4);
    expect(finalMessages[0].role).toBe('user');
    expect(finalMessages[1].role).toBe('assistant');
    expect(finalMessages[2].role).toBe('user');
    expect(finalMessages[3].role).toBe('assistant');
  });

  it('9. hook 返回 null restored_snapshot → 不替换(LEGACY 行为)', async () => {
    // 第一轮调用工具,第二轮结束。
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const { registry } = makeRegistryWithEchoTool();
    const ac = new AbortController();

    let finalMessages: Message[] = [];
    await drain(
      streamingQuery(mainClient, registry, 'do echo', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        executionRuntime: createToolExecutionRuntime(),
        maxTurns: 5,
        enableStreamingExecution: false,
        onMessages: (m) => {
          finalMessages = m;
        },
        postCompactReconstruction: async () => ({
          restored_snapshot: null, // 调用方主动放弃
          next_messages: [
            { role: 'user', content: 'SHOULD_NOT_BE_USED' },
          ],
        }),
      }),
    );

    // next_messages 应该被忽略(因为 restored_snapshot=null)
    // 最终 messages 保持 compacted: user + assistant(tool_use) + user(tool_result) + assistant
    const lastUserMessage = finalMessages.find(
      (m) => m.role === 'user' && m.content === 'SHOULD_NOT_BE_USED',
    );
    expect(lastUserMessage).toBeUndefined();
    expect(finalMessages.length).toBe(4);
  });

  it('10. completed tool executor 调用次数不增加(reconstruction 不重新执行已完成工具)', async () => {
    // 第一轮调用 echo 工具一次,第二轮结束。
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const { registry, execSpy } = makeRegistryWithEchoTool();
    const ac = new AbortController();

    // hook 返回包含一个"已完成工具对"(tool_use + tool_result,新 ID,不冲突)
    // 的 messages,模拟 reconstruction 把已完成工具恢复到 working set。
    //
    // 关键断言:streamingQuery 不应该重新执行这个被恢复的 tool_use ——
    // executor 只在阶段 3(本轮模型产出 tool_use 时)运行,不在 hook 替换
    // messages 后重新扫描历史。before_provider_send checkpoint 也只验证
    // use/result 配对完整性,不会触发执行。
    await drain(
      streamingQuery(mainClient, registry, 'do echo', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        executionRuntime: createToolExecutionRuntime(),
        maxTurns: 5,
        enableStreamingExecution: false,
        postCompactReconstruction: async () => ({
          restored_snapshot: {
            restored_working_set_snapshot_id: 'rws_test_2',
          },
          // 重建后的 messages:包含一个已完成的工具对(新 ID restored_call_99)
          // + 当前用户消息。streamingQuery 应该把这些 messages 直接传给下一轮
          // submit,不重新执行 restored_call_99。
          next_messages: [
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'restored_call_99', name: 'echo', input: {} },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'restored_call_99',
                  content: 'PRE_EXECUTED_RESULT',
                } as unknown as ContentBlock,
              ],
            },
            { role: 'user', content: 'do echo' },
          ],
        }),
      }),
    );

    // echo 工具只应被实际执行一次(第一轮的真实 call_1),
    // 而不是 hook 注入的 restored_call_99(它是已完成的,不应重新执行)
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('cutover 在唯一接入点 — runCompaction/L4 完成后调用 hook(每轮最多一次)', async () => {
    // 3 轮:工具调用 → 工具调用 → 结束
    const mainClient = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      [{ type: 'tool_use', id: 'call_2', name: 'echo', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const { registry } = makeRegistryWithEchoTool();
    const ac = new AbortController();

    const hookCalls: number[] = [];
    await drain(
      streamingQuery(mainClient, registry, 'do echo', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        executionRuntime: createToolExecutionRuntime(),
        maxTurns: 5,
        enableStreamingExecution: false,
        postCompactReconstruction: async ({ messages }) => {
          hookCalls.push(messages.length);
          return { restored_snapshot: null, next_messages: messages };
        },
      }),
    );

    // 2 次工具调用 = 2 次阶段 4 messages 合并 = 2 次 hook 调用
    // (最后一轮纯文本不进阶段 4)
    expect(hookCalls.length).toBe(2);
  });
});
