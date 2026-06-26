// claim_task 工具：认领未分配的任务
//
// 物理本质：在白板上写自己的名字。
// 看板上有任务没人做 → 调用 claim_task → 任务归你。

import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { TodoManager } from '../todo.js';

export function createClaimTaskTool(
  todoManager: TodoManager,
  owner: string,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'claim_task',
      description: 'Claim an unassigned task from the todo list. Only pending tasks without an owner can be claimed.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The ID of the task to claim',
          },
        },
        required: ['task_id'],
      },
    },
    executor: async (input) => {
      const taskId = input.task_id as string;
      return todoManager.claim(taskId, owner);
    },
  };
}
