// Agent 核心循环测试
import { describe, it, expect, vi } from 'vitest';
import { agentLoop, createLoopState } from '../agent/loop.js';
import { MockLLMClient } from '../agent/llm-client.js';
import { createDefaultRegistry } from '../agent/tool-registry.js';
import type { AgentConfig, ModelResponse } from '../agent/types.js';
import type { LoopCallbacks } from '../agent/loop.js';

describe('Agent Loop', () => {
  const defaultConfig: AgentConfig = {
    model: 'test-model',
    system: 'You are a helpful assistant.',
    tools: [],
    max_turns: 10,
  };

  it('should complete immediately when model returns text response', async () => {
    const client = new MockLLMClient();
    const registry = createDefaultRegistry();
    const state = createLoopState('Hello');

    const result = await agentLoop(state, defaultConfig, client, registry);

    // 结构化返回：含 reason 和 text。
    expect(result.reason).toBe('completed');
    expect(result.text).toContain('Mock response to: Hello');
    expect(state.turn_count).toBe(0);
    expect(state.transition_reason).toBeNull();
  });

  it('should execute tool and continue loop when model calls tool', async () => {
    const client = new MockLLMClient();
    const registry = createDefaultRegistry();

    // 预设响应：第一次调用工具，第二次返回文本
    const toolCallResponse: ModelResponse = {
      content: [{
        type: 'tool_use',
        id: 'call_1',
        name: 'run_bash',
        input: { command: 'echo "tool executed"' },
      }],
      stop_reason: 'tool_use',
    };

    const finalResponse: ModelResponse = {
      content: [{ type: 'text', text: 'Tool result received, task complete.' }],
      stop_reason: 'end_turn',
    };

    client.setResponses([toolCallResponse, finalResponse]);

    const state = createLoopState('Run echo command');
    const callbacks: LoopCallbacks = {
      onTurnStart: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onLoopEnd: vi.fn(),
    };

    const result = await agentLoop(state, defaultConfig, client, registry, callbacks);

    expect(result.reason).toBe('completed');
    expect(result.text).toBe('Tool result received, task complete.');
    expect(state.turn_count).toBe(1);
    expect(state.transition_reason).toBeNull();
    expect(callbacks.onToolCall).toHaveBeenCalledWith('run_bash', { command: 'echo "tool executed"' });
    expect(callbacks.onToolResult).toHaveBeenCalledWith('call_1', expect.stringContaining('tool executed'));
  });

  it('should stop after max_turns', async () => {
    const client = new MockLLMClient();
    const registry = createDefaultRegistry();

    // 无限工具调用
    const infiniteToolCall: ModelResponse = {
      content: [{
        type: 'tool_use',
        id: 'call_inf',
        name: 'run_bash',
        input: { command: 'echo "again"' },
      }],
      stop_reason: 'tool_use',
    };

    // 设置足够多的响应
    client.setResponses(Array(20).fill(infiniteToolCall));

    const config: AgentConfig = { ...defaultConfig, max_turns: 3 };
    const state = createLoopState('Infinite loop test');

    const result = await agentLoop(state, config, client, registry);

    // 对齐 Claude Code：返回结构化对象，含 reason 和 turnCount。
    expect(result.reason).toBe('max_turns');
    expect(result.turnCount).toBe(3);
    expect(state.turn_count).toBe(3);
  });

  it('不传 max_turns 时不限轮次（对齐 Claude Code：undefined = 无限）', async () => {
    const client = new MockLLMClient();
    const registry = createDefaultRegistry();

    // 模拟：前 20 次都在调工具，第 21 次才收尾。
    const toolCall: ModelResponse = {
      content: [{
        type: 'tool_use', id: 'call_long',
        name: 'run_bash', input: { command: 'echo "work"' },
      }],
      stop_reason: 'tool_use',
    };
    const final: ModelResponse = {
      content: [{ type: 'text', text: '终于完成。' }],
      stop_reason: 'end_turn',
    };
    // 20 次工具调用 + 1 次最终回复。旧 max_turns: 10 会在第 10 次硬切断。
    client.setResponses([...Array(20).fill(toolCall), final]);

    // 不传 max_turns（默认无限）
    const config: AgentConfig = {
      model: 'test-model', system: '...', tools: [],
    };
    const state = createLoopState('long task');

    const result = await agentLoop(state, config, client, registry);

    // 应正常完成，不被切断。
    expect(result.reason).toBe('completed');
    expect(result.text).toBe('终于完成。');
    expect(state.turn_count).toBe(20);
  });

  it('max_turns 超限时保留已生成的 assistant 内容（不返回占位字符串）', async () => {
    const client = new MockLLMClient();
    const registry = createDefaultRegistry();

    // 前 2 次：调工具 + 在 text 块里输出部分内容
    const partialWorkResponse: ModelResponse = {
      content: [
        { type: 'text', text: '已经分析了 2 个文件。' },
        { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo x' } },
      ],
      stop_reason: 'tool_use',
    };
    const toolOnly: ModelResponse = {
      content: [{
        type: 'tool_use', id: 'c2', name: 'run_bash', input: { command: 'echo y' },
      }],
      stop_reason: 'tool_use',
    };
    client.setResponses([partialWorkResponse, toolOnly, toolOnly, toolOnly, toolOnly]);

    const config: AgentConfig = { ...defaultConfig, max_turns: 3 };
    const state = createLoopState('分析项目');

    const result = await agentLoop(state, config, client, registry);

    expect(result.reason).toBe('max_turns');
    expect(result.turnCount).toBe(3);
    // 不应返回占位字符串。
    expect(result.text).not.toBe('Loop ended: maximum turns reached');
    // 应保留已生成的部分文本（最后一次 assistant 响应里的 text，供 UI 展示）。
    // 无 text 块时为空字符串，UI 层自行决定如何提示。
    expect(typeof result.text).toBe('string');
  });

  it('should handle unknown tool gracefully', async () => {
    const client = new MockLLMClient();
    const registry = createDefaultRegistry();

    const toolCallResponse: ModelResponse = {
      content: [{
        type: 'tool_use',
        id: 'call_unknown',
        name: 'nonexistent_tool',
        input: {},
      }],
      stop_reason: 'tool_use',
    };

    const finalResponse: ModelResponse = {
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
    };

    client.setResponses([toolCallResponse, finalResponse]);

    const state = createLoopState('Test unknown tool');
    await agentLoop(state, defaultConfig, client, registry);

    // 检查工具结果包含错误信息
    const toolResultMsg = state.messages[2];
    expect(toolResultMsg?.role).toBe('user');
    if (Array.isArray(toolResultMsg?.content)) {
      const resultBlock = toolResultMsg.content[0] as { type: string; content: string };
      expect(resultBlock.content).toContain('Unknown tool');
    }
  });
});
