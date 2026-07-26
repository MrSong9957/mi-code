// src/__tests__/agent/tool-reference-manifest.test.ts
// Wave D Task 8 (M-028 / DRC-3): Tool Reference Manifest.
//
// 物理本质:buildToolReferenceManifest 把"已确定的 Prompt 工具引用声明"
// 压成一份稳定、确定、可追溯的 ToolReferenceManifest。
//
// 关键不变量(spec §9.2 / §9.5 / §9.6):
//   - records 记录的是稳定 tool_id,不是 display-name 猜测;
//   - 同一 tool_id 在同一 section 重复 → throw 'reference.duplicate_tool_id';
//   - 一个 canonical name 映射多个 tool_id → throw 'reference.canonical_ambiguous';
//   - deterministic_render_scan 只识别已登记 canonical name,不猜测自然语言;
//   - manifest 不改 Prompt 内容 / tool order / visibility / permission;
//   - manifest 只记录引用,不验证 manual 完整性(INV-D10);
//   - 同一不可变输入 → 同一 manifest_id(确定性,spec §9.5 rule 12)。

import { describe, expect, it } from 'vitest';
import {
  buildToolReferenceManifest,
  REFERENCE_MANIFEST_PROTOCOL_VERSION,
  type ToolReferenceDeclaration,
  type ToolReferenceManifestInput,
} from '../../agent/tools/reference-validator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** 构造一个最小合法 declaration,便于各 case 局部覆盖。 */
function makeDeclaration(
  overrides: Partial<ToolReferenceDeclaration> = {},
): ToolReferenceDeclaration {
  return {
    section_id: 'tools',
    tool_id: 'tool:run_bash',
    canonical_tool_name: 'run_bash',
    source_kind: 'compiler_reference_token',
    evidence_ref: 'asset:tools@1',
    ...overrides,
  };
}

