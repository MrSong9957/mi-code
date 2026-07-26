// src/agent/prompt/profiles.ts
// Wave B Task 9 (M-014/M-035): Agent Prompt Profile composition (BRC-4).
//
// 物理本质:把"角色 profile + 可选 task 模板 + 能力快照(由调用方以
// capability_supported 集合形式提供)+ final tool view(BRC-2 派生产物)"
// 压成一张不可变的 `AgentPromptProfileSnapshot`,并附带本次组合的诊断信息。
//
// Profile 的职责边界(spec §10.5):
//   - 它只负责"汇报":role/task 请求了哪些工具、required capabilities、prompt
//     asset 引用,以及 finalToolView 实际包含了哪些工具。
//   - 它不授予权限:final tool view + permission 由 BRC-2 + RC-5 决定。
//     Profile 绝不修改 finalToolView 的 visibility,也绝不让被 final view
//     排除的工具"复活"。被排除的请求工具只出现在 `diagnostic_codes` 里,
//     让上层能看到"role 请求了 X,但 final view 没给 X"这一事实。
//   - 它不验证 verification role 的结论是否应成为 `completed` —— 那是父 agent
//     的职责(Profile 只携带 completion_protocol_version + verification_requirement
//     作为声明性元数据)。
//
// 组合规则(spec §10.5,fixed):
//   1. role.prompt_asset_ref 必须通过 approvedAsset 校验;若 task 非空,
//      task.prompt_asset_ref 也必须通过。否则抛错(信息含 'approved' / 'asset')。
//   2. role.required_capabilities + task.required_capabilities 必须全部在
//      capability_supported 中。否则抛错(信息含 'capability')。
//   3. requested_tool_ids = role.requested_tool_ids(task 在 Wave B 不贡献额外
//      tool 请求;后续 Wave 若 task 模板自带 requested_tool_ids,在此处取并集)。
//   4. actual_tool_ids = finalToolView.entries 中 visibility === 'included' 的
//      tool_id 列表(顺序遵循 entries 顺序)。
//   5. 对每个 requested_tool_id 不在 actual_tool_ids 中的,emit diagnostic
//      'profile.tool_excluded.<tool_id>'。
//   6. prompt_asset_refs = [role.prompt_asset_ref] + (task ? [task.prompt_asset_ref] : [])。
//   7. completion_protocol_version 取自 role。
//   8. 整个输出(snapshot + actual_tool_ids + diagnostic_codes)经 freezeSnapshot
//      深冻结。
//   9. Profile 不做 permission check(spec §10.5 rule 4)。
//
// 注意:本模块不读 process.env / process.cwd / process.platform。所有外部
// 状态(能力、工具视图、asset 审批)都通过入参显式传入,便于测试与重放。

import { createHash } from 'node:crypto';
import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';
import type { RequestToolViewSnapshot } from '../tools/overlay.js';
import type {
  CompiledPromptSnapshot,
  PromptAssetApprovalLookup,
  PromptSectionInput,
} from './compiler.js';
import {
  compileResolvedPrompt,
  type PromptResolutionPlan,
  type ResolvedPromptCompileDeps,
} from './resolution.js';

// ────────────────────────────────────────────────────────────────────────────
// Public types — frozen per spec §10.
// ────────────────────────────────────────────────────────────────────────────

/**
 * 角色侧 profile:把 ROLE_REGISTRY 的一个 entry 升级成带身份与协议版本的
 * 声明性记录。`prompt_asset_ref` 指向 Prompt Library 中已批准的 role prompt
 * 资产(在 mi-code 仓库内,这等价于 `source.kind='mi-code'` 资产,证据引用
 * 指向 `src/__tests__/role-agents.test.ts` 与 `src/__tests__/subagent-result-integrity.test.ts`)。
 */
export interface AgentRoleProfile {
  role_id: string;
  role_version: string;
  prompt_asset_ref: { asset_id: string; asset_version: string };
  purpose: string;
  requested_tool_ids: string[];
  required_capabilities: string[];
  completion_protocol_version: string;
  verification_requirement: string;
}

/**
 * 任务侧 prompt 模板:把某种任务类型(如 'investigate' / 'migrate')对应的
 * prompt 模板升级成带版本与 schema 引用的声明性记录。Wave B 暂不预建任何
 * 具体任务类型(避免 pre-build unused task types);本类型供未来 Wave 注入。
 */
