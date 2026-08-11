// 每个非后台用户回合的终态反馈契约：纯函数分类 + 构造四字段状态块。
import type { Message } from './types.js';
import type { ToolExecutionResult } from './tool-execution.js';
import type { Translator } from '../locale/types.js';

/** 用户回合的终态分类 */
export type UserTurnStatus = '成功' | '部分完成' | '失败';

/** 单个工具调用在本回合内的事实快照 */
export interface TurnToolFact {
  name: string;
  output: string;
  executionStatus?: ToolExecutionResult['status'];
}

/** finalizeTurnForUser 的输入 */
export interface TurnFinalizationInput {
  messages: readonly Message[];
  /** 父会话在本次 streamingQuery 开始前的消息数；只检查 slice(turnStartIndex) 之后的内容 */
  turnStartIndex: number;
  toolFacts: readonly TurnToolFact[];
  /** provider/运行时错误（非空表示回合异常中断） */
  error?: string;
  /** 是否被用户/中止信号打断 */
  aborted: boolean;
}

/** finalizeTurnForUser 的输出 */
export interface TurnFinalizationResult {
  status: UserTurnStatus;
  /**
   * 四字段状态块文本。当 requiresFeedback=false 时为空字符串(正常成功路径
   * 模型已给出终端 assistant 回复,无需画蛇添足追加兜底块)。
   */
  feedbackText: string;
  messages: Message[];
  /**
   * 是否需要向用户展示状态块。
   * - false:正常成功路径(成功 + 已有终端 assistant 文本),不追加 messages、
   *   feedbackText 为空、commitFinalizedTurn 跳过 emit。
   * - true:异常兜底(部分完成/失败/成功但无终端 assistant 文本),追加状态块到
   *   messages 并 emit feedbackText。
   */
  requiresFeedback: boolean;
}

/** 子代理 envelope 解析（仅解析锚定格式，不解析任意自然语言） */
const SUBAGENT_ENVELOPE =
  /^\[Subagent status=(completed|incomplete|unverified)(?: reason=([^\]]+))?\]\r?\n/;

interface SubagentEnvelope {
  status: 'completed' | 'incomplete' | 'unverified';
  reason: string | undefined;
  /** envelope 命中文本长度（含行尾换行），用于切出 body */
  matchLength: number;
}

function parseSubagentEnvelope(output: string): SubagentEnvelope | null {
  const match = SUBAGENT_ENVELOPE.exec(output);
  if (!match) return null;
  return {
    status: match[1] as SubagentEnvelope['status'],
    reason: match[2],
    matchLength: match[0].length,
  };
}

/** 提取一条 assistant 消息的纯文本（拼接所有 text 块） */
function getAssistantText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** 当前回合内是否包含任意非空 assistant 文本 */
function sliceHasAssistantText(slice: readonly Message[]): boolean {
  return slice.some(
    (message) => message.role === 'assistant' && getAssistantText(message).trim().length > 0,
  );
}

/**
 * 找到“最后一条 tool-result 消息之后”的第一条 assistant 消息文本。
 * 若当前回合无 tool-result，则取回合内第一条 assistant 消息。
 * 返回空串表示不存在这样的终端 assistant 回复。
 */
function getTerminalAssistantText(slice: readonly Message[]): string {
  let lastToolResultIdx = -1;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const message = slice[i];
    if (
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result')
    ) {
      lastToolResultIdx = i;
      break;
    }
  }
  for (let i = lastToolResultIdx + 1; i < slice.length; i += 1) {
    if (slice[i].role === 'assistant') return getAssistantText(slice[i]);
  }
  return '';
}

/** 判断某条 assistant 消息是否已含“当前状态：”状态块（按行锚定） */
function hasStatusBlock(message: Message, translator: Translator): boolean {
  const prefix = `${translator.t('status.turnFinal.currentStatus')}${translator.t('status.turnFinal.separator')}`;
  const textBlocks = typeof message.content === 'string'
    ? [message.content]
    : message.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text);
  return textBlocks.some(text => text.split(/\r?\n/).some(line => line.startsWith(prefix)));
}

