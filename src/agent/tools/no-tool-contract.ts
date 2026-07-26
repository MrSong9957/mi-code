/**
 * Wave C Task 9 (M-031 / CRC-4): No-Tool Request Contract.
 *
 * 物理本质: 一份"本次任务明确禁止工具"的硬协议。与 Prompt 里写"请不要用工具"
 * 的软防线不同, 这是机器可验证的四重 enforcement:
 *
 *   1. profile      —— BRC-4 task profile 显式声明 no_tool_requirement=true
 *   2. view         —— BRC-2 派生的 RequestToolViewSnapshot 必须 0 个 included tool
 *   3. provider     —— 发给 Provider 的 request 不携带 tools/function declarations
 *   4. runtime      —— Provider 万一返回 tool call, runtime 拒绝执行 (protocol rejection)
 *
 * 任一 gate 失败 → status='invalid'。Prompt preamble/trailer 只是软防线, 不计入 enforcement
 * (规格 §10.4 rule 6)。
 *
 * 关键不变量 (INV-C9 / 规格 §10.5):
 *   - tool_view_entry_count 必须是字面量 0, 不是 "空数组" 或 "模拟 system tool 文本"
 *   - Provider tools 必须 omitted, 而非发送空的模拟 system tool 文本
 *   - 异常 tool call 不能执行后再忽略
 *   - output parser 失败不得通过调用工具补救同一 request
 *
 * Spec: docs/superpowers/specs/2026-07-26-agent-policy-contracts-wave-c-design.md §10.4
 */

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

// ---------------------------------------------------------------------------
// Public types (frozen per spec §10.4)
// ---------------------------------------------------------------------------

export const NO_TOOL_PROTOCOL_VERSION = '1';

/**
 * Enforcement policy 身份 (spec §6.1 PolicyRef).
 * Wave C 固定一个本进程级身份; 后续 Authority 注入时替换即可。
 */
export const NO_TOOL_ENFORCEMENT_POLICY_ID = 'no-tool-enforcement';
export const NO_TOOL_ENFORCEMENT_POLICY_VERSION = '1';

/**
 * No-tool request 的结构化 contract (spec §10.4).
 *
 * 这是"本次 request 声明自己无工具"的不可变单据。由调用方在进入 streamingQuery 前
 * 构造, 与 task profile / tool view / provider request 绑定。
 */
export interface NoToolRequestContract {
  no_tool_protocol_version: string;
  no_tool_request_id: string;
  task_profile_snapshot_id: string;
  tool_view_snapshot_id: string;
  enforcement_policy_ref: {
    policy_id: string;
    policy_version: string;
  };
  expected_output_schema_id: string;
  reason_code: string;
}

/**
 * validateNoToolRequest 的输入: 四重 gate 的当前观测状态。
 *
 * 物理本质: 把"此刻系统各层的事实"摊开给 validator, 由它判定整体是否一致。
 * 任一字段反映"有工具"或"未 omitted"→ invalid。
 */
export interface NoToolRequestState {
  /** profile gate: BRC-4 task profile 是否声明 no_tool_requirement=true */
  profile_requires_no_tools: boolean;
  /** view gate: BRC-2 RequestToolViewSnapshot 的 included tool 条目数 (必须字面量 0) */
  included_tool_count: number;
  /** provider gate: 发给 Provider 的 request 是否 omitted tools (true=omitted) */
  provider_tools_omitted: boolean;
  /** runtime gate: runtime 对异常 tool call 的处置 ('reject'=拒绝执行, 'execute'=放行) */
  runtime_tool_use_behavior: 'reject' | 'execute';
}

/**
 * 验证结果 (spec §10.4 NoToolValidationResult).
 *
 * status='valid' 当且仅当四重 gate 全部满足。tool_view_entry_count 是字面量 0
 * (TypeScript literal type), 表达"必须恰好零"的硬协议。
 */
