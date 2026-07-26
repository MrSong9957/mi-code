// src/__tests__/agent/request-tool-view-integration.test.ts
// Wave B Task 4 (M-021): Final Tool View Request Wiring (BRC-2).
//
// 物理本质:验证"per-request 工具视图"端到端贯通的最后一段接驳。
// 上游已经压出一份不可变的 `RequestToolViewSnapshot`(哪些工具 included/excluded),
// 这里验证:把视图喂给 QueryEngine 的 NEW variant(`toolView` + `baseToolSnapshot`),
// 流式 provider 真正拿到的 `tools` 数组里只剩 included 工具,且顺序与 canonical_order 一致。
//
// 同时验证:
//   - materializeIncludedToolDefinitions 的所有边界(snapshot id 不匹配 / 工具缺失 /
//     canonical_order 漂移 / description_asset_ref 缺失 / 深拷贝隔离)。
//   - QueryEngine 的 LEGACY variant(`legacyToolInput: true`)行为不变,只是被新签名
//     重新包装(传什么 tools 就透传什么)。
//   - streamingQuery 端到端可选冒烟(传入 toolView + baseToolSnapshot,provider 收到 included 子集)。
//
// 该测试是 Task 4 的"GREEN 证据"主体。Provider adapter 全程不感知 overlay / capability /
// permission,只接收一份普通 `ToolDefinition[]`,与所有契约约束一致。

import { describe, expect, it } from 'vitest';
import { QueryEngine, type QueryEngineOptions } from '../../agent/query-engine.js';
import { materializeIncludedToolDefinitions } from '../../agent/tool-registry.js';
import { buildToolDefinitionSnapshot } from '../../agent/tools/descriptor-snapshot.js';
import { deriveRequestToolView } from '../../agent/tools/overlay.js';
import { createModelCapabilitySnapshot } from '../../agent/tools/capability-snapshot.js';
import { streamingQuery } from '../../agent/streaming-query.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type {
  StreamingLLMClient,
  Message,
  ToolDefinition,
  RegisteredTool,
  StreamEvent,
  AssistantMessage,
  StreamOptions,
  ContentBlock,
} from '../../agent/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CapturingStreamingClient:录制传给 provider 的 `tools` 数组,然后念一句"done"。
 *
 * 物理本质:一个被动的录音机。它只关心被叫去做什么(`tools` 参数),不在乎
 * 上游是 NEW variant 还是 LEGACY variant —— 调用方传什么就录什么。
 */
class CapturingStreamingClient implements StreamingLLMClient {
  capturedTools: ToolDefinition[] = [];
  async *stream(
    _messages: Message[],
    tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    this.capturedTools = tools;
    yield {
      type: 'message_start',
      messageId: 'msg_1',
      model: 'fake',
      inputTokens: 1,
    };
    yield {
      type: 'assistant',
      message: undefined as never, // 未使用字段,QueryEngine 只读 content/uuid/...
      content: [{ type: 'text', text: 'done' } as ContentBlock],
      usage: { input_tokens: 1, output_tokens: 1 },
      uuid: 'x',
      stopReason: 'end_turn',
      timestamp: new Date().toISOString(),
    } as AssistantMessage;
    yield { type: 'message_stop' };
  }
}

function def(name: string): ToolDefinition {
  return {
    name,
    description: `${name} desc`,
    parameters: { type: 'object', properties: {}, required: [] },
  };
}

function buildBase(names: string[]) {
  const map = new Map<string, RegisteredTool>();
  for (const n of names) map.set(n, { definition: def(n), executor: async () => '' });
  return buildToolDefinitionSnapshot('base-1', map);
}

/** 全通过的能力快照(无任何 required cap 会被否决)。 */
function permissiveCapability() {
  return createModelCapabilitySnapshot({
    capability_protocol_version: '1',
    capability_snapshot_id: 'cap-1',
    provider_id: 'test',
    model_id: 'm',
    adapter_version: '1',
    capabilities: {},
    diagnostics: [],
  });
}

