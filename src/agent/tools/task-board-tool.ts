// TaskBoard 工具：让 LLM 能操作任务看板
//
// 对应文档 s12 新版两个工具：
// - create_task_matrix：批量创建带依赖的任务（提交前跑拓扑死锁检测）
// - mark_task_done：标记任务完成，触发依赖级联解锁

import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { TaskBoard } from '../../task-board/task-board.js';

/**
 * create_task_matrix 工具
 *
 * 批量向看板添加带显式依赖的任务。
 * 底层会在提交瞬间做 Kahn 拓扑排序校验，检测到环路依赖则拒绝整批。
 */
export function createTaskMatrixTool(
  board: TaskBoard,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'create_task_matrix',
      description:
        'Initialize or append multiple tasks with explicit dependencies to the project board. ' +
        'Each task needs an id, title, and dependencies (ids of tasks that must finish first). ' +
        'A dependency cycle is rejected. Returns the updated board view.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'string',
            description:
              'JSON array of tasks: [{"id":"T1","title":"...","dependencies":[]}, ...]. ' +
              'dependencies is an array of task ids that must be done before this one.',
          },
        },
        required: ['tasks'],
      },
    },
    executor: async (input) => {
      let parsed: Array<{ id: string; title: string; dependencies: string[] }>;
      try {
        parsed = JSON.parse(input.tasks as string);
      } catch {
        return 'Error: tasks must be a valid JSON array';
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return 'Error: tasks must be a non-empty JSON array';
      }

      try {
        board.addTasks(parsed);
        board.save();
        return 'Task matrix approved. Current view:\n' + board.render();
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    },
  };
}

/**
 * mark_task_done 工具
 *
 * 标记一个 active 任务为完成，写入结果摘要。
 * 完成会触发看板级联刷新：解锁所有依赖本任务的 waiting 任务为 ready。
 */
export function createMarkTaskDoneTool(
  board: TaskBoard,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'mark_task_done',
      description:
        'Mark a task as successfully accomplished. Automatically unlocks downstream tasks ' +
        'whose dependencies are now all satisfied. Returns the updated board view.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The task id to mark done' },
          result_summary: {
            type: 'string',
            description: 'A concise summary of what was accomplished',
          },
        },
        required: ['id', 'result_summary'],
      },
    },
    executor: async (input) => {
      const id = input.id as string;
      const resultSummary = input.result_summary as string;
      if (!id) return 'Error: id is required';

      try {
        board.markDone(id, resultSummary);
        board.save();
        return `Task ${id} set to DONE. Board updated successfully.\n` + board.render();
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    },
  };
}
