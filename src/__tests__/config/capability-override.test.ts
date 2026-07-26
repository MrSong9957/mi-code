// src/__tests__/config/capability-override.test.ts
// M-059 (Wave C Task 4) Trusted Capability Override (CRC-2).
//
// 物理本质:把"受信配置对 adapter 默认能力快照的修正"做成可审计的 effective 快照。
// 关键不变量(spec §8.3 / §8.4 / §8.5):
//   - 四重 gate(trusted_source && schema_valid && deterministic_loader && exact_scope_match)
//     全部 true 才生效;任一 false → applied_override_ref=null, capabilities=base.capabilities。
//   - capability key 必须在 registered set 内,否则拒绝整条 override(不部分应用)。
//   - scope 必须 provider/endpoint/model/base_snapshot_id 四项精确匹配。
//   - 无效 override 不修改 base snapshot(INV)。
//   - effective snapshot 不可变(深冻结)。
//   - effective_capability_snapshot_id 确定性:同一组输入永远产出同一 id。
//   - supported 不等于 permission allow(INV-C5):本测试不验证 permission,只验证 capability 表达。

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  applyCapabilityOverride,
  type CapabilityOverrideRecord,
  type CapabilityOverrideTrustEvidence,
  type EffectiveCapabilitySnapshot,
} from '../../config/capability-override.js';
import type { ModelCapabilitySnapshot } from '../../agent/tools/capability-snapshot.js';
import { ConfigStore } from '../../config/store.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** 已注册的 capability key 集合(与 adapter getDefaultCapabilities 实际声明对齐)。 */
const REGISTERED_KEYS = new Set<string>([
  'native_tools',
  'tool_result_identity',
  'system_instruction',
  'provider_annotations',
]);

/** 一份合法的 base snapshot。来自 openai-compatible adapter 的典型默认声明。 */
const BASE_SNAPSHOT: ModelCapabilitySnapshot = Object.freeze({
  capability_protocol_version: '1',
  capability_snapshot_id: 'cap-base-openai-1',
  provider_id: 'openai-compatible',
  model_id: 'gpt-4o',
  adapter_version: '1',
  source: 'provider_adapter_default',
  capabilities: Object.freeze({
    native_tools: 'supported',
    tool_result_identity: 'supported',
    system_instruction: 'supported',
    provider_annotations: 'unknown',
  }),
  diagnostics: Object.freeze([]),
});

/** 一份与 BASE_SNAPSHOT scope 精确匹配、key 全部已注册的合法 override。 */
const VALID_OVERRIDE: CapabilityOverrideRecord = Object.freeze({
  override_id: 'ovr-001',
  override_version: '1',
  source_config_ref: 'config:trusted/capability-overrides.yaml',
  source_trust_proof_ref: 'trust-proof:frozen-policy-v1',
  provider_id: 'openai-compatible',
  endpoint_scope: 'https://api.openai.com/v1',
  model_scope: 'gpt-4o',
  base_capability_snapshot_id: 'cap-base-openai-1',
  changes: Object.freeze({
    provider_annotations: 'supported',
  }),
  justification: 'third-party endpoint verified to surface provider_annotations',
});

/**
 * 一份"四 gate 全开 + key 全注册"的 evidence。
 * endpoint_scope/model_scope/base_capability_snapshot_id 与 BASE_SNAPSHOT 精确匹配。
 */
function allTrueEvidence(): CapabilityOverrideTrustEvidence {
  return {
    trusted_source: true,
    schema_valid: true,
    deterministic_loader: true,
    exact_scope_match: true,
    registered_capability_keys: REGISTERED_KEYS,
  };
}

/**
 * allTrueEvidence() 直接提供四重 gate 全通的 evidence。
 * (历史上有 evidenceFor(override) 包装, 但未使用, 已移除。)
 */

// ─────────────────────────────────────────────────────────────────────────────
// (A) applyCapabilityOverride — 四重 trust gate
// ─────────────────────────────────────────────────────────────────────────────

