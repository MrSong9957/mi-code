// 角色注册表：子代理的角色化配置（systemPrompt + 工具白名单）
//
// 物理本质：临时工中介公司的"工牌 + 工具箱"对照表。
// 接到任务后给临时工发对应的工牌（systemPrompt 决定身份/工作方式）
// 和工具箱（tools 白名单决定能拿什么工具）。
//
// subagent.ts 与 self-organizing.ts 都从这里取配置，避免重复定义。

import type { RegisteredTool } from './types.js';
import { plannerPrompt } from '../prompts/index.js';

/** 子代理角色 */
export type Role = 'explore' | 'plan' | 'general';

/** 角色配置 */
export interface RoleConfig {
  /** 该角色的 systemPrompt（决定身份与工作方式） */
  systemPrompt: string;
  /**
   * 工具白名单：列出的工具名才能被该角色子代理看到；'*' = 全部（向后兼容）。
   *
   * 注意：白名单只控制"可见性"（LLM 看到的工具集），不绕过 PermissionChecker。
   * 例如 explore 白名单含 run_bash，但在 plan 模式下子代理跑写命令（mkdir / git commit / ...）
   * 仍会被 PermissionChecker 闸门 3 拦截。可见性是软约束（让 LLM 不幻觉调用），
   * PermissionChecker 是硬约束（兜底）。
   */
  tools: string[] | '*';
}

/**
 * 角色注册表
 *
 * - explore：只读探索，干完写观察报告
 * - plan：只读探索 + 写 plan + 提交审批（不实施）
 * - general：通用救火，全套工具（与原 task 子代理等价）
 */
export const ROLE_REGISTRY: Record<Role, RoleConfig> = {
  explore: {
    systemPrompt: [
      'You are a read-only exploration agent.',
      'ONLY use read_file and read-only bash (ls, cat, grep, find, git status/log/diff).',
      'NEVER modify files, NEVER run write commands (no mkdir/touch/rm/cp/mv/git commit/npm install).',
      'Do NOT narrate your process ("Let me check...", "Now I will..."). Just call tools silently.',
      'Your FINAL output must be a structured factual summary with:',
      '- Key file paths and line numbers',
      '- Architecture and design patterns found',
      '- Answers to the specific questions asked in your task',
      'Do NOT propose solutions, just report findings.',
    ].join(' '),
    tools: ['read_file', 'run_bash', 'load_skill', 'memory_read', 'memory_list', 'read_plan_file'],
  },
  plan: {
    systemPrompt: plannerPrompt,
    tools: [
      'read_file', 'run_bash', 'load_skill', 'memory_read', 'memory_list',
      'read_plan_file', 'write_plan_file', 'exit_plan_mode', 'ask_user_question',
    ],
  },
  general: {
    systemPrompt: 'You are a helpful subagent. Complete the task and return a concise summary.',
    tools: '*',
  },
};

/**
 * 按角色过滤工具集。
 *
 * 物理本质：从大工具箱里挑出该角色工牌允许的工具，装进新的小工具箱。
 *
 * 始终返回新 Map（即使 role 缺省或为 general），保证调用方拿到后
 * .set/.delete 不会污染原 registry——契约统一，无"有时共享有时不共享"的歧义。
 *
 * @param all  完整工具 Map（通常是 childToolRegistry.tools）
 * @param role 角色；undefined 时返回全量副本（向后兼容）
 * @returns 该角色可见的工具 Map（不修改原 Map）
 */
export function filterToolsByRole(
  all: Map<string, RegisteredTool>,
  role?: Role,
): Map<string, RegisteredTool> {
  if (!role) return new Map(all);
  const cfg = ROLE_REGISTRY[role];
  if (!cfg) return new Map(all);
  if (cfg.tools === '*') return new Map(all);
  const subset = new Map<string, RegisteredTool>();
  for (const name of cfg.tools) {
    const t = all.get(name);
    if (t) subset.set(name, t);
  }
  return subset;
}
