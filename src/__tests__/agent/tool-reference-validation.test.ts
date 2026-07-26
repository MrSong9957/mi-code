// src/__tests__/agent/tool-reference-validation.test.ts
// Wave D Task 9 (M-028 / DRC-3): Final Request Reference Gate — 核心校验器.
//
// 物理本质:validateToolReferences 把"已经编译好的 Prompt 工具引用 manifest"对齐
// 到"本次 request 的 final tool view",确认 Prompt 里出现的每个工具引用在最终
// 可见工具集合里仍然存在、canonical name 没漂移。
//
// 关键不变量(spec §9.5 / §9.6 / INV-D9):
//   - 只看 final tool view,绝不用 base Registry 代替(spec §9.3 末段 + INV-D9);
//   - reference 指向不可见工具 → invalid(orphan_reference_ids 记录,§9.6);
//   - canonical name 漂移 → invalid(§9.6);
//   - snapshot 不一致(三类)→ invalid(§9.5 rule 7);
//   - no-tools 但 manifest 非空 → invalid(§9.5 rule 6);
//   - 不接入 streaming-query —— 本测试只覆盖纯函数行为;
//   - 同一不可变输入 → 同一 validation_id(确定性,§9.5 rule 12);
//   - 输出整体深冻结;不修改输入。

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildToolReferenceManifest,
  REFERENCE_MANIFEST_PROTOCOL_VERSION,
  validateToolReferences,
  TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION,
  type ToolReferenceDeclaration,
  type ToolReferenceValidationInput,
} from '../../agent/tools/reference-validator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_SNAPSHOT_ID = 'request:snap-1';
const COMPILED_PROMPT_SNAPSHOT_ID = 'compiled:snap-1';
const FINAL_TOOL_VIEW_SNAPSHOT_ID = 'tv:snap-1';

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

