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

    expect(result).toContain('Mock response to: Hello');
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

    expect(result).toBe('Tool result received, task complete.');
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

    expect(result).toBe('Loop ended: maximum turns reached');
    expect(state.turn_count).toBe(3);
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
