// todo 工具：让 LLM 能更新进度
import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { TodoManager } from '../todo.js';

export function createTodoTool(todoManager: TodoManager): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'todo_write',
      description: 'Create and manage a task list to track long-running work. Use this before starting and to update progress. Only one task can be in_progress at a time.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'string',
            description: 'JSON array of todo items: [{"id":"1","content":"task","status":"pending|in_progress|completed"}]',
          },
        },
        required: ['items'],
      },
    },
    executor: async (input) => {
      try {
        const items = JSON.parse(input.items as string);
        return todoManager.update(items);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : 'Invalid JSON'}`;
      }
    },
  };
}
