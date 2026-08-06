// Auto ask resolver（Task 6 / 设计 §6 Auto ask resolver）
//
// Core Anchor：PermissionAskResolver.resolve(request) -> Promise<SecurityDecision>
//
// 物理本质：auto 模式下 ask 的"调度中心"。接收同步 checker 的 ask，按固定顺序尝试
// 本地解决（safety 前置、allowlist、acceptEdits simulation），均未解决才调用 classifier。
// classifier pending 时被审核 tool 不得进入 RuntimeSecurityGate。
//
// 固定顺序（设计 §6，不可重排）：
//   1. 非 ask：原样返回
//   2. non-classifierApprovable safety：main -> 保留 ask；headless -> hooks -> deny
//   3. requiresUserInteraction：保留 ask
//   4. denial threshold：回退交互（main -> ask；headless -> hooks -> deny）
//   5. explicit ask rule：跳过 allowlist + acceptEdits，直接 classifier
//   6. auto safe allowlist（本文件唯一持有）：canonical exact match -> allow，classifier 0 调用
//   7. canonical run_bash 强制 classifier 短路（§6.4 锚点 2）：跳过 acceptEdits，直接 classifier
//   8. acceptEdits simulation：discretionary allow / deny -> 直接返回；ask/passthrough 继续
//   9. classifier：创建独立 AbortController，await 裁决
//
// 不变量：
//   - AUTO_SAFE_TOOL_ALLOWLIST 只存在于本文件；
//   - resolver 是唯一 AbortController 创建者，每个 tool call 独立；
//   - classifier pending 时 gate/executor = 0；
//   - classifier 只返回 allow/deny，不返回 ask。

import type { SecurityDecision } from './decisions.js';
import type { PermissionClassifierInput, ExecutableToolCall } from './classifier-input.js';
import type { ClassifierDecision } from './classifier.js';
import { projectPermissionClassifierInput } from './classifier-input.js';
import { resolveHeadlessAsk, type PermissionRequestHook } from './permission-request-hooks.js';
import { resolveInteractiveAsk, type InteractiveAskInput, type DialogResult } from './interactive-ask.js';
import type { Message } from '../agent/types.js';

/**
 * auto safe allowlist 的唯一真相源（设计 §6.1）。
 * 匹配发生在 canonicalize 之后，只做 canonical tool ID exact match。
 * run_bash、spawn_agent、MCP、写入/变更工具与 wildcard 均不在该集合。
 * classifier 模块不得导入、复制或检查该集合。
 */
export const AUTO_SAFE_TOOL_ALLOWLIST = new Set<string>([
  'read_file',
  'glob',
  'grep',
  'load_skill',
  'schedule_list',
  'memory_read',
  'memory_list',
  'read_inbox',
  'read_plan_file',
]);

/**
 * pending automatic decision contract（Task 6/7）。
 * resolver 在 resolveByClassifier 构造：promise 是 classifier 裁决，abort 取消 RPC。
 * resolveInteractiveAsk 持有此对象；ESC 时自行调用 abort()，不创建第二个 controller。
 */
export interface PendingAutomaticDecision {
  readonly promise: Promise<SecurityDecision>;
  readonly abort: () => void;
}

/** resolver 请求 */
export interface PermissionAskResolutionRequest {
  readonly decision: SecurityDecision;
  readonly executableToolCall: ExecutableToolCall;
  readonly messages: readonly Message[];
  readonly origin: 'main' | 'subagent';
  readonly permissionContext: unknown;
  /** 暴露 resolver 创建的 abort handle（供 executeToolCall/Task 7 ESC 注入） */
  readonly registerAbort?: (abort: () => void) => void;
}

/** resolver 接口（设计 §6 Core Anchor） */
export interface PermissionAskResolver {
  resolve(request: PermissionAskResolutionRequest): Promise<SecurityDecision>;
}

/** classifier 最小契约（resolver 只调用 classify） */
export interface ResolverClassifier {
  classify(input: PermissionClassifierInput, signal: AbortSignal): Promise<ClassifierDecision>;
}

/** acceptEdits evaluation 契约 */
export interface ResolverEvaluator {
  (toolName: string, input: Record<string, unknown>, evaluationMode: string): Promise<SecurityDecision>;
}

