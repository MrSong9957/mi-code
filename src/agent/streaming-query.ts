// 流式查询循环：AI 调用 → 工具执行 → 再次调用 AI，直到完成
//
// 物理本质：打乒乓球。
// 1. 用户发球（发消息）
// 2. AI 接球并回球（调用 AI，可能触发工具）
// 3. 工具执行（捡球）
// 4. AI 继续回球（用工具结果继续对话）
// 5. 直到 AI 不再需要工具（回合结束）

import type {
  Message,
  ContentBlock,
  ToolDefinition,
  ToolUseBlock,
  ToolResultBlock,
  StreamingLLMClient,
  StreamEvent,
  AssistantMessage,
} from './types.js';
import { isStreamEvent } from './types.js';
import { QueryEngine, type NormalizedMessage, type QueryEngineOptions } from './query-engine.js';
import { StreamingToolExecutor } from './streaming-executor.js';
import { StreamEventBus } from './stream-event-bus.js';
import type { ToolRegistry } from './tool-registry.js';
import type { PermissionChecker } from '../permission/checker.js';
import { runCompaction, compactHistoryWithLLM } from './compression.js';
import {
  createRecoveryState,
  classifyError,
  handleError,
  FailureInbox,
} from './recovery.js';
import { jitteredBackoff, sleep } from './backoff.js';
import type { StructuredAskResult } from './ask-user-types.js';
import { askOutcomeStore } from './ask-outcome-store.js';

/**
 * 流式路径下的权限预检：返回是否被拦截及回写给模型的输出文本。
 *
 * 当前流式路径无用户确认通道，**ask 决策保持旧行为（放行）**，
 * 仅 deny 真正拦截（plan 模式、危险命令、用户 deny 规则、越界路径）。
 * 这样既补上了 plan/危险命令的硬拦截，又不回归 default 模式下写工具的可用性。
 * 未来若引入 ask 回调，可在此处接入。
 */
function checkPermissionOrBlock(
  name: string,
  input: Record<string, unknown>,
  checker?: PermissionChecker,
): { blocked: boolean; output: string | null } {
  if (!checker) return { blocked: false, output: null };
  const decision = checker.check(name, input);
  if (decision.behavior === 'deny') {
    return { blocked: true, output: `[Blocked by permission] ${decision.reason}` };
  }
  return { blocked: false, output: null };
}

/** 流式查询消息（所有可能的输出类型） */
export type StreamMessage =
  | NormalizedMessage
  | StreamEvent
  // AUTO-0025 Phase B (Task 10):structuredOutcome 走 UI 通道(仅 ask_user_question 有)。
  | { type: 'tool_result'; toolUseId: string; name: string; output: string; structuredOutcome?: StructuredAskResult };

/** 流式查询选项 */
export interface StreamingQueryOptions {
  systemPrompt: string;
  tools: ToolDefinition[];
  signal: AbortSignal;
  maxTokens?: number;
  maxTurns?: number;
  enableStreamingExecution?: boolean;
  eventBus?: StreamEventBus;
  model?: string;
  /**
   * 压缩用的小模型客户端（L4 全量摘要时调用）。
   * 物理本质：办公桌堆满时，请来帮忙整理的"临时秘书"。
   * 留空时 needsL4 仅发警告（保持旧行为），不实际压缩。
   */
  compactClient?: StreamingLLMClient;
  /**
   * 初始历史消息（resume 时传入之前的会话）。
   * 若提供，本次查询会在这些历史基础上继续，而非从单条 user 消息开始。
   */
  initialMessages?: Message[];
  /**
   * 查询结束时回调，传入最终的完整消息列表（含本次新增）。
   * 用于会话持久化（落盘到 JSONL）。
   */
  onMessages?: (messages: Message[]) => void;
  /**
   * 权限检查器（传入后启用工具执行前的权限拦截）。
   * 流式路径无用户确认通道，仅 deny 决策真正拦截；ask 保持旧行为（放行）。
   * 与 checkPermissionOrBlock 的实现一致，与 streaming-executor.ts 的 deny 拦截一致。
   */
  permissionChecker?: PermissionChecker;
  /**
   * AUTO-0025 Task 4:保留一个"无工具的最终总结轮"。
   *
   * 物理本质:maxTurns 边界前,最后一轮强制不暴露工具,让模型只能用已有工具结果
   * 产出基于证据的总结,避免"Now let me check..."等过程句被当成最终结果。
   *
   * 启用条件:reserveFinalTextTurn=true 且 maxTurns 已定义。
   * 仅在 runSubagentWithClient 启用;主 agent 行为不变(默认 undefined)。
   * 最后一轮计入 maxTurns 边界,不通过无限增加轮次规避问题。
   */
  reserveFinalTextTurn?: boolean;
}

