import { describe, expect, it } from 'vitest';
import {
  SPINNER_STALLED_RGB,
  interpolateSpinnerColor,
  reducedMotionColor,
  spinnerGlyphColor,
  spinnerGlyphTextAt,
} from './spinner-glyph.js';

describe('SpinnerGlyph', () => {
  it('按 120ms 从统一时间源切换帧，并保持两字符宽', () => {
    expect(spinnerGlyphTextAt(0, false)).toBe('· ');
    expect(spinnerGlyphTextAt(119, false)).toBe('· ');
    expect(spinnerGlyphTextAt(120, false)).toBe('✢ ');
  });

  it('reducedMotion 显示静态圆点，两字符宽', () => {
    expect(spinnerGlyphTextAt(0, true)).toBe('● ');
    expect(spinnerGlyphTextAt(1_999, true)).toBe('● ');
    expect(spinnerGlyphTextAt(2_000, true)).toBe('● ');
  });

  it('reducedMotion 每 2 秒切换一次亮暗颜色', () => {
    const active = 'rgb(100,200,240)';
    expect(reducedMotionColor(active, 0)).toBe(active);
    expect(reducedMotionColor(active, 1_999)).toBe(active);
    expect(reducedMotionColor(active, 2_000)).not.toBe(active);
    expect(reducedMotionColor(active, 4_000)).toBe(active);
  });

  it('stalledIntensity=0 保持主题色，=1 到达错误红', () => {
    const active = 'rgb(100,200,240)';
    expect(spinnerGlyphColor(active, 0)).toBe(active);
    expect(spinnerGlyphColor(active, 1)).toBe(
      `rgb(${SPINNER_STALLED_RGB.r},${SPINNER_STALLED_RGB.g},${SPINNER_STALLED_RGB.b})`,
    );
  });

  it('颜色插值支持中间强度', () => {
    expect(interpolateSpinnerColor(
      { r: 100, g: 200, b: 240 },
      SPINNER_STALLED_RGB,
      0.5,
    )).toEqual({ r: 136, g: 122, b: 152 });
  });
});
