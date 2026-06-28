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
import { runCompaction, compactHistoryWithLLM } from './compression.js';
import {
  createRecoveryState,
  classifyError,
  handleError,
  FailureInbox,
} from './recovery.js';

/** 流式查询消息（所有可能的输出类型） */
export type StreamMessage =
  | NormalizedMessage
  | StreamEvent
  | { type: 'tool_result'; toolUseId: string; name: string; output: string };

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
}

/**
 * 流式查询循环
 *
 * 核心算法：
 *   while turnCount < maxTurns:
 *     1. 调用 AI（流式）
 *     2. 收集工具调用
 *     3. 如果没有工具调用 → 结束
 *     4. 执行工具（流式执行器）
 *     5. 将工具结果加入消息历史
 *     6. 继续循环
 */
export async function* streamingQuery(
  client: StreamingLLMClient,
  registry: ToolRegistry,
  userMessage: string,
  options: StreamingQueryOptions,
): AsyncGenerator<StreamMessage> {
  const {
    systemPrompt,
    tools,
    signal,
    maxTokens = 8192,
    maxTurns = 10,
    enableStreamingExecution = true,
    eventBus,
    model = 'claude-sonnet-4-20250514',
    compactClient,
  } = options;

  const engine = new QueryEngine(client);
  let messages: Message[] = [{ role: 'user', content: userMessage }];
  let turnCount = 0;

  // 错误恢复状态
  const recoveryState = createRecoveryState(model, maxTokens);
  const failureInbox = new FailureInbox();

  while (turnCount < maxTurns) {
    // Abort 检查
    if (signal.aborted) {
      eventBus?.emitLoopEnd({ reason: 'user_abort' });
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
      ? new StreamingToolExecutor(registry)
      : null;

    const queryOptions: QueryEngineOptions = {
      systemPrompt,
      tools,
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
      eventBus?.emitLoopEnd({ reason: 'end_turn' });
      return;
    }

    // ═══════ 阶段 3：获取工具执行结果 ═══════
    const toolResults: ToolResultBlock[] = [];

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

          eventBus?.emitToolResult({
            toolUseId: tool.id,
            name: tool.block.name,
            output,
            duration: Date.now() - (toolStartTimes.get(tool.id) ?? Date.now()),
          });

          yield {
            type: 'tool_result',
            toolUseId: tool.id,
            name: tool.block.name,
            output,
          };
        }
      }
    } else {
      // 传统方式：串行执行所有工具
      for (const block of toolUseBlocks) {
        try {
          const output = await registry.execute(block.name, block.input);
          const result: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: block.id,
            content: output,
          };
          toolResults.push(result);

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

  // 达到最大轮数
  eventBus?.emitLoopEnd({ reason: 'max_turns' });
}
