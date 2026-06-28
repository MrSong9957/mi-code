// task 工具：让父代理能派生子代理
//
// 新增（s12）：可选 worktree 参数——子代理在指定 git worktree 隔离目录内执行，
// 实现任务间的目录隔离（互不污染未提交改动）。
//
// 新增（smallModel）：子代理等轻量任务走小模型省钱。未配置时回退到 undefined，
// 由 runSubagent 内部使用默认（主）模型——默认行为零变化。
import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { ToolRegistry } from '../tool-registry.js';
import { runSubagent } from '../subagent.js';
import type { SubagentOptions, SubagentResult } from '../subagent.js';
import type { WorktreeManager } from '../../worktree/worktree-manager.js';

/** 子代理执行器类型（用于依赖注入，便于测试） */
type SubagentRunner = (
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions,
) => Promise<SubagentResult>;

export function createTaskTool(
  childTools: ToolRegistry,
  worktreeManager?: WorktreeManager,
  smallModel?: string,
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

      const result = await runSubagentFn(prompt, childTools, { cwd, model: smallModel });
      return result.text;
    },
  };
}
