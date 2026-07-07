// write_plan_file + exit_plan_mode 工具
//
// 物理本质：
// - write_plan_file = 把设计图纸写进档案柜（PlanStore），plan 模式唯一允许的写入动作
// - exit_plan_mode  = 把图纸递给业主审批（AskUserManager 挂起等用户 /approve 或 /reject）

import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { PlanStore } from '../../plan/plan-store.js';
import type { AskUserManager } from '../ask-user-manager.js';

/**
 * write_plan_file：把 plan 内容写到 PlanStore。
 *
 * 目标路径由 PlanStore 内部决定（plan 模式白名单目录），
 * AI 不需要也不应该指定路径——避免越权写到其它位置。
 */
export function createWritePlanTool(
  planStore: PlanStore,
  getSessionId: () => string,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'write_plan_file',
      description: [
        'Write your implementation plan to disk (plan mode only).',
        'Use this when you have finished exploring and designing — the plan file',
        'is the single artifact the user will review when you call exit_plan_mode.',
        'You may call this multiple times to update the plan; only the latest is kept.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Full plan content in Markdown. Include Context, Approach, Files to modify, and Verification sections.',
          },
        },
        required: ['content'],
      },
    },
    executor: async (input) => {
      const content = (input.content as string)?.trim();
      if (!content) {
        return 'Error: content is required';
      }
      const filePath = planStore.write(getSessionId(), content);
      return `Plan written to ${filePath}`;
    },
  };
}

/**
 * exit_plan_mode：提交 plan 等待用户审批。
 *
 * 读出最近一份 plan 显示给用户，然后挂起等待 /approve 或 /reject。
 * - /approve：返回 'Plan approved. You may now implement.' 给 AI
 * - /reject：返回 'Plan rejected: <reason>' 给 AI（无原因时 'Plan rejected'）
 *
 * 注意：模式切换（approve 后切 build）由 index.ts 的 /approve 分支完成，
 * 不在工具 executor 内做（executor 拿不到 permissionChecker/configStore/layout）。
 */
export function createExitPlanModeTool(
  askManager: AskUserManager,
  planStore: PlanStore,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'exit_plan_mode',
      description: [
        'Submit your plan for user approval. Call this AFTER you have written the plan',
        'with write_plan_file. The user will review and respond with /approve or /reject.',
        'Returns "approved" or "rejected" with optional reason.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Optional one-line summary shown to the user as the approval prompt header.',
          },
        },
        required: [],
      },
    },
    executor: async (input) => {
      const plan = planStore.getCurrent();
      if (!plan) {
        return 'Error: no plan written. Call write_plan_file first.';
      }
      const summary = (input.summary as string)?.trim() || 'Plan ready for review';
      const question = `${summary}\n\nPlan file: ${plan.filePath}\n\nType /approve to start implementation, or /reject <reason> to request changes.`;
      const decision = await askManager.ask({
        id: `plan-exit-${Date.now()}`,
        header: 'Plan review',
        question,
        options: ['/approve', '/reject'],
      });
      // index.ts 的 /approve /reject 分支会 resolve 对应字符串
      if (decision === 'approve') {
        planStore.setStatus('approved');
        return 'Plan approved by user. You may now implement the plan. Switch to build mode has been requested.';
      }
      // reject 或任意文本（当作 reject 原因）
      planStore.setStatus('rejected');
      const reason = decision && decision !== 'reject' ? `: ${decision}` : '';
      return `Plan rejected by user${reason}. Revise the plan and call write_plan_file + exit_plan_mode again.`;
    },
  };
}
