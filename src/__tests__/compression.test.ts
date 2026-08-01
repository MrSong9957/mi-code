// 上下文压缩测试
import { describe, it, expect } from 'vitest';
import {
  snipCompact,
  microCompact,
  compactHistory,
  compactHistoryWithLLM,
  runCompaction,
  estimateContextSize,
  needsCompaction,
  persistLargeOutput,
} from '../agent/compression.js';
import type { Message, ContentBlock, StreamingLLMClient, StreamEvent, AssistantMessage, ToolDefinition, StreamOptions } from '../agent/types.js';

function makeMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: text };
}

function makeToolResult(toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content } as ContentBlock],
  };
}

function makeToolUse(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} } as ContentBlock],
  };
}

describe('snipCompact', () => {
  it('should not modify messages below threshold', () => {
    const messages = [makeMsg('user', 'hello')];
    expect(snipCompact(messages)).toEqual(messages);
  });

  it('should snip old messages when count exceeds 50', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));

    const result = snipCompact(messages);

    expect(result.length).toBe(51); // 前3 + snip标记 + 后47
    expect(result[3]).toEqual({ role: 'user', content: '[snipped 10 messages...]' });
  });

  it('should keep first 3 messages intact', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));

    const result = snipCompact(messages);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
    expect(result[2]).toEqual(messages[2]);
  });

  it('should keep a pair intact when the fixed head would split it', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));
    messages[2] = makeToolUse('call_head', 'bash');
    messages[10] = makeToolResult('call_head', 'output');

    const compacted = snipCompact(messages);
    const ids = compacted.flatMap(message =>
      Array.isArray(message.content)
        ? message.content.flatMap(block => {
            if (block.type === 'tool_use') return [block.id];
            if (block.type === 'tool_result') return [block.tool_use_id];
            return [];
          })
        : [],
    );

    expect(ids.filter(id => id === 'call_head')).toHaveLength(2);
  });

  it('should keep a pair intact when the tail boundary would split it', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));
    messages[10] = makeToolUse('call_tail', 'bash');
    messages[14] = makeToolResult('call_tail', 'output');

    const compacted = snipCompact(messages);
    const ids = compacted.flatMap(message =>
      Array.isArray(message.content)
        ? message.content.flatMap(block => {
            if (block.type === 'tool_use') return [block.id];
            if (block.type === 'tool_result') return [block.tool_use_id];
            return [];
          })
        : [],
    );

    expect(ids.filter(id => id === 'call_tail')).not.toHaveLength(1);
  });
});

describe('microCompact', () => {
  it('should not modify when tool results <= 3', () => {
    const messages = [
      makeToolResult('r1', 'short'),
      makeToolResult('r2', 'short'),
      makeToolResult('r3', 'short'),
    ];
    expect(microCompact(messages)).toEqual(messages);
  });

  it('should compact old tool result content without deleting its identity', () => {
    const longContent = 'x'.repeat(200);
    const messages = [
      makeToolResult('r1', longContent),
      makeToolResult('r2', longContent),
      makeToolResult('r3', longContent),
      makeToolResult('r4', 'keep'),
      makeToolResult('r5', 'keep'),
      makeToolResult('r6', 'keep'),
    ];

    const compacted = microCompact(messages);
    const first = (compacted[0]!.content as ContentBlock[])[0]!;

    expect(first).toEqual({
      type: 'tool_result',
      tool_use_id: 'r1',
      content: '[Earlier tool result compacted. Re-run if needed.]',
    });
    expect(compacted[3]).toEqual(messages[3]);
  });

  it('should preserve every tool_use_id in a compacted parallel result message', () => {
    const parallel: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'spawn_1', content: 'x'.repeat(200) },
        { type: 'tool_result', tool_use_id: 'spawn_2', content: 'y'.repeat(200) },
      ],
    };
    const messages = [
      parallel,
      makeToolResult('r2', 'x'.repeat(200)),
      makeToolResult('r3', 'x'.repeat(200)),
      makeToolResult('r4', 'keep'),
    ];

    const compacted = microCompact(messages);
    const blocks = compacted[0]!.content as ContentBlock[];

    expect(blocks).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'spawn_1',
        content: '[Earlier tool result compacted. Re-run if needed.]',
      },
      {
        type: 'tool_result',
        tool_use_id: 'spawn_2',
        content: '[Earlier tool result compacted. Re-run if needed.]',
      },
    ]);
  });

  it('should not compact short old results', () => {
    const messages = [
      makeToolResult('r1', 'short'),
      makeToolResult('r2', 'short'),
      makeToolResult('r3', 'short'),
      makeToolResult('r4', 'keep'),
      makeToolResult('r5', 'keep'),
      makeToolResult('r6', 'keep'),
    ];
    expect(microCompact(messages)).toEqual(messages);
  });
});

