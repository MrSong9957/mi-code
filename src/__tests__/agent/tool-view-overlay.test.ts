// src/__tests__/agent/tool-view-overlay.test.ts
// Wave B Task 3 (M-020/M-024): Tool Prompt Metadata & Overlay (BRC-2).
//
// 物理本质:把 "base 工具底片 + 能力快照 + prompt 元数据 + role/mode/security overlay"
// 压成一张 per-request 的不可变工具视图。overlay 只能进一步收窄可见性 ——
// 它绝不能新增工具、改 schema、改 executor、改 canonical order,也绝不能把
// capability/security/approval 已排除的工具通过 requested_visibility:'include' 复活。
//
// 派生顺序(spec §8.4 + plan Step 4,FIXED —— 每步只能进一步收窄):
//   1. base existence      —— 工具必须存在于 base snapshot
//   2. capability          —— required cap 为 unsupported/unknown → excluded
//   3. security            —— tool_id 在 security_excluded_tool_ids → excluded
//   4. role/mode requested —— overlay.requested_visibility[tool_id] === 'exclude' → excluded
//   5. approved description—— evaluation_status !== 'approved' 或 asset 未批准 → excluded
//   6. provider annotations—— 仅对 'supported' 能力附加注解
//
// 多重原因同时命中时,派生顺序中最先命中的步骤胜出
// (capability > security > overlay > description)。

import { describe, expect, it } from 'vitest';
import { deriveRequestToolView } from '../../agent/tools/overlay.js';
import {
  createToolPromptMetadata,
  type ToolPromptMetadata,
} from '../../agent/tools/prompt-metadata.js';
import { buildToolDefinitionSnapshot } from '../../agent/tools/descriptor-snapshot.js';
import { createModelCapabilitySnapshot } from '../../agent/tools/capability-snapshot.js';
import type { RegisteredTool, ToolDefinition } from '../../agent/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper builders
// ─────────────────────────────────────────────────────────────────────────────

function def(name: string): ToolDefinition {
  return {
    name,
    description: `${name} desc`,
    parameters: { type: 'object', properties: {}, required: [] },
  };
}

function baseWith(names: string[]): ReturnType<typeof buildToolDefinitionSnapshot> {
  const map = new Map<string, RegisteredTool>();
  for (const n of names) map.set(n, { definition: def(n), executor: async () => '' });
  return buildToolDefinitionSnapshot('base-1', map);
}

function capability(caps: Record<string, 'supported' | 'unsupported' | 'unknown'>) {
  return createModelCapabilitySnapshot({
    capability_protocol_version: '1',
    capability_snapshot_id: 'cap-1',
    provider_id: 'test',
    model_id: 'm',
    adapter_version: '1',
    capabilities: caps,
    diagnostics: [],
  });
}

function metadataFor(
  map: Record<string, Partial<ToolPromptMetadata>>,
): Map<string, ToolPromptMetadata> {
  const m = new Map<string, ToolPromptMetadata>();
  for (const [tool_id, partial] of Object.entries(map)) {
    m.set(
      tool_id,
      createToolPromptMetadata({
        tool_id,
        description_asset_ref: partial.description_asset_ref ?? null,
        required_capabilities: partial.required_capabilities ?? [],
        declared_policy_refs: partial.declared_policy_refs ?? [],
        evaluation_status: partial.evaluation_status ?? 'approved',
      }),
    );
  }
  return m;
}

/** Convenience: build an overlay input with sensible defaults. */
function overlay(overrides: Partial<{
  base_tool_snapshot_id: string;
  capability_snapshot_id: string;
  control_mode: string;
  role_id: string | null;
  security_policy_snapshot_id: string;
  requested_visibility: Record<string, 'include' | 'exclude'>;
}>): {
  base_tool_snapshot_id: string;
  capability_snapshot_id: string;
  control_mode: string;
  role_id: string | null;
  security_policy_snapshot_id: string;
  requested_visibility: Readonly<Record<string, 'include' | 'exclude'>>;
} {
  return {
    base_tool_snapshot_id: 'base-1',
    capability_snapshot_id: 'cap-1',
    control_mode: 'build',
    role_id: null,
    security_policy_snapshot_id: 'security-1',
    requested_visibility: {},
    ...overrides,
  };
}

