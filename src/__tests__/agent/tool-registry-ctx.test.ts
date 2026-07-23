// src/__tests__/agent/tool-registry-ctx.test.ts
// AUTO-0025 Phase B (Task 7):registry.execute 透传 ctx。
//
// 物理本质:ToolExecutionContext 是"通用扩展点"(非 ask 专用),
// 当前仅 toolUseId(用于 ask-user-tool 写入 outcome store)。
// 关键约束:旧 executor 签名 (input) => Promise<string> 必须零改动兼容(可选参数)。

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type { ToolDefinition } from '../../agent/types.js';

describe('registry.execute ctx 透传', () => {
  it('executor 收到 ctx.toolUseId', async () => {
    const registry = new ToolRegistry();
    let receivedCtx: { toolUseId: string } | undefined;
    const def: ToolDefinition = {
      name: 'test_tool',
      description: 'test',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    registry.register(def, async (_input, ctx) => {
      receivedCtx = ctx;
      return 'ok';
    });
    await registry.execute('test_tool', {}, { toolUseId: 'tuu-123' });
    expect(receivedCtx?.toolUseId).toBe('tuu-123');
  });

  it('不传 ctx 时旧 executor 仍正常工作', async () => {
    const registry = new ToolRegistry();
    const def: ToolDefinition = {
      name: 'legacy_tool',
      description: 'legacy',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    registry.register(def, async () => 'legacy-ok');
    const result = await registry.execute('legacy_tool', {});
    expect(result).toBe('legacy-ok');
  });
});
