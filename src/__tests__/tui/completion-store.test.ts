// src/__tests__/tui/completion-store.test.ts
// completion-store：候选 + 当前 index + visible + cycle

import { describe, it, expect } from 'vitest';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { COMMAND_SUGGESTIONS, type SuggestionItem } from '../../commands/suggestion-data.js';

/** 从 COMMAND_SUGGESTIONS 中按名字取子集（保持原顺序） */
function subset(names: string[]): SuggestionItem[] {
  return COMMAND_SUGGESTIONS.filter(s => names.includes(s.name));
}

/** 构造最小 SuggestionItem（用于只需要数量的测试,如 cycle） */
function items(names: string[]): SuggestionItem[] {
  return names.map(name => ({ name, description: '', group: 'Session' }));
}

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
    const cs = subset(['plan', 'provider']);
    s.getState().setCandidates(cs);
    const st = s.getState();
    expect(st.candidates).toEqual(cs);
    expect(st.visible).toBe(true);
    expect(st.index).toBe(0);
  });

  it('setCandidates 空数组：visible=false', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(subset(['plan']));
    s.getState().setCandidates([]);
    expect(s.getState().visible).toBe(false);
    expect(s.getState().candidates).toEqual([]);
  });

  it('cycle：index 在候选内循环', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(items(['a', 'b', 'c']));
    s.getState().cycle(); // 0→1
    expect(s.getState().index).toBe(1);
    s.getState().cycle(); // 1→2
    s.getState().cycle(); // 2→0（wrap）
    expect(s.getState().index).toBe(0);
  });

  it('hide：visible=false，重置 index', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(items(['a', 'b']));
    s.getState().cycle();
    s.getState().hide();
    expect(s.getState().visible).toBe(false);
    expect(s.getState().index).toBe(0);
  });

  it('selected：当前选中的候选名', () => {
    const s = createCompletionStore();
    // subset 按 COMMAND_SUGGESTIONS 原顺序返回（provider 在 plan 之前）
    const cs = subset(['plan', 'provider']);
    s.getState().setCandidates(cs);
    expect(s.getState().selected()).toBe(cs[0]!.name);
    s.getState().cycle();
    expect(s.getState().selected()).toBe(cs[1]!.name);
  });

  it('selected 无候选返回 null', () => {
    const s = createCompletionStore();
    expect(s.getState().selected()).toBeNull();
  });
});
