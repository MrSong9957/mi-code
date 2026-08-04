// Plan 模式在流式主路径的强制拦截测试
//
// 物理本质：验证"plan 模式下的写工具调用被门卫拦下，只读工具放行"。
// 这是把 PermissionChecker 接入 streamingQuery 主循环后的核心保证：
// 之前 /mode plan 只对子代理路径（runWithVercelAI）生效，主入口零拦截。
//
// 复用 streaming-query.test.ts 中的 ScriptedStreamClient 思路构造 fake client。
import { describe, it, expect } from 'vitest';
import { streamingQuery } from '../agent/streaming-query.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import { plannerPrompt } from '../prompts/index.js';
import { createAskUserTool } from '../agent/tools/ask-user-tool.js';
import type { AskUserManager } from '../agent/ask-user-manager.js';
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

type ScriptBlock = ContentBlock | { type: 'thinking'; thinking: string };

class ScriptedStreamClient implements StreamingLLMClient {
  private callCount = 0;
  constructor(private scripts: ScriptBlock[][]) {}

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
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, blockType: 'tool_use', blockId: block.id };
        yield { type: 'content_block_delta', index: i, deltaType: 'input_json', content: JSON.stringify(block.input) };
        yield { type: 'content_block_stop', index: i };
      }
    }
    yield {
      type: 'message_delta',
      stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      outputTokens: blocks.length,
    };
    yield { type: 'message_stop' };

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

/** 构造 registry：write_file / read_file 两个工具，用 spy 计数 */
function makeRegistryWithSpy(spy: { count: number }): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'write_file',
      description: 'Write file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    },
    async (input) => {
      spy.count++;
      return `wrote ${input.path}`;
    },
  );
  registry.register(
    {
      name: 'read_file',
      description: 'Read file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    async (input) => {
      spy.count++;
      return `content of ${input.path}`;
    },
  );
  return registry;
}

/** 从 generator 收集所有 tool_result 消息 */
async function drainToolResults(gen: AsyncGenerator<unknown>): Promise<{ name: string; output: string }[]> {
  const results: { name: string; output: string }[] = [];
  for await (const m of gen) {
    if (typeof m === 'object' && m !== null && 'type' in m && (m as { type: string }).type === 'tool_result') {
      const r = m as { type: 'tool_result'; name: string; output: string };
      results.push({ name: r.name, output: r.output });
    }
  }
  return results;
}

describe('Plan 模式流式拦截', () => {
  it('plan 模式 + 兜底串行分支：write_file 被拦，executor 不执行', async () => {
    const spy = { count: 0 };
    const registry = makeRegistryWithSpy(spy);

    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'foo.txt', content: 'x' } }],
      [{ type: 'text', text: 'Done.' }],
    ]);

    const ac = new AbortController();
    const results = await drainToolResults(
      streamingQuery(client, registry, 'write foo', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        maxTurns: 5,
        enableStreamingExecution: false, // 触发兜底串行分支
        executionRuntime: createToolExecutionRuntime({ mode: 'plan' }),
      }),
    );

    expect(results.length).toBe(1);
    expect(results[0]!.output).toContain('Plan mode');
    expect(spy.count).toBe(0); // 底层 executor 没被调用
  });

  it('plan 模式 + 流式执行器分支：write_file 被拦，read_file 放行', async () => {
    const spy = { count: 0 };
    const registry = makeRegistryWithSpy(spy);

    const client = new ScriptedStreamClient([
      [
        { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'foo.txt', content: 'x' } },
        { type: 'tool_use', id: 'call_2', name: 'read_file', input: { path: 'bar.txt' } },
      ],
      [{ type: 'text', text: 'Done.' }],
    ]);

    const ac = new AbortController();
    const results = await drainToolResults(
      streamingQuery(client, registry, 'write and read', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        maxTurns: 5,
        enableStreamingExecution: true, // 走 StreamingToolExecutor
        executionRuntime: createToolExecutionRuntime({ mode: 'plan' }),
      }),
    );

    expect(results.length).toBe(2);
    const writeResult = results.find(r => r.name === 'write_file')!;
    const readResult = results.find(r => r.name === 'read_file')!;
    expect(writeResult.output).toContain('Plan mode');
    expect(readResult.output).toBe('content of bar.txt');
    expect(spy.count).toBe(1); // 只有 read_file 真正执行
  });

  it('build 模式：write_file 的 ask 在无用户通道时 fail closed', async () => {
    const spy = { count: 0 };
    const registry = makeRegistryWithSpy(spy);

    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'foo.txt', content: 'x' } }],
      [{ type: 'text', text: 'Done.' }],
    ]);

    const ac = new AbortController();
    const results = await drainToolResults(
      streamingQuery(client, registry, 'write foo', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        maxTurns: 5,
        enableStreamingExecution: false,
        executionRuntime: createToolExecutionRuntime({ mode: 'build' }),
      }),
    );

    expect(results.length).toBe(1);
    expect(results[0]!.output).toContain('no user-decision channel is available');
    expect(spy.count).toBe(0);
  });

  it('auto 模式保持普通工具自动执行', async () => {
    const spy = { count: 0 };
    const registry = makeRegistryWithSpy(spy);

    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'foo.txt', content: 'x' } }],
      [{ type: 'text', text: 'Done.' }],
    ]);

    const ac = new AbortController();
    const results = await drainToolResults(
      streamingQuery(client, registry, 'write foo', {
        systemPrompt: 'sys',
        tools: registry.getDefinitions(),
        signal: ac.signal,
        maxTurns: 5,
        enableStreamingExecution: true,
        // A15 后 auto 模式 write_file 返回 ask；本测试验证流式执行器在 auto 下的执行行为，
        // 显式 allow write_file 以隔离权限依赖（保留"auto 下工具自动执行"的测试意图）。
        executionRuntime: createToolExecutionRuntime({ rules: [{ tool: 'write_file', behavior: 'allow' }] }),
      }),
    );

    expect(results.length).toBe(1);
    expect(results[0]!.output).toBe('wrote foo.txt');
    expect(spy.count).toBe(1);
  });
});

describe('planner control flow', () => {
  it('allows non-planning turns to end normally and reserves Ask and Exit for their conditions', () => {
    const askDescription = createAskUserTool(
      undefined as unknown as AskUserManager,
    ).definition.description;

    expect(plannerPrompt).toContain(
      'For informational or read-only requests, answer directly and end the turn.',
    );
    expect(plannerPrompt).toContain(
      'Use ask_user_question only when an unresolved choice blocks the current planning task.',
    );
    expect(plannerPrompt).toContain(
      'Never ask a generic "anything else?" question after completing the request.',
    );
    expect(plannerPrompt).toContain(
      'Call exit_plan_mode only after write_plan_file succeeded in this user turn.',
    );
    expect(plannerPrompt).toContain(
      'If the user says there is no other task, end the turn.',
    );
    expect(plannerPrompt).not.toContain(
      'Every turn MUST end with either ask_user_question or exit_plan_mode.',
    );
    expect(askDescription).toContain(
      'Use this only when an unresolved choice blocks the current task.',
    );
    expect(askDescription).toContain(
      'Do not ask generic follow-up questions after completing the request.',
    );
  });
});
