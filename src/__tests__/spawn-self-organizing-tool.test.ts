// spawn_self_organizing 工具测试
//
// 物理本质：验证"招临时工"这个动作本身。
// 真正的临时工（runSelfOrganizingSubagent）需要连真实 LLM，测不了也没必要。
// 所以这里测的是"招工流程"：招工单填对了没？工头真的去招了没？招完立刻有回执（不堵门）？
import { describe, it, expect, vi } from 'vitest';
import { createSpawnSelfOrganizingTool } from '../agent/tools/spawn-self-organizing-tool.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import { TodoManager } from '../agent/todo.js';
import { InboxManager } from '../agent/inbox.js';
import { createToolExecutionRuntime } from './helpers/tool-execution-runtime.js';

describe('createSpawnSelfOrganizingTool', () => {
  function makeDeps() {
    return {
      childTools: new ToolRegistry(),
      todoManager: new TodoManager(),
      inboxManager: new InboxManager(),
    };
  }

  it('工具定义：name 应为 spawn_self_organizing，必填参数齐全', () => {
    const { childTools, todoManager, inboxManager } = makeDeps();
    const { definition } = createSpawnSelfOrganizingTool(
      childTools, todoManager, inboxManager,
      { executionRuntime: createToolExecutionRuntime() },
    );

    expect(definition.name).toBe('spawn_self_organizing');
    expect(definition.parameters.required).toEqual(
      expect.arrayContaining(['name', 'role', 'identity', 'prompt']),
    );
  });

  it('executor 应立即返回（不阻塞），且后台启动 self-organizing', async () => {
    const { childTools, todoManager, inboxManager } = makeDeps();
    const runFn = vi.fn().mockResolvedValue('done');
    const { executor } = createSpawnSelfOrganizingTool(
      childTools, todoManager, inboxManager, {
        model: 'small-model', runFn, executionRuntime: createToolExecutionRuntime(),
      },
    );

    const start = Date.now();
    const ret = await executor({
      name: 'worker-1',
      role: 'coder',
      identity: 'You write TypeScript.',
      prompt: 'Fix all lint errors.',
    });
    const elapsed = Date.now() - start;

    // 立即返回（runFn 被 mock 成立刻 resolve，但后台启动意味着即使 runFn 慢也不会阻塞；
    // 这里 runFn 立刻 resolve，elapsed 应极小）
    expect(elapsed).toBeLessThan(100);
    // 返回非空字符串（回执）
    expect(typeof ret).toBe('string');
    expect(ret.length).toBeGreaterThan(0);
    // runFn 被以正确参数调用
    expect(runFn).toHaveBeenCalledTimes(1);
    const [name, role, identity, , , , opts] = runFn.mock.calls[0]!;
    expect(name).toBe('worker-1');
    expect(role).toBe('coder');
    // prompt 被拼进 identity 末尾作为初始任务
    expect(identity).toContain('You write TypeScript.');
    expect(identity).toContain('Fix all lint errors.');
    expect(opts).toMatchObject({ model: 'small-model' });
  });

  it('后台 promise 的错误应被吞掉，不产生 unhandledRejection', async () => {
    const { childTools, todoManager, inboxManager } = makeDeps();
    let rejectionCaught = false;
    const onUnhandled = () => { rejectionCaught = true; };
    process.once('unhandledRejection', onUnhandled);

    const runFn = vi.fn().mockRejectedValue(new Error('LLM down'));
    const { executor } = createSpawnSelfOrganizingTool(
      childTools, todoManager, inboxManager, {
        runFn, executionRuntime: createToolExecutionRuntime(),
      },
    );

    await executor({
      name: 'worker-2', role: 'coder', identity: 'x', prompt: 'y',
    });
    // 等待后台 promise 有机会 reject
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(rejectionCaught).toBe(false);
    process.removeListener('unhandledRejection', onUnhandled);
  });
});
