// src/__tests__/agent/request-snapshot.test.ts
// Task 4 (RC-2): Provider-neutral 语义请求快照。
//
// 物理本质:把 system / meta_context / conversation / tools 四个语义平面
// 烧录进一张不可变"请求胶片"。Provider adapter 从这张胶片读,而不是从活体
// Prompt compiler 状态读 —— 保证一次 turn 内的请求不会被中途状态漂移污染。
//
// 重点断言(对齐 spec §8.7):
//   - 四平面互相独立,不串台
//   - 身份字段非空(requireIdentity)
//   - 跨平面身份对齐:tools.registry_snapshot_id === request.registry_snapshot_id
//   - system section placement 运行时只接受 system_static / system_dynamic
//   - meta_context 消息 is_meta=true;conversation 消息 is_meta=false
//   - 拒绝 Provider SDK 对象 / 函数 / 类实例(JSON-compatible plain data only)
//   - 深拷贝隔离调用方对原数组的后续 mutate
//   - 深度冻结(根 + 数组 + 嵌套对象 + tools 引用)
//   - 无 attachment / attachment_plane 字段(attachment 当前 Hold)

import { describe, expect, it } from 'vitest';
import { buildSemanticRequestSnapshot } from '../../agent/contracts/request-snapshot.js';
import { buildToolDefinitionSnapshot } from '../../agent/tools/descriptor-snapshot.js';
import type { RegisteredTool } from '../../agent/types.js';

// Build a minimal tools snapshot for use in tests.
const toolsSnapshot = buildToolDefinitionSnapshot(
  'registry-1',
  new Map<string, RegisteredTool>(),
);

