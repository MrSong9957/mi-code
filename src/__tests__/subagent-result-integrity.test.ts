// 子代理结果完整性测试
//
// 物理本质：验证"临时工交上来的报告是否真实"。
// 问题：临时工可能"没去现场看过就写报告"（explore 无工具证据却返回正文），
// 或者"干到一半被叫停"（max_turns 退出）却冒充完整结果。
// 这些测试锁定：未验证的正文被丢弃、中途退出被标记、交互工具被隔离。

import { describe, it, expect } from 'vitest';
import { runSubagent, type SubagentOptions } from '../agent/subagent.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
  ContentBlock,
} from '../agent/types.js';

// ════════════════════════════════════════════════════════════════════
// ScriptedStreamClient：按剧本执行的 fake LLM 客户端
// 复用 streaming-query.test.ts 的模式
// ════════════════════════════════════════════════════════════════════
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
      } else if (block.type === 'thinking') {
        yield { type: 'content_block_start', index: i, blockType: 'thinking' };
        yield { type: 'content_block_delta', index: i, deltaType: 'thinking', content: block.thinking };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, blockType: 'tool_use', blockId: block.id };
        const json = JSON.stringify(block.input);
        yield { type: 'content_block_delta', index: i, deltaType: 'input_json', content: json };
        yield { type: 'content_block_stop', index: i };
      }
    }
    yield { type: 'message_delta', stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', outputTokens: blocks.length };
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

// ════════════════════════════════════════════════════════════════════
// 测试辅助：真实注册 read_file executor 的 ToolRegistry
// ════════════════════════════════════════════════════════════════════
function makeReadRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const readDef: ToolDefinition = {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  };
  registry.register(readDef, async (input: Record<string, unknown>) => {
    const path = input.path as string;
    if (path === 'src') {
      return 'agent, tui, ui';
    }
    return `contents of ${path}`;
  });
  return registry;
}

// ════════════════════════════════════════════════════════════════════
// Task 1: explore 无工具证据时丢弃未经验证的正文
// ════════════════════════════════════════════════════════════════════
describe('subagent result integrity', () => {
  it('explore 未取得工具证据时丢弃未经验证的正文', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'text', text: 'src contains core, editor, components' }],
    ]);
    const result = await runSubagent('list real src modules', makeReadRegistry(), {
      role: 'explore',
      client,
      maxSteps: 5,
    });

    expect(result.status).toBe('unverified');
    expect(result.evidence).toEqual({ toolCallCount: 0, successfulToolResultCount: 0 });
    expect(result.text).toContain('no successful evidence tool result');
    expect(result.text).not.toContain('core, editor, components');
  });

  it('explore 有工具证据时返回 completed', async () => {
    const client = new ScriptedStreamClient([
      [
        { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } },
      ],
      [{ type: 'text', text: 'Verified modules: agent, tui, ui' }],
    ]);
    const result = await runSubagent('list real src modules', makeReadRegistry(), {
      role: 'explore',
      client,
      maxSteps: 5,
    });

    expect(result.status).toBe('completed');
    expect(result.evidence.successfulToolResultCount).toBe(1);
    expect(result.text).toBe('Verified modules: agent, tui, ui');
  });

  it('达到 maxTurns 时不把最后一句过程文本当成完整结果', async () => {
    const client = new ScriptedStreamClient([[
      { type: 'text', text: 'Now let me check the test files...' },
      { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } },
    ]]);
    const result = await runSubagent('inspect tests', makeReadRegistry(), {
      role: 'explore', client, maxSteps: 1,
    });

    expect(result.status).toBe('incomplete');
    expect(result.terminationReason).toBe('max_turns');
    expect(result.text).toContain('[Subagent incomplete: reached max turns');
    expect(result.text).toContain('Now let me check the test files...');
  });
});

// ════════════════════════════════════════════════════════════════════
// AUTO-0025 Task 2 Step 3: 子代理内部工具进度通过 onProgress 携带 parentToolUseId 转发
//
// 物理本质:子代理在干活(读文件、跑 bash)时,这些活动应该实时浮上来,
// 让父 pending 消息看到"● spawn_agent → 子代理正在 read_file"。
// 转发必须携带 parentToolUseId,父 UI 才能正确把进度挂到对应那一次 spawn 调用。
// ════════════════════════════════════════════════════════════════════

describe('subagent child progress forwarding (AUTO-0025 Task 2)', () => {
  it('onProgress 收到 tool_call/tool_result 且都携带 parentToolUseId', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } }],
      [{ type: 'text', text: 'Verified skills: code-review, git-workflow' }],
    ]);

    const events: Array<{ kind: string; parentToolUseId?: string; name?: string }> = [];
    const result = await runSubagent('list skills', makeReadRegistry(), {
      role: 'explore',
      client,
      maxSteps: 5,
      parentToolUseId: 'spawn-1',
      onProgress: (event) => { events.push(event); },
    });

    expect(result.status).toBe('completed');
    expect(events.map(event => event.kind)).toEqual(['tool_call', 'tool_result']);
    expect(events[0]).toMatchObject({ parentToolUseId: 'spawn-1', name: 'read_file' });
    expect(events[1]).toMatchObject({ parentToolUseId: 'spawn-1', name: 'read_file' });
  });

  it('不传 onProgress 时不影响子代理正常执行', async () => {
    const client = new ScriptedStreamClient([
      [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } }],
      [{ type: 'text', text: 'verified' }],
    ]);

    const result = await runSubagent('list skills', makeReadRegistry(), {
      role: 'explore', client, maxSteps: 5,
      parentToolUseId: 'spawn-2',
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('verified');
  });
});
