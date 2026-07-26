// src/__tests__/agent/provider-meta-context-conformance.test.ts
// DRC-2 Task 4 — Provider adapter meta-context conformance (RED→GREEN).
//
// 三家 stream-client 各导出一个 `encodeMetaContextAsMessages` helper,把一批
// `MetaContextActivation` 投影成 Provider 端 `Message[]`(前置 user 消息)。
// 这个 helper 不改 stream() 签名(向后兼容),由上层 query-engine / helper
// 在调 stream() 之前把 encoded meta prepend 到 messages 数组前。
//
// 三家必须一致的契约(spec §8.5-6):
//   - 输出消息 role='user'(meta 的 semantic_role='user',Provider message plane 编码)
//     —— 不改写为 'system'(否则就提升了 authority)
//   - 按 ordinal 升序排列,meta 全部排在 conversation 之前
//   - content 与 activation 的 content_ref 一一对应(可由 content 引用回溯)
//   - 不修改 stream() 签名

import { describe, expect, it } from 'vitest';
import {
  activateProjectInstruction,
  ACTIVATION_PROTOCOL_VERSION,
  type ContextActivationIdentity,
  type MetaContextActivation,
  type ProjectInstructionActivationInput,
} from '../../agent/context/activation.js';
import { encodeMetaContextAsMessages as anthropicEncode } from '../../agent/anthropic-stream-client.js';
import { encodeMetaContextAsMessages as openaiEncode } from '../../agent/openai-stream-client.js';
import { encodeMetaContextAsMessages as googleEncode } from '../../agent/google-stream-client.js';

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

describe.each([
  ['anthropic', anthropicEncode],
  ['openai', openaiEncode],
  ['google', googleEncode],
] as const)(
  '%s encodeMetaContextAsMessages — adapter conformance (spec §8.5-6)',
  (_name, encode) => {
    it('keeps semantic user role (does NOT rewrite meta as system)', () => {
      const meta = makeActivation({ ordinal: 0 });
      const messages = encode([meta]);
      // spec §8.5-6: adapter must not modify role/placement/authority/trust.
      // semantic_role='user' must surface as role='user' on the Provider message.
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0].role).toBe('user');
    });

    it('orders multiple meta by ordinal ascending', () => {
      const late = makeActivation({
        ordinal: 9,
        bounded_content_ref: 'late',
        content_hash: 'h-late',
      });
      const early = makeActivation({
        ordinal: 1,
        bounded_content_ref: 'early',
        content_hash: 'h-early',
      });
      const messages = encode([late, early]);
      // First encoded message corresponds to the lowest ordinal.
      expect(messages[0].content).toContain('early');
      expect(messages[1].content).toContain('late');
    });

    it('preserves content correspondence with activation content_ref', () => {
      const meta = makeActivation({
        ordinal: 0,
        bounded_content_ref: 'bounded-content-xyz',
      });
      const messages = encode([meta]);
      // Encoded message body must carry the bounded content ref so the
      // Provider-side request can be traced back to its activation.
      expect(messages[0].content).toContain('bounded-content-xyz');
    });

    it('returns an empty array for empty activations', () => {
      expect(encode([])).toEqual([]);
    });

    it('returns messages whose role is user for every entry (no system pollution)', () => {
      const a = makeActivation({
        ordinal: 0,
        bounded_content_ref: 'a',
        content_hash: 'h-a',
      });
      const b = makeActivation({
        ordinal: 1,
        bounded_content_ref: 'b',
        content_hash: 'h-b',
      });
      const messages = encode([a, b]);
      // INV-D4: every meta surfaces as user role; none is rewritten to system.
      expect(messages.every((m) => m.role === 'user')).toBe(true);
    });
  },
);

describe('encodeMetaContextAsMessages — cross-adapter parity', () => {
  it('all three adapters agree on count, roles, and content for the same activations', () => {
    const a = makeActivation({
      ordinal: 0,
      bounded_content_ref: 'first',
      content_hash: 'h-first',
    });
    const b = makeActivation({
      ordinal: 1,
      bounded_content_ref: 'second',
      content_hash: 'h-second',
    });
    const activations = [a, b];

    const anthropicMessages = anthropicEncode(activations);
    const openaiMessages = openaiEncode(activations);
    const googleMessages = googleEncode(activations);

    expect(anthropicMessages.length).toBe(2);
    expect(openaiMessages.length).toBe(2);
    expect(googleMessages.length).toBe(2);

    // All three must keep user role for every entry.
    expect(anthropicMessages.every((m) => m.role === 'user')).toBe(true);
    expect(openaiMessages.every((m) => m.role === 'user')).toBe(true);
    expect(googleMessages.every((m) => m.role === 'user')).toBe(true);

    // All three must surface the same content (independent of provider encoding
    // specifics, the bounded content ref must be present in every message body).
    for (const msgs of [anthropicMessages, openaiMessages, googleMessages]) {
      expect(msgs[0].content).toContain('first');
      expect(msgs[1].content).toContain('second');
    }
  });
});
