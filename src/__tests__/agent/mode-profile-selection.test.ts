// src/__tests__/agent/mode-profile-selection.test.ts
// Wave D Task 1 (M-048): Mode Profile Selection (DRC-1).
//
// 物理本质:验证 selectModeProfile 把结构化 control mode(以
// control_mode_snapshot_id 为唯一真相源)+ role/task identity + effective
// capability snapshot + CRC-1 resolution plan(candidate_section_ids)投影为
// BRC-1 可编译的 section 集(included/excluded + mandatory coverage)。
//
// 关键不变量(spec §7.5 / §7.6):
//  - INV-D3: mode 只来自 control_mode_snapshot_id;空字符串即抛错,不从
//    用户文本、Prompt 内容或模型自报推断 mode。
//  - INV-D2 / rule 1: mandatory section 必须出现在 included_section_ids,
//    或有 condition evidence 的 not_applicable(本任务简化:mandatory 一律
//    视为 included,不实现 condition 投影)。
//  - rule 2 / rule 10: 只有 optional section 才能被排除,且必须带结构化
//    reason_code。
//  - rule 4: profile 不改 section content/hash/asset version/Authority/Trust/Placement。
//  - §7.6: control mode 未注册 → invalid(不猜 default);同 mode 多 default → invalid;
//    role/task override 多重匹配 → invalid;mandatory 缺失 → invalid;
//    profile asset 非 approved → invalid。
//  - selection_id = sel:<sha256(canonical).slice(0,16)>,同输入必同输出(确定性)。

import { describe, expect, it } from 'vitest';
import {
  selectModeProfile,
  type ModeProfileDefinition,
  type ModeProfileRegistry,
  type ModeProfileSelectionInput,
} from '../../agent/prompt/profiles.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function profile(overrides: Partial<ModeProfileDefinition> = {}): ModeProfileDefinition {
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

/**
 * 构造一个 registry。默认所有 asset 都 approved;mandatorySectionIds 默认空。
 * 测试只需声明自己关心的字段,其余用 sensible defaults。
 */
function registryWith(
  overrides: Partial<ModeProfileRegistry> = {},
): ModeProfileRegistry {
  return {
    profiles: [profile()],
    approvedAsset: () => true,
    mandatorySectionIds: new Set<string>(),
    ...overrides,
  };
}

