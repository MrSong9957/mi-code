// 阶段 4：角色化子代理测试
//
// 物理本质：验证"临时工中介"的角色注册表、工具过滤、spawn_agent 工具调用。
import { describe, it, expect, vi } from 'vitest';
import { ROLE_REGISTRY, filterToolsByRole, type Role } from '../agent/roles.js';
import { createSpawnAgentTool } from '../agent/tools/spawn-agent-tool.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import type { ToolDefinition, ToolExecutor, RegisteredTool } from '../agent/types.js';
import type { SubagentOptions, SubagentResult } from '../agent/subagent.js';
import { runSubagent, enhanceSubagentSystemPrompt } from '../agent/subagent.js';
import type { StreamingLLMClient } from '../agent/types.js';
import { createToolExecutionRuntime } from './helpers/tool-execution-runtime.js';

const executionRuntime = createToolExecutionRuntime();

describe('ROLE_REGISTRY 角色注册表', () => {
  it('三个角色都有 systemPrompt 与 tools', () => {
    const roles: Role[] = ['explore', 'plan', 'general'];
    for (const r of roles) {
      const cfg = ROLE_REGISTRY[r];
      expect(cfg.systemPrompt.length).toBeGreaterThan(0);
      expect(cfg.tools).toBeDefined();
    }
  });

  it('explore 白名单不含写工具', () => {
    const tools = ROLE_REGISTRY.explore.tools;
    if (tools === '*') throw new Error('explore 不应是 *');
    expect(tools).not.toContain('write_file');
    expect(tools).not.toContain('edit_file');
    expect(tools).not.toContain('write_plan_file');
    expect(tools).toContain('read_file');
    expect(tools).toContain('run_bash');
    expect(tools).toContain('read_plan_file');
  });

  it('plan 白名单含 write_plan_file + read_plan_file，不含 exit_plan_mode/ask_user_question', () => {
    const tools = ROLE_REGISTRY.plan.tools;
    if (tools === '*') throw new Error('plan 不应是 *');
    expect(tools).toContain('write_plan_file');
    expect(tools).toContain('read_plan_file');
    expect(tools).toContain('read_file');
    // exit_plan_mode 和 ask_user_question 在白名单中但被全局黑名单移除
    expect(tools).not.toContain('write_file');
  });

  it('plan 角色 systemPrompt 包含子代理专用指令', () => {
    const prompt = ROLE_REGISTRY.plan.systemPrompt;
    // 子代理专用 prompt 不应包含要求调用 exit_plan_mode 的指令
    expect(prompt).toContain('write_plan_file');
    expect(prompt).toContain('cannot interact');
  });

  it('general 用 "*" 表示全量工具', () => {
    expect(ROLE_REGISTRY.general.tools).toBe('*');
  });
});

describe('filterToolsByRole 工具过滤', () => {
  /** 构造测试用 Map：含 8 个虚拟工具（含交互和递归工具） */
  function makeTools(): Map<string, RegisteredTool> {
    const m = new Map<string, RegisteredTool>();
    const mk = (name: string): RegisteredTool => ({
      definition: { name, description: 'd', parameters: { type: 'object' } },
      executor: async () => '',
    });
    m.set('read_file', mk('read_file'));
    m.set('write_file', mk('write_file'));
    m.set('write_plan_file', mk('write_plan_file'));
    m.set('run_bash', mk('run_bash'));
    m.set('exit_plan_mode', mk('exit_plan_mode'));
    m.set('read_plan_file', mk('read_plan_file'));
    m.set('ask_user_question', mk('ask_user_question'));
    m.set('spawn_agent', mk('spawn_agent'));
    return m;
  }

  it('role=undefined：返回全量减去全局黑名单（向后兼容）', () => {
    const all = makeTools();
    const result = filterToolsByRole(all, undefined);
    // 8 tools - 2 disallowed (ask_user_question, spawn_agent) = 6
    // exit_plan_mode also removed by new blacklist
    expect(result.size).toBe(5);
  });

  it('role=explore：只读子集（无 write_file / write_plan_file）', () => {
    const all = makeTools();
    const result = filterToolsByRole(all, 'explore');
    expect(result.has('read_file')).toBe(true);
    expect(result.has('run_bash')).toBe(true);
    expect(result.has('read_plan_file')).toBe(true);
    expect(result.has('write_file')).toBe(false);
    expect(result.has('write_plan_file')).toBe(false);
    expect(result.has('exit_plan_mode')).toBe(false);
  });

  it('role=plan：含 plan 类工具，不含 exit_plan_mode（被全局黑名单移除）', () => {
    const all = makeTools();
    const result = filterToolsByRole(all, 'plan');
    expect(result.has('read_file')).toBe(true);
    expect(result.has('write_plan_file')).toBe(true);
    expect(result.has('exit_plan_mode')).toBe(false);
    expect(result.has('read_plan_file')).toBe(true);
    expect(result.has('write_file')).toBe(false);
  });

  it('role=general：返回全量减去防递归黑名单（spawn_agent/task 等）', () => {
    const all = makeTools();
    const result = filterToolsByRole(all, 'general');
    // 8 tools - 3 disallowed (spawn_agent, ask_user_question, exit_plan_mode) = 5
    expect(result.size).toBe(5);
  });

  it('不修改原 Map', () => {
    const all = makeTools();
    const snapshot = all.size;
    filterToolsByRole(all, 'explore');
    expect(all.size).toBe(snapshot);
  });

  it('白名单工具不存在于 Map 时静默跳过', () => {
    const all = makeTools(); // 没装 memory_read
    const result = filterToolsByRole(all, 'explore');
    // memory_read 在白名单但不在 Map，应跳过，不抛错
    expect(result.has('memory_read')).toBe(false);
    // 但 read_file 仍在
    expect(result.has('read_file')).toBe(true);
  });

  it.each(['explore', 'plan', 'general'] as const)(
    'role=%s 不暴露用户交互或递归工具',
    (role) => {
      const result = filterToolsByRole(makeTools(), role);
      expect(result.has('ask_user_question')).toBe(false);
      expect(result.has('exit_plan_mode')).toBe(false);
      expect(result.has('spawn_agent')).toBe(false);
    },
  );

  it('fork 使用 role=undefined 时也应用全局子代理黑名单', () => {
    const result = filterToolsByRole(makeTools(), undefined);
    expect(result.has('ask_user_question')).toBe(false);
    expect(result.has('exit_plan_mode')).toBe(false);
    expect(result.has('spawn_agent')).toBe(false);
  });
});

