// src/agent/prompt/resolution.ts
// Wave C Tasks 1+2+3 — CRC-1 Prompt Resolution Policy.
//
// 物理本质:本文件实现 prompt 的"选择 + 排序 + 政策化"阶段,产出
// PromptResolutionPlan,作为 BRC-1 compilePromptSnapshot 的上游政策证据。
//
// 文件边界(对应 spec §7.2 ~ §7.8 / §17.1):
//   - M-004:封闭 PromptCondition DSL(三态、无脚本/spec §7.5 rule 1)。
//   - M-003:Static/Dynamic scope 分类(unknown 按 dynamic 处理/spec §7.6)。
//   - M-002:PromptResolutionPlan 算法(base precedence / append / 错误语义)。
//   - CRC-1 → BRC-1 adapter:把 plan 编译为 CompiledPromptSnapshot。
//   - 消费 BRC-1 类型(从 ./compiler.js 导入)但不修改 compiler.ts。
//
// 关键不变量:
//   1. Condition DSL 封闭(spec §7.5 rule 1):未知 kind 直接 throw,不静默为 unknown。
//   2. Condition 三态(spec §7.5 rule 1):'true' | 'false' | 'unknown',
//      never boolean。
//   3. Condition 深度上限 16(spec 任务约束):超过返回 truth='unknown' +
//      reason_code='condition.depth_exceeded'。
//   4. capability_is 只接受 expected 'supported'/'unsupported'(spec §7.5)。
//   5. evidence_refs 必须出现在 ConditionEvaluation 里(spec §7.5 rule 7)。
//   6. PromptScopeDecision 不能有 cache_hit / saved_tokens / provider_cache_supported
//      字段(spec §17.1 rule 8 / §7.6 INV-C4)。
//   7. mandatory unknown → rejected;optional unknown → excluded(spec §7.8)。
//   8. 同层 base 冲突 → rejected,不猜 winner(spec §7.3 rule 4 / §7.8)。
//   9. 同一 (policy_id + policy_version + immutable input snapshots) 必须产生
//      相同 resolution_id(INV-C1 / spec §6.4)。

import { createHash } from 'node:crypto';

import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';
import type {
  CompiledPromptSnapshot,
  PromptAssetApprovalLookup,
  PromptCompilationInput,
  PromptSectionInput,
} from './compiler.js';
import { compilePromptSnapshot } from './compiler.js';

// ---------------------------------------------------------------------------
// §7.5 Condition DSL — 公共类型
// ---------------------------------------------------------------------------

export type ConditionTruth = 'true' | 'false' | 'unknown';

export type PromptCondition =
  | { kind: 'control_mode_is'; expected: string }
  | { kind: 'role_is'; expected: string }
  | {
      kind: 'capability_is';
      capability: string;
      expected: 'supported' | 'unsupported';
    }
  | {
      kind: 'trusted_config_flag_is';
      flag_id: string;
      expected: boolean;
    }
  | { kind: 'context_source_present'; source_class: string }
  | { kind: 'all' | 'any'; children: PromptCondition[] }
  | { kind: 'not'; child: PromptCondition };

export interface ConditionEvaluationContext {
  control_mode: string;
  role_id: string | null;
  capabilities: Readonly<Record<string, 'supported' | 'unsupported' | 'unknown'>>;
  trusted_flags: Readonly<Record<string, boolean>>;
  present_source_classes: ReadonlySet<string>;
  evidence_refs: string[];
}

export interface ConditionEvaluation {
  condition_ref: string;
  truth: ConditionTruth;
  evidence_refs: string[];
  reason_code: string;
}

// ---------------------------------------------------------------------------
// §7.5 Condition DSL — 实现
// ---------------------------------------------------------------------------

/**
 * Condition 嵌套深度上限(spec 任务约束)。
 * 超过时返回 truth='unknown' + reason_code='condition.depth_exceeded',
 * 不抛错(spec §7.5 rule 1 三态优先于异常)。
 *
 * 数值取 16:足够表达现实策略树,又能防止恶意/意外深递归耗栈。
 */
const CONDITION_MAX_DEPTH = 16;

const CONDITION_KNOWN_LEAF_KINDS: ReadonlySet<string> = new Set([
  'control_mode_is',
  'role_is',
  'capability_is',
  'trusted_config_flag_is',
  'context_source_present',
]);

const CONDITION_COMPOSITE_KINDS: ReadonlySet<string> = new Set([
  'all',
  'any',
  'not',
]);