/** 按规则顺序分类父回合结果 */
function classifyTurn(input: TurnFinalizationInput): UserTurnStatus {
  const { messages, turnStartIndex, toolFacts, error, aborted } = input;
  const slice = messages.slice(turnStartIndex);

  const hasAssistantText = sliceHasAssistantText(slice);
  const hasSuccessfulTool = toolFacts.some(
    (fact) => fact.executionStatus === 'success',
  );
  const hasUsefulOutput = hasAssistantText || hasSuccessfulTool;
  const hasFailureFact = toolFacts.some(
    (fact) => fact.executionStatus === 'failure',
  );

  // 用户主动中止不是执行失败；没有可见产出时也保留“未完成”语义。
  if (aborted) {
    return '部分完成';
  }

  // 规则 1：异常中断（error）
  if (error) {
    return hasUsefulOutput ? '部分完成' : '失败';
  }

  // 规则 3：存在失败的工具事实
  if (hasFailureFact) {
    const hasOtherUseful = hasAssistantText || hasSuccessfulTool;
    return hasOtherUseful ? '部分完成' : '失败';
  }

  // 规则 4：子代理 envelope 为 incomplete/unverified
  const hasIncompleteSubagent = toolFacts.some((fact) => {
    if (fact.name !== 'spawn_agent' && fact.name !== 'task') return false;
    const envelope = parseSubagentEnvelope(fact.output);
    return (
      envelope !== null &&
      (envelope.status === 'incomplete' || envelope.status === 'unverified')
    );
  });
  if (hasIncompleteSubagent) return '部分完成';

  // 规则 5：子代理 envelope 为 completed 且 body 非空
  const hasCompletedSubagentWithBody = toolFacts.some((fact) => {
    if (fact.name !== 'spawn_agent' && fact.name !== 'task') return false;
    const envelope = parseSubagentEnvelope(fact.output);
    if (envelope === null || envelope.status !== 'completed') return false;
    const body = fact.output.slice(envelope.matchLength);
    return body.trim().length > 0;
  });
  if (hasCompletedSubagentWithBody) return '成功';

  // 规则 6：最后 tool-result 之后有非空 assistant 文本，且无失败事实
  const terminalText = getTerminalAssistantText(slice);
  if (terminalText.trim().length > 0 && !hasFailureFact) {
    return '成功';
  }

  // 规则 7：无终端文本 —— 有任意成功输出算部分进展，否则失败
  return hasSuccessfulTool ? '部分完成' : '失败';
}

/** 根据 status 与事实推导描述性字段 */
function buildFeedbackFields(
  status: UserTurnStatus,
  input: TurnFinalizationInput,
  slice: readonly Message[],
  translator: Translator,
): { obtainedResult: string; blockedAt: string; nextStep: string } {
  const { error, toolFacts } = input;
  const terminalText = getTerminalAssistantText(slice);
  const failingFact = toolFacts.find((fact) => fact.executionStatus === 'failure');

  // 提取首个命中的子代理 envelope body 与 reason
  let subagentBody = '';
  let subagentReason = '';
  for (const fact of toolFacts) {
    if (fact.name !== 'spawn_agent' && fact.name !== 'task') continue;
    const envelope = parseSubagentEnvelope(fact.output);
    if (envelope) {
      subagentBody = fact.output.slice(envelope.matchLength);
      subagentReason = envelope.reason ?? '';
      break;
    }
  }

  switch (status) {
    case '成功': {
      return {
        obtainedResult: terminalText.trim() || subagentBody.trim() || translator.t('status.turnFinal.taskComplete'),
        blockedAt: translator.t('status.turnFinal.none'),
        nextStep: translator.t('status.turnFinal.none'),
      };
    }
    case '部分完成': {
      const obtained =
        terminalText.trim() ||
        subagentBody.trim() ||
        (toolFacts.some((fact) => fact.executionStatus === 'success')
          ? translator.t('status.turnFinal.partialToolResultsObtained')
          : translator.t('status.turnFinal.partialResultsObtained'));
      const blocked =
        error ??
        (failingFact?.output ??
          (subagentReason
            ? translator.t('status.turnFinal.subagentIncomplete', { reason: subagentReason })
            : translator.t('status.turnFinal.partialStepsIncomplete')));
      return {
        obtainedResult: obtained,
        blockedAt: blocked,
        nextStep: translator.t('status.turnFinal.retryFailedStep'),
      };
    }
    case '失败': {
      return {
        obtainedResult: translator.t('status.turnFinal.none'),
        blockedAt: error ?? failingFact?.output ?? translator.t('status.turnFinal.noUsefulOutput'),
        nextStep: translator.t('status.turnFinal.retryOrAdjust'),
      };
    }
  }
}

/** 构造四行状态块文本 */
function buildFeedbackText(
  status: UserTurnStatus,
  fields: { obtainedResult: string; blockedAt: string; nextStep: string },
  translator: Translator,
): string {
  const statusText = status === '成功'
    ? translator.t('status.turnFinal.success')
    : status === '部分完成'
      ? translator.t('status.turnFinal.partial')
      : translator.t('status.turnFinal.failure');
  const separator = translator.t('status.turnFinal.separator');
  return [
    `${translator.t('status.turnFinal.currentStatus')}${separator}${statusText}`,
    `${translator.t('status.turnFinal.obtainedResult')}${separator}${fields.obtainedResult}`,
    `${translator.t('status.turnFinal.blockedAt')}${separator}${fields.blockedAt}`,
    `${translator.t('status.turnFinal.nextStep')}${separator}${fields.nextStep}`,
  ].join('\n');
}

