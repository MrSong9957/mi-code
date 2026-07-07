// 一次性冒烟脚本：验证 plan 模式在流式主路径下拦截 write_file
// 用法： npx tsx scripts/smoke-plan-mode.ts
//
// 不依赖真实 LLM：自己构造一个 fake StreamingLLMClient 直接吐 tool_use 块。
// 这样能跑出 streamingQuery 真实代码路径，又不花 API 额度。
import 'dotenv/config';
import { streamingQuery } from '../src/agent/streaming-query.js';
import { ToolRegistry } from '../src/agent/tool-registry.js';
import { PermissionChecker } from '../src/permission/checker.js';
import type {
  StreamingLLMClient, Message, ToolDefinition, StreamEvent, AssistantMessage, StreamOptions,
} from '../src/agent/types.js';

// fake client：第一轮吐 write_file 工具调用，第二轮吐纯文本结束
class FakeClient implements StreamingLLMClient {
  private call = 0;
  async *stream(_m: Message[], _t: ToolDefinition[], _o: StreamOptions):
    AsyncGenerator<StreamEvent | AssistantMessage> {
    const n = ++this.call;
    yield { type: 'message_start', messageId: `m${n}`, model: 'fake', inputTokens: 1 };
    if (n === 1) {
      yield { type: 'content_block_start', index: 0, blockType: 'tool_use', blockId: 'call_1' };
      yield { type: 'content_block_delta', index: 0, deltaType: 'input_json',
              content: JSON.stringify({ path: 'smoke-test.txt', content: 'x' }) };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'write_file',
              input: { path: 'smoke-test.txt', content: 'x' } }],
              usage: { input_tokens: 1, output_tokens: 1 }, stopReason: 'tool_use',
              uuid: `a${n}`, timestamp: new Date().toISOString() };
      yield { type: 'message_delta', stopReason: 'tool_use', outputTokens: 1 };
    } else {
      yield { type: 'content_block_start', index: 0, blockType: 'text' };
      yield { type: 'content_block_delta', index: 0, deltaType: 'text', content: 'done' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'assistant', content: [{ type: 'text', text: 'done' }],
              usage: { input_tokens: 1, output_tokens: 1 }, stopReason: 'end_turn',
              uuid: `a${n}`, timestamp: new Date().toISOString() };
      yield { type: 'message_delta', stopReason: 'end_turn', outputTokens: 1 };
    }
    yield { type: 'message_stop' };
  }
}

const registry = new ToolRegistry();
registry.register(
  { name: 'write_file', description: 'write', parameters: { type: 'object' } },
  async (input) => `WROTE ${(input as { path: string }).path}`,
);

for (const mode of ['plan', 'build', 'auto'] as const) {
  const checker = new PermissionChecker({ mode, workdir: process.cwd() });
  console.log(`\n=== mode = ${mode} ===`);
  for await (const msg of streamingQuery(new FakeClient(), registry, 'write smoke-test.txt', {
    systemPrompt: 'sys', tools: registry.getDefinitions(),
    signal: new AbortController().signal, maxTurns: 3,
    enableStreamingExecution: false,  // 走兜底串行分支
    permissionChecker: checker,
  })) {
    if (typeof msg === 'object' && msg !== null && 'type' in msg
        && (msg as { type: string }).type === 'tool_result') {
      const r = msg as { type: 'tool_result'; name: string; output: string };
      console.log(`tool_result [${r.name}]: ${r.output}`);
    }
  }
}