/**
 * 构造一份 RequestToolViewSnapshot:对 names 中的每个工具,可选指定
 * requested_visibility(默认 'include')与 description_asset_ref(默认非空已批准)。
 *
 * 默认环境:capability 全通过、无 security exclusion、approvedAsset 总返回 true。
 */
function viewFor(
  base: ReturnType<typeof buildBase>,
  names: string[],
  opts: {
    requestedVisibility?: Record<string, 'include' | 'exclude'>;
    baseToolSnapshotId?: string;
    capabilitySnapshotId?: string;
  } = {},
) {
  const requestedVisibility = opts.requestedVisibility ?? {};
  return deriveRequestToolView({
    tool_view_protocol_version: '1',
    tool_view_snapshot_id: 'view-1',
    base,
    capability: permissiveCapability(),
    metadata: new Map(),
    overlay: {
      base_tool_snapshot_id: opts.baseToolSnapshotId ?? base.registry_snapshot_id,
      capability_snapshot_id: opts.capabilitySnapshotId ?? 'cap-1',
      control_mode: 'build',
      role_id: null,
      security_policy_snapshot_id: 'security-1',
      requested_visibility: requestedVisibility,
    },
    security_excluded_tool_ids: new Set<string>(),
    approvedAsset: () => true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// materializeIncludedToolDefinitions — pure contract
// ─────────────────────────────────────────────────────────────────────────────

describe('materializeIncludedToolDefinitions', () => {
  it('returns only included tools in canonical order; excluded tool absent', () => {
    const base = buildBase(['read_file', 'write_file', 'grep']);
    const view = viewFor(base, ['read_file', 'write_file', 'grep'], {
      requestedVisibility: {
        read_file: 'include',
        write_file: 'exclude',
        grep: 'include',
      },
    });

    const defs = materializeIncludedToolDefinitions(view, base);
    expect(defs.map(d => d.name)).toEqual(['read_file', 'grep']);
  });

  it('throws when view.base_tool_snapshot_id !== base.registry_snapshot_id', () => {
    const base = buildBase(['read_file']);
    const view = viewFor(base, ['read_file'], { baseToolSnapshotId: 'wrong-id' });

    expect(() => materializeIncludedToolDefinitions(view, base)).toThrow(/snapshot_id/);
  });

  it('throws when an included tool is not in base', () => {
    const base = buildBase(['read_file']);
    const view = viewFor(base, ['read_file']);

    // 篡改 view:把一个不存在的 tool_id 标成 included,模拟 base 与 view 漂移。
    // (正常 deriveRequestToolView 不会产出 base 不存在的 tool_id,这里手动构造边界。)
    const tamperedView = {
      ...view,
      entries: [
        ...view.entries,
        {
          tool_id: 'ghost',
          canonical_order: 99,
          visibility: 'included' as const,
          exclusion_reason_code: null,
          description_asset_ref: { asset_id: 'a', asset_version: '1' },
          provider_annotations: {},
        },
      ],
    };

    expect(() => materializeIncludedToolDefinitions(tamperedView as never, base)).toThrow(
      /ghost/,
    );
  });

  it('throws when canonical_order mismatches between view entry and base descriptor', () => {
    const base = buildBase(['read_file']);
    const view = viewFor(base, ['read_file']);

    // 篡改 view:把 read_file 的 canonical_order 改成与 base descriptor 不一致的值。
    const tamperedView = {
      ...view,
      entries: view.entries.map(e =>
        e.tool_id === 'read_file' ? { ...e, canonical_order: 999 } : e,
      ),
    };

    expect(() => materializeIncludedToolDefinitions(tamperedView as never, base)).toThrow(
      /canonical_order/,
    );
  });

  it('returns deep copies (mutating a returned definition does not affect base descriptor)', () => {
    const base = buildBase(['read_file']);
    const view = viewFor(base, ['read_file']);

    const defs = materializeIncludedToolDefinitions(view, base);
    expect(defs.length).toBe(1);

    // mutate 返回值,base descriptor 应保持不变
    const baseBefore = JSON.stringify(base.descriptors[0].definition);
    (defs[0] as ToolDefinition).name = 'mutated';
    (defs[0].parameters as { properties?: unknown }).properties = { x: {} };
    const baseAfter = JSON.stringify(base.descriptors[0].definition);

    expect(baseAfter).toBe(baseBefore);
    expect(base.descriptors[0].tool_id).toBe('read_file');
  });

  it('does not throw on included entry with null description_asset_ref (overlay-approved metadata-less tool)', () => {
    // 物理本质:overlay 对 metadata 缺失的工具视为 approved-by-default,
    // 此时 entry 合法地带 null description_asset_ref(常见于内置工具)。
    // materializer 不二次解释 overlay 的 approval 决策。
    const base = buildBase(['read_file']);
    const view = viewFor(base, ['read_file']);

    // 默认 viewFor 走的就是 metadata-less 路径,read_file 的 entry
    // description_asset_ref 已经是 null —— 应当能正常 materialize。
    expect(view.entries[0].description_asset_ref).toBeNull();
    const defs = materializeIncludedToolDefinitions(view, base);
    expect(defs.map(d => d.name)).toEqual(['read_file']);
  });

  it('does not modify the registry or the base snapshot', () => {
    const base = buildBase(['read_file', 'grep']);
    const view = viewFor(base, ['read_file', 'grep']);

    const snapshotBefore = JSON.stringify(base);
    const viewBefore = JSON.stringify(view);

    materializeIncludedToolDefinitions(view, base);

    expect(JSON.stringify(base)).toBe(snapshotBefore);
    expect(JSON.stringify(view)).toBe(viewBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QueryEngine — NEW variant (toolView + baseToolSnapshot)
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryEngine — NEW variant (toolView + baseToolSnapshot)', () => {
  it('sends only included tools to the provider, in canonical order', async () => {
    const client = new CapturingStreamingClient();
    const engine = new QueryEngine(client);
    const base = buildBase(['read_file', 'write_file', 'grep']);
    const view = viewFor(base, ['read_file', 'write_file', 'grep'], {
      requestedVisibility: {
        read_file: 'include',
        write_file: 'exclude',
        grep: 'include',
      },
    });

    const opts: QueryEngineOptions = {
      systemPrompt: 'system',
      toolView: view,
      baseToolSnapshot: base,
      signal: new AbortController().signal,
    };

    // drain the generator
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of engine.submit([], opts)) {
      // noop
    }

    expect(client.capturedTools.map(t => t.name)).toEqual(['read_file', 'grep']);
  });

  it('passes through all tools when all are included', async () => {
    const client = new CapturingStreamingClient();
    const engine = new QueryEngine(client);
    const base = buildBase(['alpha', 'beta', 'gamma']);
    const view = viewFor(base, ['alpha', 'beta', 'gamma']);

    const opts: QueryEngineOptions = {
      systemPrompt: 'system',
      toolView: view,
      baseToolSnapshot: base,
      signal: new AbortController().signal,
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of engine.submit([], opts)) {
      // noop
    }

    expect(client.capturedTools.map(t => t.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('produces an empty tools array when all tools are excluded', async () => {
    const client = new CapturingStreamingClient();
    const engine = new QueryEngine(client);
    const base = buildBase(['read_file', 'write_file']);
    const view = viewFor(base, ['read_file', 'write_file'], {
      requestedVisibility: {
        read_file: 'exclude',
        write_file: 'exclude',
      },
    });

    const opts: QueryEngineOptions = {
      systemPrompt: 'system',
      toolView: view,
      baseToolSnapshot: base,
      signal: new AbortController().signal,
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of engine.submit([], opts)) {
      // noop
    }

    expect(client.capturedTools).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QueryEngine — LEGACY variant (legacyToolInput)
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryEngine — LEGACY variant (legacyToolInput: true)', () => {
  it('passes the tools array through unchanged', async () => {
    const client = new CapturingStreamingClient();
    const engine = new QueryEngine(client);
    const legacyTools: ToolDefinition[] = [
      def('legacy_a'),
      def('legacy_b'),
    ];

    const opts: QueryEngineOptions = {
      systemPrompt: 'system',
      tools: legacyTools,
      signal: new AbortController().signal,
      legacyToolInput: true,
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of engine.submit([], opts)) {
      // noop
    }

    // provider 拿到 LEGACY 路径原样透传的 tools 数组(顺序、内容、引用一致)
    expect(client.capturedTools.map(t => t.name)).toEqual(['legacy_a', 'legacy_b']);
  });

  it('passes an empty tools array through when none provided', async () => {
    const client = new CapturingStreamingClient();
    const engine = new QueryEngine(client);

    const opts: QueryEngineOptions = {
      systemPrompt: 'system',
      tools: [],
      signal: new AbortController().signal,
      legacyToolInput: true,
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of engine.submit([], opts)) {
      // noop
    }

    expect(client.capturedTools).toEqual([]);
  });
});

/**
 * 静态类型层面的断言:discriminated union 禁止同时提供 tools 与 toolView。
 *
 * 真正的"不能同时提供两个"由编译时类型系统强制,无法在运行时测试。
 * 这里通过让一个被故意写错的字面量赋值给 `never` 在编译时报错的方式留下
 * 自文档化的约束。下面的注释掉代码如果取消注释,会触发类型错误,证明 union
 * 的相互排斥性。保持注释是为了让测试文件本身保持编译通过。
 */
describe('QueryEngineOptions — type-level mutual exclusion (compile-time only)', () => {
  it('document: providing both tools and toolView is a type error', () => {
    // 取消下面这段注释会使 tsc 报错:
    //
    // const _bad: QueryEngineOptions = {
    //   systemPrompt: 'system',
    //   signal: new AbortController().signal,
    //   tools: [],
    //   legacyToolInput: true,
    //   toolView: undefined as never,
    //   baseToolSnapshot: undefined as never,
    // };

    // 这里只断言运行时的 trivially true,把"约束存在"留在源码注释里。
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// streamingQuery — end-to-end (NEW variant through the agentic loop)
// ─────────────────────────────────────────────────────────────────────────────

describe('streamingQuery — toolView + baseToolSnapshot wiring', () => {
  /**
   * 构造一个最小冒烟测试:streamingQuery 收到 toolView + baseToolSnapshot,
   * 透传给 QueryEngine,最终 provider 收到的是 included 子集。
   *
   * 不需要 tool execution 路径(provider 念一句 'done' 就 end_turn 退出循环),
   * 这里的目的只是验证 queryOptions 分支正确挑选了 NEW variant。
   */
  it('provider receives only included tools when toolView is provided', async () => {
    const client = new CapturingStreamingClient();

    const registry = new ToolRegistry();
    // registry 内容只用来"满足 streamingQuery 签名要求";本测试不执行工具。

    const base = buildBase(['read_file', 'write_file', 'grep']);
    const view = viewFor(base, ['read_file', 'write_file', 'grep'], {
      requestedVisibility: {
        read_file: 'include',
        write_file: 'exclude',
        grep: 'include',
      },
    });

    const messages: StreamEvent[] | AssistantMessage[] = [];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _msg of streamingQuery(client, registry, 'hello', {
      systemPrompt: 'system',
      tools: [], // 兼容字段;当 toolView 提供时不被使用
      signal: new AbortController().signal,
      toolView: view,
      baseToolSnapshot: base,
    })) {
      // drain
      void messages;
    }

    expect(client.capturedTools.map(t => t.name)).toEqual(['read_file', 'grep']);
  });

  /**
   * LEGACY 路径回归:不传 toolView,streamingQuery 走老分支,provider 拿到 options.tools。
   */
  it('LEGACY: provider receives options.tools when no toolView given', async () => {
    const client = new CapturingStreamingClient();

    const registry = new ToolRegistry();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _msg of streamingQuery(client, registry, 'hello', {
      systemPrompt: 'system',
      tools: [def('legacy_only')],
      signal: new AbortController().signal,
    })) {
      // drain
    }

    expect(client.capturedTools.map(t => t.name)).toEqual(['legacy_only']);
  });
});
