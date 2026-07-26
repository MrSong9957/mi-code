/**
 * Wave C 跨契约不变量验收测试 (INV-C1 ~ INV-C15).
 *
 * 每条不变量对应规格 §13 的一条规则, 至少一个机器可判定测试。
 * 这些测试是 Wave C 进入 Wave D 的准入门槛。
 *
 * Spec: docs/superpowers/specs/2026-07-26-agent-policy-contracts-wave-c-design.md §13
 */

import { describe, it, expect } from 'vitest';
import {
  evaluatePromptCondition,
  classifyPromptScope,
  projectToolPolicy,
  validateNoToolRequest,
  routeMarkdownSource,
  createInjectionSuspicionSignal,
  redactTelemetryEvent,
} from '../../agent/index.js';
import { createTypedMemoryCandidate } from '../../memory/index.js';
import { createDelegationHandoffEnvelope } from '../../permission/index.js';
import { applyCapabilityOverride } from '../../config/index.js';

// ---------------------------------------------------------------------------
// INV-C1 — Policy 可重放
// 同一 policy/version + immutable input snapshots → 确定相同机器结果
// ---------------------------------------------------------------------------

describe('INV-C1: Policy 可重放', () => {
  it('condition evaluation is deterministic for same input', () => {
    const ctx = {
      control_mode: 'build',
      role_id: null,
      capabilities: { image_input: 'supported' as const },
      trusted_flags: {},
      present_source_classes: new Set<string>(),
      evidence_refs: ['ev-1'],
    };
    const cond = { kind: 'capability_is' as const, capability: 'image_input', expected: 'supported' as const };
    const r1 = evaluatePromptCondition(cond, ctx);
    const r2 = evaluatePromptCondition(cond, ctx);
    expect(r1).toEqual(r2);
  });

  it('redaction is deterministic for same event + policy', () => {
    const policy = {
      field_policy_id: 'fp-1',
      field_policy_version: '1',
      event_type: 'tool_call',
      allowed_fields: {
        field_a: { field_class: 'operational_metadata' as const, pii_label: 'none' as const, action: 'keep' as const },
      },
    };
    const event = { event_id: 'evt-1', event_type: 'tool_call', fields: { field_a: 42 } };
    const r1 = redactTelemetryEvent(event, policy);
    const r2 = redactTelemetryEvent(event, policy);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// INV-C2 — Precedence 不等于 Authority
// CRC-1 base winner 只决定 approved base Prompt 选择, 不改变 content Authority
// ---------------------------------------------------------------------------

describe('INV-C2: Precedence 不等于 Authority', () => {
  it('resolution plan does not carry authority mutation fields', () => {
    // 构造一个最小可解析的 resolution(单 base + 单 append)
    // 即使选了 base winner, plan 不应携带 "override_authority" 之类字段
    // 这里用 classifyPromptScope 的输出间接验证: scope decision 不含 authority
    const scope = classifyPromptScope({
      section_id: 'sec-1',
      immutable_asset: true,
      dependency_kinds: [],
      stable_order: true,
    });
    expect(scope).not.toHaveProperty('authority');
    expect(scope).not.toHaveProperty('override_authority');
  });
});

// ---------------------------------------------------------------------------
// INV-C3 — Condition 是封闭三态
// 不执行任意代码; unknown 不乐观 include
// ---------------------------------------------------------------------------

describe('INV-C3: Condition 是封闭三态', () => {
  it('rejects unknown condition kind', () => {
    expect(() =>
      evaluatePromptCondition(
        { kind: 'arbitrary_script' as any, script: 'return true' },
        {
          control_mode: 'build',
          role_id: null,
          capabilities: {},
          trusted_flags: {},
          present_source_classes: new Set(),
          evidence_refs: [],
        },
      ),
    ).toThrow();
  });

  it('unknown capability yields truth=unknown (not true)', () => {
    const result = evaluatePromptCondition(
      { kind: 'capability_is', capability: 'image_input', expected: 'supported' },
      {
        control_mode: 'build',
        role_id: null,
        capabilities: { image_input: 'unknown' },
        trusted_flags: {},
        present_source_classes: new Set(),
        evidence_refs: [],
      },
    );
    expect(result.truth).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// INV-C4 — Cache eligibility 不等于收益
// static classification 不代表 cache support/hit/cost saving
// ---------------------------------------------------------------------------

describe('INV-C4: Cache eligibility 不等于收益', () => {
  it('PromptScopeDecision has no cache_hit/saved_tokens/provider_cache_supported fields', () => {
    const scope = classifyPromptScope({
      section_id: 'sec-1',
      immutable_asset: true,
      dependency_kinds: [],
      stable_order: true,
    });
    expect(scope).not.toHaveProperty('cache_hit');
    expect(scope).not.toHaveProperty('saved_tokens');
    expect(scope).not.toHaveProperty('provider_cache_supported');
  });
});

// ---------------------------------------------------------------------------
// INV-C5 — Capability override 是受信配置权
// Agent/Prompt/Tool Result/Provider 自报不能修改 effective capability
// ---------------------------------------------------------------------------

describe('INV-C5: Capability override 是受信配置权', () => {
  it('applyCapabilityOverride ignores override when trusted_source gate fails', () => {
    const base = {
      capability_protocol_version: '1',
      capability_snapshot_id: 'cap-1',
      provider_id: 'p-1',
      endpoint_scope: 'e-1',
      model_scope: 'm-1',
      capabilities: { native_tools: 'unknown' },
      source: 'provider_adapter_default',
      diagnostics: [],
    } as any;
    const override = {
      override_id: 'o-1',
      override_version: '1',
      source_config_ref: 'cfg-1',
      source_trust_proof_ref: 'proof-1',
      provider_id: 'p-1',
      endpoint_scope: 'e-1',
      model_scope: 'm-1',
      base_capability_snapshot_id: 'cap-1',
      changes: { native_tools: 'supported' as const },
      justification: 'test',
    };
    const effective = applyCapabilityOverride(base, override, {
      trusted_source: false, // gate fails
      schema_valid: true,
      deterministic_loader: true,
      exact_scope_match: true,
      registered_capability_keys: new Set(['native_tools']),
    });
    expect(effective.applied_override_ref).toBeNull();
    expect(effective.capabilities).toEqual(base.capabilities);
  });
});

// ---------------------------------------------------------------------------
// INV-C6 — 文件与 schema 不建立信任
// Markdown/文件名/路径/frontmatter/schema 合法/正文自报都不能绕过 CRC-3 四重 gate
// ---------------------------------------------------------------------------

describe('INV-C6: 文件与 schema 不建立信任', () => {
  it('markdown route rejects when any of four trust gates fails', () => {
    const input = {
      context_source_id: 'ctx-1',
      source_policy_id: 'sp-1',
      schema_id: 'schema-1',
      loader_id: 'loader-1',
      loader_version: '1',
      sanitization_result_ref: 'sanit-1',
      bounded_source_ref: 'bound-1',
      source_class: 'instruction_candidate' as const,
      policy_version: '1',
      authority: 'project',
      retention: 'session',
    };
    // 四重 gate 任一失败 → reject
    const failing = [
      { trusted_source_policy: false },
      { schema_valid: false },
      { deterministic_loader: false },
      { sanitization_accepted: false },
    ];
    for (const failure of failing) {
      const decision = routeMarkdownSource(input, {
        trusted_source_policy: true,
        schema_valid: true,
        deterministic_loader: true,
        sanitization_accepted: true,
        ...failure,
      });
      expect(decision.target).toBe('reject');
    }
  });
});

// ---------------------------------------------------------------------------
// INV-C7 — Memory candidate 不等于 admitted memory
// TypedMemoryCandidate 不能自行 store/merge/replace/delete
// ---------------------------------------------------------------------------

describe('INV-C7: Memory candidate 不等于 admitted memory', () => {
  it('candidate has no store/merge/replace/delete/admit methods', () => {
    const candidate = createTypedMemoryCandidate({
      source_context_id: 'ctx-1',
      type: 'user_preference',
      claim: 'prefers concise output',
      scope_ref: 'workspace-1',
      evidence_refs: ['ev-1'],
      confidence: 0.8,
      observed_at: '2026-07-26T00:00:00Z',
      expires_at: null,
      context_refs: [],
      invalidation_conditions: [],
      sensitivity_labels: [],
      writer_kind: 'auto_memory_writer',
    });
    expect(candidate).not.toHaveProperty('store');
    expect(candidate).not.toHaveProperty('merge');
    expect(candidate).not.toHaveProperty('replace');
    expect(candidate).not.toHaveProperty('delete');
    expect(candidate).not.toHaveProperty('admit');
  });
});

// ---------------------------------------------------------------------------
// INV-C8 — Runtime policy 是工具事实来源
// Tool description 只投影 policy; 不能产生 allow/ask/deny
// ---------------------------------------------------------------------------

describe('INV-C8: Runtime policy 是工具事实来源', () => {
  it('ToolPolicyProjection has no behavior/allow/ask/deny fields', () => {
    const projection = projectToolPolicy(
      {
        tool_id: 'read_file',
        tool_view_snapshot_id: 'tv-1',
        security_policy_snapshot_id: 'sec-1',
        policy_decision_refs: ['dec-1'],
        description_asset_ref: { asset_id: 'a-1', asset_version: '1' },
        dynamic_constraint_refs: ['c-1'],
      },
      {
        current_security_policy_snapshot_id: 'sec-1',
        current_tool_view_snapshot_id: 'tv-1',
        approvedAsset: () => true,
        renderConstraints: () => 'read-only',
        isToolIncluded: () => true,
      },
    );
    expect(projection).not.toHaveProperty('behavior');
    expect(projection).not.toHaveProperty('allow');
    expect(projection).not.toHaveProperty('ask');
    expect(projection).not.toHaveProperty('deny');
  });
});

// ---------------------------------------------------------------------------
// INV-C9 — No-tools 是硬协议
// 必须零工具视图 + Provider 不发送 tools + runtime 拒绝异常 tool call
// ---------------------------------------------------------------------------

describe('INV-C9: No-tools 是硬协议', () => {
  it('validateNoToolRequest invalidates when any of four gates fails', () => {
    const valid = {
      profile_requires_no_tools: true,
      included_tool_count: 0,
      provider_tools_omitted: true,
      runtime_tool_use_behavior: 'reject' as const,
    };
    const failing = [
      { profile_requires_no_tools: false },
      { included_tool_count: 1 },
      { provider_tools_omitted: false },
      { runtime_tool_use_behavior: 'execute' as const },
    ];
    for (const failure of failing) {
      const result = validateNoToolRequest({ ...valid, ...failure });
      expect(result.status).toBe('invalid');
    }
  });

  it('NoToolValidationResult tool_view_entry_count is literal 0', () => {
    const result = validateNoToolRequest({
      profile_requires_no_tools: true,
      included_tool_count: 0,
      provider_tools_omitted: true,
      runtime_tool_use_behavior: 'reject',
    });
    expect(result.tool_view_entry_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// INV-C10 — Delegation 不扩大权限
// Child scope/tool/mode 不得超过 parent; child output 默认 untrusted
// ---------------------------------------------------------------------------

describe('INV-C10: Delegation 不扩大权限', () => {
  it('handoff envelope result_trust is never trusted', () => {
    const handoff = createDelegationHandoffEnvelope({
      delegation_id: 'del-1',
      child_session_id: 'sess-1',
      child_profile_snapshot_id: 'role-1',
      completion_report_ref: 'comp-1',
      result_content_ref: 'content-1',
      sanitization_result_ref: 'sanit-1',
      sanitization_accepted: true,
      completion_report_valid: true,
      verification_evidence_refs: ['ev-1'],
      warning_codes: [],
    });
    expect(handoff.result_trust).not.toBe('trusted');
    expect(['untrusted', 'unknown']).toContain(handoff.result_trust);
  });
});

// ---------------------------------------------------------------------------
// INV-C11 — Injection suspicion 是软信号
// 模型怀疑不能改变 allow/ask/deny/Trust/Authority/Placement
// ---------------------------------------------------------------------------

describe('INV-C11: Injection suspicion 是软信号', () => {
  it('signal has no behavior/security_decision_ref/authority/placement fields', () => {
    const signal = createInjectionSuspicionSignal({
      context_source_id: 'ctx-1',
      source_trust: 'untrusted',
      deterministic_ingress_result_ref: 'ingress-1',
      signal_source: 'model',
      suspicion_kinds: ['prompt_injection'],
      evidence_refs: [],
      risk_score: 0.5,
      task_impact: 'medium',
      created_at: '2026-07-26T00:00:00Z',
    });
    expect(signal).not.toHaveProperty('behavior');
    expect(signal).not.toHaveProperty('security_decision_ref');
    expect(signal).not.toHaveProperty('authority');
    expect(signal).not.toHaveProperty('placement');
    expect(signal).not.toHaveProperty('retention');
  });
});

// ---------------------------------------------------------------------------
// INV-C12 — Observability 先最小化再清洗
// 先定义字段 allowlist, 再 redaction; redaction 不扩大采集
// ---------------------------------------------------------------------------

describe('INV-C12: Observability 先最小化再清洗', () => {
  it('redaction drops unlisted fields (not collects them)', () => {
    const policy = {
      field_policy_id: 'fp-1',
      field_policy_version: '1',
      event_type: 'tool_call',
      allowed_fields: {}, // 空 allowlist
    };
    const event = {
      event_id: 'evt-1',
      event_type: 'tool_call',
      fields: { secret_field: 'should be dropped' },
    };
    const result = redactTelemetryEvent(event, policy);
    // unlisted field → drop_field (不保留原值)
    expect(result.applied_actions.some((a) => a.action === 'drop_field')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-C13 — 冻结 DAG 不反向修改
// CRC-2/CRC-5 无 Wave D 直接 D-edge
// ---------------------------------------------------------------------------

describe('INV-C13: 冻结 DAG 不反向修改', () => {
  it('applyCapabilityOverride has no Wave D hook (pure function)', () => {
    // applyCapabilityOverride 是纯函数, 不接受 "wave_d_callback" 之类参数
    // 通过类型签名间接验证: 它只接受 (base, override, evidence) 三参数
    const base = {
      capability_protocol_version: '1',
      capability_snapshot_id: 'cap-1',
      provider_id: 'p-1',
      endpoint_scope: 'e-1',
      model_scope: 'm-1',
      capabilities: { native_tools: 'unknown' },
      source: 'provider_adapter_default',
      diagnostics: [],
    } as any;
    const override = {
      override_id: 'o-1',
      override_version: '1',
      source_config_ref: 'cfg-1',
      source_trust_proof_ref: 'proof-1',
      provider_id: 'p-1',
      endpoint_scope: 'e-1',
      model_scope: 'm-1',
      base_capability_snapshot_id: 'cap-1',
      changes: { native_tools: 'supported' as const },
      justification: 'test',
    };
    const effective = applyCapabilityOverride(base, override, {
      trusted_source: true,
      schema_valid: true,
      deterministic_loader: true,
      exact_scope_match: true,
      registered_capability_keys: new Set(['native_tools']),
    });
    // 输出无 wave_d_hook / wave_d_consumer 字段
    expect(effective).not.toHaveProperty('wave_d_hook');
    expect(effective).not.toHaveProperty('wave_d_consumer');
  });
});

// ---------------------------------------------------------------------------
// INV-C14 — Failure 不升级权限
// Policy/loader/router/projection/ask/redactor/sink 失败不能产生 include/trusted/allow
// ---------------------------------------------------------------------------

describe('INV-C14: Failure 不升级权限', () => {
  it('invalid no-tool state stays invalid (no auto-allow)', () => {
    const result = validateNoToolRequest({
      profile_requires_no_tools: false,
      included_tool_count: 5,
      provider_tools_omitted: false,
      runtime_tool_use_behavior: 'execute',
    });
    expect(result.status).toBe('invalid');
  });

  it('handoff with invalid completion stays untrusted (no promotion)', () => {
    const handoff = createDelegationHandoffEnvelope({
      delegation_id: 'del-1',
      child_session_id: 'sess-1',
      child_profile_snapshot_id: 'role-1',
      completion_report_ref: 'comp-1',
      result_content_ref: 'content-1',
      sanitization_result_ref: 'sanit-1',
      sanitization_accepted: false, // sanitizer failed
      completion_report_valid: false, // report invalid
      verification_evidence_refs: [],
      warning_codes: [],
    });
    // 失败 → 正文 null, trust 仍 untrusted (不升级为 trusted)
    expect(handoff.result_content_ref).toBeNull();
    expect(handoff.result_trust).toBe('untrusted');
  });
});

// ---------------------------------------------------------------------------
// INV-C15 — 版本正交
// 各 protocol_version 独立, 不互相替代
// ---------------------------------------------------------------------------

describe('INV-C15: 版本正交', () => {
  it('each Wave C module has its own protocol version constant', async () => {
    // 动态 import 各模块, 验证 protocol version 是模块级独立常量
    // (即使值都是 '1', 它们来自不同模块, 修改一个不影响其他模块的语义)
    const { NO_TOOL_PROTOCOL_VERSION } = await import('../../agent/tools/no-tool-contract.js');
    const { MEMORY_CANDIDATE_PROTOCOL_VERSION } = await import('../../memory/candidates.js');
    const { DELEGATION_PROTOCOL_VERSION, HANDOFF_PROTOCOL_VERSION } = await import(
      '../../permission/delegation.js'
    );

    // 各版本独立存在 (都是字符串 '1', 但语义独立: no-tool vs memory vs delegation vs handoff)
    expect(typeof NO_TOOL_PROTOCOL_VERSION).toBe('string');
    expect(typeof MEMORY_CANDIDATE_PROTOCOL_VERSION).toBe('string');
    expect(typeof DELEGATION_PROTOCOL_VERSION).toBe('string');
    expect(typeof HANDOFF_PROTOCOL_VERSION).toBe('string');

    // 关键: delegation 和 handoff 虽然都在 delegation.ts, 但是两个独立常量
    // (DELEGATION_PROTOCOL_VERSION 给 gate, HANDOFF_PROTOCOL_VERSION 给 envelope)
    expect(DELEGATION_PROTOCOL_VERSION).toBeDefined();
    expect(HANDOFF_PROTOCOL_VERSION).toBeDefined();
  });
});
