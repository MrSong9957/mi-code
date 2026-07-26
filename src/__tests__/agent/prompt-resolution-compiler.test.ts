// src/__tests__/agent/prompt-resolution-compiler.test.ts
// Wave C Task 3 — CRC-1 → BRC-1 Compiler Cutover.
//
// 物理本质:compileResolvedPrompt 是一个薄 adapter,把 PromptResolutionPlan
// (Task 2 产物)桥接到 BRC-1 compilePromptSnapshot。
//
// 它本身不做任何选择/排序/批准决策 —— 那些都已经冻结在 plan 里。它只做:
//   1. 解引用 plan.ordered_section_refs → PromptSectionInput[]
//   2. 校验 asset identity 不漂移
//   3. 构造 PromptCompilationInput 并调用 compilePromptSnapshot
//
// 这里只覆盖 adapter 行为;compilePromptSnapshot 自身的校验在 prompt-compiler.test.ts
// 已有覆盖,这里不重复。

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  compileResolvedPrompt,
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  overrides: Partial<PromptResolutionCandidate> & { candidate_id: string },
): PromptResolutionCandidate {
  return {
    candidate_kind: 'default_base',
    operation: 'replace_base',
    criticality: 'mandatory',
    section_input_ref: overrides.candidate_id + ':section',
    asset_ref: { asset_id: 'asset', asset_version: '1' },
    authority: 'system',
    trust: 'trusted',
    stable_order: 100,
    condition_ref: null,
    dependency_snapshot_ids: [],
    ...overrides,
  };
}

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

const baseContext: ConditionEvaluationContext = {
  control_mode: 'default',
  role_id: 'researcher',
  capabilities: {},
  trusted_flags: {},
  present_source_classes: new Set(),
  evidence_refs: ['snap:ctx@1'],
};

