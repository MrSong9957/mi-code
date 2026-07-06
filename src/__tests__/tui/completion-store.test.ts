// src/__tests__/tui/completion-store.test.ts
// completion-store：候选 + 当前 index + visible + cycle

import { describe, it, expect } from 'vitest';
import { createCompletionStore } from '../../tui/state/completion-store.js';

describe('completion-store', () => {
  it('初始：无候选，visible=false', () => {
    const s = createCompletionStore();
    const st = s.getState();
    expect(st.candidates).toEqual([]);
    expect(st.index).toBe(0);
    expect(st.visible).toBe(false);
  });

  it('setCandidates：设置候选并 visible=true', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['plan', 'provider']);
    const st = s.getState();
    expect(st.candidates).toEqual(['plan', 'provider']);
    expect(st.visible).toBe(true);
    expect(st.index).toBe(0);
  });

  it('setCandidates 空数组：visible=false', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['plan']);
    s.getState().setCandidates([]);
    expect(s.getState().visible).toBe(false);
    expect(s.getState().candidates).toEqual([]);
  });

  it('cycle：index 在候选内循环', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['a', 'b', 'c']);
    s.getState().cycle(); // 0→1
    expect(s.getState().index).toBe(1);
    s.getState().cycle(); // 1→2
    s.getState().cycle(); // 2→0（wrap）
    expect(s.getState().index).toBe(0);
  });

  it('hide：visible=false，重置 index', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['a', 'b']);
    s.getState().cycle();
    s.getState().hide();
    expect(s.getState().visible).toBe(false);
    expect(s.getState().index).toBe(0);
  });

  it('selected：当前选中的候选名', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['plan', 'provider']);
    expect(s.getState().selected()).toBe('plan');
    s.getState().cycle();
    expect(s.getState().selected()).toBe('provider');
  });

  it('selected 无候选返回 null', () => {
    const s = createCompletionStore();
    expect(s.getState().selected()).toBeNull();
  });
});
