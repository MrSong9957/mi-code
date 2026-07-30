// src/__tests__/agent/tool-transcript-checkpoints.test.ts
// Wave B Task 11 (M-070 / BRC-5): Four Checkpoint Integration.
//
// 物理本质: 把 Task 10 的 transcript validator 挂到四个生命周期 checkpoint:
//   - before_provider_send: streamingQuery 每轮 submit 前
//   - before_persistence:   SessionStore.appendValidatedTranscript 入口
//   - before_compaction:    runCompaction 的 preflight 校验
//   - before_finalization:  streamingQuery 退出前的最终校验
//
// 本测试覆盖两路:
//   1. 各 seam 的聚焦单测(appendValidatedTranscript / runCompaction preflight)。
//   2. 通过 streamingQuery 的集成测试(provider 是否被调用)。
//
// 重要约束(spec):
//   - validator 不合成 result、不决定 partial/failed Outcome(RC-4 的事)。
//   - 配对失败 fail-closed:抛 { code: 'tool_transcript.invalid', checkpoint, status, ... }。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';

import { SessionStore } from '../../session/store.js';
import { runCompaction } from '../../agent/compression.js';
import { streamingQuery } from '../../agent/streaming-query.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import {
  validateToolTranscript,
  type ToolTranscriptValidation,
  type ToolTranscriptSnapshot,
} from '../../agent/tools/transcript-validator.js';
import type {
  StreamingLLMClient,
  Message,
  ContentBlock,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
} from '../../agent/types.js';

// ---------- helpers ----------

function use(id: string, name = 'echo'): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] };
}

function result(id: string, content = 'ok'): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}

function userText(text: string): Message {
  return { role: 'user', content: text };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

const POLICY = {
  validator_policy_id: 'pairing',
  validator_policy_version: '1',
};

/**
 * 构造一个 ToolTranscriptSnapshot —— transcript_snapshot_id 用 messages 的 sha256 短哈希,
 * 保证同一 messages 数组产生同一 id(与生产代码同样的确定性约定)。
 */
function snapshot(messages: Message[], opts: { session_id?: string; turn_id?: string } = {}): ToolTranscriptSnapshot {
  const hash = createHash('sha256')
    .update(JSON.stringify(messages))
    .digest('hex')
    .slice(0, 16);
  return {
    transcript_snapshot_id: `ts:${hash}`,
    session_id: opts.session_id ?? 'sess-test',
    turn_id: opts.turn_id ?? 'turn-test',
    messages,
  };
}

/** 工具函数:拿一份 accepted 的 validation 用于"应通过"场景。 */
function acceptedValidation(checkpoint: ToolTranscriptValidation['checkpoint'], messages: Message[]): ToolTranscriptValidation {
  return validateToolTranscript(snapshot(messages), {
    checkpoint,
    ...POLICY,
  });
}

// ============================================================
// appendValidatedTranscript —— before_persistence seam
// ============================================================

describe('SessionStore.appendValidatedTranscript (before_persistence)', () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'micode-checkpoint-test-'));
    store = new SessionStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts when checkpoint=before_persistence AND status=accepted → message appended', async () => {
    const sid = 'persist-ok';
    const msg: Message = assistantText('done');
    const v = acceptedValidation('before_persistence', [msg]);
    expect(v.status).toBe('accepted');

    await store.appendValidatedTranscript(sid, msg, v);

    const loaded = await store.load(sid);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.role).toBe('assistant');
  });

  it('rejects when checkpoint=before_compaction (wrong checkpoint) → throws, NOT appended', async () => {
    const sid = 'persist-wrong-cp';
    const msg: Message = assistantText('done');
    const v = acceptedValidation('before_compaction', [msg]);
    expect(v.checkpoint).toBe('before_compaction');
    expect(v.status).toBe('accepted');

    await expect(store.appendValidatedTranscript(sid, msg, v)).rejects.toMatchObject({
      code: 'tool_transcript.invalid',
      checkpoint: 'before_persistence',
    });

    const loaded = await store.load(sid);
    expect(loaded).toHaveLength(0);
  });

  it('rejects when status=blocked → throws, NOT appended', async () => {
    const sid = 'persist-blocked';
    const msg: Message = assistantText('done');
    // 构造一个 blocked validation:use 没配 result,且 executing_facts 列出它在执行中
    const v = validateToolTranscript(snapshot([use('c1')]), {
      checkpoint: 'before_persistence',
      ...POLICY,
      executing_facts: { executing_tool_call_ids: new Set(['c1']) },
    });
    expect(v.status).toBe('blocked');

    await expect(store.appendValidatedTranscript(sid, msg, v)).rejects.toMatchObject({
      code: 'tool_transcript.invalid',
      checkpoint: 'before_persistence',
    });

    const loaded = await store.load(sid);
    expect(loaded).toHaveLength(0);
  });

  it('rejects when status=rejected → throws, NOT appended', async () => {
    const sid = 'persist-rejected';
    const msg: Message = assistantText('done');
    // 构造一个 rejected validation:use 没配 result
    const v = validateToolTranscript(snapshot([use('c1')]), {
      checkpoint: 'before_persistence',
      ...POLICY,
    });
    expect(v.status).toBe('rejected');

    await expect(store.appendValidatedTranscript(sid, msg, v)).rejects.toMatchObject({
      code: 'tool_transcript.invalid',
      checkpoint: 'before_persistence',
    });

    const loaded = await store.load(sid);
    expect(loaded).toHaveLength(0);
  });
});