function buildSimplePlan(opts?: {
  candidates?: PromptResolutionCandidate[];
  conditions?: Record<string, unknown>;
}) {
  const candidates =
    opts?.candidates ?? [makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' })];
  const input: PromptResolutionInput = {
    resolution_protocol_version: '1',
    policy_ref: { policy_id: 'pol', policy_version: '1' },
    input_snapshot_ids: ['snap:in@1'],
    candidates,
    condition_context: baseContext,
    conditions: (opts?.conditions ?? {}) as Record<string, never>,
    section_scope_inputs: {},
    approvedAsset: () => true,
  };
  return resolvePromptPolicy(input);
}

// ---------------------------------------------------------------------------
// 正向:只编译 plan 列的 section
// ---------------------------------------------------------------------------

describe('compileResolvedPrompt — 正向桥接', () => {
  it('只编译 plan.ordered_section_refs 中的 section(不包含 excluded/unplanned)', () => {
    // 构造一个 plan:base=default + 一个被 condition=false 排除的 optional append
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({ candidate_id: 'default', candidate_kind: 'default_base' }),
      makeCandidate({
        candidate_id: 'excluded-append',
        operation: 'append',
        candidate_kind: 'append_section',
        criticality: 'optional',
        condition_ref: 'cond:never',
        section_input_ref: 'excluded-section',
      }),
    ];
    const plan = buildSimplePlan({
      candidates,
      conditions: { 'cond:never': { kind: 'control_mode_is', expected: 'never' } },
    });
    expect(plan.ordered_section_refs).toEqual(['default:section']);
    expect(plan.excluded_candidates.length).toBe(1);

    // resolveSection map 只包含 base section + excluded section + 一个 unplanned section
    const sections: Record<string, PromptSectionInput> = {
      'default:section': makeSection({
        section_id: 'default-section',
        content: 'base body',
        content_hash: hash('base body'),
        asset_ref: { asset_id: 'asset', asset_version: '1' },
      }),
      'excluded-section': makeSection({
        section_id: 'excluded-section',
        content: 'should NOT appear',
        content_hash: hash('should NOT appear'),
      }),
      'unplanned-section': makeSection({
        section_id: 'unplanned',
        content: 'also NOT in plan',
        content_hash: hash('also NOT in plan'),
      }),
    };
    const approval: PromptAssetApprovalLookup = { isApproved: () => true };

    const snapshot = compileResolvedPrompt(plan, {
      resolveSection: (ref) => sections[ref]!,
      approvalLookup: approval,
      compiler_protocol_version: '1',
      registry_snapshot_id: 'reg-1',
      request_snapshot_id: 'req-1',
    });

    expect(snapshot.section_order).toEqual(['default-section']);
    expect(snapshot.sections).toHaveLength(1);
    expect(snapshot.sections[0]?.section_id).toBe('default-section');
  });

  it('base + 多个 append 都被编译,顺序与 plan.ordered_section_refs 一致', () => {
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({
        candidate_id: 'default',
        candidate_kind: 'default_base',
        section_input_ref: 'base-ref',
      }),
      makeCandidate({
        candidate_id: 'a',
        operation: 'append',
        candidate_kind: 'append_section',
        stable_order: 10,
        section_input_ref: 'a-ref',
      }),
      makeCandidate({
        candidate_id: 'b',
        operation: 'append',
        candidate_kind: 'append_section',
        stable_order: 20,
        section_input_ref: 'b-ref',
      }),
    ];
    const plan = buildSimplePlan({ candidates });
    expect(plan.ordered_section_refs).toEqual(['base-ref', 'a-ref', 'b-ref']);

    const sections: Record<string, PromptSectionInput> = {
      'base-ref': makeSection({
        section_id: 'base',
        ordinal: 1,
        content: 'B',
        content_hash: hash('B'),
      }),
      'a-ref': makeSection({
        section_id: 'a',
        ordinal: 2,
        content: 'A',
        content_hash: hash('A'),
      }),
      'b-ref': makeSection({
        section_id: 'b',
        ordinal: 3,
        content: 'C',
        content_hash: hash('C'),
      }),
    };
    const snapshot = compileResolvedPrompt(plan, {
      resolveSection: (ref) => sections[ref]!,
      approvalLookup: { isApproved: () => true },
      compiler_protocol_version: '1',
      registry_snapshot_id: 'reg-1',
      request_snapshot_id: 'req-1',
    });
    // section_order 是按 ordinal 排序的(BRC-1 已有的规则)
    expect(snapshot.section_order).toEqual(['base', 'a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// 错误:section 缺失 / asset 漂移
// ---------------------------------------------------------------------------

describe('compileResolvedPrompt — 错误桥接', () => {
  it('plan 引用的 section 无法被 resolveSection 解引用 → 抛错', () => {
    const plan = buildSimplePlan();
    expect(() =>
      compileResolvedPrompt(plan, {
        resolveSection: () => {
          throw new Error('section not found: default:section');
        },
        approvalLookup: { isApproved: () => true },
        compiler_protocol_version: '1',
        registry_snapshot_id: 'reg-1',
        request_snapshot_id: 'req-1',
      }),
    ).toThrow(/section not found/);
  });

  it('section asset_ref 与 plan 中 candidate asset_ref 不一致 → 抛错 (asset identity 漂移)', () => {
    // plan 里 candidate 的 asset_ref 是 { asset:1 }
    const candidates: PromptResolutionCandidate[] = [
      makeCandidate({
        candidate_id: 'default',
        candidate_kind: 'default_base',
        section_input_ref: 'base-ref',
        asset_ref: { asset_id: 'asset', asset_version: '1' },
      }),
    ];
    const plan = buildSimplePlan({ candidates });

    // 但 resolveSection 返回的 section 声明自己是 { asset:2 } —— 漂移!
    const driftedSection = makeSection({
      section_id: 'base',
      content: 'drifted',
      content_hash: hash('drifted'),
      asset_ref: { asset_id: 'asset', asset_version: '2' },
    });

    expect(() =>
      compileResolvedPrompt(plan, {
        resolveSection: () => driftedSection,
        approvalLookup: { isApproved: () => true },
        compiler_protocol_version: '1',
        registry_snapshot_id: 'reg-1',
        request_snapshot_id: 'req-1',
      }),
    ).toThrow(/asset.identity.drift/);
  });

  it('approvalLookup 拒绝 plan 中 candidate 的 asset → 抛错(委托给 BRC-1)', () => {
    const plan = buildSimplePlan();
    const section = makeSection({ section_id: 'base', content: 'B', content_hash: hash('B') });
    expect(() =>
      compileResolvedPrompt(plan, {
        resolveSection: () => section,
        approvalLookup: { isApproved: () => false },
        compiler_protocol_version: '1',
        registry_snapshot_id: 'reg-1',
        request_snapshot_id: 'req-1',
      }),
    ).toThrow(/not approved/);
  });

  it('BRC-1 校验失败(空 content)→ 委托抛错', () => {
    const plan = buildSimplePlan();
    const emptySection = makeSection({
      section_id: 'base',
      content: '',
      content_hash: hash(''),
    });
    expect(() =>
      compileResolvedPrompt(plan, {
        resolveSection: () => emptySection,
        approvalLookup: { isApproved: () => true },
        compiler_protocol_version: '1',
        registry_snapshot_id: 'reg-1',
        request_snapshot_id: 'req-1',
      }),
    ).toThrow(/empty section content/);
  });
});

// ---------------------------------------------------------------------------
// 不可变性 + 产物形状
// ---------------------------------------------------------------------------

describe('compileResolvedPrompt — 产物形状', () => {
  it('返回 BRC-1 CompiledPromptSnapshot(深冻结、含 aggregate_hash)', () => {
    const plan = buildSimplePlan();
    const section = makeSection({ section_id: 'base', content: 'B', content_hash: hash('B') });
    const snapshot = compileResolvedPrompt(plan, {
      resolveSection: () => section,
      approvalLookup: { isApproved: () => true },
      compiler_protocol_version: '1',
      registry_snapshot_id: 'reg-1',
      request_snapshot_id: 'req-1',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.compiled_prompt_snapshot_id).toMatch(/^compiled:[0-9a-f]{64}$/);
    expect(snapshot.aggregate_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.compiler_protocol_version).toBe('1');
    expect(snapshot.registry_snapshot_id).toBe('reg-1');
    expect(snapshot.request_snapshot_id).toBe('req-1');
  });

  it('同一 plan + 同一 resolveSection → 相同 compiled_prompt_snapshot_id(确定性)', () => {
    const plan = buildSimplePlan();
    const makeDeps = () => ({
      resolveSection: () =>
        makeSection({ section_id: 'base', content: 'B', content_hash: hash('B') }),
      approvalLookup: { isApproved: () => true } as PromptAssetApprovalLookup,
      compiler_protocol_version: '1',
      registry_snapshot_id: 'reg-1',
      request_snapshot_id: 'req-1',
    });
    const s1 = compileResolvedPrompt(plan, makeDeps());
    const s2 = compileResolvedPrompt(plan, makeDeps());
    expect(s1.compiled_prompt_snapshot_id).toBe(s2.compiled_prompt_snapshot_id);
  });
});
