// src/__tests__/agent/provider-adapter-contract.test.ts
//
// M-057 Provider Adapter Conformance — identity & tool-plane invariants.
//
// Required Reuse: this file is the ONLY artifact permitted for M-057. It must NOT
// be satisfied by introducing a new adapter layer; each provider's existing
// StreamClient must satisfy these contracts directly.
//
// Five contract points are asserted for each of the three providers
// (anthropic, openai, google):
//   1. Provider tool-call id maps verbatim to internal ToolUseBlock.id.
//   2. A ToolResultBlock referencing that id round-trips with the SAME id
//      (the adapter never rewrites tool_use_id), AND the synthesized
//      content_block_start.blockId agrees with the final ToolUseBlock.id.
//   3. The adapter does not reorder the input tools array.
//   4. The adapter does not delete tools based on the model name.
//   5. When the provider omits the tool-call identity, the adapter surfaces it
//      consistently (either a thrown protocol error, OR empty-string '' on BOTH
//      content_block_start.blockId AND ToolUseBlock.id). The adapter MUST NOT
//      synthesize a randomUUID() / any synthetic id.
//
// asset_version, protocol_version, and provider model version are orthogonal;
// the contract below never couples them.

import { describe, it, expect } from 'vitest';
import { AnthropicStreamClient } from '../../agent/anthropic-stream-client.js';
import { OpenAIStreamClient } from '../../agent/openai-stream-client.js';
import { GoogleStreamClient } from '../../agent/google-stream-client.js';
import type {
  StreamEvent,
  AssistantMessage,
  Message,
  ToolDefinition,
  ToolUseBlock,
} from '../../agent/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Generic helpers
// ─────────────────────────────────────────────────────────────────────────────

type StreamOutput = StreamEvent | AssistantMessage;

