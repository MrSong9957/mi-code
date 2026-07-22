// task 工具：让父代理能派生子代理
//
// 新增（s12）：可选 worktree 参数——子代理在指定 git worktree 隔离目录内执行，
// 实现任务间的目录隔离（互不污染未提交改动）。
//
// provider 支持：通过 clientProvider 闭包注入多 provider client，
// 让子代理走与主 agent 相同的 streamingQuery 路径（支持 OpenAI/MiMo 等）。
import type { ToolDefinition, ToolExecutor, StreamingLLMClient } from '../types.js';
import type { ToolRegistry } from '../tool-registry.js';
import { runSubagent } from '../subagent.js';
import type { SubagentOptions, SubagentResult } from '../subagent.js';
import type { SubagentModel } from '../roles.js';
import type { WorktreeManager } from '../../worktree/worktree-manager.js';

/** 子代理执行器类型（用于依赖注入，便于测试） */
type SubagentRunner = (
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions,
) => Promise<SubagentResult>;

/** 创建子代理 LLM client 的工厂（多 provider 支持，modelChoice 控制模型选择） */
export type SubagentClientProvider = (modelChoice?: SubagentModel) => StreamingLLMClient;

export function createTaskTool(
  childTools: ToolRegistry,
  worktreeManager?: WorktreeManager,
  /** 创建子代理用的 LLM client（多 provider 支持）。不传则回退 Vercel AI SDK（仅 Anthropic）。 */
  clientProvider?: SubagentClientProvider,
  /** 依赖注入：测试时传入 mock，生产路径留空走真实 runSubagent */
  runSubagentFn: SubagentRunner = runSubagent,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'task',
      description:
        'Spawn a subagent with fresh context to handle a subtask. Returns a summary of the result. ' +
        'Optionally run inside an isolated git worktree by passing its name.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The task description for the subagent',
          },
          worktree: {
            type: 'string',
            description:
              'Optional worktree name. If given, the subagent runs inside that isolated worktree directory.',
          },
        },
        required: ['prompt'],
      },
    },
    executor: async (input) => {
      const prompt = input.prompt as string;
      const worktreeName = input.worktree as string | undefined;

      // 解析 worktree 目录（如有）
      let cwd: string | undefined;
      if (worktreeName && worktreeManager) {
        const record = worktreeManager.getByName(worktreeName);
        if (!record) {
          return `Error: worktree "${worktreeName}" not found. Use the worktree tool to create it first.`;
        }
        cwd = record.path;
      } else if (worktreeName && !worktreeManager) {
        return `Error: worktree "${worktreeName}" requested but worktree support is not configured.`;
      }

      const result = await runSubagentFn(prompt, childTools, {
        cwd,
        // task 用 general 角色（继承主模型），传 'inherit' 让 clientProvider 选主模型
        client: clientProvider ? clientProvider('inherit') : undefined,
      });
      return result.text;
    },
  };
}
