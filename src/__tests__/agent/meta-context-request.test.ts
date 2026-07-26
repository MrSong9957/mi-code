// src/__tests__/agent/meta-context-request.test.ts
// DRC-2 Task 4 — Meta Context Request Integration (RED→GREEN).
//
// `attachMetaContext` 是 D-1 T3 `activateProjectInstruction` 与 RC-2
// `buildSemanticRequestSnapshot` 之间的桥梁:把一批 `MetaContextActivation`
// 按 ordinal 排序后投影为 `meta_context` plane 上的 `SemanticMessage[]`,
// 再连同调用方提供的 system / conversation / tools 一起烧录进请求快照。
//
// 重点断言(对齐 spec §8.5):
//   - meta_context 位于 conversation 之前,但当前用户消息仍是 conversation
//     的最后一条(Pinned Working Set 不被 meta 替代)
//   - 多个 meta 按 ordinal 升序排列
//   - ordinal 冲突 → throw 'meta.ordinal_conflict'(不按字符串猜顺序)
//   - meta 的 authority/trust/placement 来自 activation 原样,不被提升
//   - 空 activations → meta_context 为空数组(snapshot 仍合法)
//   - meta 的 is_meta=true,conversation 当前用户消息 is_meta=false

import { describe, expect, it } from 'vitest';
import {
  activateProjectInstruction,
  attachMetaContext,
  ACTIVATION_PROTOCOL_VERSION,
  type ContextActivationIdentity,
  type MetaContextActivation,
  type ProjectInstructionActivationInput,
} from '../../agent/context/activation.js';
import { buildToolDefinitionSnapshot } from '../../agent/tools/descriptor-snapshot.js';
import type { RegisteredTool } from '../../agent/types.js';

const toolsSnapshot = buildToolDefinitionSnapshot(
  'registry-1',
  new Map<string, RegisteredTool>(),
);

const BASE_IDENTITY: ContextActivationIdentity = {
  activation_protocol_version: ACTIVATION_PROTOCOL_VERSION,
  activation_id: 'activation-1',
  request_snapshot_id: 'snapshot-1',
  source_context_id: 'src-1',
  route_decision_id: 'route-1',
  channel: 'project_instruction',
};

function makeActivation(
  overrides: Partial<ProjectInstructionActivationInput> = {},
): MetaContextActivation {
  return activateProjectInstruction({
    activation_identity: BASE_IDENTITY,
    context_source_id: 'src-1',
    route_decision_id: 'route-1',
    route_target: 'project_instruction_context',
    bounded_content_ref: 'bounded-ref',
    content_hash: 'hash',
    trust_proof_ref: 'trust-proof',
    sanitization_status: 'accepted',
    source_budget_ref: 'budget',
    provenance_refs: ['user:input'],
    authority: 'user',
    trust: 'trusted',
    freshness_ref: 'fresh',
    overflow_metadata_ref: null,
    ordinal: 0,
    ...overrides,
  });
}

const baseRequestInput = {
  request_id: 'request-1',
  turn_id: 'turn-1',
  registry_snapshot_id: 'registry-1',
  system_sections: [
    { section_id: 'base', placement: 'system_static' as const, content: 'sys' },
  ],
  conversation: [
    {
      message_id: 'current-user',
      role: 'user' as const,
      content: 'fix the bug',
      is_meta: false,
    },
  ],
  tools: toolsSnapshot,
};

describe('attachMetaContext — meta context placement (spec §8.5)', () => {
  it('prepends meta context before conversation without replacing the current user', () => {
    const meta = makeActivation({ ordinal: 0 });
    const snapshot = attachMetaContext(baseRequestInput, [meta]);

    // meta lands in meta_context plane, with stable message_id from activation.
    expect(snapshot.meta_context.map((m) => m.message_id)).toEqual([
      meta.message_id,
    ]);
    // current user stays as the last conversation entry, untouched.
    expect(snapshot.conversation.at(-1)?.message_id).toBe('current-user');
    // meta is flagged; current user is not.
    expect(snapshot.meta_context[0].is_meta).toBe(true);
    expect(snapshot.conversation.at(-1)?.is_meta).toBe(false);
  });

  it('keeps meta out of system_static / system_dynamic planes', () => {
    const meta = makeActivation({ ordinal: 0 });
    const snapshot = attachMetaContext(baseRequestInput, [meta]);

    // system plane carries only the original static section — no meta smuggled in.
    expect(snapshot.system_sections.map((s) => s.placement)).toEqual([
      'system_static',
    ]);
    // conversation plane carries only the original user message — no meta smuggled in.
    expect(snapshot.conversation.map((m) => m.message_id)).toEqual([
      'current-user',
    ]);
  });

  it('sorts multiple meta activations by ordinal ascending', () => {
    const late = makeActivation({
      ordinal: 5,
      bounded_content_ref: 'late',
      content_hash: 'h-late',
    });
    const early = makeActivation({
      ordinal: 1,
      bounded_content_ref: 'early',
      content_hash: 'h-early',
    });
    const middle = makeActivation({
      ordinal: 3,
      bounded_content_ref: 'middle',
      content_hash: 'h-middle',
    });

    const snapshot = attachMetaContext(baseRequestInput, [
      late,
      early,
      middle,
    ]);

    expect(snapshot.meta_context.map((m) => m.message_id)).toEqual([
      early.message_id,
      middle.message_id,
      late.message_id,
    ]);
  });

  it('rejects ordinal conflict with meta.ordinal_conflict (no path-based ordering)', () => {
    const a = makeActivation({
      ordinal: 2,
      bounded_content_ref: 'a',
      content_hash: 'h-a',
    });
    const b = makeActivation({
      ordinal: 2,
      bounded_content_ref: 'b',
      content_hash: 'h-b',
    });

    expect(() => attachMetaContext(baseRequestInput, [a, b])).toThrowError(
      'meta.ordinal_conflict',
    );
  });

  it('preserves authority/trust/placement verbatim from activation (no promotion)', () => {
    const meta = makeActivation({ authority: 'user', trust: 'trusted' });
    const snapshot = attachMetaContext(baseRequestInput, [meta]);
    const m = snapshot.meta_context[0];

    // INV-D4 / INV-D8: is_meta=true does NOT change Authority / Trust / Retention.
    // The SemanticMessage projection must echo activation values untouched.
    expect(m.is_meta).toBe(true);
    expect(m.role).toBe('user');
    // authority/trust/placement are carried as out-of-band fields on the
    // SemanticMessage record (the RC-2 plane stays Provider-neutral but
    // retains the activation's authority/trust for downstream provenance).
    expect((m as unknown as Record<string, unknown>).authority).toBe('user');
    expect((m as unknown as Record<string, unknown>).trust).toBe('trusted');
    expect((m as unknown as Record<string, unknown>).placement).toBe(
      'meta_context',
    );
  });

  it('produces empty meta_context for empty activations (backward compatible)', () => {
    const snapshot = attachMetaContext(baseRequestInput, []);
    expect(snapshot.meta_context).toEqual([]);
    // conversation still intact.
    expect(snapshot.conversation.at(-1)?.message_id).toBe('current-user');
    // snapshot is still frozen & well-formed.
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('returns a frozen snapshot whose meta_context entries are individually frozen', () => {
    const meta = makeActivation({ ordinal: 0 });
    const snapshot = attachMetaContext(baseRequestInput, [meta]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.meta_context)).toBe(true);
    expect(Object.isFrozen(snapshot.meta_context[0])).toBe(true);
  });
});
