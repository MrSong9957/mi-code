// Vercel AI SDK 客户端：支持多厂商（Anthropic、OpenAI、Google 等）
//
// 核心思路：让 Vercel AI SDK 处理整个工具调用循环，
// 我们只需要提供工具定义和执行函数。
//
// 物理本质：Vercel AI SDK 是"自动传送带"，
// 把消息发给 LLM → LLM 说要调工具 → 自动执行工具 → 把结果送回 LLM → 循环直到完成。
import { generateText, tool, jsonSchema } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ToolDefinition, ToolExecutor } from './types.js';
import type { PermissionChecker } from '../permission/checker.js';

/**
 * 将我们的工具转换为 Vercel AI SDK 格式
 *
 * 关键：在每个工具的 execute 外层包裹权限检查（四步管道），
 * 这是 Vercel AI SDK 路径下唯一的权限拦截点。
 * - checker 未传入时，行为退化为无拦截（向后兼容）。
 * - behavior=deny → 直接返回 [Blocked] 字符串，不调用原 executor
 * - behavior=ask  → 调用 onPermissionAsk 等待用户确认；拒绝则返回 [Blocked]
 * - behavior=allow → 调用原 executor
 */
function convertTools(
  definitions: ToolDefinition[],
  executors: Map<string, ToolExecutor>,
  permissionChecker?: PermissionChecker,
  onPermissionAsk?: (name: string, input: Record<string, unknown>, reason: string) => Promise<boolean>,
): Record<string, any> {
  const tools: Record<string, any> = {};

  for (const def of definitions) {
    const executor = executors.get(def.name);
    if (!executor) continue;

    tools[def.name] = tool({
      description: def.description,
      inputSchema: jsonSchema(def.parameters as any),
      execute: async (input: any) => {
        const typedInput = input as Record<string, unknown>;

        // 权限拦截（仅在传入 checker 时启用）
        if (permissionChecker) {
          const decision = permissionChecker.check(def.name, typedInput);
          if (decision.behavior === 'deny') {
            return `[Blocked by permission] ${decision.reason}`;
          }
          if (decision.behavior === 'ask') {
            const approved = onPermissionAsk
              ? await onPermissionAsk(def.name, typedInput, decision.reason)
              : false; // 无回调时默认拒绝（安全优先）
            if (!approved) {
              return '[Blocked by user] Permission denied';
            }
          }
        }

        return await executor(typedInput);
      },
    } as any);
  }

  return tools;
}

/** 创建 Anthropic 提供商 */
export function createAnthropicProvider(apiKey?: string) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is required. Set it in environment variables or pass it directly.');
  }
  return createAnthropic({ apiKey: key });
}

export interface VercelAIOptions {
  /** Parent-turn cancellation signal. */
  signal?: AbortSignal;
  model?: string;
  apiKey?: string;
  maxSteps?: number;
  system?: string;
  /** 权限检查器（传入后启用工具执行前的权限拦截） */
  permissionChecker?: PermissionChecker;
  /** 当权限决策为 ask 时调用，返回 true 表示用户同意放行 */
  onPermissionAsk?: (name: string, input: Record<string, unknown>, reason: string) => Promise<boolean>;
}

export interface VercelAIResult {
  text: string;
  steps: number;
  finishReason: string;
}

/**
 * 使用 Vercel AI SDK 执行 Agent 循环
 *
 * 这个函数替代了我们自己写的 agentLoop。
 * Vercel AI SDK 内置了：消息管理、工具调用、结果写回、循环控制。
 */
export async function runWithVercelAI(
  userMessage: string,
  tools: Map<string, { definition: ToolDefinition; executor: ToolExecutor }>,
  options: VercelAIOptions = {},
): Promise<VercelAIResult> {
  const modelId = options.model || 'claude-sonnet-4-20250514';
  const provider = createAnthropicProvider(options.apiKey);

  // 转换工具格式
  const definitions = Array.from(tools.values()).map(t => t.definition);
  const executors = new Map(Array.from(tools.entries()).map(([k, v]) => [k, v.executor]));
  const vercelTools = convertTools(definitions, executors, options.permissionChecker, options.onPermissionAsk);

  const result = await generateText({
    model: provider(modelId),
    system: options.system || 'You are a helpful assistant.',
    prompt: userMessage,
    tools: vercelTools,
    stopWhen: (options.maxSteps || 10) as any,
    abortSignal: options.signal,
  });

  return {
    text: result.text,
    steps: result.steps?.length || 1,
    finishReason: result.finishReason || 'stop',
  };
}
