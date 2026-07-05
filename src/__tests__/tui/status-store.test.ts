// src/__tests__/tui/status-store.test.ts
// status-store：状态栏 + spinner + hint 的统一状态

import { describe, it, expect } from 'vitest';
import { createStatusStore } from '../../tui/state/status-store.js';

describe('status-store（状态栏/spinner/hint）', () => {
  it('初始：含 mode/model/branch/dir/contextUsage，无 toolStatus/hint', () => {
    const store = createStatusStore({ mode: 'build', model: 'M', branch: 'main', dir: '/tmp', contextUsage: 0 });
    const s = store.getState();
    expect(s.mode).toBe('build');
    expect(s.model).toBe('M');
    expect(s.branch).toBe('main');
    expect(s.dir).toBe('/tmp');
    expect(s.contextUsage).toBe(0);
    expect(s.toolStatus).toBeUndefined();
    expect(s.hint).toBeUndefined();
  });

  it('setStatus：部分更新（合并）', () => {
    const store = createStatusStore({ mode: 'build', model: 'M', branch: 'main', dir: '/tmp', contextUsage: 0 });
    store.getState().setStatus({ mode: 'plan' });
    expect(store.getState().mode).toBe('plan');
    // 其它字段不变
    expect(store.getState().model).toBe('M');
  });

  it('startSpinner / setSpinnerLabel：设置 toolStatus', () => {
    const store = createStatusStore({ mode: 'build', model: 'M', branch: 'main', dir: '/tmp', contextUsage: 0 });
    store.getState().startSpinner('Thinking…');
    expect(store.getState().toolStatus).toEqual({ name: 'Thinking…', status: 'running' });
    store.getState().setSpinnerLabel('Generating…');
    expect(store.getState().toolStatus?.name).toBe('Generating…');
  });

  it('stopSpinner：清除 toolStatus', () => {
    const store = createStatusStore({ mode: 'build', model: 'M', branch: 'main', dir: '/tmp', contextUsage: 0 });
    store.getState().startSpinner('Thinking…');
    store.getState().stopSpinner();
    expect(store.getState().toolStatus).toBeUndefined();
  });

  it('stopSpinner 无活动时不崩', () => {
    const store = createStatusStore({ mode: 'build', model: 'M', branch: 'main', dir: '/tmp', contextUsage: 0 });
    expect(() => store.getState().stopSpinner()).not.toThrow();
  });

  it('setHint / clearHint', () => {
    const store = createStatusStore({ mode: 'build', model: 'M', branch: 'main', dir: '/tmp', contextUsage: 0 });
    store.getState().setHint('翻页提示');
    expect(store.getState().hint).toBe('翻页提示');
    store.getState().setHint(undefined);
    expect(store.getState().hint).toBeUndefined();
  });

  it('setContextUsage', () => {
    const store = createStatusStore({ mode: 'build', model: 'M', branch: 'main', dir: '/tmp', contextUsage: 0 });
    store.getState().setContextUsage(0.5);
    expect(store.getState().contextUsage).toBe(0.5);
  });
});
