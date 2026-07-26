// src/__tests__/agent/capability-snapshot.test.ts
// M-058 (Wave B Task 2) Provider Capability Snapshot.
//
// 物理本质:把"adapter 当前代码路径到底支持什么"压成一张不可变快照。
// 关键不变量:
//   - 未知就是未知:`unknown` 不能被偷偷转成 `supported`/`unsupported`。
//   - 不从 model_id 推断能力:model_id 只是身份字符串,不携带 capability 语义。
//   - 来源写死为 `provider_adapter_default`:不接受调用方走私其他来源。
//   - 输出深冻结 + 深拷贝:输入被 mutate 不能影响快照。
//   - 确定性 ID:无随机 UUID,同一个 adapter+model 必须产出同一个 snapshot_id。
//
// 本文件覆盖两层:
//   (A) createModelCapabilitySnapshot 纯函数契约(身份校验、值校验、冻结、隔离、source 写死)
//   (B) 三个 StreamClient 的 getDefaultCapabilities() 集成(每家真实声明)

import { describe, expect, it } from 'vitest';
import {
  createModelCapabilitySnapshot,
  type CreateModelCapabilitySnapshotInput,
} from '../../agent/tools/capability-snapshot.js';
import { AnthropicStreamClient } from '../../agent/anthropic-stream-client.js';
import { OpenAIStreamClient } from '../../agent/openai-stream-client.js';
import { GoogleStreamClient } from '../../agent/google-stream-client.js';
import type { OpenAI } from 'openai';
import type { GoogleGenAI } from '@google/genai';

// ─────────────────────────────────────────────────────────────────────────────
// (A) createModelCapabilitySnapshot — 纯函数契约
// ─────────────────────────────────────────────────────────────────────────────

const VALID_INPUT: CreateModelCapabilitySnapshotInput = {
  capability_protocol_version: '1',
  capability_snapshot_id: 'cap-1',
  provider_id: 'openai-compatible',
  model_id: 'gpt-4o',
  adapter_version: '1',
  capabilities: { native_tools: 'supported' },
};

describe('createModelCapabilitySnapshot — identity & value validation', () => {
  it('does not infer capabilities from model id', () => {
    // model_id 看起来像 Anthropic,但 capability 仍由调用方显式声明为准
    const snapshot = createModelCapabilitySnapshot({
      capability_protocol_version: '1',
      capability_snapshot_id: 'cap-1',
      provider_id: 'openai-compatible',
      model_id: 'claude-looking-name',
      adapter_version: '1',
      capabilities: { native_tools: 'unknown' },
      diagnostics: ['adapter did not declare native_tools'],
    });
    expect(snapshot.capabilities.native_tools).toBe('unknown');
  });

  it('preserves `unknown` exactly (no silent conversion to supported/unsupported)', () => {
    const snapshot = createModelCapabilitySnapshot({
      ...VALID_INPUT,
      capabilities: {
        native_tools: 'unknown',
        provider_annotations: 'unknown',
      },
    });
    expect(snapshot.capabilities.native_tools).toBe('unknown');
    expect(snapshot.capabilities.provider_annotations).toBe('unknown');
  });

  it('rejects an unknown support string like "maybe"', () => {
    expect(() =>
      createModelCapabilitySnapshot({
        ...VALID_INPUT,
        capabilities: { native_tools: 'maybe' as any },
      }),
    ).toThrow(/capability|support/i);
  });

  it.each([
    ['capability_protocol_version', { ...VALID_INPUT, capability_protocol_version: '' }],
    ['capability_snapshot_id', { ...VALID_INPUT, capability_snapshot_id: '' }],
    ['provider_id', { ...VALID_INPUT, provider_id: '' }],
    ['model_id', { ...VALID_INPUT, model_id: '' }],
    ['adapter_version', { ...VALID_INPUT, adapter_version: '' }],
  ] as const)('rejects empty %s via requireIdentity', (_field, input) => {
    expect(() => createModelCapabilitySnapshot(input)).toThrow(/non-empty/);
  });

  it.each([
    ['whitespace-only capability_protocol_version', { ...VALID_INPUT, capability_protocol_version: '   ' }],
    ['whitespace-only capability_snapshot_id', { ...VALID_INPUT, capability_snapshot_id: '   ' }],
    ['whitespace-only provider_id', { ...VALID_INPUT, provider_id: '   ' }],
    ['whitespace-only model_id', { ...VALID_INPUT, model_id: '   ' }],
    ['whitespace-only adapter_version', { ...VALID_INPUT, adapter_version: '   ' }],
  ] as const)('rejects %s via requireIdentity', (_label, input) => {
    expect(() => createModelCapabilitySnapshot(input)).toThrow(/non-empty/);
  });
});

