// 角色注册表：子代理的角色化配置（systemPrompt + 工具白名单 + model + 行为约束）
//
// 物理本质：临时工中介公司的"工牌 + 工具箱 + 工种说明"对照表。
// 接到任务后给临时工发对应的工牌（systemPrompt 决定身份/工作方式）、
// 工具箱（tools 白名单决定能拿什么工具）、工种说明（whenToUse 让主 agent 知道何时选）。
//
// subagent.ts 与 self-organizing.ts 都从这里取配置，避免重复定义。

import type { RegisteredTool } from './types.js';
import type { AgentRoleProfile } from './prompt/profiles.js';

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
 * 所有子代理都禁用的工具（对齐 Claude Code 防递归机制 + 用户交互隔离）。
 *
 * - spawn_agent / task / spawn_self_organizing: 防递归——子代理不能再 spawn 子代理
 * - ask_user_question / exit_plan_mode / enter_plan_mode: 用户交互由主 agent 独占，
 *   子代理不能直接询问用户或请求计划审批
 */
export const SUBAGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'spawn_agent',
  'task',
  'spawn_self_organizing',
  'ask_user_question',
  'exit_plan_mode',
  'enter_plan_mode',
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
    systemPrompt: [
      'You are a read-only planning subagent.',
      'Inspect the codebase with read tools, then write the complete plan with write_plan_file.',
      'You cannot interact with the user and must not call ask_user_question or exit_plan_mode.',
      'If information is missing, list the exact unresolved questions in your final response.',
      'After writing the plan, return its path plus a concise summary to the main agent.',
    ].join(' '),
    tools: [
      'read_file', 'run_bash', 'load_skill', 'memory_read', 'memory_list',
      'read_plan_file', 'write_plan_file',
    ],
    whenToUse: 'design implementation plans — explores code, writes a plan file, and returns summary to main agent',
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
 * @param role 角色；undefined 时返回全量减去全局黑名单（fork 路径）
 * @returns 该角色可见的工具 Map（已减去全局黑名单，不修改原 Map）
 */
export function filterToolsByRole(
  all: Map<string, RegisteredTool>,
  role?: Role,
): Map<string, RegisteredTool> {
  // 先按白名单筛选（role 缺省时取全量）
  let baseSubset: Map<string, RegisteredTool>;
  if (!role) {
    baseSubset = new Map(all);
  } else {
    const cfg = ROLE_REGISTRY[role];
    if (!cfg) {
      baseSubset = new Map(all);
    } else {
      baseSubset = cfg.tools === '*'
        ? new Map(all)
        : (() => {
          const subset = new Map<string, RegisteredTool>();
          for (const name of cfg.tools) {
            const t = all.get(name);
            if (t) subset.set(name, t);
          }
          return subset;
        })();
    }
  }
  // 统一减去全局黑名单（兜底：无论 role 是否存在，都移除交互/递归工具）
  for (const disallowed of SUBAGENT_DISALLOWED_TOOLS) {
    baseSubset.delete(disallowed);
  }
  return baseSubset;
}

// ────────────────────────────────────────────────────────────────────────────
// Wave B Task 9 (M-014/M-035): AgentRoleProfile mapping (BRC-4).
//
// 把现有 ROLE_REGISTRY 的一个 entry 升级成带身份与协议版本的 AgentRoleProfile。
// 物理本质:RoleConfig 是"工牌 + 工具箱 + 工种说明"的内部表示;
// AgentRoleProfile 是同一份信息的"对外声明性记录"(带 asset 引用 + 协议版本),
// 供 composeAgentPromptProfile 消费,产出 per-request 的 AgentPromptProfileSnapshot。
//
// 重要:本函数不创建新的 Prompt Library 资产对象,也不修改审批状态。它只是
// 把既有 3 个 role prompt 的 inline 字符串在"精神上"映射为
// `source.kind='mi-code'` 的资产引用 `{ asset_id: 'mi-code.role.<role>', asset_version: '1' }`。
// 这些资产的存在性及其 prompt 内容,由以下回归测试守卫:
//   - src/__tests__/role-agents.test.ts(角色注册表 / 工具过滤 / systemPrompt 内容)
//   - src/__tests__/subagent-result-integrity.test.ts(子代理实际运行时使用 ROLE_REGISTRY)
// 本迁移不新增 Prompt Library 资产,也不经此路径审批任何新资产。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把 {@link Role} 映射成对应的 {@link AgentRoleProfile}。
 *
 * 字段映射(frozen):
 *  - role_id:角色字符串('explore' / 'plan' / 'general')。
 *  - role_version:'1'(Wave B 首次定义这些 profile)。
 *  - prompt_asset_ref:`{ asset_id: 'mi-code.role.<role>', asset_version: '1' }`
 *    —— 在 mi-code 仓库内,这等价于 `source.kind='mi-code'` 资产,证据引用指向
 *    role-agents.test.ts + subagent-result-integrity.test.ts。
 *  - purpose:`ROLE_REGISTRY[role].whenToUse`。
 *  - requested_tool_ids:`ROLE_REGISTRY[role].tools === '*' ? [] : [...tools]`。
 *    '*' 表示"全量"(general 角色)—— 用空数组表示"未声明具体请求,全部交给
 *    final tool view 决定"(defer to view),避免在 profile 层重复列举所有工具。
 *  - required_capabilities:`[]`(现有 role 不声明 cap;未来 Wave 可扩展)。
 *  - completion_protocol_version:'1'。
 *  - verification_requirement:'V2'(Wave A Task 8:子代理必须 demonstrate V2)。
 */
export function roleToAgentRoleProfile(role: Role): AgentRoleProfile {
  const cfg = ROLE_REGISTRY[role];
  if (!cfg) {
    // 类型层面 Role 已经收敛到 3 个字面量,这里只是防御性兜底。
    throw new Error(`unknown role: ${role}`);
  }
  return {
    role_id: role,
    role_version: '1',
    prompt_asset_ref: {
      asset_id: `mi-code.role.${role}`,
      asset_version: '1',
    },
    purpose: cfg.whenToUse,
    requested_tool_ids: cfg.tools === '*' ? [] : [...cfg.tools],
    required_capabilities: [],
    completion_protocol_version: '1',
    verification_requirement: 'V2',
  };
}
