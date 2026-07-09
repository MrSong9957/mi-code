// Plan 模式工具集与提示词注入测试
//
// 物理本质：验证 plan 模式下"工具箱里的锤子被收走，只剩放大镜"。
// 这个测试不跑真实 LLM，只验证 plan/build 模式下传给 LLM 的工具列表差异
// 以及 PermissionChecker 的 plan 分支覆盖了所有写工具（防止漏网）。
import { describe, it, expect } from 'vitest';
import { PermissionChecker } from '../permission/checker.js';
import { WRITE_TOOLS, READ_ONLY_TOOLS } from '../permission/types.js';

describe('Plan 模式工具集与权限覆盖', () => {
  it('WRITE_TOOLS 覆盖所有改变系统状态的工具', () => {
    // 关键写工具必须在 WRITE_TOOLS 里
    // 注：run_bash 不在 WRITE_TOOLS 中——plan 模式下它保留可见，
    // 由 PermissionChecker 的 isWriteBash 在执行前精细判定。
    const mustHave = [
      'write_file', 'edit_file',
      'schedule_create', 'schedule_update', 'schedule_remove',
      'background', 'worktree', 'mark_task_done', 'claim_task',
      'submit_plan', 'approve_plan', 'send_message',
      'spawn_self_organizing', 'spawn_agent', 'memory_write',
    ];
    for (const name of mustHave) {
      expect(WRITE_TOOLS, `WRITE_TOOLS 应包含 ${name}`).toContain(name);
    }
  });

  it('run_bash 不在 WRITE_TOOLS 中（plan 模式保留可见，靠 PermissionChecker 拦写命令）', () => {
    expect(WRITE_TOOLS).not.toContain('run_bash');
  });

  it('todo_write 不在 WRITE_TOOLS 中（plan 模式允许维护 TODO）', () => {
    expect(WRITE_TOOLS).not.toContain('todo_write');
  });

  it('READ_ONLY_TOOLS 与 WRITE_TOOLS 不重叠', () => {
    // 一个工具不能既"只读"又"写"——逻辑互斥
    for (const t of READ_ONLY_TOOLS) {
      expect(WRITE_TOOLS, `${t} 不应同时出现在两个清单`).not.toContain(t);
    }
  });

  it('plan 模式：所有 WRITE_TOOLS 都被 PermissionChecker deny', () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    for (const tool of WRITE_TOOLS) {
      const decision = checker.check(tool, {});
      expect(decision.behavior, `plan 模式应 deny ${tool}`).toBe('deny');
    }
  });

  it('plan 模式：run_bash 写命令 deny / 只读命令 allow', () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    expect(checker.check('run_bash', { command: 'mkdir x' }).behavior).toBe('deny');
    expect(checker.check('run_bash', { command: 'echo > f' }).behavior).toBe('deny');
    expect(checker.check('run_bash', { command: 'git commit -m x' }).behavior).toBe('deny');
    expect(checker.check('run_bash', { command: 'ls' }).behavior).toBe('allow');
    expect(checker.check('run_bash', { command: 'cat f' }).behavior).toBe('allow');
  });

  it('plan 模式：read_file / todo_write 等 READ_ONLY 工具放行', () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    for (const tool of READ_ONLY_TOOLS) {
      const decision = checker.check(tool, {});
      expect(decision.behavior, `plan 模式应 allow ${tool}`).toBe('allow');
    }
  });

  it('build 模式：写工具不被 plan 闸门预拦（走到闸门4）', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    // write_file 在 build 模式下应到闸门4 ask（非 plan deny）
    const d = checker.check('write_file', { path: 'a.txt', content: 'x' });
    expect(d.behavior).not.toBe('deny');
  });
});

/**
 * 工具列表过滤逻辑测试。
 *
 * 复刻 index.ts 中的过滤行为，确保 plan 模式下传给 LLM 的工具列表
 * 真正剔除了 WRITE_TOOLS。
 */
describe('Plan 模式工具列表过滤', () => {
  // 仿照 index.ts 的过滤逻辑
  function filterToolsForMode(
    allNames: string[],
    mode: 'build' | 'plan' | 'auto',
  ): string[] {
    return mode === 'plan'
      ? allNames.filter(n => !WRITE_TOOLS.includes(n))
      : allNames;
  }

  const ALL_TOOLS = [
    ...READ_ONLY_TOOLS,
    ...WRITE_TOOLS,
    // 加几个虚构的"额外"工具，确保过滤只动 WRITE_TOOLS
    'read_inbox', 'idle', 'memory_read', 'memory_list',
  ];

  it('plan 模式：过滤后不含任何 WRITE_TOOLS', () => {
    const filtered = filterToolsForMode(ALL_TOOLS, 'plan');
    for (const w of WRITE_TOOLS) {
      expect(filtered, `plan 模式工具列表不应包含 ${w}`).not.toContain(w);
    }
  });

  it('plan 模式：过滤后仍含只读工具', () => {
    const filtered = filterToolsForMode(ALL_TOOLS, 'plan');
    for (const r of READ_ONLY_TOOLS) {
      expect(filtered).toContain(r);
    }
  });

  it('build 模式：保留全部工具（无过滤）', () => {
    const filtered = filterToolsForMode(ALL_TOOLS, 'build');
    expect(filtered).toEqual(ALL_TOOLS);
  });

  it('auto 模式：保留全部工具（无过滤）', () => {
    const filtered = filterToolsForMode(ALL_TOOLS, 'auto');
    expect(filtered).toEqual(ALL_TOOLS);
  });
});
