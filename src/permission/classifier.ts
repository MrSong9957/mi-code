// 两阶段 PermissionClassifier 状态机（Task 4 / 设计 §7.2、§7.5）
//
// 物理本质：classifier 的“判决庭”。唯一 decision parser + Stage1/Stage2 状态机。
//
// 职责（唯一）：
//   - 协议解析：parseStage1Decision / parseStage2Decision 严格只接受完整枚举字符串；
//   - 状态机：Stage1 ALLOW -> allow（Stage2=0）；FLAG -> Stage2 exactly once；
//   - fail-closed：任一 failure（额外文本/空白/JSON/unknown/timeout/provider/input-limit/protocol）-> deny；
//   - classify 最终类型只有 allow/deny，不返回 ask；
//   - 无 authentic user message -> provider 0 调用并 deny；
//   - classify(input, signal) 使用调用方传入的 per-resolution AbortSignal，不创建共享 this.signal。
//
// 不变量（设计 §7.5）：
//   - classifier RPC 是权限链内部调用，不加入主 session message history；
//   - 不触发 Agent loop / turn thinking 生命周期；
//   - 不发送 TUI delta；
//   - 只有最终裁决 + 脱敏 audit metadata 返回 resolver。
//
// classifier 不持有 ToolRegistry / RuntimeSecurityGate / Agent state / messageSink / TuiCallback。

import type { PermissionClassifierInput } from './classifier-input.js';
import {
  buildClassifierPromptPrefix,
  STAGE1_INSTRUCTION,
  STAGE2_INSTRUCTION,
} from './classifier-prompt.js';
import {
  buildClassifierProviderRequest,
  type PermissionClassifierProvider,
} from './classifier-provider.js';
import type { ClassifierModelPolicy, ClassifierModelContext, ModelRef } from './classifier-model-policy.js';
import { getRetryDelay, isRetryableApiError, RetrySleeper, type RetrySleeperInterface } from '../agent/backoff.js';

/** classifier 裁决（最终类型只有 allow/deny，不含 ask） */
export interface ClassifierDecision {
  readonly behavior: 'allow' | 'deny';
  readonly reason_code: string;
}

/** 构造 allow 裁决 */
function allow(reasonCode: string): ClassifierDecision {
  return Object.freeze({ behavior: 'allow', reason_code: reasonCode });
}

/** 构造 deny 裁决 */
function deny(reasonCode: string): ClassifierDecision {
  return Object.freeze({ behavior: 'deny', reason_code: reasonCode });
}

/**
 * Stage 1 严格协议 parser。
 * 只接受完整字符串 'ALLOW' 或 'FLAG'；其余一律抛 protocol failure。
 * 不做 trim，不容忍换行/解释/JSON/多枚举/额外字段/空字符串。
 */
export function parseStage1Decision(raw: unknown): 'ALLOW' | 'FLAG' {
  if (typeof raw !== 'string') {
    throw new ProtocolParseError(`Stage1 decision must be a string, got ${typeof raw}`);
  }
  if (raw === 'ALLOW') return 'ALLOW';
  if (raw === 'FLAG') return 'FLAG';
  throw new ProtocolParseError(`Stage1 decision must be exactly 'ALLOW' or 'FLAG'; got: ${JSON.stringify(raw)}`);
}

/**
 * Stage 2 严格协议 parser。
 * 只接受完整字符串 'ALLOW' 或 'DENY'；其余一律抛 protocol failure。
 */
export function parseStage2Decision(raw: unknown): 'ALLOW' | 'DENY' {
  if (typeof raw !== 'string') {
    throw new ProtocolParseError(`Stage2 decision must be a string, got ${typeof raw}`);
  }
  if (raw === 'ALLOW') return 'ALLOW';
  if (raw === 'DENY') return 'DENY';
  throw new ProtocolParseError(`Stage2 decision must be exactly 'ALLOW' or 'DENY'; got: ${JSON.stringify(raw)}`);
}

