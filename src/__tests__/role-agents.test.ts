// 阶段 4：角色化子代理测试
//
// 物理本质：验证"临时工中介"的角色注册表、工具过滤、spawn_agent 工具调用。
import { describe, it, expect, vi } from 'vitest';
import { ROLE_REGISTRY, filterToolsByRole, type Role } from '../agent/roles.js';
import { createSpawnAgentTool } from '../agent/tools/spawn-agent-tool.js';
import { ToolRegistry } from '../agent/tool-registry.js';
import type { ToolDefinition, ToolExecutor, RegisteredTool } from '../agent/types.js';
import type { SubagentOptions, SubagentResult } from '../agent/subagent.js';
import { PermissionChecker } from '../permission/checker.js';
import { plannerPrompt } from '../prompts/index.js';

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

  it('plan 白名单含 write_plan_file + exit_plan_mode + ask_user_question + read_plan_file', () => {
    const tools = ROLE_REGISTRY.plan.tools;
    if (tools === '*') throw new Error('plan 不应是 *');
    expect(tools).toContain('write_plan_file');
    expect(tools).toContain('exit_plan_mode');
    expect(tools).toContain('ask_user_question');
    expect(tools).toContain('read_plan_file');
    expect(tools).toContain('read_file');
    // plan 角色仍不应有通用 write_file（只能写 plan 文件）
    expect(tools).not.toContain('write_file');
  });

  it('plan 角色 systemPrompt 使用共享的 plannerPrompt（单源真理）', () => {
    expect(ROLE_REGISTRY.plan.systemPrompt).toBe(plannerPrompt);
    // 关键指令必须存在于 planner 提示词内容中
    expect(plannerPrompt).toMatch(/plan mode/i);
    expect(plannerPrompt).toContain('write_plan_file');
    expect(plannerPrompt).toContain('exit_plan_mode');
  });

  it('general 用 "*" 表示全量工具', () => {
    expect(ROLE_REGISTRY.general.tools).toBe('*');
  });
});

describe('filterToolsByRole 工具过滤', () => {
  /** 构造测试用 Map：含 6 个虚拟工具 */
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
    return m;
  }

  it('role=undefined：返回全量（向后兼容）', () => {
    const all = makeTools();
    const result = filterToolsByRole(all, undefined);
    expect(result.size).toBe(6);
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

  it('role=plan：含 plan 类工具但不含通用 write', () => {
    const all = makeTools();
    const result = filterToolsByRole(all, 'plan');
    expect(result.has('read_file')).toBe(true);
    expect(result.has('write_plan_file')).toBe(true);
    expect(result.has('exit_plan_mode')).toBe(true);
    expect(result.has('read_plan_file')).toBe(true);
    expect(result.has('write_file')).toBe(false);
  });

  it('role=general：返回全量', () => {
    const all = makeTools();
    const result = filterToolsByRole(all, 'general');
    expect(result.size).toBe(6);
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
    const { definition } = createSpawnAgentTool(registry);
    expect(definition.name).toBe('spawn_agent');
    expect(definition.parameters.required).toEqual(['role', 'prompt']);
  });

  it('executor 调 runSubagentFn 并传 role', async () => {
    const registry = makeRegistry();
    const calls: { prompt: string; role?: string }[] = [];
    const mockRunner = vi.fn(async (prompt: string, _tools: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      calls.push({ prompt, role: opts.role });
      return { text: 'subagent summary', isBackground: false };
    });
    const { executor } = createSpawnAgentTool(registry, undefined, undefined, mockRunner);

    const result = await executor({ role: 'explore', prompt: 'find auth code' });
    expect(result).toBe('subagent summary');
    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({ prompt: 'find auth code', role: 'explore' });
  });

  it('plan 角色也能正确传递', async () => {
    const registry = makeRegistry();
    const calls: { role?: string }[] = [];
    const mockRunner = vi.fn(async (_p: string, _t: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      calls.push({ role: opts.role });
      return { text: 'plan summary', isBackground: false };
    });
    const { executor } = createSpawnAgentTool(registry, undefined, undefined, mockRunner);
    await executor({ role: 'plan', prompt: 'design api' });
    expect(calls[0]?.role).toBe('plan');
  });

  it('非法 role → 返回 Error', async () => {
    const registry = makeRegistry();
    const { executor } = createSpawnAgentTool(registry);
    const result = await executor({ role: 'admin', prompt: 'x' });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/explore.*plan.*general/);
  });

  it('空 prompt → 返回 Error', async () => {
    const registry = makeRegistry();
    const { executor } = createSpawnAgentTool(registry);
    const result = await executor({ role: 'explore', prompt: '' });
    expect(result).toMatch(/Error/i);
  });

  it('传递 smallModel 给 runner', async () => {
    const registry = makeRegistry();
    let capturedModel: string | undefined;
    const mockRunner = vi.fn(async (_p: string, _t: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      capturedModel = opts.model;
      return { text: 'ok', isBackground: false };
    });
    const { executor } = createSpawnAgentTool(registry, 'claude-haiku', undefined, mockRunner);
    await executor({ role: 'general', prompt: 'x' });
    expect(capturedModel).toBe('claude-haiku');
  });

  it('透传 permissionChecker 给 runner', async () => {
    const registry = makeRegistry();
    const checker = new PermissionChecker({ mode: 'plan' });
    let capturedChecker: PermissionChecker | undefined;
    const mockRunner = vi.fn(async (_p: string, _t: ToolRegistry, opts: SubagentOptions): Promise<SubagentResult> => {
      capturedChecker = opts.permissionChecker;
      return { text: 'ok', isBackground: false };
    });
    const { executor } = createSpawnAgentTool(registry, undefined, checker, mockRunner);
    await executor({ role: 'explore', prompt: 'x' });
    expect(capturedChecker).toBe(checker);
  });
});
