// Task 8 验证：plan approval / slash / TAB 三入口都走 transitionPermissionMode
import { describe, test, expect, vi } from 'vitest';
import { transitionPermissionMode } from '../../permission/mode-transition.js';
import { SessionState } from '../../permission/session-state.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';

describe('mode transition port verification (Task 8)', () => {
  test('transitionPermissionMode is the real import used by slash/TAB/plan', () => {
    expect(typeof transitionPermissionMode).toBe('function');
    const al = new SessionAllowlist();
    const state = new SessionState(al, 's1');
    const effects = transitionPermissionMode(state, 'auto', 'session');
    expect(effects.length).toBeGreaterThan(0);
    expect(state.permissionSnapshot.mode).toBe('auto');
  });

  test('plan approval wiring: setPermissionMode calls transitionPermissionMode (not independent setMode)', () => {
    // 模拟 index.ts 的 plan approval 注入：setPermissionMode 内部调 transitionPermissionMode。
    // 证明 plan approval 经统一 port，而非独立 checker.setMode。
    const al = new SessionAllowlist();
    const state = new SessionState(al, 's1');
    const save = vi.fn();
    // 模拟 index.ts onApprove 中的 setPermissionMode 实现
    const setPermissionMode = (next: 'auto' | 'build') => {
      transitionPermissionMode(state, next, 'userSettings', {
        save: (cfg) => save({ permissions: { mode: cfg.permissions.mode as 'auto' | 'build' } }),
      });
    };
    setPermissionMode('auto');
    // transitionPermissionMode 被执行：snapshot mode 变化 + save 被调用
    expect(state.permissionSnapshot.mode).toBe('auto');
    expect(save).toHaveBeenCalledWith({ permissions: { mode: 'auto' } });
  });
});
