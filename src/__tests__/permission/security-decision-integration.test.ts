// RC-5 PermissionChecker.checkDecision() 集成测试
//
// 物理本质：门卫的新版决策单。
//   - 旧 check() 返回 { behavior, reason }（口语化、不可跨进程）；
//   - 新 checkDecision() 返回 SecurityDecision（结构化、可签名、可追踪、provenance 完整）。
//
// 关键不变量：
//   1. 不重复实现四步管道——必须复用 check()；
//   2. snapshot_id 来自 context，绝不在内部随机生成；
//   3. 决策单 NO approved 字段（Wave A 不实现 ask 通道）；
//   4. 旧 check() 行为必须完全不变（兼容性第一）。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PermissionChecker } from '../../permission/checker.js';
import type { SecurityDecision } from '../../permission/decisions.js';

const ctx = {
  decision_id: 'dec-1',
  action_snapshot_id: 'snap-1',
  policy_id: 'permission-default',
  policy_version: '1',
};

describe('PermissionChecker.checkDecision - behavior mapping', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'sec-decision-integ-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('read-only tool (read_file) → allow with default/rule reason_code', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    // 先写一个文件让 read_file 能读，但路径在工作区内
    const d = checker.checkDecision('read_file', { path: 'x.txt' }, ctx);
    expect(d.behavior).toBe('allow');
    // 读工具走默认 allow，映射为 permission.default
    expect(['permission.default', 'permission.rule_allow']).toContain(d.reason_code);
  });

  it('write tool (write_file) in build mode → ask, user confirmation required', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d = checker.checkDecision('write_file', { path: 'x.txt', content: 'x' }, ctx);
    expect(d.behavior).toBe('ask');
    expect(d.reason_code).toBe('permission.user_confirmation_required');
  });

  it('dangerous bash (rm -rf) → deny, dangerous_command', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d = checker.checkDecision('run_bash', { command: 'rm -rf /' }, ctx);
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.dangerous_command');
    expect(d.risk_kind).toBe('dangerous_command');
    expect(d.deciding_layer).toBe('command');
  });

  it('plan mode on write tool → deny, plan_write_blocked', () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir });
    const d = checker.checkDecision('write_file', { path: 'inside.txt', content: 'x' }, ctx);
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.plan_write_blocked');
    expect(d.deciding_layer).toBe('permission');
  });

  it('outside-workspace write → deny, path_outside_workspace', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    // 构造工作区外绝对路径
    const outside = join(workdir + '_sibling', 'passwd');
    const d = checker.checkDecision('write_file', { path: outside, content: 'x' }, ctx);
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.path_outside_workspace');
    expect(d.risk_kind).toBe('path_violation');
    expect(d.deciding_layer).toBe('path');
  });
});

describe('PermissionChecker.checkDecision - structure invariants', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'sec-decision-integ-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('snapshot_id from context is preserved exactly (no random ID)', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d = checker.checkDecision('write_file', { path: 'x.txt', content: 'x' }, ctx);
    expect(d.action.snapshot_id).toBe(ctx.action_snapshot_id);
    expect(d.action.snapshot_id).not.toBe('');
  });

  it('decision_id, policy_id, policy_version come from context', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d = checker.checkDecision('read_file', { path: 'x.txt' }, ctx);
    expect(d.decision_id).toBe(ctx.decision_id);
    expect(d.policy_id).toBe(ctx.policy_id);
    expect(d.policy_version).toBe(ctx.policy_version);
  });

  it('protocol_version is "1" (Wave A hardcoded)', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d = checker.checkDecision('read_file', { path: 'x.txt' }, ctx);
    expect(d.protocol_version).toBe('1');
  });

  it('action.subject_id equals toolName', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d = checker.checkDecision('write_file', { path: 'x.txt', content: 'x' }, ctx);
    expect(d.action.subject_id).toBe('write_file');
    expect(d.action.kind).toBe('tool_call');
  });

  it('returned decision has NO approved property', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d: SecurityDecision = checker.checkDecision('write_file', { path: 'x.txt', content: 'x' }, ctx);
    expect((d as unknown as { approved?: unknown }).approved).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(d, 'approved')).toBe(false);
  });

  it('returned decision is frozen', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d = checker.checkDecision('read_file', { path: 'x.txt' }, ctx);
    expect(Object.isFrozen(d)).toBe(true);
  });

  it('provenance_refs is non-empty and is an array of strings', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d = checker.checkDecision('run_bash', { command: 'echo hi' }, ctx);
    expect(Array.isArray(d.provenance_refs)).toBe(true);
    expect(d.provenance_refs.length).toBeGreaterThan(0);
    for (const ref of d.provenance_refs) {
      expect(typeof ref).toBe('string');
    }
  });
});

describe('PermissionChecker.checkDecision - compatibility with check()', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'sec-decision-integ-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('legacy check() still works identically (behavior matches new checkDecision)', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });

    const cases: Array<{ tool: string; input: Record<string, unknown> }> = [
      { tool: 'read_file', input: { path: 'a.txt' } },
      { tool: 'write_file', input: { path: 'a.txt', content: 'x' } },
      { tool: 'run_bash', input: { command: 'rm -rf /' } },
      { tool: 'run_bash', input: { command: 'echo hi' } },
    ];

    for (const c of cases) {
      const legacy = checker.check(c.tool, c.input);
      const modern = checker.checkDecision(c.tool, c.input, ctx);
      expect(modern.behavior).toBe(legacy.behavior);
    }
  });

  it('legacy check() signature unchanged — returns { behavior, reason }', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir });
    const d = checker.check('read_file', { path: 'a.txt' });
    // 只断言形状：旧契约必须保留
    expect(typeof d.behavior).toBe('string');
    expect(typeof d.reason).toBe('string');
  });
});
