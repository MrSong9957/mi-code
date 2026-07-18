import { describe, expect, it } from 'vitest';
import { formatSpinnerMetrics } from '../../tui/state/spinner-metrics.js';

describe('formatSpinnerMetrics — Claude Code 样式', () => {
  // 期望格式：(duration · arrow tokens tokens)
  // - 整体用括号包裹
  // - duration 用 formatSpinnerDuration 输出（1s/5s/1m/1m 30s）
  // - arrow: requesting → ↑, 其他 → ↓
  // - tokens 后跟 "tokens" 单位词
  // - duration 与 token 段之间用 " · "（U+00B7 中点）分隔
  it('有时长和 token 时输出 "(<dur> · <arrow> <n> tokens)"', () => {
    expect(formatSpinnerMetrics(23_000, 130, 6, 'responding'))
      .toBe('(23s · ↓ 136 tokens)');
    expect(formatSpinnerMetrics(5_000, 200, 0, 'requesting'))
      .toBe('(5s · ↑ 200 tokens)');
  });

  it('无 token 时只输出 "(<dur>)"，不含中点和箭头', () => {
    expect(formatSpinnerMetrics(5_000, 0, 0, 'responding')).toBe('(5s)');
    expect(formatSpinnerMetrics(0, 0, 0, 'requesting')).toBe('(1s)');
  });

  it('分钟级时长沿用 formatSpinnerDuration 格式', () => {
    expect(formatSpinnerMetrics(90_000, 0, 0, 'responding')).toBe('(1m 30s)');
    expect(formatSpinnerMetrics(60_000, 0, 0, 'responding')).toBe('(1m)');
  });

  it('mode 决定箭头方向：requesting→↑, 其他（responding/thinking/tool-use/tool-input）→↓', () => {
    expect(formatSpinnerMetrics(5_000, 100, 0, 'requesting')).toContain('↑');
    expect(formatSpinnerMetrics(5_000, 100, 0, 'responding')).toContain('↓');
    expect(formatSpinnerMetrics(5_000, 100, 0, 'thinking')).toContain('↓');
    expect(formatSpinnerMetrics(5_000, 100, 0, 'tool-use')).toContain('↓');
    expect(formatSpinnerMetrics(5_000, 100, 0, 'tool-input')).toContain('↓');
  });

  it('leader + teammate token 汇总后输出', () => {
    expect(formatSpinnerMetrics(5_000, 100, 50, 'responding'))
      .toBe('(5s · ↓ 150 tokens)');
  });

  it('负值/NaN 防御：token 钳为 0，时长走 formatSpinnerDuration 钳位', () => {
    expect(formatSpinnerMetrics(-500, -10, NaN, 'responding')).toBe('(1s)');
    expect(formatSpinnerMetrics(5_000, NaN, NaN, 'responding')).toBe('(5s)');
  });
});