describe('applyCapabilityOverride — trust gate', () => {
  it.each([
    ['trusted_source', { trusted_source: false }],
    ['schema_valid', { schema_valid: false }],
    ['deterministic_loader', { deterministic_loader: false }],
    ['exact_scope_match', { exact_scope_match: false }],
  ] as const)(
    'does not apply override when %s gate fails',
    (_name, failure) => {
      const base = BASE_SNAPSHOT;
      const effective = applyCapabilityOverride(base, VALID_OVERRIDE, {
        ...allTrueEvidence(),
        ...failure,
      });
      expect(effective.applied_override_ref).toBeNull();
      expect(effective.capabilities).toEqual(base.capabilities);
      // 失败必须留 diagnostics 痕迹(spec §8.5:"忽略 override 并记录 diagnostic")
      expect(effective.diagnostics.length).toBeGreaterThan(0);
    },
  );

  it('records a per-gate diagnostic naming which gate blocked the override', () => {
    const effective = applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, {
      ...allTrueEvidence(),
      schema_valid: false,
    });
    expect(effective.diagnostics.some((d) => /schema/i.test(d))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) applyCapabilityOverride — registered capability key 检查
// ─────────────────────────────────────────────────────────────────────────────

describe('applyCapabilityOverride — capability key registration', () => {
  it('rejects the entire override when a capability key is not registered', () => {
    const overrideWithUnknownKey: CapabilityOverrideRecord = {
      ...VALID_OVERRIDE,
      changes: { definitely_not_a_real_capability: 'supported' },
    };
    const effective = applyCapabilityOverride(BASE_SNAPSHOT, overrideWithUnknownKey, {
      ...allTrueEvidence(),
      registered_capability_keys: REGISTERED_KEYS,
    });
    expect(effective.applied_override_ref).toBeNull();
    expect(effective.capabilities).toEqual(BASE_SNAPSHOT.capabilities);
    // spec §8.5:"拒绝整条 override,不部分应用" —— diagnostics 提示 unknown capability key
    expect(effective.diagnostics.some((d) => /unknown.*capability.*key/i.test(d))).toBe(true);
  });

  it('rejects the entire override when ANY change key is unknown (no partial application)', () => {
    // 混合:一个已注册 + 一个未注册 → 整条拒绝,已注册那条也不应用
    const override: CapabilityOverrideRecord = {
      ...VALID_OVERRIDE,
      changes: {
        provider_annotations: 'supported',
        ghost_capability: 'unsupported',
      },
    };
    const effective = applyCapabilityOverride(BASE_SNAPSHOT, override, allTrueEvidence());
    expect(effective.applied_override_ref).toBeNull();
    // provider_annotations 必须仍是 base 的 'unknown',证明未部分应用
    expect(effective.capabilities.provider_annotations).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) applyCapabilityOverride — scope 精确匹配
// ─────────────────────────────────────────────────────────────────────────────

/**
 * scope 精确匹配是 evidence.exact_scope_match 的语义前提。caller 在外部对
 * provider_id / endpoint_scope / model_scope / base_capability_snapshot_id
 * 做精确相等判断,然后才把 exact_scope_match 置 true。
 *
 * 这里直接验证:caller 把 exact_scope_match 置 false(因为某项不等)时,override 不生效。
 */
describe('applyCapabilityOverride — scope match semantics', () => {
  it('does not apply override when exact_scope_match is false (scope mismatch)', () => {
    const effective = applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, {
      ...allTrueEvidence(),
      exact_scope_match: false,
    });
    expect(effective.applied_override_ref).toBeNull();
    expect(effective.capabilities).toEqual(BASE_SNAPSHOT.capabilities);
    expect(effective.diagnostics.some((d) => /scope/i.test(d))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) applyCapabilityOverride — 成功路径
// ─────────────────────────────────────────────────────────────────────────────

describe('applyCapabilityOverride — success path', () => {
  it('applies override and produces effective snapshot when all gates pass', () => {
    const effective = applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, allTrueEvidence());
    expect(effective.applied_override_ref).toBe(VALID_OVERRIDE.override_id);
    // capabilities = base ⊕ changes
    expect(effective.capabilities).toEqual({
      ...BASE_SNAPSHOT.capabilities,
      ...VALID_OVERRIDE.changes,
    });
    expect(effective.capabilities.provider_annotations).toBe('supported');
    // base 原值保留
    expect(effective.capabilities.native_tools).toBe('supported');
  });

  it('propagates base identity & scope fields onto the effective snapshot', () => {
    const effective = applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, allTrueEvidence());
    expect(effective.base_capability_snapshot_id).toBe(BASE_SNAPSHOT.capability_snapshot_id);
    expect(effective.provider_id).toBe(BASE_SNAPSHOT.provider_id);
    expect(effective.capability_protocol_version).toBe(BASE_SNAPSHOT.capability_protocol_version);
    expect(effective.endpoint_scope).toBe(VALID_OVERRIDE.endpoint_scope);
    expect(effective.model_scope).toBe(VALID_OVERRIDE.model_scope);
  });

  it('produces a deterministic effective_capability_snapshot_id (same input → same id)', () => {
    const a = applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, allTrueEvidence());
    const b = applyCapabilitySnapshotAgain();
    expect(a.effective_capability_snapshot_id).toBe(b.effective_capability_snapshot_id);
    // 不是空串
    expect(a.effective_capability_snapshot_id.length).toBeGreaterThan(0);
  });

  it('produces a different effective_capability_snapshot_id when capabilities differ', () => {
    const a = applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, allTrueEvidence());
    const otherOverride: CapabilityOverrideRecord = {
      ...VALID_OVERRIDE,
      override_id: 'ovr-002',
      changes: { provider_annotations: 'unsupported' },
    };
    const b = applyCapabilityOverride(BASE_SNAPSHOT, otherOverride, allTrueEvidence());
    expect(a.effective_capability_snapshot_id).not.toBe(b.effective_capability_snapshot_id);
  });
});

function applyCapabilitySnapshotAgain(): EffectiveCapabilitySnapshot {
  return applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, allTrueEvidence());
}

// ─────────────────────────────────────────────────────────────────────────────
// (E) applyCapabilityOverride — base immutability / 隔离
// ─────────────────────────────────────────────────────────────────────────────

describe('applyCapabilityOverride — base immutability', () => {
  it('does not mutate base snapshot capabilities when override is invalid', () => {
    const baseCapabilitiesBefore = { ...BASE_SNAPSHOT.capabilities };
    const overrideBadKey: CapabilityOverrideRecord = {
      ...VALID_OVERRIDE,
      changes: { ghost_capability: 'supported' },
    };
    applyCapabilityOverride(BASE_SNAPSHOT, overrideBadKey, allTrueEvidence());
    expect({ ...BASE_SNAPSHOT.capabilities }).toEqual(baseCapabilitiesBefore);
  });

  it('does not mutate base snapshot capabilities when override is applied', () => {
    const baseCapabilitiesBefore = { ...BASE_SNAPSHOT.capabilities };
    applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, allTrueEvidence());
    expect({ ...BASE_SNAPSHOT.capabilities }).toEqual(baseCapabilitiesBefore);
  });

  it('returns a frozen effective snapshot with frozen capabilities', () => {
    const effective = applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, allTrueEvidence());
    expect(Object.isFrozen(effective)).toBe(true);
    expect(Object.isFrozen(effective.capabilities)).toBe(true);
    expect(Object.isFrozen(effective.diagnostics)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (F) supported ≠ permission allow(INV-C5)契约声明
// ─────────────────────────────────────────────────────────────────────────────

describe('applyCapabilityOverride — supported is not permission allow (INV-C5)', () => {
  it('only carries capability support values, never grants permission', () => {
    const effective = applyCapabilityOverride(BASE_SNAPSHOT, VALID_OVERRIDE, allTrueEvidence());
    // 输出仅是 supported/unsupported/unknown 表达,没有任何 permission 字段
    for (const v of Object.values(effective.capabilities)) {
      expect(['supported', 'unsupported', 'unknown']).toContain(v);
    }
    expect((effective as unknown as Record<string, unknown>).permissions).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (G) ConfigStore trusted loader entry
// ─────────────────────────────────────────────────────────────────────────────

describe('ConfigStore.getCapabilityOverrides — trusted loader entry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-cap-override-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns [] when capability_overrides is absent (backward compatible)', () => {
    const store = new ConfigStore(tempDir);
    expect(store.getCapabilityOverrides()).toEqual([]);
  });

  it('loads capability_overrides from config file deterministically', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    const rawOverride = {
      override_id: 'ovr-from-file',
      override_version: '1',
      source_config_ref: 'config.json',
      source_trust_proof_ref: 'trust-proof:frozen-policy-v1',
      provider_id: 'openai-compatible',
      endpoint_scope: 'https://api.openai.com/v1',
      model_scope: 'gpt-4o',
      base_capability_snapshot_id: 'cap-base-openai-1',
      changes: { provider_annotations: 'supported' },
      justification: 'verified',
    };
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ capability_overrides: [rawOverride] }),
    );

    const store1 = new ConfigStore(configDir);
    const records1 = store1.getCapabilityOverrides();
    expect(records1).toHaveLength(1);
    expect(records1[0].override_id).toBe('ovr-from-file');

    // 确定性:同一个 config → 同样的 record(再开一个 store 应得到一致内容)
    const store2 = new ConfigStore(configDir);
    const records2 = store2.getCapabilityOverrides();
    expect(records2).toEqual(records1);
  });

  it('drops malformed override entries (schema/key validation) but keeps valid ones', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        capability_overrides: [
          {
            // 合法
            override_id: 'ovr-good',
            override_version: '1',
            source_config_ref: 'c',
            source_trust_proof_ref: 't',
            provider_id: 'openai-compatible',
            endpoint_scope: 'https://api.openai.com/v1',
            model_scope: 'gpt-4o',
            base_capability_snapshot_id: 'cap-base-openai-1',
            changes: { provider_annotations: 'supported' },
            justification: 'ok',
          },
          {
            // 缺关键字段 override_id —— 非法
            override_version: '1',
            provider_id: 'x',
            changes: {},
          },
          'not-an-object',
        ],
      }),
    );

    const store = new ConfigStore(configDir);
    const records = store.getCapabilityOverrides();
    expect(records).toHaveLength(1);
    expect(records[0].override_id).toBe('ovr-good');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (H) end-to-end: loader → applyCapabilityOverride
// ─────────────────────────────────────────────────────────────────────────────

describe('end-to-end: ConfigStore loader → applyCapabilityOverride', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-cap-override-e2e-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a loaded override can be applied to a matching base snapshot', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        capability_overrides: [
          {
            override_id: 'ovr-e2e',
            override_version: '1',
            source_config_ref: 'config.json',
            source_trust_proof_ref: 'trust-proof:frozen-policy-v1',
            provider_id: 'openai-compatible',
            endpoint_scope: 'https://api.openai.com/v1',
            model_scope: 'gpt-4o',
            base_capability_snapshot_id: 'cap-base-openai-1',
            changes: { provider_annotations: 'supported' },
            justification: 'verified',
          },
        ],
      }),
    );

    const store = new ConfigStore(configDir);
    const overrides = store.getCapabilityOverrides();
    expect(overrides).toHaveLength(1);

    // caller 拿到 override 后,自己负责做 scope 比对 + 给出 evidence
    const evidence: CapabilityOverrideTrustEvidence = {
      trusted_source: true,
      schema_valid: true,
      deterministic_loader: true,
      exact_scope_match: true,
      registered_capability_keys: REGISTERED_KEYS,
    };
    const effective = applyCapabilityOverride(BASE_SNAPSHOT, overrides[0], evidence);
    expect(effective.applied_override_ref).toBe('ovr-e2e');
    expect(effective.capabilities.provider_annotations).toBe('supported');
  });
});