/** Default deriveRequestToolView input with a permissive environment. */
function deriveInput(overrides: Partial<Parameters<typeof deriveRequestToolView>[0]> = {}) {
  return {
    tool_view_protocol_version: '1',
    tool_view_snapshot_id: 'view-1',
    base: baseWith(['read_file']),
    capability: capability({}),
    metadata: metadataFor({}),
    overlay: overlay({}),
    security_excluded_tool_ids: new Set<string>(),
    approvedAsset: () => true,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createToolPromptMetadata — pure contract
// ─────────────────────────────────────────────────────────────────────────────

describe('createToolPromptMetadata — validation', () => {
  it('rejects empty tool_id via requireIdentity', () => {
    expect(() =>
      createToolPromptMetadata({
        tool_id: '',
        description_asset_ref: null,
        required_capabilities: [],
        declared_policy_refs: [],
        evaluation_status: 'approved',
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects whitespace-only tool_id via requireIdentity', () => {
    expect(() =>
      createToolPromptMetadata({
        tool_id: '   ',
        description_asset_ref: null,
        required_capabilities: [],
        declared_policy_refs: [],
        evaluation_status: 'approved',
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects an invalid evaluation_status string', () => {
    expect(() =>
      createToolPromptMetadata({
        tool_id: 't',
        description_asset_ref: null,
        required_capabilities: [],
        declared_policy_refs: [],
        evaluation_status: 'pending' as never,
      }),
    ).toThrow(/evaluation_status/);
  });

  it('accepts all three legal evaluation_status values', () => {
    for (const status of ['approved', 'candidate', 'rejected'] as const) {
      const m = createToolPromptMetadata({
        tool_id: 't',
        description_asset_ref: null,
        required_capabilities: [],
        declared_policy_refs: [],
        evaluation_status: status,
      });
      expect(m.evaluation_status).toBe(status);
    }
  });
});

describe('createToolPromptMetadata — freezing & isolation', () => {
  it('returns a frozen object with frozen arrays', () => {
    const m = createToolPromptMetadata({
      tool_id: 't',
      description_asset_ref: { asset_id: 'a', asset_version: '1' },
      required_capabilities: ['c'],
      declared_policy_refs: ['p'],
      evaluation_status: 'approved',
    });
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.required_capabilities)).toBe(true);
    expect(Object.isFrozen(m.declared_policy_refs)).toBe(true);
    expect(Object.isFrozen(m.description_asset_ref)).toBe(true);
  });

  it('deep-copies arrays so later input mutation cannot affect metadata', () => {
    const required = ['c1'];
    const declared = ['p1'];
    const m = createToolPromptMetadata({
      tool_id: 't',
      description_asset_ref: null,
      required_capabilities: required,
      declared_policy_refs: declared,
      evaluation_status: 'approved',
    });
    required.push('c2');
    declared.push('p2');
    expect([...m.required_capabilities]).toEqual(['c1']);
    expect([...m.declared_policy_refs]).toEqual(['p1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveRequestToolView — only-narrow overlay invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveRequestToolView — cannot restore excluded tools via requested_visibility', () => {
  it('cannot restore a capability-excluded tool through requested visibility', () => {
    const view = deriveRequestToolView({
      tool_view_protocol_version: '1',
      tool_view_snapshot_id: 'view-1',
      base: baseWith(['read_file', 'image_tool']),
      capability: capability({ image_input: 'unsupported' }),
      metadata: metadataFor({ image_tool: { required_capabilities: ['image_input'] } }),
      overlay: overlay({ requested_visibility: { image_tool: 'include' } }),
      security_excluded_tool_ids: new Set(),
      approvedAsset: () => true,
    });
    expect(view.entries.find((e) => e.tool_id === 'image_tool')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'capability.unsupported.image_input',
    });
  });

  it('cannot restore a security-excluded tool through requested visibility', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'dangerous']),
        metadata: metadataFor({}),
        overlay: overlay({ requested_visibility: { dangerous: 'include' } }),
        security_excluded_tool_ids: new Set(['dangerous']),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'dangerous')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'security.excluded',
    });
  });

  it('cannot restore a description-not-approved tool through requested visibility', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'beta']),
        metadata: metadataFor({ beta: { evaluation_status: 'candidate' } }),
        overlay: overlay({ requested_visibility: { beta: 'include' } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'beta')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'description.not_approved',
    });
  });
});

