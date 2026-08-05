// Code Review Critical 回归测试：非 auto 模式（build）的 ask 决策不得进入 auto askResolver。
//
// 锁定真实故障路径：
//   permission mode = build
//   write_file checker 决策 = ask（build 契约）
//   runtime 故意提供 askResolver（若被调用，返回 allow）
//   user-decision channel = null
//   executor 用 spy 证明是否真正执行
//
// 期望（GREEN 后）：
//   1. askResolver 在 build 模式下不得被调用
//   2. write_file 不得执行
//   3. ask 继续进入正常 gate，因无 channel 而 fail closed
import { describe, it, expect, vi } from 'vitest';
import { executeToolCall } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import type { ToolExecutionRuntime } from '../../agent/tool-execution.js';
import type { PermissionAskResolver, PermissionAskResolutionRequest } from '../../permission/ask-resolver.js';
import type { SecurityDecision } from '../../permission/decisions.js';
import type { ToolUseBlock } from '../../agent/types.js';

// 内存 pending store（与 helper 一致）
class InMemoryPendingStore {
  private decisions: any[] = [];
  async save(p: any) { this.decisions.push({ ...p }); }
  async load() { return this.decisions; }
  async update() {}
}

describe('Critical 回归：build 模式 ask 不得经 resolver 放行', () => {
  it('build 模式 write_file：askResolver 不被调用，executor 不执行，fail closed', async () => {
    // 1. build 模式 checker —— write_file 应返回 ask
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const checkDecision = checker.check('write_file', { path: 'a.txt', content: 'x' });
    // 前置确认：build 模式 write_file 确为 ask（若不是，测试前提不成立）
    expect(checkDecision.behavior).toBe('ask');

    // 2. askResolver stub：若被调用，返回 allow（模拟 acceptEdits sim 放行）
    //    用 spy 记录是否被调用
    const resolverResolve = vi.fn(async (_req: PermissionAskResolutionRequest): Promise<Partial<SecurityDecision>> => {
      return { behavior: 'allow', reason_code: 'permission.auto_allowlist' };
    });
    const askResolver: PermissionAskResolver = { resolve: resolverResolve };

    // 3. executor spy：记录 write_file 是否真的执行
    const executor = vi.fn(async () => 'should-not-run');
    const registry = new ToolRegistry();
    registry.register(
      { name: 'write_file', description: 'w', parameters: { type: 'object', properties: {}, required: [] } },
      executor,
    );

    // 4. runtime：channel=null（无用户决策通道），故意挂 askResolver
    const runtime: ToolExecutionRuntime = {
      permissionChecker: checker,
      runtimeGate: new RuntimeSecurityGate({
        pendingStore: new InMemoryPendingStore() as any,
        channel: null,
        sessionId: 'build-guard-test',
      }),
      askResolver,
    };

    const call: ToolUseBlock = {
      type: 'tool_use',
      id: 'call-build-guard',
      name: 'write_file',
      input: { path: 'a.txt', content: 'x' },
    };

    // 5. 执行
    const result = await executeToolCall(registry, call, runtime);

    // 期望 1：askResolver 在 build 模式下不得被调用
    expect(resolverResolve).not.toHaveBeenCalled();

    // 期望 2：write_file 不得执行
    expect(executor).not.toHaveBeenCalled();

    // 期望 3：ask 继续进入正常 gate，因无 channel 而 fail closed
    expect(result.status).toBe('failure');
    expect(result.output).toContain('Asking the user is required, but no user-decision channel is available.');
  });
});
