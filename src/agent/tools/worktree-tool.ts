// worktree 工具：让 LLM 能创建和管理 git worktree
//
// 物理本质：给 LLM 一把"仓库钥匙"，
// 它可以开新仓库（create）、锁门（remove）、查台账（list/status）。

import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { WorktreeManager } from '../../worktree/worktree-manager.js';

export function createWorktreeTool(
  worktreeManager: WorktreeManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'worktree',
      description:
        'Manage git worktrees for isolated task execution. ' +
        'Subcommands: create(name, taskId), bind(name, taskId), remove(name, discardChanges?), closeout(name, action, reason), list(), status().',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Subcommand: create | remove | list | status',
          },
          name: {
            type: 'string',
            description: 'Worktree name (required for create/bind/remove/closeout/status)',
          },
          taskId: {
            type: 'string',
            description: 'Task ID to bind (required for create/bind)',
          },
          discardChanges: {
            type: 'boolean',
            description: 'Force remove even with uncommitted changes (for remove)',
          },
          closeoutAction: {
            type: 'string',
            description: 'Closeout action: keep or remove (for closeout)',
          },
          reason: {
            type: 'string',
            description: 'Closeout reason (for closeout)',
          },
        },
        required: ['action'],
      },
    },
    executor: async (input) => {
      const action = input.action as string;

      switch (action) {
        case 'create': {
          const name = input.name as string;
          const taskId = input.taskId as string;
          if (!name || !taskId) return 'Error: create requires name and taskId';
          try {
            const record = worktreeManager.create(name, taskId);
            return `Created worktree "${record.name}" at ${record.path} (branch: ${record.branch}, task: ${record.taskId})`;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
          }
        }

        case 'bind': {
          const name = input.name as string;
          const taskId = input.taskId as string;
          if (!name || !taskId) return 'Error: bind requires name and taskId';
          try {
            const record = worktreeManager.bind(name, taskId);
            return `Bound worktree "${record.name}" to task ${taskId}`;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
          }
        }

        case 'remove': {
          const name = input.name as string;
          if (!name) return 'Error: remove requires name';
          const discard = input.discardChanges as boolean | undefined;
          try {
            if (discard !== undefined) {
              return worktreeManager.safeRemove(name, discard);
            }
            worktreeManager.remove(name);
            return `Removed worktree "${name}"`;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
          }
        }

        case 'closeout': {
          const name = input.name as string;
          const closeoutAction = (input.closeoutAction as string) || 'keep';
          const reason = (input.reason as string) || 'completed';
          if (!name) return 'Error: closeout requires name';
          try {
            return worktreeManager.closeout(name, closeoutAction as 'keep' | 'remove', reason);
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
          }
        }

        case 'list': {
          const records = worktreeManager.list();
          if (records.length === 0) return 'No worktrees.';
          return records
            .map(r => `${r.name} -> ${r.path} (task: ${r.taskId}, branch: ${r.branch})`)
            .join('\n');
        }

        case 'status': {
          const name = input.name as string;
          if (!name) return 'Error: status requires name';
          const byName = worktreeManager.getByName(name);
          if (byName) return JSON.stringify(byName, null, 2);
          const byTask = worktreeManager.getByTask(name);
          if (byTask) return JSON.stringify(byTask, null, 2);
          return `No worktree found for "${name}"`;
        }

        default:
          return `Error: Unknown action "${action}". Use: create, bind, remove, closeout, list, status`;
      }
    },
  };
}
