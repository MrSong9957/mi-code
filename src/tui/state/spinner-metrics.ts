// Spinner 指标段（时长 + token）的统一格式化器。
//
// Claude Code 样式：
//   有 token：(23s · ↓ 1.2k tokens)
//   无 token：(23s)
//
// 设计目标：Ink（Spinner.tsx）与 inline（SpinnerLine.tsx）共享同一份拼装规则，
// 不再各自维护 "  ${duration}${tokens}" 这样的字符串模板。

import {
  formatSpinnerDuration,
  totalSpinnerTokens,
  type SpinnerMode,
} from './spinner-store.js';

export interface SpinnerMetricsInput {
  /** spinner 统一动画时钟（毫秒） */
  time: number;
  /** leader 已显示的 token 数（来自流式累加 + 平滑追赶） */
  displayedTokens: number;
  /** 所有 teammate 汇总的 token 数 */
  teammateTokens: number;
  /** 当前 spinner 模式，决定箭头方向（requesting→↑, 其他→↓） */
  mode: SpinnerMode;
}

/**
 * 格式化 token 计数为紧凑显示：
 * - < 1000：原样（如 136）
 * - ≥ 1000：k 单位，保留 1 位小数（如 3909 → 3.9k）
 */
function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  // 1.0k → 1k（去掉多余的 .0）
  return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
}

/**
 * 格式化 spinner 末尾的「时长 + token」指标段。
 *
 * 规则：
 * - 整体用括号包裹；
 * - 时长沿用 formatSpinnerDuration（0 钳位为 1s、整分钟为 1m、分钟+秒为 1m 30s）；
 * - 有 token 时追加 ` · {arrow} {formatted} tokens`：requesting 用 ↑、其他用 ↓；
 *   ≥1000 用 k 单位（3.9k），<1000 原样；
 * - 无 token 时只返回 `({duration})`，不含中点和箭头；
 * - 负值、NaN 防御：token 经 totalSpinnerTokens 钳为 0，时长由 formatSpinnerDuration 钳位。
 */
export function formatSpinnerMetrics(
  time: number,
  displayedTokens: number,
  teammateTokens: number,
  mode: SpinnerMode,
): string {
  const duration = formatSpinnerDuration(time);
  const totalTokens = totalSpinnerTokens(displayedTokens, teammateTokens);
  if (totalTokens <= 0) {
    return `(${duration})`;
  }
  const arrow = mode === 'requesting' ? '↑' : '↓';
  return `(${duration} · ${arrow} ${formatTokenCount(totalTokens)} tokens)`;
}
