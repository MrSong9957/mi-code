import { describe, it, expect, vi } from 'vitest';
import { PermissionChecker } from '../../permission/checker.js';

describe('PermissionChecker reason_code 产出', () => {
  // 危险命令(已有码,保持)
  it('危险命令 → permission.dangerous_command', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('run_bash', { command: 'rm -rf /home' });
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.dangerous_command');
  });

  // 路径越界(已有码,保持)
  it('bash 路径越界 → permission.path_outside_workspace', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('run_bash', { command: 'cat /etc/passwd' });
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.path_outside_workspace');
  });

  // 不可解析(已有码,保持)— shell-quote 极度宽容,用 spy 触发 parseFailed
  it('parseFailed → permission.command_unparseable', async () => {
    const bashPaths = await import('../../permission/bash-paths.js');
    vi.spyOn(bashPaths, 'extractBashPaths').mockReturnValue({
      paths: [], parseFailed: true, unresolvableVars: false,
    });
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('run_bash', { command: 'whatever' });
    expect(d.behavior).toBe('ask');
    expect(d.reason_code).toBe('permission.command_unparseable');
    vi.restoreAllMocks();
  });

  // ★ 变量未知(新增码 — 当前缺口)
  it('变量未知 bash → permission.command_unresolvable_var(新增)', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('run_bash', { command: 'echo $UNDEFINED_VAR_XYZ' });
    expect(d.behavior).toBe('ask');
    expect(d.reason_code).toBe('permission.command_unresolvable_var');
  });

  // 用户 deny 规则(已有码,保持)
  it('deny 规则 → permission.rule_deny', () => {
    const c = new PermissionChecker({
      mode: 'build', workdir: process.cwd(),
      rules: [{ tool: 'write_file', behavior: 'deny' }],
    });
    const d = c.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.rule_deny');
  });

  // plan 写(已有码,保持)
  it('plan write_file → permission.plan_write_blocked', () => {
    const c = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    const d = c.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.plan_write_blocked');
  });

  // auto 放行(保持 default — 不引入新码)
  it('auto write_file → permission.default(保持)', () => {
    const c = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
    const d = c.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(d.behavior).toBe('allow');
    expect(d.reason_code).toBe('permission.default');
  });

  // allow 规则(已有码,保持)
  it('allow 规则 → permission.rule_allow', () => {
    const c = new PermissionChecker({
      mode: 'build', workdir: process.cwd(),
      rules: [{ tool: 'write_file', behavior: 'allow', path: 'allowed.txt' }],
    });
    const d = c.check('write_file', { path: 'allowed.txt', content: 'x' });
    expect(d.behavior).toBe('allow');
    expect(d.reason_code).toBe('permission.rule_allow');
  });

  // 只读默认(保持 default — security-decision-integration.test.ts:43 锁定)
  it('build read_file → permission.default(保持)', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('read_file', { path: 'inside.txt' });
    expect(d.behavior).toBe('allow');
    expect(d.reason_code).toBe('permission.default');
  });

  // ★ build 写确认(下游路由的关键码,保持 user_confirmation_required)
  it('build write_file → permission.user_confirmation_required', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(d.behavior).toBe('ask');
    expect(d.reason_code).toBe('permission.user_confirmation_required');
  });
});