describe('buildSemanticRequestSnapshot', () => {
  it('keeps system, meta, conversation, and tool planes separate', () => {
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'request-1',
      turn_id: 'turn-1',
      registry_snapshot_id: 'registry-1',
      system_sections: [
        { section_id: 'base', placement: 'system_static', content: 'base' },
      ],
      meta_context: [
        {
          message_id: 'meta-1',
          role: 'user',
          content: 'project context',
          is_meta: true,
        },
      ],
      conversation: [
        { message_id: 'user-1', role: 'user', content: 'fix bug', is_meta: false },
      ],
      tools: toolsSnapshot,
    });
    expect(snapshot.system_sections[0].placement).toBe('system_static');
    expect(snapshot.meta_context[0].is_meta).toBe(true);
    expect(snapshot.conversation[0].is_meta).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  // ── 身份字段非空(requireIdentity)───────────────────────────────

  it('throws when request_id is empty (requireIdentity)', () => {
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: '',
        turn_id: 'turn-1',
        registry_snapshot_id: 'registry-1',
        system_sections: [],
        meta_context: [],
        conversation: [],
        tools: toolsSnapshot,
      }),
    ).toThrow('request_id');
  });

  it('throws when turn_id is empty (requireIdentity)', () => {
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: 'request-1',
        turn_id: '   ',
        registry_snapshot_id: 'registry-1',
        system_sections: [],
        meta_context: [],
        conversation: [],
        tools: toolsSnapshot,
      }),
    ).toThrow('turn_id');
  });

  it('throws when registry_snapshot_id is empty (requireIdentity)', () => {
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: 'request-1',
        turn_id: 'turn-1',
        registry_snapshot_id: '',
        system_sections: [],
        meta_context: [],
        conversation: [],
        tools: toolsSnapshot,
      }),
    ).toThrow('registry_snapshot_id');
  });

  // ── 跨平面身份对齐 ───────────────────────────────────────────

  it('throws mentioning registry_snapshot_id when tools mismatch request', () => {
    const mismatchedTools = buildToolDefinitionSnapshot(
      'other-registry',
      new Map<string, RegisteredTool>(),
    );
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: 'request-1',
        turn_id: 'turn-1',
        registry_snapshot_id: 'registry-1',
        system_sections: [],
        meta_context: [],
        conversation: [],
        tools: mismatchedTools,
      }),
    ).toThrow('registry_snapshot_id');
  });

  // ── system section placement 运行时再校验(防 as any 走私)─────

  it('throws mentioning placement when a system section smuggles meta_context', () => {
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: 'r',
        turn_id: 't',
        registry_snapshot_id: 'registry-1',
        system_sections: [
          {
            section_id: 's',
            placement: 'meta_context' as 'system_static',
            content: 'x',
          },
        ],
        meta_context: [],
        conversation: [],
        tools: toolsSnapshot,
      }),
    ).toThrow('placement');
  });

  it('throws mentioning placement when a system section smuggles conversation', () => {
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: 'r',
        turn_id: 't',
        registry_snapshot_id: 'registry-1',
        system_sections: [
          {
            section_id: 's',
            placement: 'conversation' as 'system_static',
            content: 'x',
          },
        ],
        meta_context: [],
        conversation: [],
        tools: toolsSnapshot,
      }),
    ).toThrow('placement');
  });

  // ── meta_context / conversation 的 is_meta 不变量 ─────────────

  it('throws mentioning meta_context when a meta item has is_meta=false', () => {
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: 'r',
        turn_id: 't',
        registry_snapshot_id: 'registry-1',
        system_sections: [],
        meta_context: [
          { message_id: 'm1', role: 'user', content: 'ctx', is_meta: false },
        ],
        conversation: [],
        tools: toolsSnapshot,
      }),
    ).toThrow('meta_context');
  });

  it('throws mentioning conversation when a conversation item has is_meta=true', () => {
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: 'r',
        turn_id: 't',
        registry_snapshot_id: 'registry-1',
        system_sections: [],
        meta_context: [],
        conversation: [
          { message_id: 'c1', role: 'user', content: 'hi', is_meta: true },
        ],
        tools: toolsSnapshot,
      }),
    ).toThrow('conversation');
  });

  // ── Provider 对象拒绝(函数 / 类实例)──────────────────────────

  it('throws when a section content is a function (Provider object rejection)', () => {
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: 'r',
        turn_id: 't',
        registry_snapshot_id: 'registry-1',
        system_sections: [
          {
            section_id: 's',
            placement: 'system_static',
            content: (() => 1) as unknown as string,
          },
        ],
        meta_context: [],
        conversation: [],
        tools: toolsSnapshot,
      }),
    ).toThrow(/Provider object/i);
  });

  it('throws when a message content is a class instance (Provider object rejection)', () => {
    expect(() =>
      buildSemanticRequestSnapshot({
        request_id: 'r',
        turn_id: 't',
        registry_snapshot_id: 'registry-1',
        system_sections: [],
        meta_context: [],
        conversation: [
          {
            message_id: 'c',
            role: 'user',
            content: new Date() as unknown as string,
            is_meta: false,
          },
        ],
        tools: toolsSnapshot,
      }),
    ).toThrow(/Provider object/i);
  });

  // ── 深拷贝隔离 capture-then-mutate ────────────────────────────

  it('isolates system_sections from later mutation of the input array', () => {
    const originalSystem = [
      {
        section_id: 'base',
        placement: 'system_static' as const,
        content: 'base',
      },
    ];
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'r',
      turn_id: 't',
      registry_snapshot_id: 'registry-1',
      system_sections: originalSystem,
      meta_context: [],
      conversation: [],
      tools: toolsSnapshot,
    });
    originalSystem.push({
      section_id: 'extra',
      placement: 'system_static',
      content: 'extra',
    });
    expect(snapshot.system_sections.length).toBe(1);
    expect(snapshot.system_sections[0].section_id).toBe('base');
  });

  it('isolates conversation from later mutation of the input array', () => {
    const originalConversation = [
      {
        message_id: 'u1',
        role: 'user' as const,
        content: 'first',
        is_meta: false,
      },
    ];
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'r',
      turn_id: 't',
      registry_snapshot_id: 'registry-1',
      system_sections: [],
      meta_context: [],
      conversation: originalConversation,
      tools: toolsSnapshot,
    });
    originalConversation.push({
      message_id: 'u2',
      role: 'user',
      content: 'second',
      is_meta: false,
    });
    expect(snapshot.conversation.length).toBe(1);
    expect(snapshot.conversation[0].message_id).toBe('u1');
  });

  it('isolates meta_context from later mutation of the input array', () => {
    const originalMeta = [
      {
        message_id: 'm1',
        role: 'user' as const,
        content: 'ctx',
        is_meta: true as const,
      },
    ];
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'r',
      turn_id: 't',
      registry_snapshot_id: 'registry-1',
      system_sections: [],
      meta_context: originalMeta,
      conversation: [],
      tools: toolsSnapshot,
    });
    originalMeta.push({
      message_id: 'm2',
      role: 'user',
      content: 'more ctx',
      is_meta: true,
    });
    expect(snapshot.meta_context.length).toBe(1);
    expect(snapshot.meta_context[0].message_id).toBe('m1');
  });

  // ── 深度冻结 ─────────────────────────────────────────────────

  it('deeply freezes the snapshot (root, arrays, sections, messages, tools)', () => {
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'r',
      turn_id: 't',
      registry_snapshot_id: 'registry-1',
      system_sections: [
        { section_id: 's', placement: 'system_static', content: 'c' },
      ],
      meta_context: [
        {
          message_id: 'm',
          role: 'user',
          content: 'meta',
          is_meta: true,
        },
      ],
      conversation: [
        { message_id: 'u', role: 'user', content: 'hi', is_meta: false },
      ],
      tools: toolsSnapshot,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.system_sections)).toBe(true);
    expect(Object.isFrozen(snapshot.system_sections[0])).toBe(true);
    expect(Object.isFrozen(snapshot.meta_context)).toBe(true);
    expect(Object.isFrozen(snapshot.meta_context[0])).toBe(true);
    expect(Object.isFrozen(snapshot.conversation)).toBe(true);
    expect(Object.isFrozen(snapshot.conversation[0])).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(Object.isFrozen(snapshot.tools.descriptors)).toBe(true);
  });

  // ── attachment on Hold:不出现 attachment 字段 ────────────────

  it('does not expose attachment or attachment_plane field (attachment on Hold)', () => {
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'r',
      turn_id: 't',
      registry_snapshot_id: 'registry-1',
      system_sections: [],
      meta_context: [],
      conversation: [],
      tools: toolsSnapshot,
    });
    expect(snapshot).not.toHaveProperty('attachment');
    expect(snapshot).not.toHaveProperty('attachment_plane');
  });

  // ── tools 快照按原样保留 ─────────────────────────────────────

  it('preserves the tools snapshot as-is (registry id + zero descriptors for empty case)', () => {
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'r',
      turn_id: 't',
      registry_snapshot_id: 'registry-1',
      system_sections: [],
      meta_context: [],
      conversation: [],
      tools: toolsSnapshot,
    });
    expect(snapshot.tools.registry_snapshot_id).toBe('registry-1');
    expect(snapshot.tools.descriptors.length).toBe(0);
  });

  // ── 多块 ContentBlock[] 内容 ─────────────────────────────────

  it('preserves multi-block ContentBlock[] content and freezes the content array', () => {
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'r',
      turn_id: 't',
      registry_snapshot_id: 'registry-1',
      system_sections: [],
      meta_context: [],
      conversation: [
        {
          message_id: 'multi',
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'text', text: 'there' },
          ],
          is_meta: false,
        },
      ],
      tools: toolsSnapshot,
    });
    const msg = snapshot.conversation[0];
    expect(Array.isArray(msg.content)).toBe(true);
    if (!Array.isArray(msg.content)) {
      throw new Error('expected array content');
    }
    expect(msg.content.length).toBe(2);
    expect(msg.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(msg.content[1]).toEqual({ type: 'text', text: 'there' });
    // content array and each block must be frozen
    expect(Object.isFrozen(msg.content)).toBe(true);
    expect(Object.isFrozen(msg.content[0])).toBe(true);
    expect(Object.isFrozen(msg.content[1])).toBe(true);
  });

  // ── 空输入合法 ───────────────────────────────────────────────

  it('accepts empty inputs (all arrays empty, zero descriptors) and returns a frozen snapshot', () => {
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'r',
      turn_id: 't',
      registry_snapshot_id: 'registry-1',
      system_sections: [],
      meta_context: [],
      conversation: [],
      tools: toolsSnapshot,
    });
    expect(snapshot.system_sections.length).toBe(0);
    expect(snapshot.meta_context.length).toBe(0);
    expect(snapshot.conversation.length).toBe(0);
    expect(snapshot.tools.descriptors.length).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
