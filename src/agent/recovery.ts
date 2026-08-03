// 错误恢复与自愈机制
//
// 物理本质：公司的"故障应急预案手册"。
// 出了问题 → 先查手册（classifyError）→ 制定方案（handleError）→ 执行修复 → 重试。
// 如果修了 3 次还是不行 → 放弃自救，报告上级（抛出异常）。

import type { Message } from './types.js';
import { formatUnknownError } from '../utils/error-message.js';

/** 错误类型枚举 */
export type ErrorType =
  | 'max_tokens_exceeded'
  | 'prompt_too_long'
  | 'rate_limited_429'
  | 'stream_idle_timeout'
  | 'stream_no_events'
  | 'connection_error'
  | 'unknown';

/** 恢复状态机 */
export interface RecoveryState {
  /** 当前最大输出 token 数（动态调整） */
  maxTokens: number;
  /** 当前使用的模型（429 时降级） */
  currentModel: string;
  /** 默认模型（用于恢复后重置） */
  defaultModel: string;
  /** 当前重试次数 */
  retryAttempt: number;
  /** 是否已触发过 reactive compact */
  reactiveCompactUsed: boolean;
}

/** 故障记录 */
export interface FailureRecord {
  timestamp: number;
  errorType: ErrorType;
  message: string;
  retryAttempt: number;
  action: string;
}

/** 默认最大重试次数 */
export const MAX_RETRY_LIMIT = 3;

/** 默认 token 预算 */
const DEFAULT_MAX_TOKENS = 8000;

/** 升级后的 token 预算 */
const UPGRADED_MAX_TOKENS = 64000;

/** 默认降级模型 */
const FALLBACK_MODEL = 'claude-3-5-haiku';

/**
 * 创建初始恢复状态
 */
export function createRecoveryState(
  defaultModel: string = 'claude-sonnet-4-20250514',
  maxTokens: number = DEFAULT_MAX_TOKENS,
): RecoveryState {
  return {
    maxTokens,
    currentModel: defaultModel,
    defaultModel,
    retryAttempt: 0,
    reactiveCompactUsed: false,
  };
}

/**
 * 故障收件箱：记录所有故障历史
 */
export class FailureInbox {
  private records: FailureRecord[] = [];

  /** 记录一次故障 */
  add(errorType: ErrorType, message: string, retryAttempt: number, action: string): void {
    this.records.push({
      timestamp: Date.now(),
      errorType,
      message,
      retryAttempt,
      action,
    });
  }

  /** 获取全部故障记录 */
  getHistory(): readonly FailureRecord[] {
    return this.records;
  }

  /** 获取记录数量 */
  get count(): number {
    return this.records.length;
  }

  /** 清空记录 */
  clear(): void {
    this.records = [];
  }
}

/**
 * 错误分类器：从异常消息中提取错误类型
 *
 * 物理本质：急诊分诊台——先判断是什么病，再分配到对应科室。
 */
export function classifyError(error: unknown): ErrorType {
  // 先用共享格式化函数规范化：普通对象会被 JSON 序列化（含 "status":429 等），
  // 使后续关键字匹配能命中 provider 抛出的非 Error 异常。
  const msg = formatUnknownError(error);
  const lower = msg.toLowerCase();

  if (lower.includes('max_tokens') || lower.includes('max tokens')) {
    return 'max_tokens_exceeded';
  }
  if (lower.includes('context_length_exceeded') || lower.includes('context length') || lower.includes('prompt_too_long') || lower.includes('too long')) {
    return 'prompt_too_long';
  }
  if (lower.includes('429') || lower.includes('rate_limit') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'rate_limited_429';
  }
  // 529 overloaded 归类为 rate_limited（设计 §9：529 可重试，与 429 同策略）
  if (lower.includes('529') || lower.includes('overloaded') || lower.includes('overload')) {
    return 'rate_limited_429';
  }
  if (lower.includes('idle timeout') || lower.includes('stream_idle_timeout')) {
    return 'stream_idle_timeout';
  }
  if (lower.includes('no events') || lower.includes('stream_no_events')) {
    return 'stream_no_events';
  }
  if (lower.includes('connection') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) {
    return 'connection_error';
  }
  return 'unknown';
}

/**
 * 错误恢复策略中枢
 *
 * 物理本质：应急预案手册——根据故障类型，决定怎么修、能不能修。
 *
 * 返回 true = 制定了修复策略，允许重试
 * 返回 false = 无法自愈，必须报错
 */
export function handleError(
  errorType: ErrorType,
  state: RecoveryState,
  inbox: FailureInbox,
  messages: Message[],
  compactFn: (messages: Message[]) => Message[],
): boolean {
  if (state.retryAttempt >= MAX_RETRY_LIMIT) {
    inbox.add(errorType, `Exceeded max retry limit (${MAX_RETRY_LIMIT})`, state.retryAttempt, 'abort');
    return false;
  }

  state.retryAttempt++;

  switch (errorType) {
    case 'max_tokens_exceeded': {
      // 断点续接：追加占位消息让模型续写，而非重跑
      state.maxTokens = UPGRADED_MAX_TOKENS;
      messages.push({
        role: 'user',
        content: 'Continue exactly from where you left off. Do not repeat any content.',
      });
      inbox.add(errorType, 'max_tokens exceeded', state.retryAttempt, `append continuation, scale maxTokens to ${UPGRADED_MAX_TOKENS}`);
      return true;
    }

    case 'prompt_too_long': {
      if (state.reactiveCompactUsed) {
        inbox.add(errorType, 'prompt_too_long after compact already used', state.retryAttempt, 'abort');
        return false;
      }
      const compacted = compactFn(messages);
      messages.length = 0;
      messages.push(...compacted);
      state.reactiveCompactUsed = true;
      inbox.add(errorType, 'context overflow', state.retryAttempt, 'reactive compact triggered');
      return true;
    }

    case 'rate_limited_429': {
      state.currentModel = FALLBACK_MODEL;
      inbox.add(errorType, 'rate limited', state.retryAttempt, `degrade model to ${FALLBACK_MODEL}`);
      return true;
    }

    default: {
      inbox.add(errorType, 'unknown error', state.retryAttempt, 'abort');
      return false;
    }
  }
}
