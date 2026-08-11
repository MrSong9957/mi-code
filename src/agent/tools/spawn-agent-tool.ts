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
//
// AUTO-0025-stable:子代理内部工具活动不再转发到主 UI(删除进度桥接)。
// pending spawn_agent 由稳定指示器渲染(固定一行 + 闪烁 ●),消除活动区抖动。

import type { ToolDefinition, ToolExecutor, StreamingLLMClient } from '../types.js';
import type { ToolRegistry } from '../tool-registry.js';
import { runSubagent } from '../subagent.js';
import type {
  SubagentOptions,
  SubagentResult,
  SubagentExecutionResult,
} from '../subagent.js';
import type { SubagentJournalFactory } from '../subagent-journal.js';
import { formatSubagentResult } from '../subagent-result-format.js';
import { ROLE_REGISTRY, type Role, type SubagentModel } from '../roles.js';
import type { ToolExecutionRuntime } from '../tool-execution.js';
import type { DelegationGateDecision } from '../../permission/delegation.js';

// 共享 envelope formatter 从 subagent-result-format.ts 导入并 re-export,
// 保持现有 `import { formatSubagentResult } from '../tools/spawn-agent-tool.js'`
// 的调用方源兼容(spawn-agent-tool 仍是该函数的公开入口之一)。
export { formatSubagentResult } from '../subagent-result-format.js';

/** 子代理执行器类型（用于依赖注入，便于测试） */
type SubagentRunner = (
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions,
) => Promise<SubagentResult>;

/** RC-4 Wave A: contracted 子代理执行器类型（返回新 discriminated union） */
type SubagentContractedRunner = (
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions,
) => Promise<SubagentExecutionResult>;

/**
 * RC-4 Wave A: 把新的 {@link SubagentExecutionResult} discriminated union 序列化为
 * 工具输出字符串。
 *
 * 与 {@link formatSubagentResult}（legacy）的区别:
 *  - dispatch 结果(background)输出 `[Subagent dispatch task=<id> accepted=true]`,
 *    不带 outcome（background 还没完成,没有 outcome）。
 *  - completion 结果输出 `[Subagent outcome=<outcome> reason=<termination_reason> verification=<status>]\n<summary>`,
 *    用 outcome 而非扁平 status,并附带 verification 状态供主 agent 判断。
 *
 * 显式按 `kind` 分支,绝不把两路 merge 成松散对象。
 */
