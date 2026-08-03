// 单一 Mode Transition（Task 8 / 设计 §9.2、§9.3、§10 A20-A23）
//
// 物理本质：权限模式切换的"统一收费站"。slash / TAB / plan approval 三条入口
// 都只调用 transitionPermissionMode，由它产生 setMode PermissionUpdate 并决定是否持久化。
//
// 不变量：
//   - mode 变化只通过 applyPermissionUpdate（setMode）；
//   - same-mode no-op（返回空 effects，不写盘）；
//   - session destination 不写盘；settings destination 写盘；
//   - startup precedence：CLI > sanitized resume > user default > build；
//   - restriction gate 只降级/拒绝，不授予更高权限；
//   - resume 先清瞬态（transitionTo），再 reload/repartition 持久规则。

import type { PermissionMode } from './types.js';
import type { SessionState } from './session-state.js';

/** transition 产生的 effect（供 ConfigStore / TUI status 订阅） */
export type ModeTransitionEffects =
  | { kind: 'mode_changed'; from: PermissionMode; to: PermissionMode }
  | { kind: 'persisted'; mode: PermissionMode; destination: string };

/** transition 目的地：session（运行时切换，不写盘）或 settings（持久化） */
export type TransitionDestination = 'session' | 'userSettings' | 'projectSettings' | 'localSettings';

/** transition 选项 */
export interface TransitionPermissionModeOptions {
  /** settings destination 时写盘回调 */
  readonly save?: (config: { permissions: { mode: PermissionMode } }) => void;
}

/**
 * 唯一 mode transition port（设计 §10 A20/A23）。
 *
 * slash / TAB / plan approval 都只调用此函数。它：
 *   1. same-mode → no-op（返回空 effects，不写盘）；
 *   2. 不同 mode → applyPermissionUpdate(setMode) + 产生 effects；
 *   3. settings destination → 调 save 写盘；session destination → 不写盘。
 *
 * 返回 effects 列表供 ConfigStore / TUI status 订阅。
 */
export function transitionPermissionMode(
  state: SessionState,
  next: PermissionMode,
  destination: TransitionDestination,
  options: TransitionPermissionModeOptions = {},
): ModeTransitionEffects[] {
  const current = state.permissionSnapshot.mode;

  // same-mode no-op
  if (current === next) {
    return [];
  }

  // 经 applyPermissionUpdate(setMode) —— 唯一状态变换入口
  state.applyPermissionUpdate({ kind: 'setMode', mode: next });

  const effects: ModeTransitionEffects[] = [
    { kind: 'mode_changed', from: current, to: next },
  ];

  // settings destination → 写盘
  if (destination !== 'session') {
    options.save?.({ permissions: { mode: next } });
    effects.push({ kind: 'persisted', mode: next, destination });
  }

  return effects;
}

// ─── Startup precedence（设计 §9.2 / A22）──────────────────────────────────────

/** startup mode 输入 */
export interface StartupModeInput {
  /** CLI --permission-mode flag */
  readonly cliArg?: PermissionMode;
  /** 已清洗且允许恢复的 resumed session mode */
  readonly resumed?: PermissionMode;
  /** userSettings.defaultMode */
  readonly userDefault?: PermissionMode;
  /** projectSettings / localSettings（不选 startup mode，仅贡献规则） */
  readonly projectDefault?: PermissionMode;
  readonly localDefault?: PermissionMode;
}

/**
 * 求 requested startup mode（设计 §9.2）。
 *
 * Precedence：CLI > sanitized resume > userDefault > build。
 * projectSettings/localSettings 不选启动默认模式（只贡献规则）。
 */
export function resolveRequestedStartupMode(input: StartupModeInput): PermissionMode {
  if (input.cliArg) return input.cliArg;
  if (input.resumed) return input.resumed;
  if (input.userDefault) return input.userDefault;
  return 'build';
}

// ─── Restriction gate（设计 §9.3 / A22）────────────────────────────────────────

/** restriction gate 输入 */
export interface RestrictionGates {
  /** managed policy 是否允许 auto */
  readonly managedPolicyAllowsAuto: boolean;
  /** headless / environment 是否允许 auto */
  readonly headlessAllowsAuto?: boolean;
}

/** restriction 结果 */
export interface RestrictionResult {
  readonly mode: PermissionMode;
  readonly reason?: string;
  readonly audited: boolean;
}

/**
 * 启动 restriction gate（设计 §9.3）。
 *
 * requested mode 求出后依次经过 managed policy / environment restriction。
 * gate 只能拒绝或降级（auto → build），不能授予更高权限。
 */
export function applyModeRestrictions(
  requested: PermissionMode,
  gates: RestrictionGates,
): RestrictionResult {
  // managed policy 拒绝 auto → 降级 build + 审计
  if (requested === 'auto' && !gates.managedPolicyAllowsAuto) {
    return { mode: 'build', reason: 'managed_policy', audited: true };
  }
  // 其他情况保持 requested（gate 不升级）
  return { mode: requested, audited: false };
}

/** runtime mode transition restriction（运行时切换被拒绝时当前 mode 保持不变） */
export interface RuntimeTransitionResult {
  readonly mode: PermissionMode;
  readonly changed: boolean;
  readonly reason?: string;
}

/**
 * 运行时 mode 切换 restriction（设计 §9.3）。
 *
 * from → to 切换时，若 restriction 不允许 to，保持 from 不变。
 */
export function applyRuntimeModeTransition(
  from: PermissionMode,
  to: PermissionMode,
  gates: RestrictionGates,
): RuntimeTransitionResult {
  if (to === 'auto' && gates.headlessAllowsAuto === false) {
    return { mode: from, changed: false, reason: 'headless_disallows_auto' };
  }
  return { mode: to, changed: from !== to };
}
