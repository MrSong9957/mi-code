// spawn_agent 工具：让主代理派角色化子代理（explore / plan / general）
//
// 物理本质：项目经理（主代理）从中介叫临时工（子代理），指定工种（role）和任务（prompt）。
// 临时工在自己的笔记本（独立 context）里干活，干完写一份摘要报告回来。
// 不同工种配不同的工具箱（roles.ts 白名单）：
//   - explore：只读探索（不污染主上下文，主代理只看摘要）
//   - plan：写 plan + 提交审批
//   - general：通用救火（等价于 task 工具）
//
// 与现有 task 工具的区别：task 是 general 的别名；spawn_agent 显式选 role，
// 工具集按角色裁剪，权限更细。

import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { ToolRegistry } from '../tool-registry.js';
import { runSubagent } from '../subagent.js';
import type { SubagentOptions, SubagentResult } from '../subagent.js';
import type { Role } from '../roles.js';
import type { PermissionChecker } from '../../permission/checker.js';

/** 子代理执行器类型（用于依赖注入，便于测试） */
type SubagentRunner = (
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions,
) => Promise<SubagentResult>;

export function createSpawnAgentTool(
  childTools: ToolRegistry,
  smallModel?: string,
  /** 透传给子代理，让子代理工具调用也受 PermissionChecker 约束 */
  permissionChecker?: PermissionChecker,
  /** 依赖注入：测试时传 mock，生产路径走真实 runSubagent */
  runSubagentFn: SubagentRunner = runSubagent,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'spawn_agent',
      description: [
        'Spawn a role-specialized subagent with fresh context to handle a subtask.',
        '- role="explore": read-only investigation (use for codebase exploration that would bloat your context).',
        '- role="plan": designs an implementation plan, writes it via write_plan_file, and submits for user approval.',
        '- role="general": generic subtask execution (equivalent to the task tool).',
        'Returns the subagent\'s summary text. The subagent cannot see your conversation history.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            description: 'Role of the subagent.',
          },
          prompt: {
            type: 'string',
            description: 'The task description for the subagent. Be specific about what to find or design.',
          },
        },
        required: ['role', 'prompt'],
      },
    },
    executor: async (input) => {
      const role = input.role as string;
      const prompt = (input.prompt as string)?.trim();

      if (!['explore', 'plan', 'general'].includes(role)) {
        return `Error: invalid role "${role}". Must be one of: explore, plan, general.`;
      }
      if (!prompt) {
        return 'Error: prompt is required';
      }

      const result = await runSubagentFn(prompt, childTools, {
        role: role as Role,
        model: smallModel,
        permissionChecker,
      });
      return result.text;
    },
  };
}
