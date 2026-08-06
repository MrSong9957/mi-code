// Interactive ask：竞速、ESC abort 与 remember（Task 7 / 设计 §8、§10 A44-A47/A49）
//
// 物理本质：auto 模式下 ask 的"人机竞速调度器"。
//   - automatic（PendingAutomaticDecision）由 resolver 创建，经 registerAbort 暴露；
//   - resolveInteractiveAsk 不创建第二个 AbortController，持有 automatic；
//   - 2 秒竞速：automatic 在 delay 内完成 → 直接返回（不创建 dialog）；
//     超时 → 创建 dialog，与 automatic 继续 race；
//   - dialog 返回 ESC → 自行调用 automatic.abort()（provider signal 自动 aborted）；
//   - dialog 返回 approved_session → 记住 exact canonical tool + structured input；
//   - dialog 返回 approved_always → 持久化规则 + 重新经过同步 checker（不绕过 hard deny）；
//   - requiresInteraction 路径不存在 automatic classifier，dialog 直接出现。
//
// 不变量：
//   - 不存在 abortAutomatic: vi.fn() 第二套取消接口；
//   - always-allow 更新后必须重新经过同步 checker；
//   - ESC 只经 automatic.abort() 取消 classifier（不手工 abortHandles.forEach）。

import type { SecurityDecision } from './decisions.js';
import type { PendingAutomaticDecision } from './ask-resolver.js';

/** dialog 返回结果 */
export type DialogResult =
  | { kind: 'approved_once' }
  | { kind: 'approved_session' }
  | { kind: 'approved_always' }
  | { kind: 'rejected' }
  | { kind: 'escape' };

/** resolveInteractiveAsk 输入 */
export interface InteractiveAskInput {
  readonly decision: SecurityDecision;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly origin: 'main' | 'subagent';
}

/** resolveInteractiveAsk 选项 */
export interface InteractiveAskOptions {
  /** pending automatic decision（classifier）；null 表示无 automatic（denial/requiresInteraction） */
  readonly automatic: PendingAutomaticDecision | null;
  /** dialog 函数（main 路径；headless 不调用 resolveInteractiveAsk） */
  readonly dialog: (input: InteractiveAskInput) => Promise<DialogResult>;
  /** dialog 创建延迟（ms）；automatic 在此之前完成则不创建 dialog */
  readonly dialogDelayMs: number;
  /** 可注入的定时器（默认 setTimeout）；测试用 fake timer 注入 */
  readonly clock?: {
    delay(ms: number): Promise<void>;
  };
  /** denial state（A44：达到阈值则回退 dialog，无竞速） */
  readonly denialState?: { readonly consecutive: number; readonly total: number };
  /** accept-session 回调（A46：记住 exact tool + input） */
  readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  /** always-allow 持久化回调（A47） */
  readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  /** always-allow 持久化后重新检查（A47：不绕过 hard deny） */
  readonly recheckAfterPersist?: () => SecurityDecision;
}

