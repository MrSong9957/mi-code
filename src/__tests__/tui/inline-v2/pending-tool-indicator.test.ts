// src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts
//
// AUTO-0025-stable Task 1:验证 pending 工具的 600ms 闪烁纯函数。
//
// 物理本质:运行中的 spawn_agent 用闪烁的 ● 表示"我在干活"。
// 闪烁周期 600ms,所有 pending 工具复用同一 spinner 时钟,不各自建定时器。
// 这是纯函数(输入时间戳,输出可见性),便于单元测试锁定周期边界。

import { describe, expect, it } from 'vitest';
import { isPendingToolGlyphVisible, PENDING_TOOL_BLINK_INTERVAL_MS } from '../../../tui/inline-v2/pending-tool-indicator.js';

describe('isPendingToolGlyphVisible', () => {
  it('toggles every 600ms', () => {
    expect(isPendingToolGlyphVisible(0)).toBe(true);
    expect(isPendingToolGlyphVisible(599)).toBe(true);
    expect(isPendingToolGlyphVisible(600)).toBe(false);
    expect(isPendingToolGlyphVisible(1199)).toBe(false);
    expect(isPendingToolGlyphVisible(1200)).toBe(true);
  });

  it('默认间隔常量是 600ms', () => {
    expect(PENDING_TOOL_BLINK_INTERVAL_MS).toBe(600);
  });

  it('负数或非有限时间戳按 0 处理(始终落在首个可见窗口)', () => {
    expect(isPendingToolGlyphVisible(-1)).toBe(true);
    expect(isPendingToolGlyphVisible(Number.NaN)).toBe(true);
    expect(isPendingToolGlyphVisible(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('支持自定义间隔(便于测试加速)', () => {
    expect(isPendingToolGlyphVisible(0, 100)).toBe(true);
    expect(isPendingToolGlyphVisible(99, 100)).toBe(true);
    expect(isPendingToolGlyphVisible(100, 100)).toBe(false);
    expect(isPendingToolGlyphVisible(199, 100)).toBe(false);
    expect(isPendingToolGlyphVisible(200, 100)).toBe(true);
  });
});