describe('deriveRequestToolView — inclusion happy path & order', () => {
  it('includes all tools when no exclusions apply (no reason codes)', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['alpha', 'beta', 'gamma']),
        metadata: metadataFor({}),
      }),
    );
    expect(view.entries.map((e) => e.visibility)).toEqual([
      'included',
      'included',
      'included',
    ]);
    for (const e of view.entries) {
      expect(e.exclusion_reason_code).toBeNull();
    }
  });

  it('sorts entries by canonical_order ascending (preserves base order)', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['zeta', 'alpha', 'mid']),
        metadata: metadataFor({}),
      }),
    );
    expect(view.entries.map((e) => e.canonical_order)).toEqual([0, 1, 2]);
    expect(view.entries.map((e) => e.tool_id)).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('treats tools absent from metadata map as approved with no required capabilities', () => {
    // base has tool, metadata map empty → tool must still be included.
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['lonely']),
        metadata: metadataFor({}),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'lonely')?.visibility).toBe('included');
  });
});

describe('deriveRequestToolView — capability exclusion', () => {
  it('excludes when a required capability is unsupported (reason includes cap name)', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'image_tool']),
        capability: capability({ image_input: 'unsupported' }),
        metadata: metadataFor({ image_tool: { required_capabilities: ['image_input'] } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'image_tool')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'capability.unsupported.image_input',
    });
  });

  it('excludes when a required capability is unknown', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'mystery']),
        capability: capability({ mystery_cap: 'unknown' }),
        metadata: metadataFor({ mystery: { required_capabilities: ['mystery_cap'] } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'mystery')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'capability.unknown.mystery_cap',
    });
  });

  it('includes when a required capability is supported', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'image_tool']),
        capability: capability({ image_input: 'supported' }),
        metadata: metadataFor({ image_tool: { required_capabilities: ['image_input'] } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'image_tool')?.visibility).toBe('included');
  });

  it('uses the FIRST failing capability (in metadata.required_capabilities order)', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['multi']),
        capability: capability({ cap_a: 'supported', cap_b: 'unsupported', cap_c: 'unknown' }),
        // metadata required order: [cap_b_unsupported, cap_c_unknown]
        metadata: metadataFor({
          multi: { required_capabilities: ['cap_b', 'cap_c'] },
        }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'multi')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'capability.unsupported.cap_b',
    });
  });
});

describe('deriveRequestToolView — security exclusion', () => {
  it('excludes with reason security.excluded', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'shell']),
        security_excluded_tool_ids: new Set(['shell']),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'shell')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'security.excluded',
    });
  });
});

describe('deriveRequestToolView — role/mode requested exclusion', () => {
  it("excludes when overlay.requested_visibility[tool_id] === 'exclude'", () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'noisy']),
        overlay: overlay({ requested_visibility: { noisy: 'exclude' } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'noisy')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'overlay.requested_exclude',
    });
  });
});

describe('deriveRequestToolView — approved description', () => {
  it('excludes a candidate description (not approved)', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'beta']),
        metadata: metadataFor({ beta: { evaluation_status: 'candidate' } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'beta')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'description.not_approved',
    });
  });

  it('excludes a rejected description (not approved)', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'bad']),
        metadata: metadataFor({ bad: { evaluation_status: 'rejected' } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'bad')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'description.not_approved',
    });
  });

  it('excludes when description_asset_ref is non-null but approvedAsset returns false', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'att']),
        metadata: metadataFor({
          att: {
            evaluation_status: 'approved',
            description_asset_ref: { asset_id: 'a1', asset_version: 'v1' },
          },
        }),
        approvedAsset: () => false,
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'att')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'description.not_approved',
    });
  });

  it('includes when description_asset_ref is null and evaluation_status is approved', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file']),
        metadata: metadataFor({
          read_file: { evaluation_status: 'approved', description_asset_ref: null },
        }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'read_file')?.visibility).toBe('included');
  });
});

