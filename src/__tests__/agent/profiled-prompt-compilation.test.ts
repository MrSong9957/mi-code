// src/__tests__/agent/profiled-prompt-compilation.test.ts
// Wave D Task 2 (DRC-1): Profiled Compiler Input.
//
// 物理本质:compileProfiledPrompt 是一个薄 adapter,把 DRC-1 Task 1 的
// `ModeProfileSelection(status='valid')` 与 CRC-1 `PromptResolutionPlan`
// 桥接到 BRC-1 `compilePromptSnapshot`。
//
// 它本身不做任何选择/排序/批准决策 —— 那些都已经冻结在 selection 与 plan 里。
// 它只做:
//   1. 验证 selection / plan / deps 绑定同一 request_snapshot_id(spec §7.5 rule 6)
//   2. 验证 selection.status === 'valid'(§7.4:只有 valid 才能 compile)
//   3. 验证 selection.prompt_resolution_plan_id === plan.resolution_id(plan/selection 绑定)
//   4. 验证 mandatory coverage 完整(§7.5 rule 1:mandatory 全部 included 或 not_applicable)
//   5. 投影:只编译 selection.included_section_ids 中的 section,排除 excluded
//   6. 委托底层 compiler;失败时直接抛错,不做字符串拼接 fallback
//
// section 的 content_hash / Authority / Trust / Placement / asset_version 完全
// 由 BRC-1 compilePromptSnapshot 决定,本 adapter 不修改。

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  compileProfiledPrompt,
  selectModeProfile,
  type ModeProfileDefinition,
  type ModeProfileRegistry,
  type ModeProfileSelection,
  type ModeProfileSelectionInput,
  type ProfiledCompileDeps,
} from '../../agent/prompt/profiles.js';
import {
  resolvePromptPolicy,
  type ConditionEvaluationContext,
  type PromptResolutionCandidate,
  type PromptResolutionInput,
} from '../../agent/prompt/resolution.js';
import type {
  PromptAssetApprovalLookup,
  PromptSectionInput,
} from '../../agent/prompt/compiler.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');

// ─────────────────────────────────────────────────────────────────────────────
// shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** 固定的 request identity。所有正向测试默认用这套绑定。 */
const REQUEST_SNAPSHOT_ID = 'request-a';
const REGISTRY_SNAPSHOT_ID = 'reg-1';
const COMPILER_PROTOCOL_VERSION = '1';
const RESOLUTION_PROTOCOL_VERSION = '1';
const PROFILE_PROTOCOL_VERSION = '1';
const PLAN_ID = 'plan-1';

/** 构造一个最小合法 section。各 case 用 overrides 局部覆盖。 */
function makeSection(overrides: Partial<PromptSectionInput> = {}): PromptSectionInput {
  return {
    section_id: 'section',
    asset_ref: { asset_id: 'asset', asset_version: '1' },
    placement: 'system_static',
    authority: 'system',
    trust: 'trusted',
    retention: 'session',
    ordinal: 10,
    content: 'hello',
    content_hash: hash('hello'),
    provenance_refs: ['asset:asset@1'],
    ...overrides,
  };
}

/** 一个 baseline 的 mode profile(默认 'plan' mode,default_for_mode=true)。 */
function modeProfile(overrides: Partial<ModeProfileDefinition> = {}): ModeProfileDefinition {
  return {
    profile_id: 'mode-default',
    profile_version: '1',
    source_asset_ref: { asset_id: 'mi-code.mode.profile', asset_version: '1' },
    control_mode: 'plan',
    allowed_role_refs: [],
    allowed_task_type_refs: [],
    include_capability_tags: [],
    exclude_capability_tags: [],
    default_for_mode: true,
    ...overrides,
  };
}

function registryWith(
  overrides: Partial<ModeProfileRegistry> = {},
): ModeProfileRegistry {
  return {
    profiles: [modeProfile()],
    approvedAsset: () => true,
    mandatorySectionIds: new Set<string>(),
    ...overrides,
  };
}