/**
 * 求值一个封闭 PromptCondition,返回三态结果(spec §7.5)。
 *
 * 实现要点:
 *   - 封闭 DSL(spec §7.5 rule 1):未知 kind 直接 throw,不静默 unknown。
 *   - evidence_refs 来自 ConditionEvaluationContext.evidence_refs;每次求值
 *     都会复制一份,使调用方后续修改 context.evidence_refs 不影响已返回结果。
 *   - depth 参数是内部递归计数;调用方不需要传。
 */
export function evaluatePromptCondition(
  condition: PromptCondition,
  context: ConditionEvaluationContext,
  condition_ref: string,
): ConditionEvaluation {
  // 入口处复制一份 evidence_refs,保证返回值的 evidence 独立于 context 后续变更。
  const evidence = [...context.evidence_refs];
  const result = evalRecursive(condition, context, 1);
  return freezeSnapshot({
    condition_ref,
    truth: result.truth,
    evidence_refs: evidence,
    reason_code: result.reason_code,
  });
}

interface RecursiveResult {
  truth: ConditionTruth;
  reason_code: string;
}

function evalRecursive(
  condition: PromptCondition,
  context: ConditionEvaluationContext,
  depth: number,
): RecursiveResult {
  // 深度上限保护:超过即视为 unknown(不抛错,符合 §7.5 三态语义)。
  if (depth > CONDITION_MAX_DEPTH) {
    return {
      truth: 'unknown',
      reason_code: 'condition.depth_exceeded',
    };
  }

  const kind = (condition as { kind?: unknown }).kind;

  // 复合节点优先处理(它们需要传递 depth+1 给子节点)。
  if (kind === 'all') {
    return evalAll((condition as { children: PromptCondition[] }).children, context, depth);
  }
  if (kind === 'any') {
    return evalAny((condition as { children: PromptCondition[] }).children, context, depth);
  }
  if (kind === 'not') {
    const child = (condition as { child: PromptCondition }).child;
    const inner = evalRecursive(child, context, depth + 1);
    // unknown 不反转;true ↔ false 反转。
    let truth: ConditionTruth = inner.truth;
    if (inner.truth === 'true') truth = 'false';
    else if (inner.truth === 'false') truth = 'true';
    return {
      truth,
      reason_code: inner.reason_code === 'condition.depth_exceeded'
        ? inner.reason_code
        : `condition.not.${reasonLeaf(inner.reason_code)}`,
    };
  }

  if (kind === 'control_mode_is') {
    const expected = (condition as { expected: string }).expected;
    const match = context.control_mode === expected;
    return {
      truth: match ? 'true' : 'false',
      reason_code: match ? 'condition.control_mode_is.match' : 'condition.control_mode_is.mismatch',
    };
  }

  if (kind === 'role_is') {
    const expected = (condition as { expected: string }).expected;
    if (context.role_id === null) {
      return {
        truth: 'false',
        reason_code: 'condition.role_is.no_role',
      };
    }
    const match = context.role_id === expected;
    return {
      truth: match ? 'true' : 'false',
      reason_code: match ? 'condition.role_is.match' : 'condition.role_is.mismatch',
    };
  }

  if (kind === 'capability_is') {
    const c = condition as {
      capability: string;
      expected: 'supported' | 'unsupported';
    };
    const present = c.capability in context.capabilities;
    if (!present) {
      return {
        truth: 'unknown',
        reason_code: 'condition.capability_is.absent',
      };
    }
    const actual = context.capabilities[c.capability];
    if (actual === 'unknown') {
      return {
        truth: 'unknown',
        reason_code: 'condition.capability_is.unknown',
      };
    }
    const match = actual === c.expected;
    return {
      truth: match ? 'true' : 'false',
      reason_code: match ? 'condition.capability_is.match' : 'condition.capability_is.mismatch',
    };
  }

  if (kind === 'trusted_config_flag_is') {
    const f = condition as { flag_id: string; expected: boolean };
    const present = f.flag_id in context.trusted_flags;
    if (!present) {
      return {
        truth: 'unknown',
        reason_code: 'condition.trusted_config_flag_is.absent',
      };
    }
    const actual = context.trusted_flags[f.flag_id];
    const match = actual === f.expected;
    return {
      truth: match ? 'true' : 'false',
      reason_code: match
        ? 'condition.trusted_config_flag_is.match'
        : 'condition.trusted_config_flag_is.mismatch',
    };
  }

  if (kind === 'context_source_present') {
    const src = (condition as { source_class: string }).source_class;
    const present = context.present_source_classes.has(src);
    return {
      truth: present ? 'true' : 'false',
      reason_code: present
        ? 'condition.context_source_present.match'
        : 'condition.context_source_present.mismatch',
    };
  }

  // 封闭 DSL:任何其它 kind 都是配置错误,抛错而非静默 unknown。
  throw new Error(
    `unsupported condition kind '${String(kind)}': known leaf kinds=[${[
      ...CONDITION_KNOWN_LEAF_KINDS,
    ].join(',')}] composite kinds=[${[...CONDITION_COMPOSITE_KINDS].join(',')}]`,
  );
}

