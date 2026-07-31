// spawn_self_organizing 工具：让父代理能派生具备 WORK/IDLE 生命周期的自组织子代理
//
// 物理本质：招一个会自己找活干的"长工"。
// 和 task 工具（一次性临时工）的区别：这个长工干完活不立刻走，
// 而是进入待机（IDLE），盯着收件箱和任务看板，有新活就接着干，闲够 60 秒才走人。
//
// 关键：后台启动（不 await）。WORK/IDLE 循环默认最长 60s，若 executor 直接 await，
// 会冻结整个 streamingQuery 主循环（用户按键、流式渲染全部卡死）。
// 所以 executor 立刻返回回执，长工在后台自己跑。
import type { ToolDefinition, ToolExecutor, StreamingLLMClient } from '../types.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { TodoManager } from '../todo.js';
import type { InboxManager } from '../inbox.js';
import { runSelfOrganizingSubagent, type SelfOrganizingOptions } from '../self-organizing.js';
import type { SubagentModel } from '../roles.js';

/** 创建自组织子代理 LLM client 的工厂（多 provider 支持） */
export type SubagentClientProvider = (modelChoice?: SubagentModel) => StreamingLLMClient;

/** 自组织子代理执行器类型（用于依赖注入，便于测试） */
type SelfOrganizingRunner = (
  name: string,
  role: string,
  identity: string,
  tools: ToolRegistry,
  todoManager: TodoManager,
  inboxManager: InboxManager,
  options: SelfOrganizingOptions,
) => Promise<string>;

export interface SpawnSelfOrganizingToolOptions extends SelfOrganizingOptions {
  /** 依赖注入：测试时传入 mock，生产路径留空走真实 runSelfOrganizingSubagent */
  runFn?: SelfOrganizingRunner;
  /** 创建子代理 LLM client 的工厂（多 provider 支持） */
  clientProvider?: SubagentClientProvider;
}

export function createSpawnSelfOrganizingTool(
  childTools: ToolRegistry,
  todoManager: TodoManager,
  inboxManager: InboxManager,
  options: SpawnSelfOrganizingToolOptions,
): { definition: ToolDefinition; executor: ToolExecutor } {
  const { runFn = runSelfOrganizingSubagent, clientProvider, ...selfOrgOptions } = options;

  return {
    definition: {
      name: 'spawn_self_organizing',
      description:
        'Spawn a self-organizing subagent with WORK/IDLE lifecycle. ' +
        'After finishing its initial task, it stays alive polling the inbox and task board for new work, ' +
        'and shuts down after an idle timeout (default 60s). Returns immediately with an acknowledgment; ' +
        'the agent runs in the background. Use name/role/identity to give it a persistent persona.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'A unique name for this agent (used for inbox addressing and task claiming)',
          },
          role: {
            type: 'string',
            description: 'The agent role, e.g. "coder", "reviewer", "researcher"',
          },
          identity: {
            type: 'string',
            description: 'A description of who the agent is and how it should behave',
          },
          prompt: {
            type: 'string',
            description: 'The initial task for the agent to work on',
          },
        },
        required: ['name', 'role', 'identity', 'prompt'],
      },
    },
    executor: async (input) => {
      const name = input.name as string;
      const role = input.role as string;
      const identity = input.identity as string;
      const prompt = input.prompt as string;

      // runSelfOrganizingSubagent 用 name/role/identity 构造 system prompt，
      // 初始任务（prompt）拼进 identity 末尾，作为它进入 WORK 阶段的第一份活。
      const identityWithTask = `${identity}\n\nYour initial task: ${prompt}`;

      // 后台启动：不 await，避免 WORK/IDLE 长循环阻塞主 agent 循环。
      // 错误必须本地捕获，否则变成 unhandledRejection 让进程不稳。
      runFn(name, role, identityWithTask, childTools, todoManager, inboxManager, {
        ...selfOrgOptions,
        client: clientProvider ? clientProvider('inherit') : undefined,
      }).catch((err: unknown) => {
        // 后台子代理失败不影响主循环，仅记录到 stderr
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[self-organizing:${name}] background error: ${msg}\n`);
      });

      return `Self-organizing agent "${name}" (${role}) launched in the background. ` +
        `It will work on the initial task, then poll for new work until idle timeout.`;
    },
  };
}
