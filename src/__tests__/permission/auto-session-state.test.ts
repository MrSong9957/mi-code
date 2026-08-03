// Task 2: 单一 PermissionUpdate 与 SessionState（A17-A19、A32、A64、A88）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §3（核心类型与状态归属）、
//          §3.1（isDangerousAllowRule 权威语义）、§10 A17/A18/A19/A32/A64/A88 重定义。
//
// 锁定 src/permission/permission-updates.ts 与扩展后的 SessionState 行为：
//   - isDangerousAllowRule：危险 allow 判定的唯一真相源（canonical alias、bash breadth、wildcard）
//   - applyPermissionUpdate：唯一规则/模式状态变换（add/remove/replace/reload/setMode）
//   - dangerous allow 的 visible/stash 分区与生命周期
//   - SessionState.permissionSnapshot / denialState / transitionTo 瞬态清理 + resume 重分区
import { describe, test, expect } from 'vitest';
import {
  isDangerousAllowRule,
  applyPermissionUpdate,
  type PermissionSnapshot,
  type PermissionUpdate,
} from '../../permission/permission-updates.js';
import type { PermissionRule } from '../../permission/types.js';
import { SessionState } from '../../permission/session-state.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';

// ─── fixture helpers（现有 { tool, behavior, path?, content? } 模型）──────────────

function allowRule(tool: string, content?: string): PermissionRule {
  return content === undefined ? { tool, behavior: 'allow' } : { tool, behavior: 'allow', content };
}
function dangerousBashAllow(): PermissionRule {
  return { tool: 'run_bash', behavior: 'allow', content: 'rm -rf *' };
}
function safeReadAllow(): PermissionRule {
  return { tool: 'read_file', behavior: 'allow', path: 'src/**' };
}
function setMode(mode: 'build' | 'plan' | 'auto'): PermissionUpdate {
  return { kind: 'setMode', mode };
}
function addAllow(rule: PermissionRule): PermissionUpdate {
  return { kind: 'addRule', rule };
}
function removeAllow(rule: PermissionRule): PermissionUpdate {
  return { kind: 'removeRule', rule };
}
function replaceAllows(rules: PermissionRule[]): PermissionUpdate {
  return { kind: 'replaceRules', rules };
}

/** 从 snapshot 提取可见 allow 规则（不含 stash） */
function visibleAllowRules(snap: PermissionSnapshot): PermissionRule[] {
  return snap.rules.filter((r) => r.behavior === 'allow');
}

function makeSnapshot(rules: PermissionRule[] = [], mode: 'build' | 'plan' | 'auto' = 'build'): PermissionSnapshot {
  return { rules: [...rules], mode, strippedDangerousRules: [] };
}

// ─── isDangerousAllowRule：唯一危险判定真相源（设计 §3.1）────────────────────────

describe('isDangerousAllowRule (authoritative danger partitioning)', () => {
  test('covers canonical aliases, Bash breadth and wildcards', () => {
    // 1. 全局 tool allow `*`
    expect(isDangerousAllowRule(allowRule('*'))).toBe(true);
    // 2. canonical spawn_agent 任意 allow（含 legacy 别名 Task/Agent/AgentTool）
    for (const alias of ['spawn_agent', 'Task', 'Agent', 'AgentTool']) {
      expect(isDangerousAllowRule(allowRule(alias)), alias).toBe(true);
    }
    // 3. run_bash 裸 allow
    expect(isDangerousAllowRule(allowRule('run_bash'))).toBe(true);
    // 3b. run_bash content 含未转义 wildcard
    expect(isDangerousAllowRule(allowRule('run_bash', '*'))).toBe(true);
    expect(isDangerousAllowRule(allowRule('run_bash', 'git:*'))).toBe(true);
    // 转义星是字面量 -> 不危险（窄化）
    expect(isDangerousAllowRule(allowRule('run_bash', 'printf \\*'))).toBe(false);
    // 4. run_bash 含 interpreter/runner 可执行文件（去环境变量赋值、提取首个可执行）
    for (const command of [
      'API_KEY=x bash -lc true',
      'PYTHON.EXE -c pass', // Windows 大小写不敏感 + 去 .exe
      'npx eslint .',
      'docker run image',
    ]) {
      expect(isDangerousAllowRule(allowRule('run_bash', command)), command).toBe(true);
    }
    // 5. 精确 run_bash 安全命令 + 其他 tool exact allow 不因此判危险
    expect(isDangerousAllowRule(allowRule('run_bash', 'git status'))).toBe(false);
    expect(isDangerousAllowRule(allowRule('read_file', 'src/a.ts'))).toBe(false);
  });
});

