// 回归测试：流式路径权限放行行为（streaming-query.ts / streaming-executor.ts）
//
// 物理本质：银行柜台"需要经理签字"的窗口。
//
// ── Wave B Task 13 (M-066) cutover ──
// 旧:ask 在流式路径静默放行(无用户确认通道)。
// 新:接入 RuntimeSecurityGate 后,ask 在 approved_once 到位前**必须阻塞**——
//   executor 调用次数 = 0;channel=null 时直接 deny(ask.no_channel),
//   绝不偷偷降级为 allow。
//
// 风险等级：🔴 权限（写操作零确认执行）
//
// 本测试通过 StreamingToolExecutor（生产执行器）验证：
//   1. deny（plan 模式写、危险命令、越界路径）→ 必须拦截
//   2. allow（auto 模式、只读操作）→ 放行
//   3. ask 无 channel → fail closed
//   4. ask 有 channel → approved_once 到位前 executor 零调用
//
// 测试不接真实 LLM/网络，仅驱动 executor + 注入假 registry / gate。

import { describe, it, expect } from 'vitest';
import { StreamingToolExecutor } from '../../../src/agent/streaming-executor.js';
import type { ToolExecutionRuntime } from '../../../src/agent/tool-execution.js';
import { ToolRegistry } from '../../../src/agent/tool-registry.js';
import { PermissionChecker } from '../../../src/permission/checker.js';
import type { ToolUseBlock } from '../../../src/agent/types.js';
import {
  RuntimeSecurityGate,
  type PendingDecisionStore,
  type PendingSecurityDecision,
  type UserDecisionChannel,
} from '../../../src/permission/runtime-gate.js';
import {
  createSecurityDecision,
  SECURITY_PROTOCOL_VERSION,
  type SecurityDecision,
  type UserDecision,
} from '../../../src/permission/decisions.js';

class NoopPendingDecisionStore implements PendingDecisionStore {
  async save(_pending: PendingSecurityDecision): Promise<void> {}
  async load(_sessionId: string): Promise<readonly PendingSecurityDecision[]> {
    return [];
  }
  async update(
    _decisionId: string,
    _update: Partial<PendingSecurityDecision>,
  ): Promise<void> {}
}

function runtimeFor(
  checker: PermissionChecker,
  gate = new RuntimeSecurityGate({
    pendingStore: new NoopPendingDecisionStore(),
    channel: null,
  }),
): ToolExecutionRuntime {
  return { permissionChecker: checker, runtimeGate: gate };
}

/** 构造一个假 registry：记录执行结果，不真跑副作用 */
function makeFakeRegistry(executed: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'write_file', description: 'fake', parameters: { type: 'object', properties: {}, required: [] } },
    async (input) => {
      executed.push(`write_file:${(input.path as string) ?? ''}`);
      return 'written';
    },
  );
  registry.register(
    { name: 'read_file', description: 'fake', parameters: { type: 'object', properties: {}, required: [] } },
    async (input) => {
      executed.push(`read_file:${(input.path as string) ?? ''}`);
      return 'content';
    },
  );
  registry.register(
    { name: 'run_bash', description: 'fake', parameters: { type: 'object', properties: {}, required: [] } },
    async (input) => {
      executed.push(`run_bash:${(input.command as string) ?? ''}`);
      return 'done';
    },
  );
  return registry;
}

/** 判断 executor 是否真执行了工具（副作用是否发生） */
async function didExecute(
  registry: ToolRegistry,
  checker: PermissionChecker,
  block: ToolUseBlock,
): Promise<boolean> {
  const executed: string[] = [];
  // 把 registry 包一层：用新的 fake registry 复用闭包 executed
  const probe = new ToolRegistry();
  probe.register(
    { name: block.name, description: 'probe', parameters: { type: 'object', properties: {}, required: [] } },
    async (input) => {
      executed.push(JSON.stringify(input));
      return 'ok';
    },
  );
  const exec = new StreamingToolExecutor(
    probe,
    runtimeFor(checker),
    new AbortController().signal,
  );
  exec.addTool(block);
  // 等待异步队列跑完
  await new Promise((r) => setTimeout(r, 50));
  for await (const _ of exec.getRemainingResults()) {
    void _;
  }
  await new Promise((r) => setTimeout(r, 20));
  return executed.length > 0;
}

