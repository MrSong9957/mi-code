// 单测：frame-scheduler.ts —— 帧调度器
//
// 物理本质：红绿灯调度员。
// 多个写屏源（按键、流式 token、spinner tick、状态变化）都来敲门"我要刷一帧"，
// 调度员不立刻开门，而是攒着——每隔 intervalMs 开一次门，把攒的这一批一次性放行。
// 没人敲门时调度员下班（stop），省 CPU；下次有人敲门再上班。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FrameScheduler } from '../renderer/frame-scheduler.js';

describe('FrameScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requestFrame 标记脏，下次 tick 触发一次 flushFn', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80);

    sched.requestFrame();
    expect(flushFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('多次 requestFrame 在一个 interval 内只触发一次 flushFn（合并）', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80);

    sched.requestFrame();
    sched.requestFrame();
    sched.requestFrame();
    sched.requestFrame();

    vi.advanceTimersByTime(80);
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('连续 requestFrame 跨多个 interval，每 interval 至多一次 flush', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80);

    sched.requestFrame();
    vi.advanceTimersByTime(80);  // 第 1 次 flush
    sched.requestFrame();
    vi.advanceTimersByTime(80);  // 第 2 次 flush

    expect(flushFn).toHaveBeenCalledTimes(2);
  });

  it('idle 检测：连续 interval 无 requestFrame → 自动 stop（省 CPU）', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80, { idleStopIntervals: 2 });

    sched.requestFrame();
    // 第 1 个 interval：flush + dirty 清零
    vi.advanceTimersByTime(80);
    expect(flushFn).toHaveBeenCalledTimes(1);
    // 第 2、3 个 interval：无新 requestFrame，idle 计数累积，达到 idleStopIntervals 后 stop
    vi.advanceTimersByTime(80);  // idle 1
    vi.advanceTimersByTime(80);  // idle 2 → stop
    expect(flushFn).toHaveBeenCalledTimes(1);  // 没有额外 flush

    // stop 后再 advance，确认定时器已清（不会触发 flush）
    vi.advanceTimersByTime(320);
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('idle 后再次 requestFrame 能重新启动调度器', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80, { idleStopIntervals: 2 });

    sched.requestFrame();
    vi.advanceTimersByTime(80);  // flush
    vi.advanceTimersByTime(240); // idle → stop（3 个 interval）

    // 重新启动
    sched.requestFrame();
    vi.advanceTimersByTime(80);
    expect(flushFn).toHaveBeenCalledTimes(2);
  });

  it('flushNow 立即调用 flushFn 且清脏标记（绕过调度）', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80);

    sched.requestFrame();
    sched.flushNow();  // 立即 flush
    expect(flushFn).toHaveBeenCalledTimes(1);

    // 下一 interval 不应再 flush（脏标记已清）
    vi.advanceTimersByTime(80);
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('flushNow 无脏标记时也调用 flushFn（用于 enter/exit 必须强制 flush）', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80);

    sched.flushNow();
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('stop 后 isRunning=false；requestFrame 能重新启动（与 idle 重启一致）', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80);

    sched.stop();
    expect(sched.isRunning).toBe(false);

    // stop 后 requestFrame 应能重新启动（健壮性：stop 主要用于 destroy 清理，
    // 若之后还有 requestFrame 说明仍在使用，应能恢复）
    sched.requestFrame();
    expect(sched.isRunning).toBe(true);
    vi.advanceTimersByTime(80);
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('isRunning 反映调度器状态', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80);

    expect(sched.isRunning).toBe(false);
    sched.requestFrame();
    expect(sched.isRunning).toBe(true);
    sched.stop();
    expect(sched.isRunning).toBe(false);
  });

  it('stop 是幂等的', () => {
    const flushFn = vi.fn();
    const sched = new FrameScheduler(flushFn, 80);

    sched.stop();
    sched.stop();  // 不抛错
    expect(sched.isRunning).toBe(false);
  });

  it('intervalMs=0 时使用默认值（不除零）', () => {
    const flushFn = vi.fn();
    // intervalMs=0 视为非法，回退到默认 80
    const sched = new FrameScheduler(flushFn, 0);

    sched.requestFrame();
    vi.advanceTimersByTime(80);
    // 只要不崩、能 flush 即可
    expect(flushFn).toHaveBeenCalledTimes(1);
  });
});