/** 协议解析失败 */
class ProtocolParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolParseError';
  }
}

/**
 * 把任意 error 映射为 deny 的 reason_code（fail-closed）。
 * - ProtocolParseError -> permission.classifier_protocol_failure
 * - abort error -> permission.classifier_aborted
 * - timeout -> permission.classifier_timeout
 * - retry exhausted (classifier unavailable) -> permission.classifier_unavailable
 * - 其他 -> permission.classifier_failure
 */
function classifierFailureReason(error: unknown): string {
  if (error instanceof ProtocolParseError) return 'permission.classifier_protocol_failure';
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'permission.classifier_aborted';
    if (/timeout/i.test(error.message)) return 'permission.classifier_timeout';
    if (/input limit|input_limit/i.test(error.message)) return 'permission.classifier_input_limit_exceeded';
  }
  return 'permission.classifier_failure';
}

/** classifier retry 最大次数（与 foreground MAX_RETRY_LIMIT 对齐） */
const CLASSIFIER_MAX_RETRIES = 3;

/** retry 耗尽时抛出的 sentinel error */
class ClassifierUnavailableError extends Error {
  constructor() {
    super('Classifier retry exhausted');
    this.name = 'ClassifierUnavailableError';
  }
}

/** DefaultPermissionClassifier 构造参数 */
export interface DefaultPermissionClassifierOptions {
  readonly provider: PermissionClassifierProvider;
  readonly modelPolicy: ClassifierModelPolicy;
  readonly modelContext: ClassifierModelContext;
  readonly rules?: readonly string[];
  /**
   * 可注入的 retry sleeper（设计 §9）。
   * 同一 per-resolution AbortSignal 同时传给 provider RPC 和 retrySleeper.wait。
   * 默认用 RetrySleeper。
   */
  readonly retrySleeper?: RetrySleeperInterface;
  /**
   * 可注入的 retry delay 随机数生成器（测试确定性）。
   * 默认 Math.random。
   */
  readonly retryRandom?: () => number;
}

/**
 * 默认两阶段 PermissionClassifier（设计 §7.2）。
 *
 * classify(input, signal)：
 *   1. 无 authentic user message -> provider 0 调用，deny(missing_user_authorization)；
 *   2. selectStage1 绑定模型（不可用 -> deny，不 fallback）；
 *   3. Stage1 RPC（带 retry，复用同一绑定 ModelRef + 同一 signal）-> parseStage1Decision：
 *      - ALLOW -> allow（Stage2=0）；
 *      - FLAG -> Stage2；
 *   4. Stage2 用同一 prefix + Stage1 绑定模型（带 retry）-> parseStage2Decision：
 *      - ALLOW -> allow；DENY -> deny；
 *   5. 任一 failure -> deny（fail-closed）。
 *
 * signal 是调用方传入的 per-resolution AbortSignal，贯穿 Stage1/Stage2/provider RPC/retry sleep。
 * 不创建共享 this.signal。
 *
 * retry 不变量（设计 §9 A60-A63）：
 *   - classifier retry 固定复用同一已绑定 ModelRef，永不跨模型 fallback；
 *   - AbortError 不 retry；retry wait 与 provider RPC 共用同一 signal；
 *   - abort 后 retry wait 立即终止，后续 provider 调用不增加；
 *   - retry 耗尽 -> deny(classifier_unavailable)。
 */
export class DefaultPermissionClassifier {
  private readonly provider: PermissionClassifierProvider;
  private readonly modelPolicy: ClassifierModelPolicy;
  private readonly modelContext: ClassifierModelContext;
  private readonly rules: readonly string[];
  private readonly retrySleeper: RetrySleeperInterface;
  private readonly retryRandom: () => number;

  constructor(opts: DefaultPermissionClassifierOptions) {
    this.provider = opts.provider;
    this.modelPolicy = opts.modelPolicy;
    this.modelContext = opts.modelContext;
    this.rules = opts.rules ?? [];
    this.retrySleeper = opts.retrySleeper ?? new RetrySleeper();
    this.retryRandom = opts.retryRandom ?? Math.random;
  }

