// Task 5: 子代理与 PermissionRequest hooks（A34、A36-A41）
//
// 设计输入：§6（Auto ask resolver）、§8（交互、hooks 与 remember）、
//          §10 A34/A36-A41 重定义。
//
// Task 5 范围：hooks/fork/headless/session 隔离。
// 不创建 DefaultPermissionAskResolver、不实现 child.resolve() classifier 逻辑（A35 属 Task 6）。
import { describe, test, expect, vi } from 'vitest';
import {
  runPermissionRequestHooks,
  resolveHeadlessAsk,
  type PermissionRequestHook,
  type HeadlessAskInput,
} from '../../permission/permission-request-hooks.js';
import {
  forkPermissionSession,
  type ParentPermissionSnapshot,
} from '../../permission/subagent-silent-policy.js';
import type { SecurityDecision } from '../../permission/decisions.js';
import type { PermissionRule } from '../../permission/types.js';

// ─── fixture helpers ────────────────────────────────────────────────────────────

function makeDecision(behavior: 'allow' | 'ask' | 'deny', reasonCode = 'permission.user_confirmation_required'): SecurityDecision {
  // 最小 SecurityDecision（测试用，identity 字段填占位）
  return {
    protocol_version: '1',
    decision_id: 'd1',
    action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 'snap1' },
    behavior,
    deciding_layer: 'permission',
    risk_kind: 'test',
    policy_id: 'p',
    policy_version: '1',
    reason_code: reasonCode,
    human_reason: 'test',
    provenance_refs: behavior === 'allow' ? ['test'] : [],
  } as SecurityDecision;
}

function ordinaryAsk(): HeadlessAskInput {
  return { decision: makeDecision('ask') };
}

function parentSnapshot(opts: {
  mode?: 'build' | 'plan' | 'auto';
  evaluationMode?: string;
  rules?: PermissionRule[];
  sessionAllows?: string[];
  denial?: { consecutive: number; total: number };
  stash?: PermissionRule[];
}): ParentPermissionSnapshot {
  return {
    mode: opts.mode ?? 'build',
    evaluationMode: opts.evaluationMode,
    rules: opts.rules ?? [],
    sessionAllows: opts.sessionAllows ?? [],
    denial: opts.denial ?? { consecutive: 0, total: 0 },
    strippedDangerousRules: opts.stash ?? [],
  };
}

function parentAutoSession(): ParentPermissionSnapshot {
  return parentSnapshot({ mode: 'auto', rules: [{ tool: 'read_file', behavior: 'allow' }] });
}
function parentBypassSession(): ParentPermissionSnapshot {
  return parentSnapshot({ mode: 'build', evaluationMode: 'bypassPermissions' });
}
function parentWithSessionAllows(allows: string[]): ParentPermissionSnapshot {
  return parentSnapshot({ mode: 'auto', sessionAllows: allows });
}
function populatedAutoSession(): ParentPermissionSnapshot {
  return parentSnapshot({
    mode: 'auto',
    rules: [{ tool: 'read_file', behavior: 'allow' }, { tool: 'run_bash', behavior: 'allow', content: 'git status' }],
    sessionAllows: ['write_file'],
    denial: { consecutive: 2, total: 5 },
    stash: [{ tool: 'spawn_agent', behavior: 'allow' }],
  });
}

function allowTool(tool: string): PermissionRule {
  return { tool, behavior: 'allow' };
}

// ─── A34: headless ask 无 hook 决定 → deny ──────────────────────────────────────

