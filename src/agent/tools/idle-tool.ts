// idle 工具：信号代理进入空闲阶段
//
// 物理本质：举手说"我没事干了"。
// 代理做完当前任务 → 调用 idle → 进入轮询等待新任务。

import type { ToolDefinition, ToolExecutor } from '../types.js';

export function createIdleTool(): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'idle',
      description: 'Signal that you have no more work to do right now. Enters idle polling phase to wait for new tasks or inbox messages.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    executor: async () => {
      return 'IDLE_REQUESTED';
    },
  };
}
