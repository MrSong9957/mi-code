// background 工具：让 LLM 能启动、查询和跟踪后台任务
//
// 物理本质：给 LLM 一个"快递单"按钮。
// 按一下（run），包裹就上了传送带，LLM 拿到单号继续干别的。
// 想知道包裹到没到（status），想看物流详情（follow）。

import { readFileSync } from 'fs';
import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { BackgroundManager } from '../../background/background-manager.js';

export function createBackgroundTool(
  bgManager: BackgroundManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'background',
      description:
        'Run commands in the background without blocking. ' +
        'Subcommands: run(command), status(taskId), list(), follow(taskId). ' +
        'Use run() for slow commands (npm install, pytest, docker build). ' +
        'Use follow() to read the latest output of a background task.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Subcommand: run | status | list',
          },
          command: {
            type: 'string',
            description: 'Shell command to run (required for run)',
          },
          taskId: {
            type: 'string',
            description: 'Task ID to query (required for status)',
          },
        },
        required: ['action'],
      },
    },
    executor: async (input) => {
      const action = input.action as string;

      switch (action) {
        case 'run': {
          const command = input.command as string;
          if (!command) return 'Error: run requires command';
          try {
            const taskId = bgManager.run(command);
            return `Started background task ${taskId}: ${command}`;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
          }
        }

        case 'status': {
          const taskId = input.taskId as string;
          if (!taskId) return 'Error: status requires taskId';
          const task = bgManager.getStatus(taskId);
          if (!task) return `No task found with ID "${taskId}"`;
          return JSON.stringify(task, null, 2);
        }

        case 'list': {
          const list = bgManager.list();
          if (list.length === 0) return 'No background tasks.';
          return list
            .map(t => `[${t.status}] ${t.id}: ${t.command}`)
            .join('\n');
        }

        case 'follow': {
          const followId = input.taskId as string;
          if (!followId) return 'Error: follow requires taskId';
          const followTask = bgManager.getStatus(followId);
          if (!followTask) return `No task found with ID "${followId}"`;
          try {
            const content = readFileSync(followTask.outputFile, 'utf8');
            const tail = content.length > 4000 ? content.slice(-4000) : content;
            return `[${followTask.status}] ${followId}: ${followTask.command}\n--- output (last 4000 chars) ---\n${tail}`;
          } catch {
            return `Error: Could not read output file for task ${followId}`;
          }
        }

        default:
          return `Error: Unknown action "${action}". Use: run, status, list`;
      }
    },
  };
}