/** 把 feedbackText 不可变地附加到当前回合（幂等） */
function appendFeedback(
  messages: readonly Message[],
  turnStartIndex: number,
  feedbackText: string,
  translator: Translator,
): Message[] {
  const slice = messages.slice(turnStartIndex);

  // 幂等：当前回合最后一条 assistant 消息已含状态块 → 原样返回
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    if (slice[i].role === 'assistant') {
      if (hasStatusBlock(slice[i], translator)) return [...messages];
      break;
    }
  }

  // 定位“最后一条 tool-result 消息之后”的第一条 assistant 消息（slice 内索引）
  let lastToolResultIdx = -1;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const message = slice[i];
    if (
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result')
    ) {
      lastToolResultIdx = i;
      break;
    }
  }
  let terminalSliceIdx = -1;
  for (let i = lastToolResultIdx + 1; i < slice.length; i += 1) {
    if (slice[i].role === 'assistant') {
      terminalSliceIdx = i;
      break;
    }
  }

  const result = [...messages];
  if (terminalSliceIdx >= 0) {
    const fullIdx = turnStartIndex + terminalSliceIdx;
    const original = result[fullIdx];
    let newContent: Message['content'];
    if (typeof original.content === 'string') {
      // string content 规范化为两 block:原正文(纯净)+ feedback(uiOnly)
      // 禁止拼接 `${original}\n\n${feedback}`(会让 uiOnly 语义失效 + 正文混入状态块)
      newContent = [
        { type: 'text', text: original.content },
        { type: 'text', text: feedbackText, uiOnly: true },
      ];
    } else {
      // array content:追加独立 feedback block,标记 uiOnly
      newContent = [...original.content, { type: 'text', text: feedbackText, uiOnly: true }];
    }
    result[fullIdx] = { ...original, content: newContent };
  } else {
    result.push({
      role: 'assistant',
      content: [{ type: 'text', text: feedbackText, uiOnly: true }],
    });
  }
  return result;
}

/**
 * 分类父回合结果并构造四字段 assistant 状态块。
 *
 * 分类与文本查找只检查 messages.slice(turnStartIndex)，绝不看更早的回合。
 * 重复调用幂等：已含状态块时返回消息不变。
 */
export function finalizeTurnForUser(
  input: TurnFinalizationInput,
  translator: Translator,
): TurnFinalizationResult {
  const status = classifyTurn(input);
  const slice = input.messages.slice(input.turnStartIndex);

  // 正常成功路径(模型已给出终端 assistant 文本回复):不追加状态块、不 emit。
  // 状态块只用于异常兜底 —— 当工具/子代理已执行但模型没有正常 final 回复,
  // 或回合并未成功(部分完成/失败)时,才需要四字段块帮用户理解结局。
  // 这避免在模型已经清晰总结的正常成功路径上画蛇添足地追加重复的状态块。
  const terminalText = getTerminalAssistantText(slice);
  if (status === '成功' && terminalText.trim().length > 0) {
    return {
      status,
      feedbackText: '',
      messages: [...input.messages],
      requiresFeedback: false,
    };
  }

  const fields = buildFeedbackFields(status, input, slice, translator);
  const feedbackText = buildFeedbackText(status, fields, translator);
  const messages = appendFeedback(input.messages, input.turnStartIndex, feedbackText, translator);
  return { status, feedbackText, messages, requiresFeedback: true };
}

/**
 * 把 finalized 快照中新增的消息按顺序持久化,然后 emit 最终四字段状态块。
 *
 * 物理本质:turn 结束前的"统一交班口"。streamingQuery 产出的最终 messages 快照
 * 经 finalizeTurnForUser 加上状态块后,这里负责:
 *   1. 把 `result.messages.slice(persistedMessageCount)` 的新消息逐条 awaited 落盘
 *   2. 持久化全部成功后才 emit feedbackText(绝不先报成功再落盘)
 *   3. 返回新的持久化计数(供调用方更新游标)
 *
 * 持久化失败由调用方处理(视为失败回合)—— 本函数让 append 抛错向上传播,
 * 不会假装成功。这与"先持久化再 emit"的顺序共同保证:用户看到的状态块一定已落盘
 * (除非落盘本身失败,那是更窄的边界,由调用方的 catch 单独 emit 失败块)。
 *
 * @param result finalizeTurnForUser 的输出
 * @param persistedMessageCount 已落盘的父会话消息数(只追加这之后的增量)
 * @param append 单条消息持久化回调(sessionStore.append)
 * @param emit 最终文本发射回调(pipeline.emit assistant_text isFinal)
 * @returns 新的持久化计数
 */
export async function commitFinalizedTurn(
  result: TurnFinalizationResult,
  persistedMessageCount: number,
  append: (message: Message) => Promise<void>,
  emit: (text: string) => void,
): Promise<number> {
  for (const message of result.messages.slice(persistedMessageCount)) {
    await append(message);
  }
  // 正常成功路径(requiresFeedback=false)跳过 emit —— 用户不应看到四字段状态块,
  // 模型自己的终端回复就是最终输出。异常兜底路径才 emit 状态块。
  if (result.requiresFeedback) {
    emit(result.feedbackText);
  }
  return result.messages.length;
}
