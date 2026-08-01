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
import type { ToolDefinitionSnapshot } from './tools/descriptor-snapshot.js';
import type { RequestToolViewSnapshot } from './tools/overlay.js';
import {
  executeToolCall,
  type ToolExecutionResult,
  type ToolExecutionRuntime,
} from './tool-execution.js';
import { runCompaction, compactHistoryWithLLM } from './compression.js';
import {
  createRecoveryState,
  classifyError,
  handleError,
  FailureInbox,
} from './recovery.js';
import { formatUnknownError } from '../utils/error-message.js';
import { jitteredBackoff, sleep } from './backoff.js';
import type { StructuredAskResult } from './ask-user-types.js';
import { askOutcomeStore } from './ask-outcome-store.js';
import {
  validateToolTranscript,
  type ToolTranscriptSnapshot,
  type ToolTranscriptValidation,
  type TranscriptCheckpoint,
} from './tools/transcript-validator.js';
import type { NoToolRequestContract } from './tools/no-tool-contract.js';
import { createHash } from 'node:crypto';

/**
 * Wave B Task 11 (M-070 / BRC-5): 四 checkpoint 共享的 validator policy 身份。
 *
 * 物理本质: validator 的"身份铭牌"。validator 的确定性与 validation_id 哈希都依赖
 * policy_id + policy_version,这里固定一个本进程级的身份,所有 checkpoint 复用同一份。
 * 未来由 Authority 注入时,替换这一常量即可。
 */
const VALIDATOR_POLICY_ID = 'pairing';
const VALIDATOR_POLICY_VERSION = '1';

/**
 * Wave B Task 11: 本进程级的 session/turn 标识(简单确定性值)。
 *
 * 物理本质: validator pair_records 上要求带 session_id / turn_id。本进程内不需要全局唯一,
 * 只要确定性即可(streamingQuery 的调用方目前没有传入 session/turn id 的入口)。
 * 后续 Wave 如果引入权威的 session/turn 身份,把这两个值换成调用方传入的参数。
 */
const STREAMING_SESSION_ID = 'sess:streaming-query';
function makeTurnId(turnCount: number): string {
  return `turn:${turnCount}`;
}

/**
 * Wave B Task 11: 从 messages 构造一份不可变 ToolTranscriptSnapshot。
 *
 * transcript_snapshot_id 用 messages 内容的 sha256 短哈希 —— 同一 messages 数组产生同一 id,
 * 不同数组产生不同 id(确定性,便于配对 validation 与重放)。前缀 `ts:` 与 spec 约定一致。
 */
function buildTranscriptSnapshot(messages: Message[], turnId: string): ToolTranscriptSnapshot {
  const hash = createHash('sha256')
    .update(JSON.stringify(messages))
    .digest('hex')
    .slice(0, 16);
  return {
    transcript_snapshot_id: `ts:${hash}`,
    session_id: STREAMING_SESSION_ID,
    turn_id: turnId,
    messages,
  };
}

/**
 * Wave B Task 11: 在指定 checkpoint 上跑 validator,按 status 决定是否 fail-closed。
 *
 *   - accepted: 返回 validation(调用方可继续往下走)。
 *   - blocked:  抛 `{ code: 'tool_transcript.invalid', checkpoint, status: 'blocked' }`。
 *   - rejected: 抛 `{ code: 'tool_transcript.invalid', checkpoint, status: 'rejected', reason_codes }`。
 *
 * Wave B 约定: blocked 时采取"最简正确行为"—— fail-closed,不进入 wait/retry 循环
 * (真实 wait/retry 是更丰富的行为,留给后续 Wave;当前实现已用文档记录此约束)。
 * blocked 的典型来源是 pending_execution(工具还在执行),此时 fail-closed 会让
 * 调用方看到错误并选择如何处理(通常是上层重试整个 streamingQuery)。
 */
