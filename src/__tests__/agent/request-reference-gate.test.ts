// src/__tests__/agent/request-reference-gate.test.ts
// Wave D Task 9 (M-028 / DRC-3): Final Request Reference Gate — gate 行为测试.
//
// 与 tool-reference-validation.test.ts 的区别:
//   - 那个文件覆盖 validateToolReferences 纯函数的字段级不变量;
//   - 本文件覆盖 "validation 失败 → request 不得发送" 的语义契约,
//     即把 validation 结果翻译成"可发送 / 不可发送 / 拒绝原因"的 gate 行为。
//
// INV-D9: gate 只看 final view 派生出的 validation 结果,不旁路去问 base registry。
// 边界:本测试不接入 streaming-query(streaming-query 由主代理统一接入);
// 这里只断言"如果 validateToolReferences 返回 invalid,任何调用方都不应发送请求"。

import { describe, expect, it } from 'vitest';
import {
  buildToolReferenceManifest,
  validateToolReferences,
  TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION,
  type ToolReferenceValidation,
  type ToolReferenceValidationInput,
} from '../../agent/tools/reference-validator.js';

// ─────────────────────────────────────────────────────────────────────────────
// 一个最小 gate 适配器:把 validation 结果翻译成"可发送 / 不可发送"。
//
// 这是测试用例用来锚定语义的纯函数;真实 streaming-query 接入由主代理负责。
// 这里只断言 validateToolReferences 的输出足以驱动这样的决策。
// ─────────────────────────────────────────────────────────────────────────────

interface GateDecision {
  sendable: boolean;
  refusal_reason: string | null;
  validation_id: string;
}

function decideRequestSendability(
  validation: ToolReferenceValidation,
): GateDecision {
  if (validation.status === 'valid') {
    return {
      sendable: true,
      refusal_reason: null,
      validation_id: validation.validation_id,
    };
  }
  // invalid:不发送。理由用首个 diagnostic 简化呈现(测试可读性)。
  return {
    sendable: false,
    refusal_reason: validation.diagnostics[0] ?? 'reference_validation_failed',
    validation_id: validation.validation_id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_SNAPSHOT_ID = 'request:snap-1';
const COMPILED_PROMPT_SNAPSHOT_ID = 'compiled:snap-1';
const FINAL_TOOL_VIEW_SNAPSHOT_ID = 'tv:snap-1';

function buildValidInput(): ToolReferenceValidationInput {
  const manifest = buildToolReferenceManifest({
    compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
    declarations: [
      {
        section_id: 'tools',
        tool_id: 'tool:run_bash',
        canonical_tool_name: 'run_bash',
        source_kind: 'compiler_reference_token',
        evidence_ref: 'asset:tools@1',
      },
    ],
  });
  return {
    validation_protocol_version: TOOL_REFERENCE_VALIDATION_PROTOCOL_VERSION,
    request_snapshot_id: REQUEST_SNAPSHOT_ID,
    compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
    final_tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
    reference_manifest_id: manifest.reference_manifest_id,
    manifest,
    final_tool_view: {
      tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
      included_tool_ids: new Set(['tool:run_bash']),
      tool_name_to_id: new Map([['run_bash', 'tool:run_bash']]),
    },
    tool_policy_projection_ids: ['proj:run_bash@1'],
    no_tool_validation_id: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('request-reference-gate / sendability decision', () => {
  it('allows sending when validation passes', () => {
    const decision = decideRequestSendability(
      validateToolReferences(buildValidInput()),
    );
    expect(decision.sendable).toBe(true);
    expect(decision.refusal_reason).toBeNull();
  });

  it('blocks sending when an orphan reference is detected', () => {
    const input = buildValidInput();
    // 从 final view 里移除 run_bash —— 制造 orphan
    input.final_tool_view = {
      tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
      included_tool_ids: new Set<string>(),
      tool_name_to_id: new Map<string, string>(),
    };

    const decision = decideRequestSendability(validateToolReferences(input));

    expect(decision.sendable).toBe(false);
    expect(decision.refusal_reason).not.toBeNull();
    // validation_id 仍然有,即便被拒,以供 telemetry 追溯
    expect(decision.validation_id).toMatch(/^valid:[a-f0-9]{16}$|^invalid:[a-f0-9]{16}$/);
  });

  it('blocks sending on canonical name drift', () => {
    const input = buildValidInput();
    input.final_tool_view = {
      tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
      included_tool_ids: new Set(['tool:run_bash']),
      tool_name_to_id: new Map([['run_bash', 'tool:execute_shell']]),
    };

    const decision = decideRequestSendability(validateToolReferences(input));
    expect(decision.sendable).toBe(false);
    expect(decision.refusal_reason).not.toBeNull();
  });

  it('blocks sending on snapshot mismatch', () => {
    const input = buildValidInput();
    input.final_tool_view = {
      tool_view_snapshot_id: 'tv:different',
      included_tool_ids: new Set(['tool:run_bash']),
      tool_name_to_id: new Map([['run_bash', 'tool:run_bash']]),
    };

    const decision = decideRequestSendability(validateToolReferences(input));
    expect(decision.sendable).toBe(false);
  });

  it('blocks sending on no-tools protocol error', () => {
    const manifest = buildToolReferenceManifest({
      compiled_prompt_snapshot_id: COMPILED_PROMPT_SNAPSHOT_ID,
      declarations: [
        {
          section_id: 'tools',
          tool_id: 'tool:run_bash',
          canonical_tool_name: 'run_bash',
          source_kind: 'compiler_reference_token',
          evidence_ref: 'asset:tools@1',
        },
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
      no_tool_validation_id: 'notool:xyz',
    };

    const decision = decideRequestSendability(validateToolReferences(input));
    expect(decision.sendable).toBe(false);
  });

  it('preserves the validation_id in the decision for telemetry', () => {
    const decision = decideRequestSendability(
      validateToolReferences(buildValidInput()),
    );
    expect(decision.validation_id).toMatch(/^valid:[a-f0-9]{16}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-D9 — gate 必须依据 final view 校验结果,不能从 base registry 旁路放行
// ─────────────────────────────────────────────────────────────────────────────

describe('request-reference-gate / INV-D9 final view authority', () => {
  it('does not allow sending a request whose only reference is invisible in final view', () => {
    // 即使该工具在 base registry 里"存在",final view 把它排除后,validation 必须
    // 返回 invalid,从而 gate 不得放行。
    const input = buildValidInput();
    input.final_tool_view = {
      tool_view_snapshot_id: FINAL_TOOL_VIEW_SNAPSHOT_ID,
      included_tool_ids: new Set<string>(), // final view 排除全部
      tool_name_to_id: new Map<string, string>(),
    };

    const validation = validateToolReferences(input);
    expect(validation.status).toBe('invalid');
    expect(validation.orphan_reference_ids).toContain('ref:run_bash');

    const decision = decideRequestSendability(validation);
    expect(decision.sendable).toBe(false);
  });
});
