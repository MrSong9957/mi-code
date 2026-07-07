// 回归测试：流式路径权限放行行为（streaming-query.ts / streaming-executor.ts）
//
// 物理本质：银行柜台"需要经理签字"的窗口，经理却不在岗。
// PermissionChecker 对写操作默认返回 ask（需要用户确认），
// 但流式路径（生产主路径）没有用户确认通道，于是 ask 被静默放行。
// 结果：build 模式下 write_file/edit_file/run_bash 写命令"看似要确认、实则直接执行"。
//
// 风险等级：🔴 权限（写操作零确认执行）
// 出错后果：用户以为写操作会被询问，实际无人拦——AI 可任意改文件/跑命令。
//
// 本测试通过 StreamingToolExecutor（生产执行器）验证三档行为：
//   1. deny（plan 模式写、危险命令、越界路径）→ 必须拦截，结果含 [Blocked by permission]
//   2. ask（build 模式写操作）→ 当前放行（已知缺口），用 it.fails 锁定"应被拦但没拦"
//   3. allow（auto 模式、只读操作）→ 放行（正确）
//
// 测试不接真实 LLM/网络，仅驱动 executor + 注入假 registry。

import { describe, it, expect } from 'vitest';
import { StreamingToolExecutor } from '../src/agent/streaming-executor.js';
import { ToolRegistry } from '../src/agent/tool-registry.js';
import { PermissionChecker } from '../src/permission/checker.js';
import type { ToolUseBlock } from '../src/agent/types.js';

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
  const exec = new StreamingToolExecutor(probe, checker);
  exec.addTool(block);
  // 等待异步队列跑完
  await new Promise((r) => setTimeout(r, 50));
  for await (const _ of exec.getRemainingResults()) {
    void _;
  }
  await new Promise((r) => setTimeout(r, 20));
  return executed.length > 0;
}

/** 取回 executor 执行后写回的 tool_result 文本（含 [Blocked by permission] 标记） */
async function getResultText(
  checker: PermissionChecker,
  block: ToolUseBlock,
): Promise<string | null> {
  const probe = new ToolRegistry();
  probe.register(
    { name: block.name, description: 'probe', parameters: { type: 'object', properties: {}, required: [] } },
    async () => 'EXECUTED',
  );
  const exec = new StreamingToolExecutor(probe, checker);
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

  it('plan 模式 write_file 被 deny：结果含 [Blocked by permission]，副作用不发生', async () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 't1',
      name: 'write_file',
      input: { path: 'inside.txt', content: 'x' },
    };
    const text = await getResultText(checker, block);
    expect(text).toContain('[Blocked by permission]');

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
    expect(text).toContain('[Blocked by permission]');
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
    expect(text).toContain('[Blocked by permission]');
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
  // 流式执行器当前把 ask 当放行处理（无用户确认通道）——工具实际执行了。
  // 本测试断言"ask 时工具不应执行"——因缺口存在，断言会失败；
  // it.fails 把失败标绿，表示"已知缺口已记录"。
  // 接入 ask 回调后请删除 .fails，转为正式断言。
  it('PermissionChecker 对 build 模式 write_file 返回 ask（决策源头）', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const decision = checker.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(decision.behavior).toBe('ask');
  });

  it.fails('ask 决策时工具不应被执行 [已知缺口：流式路径静默放行 ask，待接入确认通道]', async () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 't6',
      name: 'write_file',
      input: { path: 'inside.txt', content: 'x' },
    };
    // 期望：ask 不应让工具真正执行副作用
    const ran = await didExecute(new ToolRegistry(), checker, block);
    expect(ran).toBe(false);
  });
});
