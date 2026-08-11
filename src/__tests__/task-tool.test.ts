// task 工具测试：验证 clientProvider 创建的 client 被正确传递给子代理
//
// 物理本质：派工单。
// createTaskTool 是"派工单模板"，clientProvider 是"为临时工分配通信终端的工厂"。
// 这个测试验证：工厂按 inherit 创建的 client，传到 runSubagent 时仍是同一个实例。
import { describe, it, expect, vi } from 'vitest';
import {
  createTaskTool,
  type SubagentClientProvider,
} from '../agent/tools/task-tool.js';
import type { ToolRegistry } from '../agent/tool-registry.js';
import type { SubagentOptions, SubagentResult } from '../agent/subagent.js';
import type { SubagentJournal } from '../agent/subagent-journal.js';
import type { StreamingLLMClient } from '../agent/types.js';
import { createToolExecutionRuntime } from './helpers/tool-execution-runtime.js';

const executionRuntime = createToolExecutionRuntime();

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
    const tool = createTaskTool(fakeRegistry(), executionRuntime, undefined, undefined, makeSpy(captured));

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
      executionRuntime,
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
      executionRuntime,
      undefined,
      provider,
      makeSpy(captured),
    );

    await tool.executor({ prompt: 'task in default dir' });

    expect(captured.options!.client).toBe(client);
    expect(captured.options!.cwd).toBeUndefined();
  });

  it('将调用工具的取消信号传给子代理', async () => {
    const captured: { options?: SubagentOptions } = {};
    const tool = createTaskTool(fakeRegistry(), executionRuntime, undefined, undefined, makeSpy(captured));
    const controller = new AbortController();

    await tool.executor(
      { prompt: 'do something' },
      { toolUseId: 'task-1', signal: controller.signal },
    );

    expect(captured.options!.signal).toBe(controller.signal);
  });
});

// ════════════════════════════════════════════════════════════════════
// 子代理工作日志注入 + 共享 status envelope。
//
// 物理本质:task 工具与 spawn_agent 走同一套可靠性路径 —— 每次前台执行创建一个
// 独立 journal 透传给 runSubagent,并且输出共享的 [Subagent status=...] envelope
// (而非裸 result.text),让主 agent 能区分成功/失败/未完成。
// ════════════════════════════════════════════════════════════════════
describe('createTaskTool journal 注入与 status envelope', () => {
  function makeJournal(id: string): SubagentJournal {
    return {
      executionId: id,
      reference: `memory://${id}`,
      checkpoint: async () => {},
      load: async () => [],
    };
  }

  it('journalFactory 每次前台执行调用一次,并把 journal 透传给 runSubagentFn', async () => {
    const journal = makeJournal('task-child-1');
    const journalFactory = vi.fn(() => journal);
    const runSubagentFn = vi.fn(async (): Promise<SubagentResult> => ({
      text: 'recovered work',
      isBackground: false,
      status: 'incomplete',
      terminationReason: 'error',
      evidence: { toolCallCount: 1, successfulToolResultCount: 1 },
    }));

    const tool = createTaskTool(
      fakeRegistry(),
      executionRuntime,
      undefined,
      undefined,
      runSubagentFn,
      journalFactory,
    );

    const output = await tool.executor({ prompt: 'do something' });

    expect(journalFactory).toHaveBeenCalledTimes(1);
    expect(runSubagentFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ journal }),
    );
    // 与 spawn_agent 共享同一个 envelope 格式(而非裸 result.text)
    expect(output).toContain('[Subagent status=incomplete reason=error]');
    expect(output).toContain('recovered work');
  });
});