// ============================================================
// runCompaction —— before_compaction preflight seam
// ============================================================

describe('runCompaction (before_compaction preflight)', () => {
  /** 一份足够长、足以触发 snip 的 fixture(>50 条)。 */
  function bigFixture(): Message[] {
    const out: Message[] = [];
    for (let i = 0; i < 60; i++) out.push(userText(`msg ${i}`));
    return out;
  }

  it('with preflightValidation accepted → compaction proceeds (returns messages)', () => {
    const msgs = bigFixture();
    const v = acceptedValidation('before_compaction', msgs);
    expect(v.status).toBe('accepted');

    const { messages, needsL4 } = runCompaction(msgs, { preflightValidation: v });
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeLessThan(msgs.length); // snip 真的裁了
    expect(typeof needsL4).toBe('boolean');
  });

  it('with preflightValidation rejected → throws, compaction does NOT run', () => {
    const msgs = bigFixture();
    const v = validateToolTranscript(snapshot([use('c1')]), {
      checkpoint: 'before_compaction',
      ...POLICY,
    });
    expect(v.status).toBe('rejected');

    expect(() => runCompaction(msgs, { preflightValidation: v })).toThrow();
  });

  it('with preflightValidation having wrong checkpoint → throws', () => {
    const msgs = bigFixture();
    // checkpoint=before_persistence 但传给 runCompaction → 错 checkpoint
    const v = acceptedValidation('before_persistence', msgs);
    expect(v.checkpoint).toBe('before_persistence');

    expect(() => runCompaction(msgs, { preflightValidation: v })).toThrow();
  });

  it('WITHOUT options → legacy behavior, no checkpoint enforcement (returns messages)', () => {
    const msgs = bigFixture();
    // 不传 options —— 必须不抛、照常压缩
    const { messages, needsL4 } = runCompaction(msgs);
    expect(Array.isArray(messages)).toBe(true);
    expect(typeof needsL4).toBe('boolean');
  });

  it('legacy path still produces same output as before (regression)', () => {
    // 同一份 fixture,两次都不传 options → 输出必须完全相等(确定性)
    const msgs = bigFixture();
    const a = runCompaction(msgs);
    const b = runCompaction(msgs);
    expect(a.messages).toEqual(b.messages);
    expect(a.needsL4).toBe(b.needsL4);
    // 输出应是裁剪过的:head + snip 标记 + tail
    expect(a.messages.length).toBeLessThan(msgs.length);
  });

  it('accepted transcript remains accepted after L1/L2 compaction', () => {
    const messages: Message[] = [userText('start')];
    for (let index = 1; index <= 5; index++) {
      messages.push(use(`call_${index}`, index <= 2 ? 'spawn_agent' : 'echo'));
      messages.push(result(`call_${index}`, 'x'.repeat(200)));
    }

    const preflight = acceptedValidation('before_compaction', messages);
    const compacted = runCompaction(messages, {
      preflightValidation: preflight,
    }).messages;
    const postflight = validateToolTranscript(snapshot(compacted), {
      checkpoint: 'before_provider_send',
      ...POLICY,
    });

    expect(postflight.status).toBe('accepted');
    expect(postflight.reason_codes).toEqual([]);
    expect(postflight.pair_records.every(pair => pair.state === 'paired')).toBe(true);
  });
});

