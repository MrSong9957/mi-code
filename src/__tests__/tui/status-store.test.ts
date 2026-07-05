// src/__tests__/tui/status-store.test.ts
// status-store：tokens + elapsed 状态（charter L89 格式）

import { describe, it, expect } from 'vitest';
import { createStatusStore } from '../../tui/state/status-store.js';

describe('status-store（tokens + elapsed）', () => {
  it('初始：tokenCount=0, elapsedSec=0', () => {
    const store = createStatusStore();
    const s = store.getState();
    expect(s.tokenCount).toBe(0);
    expect(s.elapsedSec).toBe(0);
  });

  it('setTokens：更新 tokenCount', () => {
    const store = createStatusStore();
    store.getState().setTokens(42);
    expect(store.getState().tokenCount).toBe(42);
  });

  it('setTokens 覆盖（累计由上游算，store 只存最新值）', () => {
    const store = createStatusStore();
    store.getState().setTokens(10);
    store.getState().setTokens(25);
    store.getState().setTokens(100);
    expect(store.getState().tokenCount).toBe(100);
  });

  it('setElapsed：更新 elapsedSec', () => {
    const store = createStatusStore();
    store.getState().setElapsed(7);
    expect(store.getState().elapsedSec).toBe(7);
  });

  it('resetTurn：清零 tokenCount + elapsedSec（新 turn 开始）', () => {
    const store = createStatusStore();
    store.getState().setTokens(99);
    store.getState().setElapsed(5);
    store.getState().resetTurn();
    expect(store.getState().tokenCount).toBe(0);
    expect(store.getState().elapsedSec).toBe(0);
  });
});
