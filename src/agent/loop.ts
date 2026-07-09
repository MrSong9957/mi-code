// Agent 核心循环：把"模型的动作意图"变成"真实执行结果"，再把结果送回模型继续推理
//
// 带错误恢复：max_tokens 断点续接、prompt_too_long 压缩恢复、429 模型降级+退避。
import type {
  LLMClient,
  LoopState,
  AgentConfig,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from './types.js';
import { type ToolRegistry, partitionToolCalls, type ToolCall } from './tool-registry.js';
import type { HookRunner } from '../hooks/runner.js';
import type { BackgroundManager } from '../background/background-manager.js';
import { runCompaction, compactHistory, persistLargeOutput } from './compression.js';
import {
  createRecoveryState,
  classifyError,
  handleError,
  FailureInbox,
} from './recovery.js';
import { jitteredBackoff, sleep } from './backoff.js';

/** 循环事件回调 */
export interface LoopCallbacks {
  /** 每轮开始时触发 */
  onTurnStart?: (turn: number) => void;
  /** 模型回复时触发 */
  onAssistantMessage?: (content: ContentBlock[]) => void;
  /** 工具执行前触发 */
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  /** 工具执行后触发 */
  onToolResult?: (toolUseId: string, result: string) => void;
  /** 循环结束时触发 */
  onLoopEnd?: (reason: string) => void;
  /** 错误恢复时触发 */
  onRecovery?: (errorType: string, attempt: number, action: string) => void;
}

/** 工具执行上下文（生产级：封装权限、信号、预算） */
export interface ToolUseContext {
  /** 用户中止信号 */
  abortSignal?: AbortSignal;
  /** 当前累计费用（美元） */
  costSoFar?: number;
}

/** 扩展循环状态（生产级字段） */
export interface ExtendedLoopState extends LoopState {
  /** 是否已尝试过 reactive compact（防止无限压缩重试） */
  hasAttemptedReactiveCompact: boolean;
  /** max_output_tokens 恢复次数 */
  maxOutputTokensRecoveryCount: number;
  /** 当前使用的 max_output_tokens */
  maxOutputTokensOverride: number | null;
}

/** 创建初始循环状态 */
export function createLoopState(userMessage: string): ExtendedLoopState {
  return {
    messages: [{ role: 'user', content: userMessage }],
    turn_count: 0,
    transition_reason: null,
    hasAttemptedReactiveCompact: false,
    maxOutputTokensRecoveryCount: 0,
    maxOutputTokensOverride: null,
  };
}

/**
 * Agent 核心循环
 *
 * 关键逻辑：
 * 1. 调用模型
 * 2. 追加 assistant 回复到历史
 * 3. 如果模型调用了工具，就执行
 * 4. 把工具结果写回消息历史（关键！）
 * 5. 下一轮继续
 */
export async function agentLoop(
  state: ExtendedLoopState,
  config: AgentConfig,
  client: LLMClient,
  registry: ToolRegistry,
  callbacks: LoopCallbacks = {},
  hookRunner?: HookRunner,
  backgroundManager?: BackgroundManager,
  toolUseContext?: ToolUseContext,
): Promise<string> {
  const maxTurns = config.max_turns;
  const budgetLimit = config.budget_limit;

  // 初始化恢复状态机
  const recovery = createRecoveryState(config.model, config.max_output_tokens ?? 8000);
  const inbox = new FailureInbox();

  while (state.turn_count < maxTurns) {
    // Abort 信号检查
    if (toolUseContext?.abortSignal?.aborted) {
      callbacks.onLoopEnd?.('user_abort');
      return 'Loop aborted by user';
    }

    // Budget 检查
    if (budgetLimit && (toolUseContext?.costSoFar ?? 0) >= budgetLimit) {
      callbacks.onLoopEnd?.('budget_limit');
      return `Loop ended: budget limit ($${budgetLimit}) reached`;
    }
    callbacks.onTurnStart?.(state.turn_count + 1);

    // 0. 排空后台任务通知（聚合格式），注入消息历史
    if (backgroundManager) {
      const aggregated = backgroundManager.drainNotificationsAggregated();
      if (aggregated) {
        state.messages.push({ role: 'user', content: aggregated });
      }
    }

    // 0.5 上下文压缩（L1 + L2），如果仍超标则 L4
    const { messages: compacted, needsL4 } = runCompaction(state.messages);
    state.messages = needsL4 ? compactHistory(compacted) : compacted;

    // 1. 调用模型（带错误恢复）
    let response;
    try {
      // 使用 recovery 中的动态配置调用模型
      response = await client.create(state.messages, config.tools);
    } catch (error) {
      // 错误分类 → 恢复策略分流
      const errorType = classifyError(error);
      const canRetry = handleError(
        errorType,
        recovery,
        inbox,
        state.messages,
        compactHistory,
      );

      callbacks.onRecovery?.(errorType, recovery.retryAttempt, inbox.getHistory().slice(-1)[0]?.action ?? '');

      if (canRetry) {
        // 429 需要退避延迟
        if (errorType === 'rate_limited_429') {
          const delay = jitteredBackoff(recovery.retryAttempt);
          await sleep(delay);
        }
        continue; // 带上修改后的参数重试本轮
      }

      // 无法自愈，抛出
      callbacks.onLoopEnd?.('recovery_failed');
      throw error;
    }

    // 1.5 检查 stop_reason 为 max_tokens（模型自身报告截断）
    if (response.stop_reason === 'max_tokens') {
      const canRetry = handleError(
        'max_tokens_exceeded',
        recovery,
        inbox,
        state.messages,
        compactHistory,
      );

      callbacks.onRecovery?.('max_tokens_exceeded', recovery.retryAttempt, inbox.getHistory().slice(-1)[0]?.action ?? '');

      if (canRetry) {
        continue; // 追加续写占位消息后重试
      }

      callbacks.onLoopEnd?.('recovery_failed');
      throw new Error('max_tokens recovery failed: exceeded retry limit');
    }

    // 成功：重置重试计数
    recovery.retryAttempt = 0;

    // 2. 追加 assistant 回复到历史
    state.messages.push({ role: 'assistant', content: response.content });
    callbacks.onAssistantMessage?.(response.content);

    // 2.5 Reactive compact：如果模型返回了错误/拒绝且未尝试过压缩，压缩后重试
    const hasToolUseEarly = response.content.some(b => b.type === 'tool_use');
    const text = extractTextFromContent(response.content);
    const isRejected = response.stop_reason === 'end_turn' && !hasToolUseEarly &&
      (text.includes('error') || text.includes('too long') || text.includes('context length'));
    if (isRejected && !state.hasAttemptedReactiveCompact) {
      state.hasAttemptedReactiveCompact = true;
      state.messages = compactHistory(state.messages);
      continue; // 压缩后重试
    }

    // 3. 检查停止条件
    //    生产级用 needsFollowUp（内容中是否含 tool_use 块）替代 stop_reason。
    //    原因：流式传输时 stop_reason 不可靠，而 tool_use 块在内容中是确定的。
    const hasToolUse = response.content.some(b => b.type === 'tool_use');
    const needsFollowUp = hasToolUse;

    if (!needsFollowUp) {
      // 安全退出拦截：后台还有 running 任务 → 等待完成
      if (backgroundManager) {
        const running = backgroundManager.getRunningTaskIds();
        if (running.length > 0 && state.turn_count < maxTurns - 1) {
          const aggregated = backgroundManager.drainNotificationsAggregated();
          const hint = aggregated
            ? aggregated
            : `[AWAIT] ${running.length} background task(s) still running: ${running.join(', ')}. Wait or check status.`;
          state.messages.push({ role: 'user', content: hint });
          state.turn_count++;
          continue;
        }
      }
      state.transition_reason = null;
      callbacks.onLoopEnd?.(response.stop_reason);
      return extractTextFromContent(response.content);
    }

    // 4. 执行工具（并发分区：只读并行，写串行）
    const toolCalls: ToolCall[] = response.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }));

    const batches = partitionToolCalls(toolCalls);
    const results: ToolResultBlock[] = [];
    // idle 检测：若本轮调用了 idle，执行完后跳出循环，不把 IDLE_REQUESTED 写回 messages。
    let idleRequested = false;

    for (const batch of batches) {
      if (batch.parallel) {
        // 并行执行只读工具
        const batchResults = await Promise.all(
          batch.calls.map(async (call) => {
            callbacks.onToolCall?.(call.name, call.input);
            const rawOutput = await registry.execute(call.name, call.input);
            const output = persistLargeOutput(call.id, rawOutput, call.name);
            callbacks.onToolResult?.(call.id, output);
            if (call.name === 'idle') idleRequested = true;
            return { type: 'tool_result' as const, tool_use_id: call.id, content: output };
          }),
        );
        results.push(...batchResults);
      } else {
        // 串行执行写工具（含 hook 检查）
        for (const call of batch.calls) {
          callbacks.onToolCall?.(call.name, call.input);

          // PreToolUse hook
          if (hookRunner) {
            const pre = await hookRunner.run({
              name: 'PreToolUse',
              payload: { tool_name: call.name, input: call.input },
            });
            if (pre.exitCode === 1) {
              results.push({ type: 'tool_result', tool_use_id: call.id, content: `[Blocked] ${pre.message}` });
              continue;
            }
            if (pre.exitCode === 2) {
              state.messages.push({ role: 'user', content: pre.message });
            }
          }

          const rawOutput = await registry.execute(call.name, call.input);
          const output = persistLargeOutput(call.id, rawOutput, call.name);

          // idle 检测
          if (call.name === 'idle') idleRequested = true;

          // PostToolUse hook
          if (hookRunner) {
            await hookRunner.run({
              name: 'PostToolUse',
              payload: { tool_name: call.name, input: call.input, output },
            });
          }

          results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
          callbacks.onToolResult?.(call.id, output);
        }
      }
    }

    // idle 跳出：本轮调用了 idle 工具，终止循环。
    // 关键：不把 IDLE_REQUESTED 写回 messages（否则下一轮 LLM 收到无意义反馈会重复生成）。
    if (idleRequested) {
      callbacks.onLoopEnd?.('idle');
      return extractTextFromContent(response.content);
    }

    // 5. 把工具结果写回消息历史（关键！）
    state.messages.push({ role: 'user', content: results });

    // 6. 更新状态
    state.turn_count++;
    state.transition_reason = 'tool_result';
  }

  // 达到最大轮数
  callbacks.onLoopEnd?.('max_turns');
  return 'Loop ended: maximum turns reached';
}

/** 从内容块中提取文本 */
function extractTextFromContent(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && 'text' in block) {
      parts.push(block.text);
    }
  }
  return parts.join('\n') || 'No text response';
}