/** 一份"所有引用都在 final view 内、canonical 一致"的合法 input。 */
function makeValidInput(overrides: Partial<ToolReferenceValidationInput> = {}): ToolReferenceValidationInput {
  const manifest = buildToolReferenceManifest({
    compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
    declarations: [
      makeDeclaration({ tool_id: 'tool:run_bash', canonical_tool_name: 'run_bash' }),
      makeDeclaration({
        section_id: 'tools',
        tool_id: 'tool:read_file',
        canonical_tool_name: 'read_file',
        evidence_ref: 'asset:read@1',
      }),
    ],
  });

  const included_tool_ids: Set<string> = new Set(['tool:run_bash', 'tool:read_file']);
  const tool_name_to_id: Map<string, string> = new Map([
    ['run_bash', 'tool:run_bash'],
    ['read_file', 'tool:read_file'],
  ]);

  return {
    validation_protocol_version: TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION,
    request_snapshot_id: REQUEST_SNAPSHOT_ID,
    compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
    final_tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
    reference_manifest_id: manifest.reference_manifest_id,
    manifest,
    final_tool_view: {
      tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
      included_tool_ids,
      tool_name_to_id,
    },
    tool_policy_projection_ids: ['proj:run_bash@1', 'proj:read_file@1'],
    no_tool_validation_id: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToolReferences / happy path', () => {
  it('validates when all references are visible and canonical names match', () => {
    const result = validateToolReferences(makeValidInput());

    expect(result.status).toBe('valid');
    expect(result.diagnostics).toEqual([]);
    expect(result.orphan_reference_ids).toEqual([]);
    expect(result.undeclared_rendered_reference_refs).toEqual([]);
    expect(result.checked_records).toHaveLength(2);
    for (const rec of result.checked_records) {
      expect(rec.visible_in_final_view).toBe(true);
      expect(rec.canonical_name_matches).toBe(true);
      expect(rec.manual_identity_resolved).toBe(true);
      expect(rec.policy_projection_matches).toBe(true);
    }
  });

  it('echoes snapshot identities into the result', () => {
    const result = validateToolReferences(makeValidInput());

    expect(result.validation_protocol_version).toBe(
      TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION,
    );
    expect(result.request_snapshot_id).toBe(REQUEST_SNAPSHOT_ID);
    expect(result.compiled_prompt_snapshot_id).toBe(COMPILED_PROMPT_SNAPSHOT_ID);
    expect(result.final_tool_view_snapshot_id).toBe(FINAL_TOOL_VIEW_SNAPSHOT_ID);
    expect(result.reference_manifest_id).toBe(
      makeValidInput().reference_manifest_id,
    );
  });

  it('reserves manual_identity and policy_projection as pass-through hooks (true)', () => {
    // 这两个字段在 T9 是预留接口(永远 true);Wave E 接入时再实现。
    const result = validateToolReferences(makeValidInput());
    expect(
      result.checked_records.every((r) => r.manual_identity_resolved === true),
    ).toBe(true);
    expect(
      result.checked_records.every((r) => r.policy_projection_matches === true),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan detection (spec §9.5 rule 2 + rule 5, §9.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToolReferences / orphan detection', () => {
  it('rejects reference to a tool excluded by final view (orphan)', () => {
    // final view 把 run_bash 移除了 —— manifest 里却仍然引用它。
    const included = new Set<string>(['tool:read_file']);
    const nameToId = new Map<string, string>([['read_file', 'tool:read_file']]);
    const input = makeValidInput({
      final_tool_view: {
        tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
        included_tool_ids: included,
        tool_name_to_id: nameToId,
      },
    });

    const result = validateToolReferences(input);

    expect(result.status).toBe('invalid');
    expect(result.orphan_reference_ids).toContain('ref:run_bash');
    expect(result.orphan_reference_ids).not.toContain('ref:read_file');
    const orphan = result.checked_records.find(
      (r) => r.reference_id === 'ref:run_bash',
    );
    expect(orphan?.visible_in_final_view).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical name drift (spec §9.5 rule 3, §9.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToolReferences / canonical name drift', () => {
  it('rejects when canonical name in view resolves to a different tool_id', () => {
    // manifest 里 canonical 'run_bash' → tool:run_bash
    // 但 final view 把 'run_bash' 这个名字重绑到了 tool:execute_shell(漂移)。
    const input = makeValidInput({
      final_tool_view: {
        tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
        included_tool_ids: new Set(['tool:run_bash', 'tool:read_file', 'tool:execute_shell']),
        tool_name_to_id: new Map<string, string>([
          ['run_bash', 'tool:execute_shell'],
          ['read_file', 'tool:read_file'],
        ]),
      },
    });

    const result = validateToolReferences(input);

    expect(result.status).toBe('invalid');
    const drift = result.checked_records.find(
      (r) => r.reference_id === 'ref:run_bash',
    );
    expect(drift?.canonical_name_matches).toBe(false);
    // canonical 漂移不应被错误地记成 orphan
    expect(result.diagnostics.some((d) => /canonical/.test(d))).toBe(true);
  });

  it('rejects when canonical name is absent from view name map', () => {
    const input = makeValidInput({
      final_tool_view: {
        tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
        included_tool_ids: new Set(['tool:run_bash', 'tool:read_file']),
        tool_name_to_id: new Map<string, string>([
          // 'run_bash' 名字完全没登记
          ['read_file', 'tool:read_file'],
        ]),
      },
    });

    const result = validateToolReferences(input);
    expect(result.status).toBe('invalid');
    const rec = result.checked_records.find(
      (r) => r.reference_id === 'ref:run_bash',
    );
    expect(rec?.canonical_name_matches).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot consistency (spec §9.5 rule 7)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToolReferences / snapshot consistency', () => {
  it('rejects when final_tool_view.tool_view_snapshot_id differs from declared snapshot id', () => {
    const input = makeValidInput({
      final_tool_view: {
        tool_view_snapshot_id: 'tv:different',
        included_tool_ids: new Set(['tool:run_bash', 'tool:read_file']),
        tool_name_to_id: new Map<string, string>([
          ['run_bash', 'tool:run_bash'],
          ['read_file', 'tool:read_file'],
        ]),
      },
    });

    const result = validateToolReferences(input);
    expect(result.status).toBe('invalid');
    expect(
      result.diagnostics.some((d) => /tool_view_snapshot_id/.test(d)),
    ).toBe(true);
  });

  it('rejects when manifest.compiled_prompt_snapshot_id differs', () => {
    // 构造一份 manifest 用别的 compiled snapshot id
    const manifest = buildToolReferenceManifest({
      compiled_prompt_snapshot_id: 'compiled:other',
      declarations: [
        makeDeclaration({ tool_id: 'tool:run_bash', canonical_tool_name: 'run_bash' }),
        makeDeclaration({
          section_id: 'tools',
          tool_id: 'tool:read_file',
          canonical_tool_name: 'read_file',
          evidence_ref: 'asset:read@1',
        }),
      ],
    });
    const input = makeValidInput({
      compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
      manifest,
      reference_manifest_id: manifest.reference_manifest_id,
    });

    const result = validateToolReferences(input);
    expect(result.status).toBe('invalid');
    expect(
      result.diagnostics.some((d) => /compiled_prompt_snapshot_id/.test(d)),
    ).toBe(true);
  });

  it('rejects when declared reference_manifest_id differs from manifest.reference_manifest_id', () => {
    const input = makeValidInput({
      reference_manifest_id: 'manifest:deadbeefdeadbeef',
    });

    const result = validateToolReferences(input);
    expect(result.status).toBe('invalid');
    expect(
      result.diagnostics.some((d) => /reference_manifest_id/.test(d)),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity gates
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToolReferences / identity gates', () => {
  it.each([
    ['request_snapshot_id', { request_snapshot_id: '' }],
    ['compiled_prompt_snapshot_id', { compiled_prompt_snapshot_id: '' }],
    ['final_tool_view_snapshot_id', { final_tool_view_snapshot_id: '' }],
    ['reference_manifest_id', { reference_manifest_id: '' }],
  ] as const)(
    'throws on empty %s identity field',
    (_name, override) => {
      expect(() =>
        validateToolReferences(makeValidInput(override as Partial<ToolReferenceValidationInput>)),
      ).toThrow(/must be a non-empty string/);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// No-tools special case (spec §9.5 rule 6)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToolReferences / no-tools special case', () => {
  it('accepts no-tools request with empty manifest and empty final view', () => {
    const emptyManifest = buildToolReferenceManifest({
      compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
      declarations: [],
    });
    const input: ToolReferenceValidationInput = {
      validation_protocol_version: TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION,
      request_snapshot_id: REQUEST_SNAPSHOT_ID,
      compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
      final_tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
      reference_manifest_id: emptyManifest.reference_manifest_id,
      manifest: emptyManifest,
      final_tool_view: {
        tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
        included_tool_ids: new Set<string>(),
        tool_name_to_id: new Map<string, string>(),
      },
      tool_policy_projection_ids: [],
      no_tool_validation_id: 'notool:abc123',
    };

    const result = validateToolReferences(input);
    expect(result.status).toBe('valid');
    expect(result.checked_records).toEqual([]);
    expect(result.orphan_reference_ids).toEqual([]);
  });

  it('rejects no-tools with non-empty manifest (protocol error)', () => {
    const manifest = buildToolReferenceManifest({
      compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
      declarations: [
        makeDeclaration({ tool_id: 'tool:run_bash', canonical_tool_name: 'run_bash' }),
      ],
    });
    const input: ToolReferenceValidationInput = {
      validation_protocol_version: TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION,
      request_snapshot_id: REQUEST_SNAPSHOT_ID,
      compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
      final_tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
      reference_manifest_id: manifest.reference_manifest_id,
      manifest,
      final_tool_view: {
        tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
        included_tool_ids: new Set<string>(),
        tool_name_to_id: new Map<string, string>(),
      },
      tool_policy_projection_ids: [],
      no_tool_validation_id: 'notool:abc123',
    };

    const result = validateToolReferences(input);
    expect(result.status).toBe('invalid');
    expect(result.diagnostics.some((d) => /no.tool/.test(d))).toBe(true);
  });

  it('rejects no-tools when final view is non-empty even if manifest is empty', () => {
    const emptyManifest = buildToolReferenceManifest({
      compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
      declarations: [],
    });
    const input: ToolReferenceValidationInput = {
      validation_protocol_version: TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION,
      request_snapshot_id: REQUEST_SNAPSHOT_ID,
      compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
      final_tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
      reference_manifest_id: emptyManifest.reference_manifest_id,
      manifest: emptyManifest,
      final_tool_view: {
        tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
        included_tool_ids: new Set<string>(['tool:something']),
        tool_name_to_id: new Map<string, string>([['something', 'tool:something']]),
      },
      tool_policy_projection_ids: [],
      no_tool_validation_id: 'notool:abc123',
    };

    const result = validateToolReferences(input);
    expect(result.status).toBe('invalid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-D9 — must validate final view, not base registry
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToolReferences / INV-D9 final view authority', () => {
  it('treats a tool missing from final view as orphan even if id is well-formed', () => {
    // 即使 tool_id 看起来"合法",只要不在 final view 的 included 集合里就是 orphan。
    // 这防止调用方拿 base Registry 来"宽进"。
    const input = makeValidInput({
      final_tool_view: {
        tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
        included_tool_ids: new Set<string>(['tool:read_file']), // 缺 run_bash
        tool_name_to_id: new Map<string, string>([
          ['run_bash', 'tool:run_bash'], // name 仍可解析,但工具不可见
          ['read_file', 'tool:read_file'],
        ]),
      },
    });

    const result = validateToolReferences(input);
    expect(result.status).toBe('invalid');
    expect(result.orphan_reference_ids).toContain('ref:run_bash');
    // canonical_name_matches 仍可能为 true,但 visible=false 已经独立判 invalid
    const rec = result.checked_records.find(
      (r) => r.reference_id === 'ref:run_bash',
    );
    expect(rec?.visible_in_final_view).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism (spec §9.5 rule 12) + immutability
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToolReferences / determinism & immutability', () => {
  it('produces deterministic validation_id for the same logical input', () => {
    const a = validateToolReferences(makeValidInput());
    const b = validateToolReferences(makeValidInput());
    expect(a.validation_id).toBe(b.validation_id);
    expect(a).toEqual(b);
  });

  it('validation_id has shape valid:<16 hex chars>', () => {
    const result = validateToolReferences(makeValidInput());
    expect(result.validation_id).toMatch(/^valid:[a-f0-9]{16}$/);
  });

  it('changes validation_id when input changes (canonical input reflected in hash)', () => {
    const a = validateToolReferences(makeValidInput());

    // 引入一个新工具到 manifest 和 final view
    const manifest = buildToolReferenceManifest({
      compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
      declarations: [
        makeDeclaration({ tool_id: 'tool:run_bash', canonical_tool_name: 'run_bash' }),
        makeDeclaration({
          section_id: 'tools',
          tool_id: 'tool:read_file',
          canonical_tool_name: 'read_file',
          evidence_ref: 'asset:read@1',
        }),
        makeDeclaration({
          section_id: 'tools',
          tool_id: 'tool:write_file',
          canonical_tool_name: 'write_file',
          evidence_ref: 'asset:write@1',
        }),
      ],
    });
    const b = validateToolReferences(
      makeValidInput({
        manifest,
        reference_manifest_id: manifest.reference_manifest_id,
        final_tool_view: {
          tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
          included_tool_ids: new Set([
            'tool:run_bash',
            'tool:read_file',
            'tool:write_file',
          ]),
          tool_name_to_id: new Map<string, string>([
            ['run_bash', 'tool:run_bash'],
            ['read_file', 'tool:read_file'],
            ['write_file', 'tool:write_file'],
          ]),
        },
      }),
    );

    expect(b.validation_id).not.toBe(a.validation_id);
  });

  it('result is deeply frozen', () => {
    const result = validateToolReferences(makeValidInput());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.checked_records)).toBe(true);
    for (const rec of result.checked_records) {
      expect(Object.isFrozen(rec)).toBe(true);
    }
    expect(Object.isFrozen(result.orphan_reference_ids)).toBe(true);
    expect(Object.isFrozen(result.undeclared_rendered_reference_refs)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  it('does not mutate the input manifest or final_tool_view collections', () => {
    const input = makeValidInput();
    const manifestRecordsLengthBefore = input.manifest.records.length;
    const includedSizeBefore = input.final_tool_view.included_tool_ids.size;
    const nameMapSizeBefore = input.final_tool_view.tool_name_to_id.size;

    validateToolReferences(input);

    expect(input.manifest.records.length).toBe(manifestRecordsLengthBefore);
    expect(input.final_tool_view.included_tool_ids.size).toBe(includedSizeBefore);
    expect(input.final_tool_view.tool_name_to_id.size).toBe(nameMapSizeBefore);
  });

  it('validation_protocol_version is exposed as a constant equal to "1"', () => {
    expect(TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION).toBe('1');
    expect(REFERENCE_MANIFEST_PROTOCOL_VERSION).toBe('1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-checks against sha256 canonical input (deterministic id derivation)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToolReferences / validation_id derivation', () => {
  it('validation_id is `valid:` + first 16 hex chars of sha256 over canonical input', () => {
    const input = makeValidInput();
    const result = validateToolReferences(input);

    // 复现实现里的 canonical hash 输入(协议版本 + 5 个 snapshot id +
    // 已排序 checked_records 派生字段)以确认派生规则稳定。
    const canonicalLines = [
      `protocol=${TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION}`,
      `request_snapshot_id=${input.request_snapshot_id}`,
      `compiled_prompt_snapshot_id=${input.compiled_prompt_snapshot_id}`,
      `final_tool_view_snapshot_id=${input.final_tool_view_snapshot_id}`,
      `reference_manifest_id=${input.reference_manifest_id}`,
    ];
    const expectedHash = createHash('sha256')
      .update(canonicalLines.join('\n'))
      .digest('hex');
    expect(result.validation_id).toBe(`valid:${expectedHash.slice(0, 16)}`);
  });
});
