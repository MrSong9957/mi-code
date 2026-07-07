// 回归测试：PreToolUse hook 接线（streaming-query.ts / streaming-executor.ts）
//
// 物理本质：双重门禁系统。
//   第一道门：PermissionChecker（在工具执行前检查）——生产路径已接，常在岗。
//   第二道门：PreToolUse hook（preToolSafetyCheck，危险命令二次校验）——
//     注册了，但生产路径（streamingQuery / StreamingToolExecutor）从不拨这个号码。
//   结果：双重防线退化为单道。hook 层的安全检查是死代码。
//
// 风险等级：🟠 权限（双防线失效，回退到单点）
// 出错后果：PermissionChecker 万一漏判某类危险命令（黑名单不全），
//   原本能被 hook 兜住，现在没人兜——直接执行。
//
// 测试策略：
//   - 正向基线：hook 本身工作正常（注册→触发→危险命令返回 exitCode 1）
//   - 正向基线：废弃路径 loop.ts 确实接了 hook（证明设计意图是接的）
//   - 缺口锁定：生产路径 streaming-query.ts / streaming-executor.ts 当前未接 hook
//     it.fails 锁定"应包含 hookRunner 调用"——接线后删 .fails。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { HookRunner } from '../src/hooks/runner.js';
import { preToolSafetyCheck } from '../src/hooks/builtins.js';
import type { HookEvent } from '../src/hooks/types.js';

// 读取源文件文本（用于接线性静态断言）
const SRC = resolve(__dirname, '..', 'src', 'agent');
const streamingQuerySrc = readFileSync(resolve(SRC, 'streaming-query.ts'), 'utf8');
const streamingExecutorSrc = readFileSync(resolve(SRC, 'streaming-executor.ts'), 'utf8');
const loopSrc = readFileSync(resolve(SRC, 'loop.ts'), 'utf8');

describe('PreToolUse hook 接线性回归', () => {
  // ── 正向基线：hook 本身正常工作 ──

  it('preToolSafetyCheck 对 sudo rm -rf 返回 exitCode 1（拦截）', async () => {
    const event: HookEvent = {
      name: 'PreToolUse',
      payload: {
        tool_name: 'run_bash',
        input: { command: 'sudo rm -rf /' },
      },
    };
    const result = preToolSafetyCheck(event);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('Dangerous command');
  });

  it('preToolSafetyCheck 对安全命令返回 exitCode 0（放行）', () => {
    const event: HookEvent = {
      name: 'PreToolUse',
      payload: {
        tool_name: 'run_bash',
        input: { command: 'ls -la' },
      },
    };
    const result = preToolSafetyCheck(event);
    expect(result.exitCode).toBe(0);
  });

  it('preToolSafetyCheck 对非 run_bash 工具放行', () => {
    const event: HookEvent = {
      name: 'PreToolUse',
      payload: { tool_name: 'write_file', input: { path: 'a.txt' } },
    };
    const result = preToolSafetyCheck(event);
    expect(result.exitCode).toBe(0);
  });

  it('HookRunner 注册后能触发 handler 并短路（exitCode 1）', async () => {
    const runner = new HookRunner();
    runner.register('PreToolUse', preToolSafetyCheck);
    const event: HookEvent = {
      name: 'PreToolUse',
      payload: { tool_name: 'run_bash', input: { command: 'mkfs.ext4 /dev/sda1' } },
    };
    const result = await runner.run(event);
    expect(result.exitCode).toBe(1);
  });

  // ── 正向基线：废弃路径 loop.ts 确实接了 hook（证明设计意图）──

  it('loop.ts（旧路径）接了 PreToolUse hook', () => {
    // 设计意图：主循环应在工具执行前跑 PreToolUse hook
    expect(loopSrc).toMatch(/PreToolUse|hookRunner\.run|preToolSafetyCheck/);
  });

  // ── 现状锁定（非 fails）：生产路径未接 hook ──

  it('现状：streaming-query.ts 不调用 hookRunner / PreToolUse', () => {
    // 生产主路径当前未接第二道防线
    expect(streamingQuerySrc).not.toMatch(/hookRunner|PreToolUse/);
  });

  it('现状：streaming-executor.ts 不调用 hookRunner / PreToolUse', () => {
    expect(streamingExecutorSrc).not.toMatch(/hookRunner|PreToolUse/);
  });

  // ── 缺口锁定（it.fails）：理想行为应接线 ──
  //
  // 理想：生产路径应在工具执行前调用 PreToolUse hook（与 loop.ts 设计一致）。
  // 当前未接——双重防线退化为单道（仅 PermissionChecker）。
  // it.fails 锁定"streaming-executor 应包含 hookRunner 调用"——
  // 接线后此测试会变红，提醒删 .fails 转正式断言。
  it.fails('streaming-executor.ts 应在工具执行前调用 PreToolUse hook [已知缺口：双重防线退化为单道]', () => {
    expect(streamingExecutorSrc).toMatch(/hookRunner|PreToolUse/);
  });
});
