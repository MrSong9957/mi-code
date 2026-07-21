// write_plan_file + exit_plan_mode 工具
//
// 物理本质：
// - write_plan_file = 把设计图纸写进档案柜（PlanStore），plan 模式唯一允许的写入动作
// - exit_plan_mode  = 把图纸递给业主，通过 AskUserManager 问卷等待审批结果

import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { PlanStore } from '../../plan/plan-store.js';
import type { AskUserManager } from '../ask-user-manager.js';
import type { AskQuestionRequest } from '../ask-user-types.js';
import { serializeAskQuestionOutcome } from '../ask-user-serialization.js';
import { stripPlanFrontmatter } from '../../plan/plan-presentation.js';

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

export interface ExitPlanModeDeps {
  getUsagePercent: () => number;
  onApprove: (mode: 'auto' | 'build', clearContext: boolean) => void;
}

const PLAN_APPROVAL_QUESTION = 'Claude 已拟定执行方案，是否继续？';
const AUTO_CLEAR_LABEL = '确认执行，清空上下文并使用自动模式';
const AUTO_KEEP_LABEL = '确认执行，使用自动模式';
const BUILD_KEEP_LABEL = '确认执行，手动审核修改';

export function createExitPlanModeTool(
  askManager: AskUserManager,
  planStore: PlanStore,
  deps: ExitPlanModeDeps,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'exit_plan_mode',
      description: [
        'Submit your plan for user approval. Call this AFTER you have written the plan',
        'with write_plan_file. The user can approve an execution mode or request changes.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    executor: async (_input) => {
      const plan = planStore.getCurrent();
      if (!plan) {
        return 'Error: no plan written. Call write_plan_file first.';
      }

      const request: AskQuestionRequest = {
        questions: [{
          question: PLAN_APPROVAL_QUESTION,
          header: 'Plan',
          options: [
            {
              label: AUTO_CLEAR_LABEL,
              description: `重置对话（已占用 ${deps.getUsagePercent()}%），Agent 自动执行所有修改`,
            },
            {
              label: AUTO_KEEP_LABEL,
              description: '保留当前上下文，Agent 自动执行所有修改',
            },
            {
              label: BUILD_KEEP_LABEL,
              description: '保留当前上下文，每步修改需你确认',
            },
          ],
          multiSelect: false,
        }],
        otherLabel: '提出修改意见',
        presentation: {
          kind: 'plan-approval',
          content: stripPlanFrontmatter(plan.content),
          filePath: plan.filePath,
        },
      };
      const outcome = await askManager.ask(request);

      if (outcome.kind === 'submitted') {
        const answer = outcome.answers[PLAN_APPROVAL_QUESTION];
        if (answer === AUTO_CLEAR_LABEL) {
          deps.onApprove('auto', true);
          planStore.setStatus('approved');
        } else if (answer === AUTO_KEEP_LABEL) {
          deps.onApprove('auto', false);
          planStore.setStatus('approved');
        } else if (answer === BUILD_KEEP_LABEL) {
          deps.onApprove('build', false);
          planStore.setStatus('approved');
        }
      }

      return serializeAskQuestionOutcome(outcome);
    },
  };
}