/** 取回 executor 执行后写回的模型可见 output 文本。 */
async function getResultText(
  checker: PermissionChecker,
  block: ToolUseBlock,
): Promise<string | null> {
  const probe = new ToolRegistry();
  probe.register(
    { name: block.name, description: 'probe', parameters: { type: 'object', properties: {}, required: [] } },
    async () => 'EXECUTED',
  );
  const exec = new StreamingToolExecutor(
    probe,
    runtimeFor(checker),
    new AbortController().signal,
  );
  exec.addTool(block);
  await new Promise((r) => setTimeout(r, 50));
  // getRemainingResults 吐出按顺序的批次，取该工具的 results
  let text: string | null = null;
  for await (const batch of exec.getRemainingResults()) {
    for (const t of batch) {
      if (t.results && t.results.length > 0 && t.results[0].type === 'text') {
        text = (t.results[0] as { text: string }).text;
      }
    }
  }
  await new Promise((r) => setTimeout(r, 20));
  return text;
}

describe('流式权限放行回归（StreamingToolExecutor）', () => {
  // ── 正向基线：deny 必须真正拦截 ──

  it('plan 模式 write_file 被 deny：返回拒绝原因，副作用不发生', async () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 't1',
      name: 'write_file',
      input: { path: 'inside.txt', content: 'x' },
    };
    const text = await getResultText(checker, block);
    expect(text).not.toBe('EXECUTED');

    const ran = await didExecute(new ToolRegistry(), checker, block);
    expect(ran).toBe(false);
  });

  it('任意模式危险命令 rm -rf 被 deny', async () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 't2',
      name: 'run_bash',
      input: { command: 'rm -rf /home' },
    };
    const text = await getResultText(checker, block);
    expect(text).not.toBe('EXECUTED');
  });

  it('越界写路径被 deny', async () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 't3',
      name: 'write_file',
      input: { path: '../../../etc/passwd', content: 'x' },
    };
    const text = await getResultText(checker, block);
    expect(text).not.toBe('EXECUTED');
  });

  // ── 正向基线：allow 正确放行 ──

  it('auto 模式 write_file 放行执行', async () => {
    const checker = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 't4',
      name: 'write_file',
      input: { path: 'inside.txt', content: 'x' },
    };
    const text = await getResultText(checker, block);
    expect(text).toBe('EXECUTED');
  });

  it('build 模式 read_file 放行执行', async () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 't5',
      name: 'read_file',
      input: { path: 'inside.txt' },
    };
    const text = await getResultText(checker, block);
    expect(text).toBe('EXECUTED');
  });

  // ── 回归核心：ask 静默放行缺口锁定 ──
  //
  // PermissionChecker 对 build 模式 write_file 返回 ask（单元层确认）。
  //
  // 统一入口要求 RuntimeSecurityGate；ask 在 approved_once 到位前必须阻塞。
  it('PermissionChecker 对 build 模式 write_file 返回 ask（决策源头）', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const decision = checker.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(decision.behavior).toBe('ask');
  });

  it('统一入口: ask 无用户通道时工具不执行', async () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 't6',
      name: 'write_file',
      input: { path: 'inside.txt', content: 'x' },
    };
    const ran = await didExecute(new ToolRegistry(), checker, block);
    expect(ran).toBe(false);
  });

  // ═══════════════════════════════════════════
  // NEW 路径(Wave B Task 13):runtimeGate 接入 → ask 必须阻塞
  // ═══════════════════════════════════════════
  //
  // 接入 RuntimeSecurityGate 后,生产执行器必须:
  //   - ask 在 approved_once 到位前,executor(底层 registry.execute)零调用;
  //   - approved_once 到位后,executor 被调用一次;
  //   - 无 channel → 直接 deny(不降级为 allow);
  //   - 用户 reject → 直接 deny。

  /** 内存版 PendingDecisionStore(供 gate 测试)。 */
  class InMemoryPendingDecisionStore implements PendingDecisionStore {
    public saved: PendingSecurityDecision[] = [];
    async save(p: PendingSecurityDecision): Promise<void> { this.saved.push({ ...p }); }
    async load(_s: string): Promise<readonly PendingSecurityDecision[]> { return [...this.saved]; }
    async update(_id: string, _u: Partial<PendingSecurityDecision>): Promise<void> { /* no-op */ }
  }

  /** 延迟版 UserDecisionChannel(供 gate 测试)。 */
  class DeferredChannel implements UserDecisionChannel {
    public requests: SecurityDecision[] = [];
    private d: { resolve: (d: UserDecision) => void; reject: (e: unknown) => void } | null = null;
    async request(decision: SecurityDecision): Promise<UserDecision> {
      this.requests.push(decision);
      return new Promise<UserDecision>((resolve, reject) => { this.d = { resolve, reject }; });
    }
    resolve(u: UserDecision): void { const d = this.d!; this.d = null; d.resolve(u); }
    rejectChannel(e: unknown): void { const d = this.d!; this.d = null; d.reject(e); }
  }

  /** 构造一个 ask 类型的 SecurityDecision(走 build 模式 write_file 的真实管道)。 */
  function makeAskDecision(
    checker: PermissionChecker,
    input: Record<string, unknown>,
    decisionId: string,
  ): SecurityDecision {
    return checker.checkDecision('write_file', input, {
      decision_id: decisionId,
      action_snapshot_id: `snap-${decisionId}`,
      policy_id: 'permission-default',
      policy_version: '1',
    });
  }

  it('NEW 路径: ask + gate + channel,approved_once 到位前底层 executor 零调用', async () => {
    const spy: string[] = [];
    const probe = new ToolRegistry();
    probe.register(
      { name: 'write_file', description: 'probe', parameters: { type: 'object', properties: {}, required: [] } },
      async (input) => { spy.push(`write_file:${input.path}`); return 'written'; },
    );
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const gate = new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingDecisionStore(),
      channel: new DeferredChannel(),
    });
    const exec = new StreamingToolExecutor(
      probe,
      runtimeFor(checker, gate),
      new AbortController().signal,
    );

    const block: ToolUseBlock = {
      type: 'tool_use', id: 't-ask', name: 'write_file',
      input: { path: 'inside.txt', content: 'x' },
    };
    exec.addTool(block);

    // 让微任务队列跑几轮:addTool 内部的 processQueue 已 await executeTool 进了 gate.execute
    await new Promise((r) => setTimeout(r, 30));

    // 关键断言:approved_once 到位前,底层 executor(registry.execute)调用次数 = 0
    expect(spy).toHaveLength(0);

    // 取出 gate 的 channel 并 resolve approved_once
    const channel = (gate as unknown as { options: { channel: DeferredChannel } }).options.channel;
    expect(channel.requests).toHaveLength(1);
    channel.resolve({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: channel.requests[0]!.decision_id,
      response: 'approved_once',
      decided_at: '2026-07-26T00:00:00Z',
    });

    // 等 executor 收尾
    for await (const _ of exec.getRemainingResults()) { void _; }
    await new Promise((r) => setTimeout(r, 20));

    // approved_once 到位后,executor 被调用一次
    expect(spy).toEqual(['write_file:inside.txt']);
  });

  it('统一入口: ask + gate 无 channel → 返回拒绝原因，executor 零调用', async () => {
    const spy: string[] = [];
    const probe = new ToolRegistry();
    probe.register(
      { name: 'write_file', description: 'probe', parameters: { type: 'object', properties: {}, required: [] } },
      async (input) => { spy.push(`write_file:${input.path}`); return 'written'; },
    );
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    // 无 channel → fail closed
    const gate = new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingDecisionStore(),
      channel: null,
    });
    const exec = new StreamingToolExecutor(
      probe,
      runtimeFor(checker, gate),
      new AbortController().signal,
    );

    const block: ToolUseBlock = {
      type: 'tool_use', id: 't-nochannel', name: 'write_file',
      input: { path: 'inside.txt', content: 'x' },
    };
    exec.addTool(block);

    await new Promise((r) => setTimeout(r, 30));

    expect(spy).toHaveLength(0); // 未执行

    // 取回结果：必须不是 executor 的成功输出。
    let text: string | null = null;
    for await (const batch of exec.getRemainingResults()) {
      for (const t of batch) {
        if (t.results && t.results.length > 0 && t.results[0].type === 'text') {
          text = (t.results[0] as { text: string }).text;
        }
      }
    }
    expect(text).not.toBe('written');
  });

  it('统一入口: deny 仍然拦截(executor 零调用,返回拒绝原因)', async () => {
    const spy: string[] = [];
    const probe = new ToolRegistry();
    probe.register(
      { name: 'write_file', description: 'probe', parameters: { type: 'object', properties: {}, required: [] } },
      async (input) => { spy.push(`write_file:${input.path}`); return 'written'; },
    );
    // plan 模式 → write_file 必 deny
    const checker = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    const gate = new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingDecisionStore(),
      channel: new DeferredChannel(),
    });
    const exec = new StreamingToolExecutor(
      probe,
      runtimeFor(checker, gate),
      new AbortController().signal,
    );

    const block: ToolUseBlock = {
      type: 'tool_use', id: 't-deny', name: 'write_file',
      input: { path: 'inside.txt', content: 'x' },
    };
    exec.addTool(block);

    await new Promise((r) => setTimeout(r, 30));
    expect(spy).toHaveLength(0); // deny 不执行

    let text: string | null = null;
    for await (const batch of exec.getRemainingResults()) {
      for (const t of batch) {
        if (t.results && t.results.length > 0 && t.results[0].type === 'text') {
          text = (t.results[0] as { text: string }).text;
        }
      }
    }
    expect(text).not.toBe('written');
  });

  it('NEW 路径: allow 仍然放行(executor 被调用一次,结果=EXECUTED)', async () => {
    const spy: string[] = [];
    const probe = new ToolRegistry();
    probe.register(
      { name: 'read_file', description: 'probe', parameters: { type: 'object', properties: {}, required: [] } },
      async (input) => { spy.push(`read_file:${input.path}`); return 'EXECUTED'; },
    );
    // build 模式 → read_file 必 allow
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const gate = new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingDecisionStore(),
      channel: new DeferredChannel(),
    });
    const exec = new StreamingToolExecutor(
      probe,
      runtimeFor(checker, gate),
      new AbortController().signal,
    );

    const block: ToolUseBlock = {
      type: 'tool_use', id: 't-allow', name: 'read_file',
      input: { path: 'inside.txt' },
    };
    exec.addTool(block);

    let text: string | null = null;
    for await (const batch of exec.getRemainingResults()) {
      for (const t of batch) {
        if (t.results && t.results.length > 0 && t.results[0].type === 'text') {
          text = (t.results[0] as { text: string }).text;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 20));

    expect(spy).toEqual(['read_file:inside.txt']);
    expect(text).toBe('EXECUTED');
  });

  // makeAskDecision 留作未来扩展(当前 NEW 路径测试通过 StreamingToolExecutor 内部
  // 自动构造 decision,直接复用 checker.checkDecision)。
  void makeAskDecision;
});
