// @vitest-environment jsdom
// useThrottledStreamingText hook 测试（第四层：渲染节流）
//
// 对标 Claude Code 机制四（Ink 16ms throttle + React automatic batching）：
// 多个 token 在 cooldown 窗口内被合并，只 flush 最新值到消费者。
//
// 测试策略：vi.useFakeTimers() 精确控制时间推进，renderHook + rerender 驱动。
//
// flush 规则（leading + trailing）：
// - 非 cooldown：leading 立即 flush + 开 32ms cooldown
// - cooldown 中：吞中间值，cooldown 结束时 trailing flush 最新值
// - finalize（undefined）：立即同步 + 清 timer
// - 值未变（spinner tick 等重跑）：no-op

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThrottledStreamingText, THROTTLE_MS } from './use-throttled-streaming-text.js';

describe('useThrottledStreamingText：leading + trailing 节流', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leading edge：undefined → 值 立即 flush（advance 0ms）', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useThrottledStreamingText(text),
      { initialProps: { text: undefined as string | undefined } },
    );
    expect(result.current).toBeUndefined();

    // 推第一个值 → leading 立即 flush
    rerender({ text: 'A' });
    act(() => { vi.advanceTimersByTime(0); });
    expect(result.current).toBe('A');
  });

  it('cooldown 吞中间值：32ms 内推多个值，throttled 仍是 leading 值', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useThrottledStreamingText(text),
      { initialProps: { text: undefined as string | undefined } },
    );

    // leading flush 'A'
    rerender({ text: 'A' });
    act(() => { vi.advanceTimersByTime(0); });
    expect(result.current).toBe('A');

    // +10ms 推 'B' → cooldown 中，吞
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ text: 'B' });
    act(() => { vi.advanceTimersByTime(0); });
    expect(result.current).toBe('A');

    // +10ms（累计 20ms）推 'C' → 仍 cooldown，吞
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ text: 'C' });
    act(() => { vi.advanceTimersByTime(0); });
    expect(result.current).toBe('A');
  });

  it('trailing flush：cooldown 结束时 flush 最新值', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useThrottledStreamingText(text),
      { initialProps: { text: undefined as string | undefined } },
    );

    rerender({ text: 'A' });
    act(() => { vi.advanceTimersByTime(0); });

    // cooldown 中推 B、C
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ text: 'B' });
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ text: 'C' });
    expect(result.current).toBe('A');

    // 推进到 cooldown 结束（trailing flush）
    act(() => { vi.advanceTimersByTime(THROTTLE_MS); });
    expect(result.current).toBe('C');
  });

  it('新 cooldown 周期：trailing flush 后推新值 → 新 leading 立即 flush', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useThrottledStreamingText(text),
      { initialProps: { text: undefined as string | undefined } },
    );

    // 第一轮：A → flush → cooldown → trailing flush C
    rerender({ text: 'A' });
    act(() => { vi.advanceTimersByTime(0); });
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ text: 'C' });
    act(() => { vi.advanceTimersByTime(THROTTLE_MS); });
    expect(result.current).toBe('C');

    // 第二轮：推 D → 新 leading（cooldown 已结束）
    rerender({ text: 'D' });
    act(() => { vi.advanceTimersByTime(0); });
    expect(result.current).toBe('D');
  });

  it('finalize（undefined）立即同步，不需 advance', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useThrottledStreamingText(text),
      { initialProps: { text: undefined as string | undefined } },
    );

    rerender({ text: 'A' });
    act(() => { vi.advanceTimersByTime(0); });

    // cooldown 中推 B → 吞
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ text: 'B' });

    // finalize → 立即 undefined（不 advance）
    rerender({ text: undefined });
    act(() => { vi.advanceTimersByTime(0); });
    expect(result.current).toBeUndefined();
  });

  it('finalize 清 timer：之后推新值走 leading（不被旧 timer 吞）', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useThrottledStreamingText(text),
      { initialProps: { text: undefined as string | undefined } },
    );

    rerender({ text: 'A' });
    act(() => { vi.advanceTimersByTime(0); });
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ text: 'B' });
    // finalize（清 timer）
    rerender({ text: undefined });
    act(() => { vi.advanceTimersByTime(0); });

    // 推新值 X → 应 leading 立即 flush（若有残留 timer 会走 trailing 被吞）
    rerender({ text: 'X' });
    act(() => { vi.advanceTimersByTime(0); });
    expect(result.current).toBe('X');
  });

  it('值未变 no-op：相同值重复 rerender，throttled 不变', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useThrottledStreamingText(text),
      { initialProps: { text: undefined as string | undefined } },
    );

    rerender({ text: 'A' });
    act(() => { vi.advanceTimersByTime(0); });
    expect(result.current).toBe('A');

    // cooldown 结束
    act(() => { vi.advanceTimersByTime(THROTTLE_MS); });

    // 再推相同值 → no-op（不会触发额外渲染或状态变化）
    rerender({ text: 'A' });
    act(() => { vi.advanceTimersByTime(THROTTLE_MS); });
    expect(result.current).toBe('A');
  });

  it('卸载清 timer：unmount 后无 pending timer 泄漏', () => {
    const { result, rerender, unmount } = renderHook(
      ({ text }) => useThrottledStreamingText(text),
      { initialProps: { text: undefined as string | undefined } },
    );

    rerender({ text: 'A' });
    act(() => { vi.advanceTimersByTime(0); });
    act(() => { vi.advanceTimersByTime(10); });
    rerender({ text: 'B' }); // cooldown 中，有 pending timer

    // unmount → cleanup 清 timer
    unmount();

    // 推进时间，不应抛错或触发任何副作用（timer 已清）
    expect(() => {
      act(() => { vi.advanceTimersByTime(THROTTLE_MS * 2); });
    }).not.toThrow();
    // result 仍是最后一次 flush 的值（A），未被 trailing 更新
    expect(result.current).toBe('A');
  });
});
