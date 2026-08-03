// PermissionRequest hooks + headless ask 解析（Task 5 / 设计 §8、§10 A34/A40/A41）
//
// 物理本质：headless（无 UI）路径下唯一的"外部静默授权通道"。
//   - runPermissionRequestHooks：按注册顺序执行 hooks，首个明确 allow/deny 立即结束；
//     hook 异常记诊断后按 null 处理；全部无决定返回 null。
//   - resolveHeadlessAsk：hooks 无决定时，默认 deny（fail-closed）；
//     bubble 仅在显式 bubbleEnabled 选项下产生（默认 deny）。
//
// 不变量：
//   - headless 绝不创建 dialog（无 UI 副作用）；
//   - hooks 是 headless 唯一外部 allow 通道；
//   - 无 hook 决定 -> deny（不静默放行）；
//   - hook 异常 -> null（不改变结果）。

import type { SecurityDecision } from './decisions.js';

/** PermissionRequest hook 输入 */
export interface HeadlessAskInput {
  readonly decision: SecurityDecision;
}

/** PermissionRequest hook：返回 'allow' | 'deny' | null（null=无决定） */
export type PermissionRequestHook = (ask: HeadlessAskInput) => Promise<'allow' | 'deny' | null>;

/** resolveHeadlessAsk 选项 */
export interface ResolveHeadlessAskOptions {
  /** bubble 仅在显式 bubbleEnabled=true 时产生（A41）；默认 false -> deny */
  readonly bubbleEnabled?: boolean;
}

/** headless 解析结果（bubble 是 A41 的显式选项产物） */
export type HeadlessResolution = SecurityDecision | { readonly behavior: 'bubble' };

/**
 * 按注册顺序执行 PermissionRequest hooks。
 *
 * 语义：
 *   - 首个明确 'allow' 或 'deny' 立即返回，后续 hooks 不调用；
 *   - hook 抛异常 -> 记诊断后视为 null（不改变结果）；
 *   - 全部返回 null -> 返回 null（调用方决定 deny 或 bubble）。
 */
export async function runPermissionRequestHooks(
  ask: HeadlessAskInput,
  hooks: readonly PermissionRequestHook[],
): Promise<'allow' | 'deny' | null> {
  for (const hook of hooks) {
    try {
      const result = await hook(ask);
      if (result === 'allow' || result === 'deny') {
        return result;
      }
      // null -> 继续下一个 hook
    } catch {
      // hook 异常记诊断后视为 null（不改变结果）；继续下一个 hook
      // 诊断日志由调用方/上层捕获，此处不产生副作用
    }
  }
  return null;
}

/**
 * 解析 headless ask（设计 §8 / A34 / A40 / A41）。
 *
 * 批准语义（hooks 是统一决策入口）：
 *   1. 非 ask 直接返回（deny/allow 透传）；
 *   2. 任何 ask（含 safety_uncertain / unknown category）都先运行 PermissionRequest hooks；
 *      首个明确 allow/deny 立即生效；hook error/null 继续；
 *   3. hooks 无决定：bubbleEnabled=true -> bubble；否则 deny（fail-closed）。
 *
 * applySubagentSilentPolicy 不在 hooks 前终结 ask —— 它只用于 subagent origin 的
 * 既有静默分流（tool-execution.ts 调用），不参与 headless hook 解析。
 * headless 绝不创建 dialog。
 */
export async function resolveHeadlessAsk(
  ask: HeadlessAskInput,
  hooks: readonly PermissionRequestHook[],
  options: ResolveHeadlessAskOptions = {},
): Promise<HeadlessResolution> {
  // 1. 非 ask 直接返回（deny/allow 透传）
  if (ask.decision.behavior !== 'ask') {
    return ask.decision;
  }

  // 2. hooks 是 headless ask 的统一决策入口（任何 ask 都先经 hooks）
  const hookResult = await runPermissionRequestHooks(ask, hooks);
  if (hookResult === 'allow') {
    return rewriteBehavior(ask.decision, 'allow', 'permission.headless_hook_allow');
  }
  if (hookResult === 'deny') {
    return rewriteBehavior(ask.decision, 'deny', 'permission.headless_hook_deny');
  }

  // 3. hooks 无决定：bubble 或 deny（fail-closed）
  if (options.bubbleEnabled) {
    return { behavior: 'bubble' };
  }
  return rewriteBehavior(ask.decision, 'deny', 'permission.headless_no_decision');
}

/** 把 decision 改写为指定 behavior（经 createSecurityDecision 构造新 frozen 对象） */
function rewriteBehavior(
  base: SecurityDecision,
  behavior: 'allow' | 'deny',
  reasonCode: string,
): SecurityDecision {
  // 复用 subagent-silent-policy 的 rewrite 语义：保留 identity，只覆盖 behavior + reason_code
  // 此处直接构造最小 SecurityDecision（与 applySubagentSilentPolicy 同源语义）
  return {
    ...base,
    behavior,
    reason_code: reasonCode,
    provenance_refs: behavior === 'allow' ? (base.provenance_refs.length > 0 ? [...base.provenance_refs] : ['permission:headless-hook']) : base.provenance_refs,
  } as SecurityDecision;
}
