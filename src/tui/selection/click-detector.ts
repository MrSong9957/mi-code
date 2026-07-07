// src/tui/selection/click-detector.ts
// 多击分类：双击/三击检测。
//
// 物理本质：终端 SGR 鼠标不直接报「双击」，需应用层计时。
// 同一按键、同一位置（偏差 ≤ CLICK_SLOP）、间隔 ≤ DOUBLE_CLICK_MS 的连续 mousedown 累加。
// 超时/换位置/换键 → 重置为 single。count 按模 3 循环（4 击回 single）。

export type ClickKind = 'single' | 'double' | 'triple';

export interface ClickState {
  lastButton: number;
  lastRow: number;
  lastCol: number;
  lastTime: number;
  count: number; // 当前连续击数（1,2,3）
}

/** 双击间隔阈值（ms）—— 等于 300ms（VSCode/Terminal 默认） */
export const DOUBLE_CLICK_MS = 300;
/** 同位置允许的像素抖动（col/row 偏差 ≤ 此值算同位置） */
export const CLICK_SLOP = 2;

/**
 * 喂入一次 mousedown，返回这次属于第几击 + 更新后的 state。
 * @param state    上一次的状态（首次传 null）
 * @param button   SGR button 码（0=左键 2=右键）
 * @param row      1-origin 行（仅用于比较，不转换）
 * @param col      1-origin 列
 * @param now      当前时间戳（ms）
 */
export function classifyClick(
  state: ClickState | null,
  button: number,
  row: number,
  col: number,
  now: number,
): { kind: ClickKind; state: ClickState } {
  const isContinuation =
    state !== null
    && state.lastButton === button
    && Math.abs(row - state.lastRow) <= CLICK_SLOP
    && Math.abs(col - state.lastCol) <= CLICK_SLOP
    && (now - state.lastTime) <= DOUBLE_CLICK_MS;

  const count = isContinuation ? (state!.count % 3) + 1 : 1;
  const kind: ClickKind = count === 2 ? 'double' : count === 3 ? 'triple' : 'single';
  return {
    kind,
    state: { lastButton: button, lastRow: row, lastCol: col, lastTime: now, count },
  };
}
