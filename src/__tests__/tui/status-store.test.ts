// src/__tests__/tui/status-store.test.ts
// status-store：mode/model/dir/branch/contextPct（用户规格状态栏）

import { describe, it, expect } from 'vitest';
import { createStatusStore } from '../../tui/state/status-store.js';

const INIT = { mode: 'build', model: 'claude-sonnet', dir: 'Projects/mi-code', branch: 'main' };

describe('status-store（mode/model/dir/branch/contextPct）', () => {
  it('初始：含 mode/model/dir/branch，contextPct=0', () => {
    const store = createStatusStore(INIT);
    const s = store.getState();
    expect(s.mode).toBe('build');
    expect(s.model).toBe('claude-sonnet');
    expect(s.dir).toBe('Projects/mi-code');
    expect(s.branch).toBe('main');
    expect(s.contextPct).toBe(0);
  });

  it('setMode：更新权限模式', () => {
    const store = createStatusStore(INIT);
    store.getState().setMode('plan');
    expect(store.getState().mode).toBe('plan');
    // 其它字段不变
    expect(store.getState().model).toBe('claude-sonnet');
  });

  it('setContextPct：更新上下文占用 [0,1]', () => {
    const store = createStatusStore(INIT);
    store.getState().setContextPct(0.25);
    expect(store.getState().contextPct).toBe(0.25);
  });

  it('setContextPct 钳位到 [0,1]（超界防御）', () => {
    const store = createStatusStore(INIT);
    store.getState().setContextPct(-0.5);
    expect(store.getState().contextPct).toBe(0);
    store.getState().setContextPct(1.5);
    expect(store.getState().contextPct).toBe(1);
  });

  it('setContextPct 真实场景：50000/200000 = 0.25', () => {
    const store = createStatusStore(INIT);
    store.getState().setContextPct(50000 / 200000);
    expect(store.getState().contextPct).toBeCloseTo(0.25);
  });

  it('setModel：更新模型名(动态切模型即时反映到状态栏)', () => {
    const store = createStatusStore(INIT);
    store.getState().setModel('claude-opus-4-20250514');
    expect(store.getState().model).toBe('claude-opus-4-20250514');
    // 其它字段不变
    expect(store.getState().mode).toBe('build');
  });
});
