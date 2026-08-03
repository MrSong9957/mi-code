// denial tracker（Task 4 / 设计 §3 AutoPermissionState.denial / A30、A31、A81）
//
// 物理本质：纯函数计数器，无 I/O。
//   - consecutive：连续 auto 拒绝数；allow 清零。
//   - total：累计 auto 拒绝数；allow 不清零。
//   - 阈值：3 consecutive 或 20 total 达到即 shouldFallbackToPrompting=true（回退交互）。

/** auto 拒绝计数状态（frozen） */
export interface DenialState {
  readonly consecutive: number;
  readonly total: number;
}

/** consecutive 连续拒绝阈值（A30） */
export const DENIAL_CONSECUTIVE_THRESHOLD = 3;
/** total 累计拒绝阈值（A30） */
export const DENIAL_TOTAL_THRESHOLD = 20;

/** 创建初始空状态（frozen） */
export function createDenialState(): DenialState {
  return Object.freeze({ consecutive: 0, total: 0 });
}

/**
 * 是否达到回退交互阈值（A30）。
 * 3 consecutive 或 20 total 任一达到即 true。
 */
export function shouldFallbackToPrompting(state: DenialState): boolean {
  return state.consecutive >= DENIAL_CONSECUTIVE_THRESHOLD || state.total >= DENIAL_TOTAL_THRESHOLD;
}

/**
 * 记录一次 allow：consecutive 清零，total 保留（A31）。
 * 返回新 frozen 状态，不修改输入。
 */
export function recordAllow(state: DenialState): DenialState {
  return Object.freeze({ consecutive: 0, total: state.total });
}

/**
 * 记录一次 denial：consecutive +1，total +1。
 * 返回新 frozen 状态，不修改输入。
 */
export function recordDenial(state: DenialState): DenialState {
  return Object.freeze({ consecutive: state.consecutive + 1, total: state.total + 1 });
}