// ============================================================
// streamingQuery —— before_provider_send integration
// ============================================================

/** 间谍式 client:记录 stream() 是否被调用过。 */
class CapturingStreamClient implements StreamingLLMClient {
  streamCalled = false;
  streamCallCount = 0;
  constructor(private scripts: ContentBlock[][]) {}

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    this.streamCalled = true;
    this.streamCallCount++;
    const blocks = this.scripts[this.streamCallCount - 1] ?? [];
    yield { type: 'message_start', messageId: `msg_${this.streamCallCount}`, model: 'fake', inputTokens: 1 };
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as ContentBlock;
      if (block.type === 'text') {
        yield { type: 'content_block_start', index: i, blockType: 'text' };
        yield { type: 'content_block_delta', index: i, deltaType: 'text', content: block.text };
        yield { type: 'content_block_stop', index: i };
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, blockType: 'tool_use', blockId: block.id };
        yield { type: 'content_block_delta', index: i, deltaType: 'input_json', content: JSON.stringify(block.input) };
        yield { type: 'content_block_stop', index: i };
      }
    }
    yield { type: 'message_delta', stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', outputTokens: blocks.length };
    yield { type: 'message_stop' };
    yield {
      type: 'assistant',
      content: blocks,
      usage: { input_tokens: 1, output_tokens: blocks.length },
      stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      uuid: `asst_${this.streamCallCount}`,
      timestamp: new Date().toISOString(),
    };
  }
}

/** 收集 generator 的所有产出 */
async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe('streamingQuery before_provider_send integration', () => {
  it('unpaired tool_use in initial messages → throws before_provider_send, provider NOT called', async () => {
    // initialMessages 里带一个未配对的 tool_use —— 第一轮 submit 前的 checkpoint 应捕获
    const initialMessages: Message[] = [
      use('orphan_call', 'echo'),
    ];
    const client = new CapturingStreamClient([
      [{ type: 'text', text: 'should never get here' }],
    ]);
    const registry = new ToolRegistry();
    const ac = new AbortController();

    let caught: unknown = null;
    try {
      await drain(streamingQuery(client, registry, '继续', {
        systemPrompt: 'sys',
        tools: [],
        signal: ac.signal,
        maxTurns: 3,
        enableStreamingExecution: false,
        initialMessages,
      }));
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught).toMatchObject({
      code: 'tool_transcript.invalid',
      checkpoint: 'before_provider_send',
    });
    // 核心:provider 从未被调用 —— fail-closed 在 submit 之前
    expect(client.streamCalled).toBe(false);
  });

  it('clean paired transcript → streamingQuery proceeds, provider IS called', async () => {
    // initialMessages 是配对完整的:use + result
    const initialMessages: Message[] = [
      use('paired_call', 'echo'),
      result('paired_call', 'ok'),
    ];
    const client = new CapturingStreamClient([
      [{ type: 'text', text: '完成。' }],
    ]);
    const registry = new ToolRegistry();
    const ac = new AbortController();

    await drain(streamingQuery(client, registry, '继续', {
      systemPrompt: 'sys',
      tools: [],
      signal: ac.signal,
      maxTurns: 3,
      enableStreamingExecution: false,
      initialMessages,
    }));

    // 配对完整 → provider 应被调用
    expect(client.streamCalled).toBe(true);
    expect(client.streamCallCount).toBeGreaterThanOrEqual(1);
  });

  it('continues to the next provider turn after old long tool results are compacted', async () => {
    const scripts: ContentBlock[][] = [
      [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
      [{ type: 'tool_use', id: 'call_2', name: 'echo', input: {} }],
      [{ type: 'tool_use', id: 'call_3', name: 'echo', input: {} }],
      [{ type: 'tool_use', id: 'call_4', name: 'echo', input: {} }],
      [{ type: 'text', text: 'done' }],
    ];
    const client = new CapturingStreamClient(scripts);
    const registry = new ToolRegistry();
    const echo: ToolDefinition = {
      name: 'echo',
      description: 'returns a long deterministic result',
      parameters: { type: 'object', properties: {} },
    };
    registry.register(echo, async () => 'x'.repeat(200));

    await drain(streamingQuery(client, registry, 'continue', {
      systemPrompt: 'sys',
      tools: registry.getDefinitions(),
      signal: new AbortController().signal,
      maxTurns: 6,
      enableStreamingExecution: false,
    }));

    expect(client.streamCallCount).toBe(5);
  });
});
