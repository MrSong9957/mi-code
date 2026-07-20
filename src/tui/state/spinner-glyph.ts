import { spinnerFrameAt } from './spinner-store.js';

export interface SpinnerRGB {
  r: number;
  g: number;
  b: number;
}

/** Claude Code stalled 动画的目标红色。 */
export const SPINNER_STALLED_RGB: SpinnerRGB = { r: 171, g: 43, b: 63 };
export const REDUCED_MOTION_PERIOD_MS = 2_000;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 在两种 RGB 颜色之间做线性插值。 */
export function interpolateSpinnerColor(a: SpinnerRGB, b: SpinnerRGB, t: number): SpinnerRGB {
  const amount = clamp01(t);
  return {
    r: Math.round(a.r + (b.r - a.r) * amount),
    g: Math.round(a.g + (b.g - a.g) * amount),
    b: Math.round(a.b + (b.b - a.b) * amount),
  };
}

/** 解析主题中的 rgb(r,g,b) 字符串。无法解析时返回 null。 */
export function parseSpinnerColor(color: string): SpinnerRGB | null {
  const match = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

export function formatSpinnerColor(color: SpinnerRGB): string {
  return `rgb(${color.r},${color.g},${color.b})`;
}

/** 根据 stalledIntensity 计算 SpinnerGlyph 颜色。 */
export function spinnerGlyphColor(activeColor: string, stalledIntensity: number): string {
  const active = parseSpinnerColor(activeColor);
  if (!active) return activeColor;
  return formatSpinnerColor(interpolateSpinnerColor(active, SPINNER_STALLED_RGB, stalledIntensity));
}

export function spinnerGlyphColorAt(
  activeColor: string,
  stalledIntensity: number,
  reducedMotion: boolean,
  timeMs: number,
): string {
  const color = spinnerGlyphColor(activeColor, stalledIntensity);
  return reducedMotion ? reducedMotionColor(color, timeMs) : color;
}

/** reducedMotion 下每 2 秒在亮/暗两档之间切换。 */
export function reducedMotionColor(color: string, timeMs: number): string {
  const parsed = parseSpinnerColor(color);
  if (!parsed) return color;
  const isDim = Math.floor(Math.max(0, timeMs) / REDUCED_MOTION_PERIOD_MS) % 2 === 1;
  return formatSpinnerColor(isDim ? interpolateSpinnerColor(parsed, { r: 0, g: 0, b: 0 }, 0.45) : parsed);
}

/** 返回 SpinnerGlyph 的两字符宽文本（符号 + 尾随空格）。 */
export function spinnerGlyphTextAt(timeMs: number, reducedMotion: boolean): string {
  return `${reducedMotion ? '●' : spinnerFrameAt(timeMs)} `;
}