describe('compactHistory', () => {
  it('should return single summary message', () => {
    const messages = [
      makeMsg('user', 'Build a CLI tool'),
      makeMsg('assistant', 'I will create the files.'),
    ];

    const result = compactHistory(messages);

    expect(result.length).toBe(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.content).toContain('compacted for continuity');
  });
});

describe('runCompaction', () => {
  it('should apply snip and micro compact', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));

    const { messages: result, needsL4 } = runCompaction(messages);

    expect(result.length).toBeLessThan(60);
    expect(typeof needsL4).toBe('boolean');
  });

  it('should not modify small message sets', () => {
    const messages = [makeMsg('user', 'hello')];
    const { messages: result, needsL4 } = runCompaction(messages);

    expect(result).toEqual(messages);
    expect(needsL4).toBe(false);
  });
});

describe('estimateContextSize', () => {
  it('should estimate string content', () => {
    expect(estimateContextSize([makeMsg('user', 'hello')])).toBe(5);
  });

  it('should estimate block content', () => {
    expect(estimateContextSize([makeToolResult('r1', 'output text')])).toBe(11);
  });

  it('image block: 计入估算(非零),避免压缩永不触发', () => {
    const imgData = 'a'.repeat(3000); // 模拟 base64 数据
    const msg: Message = {
      role: 'user',
      content: [{ type: 'image', mediaType: 'image/png', data: imgData } as ContentBlock],
    };
    const size = estimateContextSize([msg]);
    // 图片必须被计入(非零),具体公式是 base64长度/300
    expect(size).toBeGreaterThan(0);
    expect(size).toBe(10); // ceil(3000/300)
  });

  it('image + text 混合:两者都计入', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', data: 'a'.repeat(600) } as ContentBlock,
        { type: 'text', text: 'hello' } as ContentBlock,
      ],
    };
    const size = estimateContextSize([msg]);
    expect(size).toBe(7); // ceil(600/300)=2 + 'hello'=5
  });
});

describe('needsCompaction', () => {
  it('should return false for small context', () => {
    expect(needsCompaction([makeMsg('user', 'hello')])).toBe(false);
  });

  it('should return true for large context', () => {
    expect(needsCompaction([makeMsg('user', 'x'.repeat(200000))])).toBe(true);
  });
});

describe('persistLargeOutput', () => {
  it('should return output unchanged if below threshold', () => {
    expect(persistLargeOutput('test', 'short')).toBe('short');
  });
});

// ═══════════════════════════════════════════════════════════════
// compactHistoryWithLLM：用小模型生成真实摘要（带本地回退）
// ═══════════════════════════════════════════════════════════════

/**
 * 假的 StreamingLLMClient。
 * 物理本质：一个会"按剧本说话"的假翻译官——
 * 你提前把要说的话（摘要文本）写在剧本里，它就照着念出来。
 */
class FakeStreamClient implements StreamingLLMClient {
  constructor(
    /** 剧本：要念的摘要文本。设为 null 表示"念到一半出错"（抛异常）。 */
    private script: string | null,
  ) {}

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    if (this.script === null) {
      throw new Error('simulated API failure');
    }
    // 模拟流式：message_start → content_block_start → delta(s) → stop → message_stop
    yield { type: 'message_start', messageId: 'msg_1', model: 'mimo-v2.5', inputTokens: 10 };
    yield { type: 'content_block_start', index: 0, blockType: 'text' };
    // 把摘要切成几段，模拟逐 token 流式
    const chunks = this.script.match(/.{1,8}/g) ?? [this.script];
    for (const chunk of chunks) {
      yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: chunk };
    }
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: chunks.length };
    yield { type: 'message_stop' };
  }
}