// ─── applyPermissionUpdate：唯一状态变换（A17/A18/A32）──────────────────────────

describe('applyPermissionUpdate (sole state transition)', () => {
  test('[A17] entering auto strips dangerous allows into session stash', () => {
    const base = makeSnapshot([dangerousBashAllow()], 'build');
    const next = applyPermissionUpdate(base, setMode('auto'));
    expect(visibleAllowRules(next)).not.toContainEqual(dangerousBashAllow());
    expect(next.strippedDangerousRules).toEqual([dangerousBashAllow()]);
    expect(next.mode).toBe('auto');
  });

  test('[A18] exit restores only rules still present in current stash', () => {
    const entered = applyPermissionUpdate(makeSnapshot([dangerousBashAllow()], 'build'), setMode('auto'));
    // 进入 auto 后移除该危险规则（stash 同步删除）
    const removed = applyPermissionUpdate(entered, removeAllow(dangerousBashAllow()));
    // 退出 auto：只恢复仍在 stash 的规则；该规则已被 remove，不复活
    const exited = applyPermissionUpdate(removed, setMode('build'));
    expect(visibleAllowRules(exited)).not.toContainEqual(dangerousBashAllow());
    expect(exited.strippedDangerousRules).toEqual([]);
  });

  test('[A18] exit restores dangerous rules still in stash back to visible', () => {
    // 对照：未被 remove 的危险规则，退出 auto 时从 stash 回到 visible
    const entered = applyPermissionUpdate(makeSnapshot([dangerousBashAllow()], 'build'), setMode('auto'));
    const exited = applyPermissionUpdate(entered, setMode('build'));
    expect(visibleAllowRules(exited)).toContainEqual(dangerousBashAllow());
    expect(exited.strippedDangerousRules).toEqual([]);
  });

  test('[A32] add/remove/replace/reload update visible rules and stash together', () => {
    // 在 auto 模式下，所有变换都同步 visible/stash，禁止权限复活
    let snap = applyPermissionUpdate(makeSnapshot([], 'auto'), addAllow(dangerousBashAllow()));
    expect(snap.strippedDangerousRules).toContainEqual(dangerousBashAllow());
    expect(visibleAllowRules(snap)).not.toContainEqual(dangerousBashAllow());

    // replace：清空全部 allow 后重新分区
    snap = applyPermissionUpdate(snap, replaceAllows([safeReadAllow()]));
    expect(snap.strippedDangerousRules).toEqual([]);
    expect(visibleAllowRules(snap)).toContainEqual(safeReadAllow());

    // reload（replaceRules 语义）：重新装入危险规则 -> 进 stash
    snap = applyPermissionUpdate(snap, replaceAllows([dangerousBashAllow()]));
    expect(snap.strippedDangerousRules).toEqual([dangerousBashAllow()]);
    expect(visibleAllowRules(snap)).not.toContainEqual(dangerousBashAllow());
  });

  test('non-auto mode keeps dangerous allows visible (no stash partition)', () => {
    // build/plan 模式不分区：危险 allow 留在 visible，stash 为空
    const snap = applyPermissionUpdate(makeSnapshot([dangerousBashAllow()], 'build'), addAllow(dangerousBashAllow()));
    expect(visibleAllowRules(snap)).toContainEqual(dangerousBashAllow());
    expect(snap.strippedDangerousRules).toEqual([]);
  });

  test('setMode build->auto->build roundtrip preserves rule set', () => {
    const rules = [dangerousBashAllow(), safeReadAllow()];
    let snap = applyPermissionUpdate(makeSnapshot(rules, 'build'), setMode('auto'));
    // auto: 危险进 stash，safe 留 visible
    expect(snap.strippedDangerousRules).toEqual([dangerousBashAllow()]);
    expect(visibleAllowRules(snap)).toContainEqual(safeReadAllow());
    // back to build: 危险从 stash 回 visible，两条规则都在
    snap = applyPermissionUpdate(snap, setMode('build'));
    expect(visibleAllowRules(snap)).toEqual(expect.arrayContaining([dangerousBashAllow(), safeReadAllow()]));
    expect(visibleAllowRules(snap)).toHaveLength(2);
    expect(snap.strippedDangerousRules).toEqual([]);
  });

  test('snapshot is frozen (immutable)', () => {
    const snap = applyPermissionUpdate(makeSnapshot([], 'build'), setMode('auto'));
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.rules)).toBe(true);
    expect(Object.isFrozen(snap.strippedDangerousRules)).toBe(true);
  });
});

