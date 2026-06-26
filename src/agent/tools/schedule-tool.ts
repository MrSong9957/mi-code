// schedule_create 工具：创建定时调度
//
// 物理本质：设置闹钟。
// 告诉调度器"什么时候响"和"响了说什么"。

import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { ScheduleManager } from '../scheduler/schedule-manager.js';

export function createScheduleTool(
  scheduler: ScheduleManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'schedule_create',
      description: 'Create a scheduled task that runs at a specific time using cron expression. Format: "min hour day month weekday" (e.g., "0 9 * * 1" = every Monday 9am).',
      parameters: {
        type: 'object',
        properties: {
          cron: {
            type: 'string',
            description: 'Cron expression: "min hour day month weekday" (e.g., "*/5 * * * *" = every 5 min)',
          },
          prompt: {
            type: 'string',
            description: 'The prompt to inject when the schedule fires',
          },
          recurring: {
            type: 'boolean',
            description: 'Whether to repeat (default: true)',
          },
          durable: {
            type: 'boolean',
            description: 'Whether to persist across restarts (default: true)',
          },
        },
        required: ['cron', 'prompt'],
      },
    },
    executor: async (input) => {
      const cron = input.cron as string;
      const prompt = input.prompt as string;
      const recurring = input.recurring !== false;
      const durable = input.durable !== false;

      const job = scheduler.create(cron, prompt, recurring, durable);
      return `Created schedule ${job.id}: "${prompt}" [${cron}]${recurring ? ' (recurring)' : ''}${durable ? '' : ' (ephemeral)'}`;
    },
  };
}

export function createScheduleListTool(
  scheduler: ScheduleManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'schedule_list',
      description: 'List all scheduled tasks.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    executor: async () => {
      const jobs = scheduler.list();
      if (jobs.length === 0) return 'No scheduled tasks.';

      return jobs.map(j => {
        const status = j.enabled ? 'active' : 'disabled';
        const last = j.lastFiredAt ? new Date(j.lastFiredAt).toISOString() : 'never';
        const next = j.expectedNextRun ? new Date(j.expectedNextRun).toISOString() : '-';
        const dur = j.durable !== false ? 'durable' : 'ephemeral';
        return `[${j.id}] ${status} | ${dur} | ${j.cron} | "${j.prompt}" | last: ${last} | next: ${next}`;
      }).join('\n');
    },
  };
}

export function createScheduleRemoveTool(
  scheduler: ScheduleManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'schedule_remove',
      description: 'Remove a scheduled task by ID.',
      parameters: {
        type: 'object',
        properties: {
          schedule_id: {
            type: 'string',
            description: 'The ID of the schedule to remove',
          },
        },
        required: ['schedule_id'],
      },
    },
    executor: async (input) => {
      const id = input.schedule_id as string;
      const removed = scheduler.remove(id);
      return removed ? `Removed schedule ${id}` : `Error: Schedule ${id} not found`;
    },
  };
}

export function createScheduleUpdateTool(
  scheduler: ScheduleManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'schedule_update',
      description: 'Update an existing scheduled task (cron, prompt, or recurring).',
      parameters: {
        type: 'object',
        properties: {
          schedule_id: {
            type: 'string',
            description: 'The ID of the schedule to update',
          },
          cron: {
            type: 'string',
            description: 'New cron expression (optional)',
          },
          prompt: {
            type: 'string',
            description: 'New prompt (optional)',
          },
          recurring: {
            type: 'boolean',
            description: 'New recurring flag (optional)',
          },
        },
        required: ['schedule_id'],
      },
    },
    executor: async (input) => {
      const id = input.schedule_id as string;
      const changes: { cron?: string; prompt?: string; recurring?: boolean } = {};
      if (typeof input.cron === 'string') changes.cron = input.cron;
      if (typeof input.prompt === 'string') changes.prompt = input.prompt;
      if (typeof input.recurring === 'boolean') changes.recurring = input.recurring;

      const updated = scheduler.update(id, changes);
      return updated ? `Updated schedule ${id}` : `Error: Schedule ${id} not found`;
    },
  };
}
