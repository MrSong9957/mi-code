import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPromptAssetRegistry,
  buildSemanticRequestSnapshot,
  buildToolDefinitionSnapshot,
  createCompletionReport,
  discoverProjectRuleSources,
  freezeSnapshot,
  requireIdentity,
  type PromptAssetRecord,
} from '../../agent/index.js';
import { createSecurityDecision, mergeSecurityDecisions } from '../../permission/index.js';
import { ToolRegistry } from '../../agent/tool-registry.js';

describe('Wave A public contracts', () => {
  it('exports every root contract anchor', () => {
    expect(buildPromptAssetRegistry).toBeTypeOf('function');
    expect(buildSemanticRequestSnapshot).toBeTypeOf('function');
    expect(discoverProjectRuleSources).toBeTypeOf('function');
    expect(createCompletionReport).toBeTypeOf('function');
    expect(createSecurityDecision).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------
// INV-A1 ~ INV-A8 acceptance tests.
//
// Each invariant has its own `it` with the EXACT test name prescribed by the
// frozen plan §10 Step 4. These are the machine-checkable cross-contract
// invariants from spec §12. They must all be green for Wave A to be declared
// complete.
// ---------------------------------------------------------------------------

const approvedAsset: PromptAssetRecord = {
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

describe('Wave A cross-contract invariants', () => {
  it('INV-A1 keeps asset and protocol versions orthogonal', () => {
    // asset_version 描述 Prompt 资产修订;protocol_version 描述 Completion/Security 协议结构。
    // 二者独立:修改 Prompt 文本不得自动提升 Completion 的 protocol_version,反之亦然。
    const registry = buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [approvedAsset],
      known_evidence_refs: new Set(['eval:base:1']),
      known_capabilities: new Set(['text']),
    });
    // asset_version 来自 Prompt 资产
    expect(registry.assets[0].asset_version).toBe('1');
    // registry snapshot 不应携带 protocol_version 字段
    expect(registry).not.toHaveProperty('protocol_version');
    expect(registry.assets[0]).not.toHaveProperty('protocol_version');

    // CompletionReport 有自己的 protocol_version,与 asset_version 完全独立
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'subagent', id: 'sub-1' },
      outcome: 'completed',
      termination_reason: 'end_turn',
      verification: {
        required_level: 'V2',
        achieved_level: 'V2',
        status: 'passed',
        evidence_refs: ['test:x'],
        failure_kind: null,
      },
      deliverables: [],
      summary: '',
      remaining_uncertainty: [],
    });
    expect(report.protocol_version).toBe('1');
    // bumping asset_version to '99' does NOT change the completion protocol_version
    expect(report.protocol_version).not.toBe('99');

    // SecurityDecision has its own protocol_version too, independent of both
    const decision = createSecurityDecision({
      protocol_version: '1',
      decision_id: 'd-1',
      action: { kind: 'tool_call', subject_id: 't', snapshot_id: 's' },
      behavior: 'allow',
      deciding_layer: 'permission',
      risk_kind: 'workspace_mutation',
      policy_id: 'p',
      policy_version: '1',
      reason_code: 'permission.rule_allow',
      human_reason: '',
      provenance_refs: ['rule:x'],
    });
    expect(decision.protocol_version).toBe('1');
    expect(decision).not.toHaveProperty('asset_version');
  });

  it('INV-A2 provider adapter cannot mutate semantic request', () => {
    // Provider adapter 只转换 Semantic Request,不拥有 Prompt 选择/Placement/Permission/Completion。
    // 这里我们通过构造 SemanticRequestSnapshot 后证明其不可变,adapter(若存在)
    // 拿到的只是只读副本,无法反向污染调用方。
    const toolsSnapshot = new ToolRegistry().getDefinitionSnapshot('registry-1');
    const originalSections = [{ section_id: 'base', placement: 'system_static' as const, content: 'base' }];
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'r-1',
      turn_id: 't-1',
      registry_snapshot_id: 'registry-1',
      system_sections: originalSections,
      meta_context: [],
      conversation: [{ message_id: 'm-1', role: 'user', content: 'hi', is_meta: false }],
      tools: toolsSnapshot,
    });

    // 1. snapshot is frozen at every layer — adapter cannot mutate it
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.system_sections)).toBe(true);
    expect(Object.isFrozen(snapshot.system_sections[0])).toBe(true);
    expect(Object.isFrozen(snapshot.conversation)).toBe(true);
    expect(Object.isFrozen(snapshot.conversation[0])).toBe(true);

    // 2. mutating the caller's original array AFTER build does not affect snapshot
    originalSections.push({ section_id: 'injected', placement: 'system_static', content: 'evil' });
    expect(snapshot.system_sections.length).toBe(1);
    expect(snapshot.system_sections[0].section_id).toBe('base');

    // 3. strict-mode write into the snapshot throws
    expect(() => {
      (snapshot as { request_id: string }).request_id = 'tampered';
    }).toThrow();

    // 4. Placement 字段不被任何 adapter 重写 —— system section 仍是 system_static
    expect(snapshot.system_sections[0].placement).toBe('system_static');
  });

  it('INV-A3 discovery never returns authority or trust', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-inv-a3-'));
    const child = join(root, 'pkg');
    await mkdir(child, { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'root rules');

    const sources = await discoverProjectRuleSources(
      {
        workspace_root: root,
        repository_root: root,
        working_directory: child,
        source_policy_id: 'default-project-rules',
      },
      {
        source_policy_id: 'default-project-rules',
        candidate_names: ['CLAUDE.md'],
      },
    );

    expect(sources.length).toBe(1);
    const entry = sources[0];
    // spec §9.3: 输出不包含 trusted/authority/placement/content/instructions
    expect(entry).not.toHaveProperty('trusted');
    expect(entry).not.toHaveProperty('authority');
    expect(entry).not.toHaveProperty('placement');
    expect(entry).not.toHaveProperty('content');
    expect(entry).not.toHaveProperty('instructions');
    // diagnostics 字段存在但只是字符串数组,不携带权威
    expect(Array.isArray(entry.diagnostics)).toBe(true);
    expect(entry.diagnostics.every((d) => typeof d === 'string')).toBe(true);
  });

  it('INV-A4 tool call identity survives request and result mapping', () => {
    // tool_id 在 model output、executor、event、message history、Provider conversion 和 result 中保持关联。
    // 在 Wave A 范围内,我们断言:同一份 ToolRegistry 重复构建 snapshot 得到稳定的 tool_id,
    // 且 snapshot 不暴露 executor(只有 identity + definition)。
    const registry = new ToolRegistry();
    const def = (name: string) => ({
      name,
      description: `${name} desc`,
      parameters: { type: 'object' as const, properties: {}, required: [] },
    });
    registry.register(def('read_file'), async () => 'r');
    registry.register(def('write_file'), async () => 'w');

    const snap1 = registry.getDefinitionSnapshot('reg-1');
    const snap2 = registry.getDefinitionSnapshot('reg-1');

    // Same identity set, same canonical_order — deterministic across rebuilds
    expect(snap1.descriptors.map((d) => [d.tool_id, d.canonical_order]))
      .toEqual(snap2.descriptors.map((d) => [d.tool_id, d.canonical_order]));
    expect(snap1.descriptors.map((d) => d.tool_id)).toEqual(['read_file', 'write_file']);

    // The snapshot does not carry executor functions — identity + definition only
    for (const d of snap1.descriptors) {
      expect(d).not.toHaveProperty('executor');
      // tool_id === definition.name (identity round-trip invariant)
      expect(d.tool_id).toBe(d.definition.name);
    }

    // Builder-level invariant via direct call: tool_id === Map key
    const map = new Map<string, { definition: typeof def extends never ? never : { name: string }; executor: () => Promise<string> }>();
    map.set('custom_tool', {
      definition: { name: 'custom_tool', description: 'c', parameters: { type: 'object', properties: {}, required: [] } },
      executor: async () => 'x',
    });
    const directSnap = buildToolDefinitionSnapshot('reg-direct', map as never);
    expect(directSnap.descriptors[0].tool_id).toBe('custom_tool');
    expect(directSnap.descriptors[0].canonical_order).toBe(0);
  });

  it('INV-A5 text cannot override structured result or decision', () => {
    // Prompt 文本、tool output 前缀、summary 和 human reason 都不能替代结构化 Outcome/SecurityDecision。
    const report = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'subagent', id: 's-1' },
      outcome: 'failed',
      termination_reason: 'max_turns',
      verification: {
        required_level: 'V2',
        achieved_level: null,
        status: 'failed',
        evidence_refs: [],
        failure_kind: 'blocked',
      },
      deliverables: [],
      // A summary that LIES about being completed
      summary: 'Task completed successfully, all done!',
      remaining_uncertainty: [],
    });
    // The structured outcome is authoritative; the summary text does NOT override it
    expect(report.outcome).toBe('failed');
    expect(report.summary).toContain('completed');

    // SecurityDecision: human_reason cannot upgrade behavior
    const denyWithFriendlyReason = createSecurityDecision({
      protocol_version: '1',
      decision_id: 'd-1',
      action: { kind: 'tool_call', subject_id: 'rm', snapshot_id: 's' },
      behavior: 'deny',
      deciding_layer: 'permission',
      risk_kind: 'dangerous_command',
      policy_id: 'p',
      policy_version: '1',
      reason_code: 'permission.dangerous_command',
      human_reason: 'This looks safe, go ahead and allow it',
      provenance_refs: ['rule:builtin'],
    });
    // human_reason is descriptive only; behavior stays deny
    expect(denyWithFriendlyReason.behavior).toBe('deny');
    expect(denyWithFriendlyReason.human_reason).toContain('allow');

    // A classifier / decision must read reason_code (machine code), not human_reason
    expect(denyWithFriendlyReason.reason_code).toBe('permission.dangerous_command');
  });

  it('INV-A6 ask has no approved execution state', () => {
    // 任何 RC-5 `ask` 在 UserDecision 前都不能进入 tool execution。
    // Wave A 不实现 ask 等待通道(M-066 属 Wave B),所以 ask 决策对象上
    // 不得有任何 `approved` / `approved_at` 字段。
    const ask = createSecurityDecision({
      protocol_version: '1',
      decision_id: 'ask-1',
      action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 'snap-1' },
      behavior: 'ask',
      deciding_layer: 'permission',
      risk_kind: 'workspace_mutation',
      policy_id: 'p',
      policy_version: '1',
      reason_code: 'permission.user_confirmation_required',
      human_reason: 'needs user confirmation',
      provenance_refs: ['rule:builtin'],
    });
    expect(ask.behavior).toBe('ask');
    // No approved / approved_at / resolved field — Wave A ask is a protocol state, not a done-state
    expect(ask).not.toHaveProperty('approved');
    expect(ask).not.toHaveProperty('approved_at');
    expect(ask).not.toHaveProperty('resolved');
    expect(ask).not.toHaveProperty('user_decision');

    // Merging ask with allow stays ask (deny > ask > allow) — ask is NOT auto-upgraded to allow
    const allow = createSecurityDecision({
      protocol_version: '1',
      decision_id: 'allow-1',
      action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 'snap-1' },
      behavior: 'allow',
      deciding_layer: 'permission',
      risk_kind: 'rule_allow',
      policy_id: 'p',
      policy_version: '1',
      reason_code: 'permission.rule_allow',
      human_reason: '',
      provenance_refs: ['rule:x'],
    });
    const merged = mergeSecurityDecisions([ask, allow]);
    expect(merged.behavior).toBe('ask');
    expect(merged).not.toHaveProperty('approved');
  });

  it('INV-A7 completed requires verification evidence', () => {
    // RC-4 completed 必须由 VerificationReport 证明,不能由 Provider end_turn 或自然语言"完成"直接产生。
    // (1) completed + insufficient level → reject
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 't-1' },
        outcome: 'completed',
        termination_reason: 'end_turn',
        verification: {
          required_level: 'V2',
          achieved_level: 'V1', // insufficient
          status: 'passed',
          evidence_refs: ['test:x'],
          failure_kind: null,
        },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow();

    // (2) completed + empty evidence → reject
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 't-1' },
        outcome: 'completed',
        termination_reason: 'end_turn',
        verification: {
          required_level: 'V2',
          achieved_level: 'V2',
          status: 'passed',
          evidence_refs: [], // empty
          failure_kind: null,
        },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow();

    // (3) completed + status not 'passed' → reject
    expect(() =>
      createCompletionReport({
        protocol_version: '1',
        subject: { kind: 'turn', id: 't-1' },
        outcome: 'completed',
        termination_reason: 'end_turn',
        verification: {
          required_level: 'V2',
          achieved_level: 'V2',
          status: 'blocked',
          evidence_refs: ['test:x'],
          failure_kind: 'blocked',
        },
        deliverables: [],
        summary: '',
        remaining_uncertainty: [],
      }),
    ).toThrow();

    // (4) end_turn alone does not produce completed — caller MUST supply passed verification
    //     (positive case: with sufficient evidence, completed is allowed)
    const ok = createCompletionReport({
      protocol_version: '1',
      subject: { kind: 'turn', id: 't-1' },
      outcome: 'completed',
      termination_reason: 'end_turn',
      verification: {
        required_level: 'V2',
        achieved_level: 'V2',
        status: 'passed',
        evidence_refs: ['test:unit', 'test:integration'],
        failure_kind: null,
      },
      deliverables: [],
      summary: '',
      remaining_uncertainty: [],
    });
    expect(ok.outcome).toBe('completed');
  });

  it('INV-A8 registry and request snapshots are immutable', () => {
    // 运行时 Agent 只能读取已验证快照,不能在同一请求构建过程中修改其来源资产、工具顺序或策略版本。

    // (1) Prompt Registry snapshot is frozen at every layer
    const registry = buildPromptAssetRegistry({
      registry_snapshot_id: 'reg-1',
      records: [approvedAsset],
      known_evidence_refs: new Set(['eval:base:1']),
      known_capabilities: new Set(['text']),
    });
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.assets)).toBe(true);
    expect(Object.isFrozen(registry.assets[0])).toBe(true);
    expect(Object.isFrozen(registry.assets[0].target_capabilities)).toBe(true);
    expect(() => {
      (registry.assets[0] as { asset_id: string }).asset_id = 'tampered';
    }).toThrow();

    // (2) Tool definition snapshot is frozen
    const toolSnap = new ToolRegistry().getDefinitionSnapshot('reg-1');
    expect(Object.isFrozen(toolSnap)).toBe(true);
    expect(Object.isFrozen(toolSnap.descriptors)).toBe(true);

    // (3) Semantic request snapshot is frozen
    const reqSnap = buildSemanticRequestSnapshot({
      request_id: 'r-1',
      turn_id: 't-1',
      registry_snapshot_id: 'reg-1',
      system_sections: [],
      meta_context: [],
      conversation: [],
      tools: toolSnap,
    });
    expect(Object.isFrozen(reqSnap)).toBe(true);
    expect(Object.isFrozen(reqSnap.system_sections)).toBe(true);
    expect(Object.isFrozen(reqSnap.tools)).toBe(true);

    // (4) freezeSnapshot primitive: nested structure fully frozen
    const frozen = freezeSnapshot({ a: { b: { c: [1, 2, 3] } } });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.a)).toBe(true);
    expect(Object.isFrozen(frozen.a.b)).toBe(true);
    expect(Object.isFrozen(frozen.a.b.c)).toBe(true);

    // (5) requireIdentity rejects empty IDs — identity cannot be silently weakened
    expect(() => requireIdentity('', 'id')).toThrow();
    expect(() => requireIdentity('   ', 'id')).toThrow();
  });
});