/** resolver 构造参数 */
export interface DefaultPermissionAskResolverOptions {
  readonly classifier: ResolverClassifier;
  readonly evaluateWithMode: ResolverEvaluator;
  readonly hooks: readonly PermissionRequestHook[];
  readonly denialState: { readonly consecutive: number; readonly total: number };
  /** Task 7：main-origin dialog 函数（经 resolveInteractiveAsk 竞速）；未提供时 main 走原 classifier 直等 */
  readonly dialogProvider?: (input: import('./interactive-ask.js').InteractiveAskInput) => Promise<import('./interactive-ask.js').DialogResult>;
  /** Task 7：dialog 创建延迟 ms（竞速窗口） */
  readonly dialogDelayMs?: number;
  /** Task 7 A46：accept-session 回调（透传给 resolveInteractiveAsk.onSessionAllow）。 */
  readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  /** Task 7 A47：always-allow 持久化回调（透传给 resolveInteractiveAsk.onPersistRule）。 */
  readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  /** Task 7 A47：always-allow 后同步重检（带 tool/input；在 resolveByClassifier capture 当前调用）。 */
  readonly recheck?: (toolName: string, input: Record<string, unknown>) => SecurityDecision;
}

/** non-classifierApprovable safety 的 reason_code 集合（设计 §6.3） */
const NON_CLASSIFIER_APPROVABLE = new Set<string>([
  'permission.command_unparseable',
  'permission.command_unresolvable_var',
  'permission.dangerous_command',
  'permission.path_outside_workspace',
]);

/** requiresUserInteraction 的 reason_code（设计 §5） */
const REQUIRES_INTERACTION = new Set<string>([
  'permission.requires_interaction',
]);

/** explicit ask rule 的 reason_code */
const EXPLICIT_ASK = 'permission.explicit_ask';

/** denial 回退阈值 */
const DENIAL_FALLBACK_CONSECUTIVE = 3;
const DENIAL_FALLBACK_TOTAL = 20;

/**
 * 默认 resolver（设计 §6 固定顺序）。
 */
export class DefaultPermissionAskResolver implements PermissionAskResolver {
  private readonly classifier: ResolverClassifier;
  private readonly evaluateWithMode: ResolverEvaluator;
  private readonly hooks: readonly PermissionRequestHook[];
  private readonly denialState: { readonly consecutive: number; readonly total: number };
  private readonly dialogProvider?: (input: InteractiveAskInput) => Promise<DialogResult>;
  private readonly dialogDelayMs: number;
  private readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  private readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  private readonly recheck?: (toolName: string, input: Record<string, unknown>) => SecurityDecision;

  constructor(opts: DefaultPermissionAskResolverOptions) {
    this.classifier = opts.classifier;
    this.evaluateWithMode = opts.evaluateWithMode;
    this.hooks = opts.hooks;
    this.denialState = opts.denialState;
    this.dialogProvider = opts.dialogProvider;
    this.dialogDelayMs = opts.dialogDelayMs ?? 2000;
    this.onSessionAllow = opts.onSessionAllow;
    this.onPersistRule = opts.onPersistRule;
    this.recheck = opts.recheck;
  }

  async resolve(request: PermissionAskResolutionRequest): Promise<SecurityDecision> {
    // 1. 非 ask：原样返回
    if (request.decision.behavior !== 'ask') {
      return request.decision;
    }

    const rc = request.decision.reason_code;
    const isHeadless = request.origin === 'subagent';

    // 2. non-classifierApprovable safety：main -> ask；headless -> hooks -> deny
    if (NON_CLASSIFIER_APPROVABLE.has(rc)) {
      return this.resolveSafety(request);
    }

    // 3. requiresUserInteraction：保留 ask
    if (REQUIRES_INTERACTION.has(rc)) {
      return isHeadless ? this.resolveHeadless(request) : request.decision;
    }

    // 4. denial threshold：回退交互
    if (
      this.denialState.consecutive >= DENIAL_FALLBACK_CONSECUTIVE ||
      this.denialState.total >= DENIAL_FALLBACK_TOTAL
    ) {
      return isHeadless ? this.resolveHeadless(request) : request.decision;
    }

    // 5. explicit ask rule：跳过 allowlist + acceptEdits，直接 classifier
    if (rc === EXPLICIT_ASK) {
      return this.resolveByClassifier(request);
    }

    // 6. auto safe allowlist（本文件唯一持有）：canonical exact match -> allow
    if (AUTO_SAFE_TOOL_ALLOWLIST.has(request.executableToolCall.canonicalToolName)) {
      return this.allow('permission.auto_allowlist');
    }

    // 7. canonical run_bash 强制 classifier 短路（设计 §6.4 锚点 2）
    //    覆盖 reason_code permission.auto_run_bash_requires_classifier（executeToolCall 降级产物）
    //    以及任何其他原因进入 resolver 的 canonical run_bash ask。
    //    按 tool name 短路（run_bash 不在 allowlist 已由第 6 步保证），永不进入 acceptEdits simulation。
    if (request.executableToolCall.canonicalToolName === 'run_bash') {
      return this.resolveByClassifier(request);
    }

    // 8. acceptEdits simulation
    const simulated = await this.evaluateWithMode(
      request.executableToolCall.canonicalToolName,
      request.executableToolCall.input,
      'acceptEdits',
    );
    if (simulated.behavior === 'allow') return simulated;
    if (simulated.behavior === 'deny') return simulated;

    // 9. classifier
    return this.resolveByClassifier(request);
  }