/** 一份 baseline 的 selection input,单测只覆盖自己关心的字段。 */
function selectionInput(
  overrides: Partial<ModeProfileSelectionInput> = {},
): ModeProfileSelectionInput {
  return {
    profile_protocol_version: '1',
    request_snapshot_id: 'req-1',
    prompt_resolution_plan_id: 'plan-1',
    control_mode_snapshot_id: 'plan', // 直接以 mode 字符串作为 snapshot 引用
    role_profile_snapshot_id: null,
    task_profile_snapshot_id: null,
    effective_capability_snapshot_id: 'cap-1',
    candidate_section_ids: ['base'],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('selectModeProfile (DRC-1 / M-048)', () => {
  // ── INV-D3: mode 只来自 control_mode_snapshot_id ──
  it('does not infer mode from user or prompt text — empty control_mode_snapshot_id throws', () => {
    expect(() =>
      selectModeProfile(
        selectionInput({ control_mode_snapshot_id: '' }),
        registryWith(),
      ),
    ).toThrow(/control_mode_snapshot_id/);
  });

  it('selects the default profile when no role/task override is provided', () => {
    const selection = selectModeProfile(selectionInput(), registryWith());
    expect(selection.status).toBe('valid');
    expect(selection.selected_profile_ref).toEqual({
      profile_id: 'mode-default',
      profile_version: '1',
    });
    // 无 mandatory、无 optional 排除 → 全部 candidate 进 included。
    expect(selection.included_section_ids).toEqual(['base']);
    expect(selection.excluded_sections).toEqual([]);
    expect(selection.diagnostics).toEqual([]);
  });

  // ── §7.6: 同一 mode 多个 default profile → invalid ──
  it('rejects multiple default profiles for the same mode', () => {
    const selection = selectModeProfile(
      selectionInput(),
      registryWith({
        profiles: [
          profile({ profile_id: 'd1' }),
          profile({ profile_id: 'd2' }),
        ],
      }),
    );
    expect(selection.status).toBe('invalid');
    expect(selection.diagnostics).toContain('profile.multiple_defaults');
    // invalid 时不应选定 profile。
    expect(selection.selected_profile_ref).toEqual({
      profile_id: '',
      profile_version: '',
    });
  });

  // ── §7.6: control mode 未注册 → invalid,不猜 default ──
  it('rejects an unregistered control mode without guessing a default', () => {
    const selection = selectModeProfile(
      selectionInput({ control_mode_snapshot_id: 'unknown-mode' }),
      registryWith({ profiles: [profile({ control_mode: 'plan' })] }),
    );
    expect(selection.status).toBe('invalid');
    expect(selection.diagnostics).toContain('profile.mode_not_registered');
  });

  // ── override 精确匹配 ──
  it('selects a role override profile when role_profile_snapshot_id matches exactly', () => {
    const roleOverride = profile({
      profile_id: 'mode-role-explore',
      default_for_mode: false,
      allowed_role_refs: ['explore'],
    });
    const defaultProf = profile({ profile_id: 'mode-default' });
    const selection = selectModeProfile(
      selectionInput({ role_profile_snapshot_id: 'explore' }),
      registryWith({ profiles: [defaultProf, roleOverride] }),
    );
    expect(selection.status).toBe('valid');
    expect(selection.selected_profile_ref.profile_id).toBe('mode-role-explore');
  });

  it('rejects a role override that does not match the role_profile_snapshot_id exactly (no substring)', () => {
    // role_snapshot='explore',但 profile 只声明 'explorer' → 不算匹配,
    // 回退到 default,不抛错(只是没用 override)。这条测试锁定"精确匹配、不 substring"。
    const fuzzy = profile({
      profile_id: 'mode-fuzzy',
      default_for_mode: false,
      allowed_role_refs: ['explorer'], // 与 'explore' 不严格相等
    });
    const selection = selectModeProfile(
      selectionInput({ role_profile_snapshot_id: 'explore' }),
      registryWith({ profiles: [profile(), fuzzy] }),
    );
    expect(selection.status).toBe('valid');
    // 没有精确匹配 → 回退 default,而不是误选 fuzzy。
    expect(selection.selected_profile_ref.profile_id).toBe('mode-default');
  });

  it('rejects when multiple role overrides match the same role_profile_snapshot_id', () => {
    const a = profile({
      profile_id: 'r1',
      default_for_mode: false,
      allowed_role_refs: ['explore'],
    });
    const b = profile({
      profile_id: 'r2',
      default_for_mode: false,
      allowed_role_refs: ['explore'],
    });
    const selection = selectModeProfile(
      selectionInput({ role_profile_snapshot_id: 'explore' }),
      registryWith({ profiles: [profile(), a, b] }),
    );
    expect(selection.status).toBe('invalid');
    expect(selection.diagnostics).toContain('profile.role_override_multiple');
  });

  // ── INV-D2 / rule 1: mandatory coverage ──
  it('rejects a profile that omits a mandatory section from candidates', () => {
    const selection = selectModeProfile(
      selectionInput({ candidate_section_ids: ['base'] }), // 缺 'security'
      registryWith({ mandatorySectionIds: new Set(['base', 'security']) }),
    );
    expect(selection.status).toBe('invalid');
    expect(selection.diagnostics).toContain('profile.mandatory_missing.security');
  });

  it('marks all mandatory sections as included when they appear in candidates', () => {
    const selection = selectModeProfile(
      selectionInput({ candidate_section_ids: ['base', 'security'] }),
      registryWith({ mandatorySectionIds: new Set(['base', 'security']) }),
    );
    expect(selection.status).toBe('valid');
    const coverage = selection.mandatory_coverage.map((c) => c.section_id).sort();
    expect(coverage).toEqual(['base', 'security']);
    for (const c of selection.mandatory_coverage) {
      expect(c.status).toBe('included');
      expect(c.condition_evidence_ref).toBeNull();
    }
  });

  // ── rule 2 / rule 10: optional section 排除带 reason code ──
  it('excludes an optional section that is not mandatory with a structured reason code', () => {
    // candidates 含 'base' + 'optional-extra';只 'base' 是 mandatory。
    // 'optional-extra' 既非 mandatory 又未在 profile.include_capability_tags 里
    // 触发任何 include 条件 → 视为 optional_excluded。
    const selection = selectModeProfile(
      selectionInput({ candidate_section_ids: ['base', 'optional-extra'] }),
      registryWith({ mandatorySectionIds: new Set(['base']) }),
    );
    expect(selection.status).toBe('valid');
    expect(selection.included_section_ids).toEqual(['base']);
    expect(selection.excluded_sections).toEqual([
      { section_id: 'optional-extra', reason_code: 'profile.optional_excluded' },
    ]);
  });

  // ── §7.6: profile asset 非 approved → invalid ──
  it('rejects a profile whose source asset is not approved', () => {
    const selection = selectModeProfile(
      selectionInput(),
      registryWith({ approvedAsset: () => false }),
    );
    expect(selection.status).toBe('invalid');
    expect(selection.diagnostics).toContain('profile.asset_not_approved');
  });

  // ── rule 4: profile 不改 section metadata ──
  it('does not rewrite candidate section ids beyond include/exclude partitioning', () => {
    const selection = selectModeProfile(
      selectionInput({ candidate_section_ids: ['base', 'opt-a', 'opt-b'] }),
      registryWith({ mandatorySectionIds: new Set(['base']) }),
    );
    expect(selection.status).toBe('valid');
    // included 与 excluded 的并集(去重)必须等于 candidate 集合本身,无新增无篡改。
    const included = new Set(selection.included_section_ids);
    const excluded = new Set(selection.excluded_sections.map((e) => e.section_id));
    const union = new Set([...included, ...excluded]);
    expect(union).toEqual(new Set(['base', 'opt-a', 'opt-b']));
  });

  // ── 确定性 selection_id ──
  it('produces a deterministic selection_id for identical inputs', () => {
    const a = selectModeProfile(selectionInput(), registryWith());
    const b = selectModeProfile(selectionInput(), registryWith());
    expect(a.selection_id).toBe(b.selection_id);
    expect(a.selection_id).toMatch(/^sel:[0-9a-f]{16}$/);
  });

  it('produces a different selection_id when included sections change', () => {
    const baseInput = selectionInput({
      candidate_section_ids: ['base', 'opt'],
    });
    const a = selectModeProfile(baseInput, registryWith());
    const b = selectModeProfile(
      { ...baseInput, candidate_section_ids: ['base'] },
      registryWith(),
    );
    expect(a.selection_id).not.toBe(b.selection_id);
  });

  // ── 输出不可变 ──
  it('returns a deeply frozen selection', () => {
    const selection = selectModeProfile(selectionInput(), registryWith());
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.included_section_ids)).toBe(true);
    expect(Object.isFrozen(selection.excluded_sections)).toBe(true);
    expect(Object.isFrozen(selection.mandatory_coverage)).toBe(true);
    expect(Object.isFrozen(selection.diagnostics)).toBe(true);
  });

  // ── task override 路径 ──
  it('selects a task override profile when task_profile_snapshot_id matches', () => {
    const taskOverride = profile({
      profile_id: 'mode-task-migrate',
      default_for_mode: false,
      allowed_task_type_refs: ['migrate'],
    });
    const selection = selectModeProfile(
      selectionInput({ task_profile_snapshot_id: 'migrate' }),
      registryWith({ profiles: [profile(), taskOverride] }),
    );
    expect(selection.status).toBe('valid');
    expect(selection.selected_profile_ref.profile_id).toBe('mode-task-migrate');
  });
});
