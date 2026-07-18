// src/__tests__/tui/spinner-store.test.ts
// spinner-store：start/stop/setMode/tick/onToken + 3s stall 检测
//
// 改造后（对标 Claude Code 四套动画）：
// - frameIndex → time（累计 ms，tick +50），符号帧由渲染层 floor(time/120)%12 派生
// - label → mode（thinking/generating/tool，决定配色）+ verb（随机动词）+ label（工具覆盖）
// - SPINNER_FRAMES 换 Claude Code 序列 ['·','✢','✳','✶','✻','✽'] + 反向 = 12 帧

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSpinnerStore,
  advanceSpinnerTokenCounter,
  estimateSpinnerTokens,
  formatSpinnerDuration,
  SPINNER_FRAMES,
  TICK_MS,
  SPINNER_FRAME_MS,
  spinnerFrameAt,
  shouldShowSpinnerTimer,
  thinkingColorAt,
  thinkingStatusText,
  totalSpinnerTokens,
} from '../../tui/state/spinner-store.js';
import { TURN_COMPLETION_VERBS } from '../../tui/state/turn-duration-message.js';
import { SPINNER_VERBS } from '../../tui/state/spinner-verbs.js';

describe('spinner-store', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('初始：inactive，time=0，无 verb', () => {
    const s = createSpinnerStore();
    const st = s.getState();
    expect(st.active).toBe(false);
    expect(st.time).toBe(0);
    expect(st.mode).toBe('responding');
    expect(st.verb).toBe('');
    expect(st.label).toBe('');
    expect(st.stalled).toBe(false);
  });

  it('start(mode)：active=true，time 重置 0，选 verb', () => {
    const s = createSpinnerStore();
    s.getState().start('thinking');
    const st = s.getState();
    expect(st.active).toBe(true);
    expect(st.time).toBe(0);
    expect(st.mode).toBe('thinking');
    expect(st.thinkStartTime).toBe(0);  // thinking 模式记录开始时刻
    expect(SPINNER_VERBS).toContain(st.verb);
    expect(st.lastTokenAt).toBe(0);
  });

  it('start(responding)：thinkStartTime=null（非 thinking 模式）', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    expect(s.getState().thinkStartTime).toBeNull();
  });

  it('start：使用传入的 replace 动词配置，并在 mode 切换时保持不变', () => {
    const s = createSpinnerStore({ mode: 'replace', verbs: ['Customizing', 'Reasoning'] });
    s.getState().start('responding');
    expect(['Customizing', 'Reasoning']).toContain(s.getState().verb);
    s.getState().setMode('thinking');
    expect(['Customizing', 'Reasoning']).toContain(s.getState().verb);
  });

  it('tick：时间由同一个单调时钟派生', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    vi.advanceTimersByTime(TICK_MS);
    s.getState().tick();
    expect(s.getState().time).toBe(TICK_MS);
    vi.advanceTimersByTime(TICK_MS);
    s.getState().tick();
    expect(s.getState().time).toBe(TICK_MS * 2);
  });

  it('setMode：运行中切换模式（thinking→responding 清 thinkStartTime）', () => {
    const s = createSpinnerStore();
    s.getState().start('thinking');
    expect(s.getState().thinkStartTime).not.toBeNull();
    s.getState().setMode('responding');
    expect(s.getState().mode).toBe('responding');
    expect(s.getState().thinkStartTime).toBeNull();
    expect(s.getState().active).toBe(true);
  });

  it('setMode：切到 thinking 时记录当前 tick 值作为 thinkStartTime', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    vi.advanceTimersByTime(100);
    s.getState().tick(); // time=50
    s.getState().tick(); // time=100
    s.getState().setMode('thinking');
    expect(s.getState().mode).toBe('thinking');
    expect(s.getState().thinkStartTime).toBe(100);
  });

  it('thinking 状态携带 effort，重复设置 thinking 不重置开始时间', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    s.getState().setThinkingEffort('hard');
    vi.setSystemTime(100);
    s.getState().tick();
    s.getState().setMode('thinking');
    expect(s.getState().thinkStartTime).toBe(100);
    expect(thinkingStatusText(s.getState().thinkingEffort)).toBe('thinking hard');

    vi.setSystemTime(1_100);
    s.getState().tick();
    s.getState().setMode('thinking');
    expect(s.getState().thinkStartTime).toBe(100);
  });

  it('退出 thinking 后记录耗时，摘要至少显示 2 秒后才清除', () => {
    const s = createSpinnerStore();
    s.getState().start('thinking');
    vi.setSystemTime(4_000);
    s.getState().tick();
    s.getState().setMode('responding');

    expect(s.getState().thinkingSummary).toEqual({
      durationMs: 4_000,
      visibleUntil: 6_000,
    });

    vi.setSystemTime(5_999);
    s.getState().tick();
    expect(s.getState().thinkingSummary).not.toBeNull();

    vi.setSystemTime(6_000);
    s.getState().tick();
    expect(s.getState().thinkingSummary).toBeNull();
  });

  it('thinking 灰色呼吸延迟 3 秒，周期为 2 秒', () => {
    expect(thinkingColorAt(2_999, 0)).toEqual({ r: 153, g: 153, b: 153 });
    expect(thinkingColorAt(3_500, 0)).toEqual({ r: 185, g: 185, b: 185 });
    expect(thinkingColorAt(4_500, 0)).toEqual({ r: 153, g: 153, b: 153 });
    expect(thinkingColorAt(5_500, 0)).toEqual({ r: 185, g: 185, b: 185 });
  });

  it('setLabel：工具模式覆盖显示文字', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    s.getState().setLabel('Running bash');
    expect(s.getState().label).toBe('Running bash');
    expect(s.getState().active).toBe(true);
  });

  it('stop：active=false，清 label/verb', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    s.getState().stop();
    expect(s.getState().active).toBe(false);
    expect(s.getState().label).toBe('');
    expect(s.getState().verb).toBe('');
  });

  it('stop 只返回有效时长，完成动词由消息工厂负责且重复 stop 幂等', () => {
    const random = vi.spyOn(Math, 'random');
    try {
      const store = createSpinnerStore();
      store.getState().start('responding');
      const callsAfterStart = random.mock.calls.length;
      vi.advanceTimersByTime(2_000);

      expect(store.getState().stop()).toEqual({ durationMs: 2_000 });
      expect(store.getState().stop()).toBeNull();
      expect(random).toHaveBeenCalledTimes(callsAfterStart);
    } finally {
      random.mockRestore();
    }
  });

  it('onToken：刷新 lastTokenAt，清 stalled', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    vi.setSystemTime(4000);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);
    vi.setSystemTime(4001);
    s.getState().onToken(1);
    expect(s.getState().stalled).toBe(false);
    expect(s.getState().lastTokenAt).toBe(4001);
  });

  it('responseLength 未增长不重置 lastTokenAt，增长后才重置', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    vi.setSystemTime(4000);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);

    s.getState().onToken(0);
    expect(s.getState().lastTokenAt).toBe(0);
    expect(s.getState().stalled).toBe(true);

    s.getState().onToken(4);
    expect(s.getState().lastTokenAt).toBe(4000);
    expect(s.getState().responseLength).toBe(4);
    expect(s.getState().stalled).toBe(false);
  });

  it('活跃工具期间不 stalled，工具结束后重新等待 3 秒', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    s.getState().setHasActiveTools(true);
    vi.setSystemTime(10000);
    s.getState().tick();
    expect(s.getState().stalled).toBe(false);
    expect(s.getState().stalledIntensity).toBe(0);

    s.getState().setHasActiveTools(false);
    vi.setSystemTime(12999);
    s.getState().tick();
    expect(s.getState().stalled).toBe(false);
    vi.setSystemTime(13001);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);
  });

  it('3-5 秒线性目标每 tick 以 diff * 0.1 平滑追赶', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    vi.setSystemTime(4000); // target=(4000-3000)/2000=0.5
    s.getState().tick();
    expect(s.getState().stalledIntensity).toBeCloseTo(0.05);

    vi.setSystemTime(5000); // target=1; 0.05 + (1-0.05)*0.1
    s.getState().tick();
    expect(s.getState().stalledIntensity).toBeCloseTo(0.145);

    vi.setSystemTime(5001);
    s.getState().onToken(1);
    s.getState().tick(); // target=0; 平滑恢复，不直接跳零
    expect(s.getState().stalled).toBe(false);
    expect(s.getState().stalledIntensity).toBeCloseTo(0.1305);
  });

  it('stall 阈值=3000ms：2999ms 不 stall，3001ms stall', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    vi.setSystemTime(2999);
    s.getState().tick();
    expect(s.getState().stalled).toBe(false);
    vi.setSystemTime(3001);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);
  });

  it('stop 后 tick 不再推进 time（防御）', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    s.getState().tick();
    s.getState().stop();
    // stop 重置 time=0；之后 tick 应 no-op（time 停在 0，不推进）
    expect(s.getState().time).toBe(0);
    s.getState().tick();
    expect(s.getState().time).toBe(0);
  });

  it('流式字符数平滑为 token，并在结束时生成静态完成记录', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    s.getState().onToken(400); // 粗估 100 tokens
    vi.advanceTimersByTime(TICK_MS);
    s.getState().tick();
    expect(s.getState().displayedTokens).toBe(15);
    vi.advanceTimersByTime(1_950);
    const completion = s.getState().stop();
    expect(completion?.durationMs).toBe(2_000);
    expect(formatSpinnerDuration(completion?.durationMs ?? 0)).toBe('2s');
  });

  it('按字符数除以 4 估算 leader token', () => {
    expect(estimateSpinnerTokens(0)).toBe(0);
    expect(estimateSpinnerTokens(399)).toBe(100);
    expect(estimateSpinnerTokens(400)).toBe(100);
  });

  it('按 <70、<200、>=200 三档平滑追赶且不越过目标', () => {
    expect(advanceSpinnerTokenCounter(0, 276)).toBe(3);   // target=69
    expect(advanceSpinnerTokenCounter(0, 280)).toBe(11);  // target=70, ceil(15%)
    expect(advanceSpinnerTokenCounter(0, 800)).toBe(50);  // target=200
    expect(advanceSpinnerTokenCounter(68, 276)).toBe(69); // 差 1，不越界
  });

  it('总 token 累加 leader 平滑值与 teammate token', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    s.getState().onToken(400);
    s.getState().setTeammateTokens(40);
    s.getState().tick();
    expect(s.getState().displayedTokens).toBe(15);
    expect(totalSpinnerTokens(s.getState().displayedTokens, s.getState().teammateTokens)).toBe(55);
  });

  it('暂停期间冻结 elapsedTime，恢复后排除累计暂停时长', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    vi.advanceTimersByTime(5_000);
    s.getState().tick();
    s.getState().pause();

    vi.advanceTimersByTime(10_000);
    s.getState().tick();
    expect(s.getState().time).toBe(5_000);
    expect(s.getState().pauseStartTime).toBe(5_000);

    s.getState().resume();
    vi.advanceTimersByTime(2_000);
    s.getState().tick();
    expect(s.getState().time).toBe(7_000);
    expect(s.getState().totalPausedMs).toBe(10_000);
    expect(s.getState().pauseStartTime).toBeNull();
  });

  it('暂停状态下 stop 使用冻结后的有效时长', () => {
    const s = createSpinnerStore();
    s.getState().start('responding');
    vi.advanceTimersByTime(5_000);
    s.getState().pause();
    vi.advanceTimersByTime(10_000);
    expect(s.getState().stop()?.durationMs).toBe(5_000);
  });

  it('计时器在 verbose、活跃 teammate 或满 30 秒时显示', () => {
    expect(shouldShowSpinnerTimer(29_999, false, 0)).toBe(false);
    expect(shouldShowSpinnerTimer(30_000, false, 0)).toBe(true);
    expect(shouldShowSpinnerTimer(0, true, 0)).toBe(true);
    expect(shouldShowSpinnerTimer(0, false, 1)).toBe(true);
  });

  it('格式化秒和分钟时长', () => {
    expect(formatSpinnerDuration(39_000)).toBe('39s');
    expect(formatSpinnerDuration(78_000)).toBe('1m 18s');
  });
});

describe('SPINNER_FRAMES：Claude Code 符号序列', () => {
  it('12 帧（6 正向 + 6 反向）', () => {
    expect(SPINNER_FRAMES).toHaveLength(12);
  });

  it('前 6 帧是 Claude Code 序列', () => {
    expect([...SPINNER_FRAMES.slice(0, 6)]).toEqual(['·', '✢', '✳', '✶', '✻', '✽']);
  });

  it('后 6 帧是前 6 帧的反向', () => {
    const first6 = [...SPINNER_FRAMES.slice(0, 6)];
    const last6 = [...SPINNER_FRAMES.slice(6)];
    expect(last6).toEqual([...first6].reverse());
  });

  it('统一由时间推导帧，120ms 切换且循环', () => {
    expect(spinnerFrameAt(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrameAt(SPINNER_FRAME_MS - 1)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrameAt(SPINNER_FRAME_MS)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrameAt(SPINNER_FRAME_MS * SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
  });

  it('导出固定的 8 个完成动词', () => {
    expect(TURN_COMPLETION_VERBS).toEqual([
      'Baked', 'Brewed', 'Churned', 'Cogitated',
      'Cooked', 'Crunched', 'Sautéed', 'Worked',
    ]);
  });
});