describe('deriveRequestToolView — precedence (earliest step wins)', () => {
  it('capability beats security (capability step runs first)', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['double']),
        capability: capability({ cap_x: 'unsupported' }),
        metadata: metadataFor({ double: { required_capabilities: ['cap_x'] } }),
        security_excluded_tool_ids: new Set(['double']),
        // also try to "include" it — must stay excluded with capability reason
        overlay: overlay({ requested_visibility: { double: 'include' } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'double')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'capability.unsupported.cap_x',
    });
  });

  it('security beats overlay requested_exclude (security step runs first)', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['double']),
        security_excluded_tool_ids: new Set(['double']),
        overlay: overlay({ requested_visibility: { double: 'exclude' } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'double')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'security.excluded',
    });
  });

  it('overlay requested_exclude beats description candidate', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['double']),
        metadata: metadataFor({ double: { evaluation_status: 'candidate' } }),
        overlay: overlay({ requested_visibility: { double: 'exclude' } }),
      }),
    );
    expect(view.entries.find((e) => e.tool_id === 'double')).toMatchObject({
      visibility: 'excluded',
      exclusion_reason_code: 'overlay.requested_exclude',
    });
  });
});

describe('deriveRequestToolView — unknown tool_id in overlay', () => {
  it('silently ignores requested_visibility for tool_id not in base (no entry created)', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file']),
        overlay: overlay({ requested_visibility: { ghost: 'exclude' } }),
      }),
    );
    // ghost does not exist in base → no entry for it; read_file still included
    expect(view.entries.map((e) => e.tool_id)).toEqual(['read_file']);
    expect(view.entries[0].visibility).toBe('included');
  });

  it('silently ignores requested_visibility include for an unknown tool_id', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file']),
        overlay: overlay({ requested_visibility: { ghost: 'include' } }),
      }),
    );
    expect(view.entries.map((e) => e.tool_id)).toEqual(['read_file']);
  });
});

describe('deriveRequestToolView — provider annotations', () => {
  it('attaches annotations only for supported capabilities (verified indirectly via reason absence)', () => {
    // This case asserts the structural rule: a tool whose required cap is supported
    // is included (so annotations are attached); a tool whose cap is unknown is
    // excluded (so no annotations). The provider_annotations record itself is
    // always present on every entry (possibly empty) — we assert its shape.
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['supported_tool', 'unknown_tool']),
        capability: capability({
          good_cap: 'supported',
          risky_cap: 'unknown',
        }),
        metadata: metadataFor({
          supported_tool: { required_capabilities: ['good_cap'] },
          unknown_tool: { required_capabilities: ['risky_cap'] },
        }),
      }),
    );
    const supported = view.entries.find((e) => e.tool_id === 'supported_tool')!;
    const unknown = view.entries.find((e) => e.tool_id === 'unknown_tool')!;
    expect(supported.visibility).toBe('included');
    expect(unknown.visibility).toBe('excluded');
    // Both have a provider_annotations record (frozen).
    expect(supported.provider_annotations).toEqual(expect.any(Object));
    expect(Object.isFrozen(supported.provider_annotations)).toBe(true);
    expect(unknown.provider_annotations).toEqual(expect.any(Object));
    expect(Object.isFrozen(unknown.provider_annotations)).toBe(true);
  });
});