export function formatSubagentExecutionResult(result: SubagentExecutionResult): string {
  if (result.kind === 'dispatch') {
    return `[Subagent dispatch task=${result.receipt.task_id} accepted=${result.receipt.accepted}]\n`;
  }
  // kind === 'completion'
  const { report } = result;
  return `[Subagent outcome=${report.outcome} reason=${report.termination_reason} verification=${report.verification.status}]\n${report.summary}`;
}

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
  clientProvider: SubagentClientProvider | undefined,
  executionRuntime: ToolExecutionRuntime,
  /** 依赖注入：测试时传 mock，生产路径走真实 runSubagent */
  runSubagentFn: SubagentRunner = runSubagent,
  /** 可用技能描述（注入子代理 system prompt，让子代理发现/调用技能） */
  skillsDescription?: string,
  /** 获取主 agent 当前 system prompt（fork 模式用） */
  getParentSystemPrompt?: () => string,
  /**
   * RC-4 Wave A: 启用新 CompletionContract 路径。
   * 为 true 且提供 runSubagentContractedFn 时,executor 走新路径并调用
   * {@link formatSubagentExecutionResult};否则回退到 legacy
   * {@link formatSubagentResult} 路径(保持现有测试/调用方兼容)。
   */
  useCompletionContract: boolean = false,
  /**
   * RC-4 Wave A: 返回新 {@link SubagentExecutionResult} 的依赖注入 runner。
   * 仅当 useCompletionContract 为 true 时被调用。
   */
  runSubagentContractedFn?: SubagentContractedRunner,
  /**
   * Wave C Task 10 (M-067): Delegation least-privilege gate hook。
   *
   * 传入后, executor 在派发子代理前会调用此 hook。hook 接收 spawn 工具的原始 input
   * (role/prompt/fork), 由 hook 提供方负责:
   *   1. 从主 agent 运行时上下文收集 parent 边界(scope/tools/mode/provenance)
   *   2. 构造完整 {@link DelegationRequest}
   *   3. 调用 {@link evaluateDelegationGate} 获取 {@link DelegationGateDecision}
   *
   * 返回值处理:
   *   - status='allowed_once' → 继续派发
   *   - status='denied' → 返回错误文本, 不派发
   *   - status='awaiting_user' → hook 内部应已阻塞到 resolved (approved/rejected)
   *
   * 不传时(LEGACY)→ 不做 gate 检查, 直接派发(向后兼容, 现有测试/调用方零改动)。
   * 生产主路径(index.ts)应传入此 hook 以启用 CRC-5 delegation gate。
   */
  delegationGateHook?: (input: {
    role: string;
    prompt: string;
    fork: boolean;
  }) => Promise<DelegationGateDecision>,
  /**
   * 子代理工作日志工厂(可靠性路径)。
   *
   * 每次前台子代理执行调用一次,创建一个绑定到新 executionId 的独立 journal,
   * 透传给 runSubagentFn。这样即使 provider 崩溃,已完成的工作也能从 journal 恢复。
   * 不传时(LEGACY / 直接调用 runSubagent 的测试)行为不变。
   *
   * 必须在 input 校验和 delegation gate 通过之后创建 —— 否定委派 / 无效输入不分配 journal。
   */
  journalFactory?: SubagentJournalFactory,
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
          description: {
            type: 'string',
            description: 'Short user-facing label for this delegated task.',
          },
          fork: {
            type: 'boolean',
            description: 'Set to true for a subagent that inherits your full system prompt. Use when you need a worker with your exact capabilities for an independent parallel subtask.',
          },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional explicit allowlist of tool names for the child session. Replaces (not appends) the child session rules. Task/Agent/AgentTool are canonicalized to spawn_agent.',
          },
          permissionMode: {
            type: 'string',
            description: 'Optional child-declared permission mode (build/plan/auto). Parent privileged mode takes precedence.',
          },
        },
        required: ['role', 'prompt'],
      },
    },
    executor: async (input, ctx) => {
      const role = input.role as string;
      const prompt = (input.prompt as string)?.trim();
      const allowedTools = Array.isArray(input.allowedTools) ? (input.allowedTools as string[]) : undefined;
      const permissionMode = input.permissionMode as 'build' | 'plan' | 'auto' | undefined;

      if (!['explore', 'plan', 'general'].includes(role)) {
        return `Error: invalid role "${role}". Must be one of: explore, plan, general.`;
      }
      if (!prompt) {
        return 'Error: prompt is required';
      }

      const fork = input.fork === true;

      // Wave C Task 10 (M-067 / CRC-5): Delegation least-privilege gate。
      //
      // 在派发前调用 gate hook(如果提供)。hook 负责构造完整 DelegationRequest 并
      // 调用 evaluateDelegationGate。denied 时不派发, 返回错误文本。
      //
      // 不传 hook 时(LEGACY)跳过此检查, 保持向后兼容。
      if (delegationGateHook) {
        const decision = await delegationGateHook({ role, prompt, fork });
        if (decision.status === 'denied') {
          const reasons = decision.reason_codes.join(', ');
          return `[Delegation denied] ${reasons}`;
        }
        // allowed_once / awaiting_user(已 resolved 为 approved)→ 继续派发
      }

      // 子代理工作日志:在 input/gate 校验通过后、fork 分支前创建一次,
      // 让 fork 和 role-based 两条 foreground 路径复用同一 journal 实例。
      const journal = journalFactory?.();

      if (fork) {
        if (!getParentSystemPrompt) {
          return 'Error: fork mode is not available (no parent system prompt access).';
        }
        // RC-4 Wave A: 显式分支,绝不 merge 两路结果。
        if (useCompletionContract && runSubagentContractedFn) {
          const result = await runSubagentContractedFn(prompt, childTools, {
            client: clientProvider ? clientProvider('inherit') : undefined,
            executionRuntime,
            signal: ctx?.signal,
            maxSteps: 50,
            skillsDescription,
            forkMode: true,
            parentSystem: getParentSystemPrompt(),
            allowedTools,
            permissionMode,
          });
          return formatSubagentExecutionResult(result);
        }
        // fork 模式：继承主 agent system prompt，不走角色白名单
        const result = await runSubagentFn(prompt, childTools, {
          client: clientProvider ? clientProvider('inherit') : undefined,
          executionRuntime,
          signal: ctx?.signal,
          maxSteps: 50,  // fork 用于长任务
          skillsDescription,
          forkMode: true,
          parentSystem: getParentSystemPrompt(),
          // role 不传（undefined）→ filterToolsByRole 返回全量减黑名单
          journal,
          allowedTools,
          permissionMode,
        });
        // AUTO-0025 Task 5:输出携带结构化 status 前缀
        return formatSubagentResult(result);
      }

      // 正常角色派发（现有逻辑不变）
      // 从角色配置读 model 和 maxTurns（对齐 CC 的 per-role model/maxTurns）
      const roleConfig = ROLE_REGISTRY[role as Role];
      const modelChoice = roleConfig?.model ?? 'small';
      const maxSteps = roleConfig?.maxTurns ?? (role === 'explore' ? 25 : 15);

      // RC-4 Wave A: 显式分支,绝不 merge 两路结果。
      if (useCompletionContract && runSubagentContractedFn) {
        const result = await runSubagentContractedFn(prompt, childTools, {
          role: role as Role,
          client: clientProvider ? clientProvider(modelChoice) : undefined,
          executionRuntime,
          signal: ctx?.signal,
          maxSteps,
          skillsDescription,
          allowedTools,
          permissionMode,
        });
        return formatSubagentExecutionResult(result);
      }

      const result = await runSubagentFn(prompt, childTools, {
        role: role as Role,
        client: clientProvider ? clientProvider(modelChoice) : undefined,
        executionRuntime,
        signal: ctx?.signal,
        maxSteps,
        skillsDescription,
        journal,
        allowedTools,
        permissionMode,
      });
      // AUTO-0025 Task 5:输出携带结构化 status 前缀
      return formatSubagentResult(result);
    },
  };
}
