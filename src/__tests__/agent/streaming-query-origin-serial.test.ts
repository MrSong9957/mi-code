// src/__tests__/agent/streaming-query-origin-serial.test.ts
//
// C1/🟡-1 修复:legacy 串行路径(enableStreamingExecution:false)必须透传 origin。
// 子代理走串行路径时,origin 必须保留为 'subagent',使 applySubagentSilentPolicy 生效,
// build_write ask 静默 allow(不弹 channel)。若漏传 origin,会被当 main 弹 channel。

import { describe, it, expect } from 'vitest';
import { streamingQuery } from '../../agent/streaming-query.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import {
  SECURITY_PROTOCOL_VERSION,
  type SecurityDecision, type UserDecision,
} from '../../permission/decisions.js';
import type { StreamingLLMClient, Message, StreamEvent, AssistantMessage } from '../../agent/types.js';

class MemStore { async save() {} async load() { return []; } async update() {} }

class ControllableChannel {
  public requests: SecurityDecision[] = [];
  private resolver: ((u: UserDecision) => void) | null = null;
  async request(d: SecurityDecision) {
    this.requests.push(d);
    return new Promise<UserDecision>(resolve => { this.resolver = resolve; });
  }
  resolveApproved(id: string) {
    const r = this.resolver!; this.resolver = null;
    r({ protocol_version: SECURITY_PROTOCOL_VERSION, decision_id: id, response: 'approved_once', decided_at: new Date().toISOString() });
  }
}

/** ScriptedClient:第一轮返回 tool_use(write_file),第二轮返回 text(end_turn) */
class ScriptedClient implements StreamingLLMClient {
  constructor(private turns: AssistantMessage[][]) {}
  async *stream(): AsyncGenerator<StreamEvent | AssistantMessage> {
    const turn = this.turns.shift();
    if (!turn) return;
    yield { type: 'message_start', messageId: 'm1', model: 'test', inputTokens: 1 };
    for (const block of turn) {
      if (block.content[0] && block.content[0].type === 'text') {
        yield { type: 'content_block_start', index: 0, blockType: 'text' };
        yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: (block.content[0] as { text: string }).text };
        yield { type: 'content_block_stop', index: 0 };
      }
    }
    yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
    yield { type: 'message_stop' };
    yield turn[0]!;
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { void _; }
}

describe('streamingQuery legacy 串行路径 origin 透传', () => {
  it('origin=subagent + enableStreamingExecution:false → write_file 静默 allow,不弹 channel', async () => {
    // build 模式 write_file → ask(user_confirmation_required)
    // 子代理 origin → applySubagentSilentPolicy 改写为 allow → 不弹 channel
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const ch = new ControllableChannel();
    const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: ch });
    const executionRuntime = { permissionChecker: checker, runtimeGate: gate };

    let executed = false;
    const registry = new ToolRegistry();
    registry.register(
      { name: 'write_file', description: 'p', parameters: { type: 'object', properties: {}, required: [] } },
      async () => { executed = true; return 'written'; },
    );

    const client = new ScriptedClient([
      [{ type: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a.txt', content: 'x' } }], usage: { input_tokens: 1, output_tokens: 1 }, stopReason: 'tool_use', uuid: 'a1', timestamp: new Date().toISOString() }] as any,
    ]);

    await drain(streamingQuery(client, registry, 'do task', {
      systemPrompt: 'test',
      tools: registry.getDefinitions(),
      signal: new AbortController().signal,
      executionRuntime,
      origin: 'subagent',             // ★ 子代理 origin
      enableStreamingExecution: false, // ★ 强制走 legacy 串行路径
    }));

    // ★ origin 正确透传 → 子代理 silent policy 生效 → 静默 allow,执行了,channel 未弹
    expect(executed).toBe(true);
    expect(ch.requests).toHaveLength(0); // ★ 不弹 UI
  });
});