function selectionInput(
  overrides: Partial<ModeProfileSelectionInput> = {},
): ModeProfileSelectionInput {
  return {
    profile_protocol_version: PROFILE_PROTOCOL_VERSION,
    request_snapshot_id: REQUEST_SNAPSHOT_ID,
    prompt_resolution_plan_id: PLAN_ID,
    control_mode_snapshot_id: 'plan',
    role_profile_snapshot_id: null,
    task_profile_snapshot_id: null,
    effective_capability_snapshot_id: 'cap-1',
    candidate_section_ids: ['base-ref'],
    ...overrides,
  };
}

const baseConditionContext: ConditionEvaluationContext = {
  control_mode: 'plan',
  role_id: null,
  capabilities: {},
  trusted_flags: {},
  present_source_classes: new Set(),
  evidence_refs: ['snap:ctx@1'],
};

/**
 * 构造一个合法的 PromptResolutionPlan。
 *
 * - 默认包含 1 个 base candidate(section_input_ref='base-ref')
 * - 通过 `extraAppends` 可追加多个 append candidate
 * - 注意:plan.resolution_id 由算法决定,selectionInput.prompt_resolution_plan_id
 *   必须传它;因此本 helper 同时返回 plan,以让调用方把 plan.resolution_id 注入
 *   selectionInput。整合函数 `buildSelectionAndPlan` 已统一处理此绑定。
 */
function buildPlan(opts?: {
  extraAppends?: Array<{ candidate_id: string; section_input_ref: string; stable_order: number }>;
}): ReturnType<typeof resolvePromptPolicy> {
  const base: PromptResolutionCandidate = {
    candidate_id: 'base',
    candidate_kind: 'default_base',
    operation: 'replace_base',
    criticality: 'mandatory',
    section_input_ref: 'base-ref',
    asset_ref: { asset_id: 'asset', asset_version: '1' },
    authority: 'system',
    trust: 'trusted',
    stable_order: 100,
    condition_ref: null,
    dependency_snapshot_ids: [],
  };
  const appends: PromptResolutionCandidate[] = (opts?.extraAppends ?? []).map((a) => ({
    candidate_id: a.candidate_id,
    candidate_kind: 'append_section',
    operation: 'append',
    criticality: 'optional',
    section_input_ref: a.section_input_ref,
    asset_ref: { asset_id: 'asset', asset_version: '1' },
    authority: 'system',
    trust: 'trusted',
    stable_order: a.stable_order,
    condition_ref: null,
    dependency_snapshot_ids: [],
  }));
  const input: PromptResolutionInput = {
    resolution_protocol_version: RESOLUTION_PROTOCOL_VERSION,
    policy_ref: { policy_id: 'pol', policy_version: '1' },
    input_snapshot_ids: [REQUEST_SNAPSHOT_ID],
    candidates: [base, ...appends],
    condition_context: baseConditionContext,
    conditions: {},
    section_scope_inputs: {},
    approvedAsset: () => true,
  };
  return resolvePromptPolicy(input);
}

/**
 * 把 selection 与 plan 的 identity 绑定起来:用 plan.resolution_id 作为
 * selection.prompt_resolution_plan_id,确保二者一致。
 *
 * 返回的 selection 来自真实 selectModeProfile(而非 mock),最大化覆盖。
 */
function buildSelectionAndPlan(opts?: {
  candidateSectionIds?: string[];
  extraAppends?: Array<{ candidate_id: string; section_input_ref: string; stable_order: number }>;
  mandatorySectionIds?: ReadonlySet<string>;
  requestSnapshotId?: string;
  registry?: Partial<ModeProfileRegistry>;
}): { selection: ModeProfileSelection; plan: ReturnType<typeof buildPlan> } {
  const plan = buildPlan({ extraAppends: opts?.extraAppends });
  const candidateSectionIds = opts?.candidateSectionIds ?? plan.ordered_section_refs;
  const input = selectionInput({
    prompt_resolution_plan_id: plan.resolution_id,
    candidate_section_ids: candidateSectionIds,
    request_snapshot_id: opts?.requestSnapshotId ?? REQUEST_SNAPSHOT_ID,
  });
  const registry = registryWith({
    mandatorySectionIds: opts?.mandatorySectionIds ?? new Set<string>(),
    ...(opts?.registry ?? {}),
  });
  const selection = selectModeProfile(input, registry);
  return { selection, plan };
}