describe('subagent permission boundary', () => {
  test('[A34] headless ask with no hook decision denies', async () => {
    const result = await resolveHeadlessAsk(ordinaryAsk(), []);
    expect(result.behavior).toBe('deny');
  });

  // ─── A36: 父 privileged mode 优先于 child 声明 ───────────────────────────────

  test('[A36] parent privileged mode wins over child-declared mode', () => {
    // 父 auto，child 声明 build -> child 仍 auto
    const child = forkPermissionSession(parentAutoSession(), { permissionMode: 'build' });
    expect(child.mode).toBe('auto');
    // 父 bypass，child 声明 plan -> child 仍 bypassPermissions
    const child2 = forkPermissionSession(parentBypassSession(), { permissionMode: 'plan' });
    expect(child2.evaluationMode).toBe('bypassPermissions');
  });

  // ─── A37: allowedTools 替换 child session rules（不 append 父 session allow）──

  test('[A37] allowedTools replaces child session rules', () => {
    const child = forkPermissionSession(parentWithSessionAllows(['read_file']), { allowedTools: ['grep'] });
    // child session rules 只含 allowedTools canonicalize 后的 allow，不含父 session allow
    expect(child.sessionRules).toEqual([allowTool('grep')]);
    expect(child.sessionRules).not.toContainEqual(allowTool('read_file'));
  });

  test('[A37] allowedTools canonicalizes Task/Agent/AgentTool to spawn_agent', () => {
    const child = forkPermissionSession(parentAutoSession(), { allowedTools: ['Task', 'Agent', 'AgentTool', 'grep'] });
    expect(child.sessionRules).toEqual([
      allowTool('spawn_agent'),
      allowTool('spawn_agent'),
      allowTool('spawn_agent'),
      allowTool('grep'),
    ]);
  });

  // ─── A38: child denial threshold 只终止 child ────────────────────────────────

  test('[A38] child denial threshold terminates only that child', () => {
    const parent = populatedAutoSession();
    const parentDenialBefore = { ...parent.denial };
    const child = forkPermissionSession(parent, {});
    // child 累积 denial 到阈值
    child.recordDenials(3);
    expect(child.status).toBe('aborted');
    // parent 的 denial 快照不受 child 影响（值未变）
    expect(parent.denial).toEqual(parentDenialBefore);
    // 再 fork 一个 child，它从 0 开始，不受前一个 child 的 aborted 影响
    const child2 = forkPermissionSession(parent, {});
    expect(child2.status).toBe('running');
    expect(child2.denialState).toEqual({ consecutive: 0, total: 0 });
  });

  // ─── A39: fork 复制规则值，但 denial/stash 不共享引用 ─────────────────────────

  test('[A39] fork copies rule values but not denial/stash references', () => {
    const parent = populatedAutoSession();
    const child = forkPermissionSession(parent, {});
    // 规则值相等
    expect(child.rules).toEqual(parent.rules);
    // denial 是独立对象（不共享引用）
    expect(child.denialState).not.toBe(parent.denial);
    expect(child.denialState).toEqual({ consecutive: 0, total: 0 }); // child 从 0 开始
    // stash 是独立对象
    expect(child.strippedDangerousRules).not.toBe(parent.strippedDangerousRules);
    expect(child.strippedDangerousRules).toEqual(parent.strippedDangerousRules); // 值相等
  });

  // ─── A40: hooks 是 headless 唯一外部静默 allow 通道 ───────────────────────────

  test('[A40] hooks are the only headless external allow channel', async () => {
    const hook: PermissionRequestHook = vi.fn().mockResolvedValue('allow');
    const result = await resolveHeadlessAsk(ordinaryAsk(), [hook]);
    expect(result.behavior).toBe('allow');
    expect(hook).toHaveBeenCalledOnce();
    // hook 返回 null -> deny
    const nullHook: PermissionRequestHook = vi.fn().mockResolvedValue(null);
    const result2 = await resolveHeadlessAsk(ordinaryAsk(), [nullHook]);
    expect(result2.behavior).toBe('deny');
  });

  test('[A40] first explicit allow/deny wins, subsequent hooks not called', async () => {
    const allowHook: PermissionRequestHook = vi.fn().mockResolvedValue('allow');
    const secondHook: PermissionRequestHook = vi.fn().mockResolvedValue('deny');
    const result = await resolveHeadlessAsk(ordinaryAsk(), [allowHook, secondHook]);
    expect(result.behavior).toBe('allow');
    expect(allowHook).toHaveBeenCalledOnce();
    expect(secondHook).not.toHaveBeenCalled();
  });

  test('[A40] hook exception is treated as null (no decision), all-null denies', async () => {
    const throwingHook: PermissionRequestHook = vi.fn().mockRejectedValue(new Error('hook crashed'));
    const result = await resolveHeadlessAsk(ordinaryAsk(), [throwingHook]);
    expect(result.behavior).toBe('deny');
    expect(throwingHook).toHaveBeenCalledOnce();
  });

  // ─── A41: bubble 只在显式 bubbleEnabled 下存在 ───────────────────────────────

  test('[A41] bubble exists only behind explicit bubbleEnabled option', async () => {
    // 默认 bubbleEnabled=false -> deny
    const result = await resolveHeadlessAsk(ordinaryAsk(), [], { bubbleEnabled: false });
    expect(result.behavior).toBe('deny');
    // bubbleEnabled=true -> bubble
    const result2 = await resolveHeadlessAsk(ordinaryAsk(), [], { bubbleEnabled: true });
    expect(result2.behavior).toBe('bubble');
  });

  // ─── headless 绝不创建 dialog（resolveHeadlessAsk 无 dialog 参数）──────────────

  test('resolveHeadlessAsk does not accept or create dialog', async () => {
    // resolveHeadlessAsk 签名只有 (ask, hooks, options?)，无 dialog 参数
    const result = await resolveHeadlessAsk(ordinaryAsk(), []);
    // headless 路径不创建 dialog —— 无 UI 副作用
    expect(result.behavior).toBe('deny');
  });

  // ─── safety_uncertain / non-classifierApprovable ask 必须先经过 hooks ─────────
  //
  // 批准语义：任何进入 headless ask resolution 的 ask，都先运行 PermissionRequest hooks；
  // 首个明确 allow/deny 生效；hook error/null 继续；全部无决定后才 fail-closed deny。
  // applySubagentSilentPolicy 不允许在 hooks 前把 ask 终结为 deny 或 allow。

  test('safety_uncertain ask: hook allow must take effect (hooks run before silent-deny)', async () => {
    // command_unparseable 是 safety_uncertain 别名；旧实现 silent-deny 在 hooks 前，hook 没机会。
    const safetyAsk: HeadlessAskInput = {
      decision: makeDecision('ask', 'permission.command_unparseable'),
    };
    const allowHook: PermissionRequestHook = vi.fn().mockResolvedValue('allow');
    const result = await resolveHeadlessAsk(safetyAsk, [allowHook]);
    expect(allowHook).toHaveBeenCalledOnce(); // hook 必须被调用
    expect(result.behavior).toBe('allow'); // hook allow 生效
  });

  test('safety_uncertain ask: hooks all null/error -> fail-closed deny', async () => {
    const safetyAsk: HeadlessAskInput = {
      decision: makeDecision('ask', 'permission.command_unresolvable_var'),
    };
    // 全 null -> deny
    const nullHook: PermissionRequestHook = vi.fn().mockResolvedValue(null);
    const result = await resolveHeadlessAsk(safetyAsk, [nullHook]);
    expect(nullHook).toHaveBeenCalledOnce();
    expect(result.behavior).toBe('deny');
    // 抛异常 -> deny
    const throwingHook: PermissionRequestHook = vi.fn().mockRejectedValue(new Error('crash'));
    const result2 = await resolveHeadlessAsk(safetyAsk, [throwingHook]);
    expect(throwingHook).toHaveBeenCalledOnce();
    expect(result2.behavior).toBe('deny');
  });

  test('unknown ask reason_code: hooks still run first, then fail-closed deny', async () => {
    const unknownAsk: HeadlessAskInput = {
      decision: makeDecision('ask', 'permission.some_unknown_category'),
    };
    const denyHook: PermissionRequestHook = vi.fn().mockResolvedValue('deny');
    const result = await resolveHeadlessAsk(unknownAsk, [denyHook]);
    expect(denyHook).toHaveBeenCalledOnce();
    expect(result.behavior).toBe('deny');
  });
});

// ─── runPermissionRequestHooks 直接单测 ─────────────────────────────────────────

describe('runPermissionRequestHooks', () => {
  test('returns first allow/deny, stops on first decision', async () => {
    const h1: PermissionRequestHook = vi.fn().mockResolvedValue(null);
    const h2: PermissionRequestHook = vi.fn().mockResolvedValue('deny');
    const h3: PermissionRequestHook = vi.fn().mockResolvedValue('allow');
    const result = await runPermissionRequestHooks(ordinaryAsk(), [h1, h2, h3]);
    expect(result).toBe('deny');
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    expect(h3).not.toHaveBeenCalled();
  });

  test('all-null returns null', async () => {
    const h1: PermissionRequestHook = vi.fn().mockResolvedValue(null);
    const h2: PermissionRequestHook = vi.fn().mockResolvedValue(null);
    const result = await runPermissionRequestHooks(ordinaryAsk(), [h1, h2]);
    expect(result).toBeNull();
  });

  test('empty hooks returns null', async () => {
    const result = await runPermissionRequestHooks(ordinaryAsk(), []);
    expect(result).toBeNull();
  });
});
