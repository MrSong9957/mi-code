// task 工具测试：验证 smallModel 被正确传递给子代理
//
// 物理本质：派工单。
// createTaskTool 是"派工单模板"，smallModel 是"指定临时工的等级"。
// 这个测试验证：派工单上写了等级 A，传到"临时工办公室"(runSubagent) 时还是等级 A，没被偷偷换掉。
import { describe, it, expect } from 'vitest';
import { createTaskTool } from '../agent/tools/task-tool.js';
import type { ToolRegistry } from '../agent/tool-registry.js';
import type { SubagentOptions, SubagentResult } from '../agent/subagent.js';

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
    return { text: 'mock subagent result', isBackground: false };
  };
}

describe('createTaskTool smallModel 接线', () => {
  it('未传 smallModel 时不向 runSubagent 传 model（保持原行为）', async () => {
    const captured: { options?: SubagentOptions } = {};
    const tool = createTaskTool(fakeRegistry(), undefined, undefined, makeSpy(captured));

    await tool.executor({ prompt: 'do something' });

    expect(captured.options).toBeDefined();
    expect(captured.options!.model).toBeUndefined();
  });

  it('传入 smallModel 时把它作为 model 传给 runSubagent', async () => {
    const captured: { options?: SubagentOptions } = {};
    const tool = createTaskTool(
      fakeRegistry(),
      undefined,
      'mimo-v2.5',
      makeSpy(captured),
    );

    await tool.executor({ prompt: 'do something' });

    expect(captured.options).toBeDefined();
    expect(captured.options!.model).toBe('mimo-v2.5');
  });

  it('worktree 仍然被正确解析，与 smallModel 共存', async () => {
    const captured: { options?: SubagentOptions } = {};
    const tool = createTaskTool(
      fakeRegistry(),
      undefined,
      'mimo-v2.5',
      makeSpy(captured),
    );

    // 不传 worktree，但传 prompt + 验证 model 同时存在
    await tool.executor({ prompt: 'task in default dir' });

    expect(captured.options!.model).toBe('mimo-v2.5');
    expect(captured.options!.cwd).toBeUndefined();
  });
});
