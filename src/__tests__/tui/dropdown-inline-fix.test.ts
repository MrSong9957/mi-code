import { describe, it, expect } from 'vitest';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { COMMAND_NAMES } from '../../commands/executor.js';

describe('completionStore bridge — / triggers filter', () => {
  it('filter("") shows all commands', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const s = store.getState();
    expect(s.visible).toBe(true);
    expect(s.candidates.length).toBeGreaterThan(0);
    expect(s.candidates).toEqual(COMMAND_NAMES);
  });

  it('filter("th") shows only commands starting with "th"', () => {
    const store = createCompletionStore();
    store.getState().filter('th');
    const s = store.getState();
    expect(s.visible).toBe(true);
    expect(s.candidates.every(c => c.startsWith('th'))).toBe(true);
  });

  it('filter("zzznoexist") hides dropdown', () => {
    const store = createCompletionStore();
    store.getState().filter('zzznoexist');
    const s = store.getState();
    expect(s.visible).toBe(false);
    expect(s.candidates.length).toBe(0);
  });

  it('cycle advances index and wraps around', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const initial = store.getState().index;
    store.getState().cycle();
    expect(store.getState().index).toBe((initial + 1) % store.getState().candidates.length);
  });

  it('cyclePrev goes backward and wraps', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cyclePrev();
    const s = store.getState();
    expect(s.index).toBe(s.candidates.length - 1);
  });

  it('hide resets visible and index', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cycle();
    store.getState().hide();
    const s = store.getState();
    expect(s.visible).toBe(false);
    expect(s.index).toBe(0);
  });
});
