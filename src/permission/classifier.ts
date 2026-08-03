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
import type { ClassifierModelPolicy, ClassifierModelContext } from './classifier-model-policy.js';

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

/** DefaultPermissionClassifier 构造参数 */
export interface DefaultPermissionClassifierOptions {
  readonly provider: PermissionClassifierProvider;
  readonly modelPolicy: ClassifierModelPolicy;
  readonly modelContext: ClassifierModelContext;
  readonly rules?: readonly string[];
}

/**
 * 默认两阶段 PermissionClassifier（设计 §7.2）。
 *
 * classify(input, signal)：
 *   1. 无 authentic user message -> provider 0 调用，deny(missing_user_authorization)；
 *   2. selectStage1 绑定模型（不可用 -> deny，不 fallback）；
 *   3. Stage1 RPC -> parseStage1Decision：
 *      - ALLOW -> allow（Stage2=0）；
 *      - FLAG -> Stage2；
 *   4. Stage2 用同一 prefix + Stage1 绑定模型 -> parseStage2Decision：
 *      - ALLOW -> allow；DENY -> deny；
 *   5. 任一 failure -> deny（fail-closed）。
 *
 * signal 是调用方传入的 per-resolution AbortSignal，贯穿 Stage1/Stage2/provider RPC。
 * 不创建共享 this.signal。
 */
export class DefaultPermissionClassifier {
  private readonly provider: PermissionClassifierProvider;
  private readonly modelPolicy: ClassifierModelPolicy;
  private readonly modelContext: ClassifierModelContext;
  private readonly rules: readonly string[];

  constructor(opts: DefaultPermissionClassifierOptions) {
    this.provider = opts.provider;
    this.modelPolicy = opts.modelPolicy;
    this.modelContext = opts.modelContext;
    this.rules = opts.rules ?? [];
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

      // 4. Stage1 RPC
      const stage1Raw = await this.provider.invoke(
        buildClassifierProviderRequest(
          1,
          stage1Model,
          prefix,
          signal,
          this.provider.capabilities,
          STAGE1_INSTRUCTION,
        ),
      );
      const stage1 = parseStage1Decision(stage1Raw);

      // ALLOW -> allow（Stage2=0）
      if (stage1 === 'ALLOW') {
        return allow('permission.classifier_stage1_allow');
      }

      // FLAG -> Stage2 exactly once，同一 prefix + Stage1 绑定模型
      const stage2Model = this.modelPolicy.selectStage2(this.modelContext, stage1Model);
      const stage2Raw = await this.provider.invoke(
        buildClassifierProviderRequest(
          2,
          stage2Model,
          prefix,
          signal,
          this.provider.capabilities,
          STAGE2_INSTRUCTION,
        ),
      );
      const stage2 = parseStage2Decision(stage2Raw);
      return stage2 === 'ALLOW'
        ? allow('permission.classifier_stage2_allow')
        : deny('permission.classifier_stage2_deny');
    } catch (error) {
      // 任一 failure -> deny（fail-closed），不返回 ask
      return deny(classifierFailureReason(error));
    }
  }
}
