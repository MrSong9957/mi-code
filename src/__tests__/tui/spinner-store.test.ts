// src/__tests__/tui/spinner-store.test.ts
// spinner-store：start/stop/setLabel/tick/onToken + 3s stall 检测

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';

describe('spinner-store', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('初始：inactive，frame=0，无 label', () => {
    const s = createSpinnerStore();
    const st = s.getState();
    expect(st.active).toBe(false);
    expect(st.frameIndex).toBe(0);
    expect(st.label).toBe('');
    expect(st.stalled).toBe(false);
  });

  it('start(label)：active=true，记录 label 与 lastTokenAt', () => {
    const s = createSpinnerStore();
    s.getState().start('Thinking…');
    const st = s.getState();
    expect(st.active).toBe(true);
    expect(st.label).toBe('Thinking…');
    expect(st.lastTokenAt).toBe(0);
  });

  it('tick：frameIndex 在 0..9 循环', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    for (let i = 0; i < 12; i++) s.getState().tick();
    // 12 % 10 = 2
    expect(s.getState().frameIndex).toBe(2);
  });

  it('setLabel：运行中改文案', () => {
    const s = createSpinnerStore();
    s.getState().start('Thinking…');
    s.getState().setLabel('Running bash');
    expect(s.getState().label).toBe('Running bash');
    expect(s.getState().active).toBe(true);
  });

  it('stop：active=false，清 label', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    s.getState().stop();
    expect(s.getState().active).toBe(false);
    expect(s.getState().label).toBe('');
  });

  it('onToken：刷新 lastTokenAt，清 stalled', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    // 模拟 4s 后 tick → stalled=true
    vi.setSystemTime(4000);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);
    // 收到 token → 清 stalled，刷新时间
    vi.setSystemTime(4001);
    s.getState().onToken();
    expect(s.getState().stalled).toBe(false);
    expect(s.getState().lastTokenAt).toBe(4001);
  });

  it('stall 阈值=3000ms：2999ms 不 stall，3001ms stall', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    vi.setSystemTime(2999);
    s.getState().tick();
    expect(s.getState().stalled).toBe(false);
    vi.setSystemTime(3001);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);
  });

  it('stop 后 tick 不再推进 frame（防御）', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    s.getState().tick();
    const f = s.getState().frameIndex;
    s.getState().stop();
    s.getState().tick();
    expect(s.getState().frameIndex).toBe(f);
  });
});
