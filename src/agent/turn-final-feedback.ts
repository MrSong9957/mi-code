// 每个非后台用户回合的终态反馈契约(v1):纯函数分类(classifyTurn)+ 构造单行
// candidate(buildTurnStatusCandidate:partial / failed / cancelled 或 null)+ persist-only
// 落盘(commitFinalizedTurn)。不再构造四字段状态块、不向 messages 追加状态行;
// 是否真正 emit turn-status 兜底行由 tui 层的 shouldEmitTurnStatus(candidate, items)
// 统一决定(见 transcript-reducer.ts)。
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
  messages: Message[];
  /**
   * 回合终态兜底候选(partial/failed/cancelled)或 null(正常成功路径)。
   * v1:不再产出四字段 feedbackText,也不向 messages 追加状态块。
   * 是否真正 emit 由 index.ts 调用 shouldEmitTurnStatus(candidate, items) 决定。
   */
  candidate: TurnStatusCandidate | null;
}

/**
 * 回合终态兜底候选:简洁的单行状态(partial / failed / cancelled)。
 *
 * cancelled **只**来自 `input.aborted`,不从 UserTurnStatus 推导——classifyTurn
 * 在 aborted 时仍返回 '部分完成',但 candidate 必须映射成 cancelled。
 * `shouldEmitTurnStatus` 是唯一的生产决策缝:index.ts 据此决定是否真正 emit。
 */
export type TurnStatusCandidate = {
  status: 'partial' | 'failed' | 'cancelled';
  line: string;
};

/**
 * 构造回合终态兜底候选。返回 null 表示正常成功路径(无需兜底行)。
 *
 * cancelled 硬规则:**只**从 `input.aborted` 来。aborted=true 时无视 classified
 * 直接返回 cancelled;否则按 classified(classifyTurn 的输出,不可扩展)映射:
 * - '成功' → null
 * - '部分完成' → partial
 * - '失败' → failed
 */
export function buildTurnStatusCandidate(
  input: TurnFinalizationInput,
  classified: UserTurnStatus,
  translator: Translator,
): TurnStatusCandidate | null {
  // cancelled 只来自 aborted,绝不从 classified 推导。
  if (input.aborted) {
    return { status: 'cancelled', line: translator.t('status.turnFinal.cancelledLine') };
  }
  switch (classified) {
    case '成功':
      return null;
    case '部分完成':
      return { status: 'partial', line: translator.t('status.turnFinal.partialLine') };
    case '失败':
      return { status: 'failed', line: translator.t('status.turnFinal.failedLine') };
  }
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

/**
 * 分类父回合结果并构造终态兜底候选(v1)。
 *
 * 行为变更:不再构造四字段 feedbackText、不向 messages 追加状态块、不返回
 * requiresFeedback。改为返回简洁的 candidate(由 buildTurnStatusCandidate 从
 * classifyTurn 的输出 + aborted 映射),messages 原样透传。
 *
 * 分类与文本查找只检查 messages.slice(turnStartIndex)，绝不看更早的回合。
 */
export function finalizeTurnForUser(
  input: TurnFinalizationInput,
  translator: Translator,
): TurnFinalizationResult {
  const status = classifyTurn(input);
  const candidate = buildTurnStatusCandidate(input, status, translator);
  // messages 原样透传:不再追加四字段状态块,也不做 uiOnly 标记。
  return { status, messages: [...input.messages], candidate };
}

/**
 * 把 finalized 快照中新增的消息按顺序持久化(v1: persist-only)。
 *
 * 行为变更:不再接收 emit 参数、不再读 requiresFeedback/feedbackText。
 * 只把 `result.messages.slice(persistedMessageCount)` 的新消息逐条 awaited 落盘,
 * 返回新的持久化计数。turn-status 兜底行的 emit 决策移到调用方(index.ts),
 * 由 shouldEmitTurnStatus(candidate, items) 统一决定。
 *
 * 持久化失败由调用方处理(视为失败回合)—— 本函数让 append 抛错向上传播,
 * 不会假装成功。
 *
 * @param result finalizeTurnForUser 的输出
 * @param persistedMessageCount 已落盘的父会话消息数(只追加这之后的增量)
 * @param append 单条消息持久化回调(sessionStore.append)
 * @returns 新的持久化计数
 */
export async function commitFinalizedTurn(
  result: TurnFinalizationResult,
  persistedMessageCount: number,
  append: (message: Message) => Promise<void>,
): Promise<number> {
  for (const message of result.messages.slice(persistedMessageCount)) {
    await append(message);
  }
  return result.messages.length;
}
