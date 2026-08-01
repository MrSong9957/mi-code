// 每个非后台用户回合的终态反馈契约：纯函数分类 + 构造四字段状态块。
import type { Message } from './types.js';
import type { ToolExecutionResult } from './tool-execution.js';

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
  feedbackText: string;
  messages: Message[];
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
function hasStatusBlock(message: Message): boolean {
  if (typeof message.content === 'string') {
    return /^当前状态：/m.test(message.content);
  }
  return message.content.some(
    (block) => block.type === 'text' && /^当前状态：/m.test(block.text),
  );
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

  // 规则 1 & 2：异常中断（error 或 aborted）
  if (error || aborted) {
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
        obtainedResult: terminalText.trim() || subagentBody.trim() || '任务完成',
        blockedAt: '无',
        nextStep: '无',
      };
    }
    case '部分完成': {
      const obtained =
        terminalText.trim() ||
        subagentBody.trim() ||
        (toolFacts.some((fact) => fact.executionStatus === 'success')
          ? '部分工具结果已获得'
          : '部分结果已获得');
      const blocked =
        error ??
        (failingFact?.output ??
          (subagentReason ? `子代理未完成：${subagentReason}` : '部分步骤未完成'));
      return {
        obtainedResult: obtained,
        blockedAt: blocked,
        nextStep: '重试失败步骤或补充缺失信息',
      };
    }
    case '失败': {
      return {
        obtainedResult: '无',
        blockedAt: error ?? failingFact?.output ?? '无有效输出',
        nextStep: '重试或调整方案',
      };
    }
  }
}

/** 构造四行状态块文本 */
function buildFeedbackText(
  status: UserTurnStatus,
  fields: { obtainedResult: string; blockedAt: string; nextStep: string },
): string {
  return [
    `当前状态：${status}`,
    `已获得结果：${fields.obtainedResult}`,
    `失败或受阻位置：${fields.blockedAt}`,
    `下一步：${fields.nextStep}`,
  ].join('\n');
}

/** 把 feedbackText 不可变地附加到当前回合（幂等） */
function appendFeedback(
  messages: readonly Message[],
  turnStartIndex: number,
  feedbackText: string,
): Message[] {
  const slice = messages.slice(turnStartIndex);

  // 幂等：当前回合最后一条 assistant 消息已含状态块 → 原样返回
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    if (slice[i].role === 'assistant') {
      if (hasStatusBlock(slice[i])) return [...messages];
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
    let newContent: string | Message['content'];
    if (typeof original.content === 'string') {
      newContent = `${original.content}\n\n${feedbackText}`;
    } else {
      newContent = [...original.content, { type: 'text', text: feedbackText }];
    }
    result[fullIdx] = { ...original, content: newContent };
  } else {
    result.push({
      role: 'assistant',
      content: [{ type: 'text', text: feedbackText }],
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
): TurnFinalizationResult {
  const status = classifyTurn(input);
  const slice = input.messages.slice(input.turnStartIndex);
  const fields = buildFeedbackFields(status, input, slice);
  const feedbackText = buildFeedbackText(status, fields);
  const messages = appendFeedback(input.messages, input.turnStartIndex, feedbackText);
  return { status, feedbackText, messages };
}