describe('compactHistoryWithLLM', () => {
  it('应使用小模型返回的摘要文本', async () => {
    const messages = [
      makeMsg('user', '帮我建一个 CLI'),
      makeMsg('assistant', '好的，我来创建文件。'),
    ];
    const client = new FakeStreamClient('用户想建 CLI，助手开始创建文件。');

    const result = await compactHistoryWithLLM(messages, client);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    // 摘要文本应在压缩后的消息里
    expect(typeof result[0]!.content === 'string').toBe(true);
    expect(result[0]!.content as string).toContain('用户想建 CLI');
  });

  it('client 抛错时应回退到本地启发式摘要，绝不崩溃', async () => {
    const messages = [
      makeMsg('user', '做任务 A'),
      makeMsg('assistant', '正在做 A'),
    ];
    const client = new FakeStreamClient(null); // 会抛错

    const result = await compactHistoryWithLLM(messages, client);

    // 回退路径：产出含"compacted for continuity"的本地摘要消息
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.content).toContain('compacted for continuity');
  });

  it('压缩消息应保持连续性前缀（让下一轮 AI 知道这是历史摘要）', async () => {
    const messages = [makeMsg('user', 'hello')];
    const client = new FakeStreamClient('打招呼的对话。');

    const result = await compactHistoryWithLLM(messages, client);

    expect(result[0]!.content).toContain('compacted for continuity');
  });

  // ★ 阻断 A 防御:compactHistoryWithLLM 自身必须保证 uiOnly block 不进 compact model。
  // 不依赖调用方提前 sanitize(防御性纵深)。
  it('含 uiOnly 状态块的 messages → compact client 收到的输入不含状态块文本/metadata', async () => {
    // 捕获型 client:记录 stream() 收到的 messages,返回最小摘要
    const captured: Message[] = [];
    const capturingClient: StreamingLLMClient = {
      async *stream(messages: Message[]) {
        captured.push(...JSON.parse(JSON.stringify(messages)));
        yield { type: 'message_start', messageId: 'm1', model: 'small', inputTokens: 1 };
        yield { type: 'content_block_start', index: 0, blockType: 'text' };
        yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: '摘要' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
        yield { type: 'message_stop' };
      },
    };

    // 构造含 uiOnly 状态块的 messages(模拟落盘的 sessionMessages)
    const messages: Message[] = [
      { role: 'user', content: 'do task' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '正常回复正文' },
          { type: 'text', text: '当前状态：部分完成\n失败或受阻位置：The user rejected this action.', uiOnly: true },
        ],
      },
    ];

    await compactHistoryWithLLM(messages, capturingClient);

    // compact client 收到的输入(经 serializeMessagesForSummary 序列化成字符串)
    const capturedJson = JSON.stringify(captured);
    // ★ 状态块文本不可见
    expect(capturedJson).not.toContain('当前状态');
    expect(capturedJson).not.toContain('The user rejected');
    // ★ uiOnly metadata 不可见
    expect(capturedJson).not.toContain('uiOnly');
    // ★ 正常正文保留
    expect(capturedJson).toContain('正常回复正文');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Wave G Task 3 (M-049 / GRC-1 §7.5) — Compaction Result Adapter。
//
// 这一段只测试 createCompactionResultSnapshot / validateCompactSummaryShape
// 两个 adapter helper。它们不调用任何 compactor —— compactor 输出已作为
// 输入传入。adapter 只做形状校验和 hash/bytes/lines 计算。
//
// 不变式(spec §7.5):
//   - Summary 必须是 user role + string content。
//   - adapter 不评价 summary 质量,不接管 M-031。
//   - adapter 不读取 transcript 正文,只接受 compacted_summary_message。
//   - 相同输入产生相同 compaction_result_id(deterministic)。
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import {
  capturePreCompactSnapshot,
  createCompactionResultSnapshot,
  createReconstructionPolicy,
  runReconstructionPreflight,
  validateCompactSummaryShape,
  COMPACT_RESULT_PROTOCOL_VERSION,
  type CompactionResultInput,
  type PreflightInput,
} from '../agent/context/reconstruction.js';
import type {
  ToolTranscriptValidation,
  ToolTranscriptSnapshot,
} from '../agent/tools/transcript-validator.js';
import type { DurableAcknowledgement } from '../session/store.js';

// ---- 公共 helpers (与 preflight 测试同构) ----

function grcPolicyIdentity() {
  return {
    policy_id: 'mi.reconstruction.policy:default',
    policy_version: '1.0.0',
    request_budget_policy_ref: 'mi.budget/1:default',
  };
}

function grcCaptureInput() {
  return {
    session_id: 'sess:abc',
    turn_id: 'turn:1',
    task_snapshot_id: 'task:snap-1',
    current_context_snapshot_id: 'ctx:before-compact',
    project_version_ref: 'proj:sha-1',
    transcript_snapshot_id: 'tx:snap-1',
    current_user_message_ref: 'msg:user-1',
    current_user_message_hash: '0'.repeat(64),
    active_project_activation_refs: ['act:proj-a'],
    active_meta_lifecycle_refs: ['life:meta-a'],
    memory_entrypoint_snapshot_ref: 'entry:mem-1',
    execution_state_refs: ['exec:state-1'],
    request_budget_snapshot_id: 'budget:snap-1',
    captured_at: '2026-07-26T00:00:00.000Z',
  };
}

function grcTranscriptSnapshot(): ToolTranscriptSnapshot {
  return {
    transcript_snapshot_id: 'tx:snap-1',
    session_id: 'sess:abc',
    turn_id: 'turn:1',
    messages: [{ role: 'user', content: 'hello' }],
  };
}

function grcValidation(
  overrides: Partial<ToolTranscriptValidation> = {},
): ToolTranscriptValidation {
  return {
    validation_protocol_version: '1',
    validation_id: 'tv:preflight-1',
    transcript_snapshot_id: 'tx:snap-1',
    checkpoint: 'before_compaction',
    status: 'accepted',
    validator_policy_id: 'mi.transcript.policy:default',
    validator_policy_version: '1.0.0',
    pair_records: [],
    reason_codes: [],
    ...overrides,
  };
}

function grcDurableAck(
  overrides: Partial<DurableAcknowledgement> = {},
): DurableAcknowledgement {
  return {
    ack_protocol_version: 'mi.durable/1',
    ack_id: 'durable:abc',
    record_id: 'precompact:xyz',
    session_id: 'sess:abc',
    committed_at: '2026-07-26T00:00:00.000Z',
    sidecar_ref: 'reconstruction.jsonl',
    ...overrides,
  };
}

/** 构造一份全绿的 PreflightInput(用于喂 createCompactionResultSnapshot)。 */
function grcAcceptedPreflightInput(): PreflightInput {
  return {
    precompact: capturePreCompactSnapshot(grcCaptureInput()),
    transcript_snapshot: grcTranscriptSnapshot(),
    validation: grcValidation(),
    precompact_durable_ack: grcDurableAck(),
    policy: createReconstructionPolicy(grcPolicyIdentity()),
    request_budget_snapshot_id: 'budget:snap-1',
    idempotency_key: 'recon-idem:deadbeef',
  };
}

function expectedSha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ===========================================================================
// validateCompactSummaryShape — text-only shape gate (spec §7.5 rule 8)
// ===========================================================================

describe('validateCompactSummaryShape — text-only shape validator (spec §7.5 rule 8)', () => {
  it('accepts a valid user string message', () => {
    const result = validateCompactSummaryShape({
      role: 'user',
      content: 'compacted for continuity. summary text.',
    });
    expect(result.status).toBe('accepted');
    expect(result.reason_codes).toEqual([]);
    expect(result.shape_validation_protocol_version).toBe('mi.summary_shape/1');
    expect(result.shape_validation_id).toMatch(/^summary_shape:[0-9a-f]{16}$/);
  });

  it('rejects assistant role', () => {
    const result = validateCompactSummaryShape({
      role: 'assistant',
      content: 'whatever',
    });
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('summary_shape.not_user_role');
  });

  it('rejects ContentBlock[] content', () => {
    const result = validateCompactSummaryShape({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('summary_shape.content_not_string');
  });

  it('rejects empty string content', () => {
    const result = validateCompactSummaryShape({
      role: 'user',
      content: '',
    });
    expect(result.status).toBe('rejected');
    expect(result.reason_codes).toContain('summary_shape.empty_content');
  });

  it('does NOT do semantic checks: claim-like summary text is still shape-accepted', () => {
    // 规格 §7.5 rule 3-4: summary 不能证明 action 已成功 / 不能替代 result。
    // 但 shape validator 只看形状,不判语义 —— 这种 "claim-like" 文本应 accepted。
    // 后续 postflight / M-031 才做语义判断。
    const samples = [
      'tool succeeded',
      'permission granted',
      'memory verified',
      'action completed',
      'file written',
    ];
    for (const s of samples) {
      const result = validateCompactSummaryShape({ role: 'user', content: s });
      expect(result.status).toBe('accepted');
    }
  });

  it('is deterministic: same message produces same shape_validation_id', () => {
    const msg = { role: 'user' as const, content: 'hello world' };
    const a = validateCompactSummaryShape(msg);
    const b = validateCompactSummaryShape(msg);
    expect(a.shape_validation_id).toBe(b.shape_validation_id);
  });
});

// ===========================================================================
// createCompactionResultSnapshot — adapter (spec §7.5)
// ===========================================================================

describe('createCompactionResultSnapshot — adapter (spec §7.5)', () => {
  function baseInput(
    overrides: Partial<CompactionResultInput> = {},
  ): CompactionResultInput {
    const preflight = runReconstructionPreflight(grcAcceptedPreflightInput());
    return {
      precompact: grcAcceptedPreflightInput().precompact,
      preflight,
      compacted_summary_message: {
        role: 'user',
        content: 'This conversation was compacted for continuity.\n\nSummary body.',
      },
      method: 'deterministic_local',
      method_version: 'l1l2.v1',
      compactor_ack_payload: 'compactor-call:2026-07-26T00:00:00Z|client=v1',
      created_at: '2026-07-26T00:00:00.000Z',
      ...overrides,
    };
  }

  it('produces a complete snapshot with all fields populated', () => {
    const input = baseInput();
    const result = createCompactionResultSnapshot(input);

    expect(result.compaction_result_protocol_version).toBe(
      COMPACT_RESULT_PROTOCOL_VERSION,
    );
    expect(result.compaction_result_id).toMatch(/^comp:[0-9a-f]{16}$/);
    expect(result.precompact_snapshot_id).toBe(input.precompact.precompact_snapshot_id);
    expect(result.source_transcript_snapshot_id).toBe(
      input.precompact.transcript_snapshot_id,
    );
    expect(result.preflight_validation_id).toBe(input.preflight.validation_id);
    expect(result.method).toBe('deterministic_local');
    expect(result.method_version).toBe('l1l2.v1');
    expect(result.compact_summary_ref).toMatch(/^summary:[0-9a-f]{16}$/);
    expect(result.created_at).toBe('2026-07-26T00:00:00.000Z');
    // compactor_ack_ref 形如 'compactor.ack:<16 hex>'
    expect(result.compactor_ack_ref).toMatch(/^compactor\.ack:[0-9a-f]{16}$/);
  });

  it('throws when summary message has assistant role', () => {
    const input = baseInput({
      compacted_summary_message: { role: 'assistant', content: 'oops' },
    });
    expect(() => createCompactionResultSnapshot(input)).toThrow(
      'compaction_result.summary_shape_invalid',
    );
  });

  it('throws when summary content is ContentBlock[]', () => {
    const input = baseInput({
      compacted_summary_message: {
        role: 'user',
        content: [{ type: 'text', text: 'oops' }],
      },
    });
    expect(() => createCompactionResultSnapshot(input)).toThrow(
      'compaction_result.summary_shape_invalid',
    );
  });

  it('throws when summary content is empty string', () => {
    const input = baseInput({
      compacted_summary_message: { role: 'user', content: '' },
    });
    expect(() => createCompactionResultSnapshot(input)).toThrow(
      'compaction_result.summary_shape_invalid',
    );
  });

  it('computes compact_summary_hash === sha256(content)', () => {
    const summaryText = 'This conversation was compacted for continuity.\n\nSummary body.';
    const input = baseInput({
      compacted_summary_message: { role: 'user', content: summaryText },
    });
    const result = createCompactionResultSnapshot(input);
    expect(result.compact_summary_hash).toBe(expectedSha256Hex(summaryText));
  });

  it('computes compact_summary_bytes === Buffer.byteLength(content, "utf8")', () => {
    // 多字节字符以验证 utf8 而非 utf16
    const summaryText = 'café 中文 emoji 🎉';
    const input = baseInput({
      compacted_summary_message: { role: 'user', content: summaryText },
    });
    const result = createCompactionResultSnapshot(input);
    expect(result.compact_summary_bytes).toBe(Buffer.byteLength(summaryText, 'utf8'));
  });

  it('computes compact_summary_lines correctly (single=1, multi=N)', () => {
    // 注: empty content 会触发 shape reject(走单独的 throw 测试),
    // 因此这里只测 single / multi。lines 用 \n 分割。
    // single line
    const singleInput = baseInput({
      compacted_summary_message: { role: 'user', content: 'one line' },
    });
    expect(createCompactionResultSnapshot(singleInput).compact_summary_lines).toBe(1);
    // multi line
    const multiInput = baseInput({
      compacted_summary_message: {
        role: 'user',
        content: 'line1\nline2\nline3',
      },
    });
    expect(createCompactionResultSnapshot(multiInput).compact_summary_lines).toBe(3);
  });

  it('forwards method_version unchanged (both l1l2.v1 and l4.v1)', () => {
    const a = createCompactionResultSnapshot(
      baseInput({ method: 'deterministic_local', method_version: 'l1l2.v1' }),
    );
    expect(a.method).toBe('deterministic_local');
    expect(a.method_version).toBe('l1l2.v1');

    const b = createCompactionResultSnapshot(
      baseInput({ method: 'model_summary', method_version: 'l4.v1' }),
    );
    expect(b.method).toBe('model_summary');
    expect(b.method_version).toBe('l4.v1');
  });

  it('computes compactor_ack_ref as compactor.ack:<sha256(payload).slice(0,16)>', () => {
    const payload = 'compactor-call:2026-07-26T00:00:00Z|client=v1';
    const input = baseInput({ compactor_ack_payload: payload });
    const result = createCompactionResultSnapshot(input);
    const expectedHash = expectedSha256Hex(payload).slice(0, 16);
    expect(result.compactor_ack_ref).toBe(`compactor.ack:${expectedHash}`);
  });

  it('throws when source_transcript_snapshot_id mismatches preflight', () => {
    // 冗余保险:preflight 已通过,但 adapter 再次校验 transcript id 一致性
    const base = baseInput();
    // 故意把 precompact.transcript_snapshot_id 与 preflight 的 transcript_snapshot_id 改成不同
    const tamperedPrecompact = {
      ...base.precompact,
      transcript_snapshot_id: 'tx:different',
    } as typeof base.precompact;
    const input: CompactionResultInput = { ...base, precompact: tamperedPrecompact };
    expect(() => createCompactionResultSnapshot(input)).toThrow();
  });

  it('is deterministic: same inputs produce same compaction_result_id', () => {
    const a = createCompactionResultSnapshot(baseInput());
    const b = createCompactionResultSnapshot(baseInput());
    expect(a.compaction_result_id).toBe(b.compaction_result_id);
  });

  it('deep-freezes the returned snapshot', () => {
    const result = createCompactionResultSnapshot(baseInput());
    expect(Object.isFrozen(result)).toBe(true);
  });
});
