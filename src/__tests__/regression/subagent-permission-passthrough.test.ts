// 回归测试：子代理权限透传（task / spawn_self_organizing / spawn_agent）
//
// 物理本质：总公司给外包团队配"门禁卡"。
// spawn_agent（正确）：派工时把门禁卡（PermissionChecker）交给外包，他刷卡进对应区域。
// task / spawn_self_organizing（缺口）：派工时忘了给门禁卡，外包变成"无证出入"，
// 他的 run_bash / write_file 不经任何权限闸门——子代理可任意写盘/执行命令。
//
// 风险等级：🔴 权限（子代理工具调用裸跑）
// 出错后果：父代理用户以为子代理受同样权限约束，实际子代理是特权用户，可越权。
//
// 测试策略：
//   - 注入 mock runner，捕获派工时传入的 SubagentOptions / SelfOrganizingOptions
//   - spawn_agent 正向基线：必须常绿（透传了 checker）
//   - task / spawn_self_organizing 缺口：用 it.fails 锁定"应传 checker 但没传"
//   - 修复后删 .fails 转正式断言

import { describe, it, expect, vi } from 'vitest';
import { createSpawnAgentTool } from '../../../src/agent/tools/spawn-agent-tool.js';
import { createTaskTool } from '../../../src/agent/tools/task-tool.js';
import { createSpawnSelfOrganizingTool } from '../../../src/agent/tools/spawn-self-organizing-tool.js';
import { ToolRegistry } from '../../../src/agent/tool-registry.js';
import { PermissionChecker } from '../../../src/permission/checker.js';
import { TodoManager } from '../../../src/agent/todo.js';
import { InboxManager } from '../../../src/agent/inbox.js';
import type { SubagentOptions, SubagentResult } from '../../../src/agent/subagent.js';
import type { SelfOrganizingOptions } from '../../../src/agent/self-organizing.js';

const fakeRegistry = new ToolRegistry();

function makeFakeRunner(capture: { options: SubagentOptions | null }) {
  return vi.fn(
    async (_prompt: string, _tools: ToolRegistry, options: SubagentOptions): Promise<SubagentResult> => {
      capture.options = options;
      return { text: 'done', isBackground: false };
    },
  );
}

describe('子代理权限透传回归', () => {
  // ── 正向基线：spawn_agent 正确透传 permissionChecker ──

  it('spawn_agent 把 permissionChecker 透传给 runner', async () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const captured = { options: null as SubagentOptions | null };
    const tool = createSpawnAgentTool(
      fakeRegistry,
      undefined,
      checker,
      makeFakeRunner(captured),
    );
    await tool.executor({ role: 'general', prompt: 'do something' });
    expect(captured.options).not.toBeNull();
    // 正向基线：spawn_agent 必须把 checker 交给子代理
    expect(captured.options!.permissionChecker).toBe(checker);
  });

  // ── 缺口 #1：task 工具不传 permissionChecker ──
  //
  // task-tool.ts:66 调 runSubagentFn 时 options 只含 cwd/model，无 permissionChecker。
  // 即便父代理有 checker，task 派出的子代理也裸跑。
  // 本测试断言"应透传 checker"——因缺口存在，断言失败；
  // it.fails 把失败标绿。修复后（task 工具签名加 checker 并透传）删 .fails。
  it.fails('task 工具应透传 permissionChecker [已知缺口：当前不传，子代理裸跑]', async () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const captured = { options: null as SubagentOptions | null };
    // 注意：task 工具当前签名根本不接受 permissionChecker 参数（createTaskTool 没这个形参）
    // 这里只能验证"派工 options 里没有 checker"——要让它有，需先改 createTaskTool 签名
    const tool = createTaskTool(fakeRegistry, undefined, undefined, makeFakeRunner(captured));
    await tool.executor({ prompt: 'do something' });
    expect(captured.options).not.toBeNull();
    expect(captured.options!.permissionChecker).toBe(checker);
  });

  // 现状锁定（非 fails）：确认 task 当前确实没传 checker——这条常绿
  it('task 工具现状：派工 options 不含 permissionChecker', async () => {
    const captured = { options: null as SubagentOptions | null };
    const tool = createTaskTool(fakeRegistry, undefined, undefined, makeFakeRunner(captured));
    await tool.executor({ prompt: 'do something' });
    expect(captured.options).not.toBeNull();
    expect(captured.options!.permissionChecker).toBeUndefined();
  });

  // ── 缺口 #2：spawn_self_organizing 工具不传 permissionChecker ──

  it('spawn_self_organizing 现状：派工 options 不含 permissionChecker', async () => {
    const captured: { options: SelfOrganizingOptions[] } = { options: [] };
    const fakeRunner = vi.fn(
      async (
        _name: string,
        _role: string,
        _identity: string,
        _tools: ToolRegistry,
        _todo: TodoManager,
        _inbox: InboxManager,
        options: SelfOrganizingOptions,
      ): Promise<string> => {
        captured.options.push(options);
        return 'done';
      },
    );
    const todoManager = new TodoManager();
    const inboxManager = new InboxManager();
    const tool = createSpawnSelfOrganizingTool(fakeRegistry, todoManager, inboxManager, {
      runFn: fakeRunner,
    });
    await tool.executor({
      name: 'worker-1',
      role: 'coder',
      identity: 'a worker',
      prompt: 'do work',
    });
    expect(captured.options).toHaveLength(1);
    // 现状：selfOrgOptions 里没有 permissionChecker 字段
    expect((captured.options[0] as SubagentOptions).permissionChecker).toBeUndefined();
  });

  // ── 缺口 #2 已修复：spawn_self_organizing 现在透传 permissionChecker ──
  //
  // 修复后 SelfOrganizingOptions 类型含 permissionChecker 字段，
  // createSpawnSelfOrganizingTool 签名也接受 permissionChecker 并透传。
  // 原 it.fails 已转为正式断言。
  it('spawn_self_organizing 派工 options 应含 permissionChecker 键', async () => {
    const captured: { options: SelfOrganizingOptions[] } = { options: [] };
    const fakeRunner = vi.fn(
      async (
        _n: string,
        _r: string,
        _i: string,
        _t: ToolRegistry,
        _todo: TodoManager,
        _inbox: InboxManager,
        options: SelfOrganizingOptions,
      ): Promise<string> => {
        captured.options.push(options);
        return 'done';
      },
    );
    const todoManager = new TodoManager();
    const inboxManager = new InboxManager();
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const tool = createSpawnSelfOrganizingTool(fakeRegistry, todoManager, inboxManager, {
      runFn: fakeRunner,
      permissionChecker: checker,
    });
    await tool.executor({ name: 'w', role: 'coder', identity: 'i', prompt: 'p' });
    expect(captured.options).toHaveLength(1);
    // 修复后：options 上存在 permissionChecker 键
    expect('permissionChecker' in captured.options[0]).toBe(true);
    expect(captured.options[0].permissionChecker).toBe(checker);
  });
});