describe('deriveRequestToolView — determinism & shape', () => {
  it('derives the same tool_view_snapshot_id for identical inputs', () => {
    const a = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'image_tool']),
        capability: capability({ image_input: 'unsupported' }),
        metadata: metadataFor({ image_tool: { required_capabilities: ['image_input'] } }),
        overlay: overlay({ requested_visibility: { image_tool: 'include' } }),
      }),
    );
    const b = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'image_tool']),
        capability: capability({ image_input: 'unsupported' }),
        metadata: metadataFor({ image_tool: { required_capabilities: ['image_input'] } }),
        overlay: overlay({ requested_visibility: { image_tool: 'include' } }),
      }),
    );
    expect(a.tool_view_snapshot_id).toBe(b.tool_view_snapshot_id);
    expect(a.tool_view_snapshot_id.length).toBeGreaterThan(0);
  });

  it('does NOT embed a random UUID in tool_view_snapshot_id', () => {
    const view = deriveRequestToolView(deriveInput());
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(UUID_RE.test(view.tool_view_snapshot_id)).toBe(false);
  });

  it('changes tool_view_snapshot_id when an inclusion decision flips', () => {
    const included = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'extra']),
        capability: capability({}),
      }),
    );
    const withExcluded = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file', 'extra']),
        capability: capability({}),
        overlay: overlay({ requested_visibility: { extra: 'exclude' } }),
      }),
    );
    expect(included.tool_view_snapshot_id).not.toBe(withExcluded.tool_view_snapshot_id);
  });

  it('freezes the snapshot, its entries array, and each entry', () => {
    const view = deriveRequestToolView(deriveInput({ base: baseWith(['a', 'b']) }));
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.entries)).toBe(true);
    expect(Object.isFrozen(view.entries[0])).toBe(true);
  });

  it('records the snapshot ids from the overlay verbatim', () => {
    const view = deriveRequestToolView(
      deriveInput({
        base: baseWith(['read_file']),
        overlay: overlay({
          base_tool_snapshot_id: 'base-9',
          capability_snapshot_id: 'cap-9',
          security_policy_snapshot_id: 'security-9',
        }),
      }),
    );
    expect(view.base_tool_snapshot_id).toBe('base-9');
    expect(view.capability_snapshot_id).toBe('cap-9');
    expect(view.security_policy_snapshot_id).toBe('security-9');
  });

  it('propagates tool_view_protocol_version verbatim', () => {
    const view = deriveRequestToolView({
      ...deriveInput(),
      tool_view_protocol_version: '7',
    });
    expect(view.tool_view_protocol_version).toBe('7');
  });
});

describe('deriveRequestToolView — empty inputs', () => {
  it('produces an empty entries array (still frozen, deterministic id)', () => {
    const emptyBase = buildToolDefinitionSnapshot('base-empty', new Map());
    const view = deriveRequestToolView({
      tool_view_protocol_version: '1',
      tool_view_snapshot_id: 'view-empty',
      base: emptyBase,
      capability: capability({}),
      metadata: metadataFor({}),
      overlay: overlay({ base_tool_snapshot_id: 'base-empty' }),
      security_excluded_tool_ids: new Set(),
      approvedAsset: () => true,
    });
    expect(view.entries).toEqual([]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.entries)).toBe(true);
    // deterministic
    const again = deriveRequestToolView({
      tool_view_protocol_version: '1',
      tool_view_snapshot_id: 'view-empty',
      base: buildToolDefinitionSnapshot('base-empty', new Map()),
      capability: capability({}),
      metadata: metadataFor({}),
      overlay: overlay({ base_tool_snapshot_id: 'base-empty' }),
      security_excluded_tool_ids: new Set(),
      approvedAsset: () => true,
    });
    expect(view.tool_view_snapshot_id).toBe(again.tool_view_snapshot_id);
  });
});

describe('deriveRequestToolView — identity validation', () => {
  it('throws on empty tool_view_protocol_version', () => {
    expect(() =>
      deriveRequestToolView({
        ...deriveInput(),
        tool_view_protocol_version: '',
      }),
    ).toThrow(/non-empty/);
  });

  it('throws on empty tool_view_snapshot_id (caller-provided identity must be present)', () => {
    // The spec input declares tool_view_snapshot_id as a caller-provided identity
    // (parallel to registry_snapshot_id / capability_snapshot_id). It must be
    // validated non-empty, mirroring the other snapshot builders.
    expect(() =>
      deriveRequestToolView({
        ...deriveInput(),
        tool_view_snapshot_id: '',
      }),
    ).toThrow(/non-empty/);
  });
});