  /** non-classifierApprovable safety：main 保留 ask；headless hooks -> deny */
  private async resolveSafety(request: PermissionAskResolutionRequest): Promise<SecurityDecision> {
    if (request.origin === 'main') return request.decision;
    return this.resolveHeadless(request);
  }

  /** headless 路径：hooks -> 无决定 deny */
  private async resolveHeadless(request: PermissionAskResolutionRequest): Promise<SecurityDecision> {
    const result = await resolveHeadlessAsk({ decision: request.decision }, this.hooks);
    if (result.behavior === 'bubble') {
      return this.deny('permission.headless_bubble_unsupported');
    }
    return result as SecurityDecision;
  }

  /**
   * classifier 路径（设计 §6 / §7 / §8）：
   * resolver 是唯一 AbortController 创建者，每个 tool call 独立 controller。
   * signal 贯穿 Stage1/Stage2/provider RPC。registerAbort 暴露 abort handle。
   *
   * main-origin + dialogProvider → 经 resolveInteractiveAsk 竞速（Task 7）：
   *   - 构造 PendingAutomaticDecision { promise, abort }（复用同一 controller）；
   *   - resolveInteractiveAsk 不创建第二个 controller，ESC 时自行调用 abort()。
   * subagent-origin 或无 dialogProvider → 直等 classifier（headless）。
   */
  private resolveByClassifier(request: PermissionAskResolutionRequest): Promise<SecurityDecision> {
    const input = projectPermissionClassifierInput(request.messages, request.executableToolCall);
    const controller = new AbortController();
    request.registerAbort?.(() => controller.abort());

    const classifyPromise = this.classifier
      .classify(input, controller.signal)
      .then((d: ClassifierDecision) =>
        d.behavior === 'allow'
          ? this.allow('permission.classifier_resolved_allow')
          : this.deny('permission.classifier_resolved_deny'),
      )
      .catch(() => this.deny('permission.classifier_failure'));

    // main-origin + dialogProvider → resolveInteractiveAsk 竞速
    if (request.origin === 'main' && this.dialogProvider) {
      const automatic: PendingAutomaticDecision = {
        promise: classifyPromise,
        abort: () => controller.abort(),
      };
      const interactiveInput: InteractiveAskInput = {
        decision: request.decision,
        toolName: request.executableToolCall.canonicalToolName,
        input: { ...request.executableToolCall.input },
        origin: 'main',
      };
      return resolveInteractiveAsk(interactiveInput, {
        automatic,
        dialog: this.dialogProvider,
        dialogDelayMs: this.dialogDelayMs,
        ...(this.onSessionAllow !== undefined ? { onSessionAllow: this.onSessionAllow } : {}),
        ...(this.onPersistRule !== undefined ? { onPersistRule: this.onPersistRule } : {}),
        ...(this.recheck !== undefined
          ? { recheckAfterPersist: () => this.recheck!(request.executableToolCall.canonicalToolName, request.executableToolCall.input) }
          : {}),
      });
    }

    // subagent / 无 dialog → 直等 classifier
    return classifyPromise;
  }

  private allow(reasonCode: string): SecurityDecision {
    return { behavior: 'allow', reason_code: reasonCode } as SecurityDecision;
  }
  private deny(reasonCode: string): SecurityDecision {
    return { behavior: 'deny', reason_code: reasonCode } as SecurityDecision;
  }
}