/**
 * all:全 true 才 true;含 false 即 false;无 false 且有 unknown 即 unknown。
 */
function evalAll(
  children: PromptCondition[],
  context: ConditionEvaluationContext,
  depth: number,
): RecursiveResult {
  let sawUnknown = false;
  for (const child of children) {
    const r = evalRecursive(child, context, depth + 1);
    if (r.truth === 'false') {
      return {
        truth: 'false',
        reason_code: 'condition.all.false_child',
      };
    }
    if (r.truth === 'unknown' || r.reason_code === 'condition.depth_exceeded') {
      sawUnknown = true;
    }
  }
  return sawUnknown
    ? { truth: 'unknown', reason_code: 'condition.all.unknown_child' }
    : { truth: 'true', reason_code: 'condition.all.all_true' };
}

/**
 * any:任一 true 即 true;全 false 即 false;无 true 且有 unknown 即 unknown。
 */
function evalAny(
  children: PromptCondition[],
  context: ConditionEvaluationContext,
  depth: number,
): RecursiveResult {
  let sawUnknown = false;
  for (const child of children) {
    const r = evalRecursive(child, context, depth + 1);
    if (r.truth === 'true') {
      return {
        truth: 'true',
        reason_code: 'condition.any.true_child',
      };
    }
    if (r.truth === 'unknown' || r.reason_code === 'condition.depth_exceeded') {
      sawUnknown = true;
    }
  }
  return sawUnknown
    ? { truth: 'unknown', reason_code: 'condition.any.unknown_child' }
    : { truth: 'false', reason_code: 'condition.any.all_false' };
}

/** 把 "condition.capability_is.absent" 之类折叠成 "absent",用于嵌套 reason_code 拼接。 */
function reasonLeaf(reason_code: string): string {
  const idx = reason_code.lastIndexOf('.');
  return idx >= 0 ? reason_code.slice(idx + 1) : reason_code;
}

// ---------------------------------------------------------------------------
// §7.6 Static/Dynamic Scope — 公共类型与实现
// ---------------------------------------------------------------------------

export type PromptScopeClass = 'static' | 'dynamic' | 'unknown';

export interface PromptScopeDecision {
  section_id: string;
  scope: PromptScopeClass;
  dependency_kinds: string[];
  reason_code: string;
}

/**
 * 已知会导致 dynamic 的 dependency kind 集合(spec §7.6):
 *   user / session / turn / time / cwd / environment / memory /
 *   tool_result / attachment / request_override / mutable_config。
 *
 * 任一出现 → dynamic。
 */
const DYNAMIC_DEPENDENCY_KINDS: ReadonlySet<string> = new Set([
  'user',
  'session',
  'turn',
  'time',
  'cwd',
  'environment',
  'memory',
  'tool_result',
  'attachment',
  'request_override',
  'mutable_config',
]);

/**
 * 分类 section 是 static / dynamic / unknown(spec §7.6)。
 *
 * 规则:
 *   - 任一已知 dynamic 依赖出现 → dynamic。
 *   - !immutable_asset → dynamic(spec §7.6 "内容由 approved immutable asset 决定" 反例)。
 *   - !stable_order → dynamic(spec §7.6 "顺序稳定" 反例)。
 *   - 出现未在已知 dynamic 集合内的未知 kind,但其它条件都满足 → unknown。
 *   - 空依赖 + immutable + stable → static。
 *   - unknown 在 resolution 中按 dynamic effective 处理,但原始 scope 字段保留为 'unknown'。
 */