describe('createSpawnAgentTool', () => {
  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    const def: ToolDefinition = { name: 'read_file', description: 'd', parameters: { type: 'object' } };
    const exec: ToolExecutor = async () => 'ok';
    registry.register(def, exec);
    return registry;
  }

  it('definition 字段正确', () => {
    const registry = makeRegistry();
    const { definition } = createSpawnAgentTool(registry, undefined, executionRuntime);
    expect(definition.name).toBe('spawn_agent');
    expect(definition.parameters.required).toEqual(['role', 'prompt']);
  });

  it('schema 含可选 description 字段(AUTO-0025-transient Task 3)', () => {
    const registry = makeRegistry();
    const { definition } = createSpawnAgentTool(registry, undefined, executionRuntime);
    expect(definition.parameters.properties).toHaveProperty('description');
    // description 不在 required(向后兼容)
    expect(definition.parameters.required).not.toContain('description');
  });

  it('不带 description 的既有调用仍正常执行(向后兼容)', async () => {
    const registry = makeRegistry();
    const mockRunner = vi.fn(async (): Promise<SubagentResult> => ({
      text: 'ok', isBackground: false, status: 'completed',
      terminationReason: 'end_turn', evidence: { toolCallCount: 1, successfulToolResultCount: 1 },
    }));
    const { executor } = createSpawnAgentTool(registry, undefined, executionRuntime, mockRunner);
    const result = await executor({ role: 'explore', prompt: 'task' });
    expect(result).toContain('[Subagent status=completed]');
  });

  it('executor 调 runSubagentFn 并传 role', async () => {
    const registry = makeRegistry();
    const calls: { prompt: string; role?: string }[] = [];
    const mockRunner = vi.fn(async (prompt: string, _tools: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      calls.push({ prompt, role: opts.role });
      return { text: 'subagent summary', isBackground: false, status: 'completed' as const, terminationReason: 'end_turn', evidence: { toolCallCount: 1, successfulToolResultCount: 1 } };
    });
    const { executor } = createSpawnAgentTool(registry, undefined, executionRuntime, mockRunner);

    const result = await executor({ role: 'explore', prompt: 'find auth code' });
    // AUTO-0025 Task 5:输出携带结构化 status 前缀,让主 agent 能区分成功/失败
    expect(result).toContain('[Subagent status=completed]');
    expect(result).toContain('subagent summary');
    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({ prompt: 'find auth code', role: 'explore' });
  });

  // ────────────────────────────────────────────────────────────────────
  // AUTO-0025 Task 5:spawn_agent 输出携带结构化 status,让主 agent 区分成功/失败。
  //
  // 物理本质:派工单回执上的"工单状态戳"。主 agent 看到戳就知道:
  // - status=completed → 子代理成功,直接用 summary
  // - status=incomplete/error → 子代理失败,不要静默用自己的工具重做(显式委派场景)
  // ────────────────────────────────────────────────────────────────────

  it('输出携带 [Subagent status=completed] 前缀(completed)', async () => {
    const registry = makeRegistry();
    const mockRunner = vi.fn(async (): Promise<SubagentResult> => ({
      text: 'found 3 skills', isBackground: false, status: 'completed',
      terminationReason: 'end_turn', evidence: { toolCallCount: 2, successfulToolResultCount: 2 },
    }));
    const { executor } = createSpawnAgentTool(registry, undefined, executionRuntime, mockRunner);

    const result = await executor({ role: 'explore', prompt: 'list skills' });
    expect(result).toContain('[Subagent status=completed]');
    expect(result).toContain('found 3 skills');
  });

  it('输出携带 [Subagent status=incomplete reason=max_turns] 前缀(incomplete)', async () => {
    const registry = makeRegistry();
    const mockRunner = vi.fn(async (): Promise<SubagentResult> => ({
      text: '[Subagent incomplete: reached max turns] partial findings',
      isBackground: false, status: 'incomplete',
      terminationReason: 'max_turns', evidence: { toolCallCount: 3, successfulToolResultCount: 1 },
    }));
    const { executor } = createSpawnAgentTool(registry, undefined, executionRuntime, mockRunner);

    const result = await executor({ role: 'explore', prompt: 'deep search' });
    expect(result).toContain('[Subagent status=incomplete');
    expect(result).toContain('reason=max_turns');
    expect(result).toContain('partial findings');
  });

  it('输出携带 [Subagent status=unverified] 前缀(unverified)', async () => {
    const registry = makeRegistry();
    const mockRunner = vi.fn(async (): Promise<SubagentResult> => ({
      text: '[Subagent unverified] no evidence',
      isBackground: false, status: 'unverified',
      terminationReason: 'end_turn', evidence: { toolCallCount: 0, successfulToolResultCount: 0 },
    }));
    const { executor } = createSpawnAgentTool(registry, undefined, executionRuntime, mockRunner);

    const result = await executor({ role: 'explore', prompt: 'check' });
    expect(result).toContain('[Subagent status=unverified]');
  });

  it('plan 角色也能正确传递', async () => {
    const registry = makeRegistry();
    const calls: { role?: string }[] = [];
    const mockRunner = vi.fn(async (_p: string, _t: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      calls.push({ role: opts.role });
      return { text: 'plan summary', isBackground: false, status: 'completed' as const, terminationReason: 'end_turn', evidence: { toolCallCount: 1, successfulToolResultCount: 1 } };
    });
    const { executor } = createSpawnAgentTool(registry, undefined, executionRuntime, mockRunner);
    await executor({ role: 'plan', prompt: 'design api' });
    expect(calls[0]?.role).toBe('plan');
  });

  it('非法 role → 返回 Error', async () => {
    const registry = makeRegistry();
    const { executor } = createSpawnAgentTool(registry, undefined, executionRuntime);
    const result = await executor({ role: 'admin', prompt: 'x' });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/explore.*plan.*general/);
  });

  it('空 prompt → 返回 Error', async () => {
    const registry = makeRegistry();
    const { executor } = createSpawnAgentTool(registry, undefined, executionRuntime);
    const result = await executor({ role: 'explore', prompt: '' });
    expect(result).toMatch(/Error/i);
  });

  it('传递 clientProvider 的结果给 runner（多 provider 支持）', async () => {
    const registry = makeRegistry();
    let capturedClient: unknown;
    const fakeClient = { stream: async function* () { /* mock client */ } };
    const mockRunner = vi.fn(async (_p: string, _t: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      capturedClient = opts.client;
      return { text: 'ok', isBackground: false, status: 'completed' as const, terminationReason: 'end_turn', evidence: { toolCallCount: 1, successfulToolResultCount: 1 } };
    });
    const { executor } = createSpawnAgentTool(registry, () => fakeClient, executionRuntime, mockRunner);
    await executor({ role: 'general', prompt: 'x' });
    // clientProvider 被调用，产物作为 opts.client 传入 runner
    expect(capturedClient).toBe(fakeClient);
  });

  it('未传 clientProvider 时 opts.client 为 undefined（回退 Vercel 路径）', async () => {
    const registry = makeRegistry();
    let capturedClient: unknown = 'sentinel';
    const mockRunner = vi.fn(async (_p: string, _t: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      capturedClient = opts.client;
      return { text: 'ok', isBackground: false, status: 'completed' as const, terminationReason: 'end_turn', evidence: { toolCallCount: 1, successfulToolResultCount: 1 } };
    });
    const { executor } = createSpawnAgentTool(registry, undefined, executionRuntime, mockRunner);
    await executor({ role: 'general', prompt: 'x' });
    expect(capturedClient).toBeUndefined();
  });

  it('透传同一个 executionRuntime 给 runner', async () => {
    const registry = makeRegistry();
    const runtime = createToolExecutionRuntime({ mode: 'plan' });
    let capturedRuntime: SubagentOptions['executionRuntime'] | undefined;
    const mockRunner = vi.fn(async (_p: string, _t: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      capturedRuntime = opts.executionRuntime;
      return { text: 'ok', isBackground: false, status: 'completed' as const, terminationReason: 'end_turn', evidence: { toolCallCount: 1, successfulToolResultCount: 1 } };
    });
    const { executor } = createSpawnAgentTool(registry, undefined, runtime, mockRunner);
    await executor({ role: 'explore', prompt: 'x' });
    expect(capturedRuntime).toBe(runtime);
  });

  /** 构造捕获 runner：把每次调用的 options 存入 captured.options */
  function makeFakeRunner(captured: { options: SubagentOptions | null }) {
    return async (_p: string, _t: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      captured.options = opts;
      return { text: 'fork summary', isBackground: false, status: 'completed' as const, terminationReason: 'end_turn', evidence: { toolCallCount: 1, successfulToolResultCount: 1 } };
    };
  }

  it('fork=true 时传 forkMode + parentSystem + maxSteps=50', async () => {
    const fakeRegistry = makeRegistry();
    const captured = { options: null as SubagentOptions | null };
    const tool = createSpawnAgentTool(
      fakeRegistry,
      undefined,          // clientProvider
      executionRuntime,
      makeFakeRunner(captured),
      undefined,          // skillsDescription
      () => 'parent system prompt',  // getParentSystemPrompt
    );
    await tool.executor({ role: 'general', prompt: 'do something', fork: true });
    expect(captured.options?.forkMode).toBe(true);
    expect(captured.options?.parentSystem).toBe('parent system prompt');
    expect(captured.options?.maxSteps).toBe(50);
    // fork 模式不传 role
    expect(captured.options?.role).toBeUndefined();
  });

  it('fork 省略时不传 forkMode', async () => {
    const fakeRegistry = makeRegistry();
    const captured = { options: null as SubagentOptions | null };
    const tool = createSpawnAgentTool(
      fakeRegistry,
      undefined,
      executionRuntime,
      makeFakeRunner(captured),
      undefined,
      () => 'parent system prompt',
    );
    await tool.executor({ role: 'general', prompt: 'do something' });
    expect(captured.options?.forkMode).toBeFalsy();
    expect(captured.options?.parentSystem).toBeUndefined();
  });

  it('fork=true 但无 getParentSystemPrompt 时返回 Error', async () => {
    const fakeRegistry = makeRegistry();
    const tool = createSpawnAgentTool(fakeRegistry, undefined, executionRuntime);
    const result = await tool.executor({ role: 'general', prompt: 'do something', fork: true });
    expect(result).toContain('Error');
  });

  it('provider 异常通过 spawn_agent 输出 incomplete/error envelope', async () => {
    const registry = makeRegistry();
    const failingClient: StreamingLLMClient = {
      // 模拟 provider 在产出任何流事件前就抛出普通对象异常。
      // eslint-disable-next-line require-yield
      async *stream() {
        throw {
          status: 503,
          error: { message: 'upstream unavailable' },
        };
      },
    };
    const { executor } = createSpawnAgentTool(
      registry,
      () => failingClient,
      executionRuntime,
      runSubagent,
    );

    const output = await executor({
      role: 'explore',
      prompt: 'inspect files',
      description: '检查文件',
    });

    expect(output).toContain('[Subagent status=incomplete reason=error]');
    expect(output).toContain('"status":503');
    expect(output).toContain('upstream unavailable');
    expect(output).not.toContain('[object Object]');
    expect(output).not.toContain('ERR_UNHANDLED_ERROR');
  });
});

describe('enhanceSubagentSystemPrompt', () => {
  it('含 git 仓库检测和 Shell 信息', () => {
    const result = enhanceSubagentSystemPrompt('base');
    expect(result).toContain('Platform:');
    expect(result).toContain('Shell:');
    expect(result).toContain('git repository');
  });

  it('追加技能描述', () => {
    const result = enhanceSubagentSystemPrompt('base', { skillsDescription: 'test-skill: description' });
    expect(result).toContain('test-skill');
    expect(result).toContain('Available skills');
  });

  it('无技能描述时不追加', () => {
    const result = enhanceSubagentSystemPrompt('base');
    expect(result).not.toContain('Available skills');
  });
});