export interface NoToolValidationResult {
  no_tool_request_id: string;
  tool_view_entry_count: 0;
  provider_tools_omitted: true;
  runtime_tool_use_behavior: 'reject';
  status: 'valid' | 'invalid';
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 构造一份 NoToolRequestContract (不可变单据).
 *
 * 调用方在进入 streamingQuery 前构造此 contract, 把它和 task profile / tool view
 * 绑定。contract 本身不验证 gate —— 验证由 validateNoToolRequest 完成。
 */
export function createNoToolRequestContract(input: {
  task_profile_snapshot_id: string;
  tool_view_snapshot_id: string;
  expected_output_schema_id?: string;
  reason_code?: string;
}): NoToolRequestContract {
  requireIdentity(input.task_profile_snapshot_id, 'task_profile_snapshot_id');
  requireIdentity(input.tool_view_snapshot_id, 'tool_view_snapshot_id');

  const canonical = JSON.stringify({
    task_profile_snapshot_id: input.task_profile_snapshot_id,
    tool_view_snapshot_id: input.tool_view_snapshot_id,
    expected_output_schema_id: input.expected_output_schema_id ?? 'default',
    reason_code: input.reason_code ?? 'no_tool.required',
    enforcement_policy_id: NO_TOOL_ENFORCEMENT_POLICY_ID,
    enforcement_policy_version: NO_TOOL_ENFORCEMENT_POLICY_VERSION,
  });
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);

  return freezeSnapshot<NoToolRequestContract>({
    no_tool_protocol_version: NO_TOOL_PROTOCOL_VERSION,
    no_tool_request_id: `notool:${hash}`,
    task_profile_snapshot_id: input.task_profile_snapshot_id,
    tool_view_snapshot_id: input.tool_view_snapshot_id,
    enforcement_policy_ref: {
      policy_id: NO_TOOL_ENFORCEMENT_POLICY_ID,
      policy_version: NO_TOOL_ENFORCEMENT_POLICY_VERSION,
    },
    expected_output_schema_id: input.expected_output_schema_id ?? 'text_summary',
    reason_code: input.reason_code ?? 'no_tool.required',
  });
}

/**
 * 验证四重 enforcement gate (spec §10.4).
 *
 * 算法: 逐 gate 检查, 任一失败 → 收集 diagnostic + status='invalid'。
 * 全部通过 → status='valid', 并把通过的事实在 result 里固化
 * (tool_view_entry_count=0, provider_tools_omitted=true, runtime_tool_use_behavior='reject')。
 *
 * 关键: tool_view_entry_count 必须是字面量 0。included_tool_count > 0 即 invalid,
 * 不容忍"只暴露一个无害工具"。
 */
export function validateNoToolRequest(state: NoToolRequestState): NoToolValidationResult {
  const diagnostics: string[] = [];

  // Gate 1: profile
  if (!state.profile_requires_no_tools) {
    diagnostics.push(
      'no_tool.profile_gate_failed: task profile does not declare no_tool_requirement=true',
    );
  }

  // Gate 2: view (字面量 0)
  if (state.included_tool_count !== 0) {
    diagnostics.push(
      `no_tool.view_gate_failed: included_tool_count must be 0, got ${state.included_tool_count}`,
    );
  }

  // Gate 3: provider omission
  if (!state.provider_tools_omitted) {
    diagnostics.push(
      'no_tool.provider_gate_failed: provider request must omit tools entirely',
    );
  }

  // Gate 4: runtime rejection
  if (state.runtime_tool_use_behavior !== 'reject') {
    diagnostics.push(
      `no_tool.runtime_gate_failed: runtime_tool_use_behavior must be 'reject', got '${state.runtime_tool_use_behavior}'`,
    );
  }

  const status: 'valid' | 'invalid' = diagnostics.length === 0 ? 'valid' : 'invalid';

  return freezeSnapshot<NoToolValidationResult>({
    no_tool_request_id: 'validated',
    tool_view_entry_count: 0,
    provider_tools_omitted: true,
    runtime_tool_use_behavior: 'reject',
    status,
    diagnostics,
  });
}

/**
 * 把 validateNoToolRequest 的结果绑定到具体 contract, 产生带 identity 的 result。
 *
 * 用于 streamingQuery 入口: 先 createNoToolRequestContract, 再用此函数把验证结果
 * 和 contract id 关联, 便于 trace。
 */
export function bindValidationToContract(
  contract: NoToolRequestContract,
  state: NoToolRequestState,
): NoToolValidationResult {
  const base = validateNoToolRequest(state);
  return freezeSnapshot<NoToolValidationResult>({
    ...base,
    no_tool_request_id: contract.no_tool_request_id,
  });
}