  async classify(input: PermissionClassifierInput, signal: AbortSignal): Promise<ClassifierDecision> {
    // 1. 无 authentic user message -> provider 0 调用，deny
    if (input.authenticUserMessages.length === 0) {
      return deny('permission.classifier_missing_user_authorization');
    }

    try {
      // 2. 绑定 Stage1 模型（不可用 -> 抛错 -> deny，不 fallback）
      const stage1Model = this.modelPolicy.selectStage1(this.modelContext);

      // 3. 构建不可变 prefix（Stage1/Stage2 共用）
      const prefix = buildClassifierPromptPrefix(input, this.rules);

      // 4. Stage1 RPC（带 retry，复用同一 ModelRef + 同一 signal）
      const stage1Raw = await this.invokeWithRetry(stage1Model, prefix, signal, STAGE1_INSTRUCTION, 1);
      const stage1 = parseStage1Decision(stage1Raw);

      // ALLOW -> allow（Stage2=0）
      if (stage1 === 'ALLOW') {
        return allow('permission.classifier_stage1_allow');
      }

      // FLAG -> Stage2 exactly once，同一 prefix + Stage1 绑定模型（带 retry）
      const stage2Model = this.modelPolicy.selectStage2(this.modelContext, stage1Model);
      const stage2Raw = await this.invokeWithRetry(stage2Model, prefix, signal, STAGE2_INSTRUCTION, 2);
      const stage2 = parseStage2Decision(stage2Raw);
      return stage2 === 'ALLOW'
        ? allow('permission.classifier_stage2_allow')
        : deny('permission.classifier_stage2_deny');
    } catch (error) {
      // 任一 failure -> deny（fail-closed），不返回 ask
      if (error instanceof ClassifierUnavailableError) {
        return deny('permission.classifier_unavailable');
      }
      return deny(classifierFailureReason(error));
    }
  }

  /**
   * 带 retry 的 provider invoke（设计 §9 A60-A63）。
   *
   * 不变量：
   *   - 固定复用同一 model（永不跨模型 fallback）；
   *   - 同一 signal 贯穿 provider RPC 和 retrySleeper.wait；
   *   - AbortError 不 retry；
   *   - isRetryableApiError 为 false 时不 retry（直接抛出）；
   *   - retry 耗尽（CLASSIFIER_MAX_RETRIES）-> 抛 ClassifierUnavailableError。
   */
  private async invokeWithRetry(
    model: ModelRef,
    prefix: string,
    signal: AbortSignal,
    instruction: string,
    stage: 1 | 2,
  ): Promise<unknown> {
    const caps = this.provider.capabilities;
    let lastError: unknown;
    for (let attempt = 0; attempt <= CLASSIFIER_MAX_RETRIES; attempt++) {
      // signal 已 abort -> 不发 provider 请求
      if (signal.aborted) throw makeAbortError();
      try {
        return await this.provider.invoke(
          buildClassifierProviderRequest(stage, model, prefix, signal, caps, instruction),
        );
      } catch (error) {
        lastError = error;
        // AbortError 不 retry
        if (error instanceof Error && error.name === 'AbortError') throw error;
        // 不可重试的错误不 retry
        if (!isRetryableApiError(error)) throw error;
        // retry 耗尽
        if (attempt >= CLASSIFIER_MAX_RETRIES) throw new ClassifierUnavailableError();
        // 同一 signal 贯穿 retry sleep
        const delay = getRetryDelay(attempt, this.retryRandom);
        await this.retrySleeper.wait(delay, signal);
        // sleep 期间 signal 可能被 abort -> wait 已 reject AbortError，
        // 但若 wait 未 reject（某些实现），这里再检查一次
        if (signal.aborted) throw makeAbortError();
      }
    }
    throw lastError;
  }
}

/** 构造 AbortError */
function makeAbortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}