/** Collect everything yielded by a stream() generator into an array. */
async function collect(gen: AsyncGenerator<StreamOutput>): Promise<StreamOutput[]> {
  const out: StreamOutput[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Find the first assistant message in the collected output. */
function firstAssistant(events: StreamOutput[]): AssistantMessage {
  const msg = events.find(e => e.type === 'assistant') as AssistantMessage | undefined;
  if (!msg) throw new Error('no AssistantMessage yielded');
  return msg;
}

/** Find the first tool_use block on the first assistant message. */
function firstToolUse(events: StreamOutput[]): ToolUseBlock {
  const msg = firstAssistant(events);
  const block = msg.content.find(b => b.type === 'tool_use') as ToolUseBlock | undefined;
  if (!block) throw new Error('no tool_use block on assistant message');
  return block;
}

/** A small tools array deliberately NOT in alphabetical / insertion order. */
const UNORDERED_TOOLS: ToolDefinition[] = [
  {
    name: 'zeta',
    description: 'Z tool',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'alpha',
    description: 'A tool',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'middle',
    description: 'M tool',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const OPTIONS = {
  systemPrompt: 'sys',
  maxTokens: 1024,
  signal: new AbortController().signal,
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock SDK builders — each returns { client, captured } where `captured` records
// the tools (and converted messages) the adapter sent to the mock SDK.
// ─────────────────────────────────────────────────────────────────────────────

// ---- Anthropic ----
//
// AnthropicStreamClient has NO DI constructor — it always news up a real
// `Anthropic` client internally. We must mock the `@anthropic-ai/sdk` module
// via its prototype: replace `client.messages.create` after construction by
// reaching into the private field. Because the private field is not accessible
// from outside, we use a small monkey-patch on the prototype of the SDK class
// captured via the same import the client uses.
//
// Simpler approach that stays within the existing test conventions: import the
// same `Anthropic` constructor the client imports, override
// `Anthropic.prototype.messages.create` for the duration of the suite.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

interface AnthropicCaptured {
  tools: unknown;
  messages: unknown;
}

function installAnthropicMock(events: AnthropicMockEvent[]): {
  captured: AnthropicCaptured;
  restore: () => void;
} {
  const captured: AnthropicCaptured = { tools: undefined, messages: undefined };
  // AnthropicStreamClient has no DI: it constructs its own `Anthropic` instance
  // and calls `this.client.messages.create(params, { signal })`. The `create`
  // function lives on the prototype shared by all instances' `messages`
  // objects, so we monkey-patch that single prototype method.
  const probe = new Anthropic({ apiKey: 'probe' });
  const messagesProto = Object.getPrototypeOf(probe.messages) as any;
  const originalCreate = messagesProto.create;
  messagesProto.create = function (this: unknown, params: any): AsyncIterable<AnthropicMockEvent> {
    captured.tools = params?.tools;
    captured.messages = params?.messages;
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next(): Promise<IteratorResult<AnthropicMockEvent>> {
            if (i < events.length) return Promise.resolve({ value: events[i++]!, done: false });
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  };
  return {
    captured,
    restore: () => {
      messagesProto.create = originalCreate;
    },
  };
}

/** Minimal Anthropic SSE event shapes (only the fields the client reads). */
type AnthropicMockEvent =
  | {
      type: 'message_start';
      message: { id: string; model: string; usage: { input_tokens: number; output_tokens: number } };
    }
  | {
      type: 'content_block_start';
      index: number;
      content_block: { type: 'tool_use'; id?: string; name?: string };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta: { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string }; usage: { output_tokens: number } }
  | { type: 'message_stop' };

function anthropicToolUseEvents(opts: {
  toolUseId?: string; // undefined => omit field entirely
  name?: string;
  args?: Record<string, unknown>;
}): AnthropicMockEvent[] {
  const idPresent = opts.toolUseId !== undefined;
  return [
    {
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 1, output_tokens: 0 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        ...(idPresent ? { id: opts.toolUseId! } : {}),
        name: opts.name ?? 'zeta',
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(opts.args ?? {}) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
}

// ---- OpenAI ----

interface OpenAIMockChunk {
  id?: string;
  model?: string;
  choices: Array<{
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
    index: number;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function makeOpenAIMock(chunks: OpenAIMockChunk[]): {
  client: unknown;
  captured: { tools: unknown; messages: unknown };
} {
  const captured: { tools: unknown; messages: unknown } = { tools: undefined, messages: undefined };
  const client = {
    chat: {
      completions: {
        create: async (params: any): Promise<AsyncIterable<OpenAIMockChunk>> => {
          captured.tools = params?.tools;
          captured.messages = params?.messages;
          return {
            [Symbol.asyncIterator]() {
              let i = 0;
              return {
                next(): Promise<IteratorResult<OpenAIMockChunk>> {
                  if (i < chunks.length) return Promise.resolve({ value: chunks[i++]!, done: false });
                  return Promise.resolve({ value: undefined, done: true });
                },
              };
            },
          };
        },
      },
    },
  };
  return { client, captured };
}

function openaiToolUseChunks(opts: {
  toolCallId?: string; // undefined => omit id field entirely
  name?: string;
  args?: Record<string, unknown>;
}): OpenAIMockChunk[] {
  const idPresent = opts.toolCallId !== undefined;
  return [
    { id: 'c1', model: 'gpt-x', choices: [{ delta: { role: 'assistant' }, finish_reason: null, index: 0 }] },
    {
      id: 'c1',
      model: 'gpt-x',
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                ...(idPresent ? { id: opts.toolCallId! } : {}),
                function: { name: opts.name ?? 'zeta', arguments: JSON.stringify(opts.args ?? {}) },
              },
            ],
          },
          finish_reason: null,
          index: 0,
        },
      ],
    },
    { id: 'c1', model: 'gpt-x', choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
  ];
}

// ---- Google ----

interface GoogleMockChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

function makeGoogleMock(chunks: GoogleMockChunk[]): {
  client: unknown;
  captured: { tools: unknown; contents: unknown };
} {
  const captured: { tools: unknown; contents: unknown } = { tools: undefined, contents: undefined };
  const client = {
    models: {
      generateContentStream: async (params: any): Promise<AsyncIterable<GoogleMockChunk>> => {
        captured.tools = params?.config?.tools;
        captured.contents = params?.contents;
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              next(): Promise<IteratorResult<GoogleMockChunk>> {
                if (i < chunks.length) return Promise.resolve({ value: chunks[i++]!, done: false });
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
        };
      },
    },
  };
  return { client, captured };
}

function googleToolUseChunks(opts: {
  functionCallId?: string; // undefined => omit id field entirely
  name?: string;
  args?: Record<string, unknown>;
}): GoogleMockChunk[] {
  const idPresent = opts.functionCallId !== undefined;
  return [
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  ...(idPresent ? { id: opts.functionCallId! } : {}),
                  name: opts.name ?? 'zeta',
                  args: opts.args ?? {},
                },
              },
            ],
          },
          finishReason: undefined,
        },
      ],
    },
    { candidates: [{ finishReason: 'STOP' }] },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider-agnostic factory: each call returns a FRESH (client, captured) pair
// so tests never share mutable state. The factory builds a tool-use stream for
// the given provider-native id; pass `undefined` to omit the id field entirely
// (the M-057 §5 "missing identity" case).
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderCase {
  provider: 'anthropic' | 'openai' | 'google';
  /** Known provider-native id used in the "happy path" assertions. */
  knownId: string;
  /**
   * Build a fresh StreamClient wired to a recording mock. The mock replays a
   * tool-use stream carrying `toolUseId` (or with the id field omitted when
   * undefined) and records the tools + converted messages the adapter forwards.
   */
  build: (toolUseId: string | undefined, model?: string) => {
    streamClient: StreamingClientLike;
    captured: { tools: unknown; messages: unknown };
  };
  /** Extract tool names from the provider-native tools shape. */
  toolNames: (tools: unknown) => string[];
}

interface StreamingClientLike {
  stream: (
    m: Message[],
    t: ToolDefinition[],
    o: typeof OPTIONS,
  ) => AsyncGenerator<StreamOutput>;
}

const CASES: ProviderCase[] = [
  {
    provider: 'anthropic',
    knownId: 'toolu_123',
    build: (toolUseId, model) => {
      const installed = installAnthropicMock(anthropicToolUseEvents({ toolUseId }));
      const streamClient = new AnthropicStreamClient({
        apiKey: 'test',
        model: model ?? 'claude-x',
      });
      // Attach restore so callers can clean up if they re-build mid-test.
      (streamClient as any).__restore = installed.restore;
      return {
        streamClient: streamClient as unknown as StreamingClientLike,
        captured: {
          // Getters reflect live state — the mock populates these only when
          // messages.create is invoked during stream().
          get tools() { return installed.captured.tools; },
          get messages() { return installed.captured.messages; },
        },
      };
    },
    toolNames: tools => (tools as any[]).map((t: any) => t.name),
  },
  {
    provider: 'openai',
    knownId: 'call_123',
    build: (toolUseId, model) => {
      const mock = makeOpenAIMock(openaiToolUseChunks({ toolCallId: toolUseId }));
      const streamClient = new OpenAIStreamClient(
        { apiKey: 'test', model: model ?? 'gpt-x' },
        mock.client as OpenAI,
      );
      return {
        streamClient: streamClient as unknown as StreamingClientLike,
        captured: mock.captured,
      };
    },
    toolNames: tools => (tools as any[]).map((t: any) => t.function?.name),
  },
  {
    provider: 'google',
    knownId: 'function-call-123',
    build: (toolUseId, model) => {
      const mock = makeGoogleMock(googleToolUseChunks({ functionCallId: toolUseId }));
      const streamClient = new GoogleStreamClient(
        { apiKey: 'test', model: model ?? 'gemini-x' },
        mock.client as GoogleGenAI,
      );
      return {
        streamClient: streamClient as unknown as StreamingClientLike,
        captured: {
          get tools() { return mock.captured.tools; },
          get messages() { return mock.captured.contents; },
        },
      };
    },
    // google tools shape: [{ functionDeclarations: [{ name, ... }] }]
    toolNames: tools => ((tools as any[])?.[0]?.functionDeclarations ?? []).map((t: any) => t.name),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The conformance matrix
// ─────────────────────────────────────────────────────────────────────────────

describe.each(CASES)('$provider — M-057 conformance', (case_) => {
  it('1. maps provider tool-call id to internal ToolUseBlock.id verbatim', async () => {
    const { streamClient } = case_.build(case_.knownId);
    const events = await collect(streamClient.stream([{ role: 'user', content: 'go' }], UNORDERED_TOOLS, OPTIONS));
    const toolUse = firstToolUse(events);
    expect(toolUse.id).toBe(case_.knownId);
  });

  it('2. content_block_start.blockId and ToolUseBlock.id agree, and tool_use_id round-trips', async () => {
    const { streamClient } = case_.build(case_.knownId);
    const events = await collect(streamClient.stream([{ role: 'user', content: 'go' }], UNORDERED_TOOLS, OPTIONS));

    // (a) internal consistency: the synthesized content_block_start.blockId
    // must equal the final ToolUseBlock.id.
    const toolUse = firstToolUse(events);
    const blockStart = events.find(
      e => e.type === 'content_block_start' && (e as any).blockType === 'tool_use',
    ) as any;
    expect(blockStart).toBeDefined();
    expect(blockStart.blockId).toBe(toolUse.id);

    // (b) round-trip: feed a follow-up conversation whose ToolResultBlock
    // references the known id; assert the adapter forwards that id unchanged
    // to the mock SDK (no rewrite of tool_use_id).
    const roundTripMessages: Message[] = [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: case_.knownId, name: 'zeta', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: case_.knownId, content: 'ok' },
        ],
      },
    ];
    const second = case_.build(case_.knownId);
    await collect(second.streamClient.stream(roundTripMessages, UNORDERED_TOOLS, OPTIONS));
    const recorded = second.captured.messages as any;
    expect(recorded).toBeDefined();
    const serialized = JSON.stringify(recorded);
    expect(serialized).toContain(case_.knownId);
    // The known id must appear in the recorded payload untransformed. Any
    // rewrite of tool_use_id would drop or replace this distinctive string.
  });

  it('3. does not reorder input tools', async () => {
    const { streamClient, captured } = case_.build(case_.knownId);
    await collect(streamClient.stream([{ role: 'user', content: 'go' }], UNORDERED_TOOLS, OPTIONS));
    expect(captured.tools).toBeDefined();
    expect(case_.toolNames(captured.tools)).toEqual(['zeta', 'alpha', 'middle']);
  });

  it('4. does not delete tools based on model name', async () => {
    // Pass an unusual model name; the full tool set must still be forwarded
    // unchanged (same length, same order, same names).
    const { streamClient, captured } = case_.build(case_.knownId, 'unknown-model-zzz');
    await collect(streamClient.stream([{ role: 'user', content: 'go' }], UNORDERED_TOOLS, OPTIONS));
    expect(captured.tools).toBeDefined();
    expect(case_.toolNames(captured.tools)).toEqual(['zeta', 'alpha', 'middle']);
  });

  it('5. does not synthesize a random fallback id when provider omits identity', async () => {
    // Feed a tool-use stream with the id field omitted entirely. The adapter
    // must EITHER throw a protocol error mentioning the provider, OR surface
    // the missing id as empty-string '' CONSISTENTLY across both
    // content_block_start.blockId and the final ToolUseBlock.id. It MUST NOT
    // inject a randomUUID() or any synthetic id.
    const { streamClient } = case_.build(undefined);
    let events: StreamOutput[];
    try {
      events = await collect(streamClient.stream([{ role: 'user', content: 'go' }], UNORDERED_TOOLS, OPTIONS));
    } catch (err) {
      // Protocol-error branch: the message must mention the provider.
      expect(String((err as Error)?.message ?? err).toLowerCase()).toContain(case_.provider);
      return;
    }

    const toolUse = firstToolUse(events);
    const blockStart = events.find(
      e => e.type === 'content_block_start' && (e as any).blockType === 'tool_use',
    ) as any;

    // If a value is surfaced, it MUST be '' (empty string), not a synthesized id.
    expect(toolUse.id).toBe('');
    if (blockStart) {
      // blockId may legitimately be undefined OR '' — but never a random uuid.
      expect(blockStart.blockId === undefined || blockStart.blockId === '').toBe(true);
      // And it must agree with the final id when both are defined.
      if (blockStart.blockId !== undefined) {
        expect(blockStart.blockId).toBe(toolUse.id);
      }
    }
  });
});
