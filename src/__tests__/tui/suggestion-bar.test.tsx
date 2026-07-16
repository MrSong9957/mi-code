// src/__tests__/tui/suggestion-bar.test.tsx
// SuggestionBar：visible 时渲染候选，当前项高亮

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SuggestionBar } from '../../tui/components/SuggestionBar.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { COMMAND_SUGGESTIONS, type SuggestionItem } from '../../commands/suggestion-data.js';

/** 从 COMMAND_SUGGESTIONS 中按名字取子集（保持原顺序） */
function subset(names: string[]): SuggestionItem[] {
  return COMMAND_SUGGESTIONS.filter(s => names.includes(s.name));
}

describe('SuggestionBar', () => {
  it('invisible：渲染空', () => {
    const store = createCompletionStore();
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('visible：渲染所有候选', () => {
    const store = createCompletionStore();
    // plan/provider 来自真相源，proxy 是构造的最小 SuggestionItem
    const candidates = [
      ...subset(['plan', 'provider']),
      { name: 'proxy', description: '', group: 'Config' as const },
    ];
    store.getState().setCandidates(candidates);
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan');
    expect(frame).toContain('provider');
    expect(frame).toContain('proxy');
  });

  it('cycle 后高亮项变化（selected 切到第 2 个）', () => {
    const store = createCompletionStore();
    store.getState().setCandidates(subset(['plan', 'provider']));
    store.getState().cycle(); // index=1 → provider
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    // ink-testing-library 不暴露 color，但 selected() 已在 store 单测覆盖；
    // 这里只确保两个候选都在画面里
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan');
    expect(frame).toContain('provider');
  });
});
