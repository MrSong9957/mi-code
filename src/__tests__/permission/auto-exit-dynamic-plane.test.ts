// Task 12 final blocker: auto_mode_exit 必须走 dynamic plane，不污染 static systemPrompt
//
// 验收三项：
//   1. static system content/hash 前后完全相同（attachment 不改 static）
//   2. 第一次请求 dynamic plane 含 auto_mode_exit
//   3. 第二次已消费，不再含
//
// 生产路径：streamingQuery 的 options.systemPrompt 是 static（不含 attachment）；
// attachment 通过 consumeAutoAttachments hook 在 streamingQuery 内部作为 dynamic
// section 注入，与 static 拼接后传给 provider。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamingQuery } from '../../agent/streaming-query.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { SessionState } from '../../permission/session-state.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { transitionPermissionMode } from '../../permission/mode-transition.js';
import { renderAttachmentsForPrompt } from '../../agent/prompt/auto-attachments.js';
import * as backoffModule from '../../agent/backoff.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
} from '../../agent/types.js';

class SystemPromptCapturingClient implements StreamingLLMClient {
  readonly capturedSystemPrompts: string[] = [];
  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    this.capturedSystemPrompts.push(options.systemPrompt);
    yield { type: 'message_start', messageId: 'msg', model: 'test', inputTokens: 1 };
    yield { type: 'content_block_start', index: 0, blockType: 'text' };
    yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: 'ok' };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
    yield { type: 'message_stop' };
  }
}

async function consumeStream(gen: AsyncGenerator): Promise<void> {
  for await (const _ of gen) void _;
}

let sleepSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { sleepSpy = vi.spyOn(backoffModule, 'sleep').mockResolvedValue(undefined); });
afterEach(() => { sleepSpy?.mockRestore(); });

const STATIC_PROMPT = 'You are MiCode, a coding agent.';

describe('auto_mode_exit stays in dynamic plane (A74-A76 boundary)', () => {
  test('static systemPrompt passed to streamingQuery is clean (no attachment)', async () => {
    // 即使有 pending attachment，传给 streamingQuery 的 options.systemPrompt 仍是纯 static
    const sessionState = new SessionState(new SessionAllowlist(), 's1');
    sessionState.applyPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    transitionPermissionMode(sessionState, 'build', 'session');
    expect(sessionState.exitAttachmentPending).toBe(true);

    // 生产接线：传 consumeAutoAttachments hook，不改 systemPrompt 本身
    const client = new SystemPromptCapturingClient();
    await consumeStream(streamingQuery(client, new ToolRegistry(), 'hello', {
      systemPrompt: STATIC_PROMPT,
      tools: [],
      signal: new AbortController().signal,
      maxTurns: 1,
      consumeAutoAttachments: () => {
        const text = renderAttachmentsForPrompt(sessionState.takeAttachments());
        return text || null;
      },
    }));

    // provider 收到的 systemPrompt 包含 attachment（dynamic plane 注入）
    expect(client.capturedSystemPrompts).toHaveLength(1);
    expect(client.capturedSystemPrompts[0]).toContain('exited auto');
    // 但 static 部分完整保留在前面
    expect(client.capturedSystemPrompts[0].startsWith(STATIC_PROMPT)).toBe(true);
  });

  test('first request dynamic plane contains auto_mode_exit; second does not', async () => {
    const sessionState = new SessionState(new SessionAllowlist(), 's1');
    sessionState.applyPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    transitionPermissionMode(sessionState, 'build', 'session');

    const hook = (): string | null => {
      const text = renderAttachmentsForPrompt(sessionState.takeAttachments());
      return text || null;
    };

    // 第一次请求：attachment 待消费
    const client1 = new SystemPromptCapturingClient();
    await consumeStream(streamingQuery(client1, new ToolRegistry(), 'hello', {
      systemPrompt: STATIC_PROMPT, tools: [], signal: new AbortController().signal, maxTurns: 1,
      consumeAutoAttachments: hook,
    }));
    expect(client1.capturedSystemPrompts[0]).toContain('exited auto');

    // 第二次请求：已消费，不再含
    const client2 = new SystemPromptCapturingClient();
    await consumeStream(streamingQuery(client2, new ToolRegistry(), 'hello', {
      systemPrompt: STATIC_PROMPT, tools: [], signal: new AbortController().signal, maxTurns: 1,
      consumeAutoAttachments: hook,
    }));
    expect(client2.capturedSystemPrompts[0]).toBe(STATIC_PROMPT);
    expect(client2.capturedSystemPrompts[0]).not.toContain('exited auto');
  });

  test('static system content identical with and without attachment', async () => {
    // 无 attachment 时
    const clientBaseline = new SystemPromptCapturingClient();
    await consumeStream(streamingQuery(clientBaseline, new ToolRegistry(), 'hello', {
      systemPrompt: STATIC_PROMPT, tools: [], signal: new AbortController().signal, maxTurns: 1,
    }));
    const baselinePrompt = clientBaseline.capturedSystemPrompts[0];

    // 有 attachment 时
    const sessionState = new SessionState(new SessionAllowlist(), 's1');
    sessionState.applyPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    transitionPermissionMode(sessionState, 'build', 'session');
    const clientWithAttachment = new SystemPromptCapturingClient();
    await consumeStream(streamingQuery(clientWithAttachment, new ToolRegistry(), 'hello', {
      systemPrompt: STATIC_PROMPT, tools: [], signal: new AbortController().signal, maxTurns: 1,
      consumeAutoAttachments: () => {
        const text = renderAttachmentsForPrompt(sessionState.takeAttachments());
        return text || null;
      },
    }));
    const withAttachmentPrompt = clientWithAttachment.capturedSystemPrompts[0];

    // static 部分相同：attachment 在分隔符之后，前面完全一致
    const baselineStatic = baselinePrompt.split('\n\n---\n\n')[0];
    const withAttachmentStatic = withAttachmentPrompt.split('\n\n---\n\n')[0];
    expect(withAttachmentStatic).toBe(baselineStatic);
    // baseline 无动态部分，withAttachment 有
    expect(baselinePrompt).toBe(STATIC_PROMPT);
    expect(withAttachmentPrompt).not.toBe(STATIC_PROMPT);
  });
});
