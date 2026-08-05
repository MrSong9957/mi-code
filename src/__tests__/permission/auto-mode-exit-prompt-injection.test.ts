// Task 12 blocker: 证明真实 Agent prompt/request 链消费 auto_mode_exit attachment
//
// 生产路径：
//   transitionPermissionMode(auto→build) → state.exitAuto() → _attachments 入队
//   → index.ts 调 streamingQuery 前 takeAttachments → 渲染为文本追加到 systemPrompt
//   → streamingQuery → queryEngine → client.stream({ systemPrompt }) 到达 provider
//
// 本测试模拟真实路径：构造 sessionState，做 auto→build transition，
// 然后验证 streamingQuery 收到的 systemPrompt 包含 attachment 文本。
// 消费后下一次不再携带。static system prompt 不因 transition 改变。
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

// ─── mock client：记录收到的 systemPrompt ─────────────────────────────────────

class SystemPromptCapturingClient implements StreamingLLMClient {
  readonly capturedSystemPrompts: string[] = [];

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    this.capturedSystemPrompts.push(options.systemPrompt);
    // 立即返回一个 end_turn 响应
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
beforeEach(() => {
  sleepSpy = vi.spyOn(backoffModule, 'sleep').mockResolvedValue(undefined);
});
afterEach(() => { sleepSpy?.mockRestore(); });

// ─── 生产路径：auto→build transition 后 systemPrompt 携带 attachment ──────────

describe('auto_mode_exit attachment consumed by real streamingQuery path', () => {
  const BASE_SYSTEM_PROMPT = 'You are MiCode, a coding agent.';

  test('transition auto→build: next streamingQuery systemPrompt contains auto_mode_exit text', async () => {
    const sessionState = new SessionState(new SessionAllowlist(), 's1');
    // 进入 auto
    sessionState.applyPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    // 退出 auto → build（触发 exitAuto 入队）
    transitionPermissionMode(sessionState, 'build', 'session');

    // 模拟 index.ts 生产路径：调用前取 attachment 渲染
    const attachments = sessionState.takeAttachments();
    const attachmentText = renderAttachmentsForPrompt(attachments);
    const systemPrompt = attachmentText
      ? `${BASE_SYSTEM_PROMPT}\n\n---\n\n${attachmentText}`
      : BASE_SYSTEM_PROMPT;

    // 验证 attachment 已入队且渲染
    expect(attachments).toEqual([{ type: 'auto_mode_exit' }]);
    expect(systemPrompt).toContain('exited auto');
    // 更重要：验证真实 streamingQuery 把它传到 provider
    const client = new SystemPromptCapturingClient();
    await consumeStream(streamingQuery(client, new ToolRegistry(), 'hello', {
      systemPrompt,
      tools: [],
      signal: new AbortController().signal,
      maxTurns: 1,
    }));
    expect(client.capturedSystemPrompts).toHaveLength(1);
    expect(client.capturedSystemPrompts[0]).toContain('exited auto');
  });

  test('attachment consumed: second request after takeAttachments has no attachment text', async () => {
    const sessionState = new SessionState(new SessionAllowlist(), 's1');
    sessionState.applyPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    transitionPermissionMode(sessionState, 'build', 'session');

    // 第一次：取并消费 attachment
    const firstAttachments = sessionState.takeAttachments();
    expect(firstAttachments).toHaveLength(1);

    // 第二次：takeAttachments 已清空，不再有 attachment
    const secondAttachments = sessionState.takeAttachments();
    expect(secondAttachments).toEqual([]);
    const systemPrompt = BASE_SYSTEM_PROMPT; // 无 attachment 追加

    const client = new SystemPromptCapturingClient();
    await consumeStream(streamingQuery(client, new ToolRegistry(), 'hello', {
      systemPrompt,
      tools: [],
      signal: new AbortController().signal,
      maxTurns: 1,
    }));
    expect(client.capturedSystemPrompts[0]).toBe(BASE_SYSTEM_PROMPT);
    expect(client.capturedSystemPrompts[0]).not.toContain('auto_mode_exit');
  });

  test('static system prompt base unchanged: attachment appended after separator', async () => {
    const sessionState = new SessionState(new SessionAllowlist(), 's1');
    sessionState.applyPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    transitionPermissionMode(sessionState, 'build', 'session');

    const attachments = sessionState.takeAttachments();
    const attachmentText = renderAttachmentsForPrompt(attachments);
    const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n---\n\n${attachmentText}`;

    // static 部分完整保留在前面
    expect(systemPrompt.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    // attachment 在分隔符之后
    const parts = systemPrompt.split('\n\n---\n\n');
    expect(parts[0]).toBe(BASE_SYSTEM_PROMPT); // static 不变
    expect(parts.length).toBe(2); // 有动态部分
    expect(parts[1]).toContain('exited auto');
  });

  test('no transition (staying in build) produces no attachment', async () => {
    const sessionState = new SessionState(new SessionAllowlist(), 's1');
    // 从未进入 auto，直接 build
    expect(sessionState.takeAttachments()).toEqual([]);
    const systemPrompt = BASE_SYSTEM_PROMPT;

    const client = new SystemPromptCapturingClient();
    await consumeStream(streamingQuery(client, new ToolRegistry(), 'hello', {
      systemPrompt,
      tools: [],
      signal: new AbortController().signal,
      maxTurns: 1,
    }));
    expect(client.capturedSystemPrompts[0]).not.toContain('auto_mode_exit');
  });
});