/** 默认 clock（真实 setTimeout） */
const defaultClock = {
  delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

/** denial 回退阈值 */
const DENIAL_FALLBACK_CONSECUTIVE = 3;
const DENIAL_FALLBACK_TOTAL = 20;

/**
 * 解析交互式 ask（设计 §8 / A44-A47/A49）。
 *
 * 竞速语义：
 *   1. 无 automatic（denial threshold / requiresInteraction）→ 直接 dialog（无竞速）；
 *   2. 有 automatic → Promise.race([automatic.promise, clock.delay(dialogDelayMs).then(dialog)])；
 *      automatic 先完成 → 返回其结果（dialog 不创建）；
 *      delay 先完成 → 创建 dialog，与 automatic 继续 race；
 *   3. dialog 返回 ESC → 自行调用 automatic.abort()（取消 classifier RPC）；
 *   4. dialog 返回 approved_* → 按 remember 类型处理（session/persist/recheck）；
 *   5. dialog 返回 rejected → deny。
 */
export async function resolveInteractiveAsk(
  input: InteractiveAskInput,
  options: InteractiveAskOptions,
): Promise<SecurityDecision> {
  const clock = options.clock ?? defaultClock;
  const hasDenialFallback =
    (options.denialState?.consecutive ?? 0) >= DENIAL_FALLBACK_CONSECUTIVE ||
    (options.denialState?.total ?? 0) >= DENIAL_FALLBACK_TOTAL;

  // 1. 无 automatic（denial / requiresInteraction）→ 直接 dialog
  if (!options.automatic || hasDenialFallback) {
    return runDialog(input, options);
  }

  // 2. 竞速：automatic 只在 dialog delay 窗口内有决定权。
  //    delay 到期前 automatic 完成 → automatic 赢，不创建 dialog。
  //    delay 先到期 → automatic 永久失去本次 tool call 的决定权：
  //      abort 尚未完成的 classifier RPC，创建 dialog，最终 decision 只能来自用户。
  //    （禁止 dialog 已显示后 classifier 仍能放行的结构。）
  const autoPromise = options.automatic.promise;
  const delayPromise = clock.delay(options.dialogDelayMs).then(() => 'delay-done' as const);

  const earlyResult = await Promise.race([
    autoPromise.then((decision) => ({ source: 'automatic' as const, decision })),
    delayPromise.then(() => ({ source: 'delay' as const })),
  ]);

  // delay 窗口内 automatic 完成 → 返回 automatic decision，不创建 dialog
  if (earlyResult.source === 'automatic') {
    return earlyResult.decision;
  }

  // delay 先到期：automatic 永久失权。abort 尚未完成的 classifier（取消无谓 RPC）。
  options.automatic.abort();
  // 创建并等待 dialog；classifier 后续 resolve 被忽略（不再参与任何 race）。
  const dialogResult = await options.dialog(input);
  return handleDialogResult(dialogResult, input, options);
}

/** 无竞速直接 dialog（denial / requiresInteraction） */
async function runDialog(input: InteractiveAskInput, options: InteractiveAskOptions): Promise<SecurityDecision> {
  const result = await options.dialog(input);
  return handleDialogResult(result, input, options);
}

/** 处理 dialog 结果 */
function handleDialogResult(
  result: DialogResult,
  input: InteractiveAskInput,
  options: InteractiveAskOptions,
): SecurityDecision {
  switch (result.kind) {
    case 'escape':
      // ESC → 自行调用 automatic.abort()（取消 classifier RPC）
      options.automatic?.abort();
      return makeDeny('permission.user_cancelled');

    case 'rejected':
      options.automatic?.abort();
      return makeDeny('permission.user_denied');

    case 'approved_once':
      return makeAllow('permission.user_approved');

    case 'approved_session':
      // 记住 exact canonical tool + structured input（A46）
      options.onSessionAllow?.(input.toolName, input.input);
      return makeAllow('permission.session_allow');

    case 'approved_always':
      // 持久化规则（A47）
      options.onPersistRule?.({
        type: 'addRules',
        destination: 'userSettings',
        rule: { tool: input.toolName, behavior: 'allow', ...(Object.keys(input.input).length > 0 ? { content: JSON.stringify(input.input) } : {}) },
      });
      // 重新经过同步 checker（不绕过 hard deny）
      if (options.recheckAfterPersist) {
        return options.recheckAfterPersist();
      }
      return makeAllow('permission.always_allow');

    default:
      return makeDeny('permission.unknown_dialog_result');
  }
}

function makeAllow(reasonCode: string): SecurityDecision {
  return { behavior: 'allow', reason_code: reasonCode } as SecurityDecision;
}
function makeDeny(reasonCode: string): SecurityDecision {
  return { behavior: 'deny', reason_code: reasonCode } as SecurityDecision;
}
