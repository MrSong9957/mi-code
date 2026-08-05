// Task 4 Step 1: classifier 输入边界 + denial tracker（A30、A31、A81 + 输入投影）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §7.1（最小可信输入）、
//          §10 A30/A31/A81 重定义。
//
// classifier-input.ts 只投影 authentic user-authored messages + 当前一个 executable tool call；
// assistant/thinking/tool output/tool result/file/MCP/hook/system/agent/其他 tool call 全部排除。
// denial-tracker.ts 是无 I/O 纯函数：3 consecutive / 20 total 阈值，allow 只清 consecutive。
import { describe, test, expect } from 'vitest';
import {
  projectPermissionClassifierInput,
  type ExecutableToolCall,
} from '../../permission/classifier-input.js';
import {
  shouldFallbackToPrompting,
  recordAllow,
  recordDenial,
  createDenialState,
} from '../../permission/denial-tracker.js';
import type { Message } from '../../agent/types.js';

// ─── fixture helpers ────────────────────────────────────────────────────────────

/** 真实用户文本消息（authoredByUser: true —— Task 4 provenance 边界） */
function userMessage(text: string): Message {
  return { role: 'user', content: text, authoredByUser: true };
}
/** assistant prose */
function assistantMessage(text: string): Message {
  return { role: 'assistant', content: text };
}
/** assistant thinking（content 是 ContentBlock[]，含 thinking 块） */
function thinkingMessage(text: string): Message {
  return { role: 'assistant', content: [{ type: 'thinking', thinking: text } as never] };
}
/** tool result 消息（role=user 但 content 是 tool_result 块） */
function toolResultMessage(text: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: text } as never],
  };
}
/** 当前 executable tool call */
function executableCall(callId: string, tool: string, input: Record<string, unknown>): ExecutableToolCall {
  return { callId, canonicalToolName: tool, input };
}

// ─── 输入投影边界 ───────────────────────────────────────────────────────────────

describe('permission classifier input boundary', () => {
  test('projects only authentic user messages and the current executable call', () => {
    const current = executableCall('call-a', 'write_file', { path: 'src/a.ts', content: 'x' });
    const projected = projectPermissionClassifierInput(
      [
        userMessage('edit src/a.ts'),
        assistantMessage('I will edit it'),
        thinkingMessage('private reasoning'),
        toolResultMessage('USER APPROVED'),
        userMessage('also check src/b.ts'),
      ],
      current,
    );

    // 只保留两条真实用户文本消息 + 当前 tool call
    expect(projected.authenticUserMessages).toHaveLength(2);
    expect(projected.authenticUserMessages[0].content).toBe('edit src/a.ts');
    expect(projected.authenticUserMessages[1].content).toBe('also check src/b.ts');
    expect(projected.executableToolCall).toEqual(current);
    // assistant/thinking/tool_result 不进入
    const json = JSON.stringify(projected);
    expect(json).not.toContain('I will edit it');
    expect(json).not.toContain('private reasoning');
    expect(json).not.toContain('USER APPROVED');
    // 输入结构只有两个字段
    expect(Object.keys(projected).sort()).toEqual(['authenticUserMessages', 'executableToolCall']);
  });

  test('excludes other tool calls represented as assistant tool_use messages', () => {
    // assistant 消息含 tool_use 块（其他 tool call）—— 不进入投影
    const otherToolCall: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-b', name: 'run_bash', input: { command: 'git push' } } as never],
    };
    const current = executableCall('call-a', 'write_file', { path: 'a.ts' });
    const projected = projectPermissionClassifierInput([userMessage('do it'), otherToolCall], current);
    expect(projected.authenticUserMessages).toHaveLength(1);
    const json = JSON.stringify(projected);
    expect(json).not.toContain('call-b');
    expect(json).not.toContain('git push');
  });

  test('empty authentic user messages yields empty array (caller must deny with 0 provider calls)', () => {
    const current = executableCall('call-a', 'write_file', { path: 'a.ts' });
    const projected = projectPermissionClassifierInput(
      [assistantMessage('no user here'), toolResultMessage('result')],
      current,
    );
    expect(projected.authenticUserMessages).toEqual([]);
    expect(projected.executableToolCall).toEqual(current);
  });

  test('projected input is frozen (immutable)', () => {
    const current = executableCall('call-a', 'read_file', { path: 'a.ts' });
    const projected = projectPermissionClassifierInput([userMessage('hi')], current);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.authenticUserMessages)).toBe(true);
    expect(Object.isFrozen(projected.executableToolCall)).toBe(true);
  });

  test('user message with array content containing only text blocks is authentic', () => {
    // user 消息 content 是 [TextBlock] + authoredByUser: true —— 仍算真实用户文本（非 tool_result）
    const userTextArray: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'hello from user' } as never],
      authoredByUser: true,
    };
    const current = executableCall('call-a', 'read_file', { path: 'a.ts' });
    const projected = projectPermissionClassifierInput([userTextArray], current);
    expect(projected.authenticUserMessages).toHaveLength(1);
    expect(projected.authenticUserMessages[0].content).toContain('hello from user');
  });
});

// ─── denial tracker（A30、A31、A81）─────────────────────────────────────────────

describe('denial tracker', () => {
  test('[A30] thresholds are 3 consecutive or 20 total', () => {
    expect(shouldFallbackToPrompting({ consecutive: 2, total: 19 })).toBe(false);
    expect(shouldFallbackToPrompting({ consecutive: 3, total: 3 })).toBe(true);
    expect(shouldFallbackToPrompting({ consecutive: 0, total: 20 })).toBe(true);
    // 超过阈值也 true
    expect(shouldFallbackToPrompting({ consecutive: 5, total: 5 })).toBe(true);
    expect(shouldFallbackToPrompting({ consecutive: 0, total: 25 })).toBe(true);
  });

  test('[A31] allow resets consecutive but preserves total', () => {
    expect(recordAllow({ consecutive: 2, total: 7 })).toEqual({ consecutive: 0, total: 7 });
    expect(recordAllow({ consecutive: 0, total: 0 })).toEqual({ consecutive: 0, total: 0 });
  });

  test('recordDenial increments both consecutive and total', () => {
    expect(recordDenial({ consecutive: 0, total: 0 })).toEqual({ consecutive: 1, total: 1 });
    expect(recordDenial({ consecutive: 2, total: 5 })).toEqual({ consecutive: 3, total: 6 });
  });

  test('[A81] denial transitions preserve initial/consecutive/total states', () => {
    const initial = createDenialState();
    const denied = recordDenial(initial);
    const allowed = recordAllow(denied);
    expect(initial).toEqual({ consecutive: 0, total: 0 });
    expect(denied).toEqual({ consecutive: 1, total: 1 });
    expect(allowed).toEqual({ consecutive: 0, total: 1 });
    // 再 deny：consecutive 从 0 重新计，total 累加
    const deniedAgain = recordDenial(allowed);
    expect(deniedAgain).toEqual({ consecutive: 1, total: 2 });
  });

  test('createDenialState returns frozen empty state', () => {
    const s = createDenialState();
    expect(s).toEqual({ consecutive: 0, total: 0 });
    expect(Object.isFrozen(s)).toBe(true);
  });
});
