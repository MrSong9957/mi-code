// src/__tests__/tui/spinner-store.test.ts
// spinner-store：start/stop/setMode/tick/onToken + 3s stall 检测
//
// 改造后（对标 Claude Code 四套动画）：
// - frameIndex → time（累计 ms，tick +50），符号帧由渲染层 floor(time/120)%12 派生
// - label → mode（thinking/generating/tool，决定配色）+ verb（随机动词）+ label（工具覆盖）
// - SPINNER_FRAMES 换 Claude Code 序列 ['·','✢','✳','✶','✻','✽'] + 反向 = 12 帧

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSpinnerStore, SPINNER_FRAMES, TICK_MS } from '../../tui/state/spinner-store.js';
import { SPINNER_VERBS } from '../../tui/state/spinner-verbs.js';

describe('spinner-store', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('初始：inactive，time=0，无 verb', () => {
    const s = createSpinnerStore();
    const st = s.getState();
    expect(st.active).toBe(false);
    expect(st.time).toBe(0);
    expect(st.mode).toBe('generating');
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

  it('start(generating)：thinkStartTime=null（非 thinking 模式）', () => {
    const s = createSpinnerStore();
    s.getState().start('generating');
    expect(s.getState().thinkStartTime).toBeNull();
  });

  it('tick：time 每次 +TICK_MS', () => {
    const s = createSpinnerStore();
    s.getState().start('generating');
    s.getState().tick();
    expect(s.getState().time).toBe(TICK_MS);
    s.getState().tick();
    expect(s.getState().time).toBe(TICK_MS * 2);
  });

  it('setMode：运行中切换模式（thinking→generating 清 thinkStartTime）', () => {
    const s = createSpinnerStore();
    s.getState().start('thinking');
    expect(s.getState().thinkStartTime).not.toBeNull();
    s.getState().setMode('generating');
    expect(s.getState().mode).toBe('generating');
    expect(s.getState().thinkStartTime).toBeNull();
    expect(s.getState().active).toBe(true);
  });

  it('setMode：切到 thinking 时记录当前 tick 值作为 thinkStartTime', () => {
    const s = createSpinnerStore();
    s.getState().start('generating');
    s.getState().tick(); // time=50
    s.getState().tick(); // time=100
    s.getState().setMode('thinking');
    expect(s.getState().mode).toBe('thinking');
    expect(s.getState().thinkStartTime).toBe(100);
  });

  it('setLabel：工具模式覆盖显示文字', () => {
    const s = createSpinnerStore();
    s.getState().start('generating');
    s.getState().setLabel('Running bash');
    expect(s.getState().label).toBe('Running bash');
    expect(s.getState().active).toBe(true);
  });

  it('stop：active=false，清 label/verb', () => {
    const s = createSpinnerStore();
    s.getState().start('generating');
    s.getState().stop();
    expect(s.getState().active).toBe(false);
    expect(s.getState().label).toBe('');
    expect(s.getState().verb).toBe('');
  });

  it('onToken：刷新 lastTokenAt，清 stalled', () => {
    const s = createSpinnerStore();
    s.getState().start('generating');
    vi.setSystemTime(4000);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);
    vi.setSystemTime(4001);
    s.getState().onToken();
    expect(s.getState().stalled).toBe(false);
    expect(s.getState().lastTokenAt).toBe(4001);
  });

  it('stall 阈值=3000ms：2999ms 不 stall，3001ms stall', () => {
    const s = createSpinnerStore();
    s.getState().start('generating');
    vi.setSystemTime(2999);
    s.getState().tick();
    expect(s.getState().stalled).toBe(false);
    vi.setSystemTime(3001);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);
  });

  it('stop 后 tick 不再推进 time（防御）', () => {
    const s = createSpinnerStore();
    s.getState().start('generating');
    s.getState().tick();
    s.getState().stop();
    // stop 重置 time=0；之后 tick 应 no-op（time 停在 0，不推进）
    expect(s.getState().time).toBe(0);
    s.getState().tick();
    expect(s.getState().time).toBe(0);
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
});
