// 角色注册表：子代理的角色化配置（systemPrompt + 工具白名单 + model + 行为约束）
//
// 物理本质：临时工中介公司的"工牌 + 工具箱 + 工种说明"对照表。
// 接到任务后给临时工发对应的工牌（systemPrompt 决定身份/工作方式）、
// 工具箱（tools 白名单决定能拿什么工具）、工种说明（whenToUse 让主 agent 知道何时选）。
//
// subagent.ts 与 self-organizing.ts 都从这里取配置，避免重复定义。

import type { RegisteredTool } from './types.js';
import { plannerPrompt } from '../prompts/index.js';

/** 子代理角色 */
export type Role = 'explore' | 'plan' | 'general';

/** 模型选择策略：'small'=小模型(便宜快速), 'inherit'=继承主模型 */
export type SubagentModel = 'small' | 'inherit';

/** 角色配置 */
export interface RoleConfig {
  /** 该角色的 systemPrompt（决定身份/工作方式） */
  systemPrompt: string;
  /**
   * 工具白名单：列出的工具名才能被该角色子代理看到；'*' = 全部（向后兼容）。
   *
   * 注意：白名单只控制"可见性"（LLM 看到的工具集），不绕过 PermissionChecker。
   * 例如 explore 白名单含 run_bash，但在 plan 模式下子代理跑写命令（mkdir / git commit / ...）
   * 仍会被 PermissionChecker 闸门 3 拦截。可见性是软约束（让 LLM 不幻觉调用），
   * PermissionChecker 是硬约束（兜底）。
   *
   * 最终可见工具 = 白名单 - SUBAGENT_DISALLOWED_TOOLS（全局黑名单兜底）。
   */
  tools: string[] | '*';
  /** 主 agent 选择此角色时的描述（注入 spawn_agent 工具 description） */
  whenToUse: string;
  /** 模型选择：'small'=小模型(便宜), 'inherit'=主模型。缺省='small' */
  model?: SubagentModel;
  /** 最大工具调用轮数。缺省由调用方决定(explore=25, 其他=15) */
  maxTurns?: number;
}

/**
 * 所有子代理都禁用的工具（对齐 Claude Code 防递归机制）。
 *
 * 白名单模式已经精确控制了 explore/plan 角色的工具可见性。
 * 这个黑名单只针对 general 角色（tools: '*'）做兜底：
 *
 * - spawn_agent / task / spawn_self_organizing: 防递归——子代理不能再 spawn 子代理
 *   （CC 通过 ALL_AGENT_DISALLOWED_TOOLS 移除 Agent 工具实现同样效果）
 *
 * 注意：exit_plan_mode 和 ask_user_question **不在此列表**。
 * plan 角色需要 exit_plan_mode 提交审批、ask_user_question 澄清需求
 * （对齐 CC 在 plan 模式下特判放行 ExitPlanMode 的设计）。
 */
export const SUBAGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'spawn_agent',
  'task',
  'spawn_self_organizing',
]);

/**
 * 角色注册表
 *
 * - explore：只读探索，干完写观察报告（用小模型省钱）
 * - plan：只读探索 + 写 plan（用主模型保证质量），提交审批由主 agent 决定
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
    whenToUse: 'read-only codebase investigation (use when you need to explore code without bloating your context)',
    model: 'small',
    maxTurns: 25,
  },
  plan: {
    systemPrompt: plannerPrompt,
    tools: [
      'read_file', 'run_bash', 'load_skill', 'memory_read', 'memory_list',
      'read_plan_file', 'write_plan_file', 'exit_plan_mode', 'ask_user_question',
    ],
    whenToUse: 'design implementation plans — explores code, writes a plan file, and submits for user approval via exit_plan_mode',
    model: 'inherit',
    maxTurns: 15,
  },
  general: {
    systemPrompt: 'You are a helpful subagent. Complete the task and return a concise summary.',
    tools: '*',
    whenToUse: 'generic subtask execution (equivalent to the task tool)',
  },
};

/**
 * 按角色过滤工具集。
 *
 * 物理本质：从大工具箱里挑出该角色工牌允许的工具，装进新的小工具箱，
 * 再把全局禁用的工具拿出来（SUBAGENT_DISALLOWED_TOOLS 兜底）。
 *
 * 始终返回新 Map（即使 role 缺省或为 general），保证调用方拿到后
 * .set/.delete 不会污染原 registry——契约统一，无"有时共享有时不共享"的歧义。
 *
 * @param all  完整工具 Map（通常是 childToolRegistry.tools）
 * @param role 角色；undefined 时返回全量副本（向后兼容）
 * @returns 该角色可见的工具 Map（已减去全局黑名单，不修改原 Map）
 */
export function filterToolsByRole(
  all: Map<string, RegisteredTool>,
  role?: Role,
): Map<string, RegisteredTool> {
  if (!role) return new Map(all);
  const cfg = ROLE_REGISTRY[role];
  if (!cfg) return new Map(all);
  // 先按白名单筛选
  const baseSubset: Map<string, RegisteredTool> = cfg.tools === '*'
    ? new Map(all)
    : (() => {
      const subset = new Map<string, RegisteredTool>();
      for (const name of cfg.tools) {
        const t = all.get(name);
        if (t) subset.set(name, t);
      }
      return subset;
    })();
  // 再减去全局黑名单（兜底：即使白名单含被禁工具或 general 用 '*' 也会被移除）
  for (const disallowed of SUBAGENT_DISALLOWED_TOOLS) {
    baseSubset.delete(disallowed);
  }
  return baseSubset;
}