export function classifyPromptScope(input: {
  section_id: string;
  immutable_asset: boolean;
  dependency_kinds: readonly string[];
  stable_order: boolean;
}): PromptScopeDecision {
  const dependency_kinds = [...input.dependency_kinds];

  if (!input.immutable_asset) {
    return freezeSnapshot({
      section_id: input.section_id,
      scope: 'dynamic',
      dependency_kinds,
      reason_code: 'scope.dynamic.mutable_asset',
    });
  }

  if (!input.stable_order) {
    return freezeSnapshot({
      section_id: input.section_id,
      scope: 'dynamic',
      dependency_kinds,
      reason_code: 'scope.dynamic.unstable_order',
    });
  }

  let sawUnknownKind = false;
  for (const kind of dependency_kinds) {
    if (DYNAMIC_DEPENDENCY_KINDS.has(kind)) {
      return freezeSnapshot({
        section_id: input.section_id,
        scope: 'dynamic',
        dependency_kinds,
        reason_code: `scope.dynamic.dependency:${kind}`,
      });
    }
    // 不是已知 dynamic kind,也不是空 —— 视为 unknown。
    sawUnknownKind = true;
  }

  if (sawUnknownKind) {
    return freezeSnapshot({
      section_id: input.section_id,
      scope: 'unknown',
      dependency_kinds,
      reason_code: 'scope.unknown',
    });
  }

  return freezeSnapshot({
    section_id: input.section_id,
    scope: 'static',
    dependency_kinds,
    reason_code: 'scope.static',
  });
}

// ---------------------------------------------------------------------------
// §7.2/§7.3/§7.7 PromptResolution — RED stub(将在 GREEN 阶段实现)
// ---------------------------------------------------------------------------

export type PromptCandidateKind =
  | 'trusted_runtime_override'
  | 'coordinator_profile'
  | 'agent_role_profile'
  | 'approved_custom_profile'
  | 'default_base'
  | 'append_section';

export type PromptCandidateOperation = 'replace_base' | 'append';
export type PromptCandidateCriticality = 'mandatory' | 'optional';

export interface PromptResolutionCandidate {
  candidate_id: string;
  candidate_kind: PromptCandidateKind;
  operation: PromptCandidateOperation;
  criticality: PromptCandidateCriticality;
  section_input_ref: string;
  asset_ref: {
    asset_id: string;
    asset_version: string;
  };
  authority: string;
  trust: string;
  stable_order: number;
  condition_ref: string | null;
  dependency_snapshot_ids: string[];
}

export interface PolicyRef {
  policy_id: string;
  policy_version: string;
}

export interface SectionScopeInput {
  section_input_ref: string;
  immutable_asset: boolean;
  dependency_kinds: readonly string[];
  stable_order: boolean;
}

export interface PromptResolutionInput {
  resolution_protocol_version: string;
  policy_ref: PolicyRef;
  input_snapshot_ids: string[];
  candidates: readonly PromptResolutionCandidate[];
  condition_context: ConditionEvaluationContext;
  /** condition_ref → PromptCondition 表;candidate.condition_ref 在此查表。 */
  conditions: Readonly<Record<string, PromptCondition>>;
  /** candidate_id → scope 输入;用于 classifyPromptScope。 */
  section_scope_inputs: Readonly<Record<string, SectionScopeInput>>;
  approvedAsset: (ref: { asset_id: string; asset_version: string }) => boolean;
}

export interface ExcludedCandidate {
  candidate_id: string;
  reason_code: string;
}

export interface PromptResolutionPlan {
  resolution_protocol_version: string;
  resolution_id: string;
  policy_ref: PolicyRef;
  input_snapshot_ids: string[];
  selected_base_candidate_id: string;
  mandatory_candidate_ids: string[];
  included_append_candidate_ids: string[];
  excluded_candidates: ReadonlyArray<ExcludedCandidate>;
  condition_evaluations: ReadonlyArray<ConditionEvaluation>;
  scope_decisions: ReadonlyArray<PromptScopeDecision>;
  ordered_section_refs: string[];
  /**
   * section_input_ref → 该 section 在 resolution 时绑定的 asset_ref(spec §17.1 CRC-1 rule 2)。
   *
   * 这是规格 §7.7 字段集合的最小必要扩展,使 Task 3 compiler adapter 能做 asset identity
   * drift 检测(section 解引用后的 asset_ref 必须与 plan 决策时的 asset_ref 一致)。
   * 不在规格 §7.7 字面列表里 —— 见简报中报告的规格 gap。
   */
  included_section_assets: Readonly<
    Record<string, { asset_id: string; asset_version: string }>
  >;
}

