// spawn_agent 工具：让主代理派角色化子代理（explore / plan / general）
//
// 物理本质：项目经理（主代理）从中介叫临时工（子代理），指定工种（role）和任务（prompt）。
// 临时工在自己的笔记本（独立 context）里干活，干完写一份摘要报告回来。
// 不同工种配不同的工具箱（roles.ts 白名单）+ 模型（small/inherit）+ 最大轮数：
//   - explore：只读探索，用小模型省钱，25 步
//   - plan：写 plan，用主模型保证质量，15 步
//   - general：通用救火（等价于 task 工具）
//
// 与现有 task 工具的区别：task 是 general 的别名；spawn_agent 显式选 role，
// 工具集按角色裁剪，模型/轮数也按角色分配。

import type { ToolDefinition, ToolExecutor, StreamingLLMClient } from '../types.js';
import type { ToolRegistry } from '../tool-registry.js';
import { runSubagent } from '../subagent.js';
import type { SubagentOptions, SubagentResult } from '../subagent.js';
import { ROLE_REGISTRY, type Role, type SubagentModel } from '../roles.js';
import type { PermissionChecker } from '../../permission/checker.js';

/** 子代理执行器类型（用于依赖注入，便于测试） */
type SubagentRunner = (
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions,
) => Promise<SubagentResult>;

/**
 * 子代理 LLM 客户端工厂。
 *
 * 每次 spawn 时调用，读取当前 provider 配置并创建对应的流式客户端，
 * 让子代理走主 agent 的多 provider 路径（修复子代理写死 Anthropic 的 bug）。
 * 物理本质：派工时按当前门禁系统（provider）给临时工发对应门禁卡。
 *
 * modelChoice 参数让不同角色用不同模型（explore=small, plan=inherit）。
 */
export type SubagentClientProvider = (modelChoice?: SubagentModel) => StreamingLLMClient;

export function createSpawnAgentTool(
  childTools: ToolRegistry,
  /**
   * 创建子代理用的流式 LLM 客户端（每次 spawn 时调用）。
   * 传入时子代理走 streamingQuery（多 provider，支持 OpenAI/MiMo 等）。
   * 不传则回退 runWithVercelAI（仅 Anthropic，测试/向后兼容用）。
   */
  clientProvider?: SubagentClientProvider,
  /** 透传给子代理，让子代理工具调用也受 PermissionChecker 约束 */
  permissionChecker?: PermissionChecker,
  /** 依赖注入：测试时传 mock，生产路径走真实 runSubagent */
  runSubagentFn: SubagentRunner = runSubagent,
  /** 可用技能描述（注入子代理 system prompt，让子代理发现/调用技能） */
  skillsDescription?: string,
  /** 获取主 agent 当前 system prompt（fork 模式用） */
  getParentSystemPrompt?: () => string,
): { definition: ToolDefinition; executor: ToolExecutor } {
  // 动态生成工具描述：从 ROLE_REGISTRY 的 whenToUse 字段拼装
  const roleLines = (['explore', 'plan', 'general'] as Role[])
    .map(r => `- role="${r}": ${ROLE_REGISTRY[r].whenToUse}`)
    .join('\n');

  return {
    definition: {
      name: 'spawn_agent',
      description: [
        'Spawn a role-specialized subagent with fresh context to handle a subtask.',
        roleLines,
        'Returns the subagent\'s summary text. The subagent cannot see your conversation history.',
        '- fork=true: inherit your full system prompt (a worker with your exact capabilities, for independent parallel subtasks).',
      ].join('\n'),
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
          fork: {
            type: 'boolean',
            description: 'Set to true for a subagent that inherits your full system prompt. Use when you need a worker with your exact capabilities for an independent parallel subtask.',
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

      const fork = input.fork === true;

      if (fork) {
        if (!getParentSystemPrompt) {
          return 'Error: fork mode is not available (no parent system prompt access).';
        }
        // fork 模式：继承主 agent system prompt，不走角色白名单
        const result = await runSubagentFn(prompt, childTools, {
          client: clientProvider ? clientProvider('inherit') : undefined,
          permissionChecker,
          maxSteps: 50,  // fork 用于长任务
          skillsDescription,
          forkMode: true,
          parentSystem: getParentSystemPrompt(),
          // role 不传（undefined）→ filterToolsByRole 返回全量减黑名单
        });
        return result.text;
      }

      // 正常角色派发（现有逻辑不变）
      // 从角色配置读 model 和 maxTurns（对齐 CC 的 per-role model/maxTurns）
      const roleConfig = ROLE_REGISTRY[role as Role];
      const modelChoice = roleConfig?.model ?? 'small';
      const maxSteps = roleConfig?.maxTurns ?? (role === 'explore' ? 25 : 15);

      const result = await runSubagentFn(prompt, childTools, {
        role: role as Role,
        client: clientProvider ? clientProvider(modelChoice) : undefined,
        permissionChecker,
        maxSteps,
        skillsDescription,
      });
      return result.text;
    },
  };
}
