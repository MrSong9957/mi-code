// task 工具测试：验证 clientProvider 创建的 client 被正确传递给子代理
//
// 物理本质：派工单。
// createTaskTool 是"派工单模板"，clientProvider 是"为临时工分配通信终端的工厂"。
// 这个测试验证：工厂按 inherit 创建的 client，传到 runSubagent 时仍是同一个实例。
import { describe, it, expect } from 'vitest';
import {
  createTaskTool,
  type SubagentClientProvider,
} from '../agent/tools/task-tool.js';
import type { ToolRegistry } from '../agent/tool-registry.js';
import type { SubagentOptions, SubagentResult } from '../agent/subagent.js';
import type { StreamingLLMClient } from '../agent/types.js';

/** 假的 ToolRegistry（task 工具不需要真实工具，只测派发参数） */
function fakeRegistry(): ToolRegistry {
  return { tools: new Map() } as unknown as ToolRegistry;
}

/** 记录最后一次调用 runSubagent 的参数（间谍） */
function makeSpy(captured: { options?: SubagentOptions }) {
  return async (
    _prompt: string,
    _tools: ToolRegistry,
    options: SubagentOptions,
  ): Promise<SubagentResult> => {
    captured.options = options;
    return { text: 'mock subagent result', isBackground: false, status: 'completed' as const, terminationReason: 'end_turn', evidence: { toolCallCount: 1, successfulToolResultCount: 1 } };
  };
}

function makeClientProvider(captured: { modelChoice?: string }): {
  client: StreamingLLMClient;
  provider: SubagentClientProvider;
} {
  const client = {} as StreamingLLMClient;
  return {
    client,
    provider: (modelChoice) => {
      captured.modelChoice = modelChoice;
      return client;
    },
  };
}

describe('createTaskTool clientProvider 接线', () => {
  it('未传 clientProvider 时不向 runSubagent 传 client（保持回退行为）', async () => {
    const captured: { options?: SubagentOptions } = {};
    const tool = createTaskTool(fakeRegistry(), undefined, undefined, makeSpy(captured));

    await tool.executor({ prompt: 'do something' });

    expect(captured.options).toBeDefined();
    expect(captured.options!.client).toBeUndefined();
  });

  it('传入 clientProvider 时用 inherit 创建 client 并传给 runSubagent', async () => {
    const captured: { options?: SubagentOptions } = {};
    const providerCapture: { modelChoice?: string } = {};
    const { client, provider } = makeClientProvider(providerCapture);
    const tool = createTaskTool(
      fakeRegistry(),
      undefined,
      provider,
      makeSpy(captured),
    );

    await tool.executor({ prompt: 'do something' });

    expect(captured.options).toBeDefined();
    expect(providerCapture.modelChoice).toBe('inherit');
    expect(captured.options!.client).toBe(client);
  });

  it('默认 cwd 与 clientProvider 共存', async () => {
    const captured: { options?: SubagentOptions } = {};
    const providerCapture: { modelChoice?: string } = {};
    const { client, provider } = makeClientProvider(providerCapture);
    const tool = createTaskTool(
      fakeRegistry(),
      undefined,
      provider,
      makeSpy(captured),
    );

    await tool.executor({ prompt: 'task in default dir' });

    expect(captured.options!.client).toBe(client);
    expect(captured.options!.cwd).toBeUndefined();
  });
});