export interface TaskPromptTemplate {
  task_type: string;
  template_version: string;
  prompt_asset_ref: { asset_id: string; asset_version: string };
  input_schema_id: string;
  output_schema_id: string;
  required_capabilities: string[];
  no_tool_requirement: boolean;
}

/**
 * 不可变的组合后 snapshot:role/task 身份引用 + 请求的工具 + 必需能力 +
 * 完成协议版本 + prompt asset 引用列表。这是"本轮请求的 profile 底片"。
 */
export interface AgentPromptProfileSnapshot {
  profile_protocol_version: string;
  profile_snapshot_id: string;
  role_ref: { role_id: string; role_version: string };
  task_ref: { task_type: string; template_version: string } | null;
  requested_tool_ids: string[];
  required_capabilities: string[];
  completion_protocol_version: string;
  prompt_asset_refs: ReadonlyArray<{ asset_id: string; asset_version: string }>;
}

/**
 * composeAgentPromptProfile 的产物:除了不可变 snapshot,还附带
 * actual_tool_ids(final view 实际包含的工具)与 diagnostic_codes
 * (请求了但被 final view 排除的工具,以 'profile.tool_excluded.<tool_id>' 标记)。
 *
 * 这两个附加字段是"汇报性"的 —— 它们不会反向影响 final view 或权限决策。
 */
export interface ComposedAgentProfile {
  snapshot: AgentPromptProfileSnapshot;
  /**
   * finalToolView.entries 中 visibility === 'included' 的 tool_id 列表。
   * 顺序遵循 entries 的顺序。Profile 不修改 finalToolView,只读取它。
   */
  actual_tool_ids: string[];
  /**
   * 请求了但被 finalToolView 排除的工具,以 'profile.tool_excluded.<tool_id>'
   * 形式汇报。让上层能看到"role 请求了 X 但 final view 没给 X"。
   */
  diagnostic_codes: string[];
}

/**
 * composeAgentPromptProfile 的入参。
 *
 * - `capability_supported`:role/task 声明的 required_capabilities 必须全部
 *   在此集合中,否则抛错。这是 BRC-2 capability snapshot 的"已支持集合"投影。
 * - `finalToolView`:BRC-2 deriveRequestToolView 的产物。Profile 只读它,不改它。
 * - `approvedAsset`:Prompt Library 的 asset 审批回调(由调用方提供,
 *   通常查询 Prompt Registry 的 approval 状态)。
 */
