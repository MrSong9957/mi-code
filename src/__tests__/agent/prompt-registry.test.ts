// src/__tests__/agent/prompt-registry.test.ts
// AUTO-0025 Wave A (Task 2):RC-1 Prompt Asset Registry.
//
// 物理本质:PromptAssetRegistry 是 prompt 资产的"受控入口"。
// 只接受 in-memory 的 PromptAssetRecord[],输出一份冻结的、已排序的、仅含 approved 资产的快照。
// 关键不变量:
//   - 只放行 evaluation.status === 'approved' 的资产(candidate/unverified/rejected/retired 排除)。
//   - approved 资产必须满足 license 非空、evidence_refs 全部已知、target_capabilities 全部已知,否则整体 fatal。
//   - (asset_id, asset_version) + 不同 content_ref 是冲突(throw);相同 content_ref 去重。
//   - 绝不引入 protocol_version(asset_version 与 protocol_version 正交,INV-A1)。
//   - 绝不修改调用方输入(deep-copy + freeze)。

import { describe, expect, it } from 'vitest';
import {
  buildPromptAssetRegistry,
  type PromptAssetRecord,
} from '../../agent/prompt/registry.js';

const base: PromptAssetRecord = {
  asset_id: 'agent.base',
  asset_version: '1',
  source: { kind: 'mi-code', locator: 'src/prompts/base.md', license: 'ISC' },
  purpose: 'base agent behavior',
  owner: 'P1',
  target_models: [],
  target_capabilities: ['text'],
  prohibited_placements: [],
  adaptation_notes: '',
  evaluation: { status: 'approved', evidence_refs: ['eval:base:1'] },
  content_ref: 'prompt:agent.base:1',
};

const KNOWN_EVIDENCE = new Set(['eval:base:1']);
const KNOWN_CAPS = new Set(['text']);