function makeInput(
  declarations: ToolReferenceDeclaration[],
  compiled_prompt_snapshot_id = 'compiled:abc',
): ToolReferenceManifestInput {
  return { compiled_prompt_snapshot_id, declarations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path & shape
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolReferenceManifest / happy path', () => {
  it('records stable tool ids instead of display-name guesses', () => {
    const manifest = buildToolReferenceManifest(
      makeInput([
        makeDeclaration({
          tool_id: 'tool:run_bash',
          canonical_tool_name: 'run_bash',
          source_kind: 'compiler_reference_token',
        }),
      ]),
    );

    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0].tool_id).toBe('tool:run_bash');
    expect(manifest.records[0].canonical_tool_name).toBe('run_bash');
    expect(manifest.records[0].source_kind).toBe('compiler_reference_token');
    expect(manifest.records[0].section_id).toBe('tools');
    expect(manifest.records[0].evidence_ref).toBe('asset:tools@1');
  });

  it('accepts all three closed source_kinds', () => {
    const manifest = buildToolReferenceManifest(
      makeInput([
        makeDeclaration({
          tool_id: 'tool:a',
          canonical_tool_name: 'a',
          source_kind: 'structured_asset_metadata',
          evidence_ref: 'asset:a@1',
        }),
        makeDeclaration({
          section_id: 'tools',
          tool_id: 'tool:b',
          canonical_tool_name: 'b',
          source_kind: 'compiler_reference_token',
          evidence_ref: 'asset:b@1',
        }),
        makeDeclaration({
          section_id: 'tools2',
          tool_id: 'tool:c',
          canonical_tool_name: 'c',
          source_kind: 'deterministic_render_scan',
          evidence_ref: 'asset:c@1',
        }),
      ]),
    );

    const kinds = manifest.records.map((r) => r.source_kind).sort();
    expect(kinds).toEqual([
      'compiler_reference_token',
      'deterministic_render_scan',
      'structured_asset_metadata',
    ]);
  });

  it('propagates protocol version, snapshot id, and manifest id shape', () => {
    const manifest = buildToolReferenceManifest(
      makeInput([makeDeclaration()], 'compiled:snap-1'),
    );

    expect(manifest.reference_manifest_protocol_version).toBe(
      REFERENCE_MANIFEST_PROTOCOL_VERSION,
    );
    expect(manifest.compiled_prompt_snapshot_id).toBe('compiled:snap-1');
    // manifest:<16 hex chars>
    expect(manifest.reference_manifest_id).toMatch(/^manifest:[a-f0-9]{16}$/);
  });

  it('derives reference_id from canonical_tool_name with ref: prefix', () => {
    const manifest = buildToolReferenceManifest(
      makeInput([
        makeDeclaration({
          tool_id: 'tool:run_bash',
          canonical_tool_name: 'run_bash',
        }),
      ]),
    );

    // 简单情况(单一 canonical name):使用 ref:<canonical> 形式,可读且确定。
    expect(manifest.records[0].reference_id).toBe('ref:run_bash');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolReferenceManifest / determinism', () => {
  it('produces deterministic manifest_id for the same logical input', () => {
    const input1 = makeInput([
      makeDeclaration({ tool_id: 'tool:a', canonical_tool_name: 'a' }),
    ]);
    const input2 = makeInput([
      makeDeclaration({ tool_id: 'tool:a', canonical_tool_name: 'a' }),
    ]);

    const m1 = buildToolReferenceManifest(input1);
    const m2 = buildToolReferenceManifest(input2);

    expect(m1.reference_manifest_id).toBe(m2.reference_manifest_id);
    expect(m1.records[0].reference_id).toBe(m2.records[0].reference_id);
  });

  it('produces different manifest_id when canonical name set changes (rename forms new version)', () => {
    // spec §9.5 rule 8: 重命名工具必须形成新的 manifest/asset version
    const before = buildToolReferenceManifest(
      makeInput([makeDeclaration({ canonical_tool_name: 'run_bash', tool_id: 'tool:run_bash' })]),
    );
    const after = buildToolReferenceManifest(
      makeInput([makeDeclaration({ canonical_tool_name: 'execute_shell', tool_id: 'tool:execute_shell' })]),
    );

    expect(before.reference_manifest_id).not.toBe(after.reference_manifest_id);
  });

  it('sorts records by (section_id ASC, tool_id ASC) deterministically', () => {
    // 故意乱序传入,验证输出顺序与输入顺序无关。
    const manifest = buildToolReferenceManifest(
      makeInput([
        makeDeclaration({ section_id: 'tools2', tool_id: 'tool:z', canonical_tool_name: 'z' }),
        makeDeclaration({ section_id: 'tools', tool_id: 'tool:m', canonical_tool_name: 'm' }),
        makeDeclaration({ section_id: 'tools', tool_id: 'tool:a', canonical_tool_name: 'a' }),
        makeDeclaration({ section_id: 'tools2', tool_id: 'tool:a2', canonical_tool_name: 'a2' }),
      ]),
    );

    expect(manifest.records.map((r) => `${r.section_id}/${r.tool_id}`)).toEqual([
      'tools/tool:a',
      'tools/tool:m',
      'tools2/tool:a2',
      'tools2/tool:z',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty & no-tools
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolReferenceManifest / empty declarations', () => {
  it('empty declarations produce an empty manifest (no-tools case)', () => {
    // spec §9.5 rule 6: no-tools request 的 manifest 必须为空
    const manifest = buildToolReferenceManifest(makeInput([]));

    expect(manifest.records).toEqual([]);
    // 即使为空,manifest_id 与 protocol_version 仍要稳定可寻址。
    expect(manifest.reference_manifest_id).toMatch(/^manifest:[a-f0-9]{16}$/);
    expect(manifest.reference_manifest_protocol_version).toBe(
      REFERENCE_MANIFEST_PROTOCOL_VERSION,
    );
    expect(manifest.compiled_prompt_snapshot_id).toBe('compiled:abc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Immutability
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolReferenceManifest / immutability', () => {
  it('manifest is frozen (records array and records are deep-frozen)', () => {
    const manifest = buildToolReferenceManifest(
      makeInput([makeDeclaration()]),
    );

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.records)).toBe(true);
    expect(Object.isFrozen(manifest.records[0])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error semantics (spec §9.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolReferenceManifest / error semantics', () => {
  it('rejects missing compiled_prompt_snapshot_id', () => {
    expect(() =>
      buildToolReferenceManifest({
        compiled_prompt_snapshot_id: '',
        declarations: [makeDeclaration()],
      }),
    ).toThrow(/compiled_prompt_snapshot_id/);
  });

  it('rejects missing evidence ref', () => {
    // spec §9.6: manual identity 缺失或版本不匹配 → invalid
    expect(() =>
      buildToolReferenceManifest(
        makeInput([makeDeclaration({ evidence_ref: '' })]),
      ),
    ).toThrow(/reference\.missing_evidence|evidence_ref/);
  });

  it('rejects missing tool_id', () => {
    expect(() =>
      buildToolReferenceManifest(
        makeInput([makeDeclaration({ tool_id: '' })]),
      ),
    ).toThrow(/tool_id/);
  });

  it('rejects missing canonical_tool_name', () => {
    expect(() =>
      buildToolReferenceManifest(
        makeInput([makeDeclaration({ canonical_tool_name: '' })]),
      ),
    ).toThrow(/canonical_tool_name/);
  });

  it('rejects missing section_id', () => {
    expect(() =>
      buildToolReferenceManifest(
        makeInput([makeDeclaration({ section_id: '' })]),
      ),
    ).toThrow(/section_id/);
  });

  it('rejects unknown source_kind (closed domain)', () => {
    // spec §9.6: deterministic scan 不猜测自然语言;source_kind 必须在封闭域内
    expect(() =>
      buildToolReferenceManifest(
        // 类型断言绕过编译期检查,模拟运行时脏数据
        makeInput([
          makeDeclaration({ source_kind: 'model_guess' as ToolReferenceDeclaration['source_kind'] }),
        ]),
      ),
    ).toThrow(/reference\.invalid_source_kind|source_kind/);
  });

  it('rejects duplicate tool_id within the same section', () => {
    // spec §9.5 rule 1 + §9.6: 同一 tool_id 在同一 section 重复 → invalid
    expect(() =>
      buildToolReferenceManifest(
        makeInput([
          makeDeclaration({ tool_id: 'tool:dup', canonical_tool_name: 'dup' }),
          makeDeclaration({ tool_id: 'tool:dup', canonical_tool_name: 'dup' }),
        ]),
      ),
    ).toThrow(/reference\.duplicate_tool_id/);
  });

  it('rejects one canonical name mapping to multiple tool ids (canonical drift)', () => {
    // spec §9.6: 一个 name 对应多个 tool ID → invalid
    expect(() =>
      buildToolReferenceManifest(
        makeInput([
          makeDeclaration({
            section_id: 's1',
            tool_id: 'tool:run_bash',
            canonical_tool_name: 'shell',
          }),
          makeDeclaration({
            section_id: 's2',
            tool_id: 'tool:execute_cmd',
            canonical_tool_name: 'shell',
          }),
        ]),
      ),
    ).toThrow(/reference\.canonical_ambiguous/);
  });
});
