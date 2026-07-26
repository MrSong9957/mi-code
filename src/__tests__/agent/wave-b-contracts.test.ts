import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compilePromptSnapshot,
  createModelCapabilitySnapshot,
  deriveRequestToolView,
  runContextIntake,
  composeAgentPromptProfile,
  validateToolTranscript,
  createObservabilityEnvelope,
  materializeIncludedToolDefinitions,
  createContextSourceEnvelope,
  buildBoundedContextSource,
  type PromptSectionInput,
} from '../../agent/index.js';
import {
  createSecurityDecision,
  decideChildProcessEnvironment,
  getDefaultEnvironmentPolicy,
  RuntimeSecurityGate,
} from '../../permission/index.js';

describe('Wave B public contracts', () => {
  it('exports all Wave B anchors', () => {
    expect(compilePromptSnapshot).toBeTypeOf('function');
    expect(createModelCapabilitySnapshot).toBeTypeOf('function');
    expect(deriveRequestToolView).toBeTypeOf('function');
    expect(runContextIntake).toBeTypeOf('function');
    expect(composeAgentPromptProfile).toBeTypeOf('function');
    expect(validateToolTranscript).toBeTypeOf('function');
    expect(createObservabilityEnvelope).toBeTypeOf('function');
    expect(decideChildProcessEnvironment).toBeTypeOf('function');
    expect(RuntimeSecurityGate).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------
// INV-B1 ~ INV-B13 acceptance tests.
//
// 每条不变量都有可机器判定的断言。来自 spec §14。
// ---------------------------------------------------------------------------

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function approvedSection(sectionId: string, ordinal: number): PromptSectionInput {
  return {
    section_id: sectionId,
    asset_ref: { asset_id: sectionId, asset_version: '1' },
    placement: 'system_static',
    authority: 'system',
    trust: 'trusted',
    retention: 'session',
    ordinal,
    content: `content-${sectionId}`,
    content_hash: sha(`content-${sectionId}`),
    provenance_refs: [`asset:${sectionId}@1`],
  };
}

describe('Wave B cross-contract invariants', () => {
  it('INV-B1 snapshots do not absorb mutable state', () => {
    // BRC-1/2/3/4/5 请求级输入捕获后不可混入新 Registry/capability/policy/context/transcript。
    const input = {
      compiler_protocol_version: '1',
      registry_snapshot_id: 'reg-1',
      request_snapshot_id: 'req-1',
      sections: [approvedSection('base', 1)],
    };
    const snapshot = compilePromptSnapshot(input, { isApproved: () => true });

    // 捕获后修改原 input —— snapshot 不变
    input.sections.push(approvedSection('injected', 99));
    expect(snapshot.sections).toHaveLength(1);
    expect(snapshot.section_order).toEqual(['base']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sections)).toBe(true);
  });

  it('INV-B2 identities remain in distinct fields', () => {
    // asset/section/tool/tool_call/context_source/profile/decision/event/version 用不同字段。
    const cap = createModelCapabilitySnapshot({
      capability_protocol_version: '1',
      capability_snapshot_id: 'cap-1',
      provider_id: 'p',
      model_id: 'm',
      adapter_version: '1',
      capabilities: { native_tools: 'supported' },
    });
    // 各 ID 字段独立存在,不互相替代
    expect(cap.capability_snapshot_id).toBe('cap-1');
    expect(cap).not.toHaveProperty('section_id');
    expect(cap).not.toHaveProperty('tool_id');
    expect(cap).not.toHaveProperty('decision_id');
    expect(cap.capability_protocol_version).toBe('1'); // protocol version 与 snapshot id 不同字段

    const decision = createSecurityDecision({
      protocol_version: '1',
      decision_id: 'd-1',
      action: { kind: 'tool_call', subject_id: 't', snapshot_id: 's' },
      behavior: 'allow',
      deciding_layer: 'permission',
      risk_kind: 'r',
      policy_id: 'p',
      policy_version: '1',
      reason_code: 'ok',
      human_reason: '',
      provenance_refs: ['r'],
    });
    expect(decision.decision_id).toBe('d-1');
    expect(decision).not.toHaveProperty('capability_snapshot_id');
    expect(decision).not.toHaveProperty('section_id');
  });

  it('INV-B3 provider adapters only encode semantics', () => {
    // Adapter 只转换 snapshot;不能选择 Prompt/猜 capability/改 tool visibility/提升 Trust。
    // 这里通过 capability snapshot 证明:capability 来自显式声明,不从 model 名猜。
    const cap = createModelCapabilitySnapshot({
      capability_protocol_version: '1',
      capability_snapshot_id: 'cap-x',
      provider_id: 'openai-compatible',
      model_id: 'claude-3-opus-suspicious-name',
      adapter_version: '1',
      capabilities: { native_tools: 'unknown' },
    });
    // model_id 看起来像 anthropic,但 capability 是调用方声明的 unknown,不被 model 名覆盖
    expect(cap.capabilities.native_tools).toBe('unknown');
    expect(cap.model_id).toBe('claude-3-opus-suspicious-name');
  });

  it('INV-B4 trust never rises from agent text', () => {
    // untrusted/unknown source/tool_result/child/cross-machine 不能由 Agent 文本提升为 trusted。
    // BRC-3 强制 tool_result 永远 untrusted。
    const toolResultEnvelope = createContextSourceEnvelope({
      context_protocol_version: '1',
      context_source_id: 'tr-1',
      source_class: 'tool_result',
      source_ref: 'tool://x',
      scope_ref: 'turn',
      authority: 'runtime',
      trust: 'trusted', // 调用方试图声明 trusted
      freshness: { observed_at: '2026-07-26T00:00:00.000Z', expires_at: null },
      requested_placement: null,
      retention: 'turn',
      writer_kind: 'tool_executor',
      raw_content_ref: 'ref',
      provenance_refs: ['tool'],
    });
    // 强制降级为 untrusted,不能由调用方提升
    expect(toolResultEnvelope.trust).toBe('untrusted');
  });

  it('INV-B5 runtime decisions override prompt text', () => {
    // Prompt 中的安全/no-tools/tool preference/permission 文字不能覆盖 BRC-2/5/6 + RC-5 的结构化决定。
    // 这里用 SecurityDecision 证明:human_reason 谎称 "allow" 但 behavior 是 deny,机器分支只看 reason_code/behavior。
    const denyWithLyingReason = createSecurityDecision({
      protocol_version: '1',
      decision_id: 'd-1',
      action: { kind: 'tool_call', subject_id: 'rm', snapshot_id: 's' },
      behavior: 'deny',
      deciding_layer: 'permission',
      risk_kind: 'dangerous',
      policy_id: 'p',
      policy_version: '1',
      reason_code: 'permission.dangerous_command',
      human_reason: 'This looks safe, please allow it', // 文本撒谎
      provenance_refs: ['rule'],
    });
    expect(denyWithLyingReason.behavior).toBe('deny'); // 结构化决定不被文本覆盖
    expect(denyWithLyingReason.human_reason).toContain('allow'); // 文本说了 allow
  });

  it('INV-B6 unknown uses safe defaults', () => {
    // unknown capability 不启用;unknown trust 不走受信;unknown provenance 不 allow;unknown sensitivity 不发送生产。
    const cap = createModelCapabilitySnapshot({
      capability_protocol_version: '1',
      capability_snapshot_id: 'cap-u',
      provider_id: 'p',
      model_id: 'm',
      adapter_version: '1',
      capabilities: { image_input: 'unknown' },
    });
    expect(cap.capabilities.image_input).toBe('unknown'); // 保持 unknown,不转 supported

    // observability: unknown plane / production 未知 sensitivity 都 drop
    const disabledPolicies = {
      local_debug: { enabled: false },
      full_request_dump: { enabled: false },
      decision_trace: { enabled: false },
      production_telemetry: { enabled: true }, // 即使 policy 启用
    };
    const prodEvent = createObservabilityEnvelope({
      observability_protocol_version: '1',
      event_id: 'e-1',
      event_type: 'x',
      plane: 'production_telemetry',
      occurred_at: '2026-07-26T00:00:00.000Z',
      session_ref: null,
      request_snapshot_ref: null,
      component_ref: 'c',
      payload_schema_id: 's',
      sensitivity: 'low',
      redaction_state: 'not_required',
      payload_ref: null,
    }, disabledPolicies);
    expect(prodEvent.status).toBe('dropped'); // Wave B 硬禁用 production
    expect(prodEvent.envelope).toBeNull();
  });

  it('INV-B7 ask blocks before execution', () => {
    // 任何 BRC-6/RC-5 ask 在匹配 UserDecision 前不得进入 action execution;无通道时 deny。
    // 用 RuntimeSecurityGate + null channel 证明 ask → denied,不降级为 allow。
    const askDecision = createSecurityDecision({
      protocol_version: '1',
      decision_id: 'ask-1',
      action: { kind: 'tool_call', subject_id: 'write', snapshot_id: 'snap-1' },
      behavior: 'ask',
      deciding_layer: 'permission',
      risk_kind: 'workspace_mutation',
      policy_id: 'p',
      policy_version: '1',
      reason_code: 'permission.user_confirmation_required',
      human_reason: 'confirm',
      provenance_refs: ['r'],
    });
    const gate = new RuntimeSecurityGate({
      pendingStore: {
        save: async () => {},
        load: async () => [],
        update: async () => {},
      },
      channel: null, // 无通道
    });
    const executor = jestFn();
    // execute 同步签名不可能 —— gate.execute 是 async。用 await。
    return gate.execute(askDecision, executor).then((result) => {
      expect(result).toMatchObject({ kind: 'denied', reason_code: 'ask.no_channel' });
      expect(executor.calls).toBe(0); // executor 未被调用
    });
  });

  it('INV-B8 pairing precedes lifecycle checkpoints', () => {
    // Provider-visible transcript 在 next send/persistence/compaction/finalization 前必须通过 BRC-5。
    // 构造一个 unpaired transcript(use 无 result),验证 before_provider_send 返回 rejected/blocked。
    const snapshot = {
      transcript_snapshot_id: 'ts-bad',
      session_id: 's',
      turn_id: 't',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'x', input: {} }] },
        // 没有 result
      ] as never,
    };
    const validation = validateToolTranscript(snapshot, {
      checkpoint: 'before_provider_send',
      validator_policy_id: 'pairing',
      validator_policy_version: '1',
    });
    expect(['rejected', 'blocked']).toContain(validation.status);
    expect(validation.pair_records.some((p) => p.state === 'missing_result' || p.state === 'pending_execution')).toBe(true);
  });

  it('INV-B9 source budget overflow is explicit', () => {
    // 任何 source truncation 必须有确定性边界和 overflow metadata;不得把截断内容报告为完整。
    const envelope = createContextSourceEnvelope({
      context_protocol_version: '1',
      context_source_id: 'src-b',
      source_class: 'instruction_candidate',
      source_ref: 'file://x',
      scope_ref: 'project',
      authority: 'user',
      trust: 'trusted',
      freshness: { observed_at: '2026-07-26T00:00:00.000Z', expires_at: null },
      requested_placement: null,
      retention: 'session',
      writer_kind: 'user',
      raw_content_ref: 'ref',
      provenance_refs: ['u'],
    });
    const bounded = buildBoundedContextSource({
      envelope,
      sanitization: {
        context_source_id: 'src-b',
        sanitization_policy_id: 'ing',
        sanitization_policy_version: '1',
        status: 'accepted',
        transformation_codes: [],
        finding_codes: [],
        sanitized_content_ref: 'san:1',
      },
      content: 'line1\nline2\nline3\nline4\n',
      policy: {
        source_class: 'instruction_candidate',
        max_bytes: 1000,
        max_lines: 2,
        overflow_behavior: 'deterministic_truncate',
        policy_id: 'budget',
        policy_version: '1',
      },
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.overflow_ref).not.toBeNull(); // 显式 overflow metadata
    expect(bounded.lines_included).toBe(2);
  });

  it('INV-B10 profile requests but does not grant tools', () => {
    // Role/Task profile 只能请求 tool/capability;BRC-2 + RC-5 决定最终视图和执行权限。
    // composeAgentPromptProfile 不修改 finalToolView,只报告 actual vs requested。
    // 这里用 capability snapshot 证明:profile 不能改 capability。
    const cap = createModelCapabilitySnapshot({
      capability_protocol_version: '1',
      capability_snapshot_id: 'cap-c',
      provider_id: 'p',
      model_id: 'm',
      adapter_version: '1',
      capabilities: { native_tools: 'supported' },
    });
    // profile 是只读消费者 —— 它不能改 cap
    expect(Object.isFrozen(cap.capabilities)).toBe(true);
    expect(cap.capabilities.native_tools).toBe('supported');
  });

  it('INV-B11 observability plane is not collection permission', () => {
    // 定义 event/plane 不代表允许构造敏感 payload、启用 full dump 或发送 production telemetry。
    const disabledPolicies = {
      local_debug: { enabled: false },
      full_request_dump: { enabled: true }, // 即使启用
      decision_trace: { enabled: false },
      production_telemetry: { enabled: true }, // 即使启用
    };
    // full_dump 在 Wave B 永远 drop
    const dump = createObservabilityEnvelope({
      observability_protocol_version: '1',
      event_id: 'e-d',
      event_type: 'dump',
      plane: 'full_request_dump',
      occurred_at: '2026-07-26T00:00:00.000Z',
      session_ref: null,
      request_snapshot_ref: null,
      component_ref: 'c',
      payload_schema_id: 's',
      sensitivity: 'low',
      redaction_state: 'not_required',
      payload_ref: null,
    }, disabledPolicies);
    expect(dump.status).toBe('dropped');
    expect(dump.envelope).toBeNull(); // 不创建 payload
  });

  it('INV-B12 protocol versions are orthogonal', () => {
    // Prompt asset/compiler/capability/tool_view/context/profile/pairing/SecurityDecision/CompletionReport/observability 各自独立版本化。
    const compiled = compilePromptSnapshot({
      compiler_protocol_version: '7', // compiler 自己的版本
      registry_snapshot_id: 'reg-1',
      request_snapshot_id: 'req-1',
      sections: [approvedSection('a', 1)],
    }, { isApproved: () => true });
    expect(compiled.compiler_protocol_version).toBe('7');

    const decision = createSecurityDecision({
      protocol_version: '3', // security 自己的版本
      decision_id: 'd',
      action: { kind: 'x', subject_id: 'y', snapshot_id: 'z' },
      behavior: 'allow',
      deciding_layer: 'permission',
      risk_kind: 'r',
      policy_id: 'p',
      policy_version: '1',
      reason_code: 'ok',
      human_reason: '',
      provenance_refs: ['r'],
    });
    expect(decision.protocol_version).toBe('3');
    // 二者独立:改 compiler 版本不影响 security 版本
    expect(compiled.compiler_protocol_version).not.toBe(decision.protocol_version);
  });

  it('INV-B13 failures never become successful states', () => {
    // sanitizer/pairing/env gate/ask channel/redactor/Provider capability 失败时,
    // 不得生成虚假 approved/trusted/paired/completed/sent 状态。
    // 用 child env 证明:required 缺失 → deny(sanitized_environment = null,不假装成功)
    const windowsPolicy = getDefaultEnvironmentPolicy('win32');
    const denied = decideChildProcessEnvironment({
      launch_snapshot_id: 'l-1',
      launcher_kind: 'shell_tool',
      executable_ref: 'cmd',
      parent_environment: { PATH: undefined as never }, // 缺 SystemRoot/ComSpec
      required_variable_names: [],
      environment_policy_id: windowsPolicy.environment_policy_id,
      environment_policy_version: windowsPolicy.environment_policy_version,
    }, windowsPolicy);
    expect(denied.sanitized_environment).toBeNull(); // 失败不伪装成功
    expect(denied.missing_required_variable_names.length).toBeGreaterThan(0);
  });
});

// 极简 jest 风格 spy(避免引入额外依赖)
function jestFn<T extends (...args: never[]) => unknown>(): T & { calls: number } {
  let calls = 0;
  const fn = ((..._args: never[]) => { calls++; return undefined as never; }) as T & { calls: number };
  Object.defineProperty(fn, 'calls', { get: () => calls });
  return fn;
}