describe('createModelCapabilitySnapshot — source & shape', () => {
  it("hardcodes source to 'provider_adapter_default' and ignores any smuggled source field", () => {
    // 调用方尝试走私一个不同的 source —— 必须被丢弃
    const snapshot = createModelCapabilitySnapshot({
      ...VALID_INPUT,
      ...({ source: 'user_override' } as any),
    });
    expect(snapshot.source).toBe('provider_adapter_default');
  });

  it('does not expose a `source` field from input on the output object beyond the hardcoded value', () => {
    const snapshot = createModelCapabilitySnapshot({
      ...VALID_INPUT,
      ...({ source: 'evil' } as any),
    });
    expect((snapshot as any).source).toBe('provider_adapter_default');
  });
});

describe('createModelCapabilitySnapshot — freezing & isolation', () => {
  it('returns a frozen top-level object', () => {
    const snapshot = createModelCapabilitySnapshot(VALID_INPUT);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('returns a frozen capabilities map', () => {
    const snapshot = createModelCapabilitySnapshot(VALID_INPUT);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
  });

  it('returns a frozen diagnostics array', () => {
    const snapshot = createModelCapabilitySnapshot({ ...VALID_INPUT, diagnostics: ['d1'] });
    expect(Object.isFrozen(snapshot.diagnostics)).toBe(true);
  });

  it('defaults diagnostics to [] when omitted', () => {
    const snapshot = createModelCapabilitySnapshot(VALID_INPUT);
    expect(snapshot.diagnostics).toEqual([]);
    expect(Array.isArray(snapshot.diagnostics)).toBe(true);
  });

  it('defaults diagnostics to [] when explicitly undefined', () => {
    const snapshot = createModelCapabilitySnapshot({ ...VALID_INPUT, diagnostics: undefined });
    expect(snapshot.diagnostics).toEqual([]);
  });

  it('isolates capabilities from later input mutation (deep copy)', () => {
    const capabilities = { native_tools: 'supported' as const };
    const snapshot = createModelCapabilitySnapshot({ ...VALID_INPUT, capabilities });
    // mutate the original input map AFTER creating the snapshot
    (capabilities as any).native_tools = 'unsupported';
    (capabilities as any).sneaky = true;
    expect(snapshot.capabilities.native_tools).toBe('supported');
    expect((snapshot.capabilities as any).sneaky).toBeUndefined();
  });

  it('isolates diagnostics from later input mutation (deep copy)', () => {
    const diagnostics = ['original'];
    const snapshot = createModelCapabilitySnapshot({ ...VALID_INPUT, diagnostics });
    diagnostics.push('mutated');
    (diagnostics as any)[0] = 'changed';
    expect(snapshot.diagnostics).toEqual(['original']);
  });

  it('does not derive capability values from suspicious model_id content', () => {
    // 一个看起来"很 GPT" 的 model_id 不应改变 native_tools 等
    const snapshot = createModelCapabilitySnapshot({
      ...VALID_INPUT,
      model_id: 'gpt-4-turbo-pro-max',
      capabilities: {
        native_tools: 'unknown',
        tool_result_identity: 'unknown',
        system_instruction: 'unknown',
        provider_annotations: 'unknown',
      },
    });
    expect(snapshot.capabilities.native_tools).toBe('unknown');
    expect(snapshot.capabilities.tool_result_identity).toBe('unknown');
    expect(snapshot.capabilities.system_instruction).toBe('unknown');
    expect(snapshot.capabilities.provider_annotations).toBe('unknown');
  });
});

describe('createModelCapabilitySnapshot — output fields', () => {
  it('records every identity field verbatim', () => {
    const snapshot = createModelCapabilitySnapshot({
      capability_protocol_version: '7',
      capability_snapshot_id: 'cap-snap-42',
      provider_id: 'p',
      model_id: 'm',
      adapter_version: '9',
      capabilities: { x: 'supported' },
    });
    expect(snapshot.capability_protocol_version).toBe('7');
    expect(snapshot.capability_snapshot_id).toBe('cap-snap-42');
    expect(snapshot.provider_id).toBe('p');
    expect(snapshot.model_id).toBe('m');
    expect(snapshot.adapter_version).toBe('9');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) Per-adapter getDefaultCapabilities() integration
// ─────────────────────────────────────────────────────────────────────────────

// UUID v1-v5-ish regex —— used to assert the snapshot_id is NOT a random UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the three clients WITHOUT calling the network. For OpenAI/Google we
 * inject a no-op mock override (same pattern as provider-adapter-contract.test.ts
 * and the existing client unit tests). Anthropic constructs its own SDK from
 * apiKey, but getDefaultCapabilities() never touches the network layer.
 */
function buildClients() {
  const anthropic = new AnthropicStreamClient({ apiKey: 'test-key', model: 'claude-x' });
  const openai = new OpenAIStreamClient(
    { apiKey: 'test-key', model: 'gpt-x' },
    {} as unknown as OpenAI, // override —— stream() 不会在 capability 路径上被调用
  );
  const google = new GoogleStreamClient(
    { apiKey: 'test-key', model: 'gemini-x' },
    {} as unknown as GoogleGenAI,
  );
  return { anthropic, openai, google };
}

describe.each([
  { name: 'anthropic', expectedProviderId: 'anthropic', getClient: () => buildClients().anthropic },
  { name: 'openai', expectedProviderId: 'openai-compatible', getClient: () => buildClients().openai },
  { name: 'google', expectedProviderId: 'google', getClient: () => buildClients().google },
] as const)('$name getDefaultCapabilities()', ({ expectedProviderId, getClient }) => {
  it('declares the expected provider_id', () => {
    const snapshot = getClient().getDefaultCapabilities();
    expect(snapshot.provider_id).toBe(expectedProviderId);
  });

  it("declares native_tools === 'supported'", () => {
    const snapshot = getClient().getDefaultCapabilities();
    expect(snapshot.capabilities.native_tools).toBe('supported');
  });

  it("declares tool_result_identity === 'supported'", () => {
    const snapshot = getClient().getDefaultCapabilities();
    expect(snapshot.capabilities.tool_result_identity).toBe('supported');
  });

  it("declares system_instruction === 'supported'", () => {
    const snapshot = getClient().getDefaultCapabilities();
    expect(snapshot.capabilities.system_instruction).toBe('supported');
  });

  it("sets source === 'provider_adapter_default'", () => {
    const snapshot = getClient().getDefaultCapabilities();
    expect(snapshot.source).toBe('provider_adapter_default');
  });

  it('produces a deterministic capability_snapshot_id (stable across calls)', () => {
    const client = getClient();
    const a = client.getDefaultCapabilities();
    const b = client.getDefaultCapabilities();
    expect(a.capability_snapshot_id).toBe(b.capability_snapshot_id);
    expect(a.capability_snapshot_id.length).toBeGreaterThan(0);
  });

  it('does NOT embed a random UUID in capability_snapshot_id', () => {
    const snapshot = getClient().getDefaultCapabilities();
    expect(UUID_RE.test(snapshot.capability_snapshot_id)).toBe(false);
  });

  it('returns a frozen snapshot with frozen capabilities', () => {
    const snapshot = getClient().getDefaultCapabilities();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
  });
});

describe('getDefaultCapabilities — provider-specific annotations declaration', () => {
  it("anthropic declares provider_annotations === 'supported'", () => {
    const snapshot = buildClients().anthropic.getDefaultCapabilities();
    expect(snapshot.capabilities.provider_annotations).toBe('supported');
  });

  it("openai declares provider_annotations === 'unknown'", () => {
    const snapshot = buildClients().openai.getDefaultCapabilities();
    // openai-compatible 路径不携带 provider_annotations —— 显式标 unknown,
    // 不允许偷偷改成 supported
    expect(snapshot.capabilities.provider_annotations).toBe('unknown');
  });

  it("google declares provider_annotations === 'unknown'", () => {
    const snapshot = buildClients().google.getDefaultCapabilities();
    expect(snapshot.capabilities.provider_annotations).toBe('unknown');
  });
});