export function resolvePromptPolicy(input: PromptResolutionInput): PromptResolutionPlan {
  // ---- 0) identity 守门(早失败) -----------------------------------------------
  // 复用 Wave A 的 requireIdentity(与所有其他 RC/BRC/CRC 保持一致,避免重复实现)。
  const resolution_protocol_version = requireIdentity(
    input.resolution_protocol_version,
    'resolution_protocol_version',
  );
  requireIdentity(input.policy_ref.policy_id, 'policy_ref.policy_id');
  requireIdentity(input.policy_ref.policy_version, 'policy_ref.policy_version');
  if (input.input_snapshot_ids.length === 0) {
    throw new Error('base.rejected: input_snapshot_ids must not be empty');
  }
  for (const id of input.input_snapshot_ids) {
    requireIdentity(id, 'input_snapshot_ids[]');
  }

  // ---- 1) 第一遍过滤:asset 未批准 → excluded ----------------------------------
  // 不动 condition 评估顺序;按 candidate 原始顺序遍历,以保持 reason_code 可读性。
  const excluded: ExcludedCandidate[] = [];
  const conditionEvaluations: ConditionEvaluation[] = [];

  // activeCandidates = 通过 asset gate 的候选(base + append 都先过这一关)
  interface Active {
    candidate: PromptResolutionCandidate;
    conditionEval: ConditionEvaluation | null; // null 表示无 condition
  }
  const active: Active[] = [];

  for (const candidate of input.candidates) {
    if (!input.approvedAsset(candidate.asset_ref)) {
      excluded.push({
        candidate_id: candidate.candidate_id,
        reason_code: 'candidate.asset_not_approved',
      });
      continue;
    }
    active.push({ candidate, conditionEval: null });
  }

  // ---- 2) 评估所有 active candidate 的 condition(三态) -----------------------
  // 注意:即便后续会被 rank 淘汰,condition 评估也要记录到 condition_evaluations
  // 里(spec §7.9 handoff 要求提供"每个 condition 的三态结果和 evidence")。
  for (const a of active) {
    if (a.candidate.condition_ref === null) {
      continue;
    }
    const conditionExpr = input.conditions[a.candidate.condition_ref];
    // condition_ref 指向不存在的 condition 视为 unknown(spec §7.5 rule 3 隐含)。
    if (conditionExpr === undefined) {
      conditionEvaluations.push(
        freezeSnapshot({
          condition_ref: a.candidate.condition_ref,
          truth: 'unknown' as ConditionTruth,
          evidence_refs: [...input.condition_context.evidence_refs],
          reason_code: 'condition.missing_definition',
        }),
      );
      a.conditionEval = conditionEvaluations[conditionEvaluations.length - 1] ?? null;
      continue;
    }
    const evalResult = evaluatePromptCondition(
      conditionExpr,
      input.condition_context,
      a.candidate.condition_ref,
    );
    conditionEvaluations.push(evalResult);
    a.conditionEval = evalResult;
  }

  // ---- 3) 处理 base candidate --------------------------------------------------
  // 按 rank 分组:rank 越小越优先(spec §7.3)。
  const baseActive = active.filter((a) => a.candidate.operation === 'replace_base');

  // 对每个 base,根据 condition truth 决定是否"有效参与竞争"或 excluded/rejected。
  interface BaseStatus {
    candidate: PromptResolutionCandidate;
    truth: ConditionTruth; // 'true' = 无 condition 或 condition=true
  }
  const participatingByRank: Map<number, BaseStatus[]> = new Map();

  for (const a of baseActive) {
    const truth: ConditionTruth = a.conditionEval ? a.conditionEval.truth : 'true';

    if (truth === 'false') {
      // condition=false → excluded(无论 mandatory/optional),不参与竞争
      excluded.push({
        candidate_id: a.candidate.candidate_id,
        reason_code: 'candidate.condition_false',
      });
      continue;
    }

    if (truth === 'unknown') {
      // mandatory unknown → rejected(整次 resolution 失败)
      // optional unknown → excluded(不 throw)
      if (a.candidate.criticality === 'mandatory') {
        throw new Error(
          `base.condition_unknown: mandatory base candidate '${a.candidate.candidate_id}' ` +
            `has unknown condition '${a.candidate.condition_ref}'`,
        );
      }
      excluded.push({
        candidate_id: a.candidate.candidate_id,
        reason_code: 'candidate.condition_unknown_optional',
      });
      continue;
    }

    // truth === 'true' → 参与竞争
    const rank = baseRankOf(a.candidate.candidate_kind);
    const arr = participatingByRank.get(rank) ?? [];
    arr.push({ candidate: a.candidate, truth });
    participatingByRank.set(rank, arr);
  }

  // 找最小 rank 的有效层
  const sortedRanks = [...participatingByRank.keys()].sort((x, y) => x - y);
  if (sortedRanks.length === 0) {
    // 没有 base candidate 通过所有 gate
    throw new Error(
      'base.none: no valid approved base candidate with passing condition',
    );
  }

  const minRank = sortedRanks[0]!;
  const winnersAtMin = participatingByRank.get(minRank)!;
  if (winnersAtMin.length > 1) {
    // 同层多个有效 base → 配置错误,不猜 winner(spec §7.3 rule 4)
    const ids = winnersAtMin.map((w) => w.candidate.candidate_id).join(', ');
    throw new Error(
      `base.conflict_at_rank: multiple valid base candidates at rank ${minRank}: [${ids}]`,
    );
  }
  const baseWinner = winnersAtMin[0]!.candidate;

  // 把所有更高 rank 的"参与但未中"的 base 标 excluded
  for (let i = 1; i < sortedRanks.length; i++) {
    const rank = sortedRanks[i]!;
    for (const w of participatingByRank.get(rank)!) {
      excluded.push({
        candidate_id: w.candidate.candidate_id,
        reason_code: 'candidate.superseded_by_lower_rank_base',
      });
    }
  }

  // ---- 4) 处理 append candidate -----------------------------------------------
  const appendActive = active.filter((a) => a.candidate.operation === 'append');
  interface AppendStatus {
    candidate: PromptResolutionCandidate;
    truth: ConditionTruth;
  }
  const appendParticipants: AppendStatus[] = [];

  for (const a of appendActive) {
    const truth: ConditionTruth = a.conditionEval ? a.conditionEval.truth : 'true';

    if (truth === 'false') {
      // spec §7.4 rule 7:mandatory append 受信 condition=false 时为"不适用"。
      // 即 false 可省略(无论 mandatory/optional)。
      excluded.push({
        candidate_id: a.candidate.candidate_id,
        reason_code: 'candidate.condition_false',
      });
      continue;
    }

    if (truth === 'unknown') {
      if (a.candidate.criticality === 'mandatory') {
        // mandatory append condition=unknown → rejected(spec §7.4 rule 7)
        throw new Error(
          `append.condition_unknown: mandatory append candidate '${a.candidate.candidate_id}' ` +
            `has unknown condition '${a.candidate.condition_ref}'`,
        );
      }
      excluded.push({
        candidate_id: a.candidate.candidate_id,
        reason_code: 'candidate.condition_unknown_optional',
      });
      continue;
    }

    appendParticipants.push({ candidate: a.candidate, truth });
  }

  // (stable_order ASC, candidate_id ASC) 排序(spec §7.4 rule 2)
  appendParticipants.sort((x, y) => {
    if (x.candidate.stable_order !== y.candidate.stable_order) {
      return x.candidate.stable_order < y.candidate.stable_order ? -1 : 1;
    }
    return x.candidate.candidate_id.localeCompare(y.candidate.candidate_id);
  });

  // stable_order 重复检测(spec §7.4 rule 3)
  const seenOrders = new Set<number>();
  for (const ap of appendParticipants) {
    if (seenOrders.has(ap.candidate.stable_order)) {
      throw new Error(
        `append.duplicate_stable_order: stable_order=${ap.candidate.stable_order} ` +
          `(candidates=[${appendParticipants
            .filter((x) => x.candidate.stable_order === ap.candidate.stable_order)
            .map((x) => x.candidate.candidate_id)
            .join(', ')}])`,
      );
    }
    seenOrders.add(ap.candidate.stable_order);
  }

  const includedAppends = appendParticipants.map((ap) => ap.candidate);

  // ---- 5) 组装 ordered_section_refs + scope_decisions -------------------------
  const orderedSectionRefs: string[] = [baseWinner.section_input_ref];
  for (const ap of includedAppends) {
    orderedSectionRefs.push(ap.section_input_ref);
  }

  // scope decisions:对每个 included candidate 评估
  const scopeDecisions: PromptScopeDecision[] = [];
  for (const ref of [baseWinner, ...includedAppends]) {
    const scopeInput = input.section_scope_inputs[ref.candidate_id];
    if (scopeInput === undefined) {
      // 证据不足 → unknown(spec §7.6)
      scopeDecisions.push(
        freezeSnapshot({
          section_id: ref.candidate_id,
          scope: 'unknown' as PromptScopeClass,
          dependency_kinds: [],
          reason_code: 'scope.unknown.missing_scope_input',
        }),
      );
    } else {
      scopeDecisions.push(
        classifyPromptScope({
          section_id: ref.candidate_id,
          immutable_asset: scopeInput.immutable_asset,
          dependency_kinds: scopeInput.dependency_kinds,
          stable_order: scopeInput.stable_order,
        }),
      );
    }
  }

  // ---- 6) mandatory_candidate_ids(只包含 included 且 criticality=mandatory 的)
  const mandatoryCandidateIds: string[] = [];
  if (baseWinner.criticality === 'mandatory') {
    mandatoryCandidateIds.push(baseWinner.candidate_id);
  }
  for (const ap of includedAppends) {
    if (ap.criticality === 'mandatory') {
      mandatoryCandidateIds.push(ap.candidate_id);
    }
  }
  // 确定性顺序:与 ordered_section_refs 顺序一致(已是 stable sort 后的)
  mandatoryCandidateIds.sort((a, b) => {
    const candidatePool = [baseWinner, ...includedAppends];
    const ia = orderedSectionRefs.indexOf(
      candidatePool.find((c) => c.candidate_id === a)!.section_input_ref,
    );
    const ib = orderedSectionRefs.indexOf(
      candidatePool.find((c) => c.candidate_id === b)!.section_input_ref,
    );
    return ia - ib;
  });

  // ---- 7) 计算 resolution_id(确定性 hash) -----------------------------------
  const includedAppendIds = includedAppends.map((ap) => ap.candidate_id);

  // included_section_assets: section_input_ref → asset_ref(Task 3 漂移检测用)
  const includedSectionAssets: Record<
    string,
    { asset_id: string; asset_version: string }
  > = {};
  for (const c of [baseWinner, ...includedAppends]) {
    includedSectionAssets[c.section_input_ref] = {
      asset_id: c.asset_ref.asset_id,
      asset_version: c.asset_ref.asset_version,
    };
  }

  const plan: PromptResolutionPlan = {
    resolution_protocol_version,
    resolution_id: '', // 占位,下面计算
    policy_ref: input.policy_ref,
    input_snapshot_ids: [...input.input_snapshot_ids],
    selected_base_candidate_id: baseWinner.candidate_id,
    mandatory_candidate_ids: mandatoryCandidateIds,
    included_append_candidate_ids: includedAppendIds,
    excluded_candidates: excluded,
    condition_evaluations: conditionEvaluations,
    scope_decisions: scopeDecisions,
    ordered_section_refs: orderedSectionRefs,
    included_section_assets: includedSectionAssets,
  };

  const resolution_id = computeResolutionId(plan);
  const finalPlan: PromptResolutionPlan = { ...plan, resolution_id };

  return freezeSnapshot(finalPlan);
}