// ─── SessionState 扩展：permissionSnapshot / denialState / transitionTo ─────────

describe('SessionState permission snapshot and denial state', () => {
  function makeSessionState(opts: {
    mode?: 'build' | 'plan' | 'auto';
    rules?: PermissionRule[];
    id?: string;
  } = {}): SessionState {
    const al = new SessionAllowlist();
    const state = new SessionState(al, opts.id ?? 's1');
    if (opts.rules || opts.mode) {
      state.applyPermissionUpdate({
        kind: 'replaceRules',
        rules: opts.rules ?? [],
      });
      if (opts.mode) {
        state.applyPermissionUpdate({ kind: 'setMode', mode: opts.mode });
      }
    }
    return state;
  }

  test('exposes permissionSnapshot and denialState', () => {
    const state = makeSessionState({ mode: 'auto' });
    expect(state.permissionSnapshot.mode).toBe('auto');
    expect(state.denialState).toEqual({ consecutive: 0, total: 0 });
  });

  test('[A64] resume clears transient state then repartitions persisted dangerous rules', () => {
    // auto 模式 + 危险规则在 stash
    const state = makeSessionState({
      mode: 'auto',
      rules: [dangerousBashAllow()],
      id: 's1',
    });
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([dangerousBashAllow()]);

    // 累积一些 denial / allowlist 记录（瞬态）
    state.recordDenial();
    state.recordDenial();
    state.sessionAllowlist.add('write_file', { path: 'a' });
    expect(state.denialState).toEqual({ consecutive: 2, total: 2 });

    // transitionTo(新 session)：瞬态全清
    state.transitionTo('resumed-session');
    expect(state.denialState).toEqual({ consecutive: 0, total: 0 });
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([]);
    expect(state.sessionAllowlist.size).toBe(0);

    // resume 后 reload 持久规则：auto 下危险 allow 重新进 stash
    state.applyPermissionUpdate({ kind: 'replaceRules', rules: [dangerousBashAllow()] });
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([dangerousBashAllow()]);
    expect(visibleAllowRules(state.permissionSnapshot)).not.toContainEqual(dangerousBashAllow());
  });

  test('[A88] transitionTo clears every session cache; same id is a no-op', () => {
    const state = makeSessionState({
      mode: 'auto',
      rules: [dangerousBashAllow(), safeReadAllow()],
      id: 's1',
    });
    state.sessionAllowlist.add('write_file', { path: 'a' });
    state.recordDenial();
    expect(state.sessionAllowlist.size).toBeGreaterThan(0);

    // 相同 id：no-op，不清瞬态
    state.transitionTo('s1');
    expect(state.sessionAllowlist.size).toBeGreaterThan(0);
    expect(state.denialState).toEqual({ consecutive: 1, total: 1 });

    // 不同 id：清 allowlist + denial + stash（但 visible rules 按设计保留还是清？
    //   设计 §8/§10 A88：transitionTo 清 allowlist/denial/stash/attachment pending。
    //   持久规则的稳定态由 reload 重建，transitionTo 本身不保留 stash。）
    state.transitionTo('s2');
    expect(state.sessionAllowlist.size).toBe(0);
    expect(state.denialState).toEqual({ consecutive: 0, total: 0 });
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([]);
  });

  test('recordAllow resets consecutive but preserves total (denial tracker)', () => {
    const state = makeSessionState({ mode: 'auto' });
    state.recordDenial();
    state.recordDenial();
    expect(state.denialState).toEqual({ consecutive: 2, total: 2 });
    state.recordAllow();
    expect(state.denialState).toEqual({ consecutive: 0, total: 2 });
  });

  test('sessionAllowlist is accessible read-only', () => {
    const state = makeSessionState({ mode: 'auto' });
    expect(state.sessionAllowlist).toBeDefined();
    expect(state.sessionAllowlist.size).toBe(0);
  });
});
