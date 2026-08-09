// write_plan_file + exit_plan_mode 工具
//
// 物理本质：
// - write_plan_file = 把设计图纸写进档案柜（PlanStore），plan 模式唯一允许的写入动作
// - exit_plan_mode  = 把图纸递给业主，通过 AskUserManager 问卷等待审批结果

import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { PlanContext, PlanStore } from '../../plan/plan-store.js';
import type { AskUserManager } from '../ask-user-manager.js';
import type { AskQuestionRequest } from '../ask-user-types.js';
import type { Translator } from '../../locale/types.js';
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
  getPlanContext: () => PlanContext | null,
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
      const context = getPlanContext();
      if (!context) return 'Error: No active plan context for the current turn.';
      try {
        const filePath = planStore.write(context, content);
        return `Plan written to ${filePath}`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/**
 * read_plan_file：读回当前计划文件内容（剥离 frontmatter）。
 * 让 LLM 能增量编辑计划——读回当前草稿，修改后用 write_plan_file 全量重写。
 */
export function createReadPlanTool(
  planStore: PlanStore,
  getPlanContext: () => PlanContext | null,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'read_plan_file',
      description: 'Read the current plan file content. Returns the plan Markdown without frontmatter. Use this to review your current draft before updating it with write_plan_file.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    executor: async () => {
      const context = getPlanContext();
      const plan = context ? planStore.getActive(context) : null;
      if (!plan) {
        return 'Error: no plan written yet. Call write_plan_file first.';
      }
      return stripPlanFrontmatter(plan.content);
    },
  };
}

export interface ExitPlanModeDeps {
  getUsagePercent: () => number;
  onApprove: (mode: 'auto' | 'build', clearContext: boolean) => void;
  getPlanContext: () => PlanContext | null;
}

/**
 * 稳定 value ID：exit_plan_mode 三个审批选项的不可翻译标识。
 *
 * 决策映射只读 answerValues 中的 value，不读可翻译的 label 文本——
 * 这样切换 locale 后审批分支仍能正确命中（i18n 安全不变量，见 permission 模式）。
 */
export const PLAN_APPROVAL_OPTION_VALUES = {
  autoClear: 'planApproval.option.autoClear',
  autoKeep: 'planApproval.option.autoKeep',
  buildKeep: 'planApproval.option.buildKeep',
} as const;

export function createExitPlanModeTool(
  askManager: AskUserManager,
  planStore: PlanStore,
  translator: Translator,
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
      const context = deps.getPlanContext();
      const plan = context ? planStore.getActive(context) : null;
      if (!plan) {
        return 'Error: No plan was written in the current turn. Call write_plan_file first.';
      }
      const approvalContext = context!;

      const question = translator.t('planApproval.tool.question');
      const usagePercent = deps.getUsagePercent();
      const request: AskQuestionRequest = {
        questions: [{
          question,
          header: 'Plan',
          options: [
            {
              label: translator.t('planApproval.tool.autoClearLabel'),
              description: translator.t('planApproval.tool.autoClearDescription', { usage: usagePercent }),
              value: PLAN_APPROVAL_OPTION_VALUES.autoClear,
            },
            {
              label: translator.t('planApproval.tool.autoKeepLabel'),
              description: translator.t('planApproval.tool.autoKeepDescription'),
              value: PLAN_APPROVAL_OPTION_VALUES.autoKeep,
            },
            {
              label: translator.t('planApproval.tool.buildKeepLabel'),
              description: translator.t('planApproval.tool.buildKeepDescription'),
              value: PLAN_APPROVAL_OPTION_VALUES.buildKeep,
            },
          ],
          multiSelect: false,
        }],
        otherLabel: translator.t('planApproval.tool.otherLabel'),
        presentation: {
          kind: 'plan-approval',
          content: stripPlanFrontmatter(plan.content),
          filePath: plan.filePath,
        },
      };
      const outcome = await askManager.ask(request);

      if (outcome.kind === 'submitted') {
        const answerValue = outcome.answerValues?.[question];
        if (answerValue === PLAN_APPROVAL_OPTION_VALUES.autoClear) {
          deps.onApprove('auto', true);
          planStore.setStatus(approvalContext, 'approved');
        } else if (answerValue === PLAN_APPROVAL_OPTION_VALUES.autoKeep) {
          deps.onApprove('auto', false);
          planStore.setStatus(approvalContext, 'approved');
        } else if (answerValue === PLAN_APPROVAL_OPTION_VALUES.buildKeep) {
          deps.onApprove('build', false);
          planStore.setStatus(approvalContext, 'approved');
        }
      }

      return serializeAskQuestionOutcome(outcome);
    },
  };
}