// ---------------------------------------------------------------------------
// 内部 helpers:base rank / resolution_id / identity 守门
// ---------------------------------------------------------------------------

/**
 * Base precedence 的固定 rank(spec §7.3)。
 * 数字越小优先级越高。append 不参与 base 竞争,这里不列。
 */
const BASE_RANK: Readonly<Record<string, number>> = {
  trusted_runtime_override: 0,
  coordinator_profile: 1,
  agent_role_profile: 2,
  approved_custom_profile: 3,
  default_base: 4,
};

function baseRankOf(kind: PromptCandidateKind): number {
  const r = BASE_RANK[kind];
  if (r === undefined) {
    // append_section 或未知 kind 不应出现在 base 竞争里。
    // 未知 kind 视为配置错误,抛错。
    throw new Error(
      `base.invalid_kind: candidate_kind '${kind}' is not a valid base kind ` +
        `(valid: trusted_runtime_override / coordinator_profile / agent_role_profile / approved_custom_profile / default_base)`,
    );
  }
  return r;
}

// requireNonEmpty 已迁移到 Wave A 的 requireIdentity(../contracts/identities.js)。
// 本文件所有 identity 守门统一复用 requireIdentity,避免重复实现。

/**
 * 计算 resolution_id(spec §6.4 INV-C1)。
 *
 * 输入:canonical JSON,按字段名稳定排序(深 sort),不依赖对象插入顺序。
 * 覆盖维度:
 *   - resolution_protocol_version / policy_ref / input_snapshot_ids
 *   - selected_base_candidate_id
 *   - mandatory_candidate_ids(已排序)
 *   - included_append_candidate_ids(已按 stable_order 排序)
 *   - excluded_candidates(按 candidate_id 排序,使顺序无关)
 *   - condition_evaluations(按 condition_ref 排序)
 *   - scope_decisions(按 section_id 排序)
 *
 * 注意:input.candidates 数组顺序不进入 hash —— 我们只 hash 已确定的 plan 内容。
 * 这样候选传入顺序无关(已由 mandatoryCandidateIds/excluded 的内部排序保证)。
 */
