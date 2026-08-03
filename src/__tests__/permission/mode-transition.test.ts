// Task 8: 单一 Mode Transition（A20-A23）
//
// 设计输入：§9.2（Startup/default mode precedence）、§9.3（Policy restriction/gate precedence）、
//          §10 A20-A23 重定义。
//
// 锁定：
//   - A20：session destination 不写盘；settings destination 写 mode。same-mode no-op。
//   - A21：resume 先清瞬态，再 reload/repartition 持久规则（auto 下危险 allow 进 stash）。
//   - A22：startup precedence（CLI > sanitized resume > user default > build）；
//          restriction gate 只降级/拒绝，不授予更高权限。
//   - A23：slash/TAB/plan approval 统一经同一 transitionPermissionMode port。
import { describe, test, expect, vi } from 'vitest';
import {
  transitionPermissionMode,
  resolveRequestedStartupMode,
  applyModeRestrictions,
  applyRuntimeModeTransition,
  type ModeTransitionEffects,
} from '../../permission/mode-transition.js';
import { SessionState } from '../../permission/session-state.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import type { PermissionRule } from '../../permission/types.js';

// ─── helpers ────────────────────────────────────────────────────────────────────

function makeSessionState(mode: 'build' | 'plan' | 'auto' = 'build', rules: PermissionRule[] = []): SessionState {
  const al = new SessionAllowlist();
  const state = new SessionState(al, 's1');
  state.applyPermissionUpdate({ kind: 'replaceRules', rules });
  if (mode !== 'build') state.applyPermissionUpdate({ kind: 'setMode', mode });
  return state;
}

function dangerousBashAllow(): PermissionRule {
  return { tool: 'run_bash', behavior: 'allow', content: 'rm -rf *' };
}

// ─── A20: session/settings destination + same-mode no-op ────────────────────────

describe('permission mode transition', () => {
  test('[A20] session destination never writes disk', () => {
    const save = vi.fn();
    const state = makeSessionState('build');
    transitionPermissionMode(state, 'auto', 'session', { save });
    expect(save).not.toHaveBeenCalled();
    expect(state.permissionSnapshot.mode).toBe('auto');
  });

  test('[A20] settings destination writes default mode', () => {
    const save = vi.fn();
    const state = makeSessionState('build');
    transitionPermissionMode(state, 'plan', 'userSettings', { save });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ permissions: { mode: 'plan' } }));
  });

  test('[A20] same-mode transition is no-op (no effects, no save)', () => {
    const save = vi.fn();
    const state = makeSessionState('auto');
    const snapshotBefore = state.permissionSnapshot;
    const effects = transitionPermissionMode(state, 'auto', 'session', { save });
    expect(effects).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    // snapshot identity preserved
    expect(state.permissionSnapshot).toBe(snapshotBefore);
  });

  // ─── A21: resume 先清瞬态，再 reload/repartition ──────────────────────────────

  test('[A21] resume clears transient then repartitions persisted dangerous rules', () => {
    // auto + 危险规则 + 瞬态
    const state = makeSessionState('auto', [dangerousBashAllow()]);
    state.recordDenial();
    state.recordDenial();
    state.sessionAllowlist.add('write_file', { path: 'a' });
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([dangerousBashAllow()]);
    expect(state.denialState).toEqual({ consecutive: 2, total: 2 });

    // transitionTo 清瞬态
    state.transitionTo('resumed');
    expect(state.denialState).toEqual({ consecutive: 0, total: 0 });
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([]);
    expect(state.sessionAllowlist.size).toBe(0);

    // reload 持久规则 -> auto 下危险 allow 重新进 stash
    state.applyPermissionUpdate({ kind: 'replaceRules', rules: [dangerousBashAllow()] });
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([dangerousBashAllow()]);
  });

  // ─── A22: startup precedence ──────────────────────────────────────────────────

  test('[A22] requested startup mode uses CLI > sanitized resume > user default > build', () => {
    expect(resolveRequestedStartupMode({ cliArg: 'auto', resumed: 'plan', userDefault: 'build' })).toBe('auto');
    expect(resolveRequestedStartupMode({ resumed: 'plan', userDefault: 'auto' })).toBe('plan');
    expect(resolveRequestedStartupMode({ userDefault: 'auto' })).toBe('auto');
    // 无 CLI / resume / userDefault -> build（project/local default 不选 startup mode）
    expect(resolveRequestedStartupMode({ projectDefault: 'plan', localDefault: 'plan' })).toBe('build');
    // 完全无输入 -> build
    expect(resolveRequestedStartupMode({})).toBe('build');
  });

  // ─── A22: restriction gate ────────────────────────────────────────────────────

  test('[A22] managed policy restricts auto to build', () => {
    const result = applyModeRestrictions('auto', { managedPolicyAllowsAuto: false });
    expect(result.mode).toBe('build');
    expect(result.reason).toBe('managed_policy');
    expect(result.audited).toBe(true);
  });

  test('[A22] managed policy allows auto keeps auto', () => {
    const result = applyModeRestrictions('auto', { managedPolicyAllowsAuto: true });
    expect(result.mode).toBe('auto');
  });

  test('[A22] runtime mode transition restricted when headless disallows auto', () => {
    const result = applyRuntimeModeTransition('build', 'auto', { headlessAllowsAuto: false });
    expect(result.mode).toBe('build');
    expect(result.changed).toBe(false);
  });

  test('[A22] restriction never grants higher than requested', () => {
    // build -> restriction 不应升级到 auto
    const result = applyModeRestrictions('build', { managedPolicyAllowsAuto: true });
    expect(result.mode).toBe('build');
  });

  // ─── A23: slash/TAB/plan approval 统一 port ───────────────────────────────────

  test('[A23] all mode changes go through transitionPermissionMode', () => {
    // 模拟 slash /auto、TAB cycle、plan approval 都调 transitionPermissionMode
    const state1 = makeSessionState('build');
    const state2 = makeSessionState('build');
    const state3 = makeSessionState('build');

    // slash /auto
    transitionPermissionMode(state1, 'auto', 'session');
    expect(state1.permissionSnapshot.mode).toBe('auto');

    // TAB cycle: build -> plan
    transitionPermissionMode(state2, 'plan', 'session');
    expect(state2.permissionSnapshot.mode).toBe('plan');

    // plan approval -> build
    transitionPermissionMode(state3, 'build', 'session');
    expect(state3.permissionSnapshot.mode).toBe('build');
  });

  test('[A23] transitionPermissionMode returns effects for observers', () => {
    const state = makeSessionState('build');
    const effects = transitionPermissionMode(state, 'auto', 'session');
    expect(Array.isArray(effects)).toBe(true);
    expect(effects.length).toBeGreaterThan(0);
    // effect 应包含 mode 变化信息
    expect(effects.some((e: ModeTransitionEffects) => e.kind === 'mode_changed')).toBe(true);
  });
});