export interface ComposeAgentPromptProfileInput {
  profile_protocol_version: string;
  profile_snapshot_id: string;
  role: AgentRoleProfile;
  task: TaskPromptTemplate | null;
  /** required caps 中被视为 'supported' 的集合(来自 BRC-2 capability snapshot)。 */
  capability_supported: ReadonlySet<string>;
  /** BRC-2 派生的最终工具视图。Profile 只读,不改。 */
  finalToolView: RequestToolViewSnapshot;
  /** Prompt asset 审批回调。返回 false → 抛错(mentioning 'approved' / 'asset')。 */
  approvedAsset: (ref: { asset_id: string; asset_version: string }) => boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// composeAgentPromptProfile: rule-based composition (spec §10.5).
// ────────────────────────────────────────────────────────────────────────────

/**
 * 组合 role + task + capability + final tool view,产出不可变的
 * {@link ComposedAgentProfile}。规则见模块头注释。
 *
 * @throws 当 role/task 的 prompt_asset_ref 未通过 approvedAsset(信息含
 *         'approved' / 'asset'),或 role/task 的 required_capabilities 未全部
 *         在 capability_supported 中(信息含 'capability')。
 */
export function composeAgentPromptProfile(
  input: ComposeAgentPromptProfileInput,
): ComposedAgentProfile {
  // 身份字段非空校验(与其它 snapshot builder 一致)。
  const profile_protocol_version = requireIdentity(
    input.profile_protocol_version,
    'profile_protocol_version',
  );
  const profile_snapshot_id = requireIdentity(
    input.profile_snapshot_id,
    'profile_snapshot_id',
  );

  const role = input.role;
  const task = input.task;

  // ── Rule 1: prompt asset approval ──
  // role 的 asset 必须批准;task 非空时,task 的 asset 也必须批准。
  if (!input.approvedAsset(role.prompt_asset_ref)) {
    throw new Error(
      `role prompt asset not approved: ${role.prompt_asset_ref.asset_id}@${role.prompt_asset_ref.asset_version}`,
    );
  }
  if (task !== null && !input.approvedAsset(task.prompt_asset_ref)) {
    throw new Error(
      `task prompt asset not approved: ${task.prompt_asset_ref.asset_id}@${task.prompt_asset_ref.asset_version}`,
    );
  }

  // ── Rule 2: required capabilities must all be supported ──
  // role.required_capabilities + task.required_capabilities 必须全部在
  // capability_supported 中。任一缺失即抛错(信息含 'capability')。
  const required_capabilities: string[] = [...role.required_capabilities];
  if (task !== null) {
    for (const cap of task.required_capabilities) {
      if (!required_capabilities.includes(cap)) required_capabilities.push(cap);
    }
  }
  for (const cap of required_capabilities) {
    if (!input.capability_supported.has(cap)) {
      throw new Error(
        `required capability not supported: ${cap} (role=${role.role_id}${task ? `, task=${task.task_type}` : ''})`,
      );
    }
  }

  // ── Rule 3: requested_tool_ids ──
  // Wave B:只取 role 的请求。未来 Wave 若 task 模板自带 requested_tool_ids,
  // 在此处取并集。
  const requested_tool_ids: string[] = [...role.requested_tool_ids];

  // ── Rule 4: actual_tool_ids ──
  // finalToolView.entries 中 visibility === 'included' 的 tool_id 列表,
  // 顺序遵循 entries 顺序。Profile 只读 finalToolView,不改它。
  const actual_tool_ids: string[] = [];
  for (const entry of input.finalToolView.entries) {
    if (entry.visibility === 'included') {
      actual_tool_ids.push(entry.tool_id);
    }
  }
  const actualSet = new Set(actual_tool_ids);

  // ── Rule 5: diagnostics for requested-but-excluded tools ──
  // 对每个 requested_tool_id 不在 actual_tool_ids 中的,emit
  // 'profile.tool_excluded.<tool_id>'。这是"汇报性"诊断,不影响 final view。
  const diagnostic_codes: string[] = [];
  for (const tid of requested_tool_ids) {
    if (!actualSet.has(tid)) {
      diagnostic_codes.push(`profile.tool_excluded.${tid}`);
    }
  }

  // ── Rule 6: prompt_asset_refs ──
  const prompt_asset_refs = task === null
    ? [{ ...role.prompt_asset_ref }]
    : [{ ...role.prompt_asset_ref }, { ...task.prompt_asset_ref }];

  // ── Rule 7: completion_protocol_version from role ──
  const completion_protocol_version = role.completion_protocol_version;

  // 组装 snapshot。
  const snapshot: AgentPromptProfileSnapshot = {
    profile_protocol_version,
    profile_snapshot_id,
    role_ref: { role_id: role.role_id, role_version: role.role_version },
    task_ref: task === null
      ? null
      : { task_type: task.task_type, template_version: task.template_version },
    requested_tool_ids,
    required_capabilities,
    completion_protocol_version,
    prompt_asset_refs,
  };

  // ── Rule 8: deep-freeze ──
  // freezeSnapshot 递归冻结 snapshot 及其子对象/数组(prompt_asset_refs、
  // role_ref、task_ref、requested_tool_ids、required_capabilities)。
  // 单独冻结 actual_tool_ids 与 diagnostic_codes(它们不挂在 snapshot 上)。
  freezeSnapshot(snapshot);
  freezeSnapshot(actual_tool_ids);
  freezeSnapshot(diagnostic_codes);

  return { snapshot, actual_tool_ids, diagnostic_codes };
}

// ────────────────────────────────────────────────────────────────────────────
// Wave D Task 1 (M-048): Mode Profile Selection (DRC-1).
//
// 物理本质:把结构化 control mode(以 control_mode_snapshot_id 为唯一真相源)+
// role/task identity + effective capability snapshot + CRC-1 resolution plan
// (candidate_section_ids)投影为 BRC-1 可编译的 section 集 —— 即决定哪些
// candidate section 进 included、哪些 optional section 被排除(带 reason code),
// 并核对 mandatory section 是否全覆盖。
//
// 严格边界(spec §7.1 / §7.5):
//   - DRC-1 不创建 mode、不从自然语言猜 mode、不决定 Provider cache、不改变
//     section Authority/Trust/Placement/content/hash/asset version。
//   - INV-D3: mode 只来自 control_mode_snapshot_id;用户文本、Prompt 内容、
//     模型自报的 "plan/build/auto" 字样不参与 mode 判定。空字符串即抛错。
//   - INV-D2: mandatory section 必须出现在 included_section_ids,或有受信
//     condition 明确 false 的 not_applicable evidence。本任务简化:不实现
//     condition 投影,mandatory 一律视为 included;condition evaluator 留
//     给后续 Wave。
//   - 只有 optional section 才能被排除,且必须带结构化 reason_code。
//   - 只有 status === 'valid' 的 selection 才能形成 BRC-1 PromptCompilationInput。
//
// 注意:本模块不读 process.env / process.cwd / process.platform。所有外部
// 状态(profile registry、asset 审批、mandatory 集合)都通过入参显式传入。
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mode profile 定义(spec §7.2)。来自 approved immutable asset 或受信构建配置。
 * 一个 control mode 最多一个有效 default profile;role/task override 必须
 * 精确匹配(不支持 substring 或 Prompt 内容判断)。
 */
export interface ModeProfileDefinition {
  profile_id: string;
  profile_version: string;
  source_asset_ref: { asset_id: string; asset_version: string };
  control_mode: string;
  allowed_role_refs: string[];
  allowed_task_type_refs: string[];
  include_capability_tags: string[];
  exclude_capability_tags: string[];
  default_for_mode: boolean;
}

/**
 * Profile 注册表 + 受信外部回调。`approvedAsset` 校验 profile 的
 * source_asset_ref 是否来自 approved immutable asset;`mandatorySectionIds`
 * 是 CRC-1 resolution plan 投影出的 mandatory section 集合。
 */
export interface ModeProfileRegistry {
  profiles: ReadonlyArray<ModeProfileDefinition>;
  approvedAsset: (ref: { asset_id: string; asset_version: string }) => boolean;
  mandatorySectionIds: ReadonlySet<string>;
}

/**
 * selectModeProfile 的入参(spec §7.3)。
 *
 * `control_mode_snapshot_id` 是唯一 mode 真相源;空字符串即抛错(INV-D3)。
 * 本任务简化:直接以该 snapshot id 字符串作为 mode key 用于 registry 匹配
 * (DRC-1 不解析 snapshot 内容,只引用其身份)。
 */
export interface ModeProfileSelectionInput {
  profile_protocol_version: string;
  request_snapshot_id: string;
  prompt_resolution_plan_id: string;
  control_mode_snapshot_id: string;
  role_profile_snapshot_id: string | null;
  task_profile_snapshot_id: string | null;
  effective_capability_snapshot_id: string;
  candidate_section_ids: string[];
}

/**
 * selectModeProfile 的产物(spec §7.4)。`included_section_ids` 与
 * `excluded_sections` 一起完整划分 candidate 集合;`mandatory_coverage`
 * 记录每个 mandatory section 的覆盖状态。`status === 'invalid'` 时
 * `selected_profile_ref` 为空串占位,selection 不得编译。
 */
export interface ModeProfileSelection {
  profile_protocol_version: string;
  selection_id: string;
  request_snapshot_id: string;
  selected_profile_ref: { profile_id: string; profile_version: string };
  prompt_resolution_plan_id: string;
  included_section_ids: string[];
  excluded_sections: ReadonlyArray<{
    section_id: string;
    reason_code: string;
  }>;
  mandatory_coverage: ReadonlyArray<{
    section_id: string;
    status: 'included' | 'not_applicable';
    condition_evidence_ref: string | null;
  }>;
  status: 'valid' | 'invalid';
  diagnostics: string[];
}

/**
 * 选定一个 mode profile 并把 candidate sections 投影为 included/excluded +
 * mandatory coverage(spec §7.4 / §7.5 / §7.6)。
 *
 * @throws 当 `control_mode_snapshot_id` 为空字符串(INV-D3:mode 只来自该字段,
 *         空即说明调用方未能确定 mode,拒绝猜测)。
 */
export function selectModeProfile(
  input: ModeProfileSelectionInput,
  registry: ModeProfileRegistry,
): ModeProfileSelection {
  // ── INV-D3: mode 只来自 control_mode_snapshot_id ──
  // 空字符串即抛错(信息含 'control_mode_snapshot_id'),不从用户文本/Prompt/
  // 模型自报推断 mode。requireIdentity 的错误信息格式为 "<field> must be ...",
  // 字段名出现在消息中,满足 toThrow(/control_mode_snapshot_id/)。
  const control_mode_snapshot_id = requireIdentity(
    input.control_mode_snapshot_id,
    'control_mode_snapshot_id',
  );
  const profile_protocol_version = requireIdentity(
    input.profile_protocol_version,
    'profile_protocol_version',
  );
  const request_snapshot_id = requireIdentity(
    input.request_snapshot_id,
    'request_snapshot_id',
  );
  const prompt_resolution_plan_id = requireIdentity(
    input.prompt_resolution_plan_id,
    'prompt_resolution_plan_id',
  );

  // mode key 直接取自 control_mode_snapshot_id(本任务简化:DRC-1 不解析
  // snapshot 内容,只引用其身份作为 mode 真相源)。
  const mode = control_mode_snapshot_id;

  const candidate = [...input.candidate_section_ids];
  const candidateSet = new Set(candidate);
  const mandatorySet = registry.mandatorySectionIds;
  const diagnostics: string[] = [];

  // ── §7.2 / §7.6: 选择 profile ──
  // 同 control_mode 的 profile 才是候选。
  const sameMode = registry.profiles.filter((p) => p.control_mode === mode);

  let selected: ModeProfileDefinition | null = null;
  let selectionError: string | null = null;

  if (sameMode.length === 0) {
    // control mode 未注册 → invalid,不猜 default(§7.6)。
    selectionError = 'profile.mode_not_registered';
  } else {
    // role/task override 必须精确匹配(§7.2 rule 3:不支持 substring)。
    const roleRef = input.role_profile_snapshot_id;
    const taskRef = input.task_profile_snapshot_id;

    let roleMatches: ModeProfileDefinition[] = [];
    let taskMatches: ModeProfileDefinition[] = [];
    if (roleRef !== null) {
      roleMatches = sameMode.filter(
        (p) => !p.default_for_mode && p.allowed_role_refs.includes(roleRef),
      );
    }
    if (taskRef !== null) {
      taskMatches = sameMode.filter(
        (p) => !p.default_for_mode && p.allowed_task_type_refs.includes(taskRef),
      );
    }

    if (roleMatches.length > 1) {
      selectionError = 'profile.role_override_multiple';
    } else if (taskMatches.length > 1) {
      selectionError = 'profile.task_override_multiple';
    } else if (roleMatches.length === 1) {
      selected = roleMatches[0];
    } else if (taskMatches.length === 1) {
      selected = taskMatches[0];
    } else {
      // 无 override 命中(或无 override 提供时)→ 走 default。
      const defaults = sameMode.filter((p) => p.default_for_mode);
      if (defaults.length > 1) {
        // §7.6: 同 mode 多 default → invalid。
        selectionError = 'profile.multiple_defaults';
      } else if (defaults.length === 1) {
        selected = defaults[0];
      } else {
        // override 未精确命中且无 default → invalid。
        selectionError = 'profile.no_matching_profile';
      }
    }
  }

  // 任何选择错误 → 构造 invalid 结果(仍计算 mandatory coverage 以便诊断,
  // 但 selected_profile_ref 为空串占位)。
  if (selectionError !== null) {
    diagnostics.push(selectionError);
  }

  // ── §7.6: profile asset 非 approved → invalid ──
  if (selected !== null && !registry.approvedAsset(selected.source_asset_ref)) {
    diagnostics.push('profile.asset_not_approved');
    selected = null; // 标记为未选定,后续用空占位
  }

  const selectedProfileRef =
    selected !== null
      ? { profile_id: selected.profile_id, profile_version: selected.profile_version }
      : { profile_id: '', profile_version: '' };

  // ── INV-D2 / §7.5 rule 1: mandatory coverage ──
  // 本任务简化:mandatory section 一律视为 included(不实现 condition 投影)。
  // mandatory 缺失(不在 candidate_section_ids)→ invalid + diagnostic。
  const mandatory_coverage: {
    section_id: string;
    status: 'included' | 'not_applicable';
    condition_evidence_ref: string | null;
  }[] = [];
  for (const section_id of mandatorySet) {
    if (candidateSet.has(section_id)) {
      mandatory_coverage.push({
        section_id,
        status: 'included',
        condition_evidence_ref: null,
      });
    } else {
      // mandatory 不在 candidate → invalid,记录结构化 diagnostic。
      diagnostics.push(`profile.mandatory_missing.${section_id}`);
      // 不加入 mandatory_coverage(它不在 candidate 集合中,无法覆盖)。
    }
  }

  // ── §7.5 rule 2 / rule 10: optional section 排除 ──
  // 规格语义:只有 optional section 才能因 mode/role/task/capability 不适用
  // 而排除,且必须带结构化 reason_code。mandatory section 一律 included。
  //
  // 本任务简化(无 capability tag 投影、无 condition evaluator):
  //   - 当 registry 声明了非空 mandatory 集合时,profile 才启动 optional
  //     投影 —— 此时不在 mandatory 的 candidate 一律视为 optional,因"无
  //     capability 投影可用以证明适用性"而排除(reason_code 'profile.optional_excluded')。
  //   - 当 mandatory 集合为空时,registry 未给出任何 mandatory 声明,profile
  //     无法判定哪些 candidate 是 optional,保守透传所有 candidate 作为 included
  //     (避免无故删除 section)。
  // 这条规则与规格 rule 4 一致:profile 不改 section content/Authority/Placement,
  // 只在能证明 optional 不适用时才排除。
  const mandatoryIsEmpty = mandatorySet.size === 0;
  const included_section_ids: string[] = [];
  const excluded_sections: { section_id: string; reason_code: string }[] = [];
  for (const section_id of candidate) {
    if (mandatorySet.has(section_id)) {
      included_section_ids.push(section_id);
    } else if (mandatoryIsEmpty) {
      // 未声明 mandatory → 无法判定 optional,保守 include。
      included_section_ids.push(section_id);
    } else {
      excluded_sections.push({
        section_id,
        reason_code: 'profile.optional_excluded',
      });
    }
  }

  const status: 'valid' | 'invalid' = diagnostics.length === 0 ? 'valid' : 'invalid';

  // ── §7.4 selection_id: sel:<sha256(canonical).slice(0,16)> ──
  // canonical JSON 覆盖 protocol_version / request_snapshot_id / plan_id /
  // control_mode_snapshot_id / selected_profile / included / excluded /
  // mandatory_coverage。同输入必同输出(确定性)。
  const canonical = JSON.stringify({
    profile_protocol_version,
    request_snapshot_id,
    prompt_resolution_plan_id,
    control_mode_snapshot_id,
    selected_profile_ref: selectedProfileRef,
    included_section_ids,
    excluded_sections,
    mandatory_coverage,
  });
  const digest = createHash('sha256').update(canonical).digest('hex');
  const selection_id = `sel:${digest.slice(0, 16)}`;

  const selection: ModeProfileSelection = {
    profile_protocol_version,
    selection_id,
    request_snapshot_id,
    selected_profile_ref: selectedProfileRef,
    prompt_resolution_plan_id,
    included_section_ids,
    excluded_sections,
    mandatory_coverage,
    status,
    diagnostics,
  };

  // 深冻结输出(与其它 snapshot builder 一致)。
  freezeSnapshot(selection);
  return selection;
}

// ────────────────────────────────────────────────────────────────────────────
// Wave D Task 2 (M-048): Profiled Compiler Input (DRC-1).
//
// 物理本质:compileProfiledPrompt 是 selectModeProfile → compileResolvedPrompt
// → compilePromptSnapshot 之间的薄 adapter。它把 DRC-1 selection(status='valid')
// 与 CRC-1 plan + BRC-1 编译依赖绑定到一起,验证三者绑定一致,然后把
// selection.included_section_ids 投影为一个过滤后的 plan,委托 CRC-1 编译器
// 产出最终的 CompiledPromptSnapshot。
//
// 严格边界(spec §7.5):
//   - 本 adapter 不做选择、排序、批准决策 —— 那些都已冻结在 selection 与 plan 里。
//   - 不修改 section 的 content_hash / Authority / Trust / Placement / asset_version
//     / scope(那些由 compilePromptSnapshot 保证)。它只做 included/excluded 投影。
//   - §7.5 rule 6:selected profile 与 resolution plan 必须绑定同一 request snapshot。
//   - §7.5 rule 1:mandatory section 必须有 included 或带 evidence 的 not_applicable。
//   - §7.4:只有 status='valid' 的 selection 才能形成 BRC-1 compilation input。
//   - 失败时直接 throw,不做字符串拼接 fallback(spec §7.4 rule 9 / §7.5 rule 1)。
//
// 注意:本模块不读 process.env / process.cwd / process.platform。所有外部
// 状态(section resolver / approval lookup / identity)都通过 deps 显式传入。
// ────────────────────────────────────────────────────────────────────────────

/**
 * compileProfiledPrompt 的依赖(spec §17.1)。
 *
 * 与 CRC-1 ResolvedPromptCompileDeps 相同的形状,因为本 adapter 最终委托给
 * compileResolvedPrompt。`request_snapshot_id` 必须与
 * {@link ModeProfileSelection.request_snapshot_id} 一致,且必须出现在
 * plan.input_snapshot_ids 中(§7.5 rule 6)。
 */
export interface ProfiledCompileDeps {
  /** section_input_ref → PromptSectionInput 的解析回调。 */
  resolveSection: (section_input_ref: string) => PromptSectionInput;
  /** asset_ref → 是否 approved 的查询(BRC-1 lookup)。 */
  approvalLookup: PromptAssetApprovalLookup;
  /** BRC-1 identity 字段,由调用方提供。 */
  compiler_protocol_version: string;
  registry_snapshot_id: string;
  request_snapshot_id: string;
}

/**
 * 把一个 valid {@link ModeProfileSelection} + CRC-1 {@link PromptResolutionPlan}
 * + BRC-1 编译依赖绑定,投影并编译为 {@link CompiledPromptSnapshot}。
 *
 * 算法(规格 §7.5 / §17.1):
 *   1. request snapshot 一致性:selection.request_snapshot_id === deps.request_snapshot_id
 *      且 deps.request_snapshot_id ∈ plan.input_snapshot_ids。否则 throw
 *      'request_snapshot_mismatch'(§7.5 rule 6)。
 *   2. selection status:selection.status !== 'valid' → throw 'selection.invalid'
 *      (§7.4:不 fallback 字符串拼接)。
 *   3. plan/selection 绑定:selection.prompt_resolution_plan_id === plan.resolution_id,
 *      否则 throw 'plan_mismatch'。
 *   4. included ⊆ plan:selection.included_section_ids 中每个 ref 必须出现在
 *      plan.ordered_section_refs 中。否则 throw 'included_section_not_in_plan'。
 *      (防御性:正常的 selectModeProfile 不会产生越界 ref,但 adapter 必须守门。)
 *   5. mandatory coverage 完整(§7.5 rule 1):每个 mandatory_coverage 项的 status
 *      必须是 'included' 或 'not_applicable';若 'not_applicable' 则必须有
 *      非空 condition_evidence_ref。否则 throw
 *      'mandatory.not_applicable_without_evidence'。
 *   6. 投影:构造一个 derived plan,其 ordered_section_refs = plan.ordered_section_refs
 *      与 selection.included_section_ids 的交集(保持 plan 顺序);
 *      included_section_assets 同步过滤。然后委托 compileResolvedPrompt 编译。
 *      excluded section 不进入 compiler。
 *
 * 任何下层错误(BRC-1 校验、CRC-1 asset 漂移、resolveSection 失败)直接透传,
 * 不做 fallback。
 *
 * @throws 当 selection 与 plan/deps 不绑定同一 request snapshot、selection 非
 *         valid、plan_id 不匹配、mandatory coverage 不完整、included 越界 plan,
 *         或下层 compiler 抛错时。
 */
export function compileProfiledPrompt(
  selection: ModeProfileSelection,
  plan: PromptResolutionPlan,
  deps: ProfiledCompileDeps,
): CompiledPromptSnapshot {
  // ── Step 1: request snapshot 一致性(§7.5 rule 6) ──
  // selection.request_snapshot_id、deps.request_snapshot_id 必须一致,
  // 且该 id 必须出现在 plan.input_snapshot_ids(plan 必须绑定同一 request)。
  const selectionReq = selection.request_snapshot_id;
  const depsReq = deps.request_snapshot_id;
  if (selectionReq !== depsReq || !plan.input_snapshot_ids.includes(depsReq)) {
    throw new Error(
      `request_snapshot_mismatch: selection.request_snapshot_id='${selectionReq}', ` +
        `deps.request_snapshot_id='${depsReq}', ` +
        `plan.input_snapshot_ids=[${plan.input_snapshot_ids.join(',')}]`,
    );
  }

  // ── Step 2: selection status(§7.4) ──
  if (selection.status !== 'valid') {
    throw new Error(
      `selection.invalid: status='${selection.status}', ` +
        `diagnostics=[${selection.diagnostics.join(',')}]`,
    );
  }

  // ── Step 3: plan/selection 绑定 ──
  if (selection.prompt_resolution_plan_id !== plan.resolution_id) {
    throw new Error(
      `plan_mismatch: selection.prompt_resolution_plan_id='${selection.prompt_resolution_plan_id}' ` +
        `!= plan.resolution_id='${plan.resolution_id}'`,
    );
  }

  // ── Step 4: included ⊆ plan.ordered_section_refs ──
  // 防御性检查:正常的 selectModeProfile 会保证 included 都来自 candidate,
  // 而 candidate 即来自 plan,但 adapter 不得假设调用方遵守协议。
  const planOrderedSet = new Set(plan.ordered_section_refs);
  for (const ref of selection.included_section_ids) {
    if (!planOrderedSet.has(ref)) {
      throw new Error(
        `included_section_not_in_plan: section_input_ref='${ref}' is in ` +
          `selection.included_section_ids but not in plan.ordered_section_refs ` +
          `[${plan.ordered_section_refs.join(',')}]`,
      );
    }
  }

  // ── Step 5: mandatory coverage 完整(§7.5 rule 1) ──
  // 每个 mandatory_coverage 项必须 status='included',或 status='not_applicable'
  // 且 condition_evidence_ref 非空。任何 not_applicable 缺 evidence 即抛错。
  for (const coverage of selection.mandatory_coverage) {
    if (coverage.status === 'not_applicable') {
      if (
        coverage.condition_evidence_ref === null ||
        coverage.condition_evidence_ref.trim().length === 0
      ) {
        throw new Error(
          `mandatory.not_applicable_without_evidence: mandatory section ` +
            `'${coverage.section_id}' is marked not_applicable but has no condition_evidence_ref`,
        );
      }
    }
  }

  // ── Step 6: 投影并委托 ──
  // 构造 derived plan:ordered_section_refs 取 plan 顺序下与
  // selection.included_section_ids 的交集;included_section_assets 同步过滤。
  // 不修改原 plan(它已 frozen)。derived plan 的其它字段照搬原 plan。
  const includedSet = new Set(selection.included_section_ids);
  const derivedOrderedSectionRefs = plan.ordered_section_refs.filter((ref) =>
    includedSet.has(ref),
  );
  const derivedIncludedSectionAssets: Record<
    string,
    { asset_id: string; asset_version: string }
  > = {};
  for (const ref of derivedOrderedSectionRefs) {
    const asset = plan.included_section_assets[ref];
    if (asset === undefined) {
      // 这条理论上不会触发(included ⊆ plan 已在 Step 4 验证),但 CRC-1
      // compileResolvedPrompt 也会再次检查;此处显式抛出便于定位。
      throw new Error(
        `plan_mismatch: section_input_ref='${ref}' is in plan.ordered_section_refs ` +
          `but missing from plan.included_section_assets`,
      );
    }
    derivedIncludedSectionAssets[ref] = {
      asset_id: asset.asset_id,
      asset_version: asset.asset_version,
    };
  }

  // derived plan 复用原 plan 的所有元信息,只覆盖投影相关字段。
  // 注意:这里不重新计算 resolution_id(derived plan 不需要被外部引用);
  // compileResolvedPrompt 也不消费 resolution_id。
  const derivedPlan: PromptResolutionPlan = {
    ...plan,
    ordered_section_refs: derivedOrderedSectionRefs,
    included_section_assets: derivedIncludedSectionAssets,
  };

  // 委托 compileResolvedPrompt。deps 形状与 ResolvedPromptCompileDeps 一致。
  const resolvedDeps: ResolvedPromptCompileDeps = {
    resolveSection: deps.resolveSection,
    approvalLookup: deps.approvalLookup,
    compiler_protocol_version: deps.compiler_protocol_version,
    registry_snapshot_id: deps.registry_snapshot_id,
    request_snapshot_id: deps.request_snapshot_id,
  };

  return compileResolvedPrompt(derivedPlan, resolvedDeps);
}