function computeResolutionId(plan: PromptResolutionPlan): string {
  const canonical = JSON.stringify({
    resolution_protocol_version: plan.resolution_protocol_version,
    policy_ref: {
      policy_id: plan.policy_ref.policy_id,
      policy_version: plan.policy_ref.policy_version,
    },
    input_snapshot_ids: [...plan.input_snapshot_ids].sort(),
    selected_base_candidate_id: plan.selected_base_candidate_id,
    mandatory_candidate_ids: [...plan.mandatory_candidate_ids].sort(),
    included_append_candidate_ids: [...plan.included_append_candidate_ids],
    included_section_assets: Object.fromEntries(
      Object.entries(plan.included_section_assets)
        .map(([ref, a]) => [
          ref,
          { asset_id: a.asset_id, asset_version: a.asset_version },
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
    excluded_candidates: [...plan.excluded_candidates]
      .map((e) => ({ candidate_id: e.candidate_id, reason_code: e.reason_code }))
      .sort((a, b) => a.candidate_id.localeCompare(b.candidate_id)),
    condition_evaluations: [...plan.condition_evaluations]
      .map((e) => ({
        condition_ref: e.condition_ref,
        truth: e.truth,
        evidence_refs: [...e.evidence_refs].sort(),
        reason_code: e.reason_code,
      }))
      .sort((a, b) => a.condition_ref.localeCompare(b.condition_ref)),
    scope_decisions: [...plan.scope_decisions]
      .map((d) => ({
        section_id: d.section_id,
        scope: d.scope,
        dependency_kinds: [...d.dependency_kinds].sort(),
        reason_code: d.reason_code,
      }))
      .sort((a, b) => a.section_id.localeCompare(b.section_id)),
    ordered_section_refs: plan.ordered_section_refs,
  });
  return createHashSha256(canonical);
}

function createHashSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// §17.1 CRC-1 → BRC-1 Compiler adapter(RED stub,GREEN 阶段实现)
// ---------------------------------------------------------------------------

export interface ResolvedPromptCompileDeps {
  resolveSection: (section_input_ref: string) => PromptSectionInput;
  approvalLookup: PromptAssetApprovalLookup;
  /** BRC-1 compilePromptSnapshot 需要的 identity 字段,由调用方提供。 */
  compiler_protocol_version: string;
  registry_snapshot_id: string;
  request_snapshot_id: string;
}

export function compileResolvedPrompt(
  plan: PromptResolutionPlan,
  deps: ResolvedPromptCompileDeps,
): CompiledPromptSnapshot {
  // 1) 解引用每个 section_input_ref → PromptSectionInput
  //    只编译 plan.ordered_section_refs 中的 section(spec §17.1 / Task 3 边界)。
  //    不包含 excluded 或未在 plan 中的 section。
  const sections: PromptSectionInput[] = [];
  for (const ref of plan.ordered_section_refs) {
    // resolveSection 抛错时让其透传(有意义错误直接向上传播,无需包装)
    const section: PromptSectionInput = deps.resolveSection(ref);

    // 2) asset identity drift 检测(spec §17.1 CRC-1 rule 2)
    //    plan 决策时的 asset_ref 与 section 解引用后的 asset_ref 必须一致。
    const expectedAsset = plan.included_section_assets[ref];
    if (expectedAsset === undefined) {
      throw new Error(
        `asset.identity.drift: section_input_ref '${ref}' is in plan.ordered_section_refs ` +
          `but has no asset binding in plan.included_section_assets`,
      );
    }
    if (
      section.asset_ref.asset_id !== expectedAsset.asset_id ||
      section.asset_ref.asset_version !== expectedAsset.asset_version
    ) {
      throw new Error(
        `asset.identity.drift: section_input_ref '${ref}' resolved to asset ` +
          `'${section.asset_ref.asset_id}:${section.asset_ref.asset_version}' but plan bound ` +
          `'${expectedAsset.asset_id}:${expectedAsset.asset_version}'`,
      );
    }

    sections.push(section);
  }

  // 3) 构造 PromptCompilationInput 并委托 BRC-1。
  //    protocol/registry/request identity 由调用方提供(它们是 BRC-1 的语义,不属于 resolution)。
  const compilationInput: PromptCompilationInput = {
    compiler_protocol_version: deps.compiler_protocol_version,
    registry_snapshot_id: deps.registry_snapshot_id,
    request_snapshot_id: deps.request_snapshot_id,
    sections,
  };

  // 4) 委托 BRC-1。它会做:深拷贝、空 content 检查、ordinal/section_id 唯一性、
  //    placement 校验、content_hash 校验、approvalLookup 校验、排序、aggregate_hash、
  //    freeze。所有 BRC-1 错误语义在此透传。
  return compilePromptSnapshot(compilationInput, deps.approvalLookup);
}