describe('buildPromptAssetRegistry', () => {
  it('includes approved assets and excludes candidate assets', () => {
    const snapshot = buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [
        base,
        { ...base, asset_id: 'candidate', evaluation: { status: 'candidate', evidence_refs: [] } },
      ],
      known_evidence_refs: KNOWN_EVIDENCE,
      known_capabilities: KNOWN_CAPS,
    });
    expect(snapshot.assets.map((asset) => asset.asset_id)).toEqual(['agent.base']);
    expect(Object.isFrozen(snapshot.assets)).toBe(true);
  });

  it('rejects same identity/version with different content refs', () => {
    expect(() =>
      buildPromptAssetRegistry({
        registry_snapshot_id: 'registry-1',
        records: [base, { ...base, content_ref: 'prompt:different' }],
        known_evidence_refs: KNOWN_EVIDENCE,
        known_capabilities: KNOWN_CAPS,
      }),
    ).toThrow('agent.base@1');
  });

  it('does not use protocol_version as asset_version', () => {
    expect(base).not.toHaveProperty('protocol_version');
  });

  // ── 额外用例:approved 资产的三条强制不变量 ──

  it('throws when an approved external asset has license=null', () => {
    const noLicense = {
      ...base,
      asset_id: 'agent.external',
      source: {
        kind: 'external' as const,
        locator: 'https://example.com/p.md',
        license: null,
      },
    };
    expect(() =>
      buildPromptAssetRegistry({
        registry_snapshot_id: 'registry-1',
        records: [noLicense],
        known_evidence_refs: KNOWN_EVIDENCE,
        known_capabilities: KNOWN_CAPS,
      }),
    ).toThrow();
  });

  it('throws when an approved asset references an unknown evidence ref', () => {
    const badEvidence = {
      ...base,
      evaluation: { status: 'approved' as const, evidence_refs: ['eval:missing'] },
    };
    expect(() =>
      buildPromptAssetRegistry({
        registry_snapshot_id: 'registry-1',
        records: [badEvidence],
        known_evidence_refs: KNOWN_EVIDENCE, // 不含 eval:missing
        known_capabilities: KNOWN_CAPS,
      }),
    ).toThrow();
  });

  it('throws when an approved asset declares an unknown target capability', () => {
    const badCap = {
      ...base,
      asset_id: 'agent.badcap',
      target_capabilities: ['unknown-cap'],
    };
    expect(() =>
      buildPromptAssetRegistry({
        registry_snapshot_id: 'registry-1',
        records: [badCap],
        known_evidence_refs: KNOWN_EVIDENCE,
        known_capabilities: KNOWN_CAPS, // 不含 unknown-cap
      }),
    ).toThrow();
  });

  // ── candidate 的失败是"静默排除",不是 fatal ──

  it('excludes (not fails) a candidate asset with missing evidence', () => {
    const snapshot = buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [
        base,
        {
          ...base,
          asset_id: 'agent.cand',
          evaluation: { status: 'candidate', evidence_refs: ['eval:missing'] },
        },
      ],
      known_evidence_refs: KNOWN_EVIDENCE,
      known_capabilities: KNOWN_CAPS,
    });
    expect(snapshot.assets.map((a) => a.asset_id)).toEqual(['agent.base']);
  });

  // ── 去重:同 (asset_id, asset_version) + 同 content_ref ──

  it('deduplicates records sharing identity/version/content_ref', () => {
    const dup: PromptAssetRecord = { ...base }; // 完全一致(含 content_ref)
    const snapshot = buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [base, dup],
      known_evidence_refs: KNOWN_EVIDENCE,
      known_capabilities: KNOWN_CAPS,
    });
    expect(snapshot.assets.length).toBe(1);
    expect(snapshot.assets[0]!.asset_id).toBe('agent.base');
  });

  // ── 顺序无关 / 稳定排序 ──

  it('produces identical snapshot assets for inputs in different order', () => {
    const a: PromptAssetRecord = { ...base, asset_id: 'agent.a', content_ref: 'p:a' };
    const b: PromptAssetRecord = { ...base, asset_id: 'agent.b', content_ref: 'p:b' };
    const snap1 = buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [a, b],
      known_evidence_refs: KNOWN_EVIDENCE,
      known_capabilities: KNOWN_CAPS,
    });
    const snap2 = buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [b, a],
      known_evidence_refs: KNOWN_EVIDENCE,
      known_capabilities: KNOWN_CAPS,
    });
    expect(snap1.assets.map((x) => [x.asset_id, x.content_ref])).toEqual(
      snap2.assets.map((x) => [x.asset_id, x.content_ref]),
    );
    // 排序后 b 应在 a 前(按 asset_id 升序)
    expect(snap1.assets.map((x) => x.asset_id)).toEqual(['agent.a', 'agent.b']);
  });

  // ── requireIdentity 守门 ──

  it('throws when registry_snapshot_id is empty (uses requireIdentity)', () => {
    expect(() =>
      buildPromptAssetRegistry({
        registry_snapshot_id: '',
        records: [base],
        known_evidence_refs: KNOWN_EVIDENCE,
        known_capabilities: KNOWN_CAPS,
      }),
    ).toThrow();
  });

  // ── 冻结:数组 + 每条记录 + 嵌套数组 ──

  it('freezes the assets array, each asset, and nested arrays', () => {
    const snapshot = buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [base],
      known_evidence_refs: KNOWN_EVIDENCE,
      known_capabilities: KNOWN_CAPS,
    });
    expect(Object.isFrozen(snapshot.assets)).toBe(true);
    expect(Object.isFrozen(snapshot.assets[0])).toBe(true);
    expect(Object.isFrozen(snapshot.assets[0]!.target_capabilities)).toBe(true);
    expect(Object.isFrozen(snapshot.assets[0]!.source)).toBe(true);
    expect(Object.isFrozen(snapshot.assets[0]!.evaluation)).toBe(true);
  });

  // ── 不污染调用方输入 ──

  it('does not mutate caller input records', () => {
    const before = structuredClone(base);
    buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [base],
      known_evidence_refs: KNOWN_EVIDENCE,
      known_capabilities: KNOWN_CAPS,
    });
    // 调用前后,base 必须未被修改(深比较)
    expect(base).toEqual(before);
    // 而且 base 本身没被冻结(builder 不应就地冻结输入)
    expect(Object.isFrozen(base)).toBe(false);
  });

  // ── 输出快照不应携带 protocol_version ──

  it('does not expose a protocol_version property on the snapshot', () => {
    const snapshot = buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [base],
      known_evidence_refs: KNOWN_EVIDENCE,
      known_capabilities: KNOWN_CAPS,
    });
    expect(snapshot).not.toHaveProperty('protocol_version');
    expect(snapshot.assets[0]).not.toHaveProperty('protocol_version');
  });
});