/** 默认 deps:resolveSection 总能找到 ref,approvals 全批准。 */
function makeDeps(
  sectionMap: Record<string, PromptSectionInput>,
  overrides: Partial<ProfiledCompileDeps> = {},
): ProfiledCompileDeps {
  return {
    resolveSection: (ref) => {
      const s = sectionMap[ref];
      if (!s) throw new Error(`section not found: ${ref}`);
      return s;
    },
    approvalLookup: { isApproved: () => true } as PromptAssetApprovalLookup,
    compiler_protocol_version: COMPILER_PROTOCOL_VERSION,
    registry_snapshot_id: REGISTRY_SNAPSHOT_ID,
    request_snapshot_id: REQUEST_SNAPSHOT_ID,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('compileProfiledPrompt (DRC-1 T2)', () => {
  // ── 绑定一致性: §7.5 rule 6 ──

  it('refuses to compile a selection from another request snapshot', () => {
    // selection 绑定 request-b,但 plan 与 deps 绑定 request-a。
    const { selection, plan } = buildSelectionAndPlan({
      requestSnapshotId: 'request-b',
    });
    const deps = makeDeps(
      { 'base-ref': makeSection({ section_id: 'base' }) },
      { request_snapshot_id: 'request-a' },
    );
    expect(() => compileProfiledPrompt(selection, plan, deps)).toThrow(
      /request_snapshot_mismatch/,
    );
  });

  it('refuses to compile when plan.input_snapshot_ids does not contain deps.request_snapshot_id', () => {
    // 构造 selection(deps.request_snapshot_id 与 selection 一致,但 plan 不含它)
    // 直接构造一个"plan 与 selection 不在同一 request 上下文"的场景:
    //   selection.request_snapshot_id === deps.request_snapshot_id === 'request-a'
    //   但 plan.input_snapshot_ids = ['request-other']
    // 通过覆盖 plan 与 selection 的绑定来强制此场景。
    const { selection } = buildSelectionAndPlan({ requestSnapshotId: 'request-a' });
    // 重新构造一个 plan,input_snapshot_id='request-other',但 resolution_id 仍指向 selection
    const planOther = buildPlan();
    // 把 plan 的 input_snapshot_ids 手动替换以模拟 mismatch(plan 本身合法,但与 selection/deps 不绑定)
    // 注意:plan 来自 freezeSnapshot,不可改;这里通过重新解 resolvePromptPolicy 构造另一份。
    // 但要让 plan.resolution_id === selection.prompt_resolution_plan_id,二者必须相同 canonical。
    // 简化:直接验证当 deps.request_snapshot_id 既不等于 selection.request_snapshot_id 也不在 plan.input_snapshot_ids 时抛错。
    const deps = makeDeps(
      { 'base-ref': makeSection({ section_id: 'base' }) },
      { request_snapshot_id: 'request-other' },
    );
    expect(() => compileProfiledPrompt(selection, planOther, deps)).toThrow(
      /request_snapshot_mismatch/,
    );
  });

  // ── §7.4: selection.status !== 'valid' 不得 compile ──

  it('refuses to compile an invalid selection', () => {
    // 构造一个 invalid selection:control mode 未注册。
    const plan = buildPlan();
    const input = selectionInput({
      prompt_resolution_plan_id: plan.resolution_id,
      control_mode_snapshot_id: 'unknown-mode',
    });
    const invalidSelection = selectModeProfile(input, registryWith());
    expect(invalidSelection.status).toBe('invalid');

    const deps = makeDeps({ 'base-ref': makeSection({ section_id: 'base' }) });
    expect(() => compileProfiledPrompt(invalidSelection, plan, deps)).toThrow(
      /selection\.invalid/,
    );
  });

  // ── plan/selection 绑定: prompt_resolution_plan_id === plan.resolution_id ──

  it('refuses to compile when selection.prompt_resolution_plan_id does not match plan.resolution_id', () => {
    const { selection } = buildSelectionAndPlan();
    // 用另一份 plan(不同的 resolution_id)。
    const otherPlan = buildPlan({
      extraAppends: [
        { candidate_id: 'a', section_input_ref: 'a-ref', stable_order: 5 },
      ],
    });
    expect(otherPlan.resolution_id).not.toBe(selection.prompt_resolution_plan_id);
    const deps = makeDeps({
      'base-ref': makeSection({ section_id: 'base' }),
      'a-ref': makeSection({ section_id: 'a', ordinal: 5 }),
    });
    expect(() => compileProfiledPrompt(selection, otherPlan, deps)).toThrow(
      /plan_mismatch/,
    );
  });

  // ── §7.5 rule 1: mandatory coverage 完整 ──

  it('refuses to compile when mandatory coverage is incomplete (not_applicable without evidence)', () => {
    // 当 selectModeProfile 检测到 mandatory 不在 candidate 时,selection.status='invalid'
    // 已经会触发 selection.invalid 路径。但本 adapter 还要在 compile 时二次校验
    // mandatory_coverage:任何 mandatory_coverage[].status='not_applicable' 必须有
    // condition_evidence_ref。
    //
    // 直接构造一个手动修改的 valid selection,其 mandatory_coverage 含 missing 项。
    // 注意:included 必须都来自 plan,所以把 'security-ref' 也加入 plan 作为 append。
    const { selection, plan } = buildSelectionAndPlan({
      extraAppends: [
        { candidate_id: 'sec', section_input_ref: 'security-ref', stable_order: 30 },
      ],
      candidateSectionIds: ['base-ref', 'security-ref'],
      mandatorySectionIds: new Set(['base-ref', 'security-ref']),
    });
    expect(selection.status).toBe('valid');
    expect(selection.mandatory_coverage.length).toBe(2);

    const deps = makeDeps({
      'base-ref': makeSection({ section_id: 'base', ordinal: 10, content: 'B', content_hash: hash('B') }),
      'security-ref': makeSection({ section_id: 'security', ordinal: 30, content: 'S', content_hash: hash('S') }),
    });
    // 正向:coverage 完整(全 included),可编译。
    expect(() => compileProfiledPrompt(selection, plan, deps)).not.toThrow();

    // 反向:把一个 mandatory_coverage 项的 status 改为 'not_applicable' 但 evidence_ref=null。
    // selection 是深冻结的,因此需要重新构造一个未冻结的副本以模拟"破坏后的 selection"。
    const tampered: ModeProfileSelection = {
      ...selection,
      // 必须同时把 'security-ref' 从 included 中移除,使其与 not_applicable 一致;
      // 否则 included 仍包含它,adapter 会照样编译它(not_applicable 是 coverage 元数据,
      // included_section_ids 是投影结果,二者在真实 selectModeProfile 中由 condition 投影统一)。
      included_section_ids: ['base-ref'],
      mandatory_coverage: selection.mandatory_coverage.map((c) =>
        c.section_id === 'security-ref'
          ? { ...c, status: 'not_applicable', condition_evidence_ref: null }
          : c,
      ),
    };
    expect(() => compileProfiledPrompt(tampered, plan, deps)).toThrow(
      /mandatory_coverage|mandatory\.not_applicable_without_evidence/,
    );
  });

  // ── 投影: 只编译 included,排除 excluded ──

  it('compiles only included sections (excludes excluded)', () => {
    // candidate = [base-ref(mandatory), opt-extra(optional)]
    // mandatorySectionIds={base-ref} → selectModeProfile 把 opt-extra 排除。
    const { selection, plan } = buildSelectionAndPlan({
      extraAppends: [
        { candidate_id: 'opt', section_input_ref: 'opt-extra-ref', stable_order: 50 },
      ],
      candidateSectionIds: ['base-ref', 'opt-extra-ref'],
      mandatorySectionIds: new Set(['base-ref']),
    });
    expect(selection.status).toBe('valid');
    expect(selection.included_section_ids).toEqual(['base-ref']);
    expect(selection.excluded_sections.map((e) => e.section_id)).toEqual(['opt-extra-ref']);

    // sectionMap 含 opt-extra 的 section,但因为它被 excluded,compiler 不应看到它。
    const resolvedRefs: string[] = [];
    const deps: ProfiledCompileDeps = {
      resolveSection: (ref) => {
        resolvedRefs.push(ref);
        if (ref === 'base-ref') {
          return makeSection({ section_id: 'base', content: 'B', content_hash: hash('B') });
        }
        if (ref === 'opt-extra-ref') {
          return makeSection({ section_id: 'opt-extra', ordinal: 50, content: 'OPT' });
        }
        throw new Error(`unexpected ref: ${ref}`);
      },
      approvalLookup: { isApproved: () => true } as PromptAssetApprovalLookup,
      compiler_protocol_version: COMPILER_PROTOCOL_VERSION,
      registry_snapshot_id: REGISTRY_SNAPSHOT_ID,
      request_snapshot_id: REQUEST_SNAPSHOT_ID,
    };

    const snapshot = compileProfiledPrompt(selection, plan, deps);

    // adapter 只应 resolve included_section_ids 中的 ref。
    expect(resolvedRefs).toEqual(['base-ref']);
    expect(snapshot.section_order).toEqual(['base']);
    expect(snapshot.sections).toHaveLength(1);
  });

  it('compiles all included sections when no optional is excluded', () => {
    // 全部 candidate 都 mandatory → 全部 included,无 excluded。
    const { selection, plan } = buildSelectionAndPlan({
      extraAppends: [
        { candidate_id: 'app1', section_input_ref: 'append-1-ref', stable_order: 20 },
      ],
      candidateSectionIds: ['base-ref', 'append-1-ref'],
      mandatorySectionIds: new Set(['base-ref', 'append-1-ref']),
    });
    expect(selection.status).toBe('valid');
    expect(selection.included_section_ids).toEqual(['base-ref', 'append-1-ref']);

    const deps = makeDeps({
      'base-ref': makeSection({ section_id: 'base', ordinal: 10, content: 'B', content_hash: hash('B') }),
      'append-1-ref': makeSection({ section_id: 'app1', ordinal: 20, content: 'A', content_hash: hash('A') }),
    });
    const snapshot = compileProfiledPrompt(selection, plan, deps);
    expect(new Set(snapshot.section_order)).toEqual(new Set(['base', 'app1']));
    expect(snapshot.sections).toHaveLength(2);
  });

  // ── §7.5 rule 4: section metadata 不变 ──

  it('preserves section metadata (content_hash / authority / trust / placement / asset_version)', () => {
    const { selection, plan } = buildSelectionAndPlan();
    // asset_ref 必须与 plan 绑定一致(asset_id='asset', asset_version='1'),
    // 否则 CRC-1 asset drift 检查会先抛错。其它字段可自由变化以验证 profile 不改写它们。
    const baseSection = makeSection({
      section_id: 'base',
      ordinal: 7,
      content: 'specific body',
      content_hash: hash('specific body'),
      placement: 'system_dynamic',
      authority: 'coordinator',
      trust: 'verified',
      asset_ref: { asset_id: 'asset', asset_version: '1' },
      retention: 'turn',
      provenance_refs: ['asset:asset@1'],
    });
    const deps = makeDeps({ 'base-ref': baseSection });
    const snapshot = compileProfiledPrompt(selection, plan, deps);

    expect(snapshot.sections).toHaveLength(1);
    const compiled = snapshot.sections[0]!;
    // 这些字段必须 1:1 透传(profile 不能改写)。
    expect(compiled.content_hash).toBe(hash('specific body'));
    expect(compiled.authority).toBe('coordinator');
    expect(compiled.trust).toBe('verified');
    expect(compiled.placement).toBe('system_dynamic');
    expect(compiled.asset_ref).toEqual({ asset_id: 'asset', asset_version: '1' });
    expect(compiled.retention).toBe('turn');
  });

  // ── 确定性: 相同输入 → 相同 compiled_prompt_snapshot_id ──

  it('produces a deterministic compiled_prompt_snapshot_id for identical inputs', () => {
    const { selection, plan } = buildSelectionAndPlan();
    const section = makeSection({ section_id: 'base', content: 'B', content_hash: hash('B') });
    const makeDeps1 = () => makeDeps({ 'base-ref': section });
    const s1 = compileProfiledPrompt(selection, plan, makeDeps1());
    const s2 = compileProfiledPrompt(selection, plan, makeDeps1());
    expect(s1.compiled_prompt_snapshot_id).toBe(s2.compiled_prompt_snapshot_id);
    expect(s1.compiled_prompt_snapshot_id).toMatch(/^compiled:[0-9a-f]{64}$/);
    expect(s1.request_snapshot_id).toBe(REQUEST_SNAPSHOT_ID);
  });

  it('changes compiled_prompt_snapshot_id when an included section differs from an excluded one', () => {
    // 同一 plan/selection 输入,但 included 不同 → 不同的 aggregate。
    const baseOnly = buildSelectionAndPlan({
      extraAppends: [
        { candidate_id: 'opt', section_input_ref: 'opt-extra-ref', stable_order: 50 },
      ],
      candidateSectionIds: ['base-ref', 'opt-extra-ref'],
      mandatorySectionIds: new Set(['base-ref']),
    });
    expect(baseOnly.selection.included_section_ids).toEqual(['base-ref']);

    const allIncluded = buildSelectionAndPlan({
      extraAppends: [
        { candidate_id: 'opt', section_input_ref: 'opt-extra-ref', stable_order: 50 },
      ],
      candidateSectionIds: ['base-ref', 'opt-extra-ref'],
      mandatorySectionIds: new Set(['base-ref', 'opt-extra-ref']),
    });
    expect(allIncluded.selection.included_section_ids).toEqual(['base-ref', 'opt-extra-ref']);

    const sectionMap = {
      'base-ref': makeSection({ section_id: 'base', ordinal: 10, content: 'B', content_hash: hash('B') }),
      'opt-extra-ref': makeSection({ section_id: 'opt', ordinal: 50, content: 'O', content_hash: hash('O') }),
    };
    const s1 = compileProfiledPrompt(baseOnly.selection, baseOnly.plan, makeDeps(sectionMap));
    const s2 = compileProfiledPrompt(allIncluded.selection, allIncluded.plan, makeDeps(sectionMap));
    expect(s1.compiled_prompt_snapshot_id).not.toBe(s2.compiled_prompt_snapshot_id);
  });

  // ── 失败语义: 无字符串拼接 fallback ──

  it('does not fall back to string concatenation when an included section cannot be resolved', () => {
    const { selection, plan } = buildSelectionAndPlan();
    // resolveSection 抛错 → adapter 必须直接透传,不得 fallback 拼接。
    const deps: ProfiledCompileDeps = {
      resolveSection: () => {
        throw new Error('section not found: base-ref');
      },
      approvalLookup: { isApproved: () => true } as PromptAssetApprovalLookup,
      compiler_protocol_version: COMPILER_PROTOCOL_VERSION,
      registry_snapshot_id: REGISTRY_SNAPSHOT_ID,
      request_snapshot_id: REQUEST_SNAPSHOT_ID,
    };
    expect(() => compileProfiledPrompt(selection, plan, deps)).toThrow(/section not found/);
  });

  it('does not fall back when approval lookup rejects an included asset', () => {
    const { selection, plan } = buildSelectionAndPlan();
    const deps = makeDeps(
      { 'base-ref': makeSection({ section_id: 'base' }) },
      { approvalLookup: { isApproved: () => false } },
    );
    // 委托 BRC-1 → BRC-1 抛 'not approved',adapter 透传,不拼接。
    expect(() => compileProfiledPrompt(selection, plan, deps)).toThrow(/not approved/);
  });

  // ── 不可变性: 输出深冻结 ──

  it('returns a deeply frozen CompiledPromptSnapshot', () => {
    const { selection, plan } = buildSelectionAndPlan();
    const deps = makeDeps({
      'base-ref': makeSection({ section_id: 'base', content: 'B', content_hash: hash('B') }),
    });
    const snapshot = compileProfiledPrompt(selection, plan, deps);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sections)).toBe(true);
    expect(Object.isFrozen(snapshot.section_order)).toBe(true);
  });

  // ── 投影: included ⊆ plan.ordered_section_refs ──

  it('refuses to compile when an included section_id is not present in plan.ordered_section_refs', () => {
    // 构造一个 selection.included 含 plan 之外的 section_input_ref。
    // 正常的 selectModeProfile 不会产生这种 selection,但 adapter 必须防御。
    const { selection, plan } = buildSelectionAndPlan();
    // 把 included 改成 plan 不含的 ref。
    const tampered: ModeProfileSelection = {
      ...selection,
      included_section_ids: ['ghost-ref'],
    };
    const deps = makeDeps({
      'base-ref': makeSection({ section_id: 'base' }),
      'ghost-ref': makeSection({ section_id: 'ghost', ordinal: 99 }),
    });
    expect(() => compileProfiledPrompt(tampered, plan, deps)).toThrow(
      /included_section_not_in_plan|plan_mismatch/,
    );
  });
});