function enforceCheckpoint(
  checkpoint: TranscriptCheckpoint,
  messages: Message[],
  turnId: string,
): ToolTranscriptValidation {
  const snapshot = buildTranscriptSnapshot(messages, turnId);
  const validation = validateToolTranscript(snapshot, {
    checkpoint,
    validator_policy_id: VALIDATOR_POLICY_ID,
    validator_policy_version: VALIDATOR_POLICY_VERSION,
  });
  if (validation.status === 'blocked') {
    throw {
      code: 'tool_transcript.invalid',
      checkpoint,
      status: 'blocked',
      validation_id: validation.validation_id,
    };
  }
  if (validation.status === 'rejected') {
    throw {
      code: 'tool_transcript.invalid',
      checkpoint,
      status: 'rejected',
      reason_codes: validation.reason_codes,
      validation_id: validation.validation_id,
    };
  }
  return validation;
}

/** 流式查询消息（所有可能的输出类型） */
export type StreamMessage =
  | NormalizedMessage
  | StreamEvent
  // AUTO-0025 Phase B (Task 10):structuredOutcome 走 UI 通道(仅 ask_user_question 有)。
  | {
      type: 'tool_result';
      toolUseId: string;
      name: string;
      output: string;
      structuredOutcome?: StructuredAskResult;
      executionResult?: ToolExecutionResult;
    };

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
   * 子代理工作日志 checkpoint:每完成一条消息边界(awaited)落盘一次。
   *
   * 物理本质:子代理每打完一回合("工具调用 + 工具结果配对完成"或"无工具的最终
   * assistant"),把当前完整的 messages 快照交给调用方持久化。awaited 语义保证
   * 落盘返回前不会启动下一轮 provider 调用 —— 这样即使后续 provider/通信失败,
   * 已完成的工作也能从 checkpoint 恢复(fail-fast:checkpoint 写失败 → 直接抛错
   * 终止子代理执行,绝不"知错继续")。
   *
   * 调用时机(仅在"已完成的消息边界",不在 partial delta):
   *   - 阶段 4:assistant(tool_use) + user(tool_result) 合并进 messages 之后
   *   - end_turn:无工具的最终 assistant 合并进 messages 之后、return 之前
   *
   * I/O 数量受"完成的轮数"约束(不是流式 token):N 个工具轮 + 1 个最终 assistant
   * 产生至多 N+1 次 awaited checkpoint 追加。不传时(LEGACY)无任何行为变化。
   */
  onMessageCheckpoint?: (messages: readonly Message[]) => Promise<void>;
  /** 工具执行所需的统一权限、Gate 与回调运行时。 */
  executionRuntime?: ToolExecutionRuntime;
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
  /**
   * Wave B Task 4 (M-021): per-request 工具视图(NEW variant 入口)。
   *
   * 与 `baseToolSnapshot` 同时提供时,`streamingQuery` 会走 NEW variant:
   * 每轮 engine.submit() 用 `{ systemPrompt, toolView, baseToolSnapshot, signal, maxTokens }`
   * 形式,QueryEngine 内部调用 materializeIncludedToolDefinitions 把视图物化成
   * ToolDefinition[] 发给 provider。
   *
   * 不提供(或只提供其一)时,自动 fallback 到 LEGACY variant(`tools` 字段),
   * 保持旧行为不变。
   *
   * 重要:工具视图与 base snapshot 应在调用方一次性捕获,不在循环中重读 Registry
   * (避免一次 turn 内工具集漂移)。本函数不会在中途重新构建 base snapshot。
   * 如果调用方提供 toolView 但忘了提供 baseToolSnapshot,会 fallback 到 LEGACY,
   * 而不是抛错(向前兼容)。
   */
  toolView?: RequestToolViewSnapshot;
  /**
   * Wave B Task 4 (M-021): 与 `toolView` 配对的 base 工具定义快照。
   * 必须与 toolView.base_tool_snapshot_id 一致(由 materializer 校验)。
   */
  baseToolSnapshot?: ToolDefinitionSnapshot;
  /**
   * Wave C Task 9 (M-031 / CRC-4): No-Tool Request Contract。
   *
   * 传入后启用四重硬 enforcement(profile/view/provider/runtime):
   *   - 本次 query 的所有轮次强制 tools=[] (provider gate)
   *   - 收到异常 tool call 时产生 protocol rejection, 不执行 (runtime gate)
   *   - System prompt 追加 no-tool 软指令 (preamble, 不计入 enforcement)
   *
   * 与 reserveFinalTextTurn 的区别: reserveFinalTextTurn 是"最后一轮无工具"(用于
   * 子代理强制总结); noToolContract 是"整次 query 无工具"(用于摘要/纯文本任务)。
   * 两者可共存; noToolContract 优先级更高(整次无工具自然包含最后一轮)。
   *
   * 不传时行为不变 (LEGACY, 工具按 tools/toolView 正常暴露)。
   */
  noToolContract?: NoToolRequestContract;
  /**
   * Wave D Task 9 (M-028 / DRC-3): Tool Reference Validation Hook。
   *
   * 传入后, 在 before_provider_send checkpoint 之后、engine.submit 之前调用此 hook。
   * hook 返回 status='invalid' 时, 本次 request 不发送给 provider(fail-closed),
   * 抛出 `{ code: 'tool_reference.invalid', validation }` 让上层处理。
   *
   * hook 由调用方负责构造 ToolReferenceValidationInput(需要 manifest + final tool view
   * 等上游 snapshot), streaming-query 内部不持有这些。
   *
   * 不传时(LEGACY)跳过 reference validation, 保持向后兼容。
   * 生产主路径(index.ts)应传入此 hook 以启用 DRC-3 pre-send gate。
   */
  referenceValidationHook?: () => {
    status: 'valid' | 'invalid';
    diagnostics: string[];
    validation_id: string;
  };
  /**
   * Wave F Task 9 (M-013): Bounded Memory Integration hook。
   *
   * 物理本质:在 pre-compilation 阶段(把 systemPrompt 发给 provider 之前)注入
   * Memory section。这是 FRC-1 bounded memory entrypoint 接入 streamingQuery 的
   * 最小侵入式 hook —— 只在调用方主动提供 hook 时启用,否则 LEGACY 行为不变。
   *
   * 接入点:baseSystemPrompt 派生前。streamingQuery 会:
   *   1. await hook()
   *   2. 如果 result.prompt_section 非空,把 section.content 附加到 systemPrompt
   *      (以 `\n\n---\n\n` 分隔)
   *   3. 如果 section 为空,systemPrompt 不变
   *   4. 如果 hook 抛错,静默失败(systemPrompt 不变;不改变 TurnOutcome)
   *
   * 关键不变量(规格 §7.18 / §7.19):
   *   - 失败静默 不抛错 不回退 full-load(INV-F10)
   *   - LEGACY:不传此 hook → 行为完全不变(向后兼容)
   *   - 与 noToolContract 共存:两个 preamble 都生效(no-tool 在前,memory 在后)
   *
   * hook 返回 BoundedMemoryRequestIntegrationResult(来自 integrateBoundedMemoryIntoRequest);
   * 类型故意不在这里硬约束(避免 streaming-query.ts 反向依赖 bounded-memory.ts)。
   * 调用方负责保证返回值符合 interface。
   */
  boundedMemoryIntegration?: () =>
    | {
        integration_protocol_version: string;
        prompt_section: {
          content: string;
          [key: string]: unknown;
        } | null;
        [key: string]: unknown;
      }
    | Promise<{
        integration_protocol_version: string;
        prompt_section: {
          content: string;
          [key: string]: unknown;
        } | null;
        [key: string]: unknown;
      }>;
  /**
   * Wave G Task 10 (M-049): Post-Compact Reconstruction hook(可选)。
   *
   * 物理本质:compaction boundary 之后的 working-set 重建入口。当调用方传入此
   * hook,streamingQuery 在 runCompaction + L4 全量摘要完成后调用它,用 hook
   * 返回的 `next_messages` 替换当前 messages(把 compacted transcript 升级为
   * 完整的 restored working set)。
   *
   * LEGACY:不传 → 旧行为完全不变(只走 runCompaction / compactHistoryWithLLM,
   * compacted messages 直接进下一轮,无 reconstruction)。这与 boundedMemoryIntegration
   * 的 hook 模式一致 —— 不传 = 不启用。
   *
   * 接入点(唯一 cutover):第 4 阶段更新消息历史后、循环回到顶部前。
   *   - 调用 hook,传入 { messages, sessionId, turnId }
   *   - 若返回 restored_snapshot 非空 + next_messages 非空 → 替换 messages
   *   - 若返回 restored_snapshot=null → 不替换(调用方主动放弃,走 LEGACY)
   *   - 若 hook 抛错 → 静默失败(保留 compacted messages,不改变 TurnOutcome)
   *
   * 关键不变量(spec §7.26 / §7.21):
   *   - 不删除 runCompaction / compactHistoryWithLLM(它们仍是 CompactionResultSnapshot
   *     的 producer,reconstruction 内部会引用其输出 hash)。
   *   - hook 不实现 reconstruction 自身 —— 它只调用 reconstruction.ts 中的
   *     reconstructPostCompactWorkingSet。所有 reconstruction 逻辑在上游契约层。
   *   - 失败静默:hook 抛错绝不抛给 generator,保留 compacted messages 让 turn 继续。
   *
   * 类型故意用 structural shape 而不是直接 import RestoredWorkingSetSnapshot
   * (避免 streaming-query.ts 反向依赖 reconstruction.ts 的内部类型;hook 调用方
   * 负责保证返回值符合 reconstruction.ts 的 interface 契约)。
   */
  postCompactReconstruction?: (input: {
    messages: Message[];
    sessionId: string;
    turnId: string;
  }) => Promise<{
    restored_snapshot: {
      restored_working_set_snapshot_id: string;
      [key: string]: unknown;
    } | null;
    next_messages: Message[];
  }>;
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
    onMessageCheckpoint,
    executionRuntime,
    reserveFinalTextTurn = false,
    noToolContract,
    referenceValidationHook,
    boundedMemoryIntegration,
    postCompactReconstruction,
  } = options;

  if (tools.length > 0 && !executionRuntime) {
    throw new Error('streamingQuery invariant violation: executionRuntime is required when tools are exposed');
  }

  // Wave C Task 9 (M-031): No-Tool Contract 启用时, 本次 query 整体禁用工具。
  //
  // 物理本质: "本次任务明确不需要工具, 任何工具调用都是协议违规"。
  // 四重 enforcement 在此集中表达:
  //   - profile gate: contract 存在即声明 profile_requires_no_tools=true (由调用方负责)
  //   - view gate:    effectiveTools=[] 保证 tool_view_entry_count=0
  //   - provider gate: tools=[] 传给 provider (provider_tools_omitted=true)
  //   - runtime gate: 收到 tool_use block 时不执行 (在阶段 3 处理)
  //
  // System prompt 追加 no-tool 软指令 (preamble, 规格 §10.4 rule 6 说不计入 enforcement,
  // 但作为软防线有助于减少异常 tool call)。
  const noToolActive = !!noToolContract;

  // ─── Wave F Task 9 (M-013): Bounded Memory Integration hook ────────
  //
  // 物理本质:在 baseSystemPrompt 派生前, 可选地把 Memory section 附加到 systemPrompt。
  // 这是 pre-compilation 阶段的最小侵入式接入:不传 hook → LEGACY 行为不变;
  // 传 hook → 把 section.content 以 `\n\n---\n\n` 分隔附加到 systemPrompt。
  //
  // 失败静默(spec §7.18):hook 抛错 → 不抛错, systemPrompt 不变。
  // 不改变 TurnOutcome, 不回退 full-load(INV-F10)。
  let memorySectionContent: string | null = null;
  if (boundedMemoryIntegration) {
    try {
      const result = await boundedMemoryIntegration();
      if (result.prompt_section && typeof result.prompt_section.content === 'string') {
        memorySectionContent = result.prompt_section.content;
      }
    } catch {
      // 静默失败: 不抛错, systemPrompt 不变(spec §7.18: failure 不改变 TurnOutcome)
      memorySectionContent = null;
    }
  }

  // 把 memory section 附加到 systemPrompt(以 `\n\n---\n\n` 分隔)
  const systemPromptWithMemory =
    memorySectionContent !== null
      ? `${systemPrompt}\n\n---\n\n${memorySectionContent}`
      : systemPrompt;

  const baseSystemPrompt = noToolActive
    ? `${systemPromptWithMemory}\n\nThis request operates under a No-Tool Contract. Do not call any tools. Return only a text response based on the input.`
    : systemPromptWithMemory;

  const engine = new QueryEngine(client);
  // 初始历史：resume 时传入之前的会话 + 本次 user 消息；否则从单条 user 消息开始
  let messages: Message[] = initialMessages && initialMessages.length > 0
    ? [...initialMessages, { role: 'user' as const, content: userMessage }]
    : [{ role: 'user' as const, content: userMessage }];
  let turnCount = 0;

  // 错误恢复状态
  const recoveryState = createRecoveryState(model, maxTokens);
  const failureInbox = new FailureInbox();

  // Wave B Task 11: finalization gate。仅在"正常收尾"路径(end_turn / idle / max_turns)
  // 上执行 before_finalization checkpoint。错误抛出 / 用户 abort 路径直接跳过 finalization
  // (那些路径的 transcript 通常是残缺的 —— 工具还在执行就被打断了 —— 强制 finalization
  // 会用 before_finalization 错误掩盖真正的原始错误)。
  // 物理本质: "正常交班才体检,急诊交班直接走"。finalization 是收尾流程的卫生检查,
  // 不是错误处理的一部分。
  let finalizationDone = false;
  function runFinalizationCheckpoint(): void {
    if (finalizationDone) return;
    finalizationDone = true;
    enforceCheckpoint('before_finalization', messages, 'turn:finalization');
  }

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
      // Wave B Task 11: max_turns 是正常收尾路径(checked at loop top before any
      // tool execution this turn, so transcript is stable). 跑 finalization 体检。
      runFinalizationCheckpoint();
      eventBus?.emitLoopEnd({ reason: 'max_turns' });
      return;
    }

    turnCount++;

    // ═══════ 阶段 1：调用 AI（流式）═══════
    const assistantMessages: AssistantMessage[] = [];
    const toolUseBlocks: ToolUseBlock[] = [];
    // Wave C Task 9: toolResults 提前声明为 per-turn 累积器, 让 no-tool runtime gate
    // 能在阶段 1 收到 tool_use 时立即 push protocol rejection (不依赖阶段 3 才存在)。
    const toolResults: ToolResultBlock[] = [];
    let needsFollowUp = false;

    // 创建流式工具执行器
    const streamingExecutor = enableStreamingExecution && executionRuntime
      ? new StreamingToolExecutor(registry, executionRuntime, signal)
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

    // Wave B Task 4 (M-021): branch on variant.
    //
    // 若调用方同时提供 toolView + baseToolSnapshot,走 NEW variant;
    // 否则 fallback 到 LEGACY variant(`tools` 字段,与历史行为一致)。
    //
    // finalTextTurn 仍按原逻辑把 tools 清空(强制无工具的总结轮):
    //   - NEW variant: 在 finalTextTurn 时仍需"空工具集"语义 —— 由于 materializer
    //     依据 view.entries 的 visibility 决定输出,这里采用一个最简约定:finalTextTurn
    //     时一律切回 LEGACY 路径并传 []。这样不污染 view 本身(不在循环里篡改 snapshot)。
    //   - LEGACY variant: 直接传 []。
    //
    // 不读 Registry —— toolView 与 baseToolSnapshot 由调用方在 streamingQuery 入口
    // 前一次性捕获(本函数不会在中途重建 base snapshot)。
    //
    // Wave C Task 9 (M-031): noToolActive 时整次 query 走 LEGACY + tools=[],
    // 不进入 NEW variant (NEW variant 会 materialize view, 与 no-tool 的 view gate 冲突)。
    const useNewVariant = !finalTextTurn && !noToolActive && !!options.toolView && !!options.baseToolSnapshot;
    const effectiveSystemPrompt = finalTextTurn
      ? `${baseSystemPrompt}\n\nFinal turn: do not call tools. Return a concise factual summary based only on tool results already present in the conversation.`
      : baseSystemPrompt;
    const queryOptions: QueryEngineOptions = useNewVariant
      ? {
          systemPrompt: effectiveSystemPrompt,
          toolView: options.toolView!,
          baseToolSnapshot: options.baseToolSnapshot!,
          signal,
          maxTokens: recoveryState.maxTokens,
        }
      : {
          systemPrompt: effectiveSystemPrompt,
          // noToolActive 或 finalTextTurn 都强制 tools=[] (provider gate / 总结轮)
          tools: finalTextTurn || noToolActive ? [] : tools,
          signal,
          maxTokens: recoveryState.maxTokens,
          legacyToolInput: true,
        };

    // ═══════ Wave B Task 11: before_provider_send checkpoint ═══════
    //
    // 物理本质: "把信寄出前检查信封完整"。在把 messages 发给 provider 之前,
    // 扫一遍 transcript,要求所有 tool_use 都有匹配的 tool_result。
    // 配对残缺(缺失 result / orphan result / 重复 result / 身份冲突)→ fail-closed,
    // 不发请求(provider stream 永不被调用),把错误抛给上层。
    //
    // pending_execution(blocked)的常见场景: 流式执行器还在跑工具,但本轮 submit 提前了。
    // Wave B 采取最简正确行为: fail-closed,不进 wait/retry(留给后续 Wave)。
    //
    // 注意: 这一步在 engine.submit() 之前执行 —— provider 真的没被调用(测试用
    // CapturingStreamClient 验证 streamCalled === false)。
    enforceCheckpoint('before_provider_send', messages, makeTurnId(turnCount));

    // ═══════ Wave D Task 9 (M-028 / DRC-3): pre-send reference gate ═══════
    //
    // 物理本质: "寄信前核对收件人地址"。在把 request 发给 provider 之前, 校验
    // Prompt 里的工具引用是否都能在 final tool view 中解析。invalid → fail-closed,
    // 不发请求(provider stream 永不被调用), 抛错给上层。
    //
    // hook 由调用方提供(构造 ToolReferenceValidationInput 需要 manifest + final view
    // 等上游 snapshot, streaming-query 内部不持有)。不传时 LEGACY 跳过。
    if (referenceValidationHook) {
      const validation = referenceValidationHook();
      if (validation.status === 'invalid') {
        throw {
          code: 'tool_reference.invalid',
          validation_id: validation.validation_id,
          diagnostics: validation.diagnostics,
        };
      }
    }

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
              // Wave C Task 9 (M-031) runtime gate: No-Tool Contract 启用时,
              // 任何 tool_use 都是协议违规。不执行, 产生 protocol rejection result
              // 写回给 provider (让 provider 在下一轮修正), executor 调用次数保持为 0。
              //
              // 规格 §10.5: "Provider 返回 tool call: 拒绝执行并将 task 归类为协议失败"。
              // 这里不立即 throw —— 而是把 rejection 作为 tool_result 反馈, 给 provider
              // 一次自我修正的机会 (符合 LLM 对话的 turn-taking 语义)。
              if (noToolActive) {
                const rejectionContent = `[Protocol Rejection] Tool call '${(block as ToolUseBlock).name}' is not allowed: this request operates under a No-Tool Contract (${noToolContract?.no_tool_request_id ?? 'active'}). Provide a text-only response.`;
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: rejectionContent,
                });
                needsFollowUp = true; // 让循环继续, 把 rejection 写回 provider
                eventBus?.emitToolResult({
                  toolUseId: block.id,
                  name: (block as ToolUseBlock).name,
                  output: rejectionContent,
                  duration: 0,
                });
                yield {
                  type: 'tool_result',
                  toolUseId: block.id,
                  name: (block as ToolUseBlock).name,
                  output: rejectionContent,
                };
                continue; // 不进 toolUseBlocks, 不触发 streamingExecutor
              }

              toolUseBlocks.push(block as ToolUseBlock);
              needsFollowUp = true;

              // 流式执行：AI 还在输出时就开始执行工具
              if (streamingExecutor) {
                streamingExecutor.addTool(block as ToolUseBlock);
                const startTime = Date.now();
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
          message: formatUnknownError(error),
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
          message: formatUnknownError(error),
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
      // 子代理工作日志:end_turn 退出前 awaited checkpoint 一次。
      // 此时本轮无工具的最终 assistant 已合并进 messages,是一个"已完成的消息边界"。
      // fail-fast:checkpoint 写失败 → 直接抛错,不调用 finalization、不 return。
      if (onMessageCheckpoint) await onMessageCheckpoint(messages);
      // Wave B Task 11: end_turn 是 LLM 自主收尾,最干净的成功路径。跑 finalization 体检。
      runFinalizationCheckpoint();
      return;
    }

    // ═══════ 阶段 3：获取工具执行结果 ═══════
    // toolResults 已在阶段 1 声明 (Wave C Task 9: no-tool runtime gate 可能已 push rejection)
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
            duration: tool.executionResult?.durationMs ?? 0,
            structuredOutcome,
          });

          yield {
            type: 'tool_result',
            toolUseId: tool.id,
            name: tool.block.name,
            output,
            structuredOutcome,
            executionResult: tool.executionResult,
          };
        }
      }
    } else {
      // 传统方式：串行执行所有工具
      for (const block of toolUseBlocks) {
        if (!executionRuntime) {
          throw new Error('streamingQuery invariant violation: tool call received without executionRuntime');
        }
        const executionResult = await executeToolCall(
          registry,
          block,
          executionRuntime,
          { signal },
        );
        const output = executionResult.output;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        });

        if (block.name === 'idle') {
          idleRequested = true;
        }

        const structuredOutcome = askOutcomeStore.take(block.id);
        if (!structuredOutcome && block.name === 'ask_user_question' && process.env.DEBUG) {
          console.error('[streaming-query] ask_user_question outcome missing in store', { toolUseId: block.id });
        }

        eventBus?.emitToolResult({
          toolUseId: block.id,
          name: block.name,
          output,
          duration: executionResult.durationMs,
          structuredOutcome,
        });

        yield {
          type: 'tool_result',
          toolUseId: block.id,
          name: block.name,
          output,
          structuredOutcome,
          executionResult,
        };
      }
    }

    // idle 跳出：本轮调用了 idle 工具，不再继续循环。
    // 关键：不进入阶段 4（不把 IDLE_REQUESTED 写回 messages），
    // 否则下一轮 LLM 收到无意义反馈会重复生成。
    if (idleRequested) {
      // Wave B Task 11: idle 是用户主动叫停的正常收尾路径。跑 finalization 体检。
      runFinalizationCheckpoint();
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

    // 子代理工作日志:工具轮配对完成后 awaited checkpoint 一次。
    // 此时本轮 assistant(tool_use) + user(tool_result) 已合并进 messages,
    // 是一个"已完成的消息边界"(可安全恢复的最小单元)。fail-fast:写失败 → 抛错。
    // 注意:放在 compaction 之前 —— 恢复的是"真实发生过的工作",而非 compact 后的摘要。
    if (onMessageCheckpoint) await onMessageCheckpoint(messages);

    // 上下文压缩：防止消息历史无限增长
    //
    // ═══════ Wave B Task 11: before_compaction checkpoint ═══════
    //
    // 物理本质: "动刀裁消息前先体检"。压缩会裁/换占位旧消息,在动刀前要求这份
    // transcript 的 use/result 配对完整。配对残缺时被裁掉的就永远查不回因果,
    // 所以 fail-closed —— runCompaction 收到 preflightValidation 不达标会抛
    // `{ code: 'tool_transcript.invalid', checkpoint: 'before_compaction' }`。
    //
    // 注意: 错误恢复路径(handleError 内的回调,line ~415)走 legacy 不带 checkpoint ——
    // 那是 recovery.ts 的内部回调,签名固定,不在本 Task 的修改集内,保持旧行为。
    const compactionValidation = enforceCheckpoint(
      'before_compaction',
      messages,
      makeTurnId(turnCount),
    );
    const { messages: compacted, needsL4 } = runCompaction(messages, {
      preflightValidation: compactionValidation,
    });
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

    // ═══════ Wave G Task 10 (M-049): post-compact reconstruction cutover ═══════
    //
    // 物理本质:compaction boundary 之后的 working-set 重建入口(可选 hook)。
    // 当调用方传入 postCompactReconstruction 时,在 runCompaction + L4 完成后,
    // 调用它把 compacted messages 升级为完整的 restored working set。
    //
    // 这是 T10 唯一的 cutover 点。旧路径(runCompaction / compactHistoryWithLLM
    // 的输出直接进下一轮)与新路径(reconstruction 的 next_messages)在此分叉:
    //   - 不传 hook → 旧路径(messages 保持 compacted 状态,行为不变)
    //   - 传 hook 且返回有效 restored_snapshot + next_messages → 新路径
    //   - 传 hook 但返回 restored_snapshot=null → 旧行为(调用方主动放弃)
    //   - 传 hook 但抛错 → 静默失败(保留 compacted messages,不改变 TurnOutcome)
    //
    // 关键不变量(spec §7.26 / §7.21):
    //   - 不删除 / 不改变 runCompaction / compactHistoryWithLLM 算法 —— 它们仍是
    //     CompactionResultSnapshot 的 producer(reconstruction 内部引用其 hash)。
    //   - hook 只调用 reconstruction.ts 中的 reconstructPostCompactWorkingSet;
    //     reconstruction 自身的所有逻辑在上游契约层,streamingQuery 不实现 reconstruction。
    //   - 失败静默(INV-G / spec §7.18 风格):hook 抛错绝不传播给 generator,
    //     保留 compacted messages 让 turn 继续推进。
    //   - 不改变 TurnOutcome —— reconstruction 的成败不影响本轮的工具执行结果。
    //
    // 注:此 cutover 与 boundedMemoryIntegration 的 hook 模式一致 —— 可选 + 失败静默 +
    // LEGACY 默认。生产主路径(index.ts)在 activation gate 全门为 true 后选择是否
    // 传入此 hook;不传则保持当前 LEGACY 行为。
    if (postCompactReconstruction) {
      try {
        const reconResult = await postCompactReconstruction({
          messages,
          sessionId: STREAMING_SESSION_ID,
          turnId: makeTurnId(turnCount),
        });
        // 调用方返回 restored_snapshot 非空 + next_messages 非空 才替换。
        // restored_snapshot=null 表示调用方主动放弃(例如 activation gate 未通过),
        // 此时走 LEGACY —— 保留 compacted messages,不替换。
        if (
          reconResult.restored_snapshot !== null &&
          Array.isArray(reconResult.next_messages) &&
          reconResult.next_messages.length > 0
        ) {
          messages = reconResult.next_messages;
        }
      } catch {
        // 静默失败:hook 抛错时不传播,保留 compacted messages 让本轮 turn 继续。
        // 不改变 TurnOutcome,不发 context_overflow 事件(reconstruction 失败
        // 不是 compaction 失败;compaction 已成功,只是 reconstruction 升级失败)。
      }
    }
  }
  // 循环退出全靠循环体内的 return（user_abort / max_turns guard / end_turn / 错误恢复失败）。
  // 落到这里说明逻辑有漏洞——记录后兜底退出，避免死循环。
  // Wave B Task 11: 视为正常收尾路径(防御性)—— 跑 finalization 体检再退出。
  runFinalizationCheckpoint();
  eventBus?.emitLoopEnd({ reason: 'unexpected_exit' });
  } finally {
    // AUTO-0025 Phase B:turn 结束强制清空 outcome store(turn 生命周期清理)。
    // 正常路径下 take 已消费所有 entry;此处用 clear() 强制清空未消费的
    // (take miss / 权限拦截 / 异常路径留下的 orphan),不等 TTL。
    // 注意:不能用 sweep()——sweep 是 TTL 清理(只删超 5min 的 entry),
    // 对本 turn 产生的 orphan 是 no-op。两者职责分离:
    //   clear()  = turn 生命周期(本函数 finally,确定性清空)
    //   sweep()  = 进程生命周期(防御性 TTL,长运行兜底,当前无定时调用点)
    askOutcomeStore.clear();

    // ═══════ Wave B Task 11: before_finalization checkpoint 说明 ═══════
    //
    // finalization 体检**不在 finally 块内执行** —— 而是在三处"正常收尾"路径
    // (end_turn / idle / max_turns)以及 unexpected_exit 兜底处显式调用
    // `runFinalizationCheckpoint()`。原因: finally 块无法区分"正常 return"与
    // "异常 unwind",如果在 finally 里跑 finalization,会把配对残缺的 abort/错误
    // 路径强行体检,产生的 `before_finalization` 错误会**掩盖**原始错误(例如
    // before_provider_send 抛出的错误会被 finally 里的 before_finalization 错误替代)。
    //
    // 因此 finalization 只在"确定是正常收尾"时跑 —— 那些路径的 transcript 应是
    // 稳定的(上一轮工具结果都已写入)。错误/abort 路径直接跳过 finalization,
    // 让原始错误干净地向上传。
    //
    // runFinalizationCheckpoint 内部有 finalizationDone 标志,多次调用幂等。

    // 无论正常结束/错误/中断，都把最终消息列表回调出去（供会话持久化落盘）
    if (onMessages) onMessages(messages);
  }
}