/**
 * 流式查询循环
 *
 * 核心算法（对齐 Claude Code）：
 *   while true:                                    ← 默认无限循环
 *     0. 用户 ESC / maxTurns guard（仅显式传入时） → 退出
 *     1. 调用 AI（流式）
 *     2. 收集工具调用
 *     3. 如果没有工具调用 → 结束（LLM 自主 end_turn）
 *     4. 执行工具（流式执行器）
 *     5. 将工具结果加入消息历史
 *     6. 继续循环
 *
 * 退出权优先级：用户 ESC > 显式 maxTurns > LLM 自主 end_turn > 错误恢复失败。
 * 不传 maxTurns = 无限（依赖 LLM 自主收尾 + ESC + budget 软限制）。
 */
export async function* streamingQuery(
  client: StreamingLLMClient,
  registry: ToolRegistry,
  userMessage: string | ContentBlock[],
  options: StreamingQueryOptions,
): AsyncGenerator<StreamMessage> {
  const {
    systemPrompt,
    tools,
    signal,
    maxTokens = 8192,
    maxTurns,
    enableStreamingExecution = true,
    eventBus,
    model = 'claude-sonnet-4-20250514',
    compactClient,
    initialMessages,
    onMessages,
    permissionChecker,
    reserveFinalTextTurn = false,
  } = options;

  const engine = new QueryEngine(client);
  // 初始历史：resume 时传入之前的会话 + 本次 user 消息；否则从单条 user 消息开始
  let messages: Message[] = initialMessages && initialMessages.length > 0
    ? [...initialMessages, { role: 'user' as const, content: userMessage }]
    : [{ role: 'user' as const, content: userMessage }];
  let turnCount = 0;

  // 错误恢复状态
  const recoveryState = createRecoveryState(model, maxTokens);
  const failureInbox = new FailureInbox();

  try {
  // 对齐 Claude Code：默认无限循环，仅当显式传入 maxTurns 时作为安全网触发。
  // 退出条件优先级：用户 ESC > 显式 maxTurns guard > LLM 自主 end_turn。
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Abort 检查
    if (signal.aborted) {
      eventBus?.emitLoopEnd({ reason: 'user_abort' });
      return;
    }

    // maxTurns 安全网检查（仅在显式传入时启用，undefined = 无限）
    if (maxTurns !== undefined && turnCount >= maxTurns) {
      eventBus?.emitLoopEnd({ reason: 'max_turns' });
      return;
    }

    turnCount++;

    // ═══════ 阶段 1：调用 AI（流式）═══════
    const assistantMessages: AssistantMessage[] = [];
    const toolUseBlocks: ToolUseBlock[] = [];
    const toolStartTimes = new Map<string, number>();
    let needsFollowUp = false;

    // 创建流式工具执行器
    const streamingExecutor = enableStreamingExecution
      ? new StreamingToolExecutor(registry, permissionChecker)
      : null;

    // AUTO-0025 Task 4:判断本轮是否是"无工具的最终总结轮"。
    //
    // 物理语义:循环顶部已检查 turnCount >= maxTurns → return,所以走到这里时
    // turnCount(maxTurns 内的最大值,刚 ++ 完)正是最后一次允许的模型调用。
    // 判断条件:turnCount === maxTurns 且 maxTurns >= 2。
    //
    // maxTurns >= 2 的要求:至少留 1 轮给工具收集证据 + 1 轮给总结。
    // maxTurns=1 时没空间留总结轮,不启用(否则第 1 轮就被强制无工具,子代理无法收集证据)。
    //
    // 例如 maxTurns=2:第 1 轮(turnCount=1)正常调工具,第 2 轮(turnCount=2)是 final,
    // 强制 tools=[] + 注入"基于证据总结"指令,模型只能用第 1 轮的工具结果产出总结。
    // 这一轮计入 maxTurns 边界,不通过无限增加轮次规避问题。
    const finalTextTurn = reserveFinalTextTurn
      && maxTurns !== undefined
      && maxTurns >= 2
      && turnCount === maxTurns;

    const queryOptions: QueryEngineOptions = {
      systemPrompt: finalTextTurn
        ? `${systemPrompt}\n\nFinal turn: do not call tools. Return a concise factual summary based only on tool results already present in the conversation.`
        : systemPrompt,
      tools: finalTextTurn ? [] : tools,
      signal,
      maxTokens: recoveryState.maxTokens,
    };

    try {
      for await (const message of engine.submit(messages, queryOptions)) {
        // 透传流式事件给 UI
        if (isStreamEvent(message)) {
          eventBus?.emitStreamEvent(message);
          yield message;
          continue;
        }

        // 处理助手消息
        if (message.type === 'assistant') {
          assistantMessages.push(message as AssistantMessage);
          eventBus?.emitAssistantMessage(message as AssistantMessage);
          yield message as NormalizedMessage;

          // 收集工具调用
          for (const block of message.content) {
            if (block.type === 'tool_use') {
              toolUseBlocks.push(block as ToolUseBlock);
              needsFollowUp = true;

              // 流式执行：AI 还在输出时就开始执行工具
              if (streamingExecutor) {
                streamingExecutor.addTool(block as ToolUseBlock);
                const startTime = Date.now();
                toolStartTimes.set(block.id, startTime);
                eventBus?.emitToolCall({
                  toolUseId: (block as ToolUseBlock).id,
                  name: (block as ToolUseBlock).name,
                  input: (block as ToolUseBlock).input,
                  startTime,
                });
              }
            }
          }
        }
      }
    } catch (error) {
      // 错误恢复：分类错误并决定是否重试
      const errorType = classifyError(error);
      const canRetry = handleError(
        errorType,
        recoveryState,
        failureInbox,
        messages,
        (msgs) => runCompaction(msgs).messages,
      );

      if (canRetry) {
        // 记录错误并继续循环重试
        eventBus?.emitError({
          errorType,
          message: String(error),
          recoverable: true,
        });
        // 429 限流需要退避延迟，否则立即重试会触发二次限流甚至封禁
        if (errorType === 'rate_limited_429') {
          const delay = jitteredBackoff(recoveryState.retryAttempt);
          await sleep(delay);
        }
        continue;
      } else {
        // 无法恢复，抛出错误
        eventBus?.emitError({
          errorType,
          message: String(error),
          recoverable: false,
        });
        eventBus?.emitLoopEnd({ reason: 'error' });
        throw error;
      }
    }

    // ═══════ 阶段 2：检查是否继续 ═══════
    if (!needsFollowUp) {
      // AUTO-0030 修复:end_turn 退出前必须把本轮 assistant 消息合并进 messages,
      // 否则 finally 里 onMessages(messages) 回调出去的数组漏掉最后一条 assistant,
      // 持久化层(index.ts → sessionStore.append)落盘的 JSONL 会缺这条消息。
      // 原 bug:此处直接 return 跳过了阶段 4 的 messages 合并步骤。
      if (assistantMessages.length > 0) {
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: assistantMessages.flatMap(m => m.content),
          },
        ];
      }
      eventBus?.emitLoopEnd({ reason: 'end_turn' });
      return;
    }

    // ═══════ 阶段 3：获取工具执行结果 ═══════
    const toolResults: ToolResultBlock[] = [];
    // idle 检测：若本轮工具调用里出现 idle，收集完结果后跳出循环，
    // 不把 IDLE_REQUESTED 写回 messages（否则下一轮 LLM 收到无意义反馈，
    // 会重新生成一遍刚说过的内容——这是"一条消息回复两次"的根因）。
    let idleRequested = false;

    if (streamingExecutor) {
      // 流式执行器已经在后台执行了，这里等待结果
      for await (const batch of streamingExecutor.getRemainingResults()) {
        for (const tool of batch) {
          const output = tool.results?.[0]?.type === 'text'
            ? (tool.results[0] as { type: 'text'; text: string }).text
            : tool.error || '[No output]';

          const result: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: tool.id,
            content: output,
          };
          toolResults.push(result);

          // idle 工具被调用 → 标记跳出（仍 emitToolResult 让 UI 显示 ⎿ 结果）
          if (tool.block.name === 'idle') {
            idleRequested = true;
          }

          // AUTO-0025 Phase B (Task 11):meta 旁路消费端。
          // 从 outcome store take 出结构化结果(ask_user_question executor 在 Task 9 写入)。
          // take 即删:正常路径下一次性消费。take miss 检测:ask_user_question 执行后 store 应有 entry,
          // 若返回 undefined 说明 set/take 时序异常或 toolUseId 不匹配(开发错误,非运行错误)。
          // DEBUG 门控:正常不输出(避免污染终端),调试时 DEBUG=1 可见。
          const structuredOutcome = askOutcomeStore.take(tool.id);
          if (!structuredOutcome && tool.block.name === 'ask_user_question' && process.env.DEBUG) {
            console.error('[streaming-query] ask_user_question outcome missing in store', { toolUseId: tool.id });
          }

          eventBus?.emitToolResult({
            toolUseId: tool.id,
            name: tool.block.name,
            output,
            duration: Date.now() - (toolStartTimes.get(tool.id) ?? Date.now()),
            structuredOutcome,
          });

          yield {
            type: 'tool_result',
            toolUseId: tool.id,
            name: tool.block.name,
            output,
            structuredOutcome,
          };
        }
      }
    } else {
      // 传统方式：串行执行所有工具
      for (const block of toolUseBlocks) {
        // 权限预检（流式路径无确认通道，仅 deny 拦截，ask 放行）
        const guard = checkPermissionOrBlock(block.name, block.input, permissionChecker);
        if (guard.blocked && guard.output) {
          const output = guard.output;
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
          eventBus?.emitToolResult({
            toolUseId: block.id,
            name: block.name,
            output,
            duration: Date.now() - (toolStartTimes.get(block.id) ?? Date.now()),
          });
          yield { type: 'tool_result', toolUseId: block.id, name: block.name, output };
          continue;
        }
        try {
          const output = await registry.execute(block.name, block.input, { toolUseId: block.id });
          const result: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: block.id,
            content: output,
          };
          toolResults.push(result);

          // idle 工具被调用 → 标记跳出
          if (block.name === 'idle') {
            idleRequested = true;
          }

          // AUTO-0025 Phase B (Task 11):meta 旁路消费端(传统分支,与流式分支对齐)。
          const structuredOutcome = askOutcomeStore.take(block.id);
          if (!structuredOutcome && block.name === 'ask_user_question' && process.env.DEBUG) {
            console.error('[streaming-query] ask_user_question outcome missing in store', { toolUseId: block.id });
          }

          eventBus?.emitToolResult({
            toolUseId: block.id,
            name: block.name,
            output,
            duration: Date.now() - (toolStartTimes.get(block.id) ?? Date.now()),
            structuredOutcome,
          });

          yield {
            type: 'tool_result',
            toolUseId: block.id,
            name: block.name,
            output,
            structuredOutcome,
          };
        } catch (error) {
          const output = `[Tool Error] ${String(error)}`;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: output,
          });

          eventBus?.emitToolResult({
            toolUseId: block.id,
            name: block.name,
            output,
            duration: Date.now() - (toolStartTimes.get(block.id) ?? Date.now()),
          });

          yield {
            type: 'tool_result',
            toolUseId: block.id,
            name: block.name,
            output,
          };
        }
      }
    }

    // idle 跳出：本轮调用了 idle 工具，不再继续循环。
    // 关键：不进入阶段 4（不把 IDLE_REQUESTED 写回 messages），
    // 否则下一轮 LLM 收到无意义反馈会重复生成。
    if (idleRequested) {
      eventBus?.emitLoopEnd({ reason: 'idle' });
      return;
    }

    // ═══════ 阶段 4：更新消息历史，继续循环 ═══════
    messages = [
      ...messages,
      // assistant 消息（包含 tool_use 块）
      {
        role: 'assistant',
        content: assistantMessages.flatMap(m => m.content),
      },
      // tool_result 消息
      { role: 'user', content: toolResults },
    ];

    // 上下文压缩：防止消息历史无限增长
    const { messages: compacted, needsL4 } = runCompaction(messages);
    messages = compacted;
    if (needsL4) {
      if (compactClient) {
        // 有小模型：请"临时秘书"整理整本工作日志（失败时内部回退本地启发式，不崩）
        messages = await compactHistoryWithLLM(messages, compactClient);
        eventBus?.emitError({
          errorType: 'context_overflow',
          message: 'Context compacted via small model summary',
          recoverable: true,
        });
      } else {
        // 无小模型：仅发警告（保持旧行为）
        eventBus?.emitError({
          errorType: 'context_overflow',
          message: 'Context window exceeded, compaction recommended',
          recoverable: true,
        });
      }
    }
  }
  // 循环退出全靠循环体内的 return（user_abort / max_turns guard / end_turn / 错误恢复失败）。
  // 落到这里说明逻辑有漏洞——记录后兜底退出，避免死循环。
  eventBus?.emitLoopEnd({ reason: 'unexpected_exit' });
  } finally {
    // AUTO-0025 Phase B (Task 11):turn 结束兜底清理 outcome store。
    // 正常路径下 take 已消费所有 entry;此处清理未消费的(take miss / 权限拦截 / 异常路径留下的)。
    // 配合 TTL 5min 双保险防 orphan/内存泄漏。
    askOutcomeStore.sweep();
    // 无论正常结束/错误/中断，都把最终消息列表回调出去（供会话持久化落盘）
    if (onMessages) onMessages(messages);
  }
}
