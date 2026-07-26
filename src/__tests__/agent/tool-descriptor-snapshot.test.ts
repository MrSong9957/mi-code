// src/__tests__/agent/tool-descriptor-snapshot.test.ts
// Task 3 (RC-2): Tool identity & deterministic base order.
//
// 物理本质:工具清单的"快照底片"。一次曝光把所有工具定义 + 注册顺序
// 烧录进不可变胶片,后续注册表增删都不影响这张底片,模型请求从底片复制
// 而不是直接读活体注册表(避免一次 turn 内工具集漂移)。
//
// 重点断言:
//   - canonical_order 由 Map 插入顺序(= 注册顺序)决定,不排序
//   - tool_id === Map key === definition.name(round-trip 不变量)
//   - 快照三层全冻结(数组 + descriptor + 嵌套 definition/parameters)
//   - 快照隔离于:(a)后续注册表增删,(b)原始 definition 对象被 mutate
//   - 重复 tool_id 注册直接抛错(不再静默覆盖)

import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { buildToolDefinitionSnapshot } from '../../agent/tools/descriptor-snapshot.js';
import type { RegisteredTool, ToolDefinition } from '../../agent/types.js';

const definition = (name: string): ToolDefinition => ({
  name,
  description: `${name} description`,
  parameters: { type: 'object', properties: {}, required: [] },
});

describe('ToolRegistry definition snapshot', () => {
  it('seeds canonical order from registration order', () => {
    const registry = new ToolRegistry();
    registry.register(definition('zeta'), async () => 'z');
    registry.register(definition('alpha'), async () => 'a');
    const snapshot = registry.getDefinitionSnapshot('registry-1');
    expect(
      snapshot.descriptors.map(({ tool_id, canonical_order }) => [tool_id, canonical_order]),
    ).toEqual([
      ['zeta', 0],
      ['alpha', 1],
    ]);
  });

  it('rejects duplicate tool ids instead of overwriting', () => {
    const registry = new ToolRegistry();
    registry.register(definition('read_file'), async () => 'first');
    expect(() => registry.register(definition('read_file'), async () => 'second')).toThrow(
      'Duplicate tool id',
    );
  });

  it('rejects an empty registry_snapshot_id via requireIdentity', () => {
    const registry = new ToolRegistry();
    registry.register(definition('solo'), async () => 's');
    expect(() => registry.getDefinitionSnapshot('')).toThrow();
  });

  it('produces a deeply frozen snapshot (array, descriptor, nested definition)', () => {
    const registry = new ToolRegistry();
    registry.register(definition('frozen_one'), async () => 'x');
    const snapshot = registry.getDefinitionSnapshot('registry-frozen');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.descriptors)).toBe(true);
    expect(Object.isFrozen(snapshot.descriptors[0])).toBe(true);
    // nested definition + parameters also frozen
    expect(Object.isFrozen(snapshot.descriptors[0].definition)).toBe(true);
    expect(Object.isFrozen(snapshot.descriptors[0].definition.parameters)).toBe(true);
  });

  it('isolates the snapshot from later registry mutation (capture-then-mutate)', () => {
    const registry = new ToolRegistry();
    registry.register(definition('first'), async () => '1');
    const snapshot = registry.getDefinitionSnapshot('registry-isolate');
    // mutate the SAME registry after the snapshot
    registry.register(definition('second'), async () => '2');
    expect(snapshot.descriptors.length).toBe(1);
    expect(snapshot.descriptors[0].tool_id).toBe('first');
  });

  it('isolates the snapshot from later mutation of the original definition object', () => {
    const registry = new ToolRegistry();
    const def = definition('mutatee');
    registry.register(def, async () => 'm');
    const snapshot = registry.getDefinitionSnapshot('registry-def-isolate');
    // mutate the ORIGINAL definition object after snapshotting
    def.description = 'CHANGED AFTER SNAPSHOT';
    expect(snapshot.descriptors[0].definition.description).toBe('mutatee description');
  });

  it('buildToolDefinitionSnapshot called directly with a hand-built Map matches getDefinitionSnapshot order', () => {
    const registry = new ToolRegistry();
    registry.register(definition('c'), async () => 'c');
    registry.register(definition('b'), async () => 'b');
    registry.register(definition('a'), async () => 'a');

    // hand-built Map in the same insertion order
    const handBuilt = new Map<string, RegisteredTool>();
    handBuilt.set('c', { definition: definition('c'), executor: async () => 'c' });
    handBuilt.set('b', { definition: definition('b'), executor: async () => 'b' });
    handBuilt.set('a', { definition: definition('a'), executor: async () => 'a' });

    const fromRegistry = registry.getDefinitionSnapshot('registry-direct');
    const fromBuilder = buildToolDefinitionSnapshot('registry-direct', handBuilt);

    expect(
      fromRegistry.descriptors.map(({ tool_id, canonical_order }) => [tool_id, canonical_order]),
    ).toEqual(
      fromBuilder.descriptors.map(({ tool_id, canonical_order }) => [tool_id, canonical_order]),
    );
  });

  it('returns an empty (length 0) but still frozen snapshot for an empty registry', () => {
    const registry = new ToolRegistry();
    const snapshot = registry.getDefinitionSnapshot('registry-empty');
    expect(snapshot.descriptors.length).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.descriptors)).toBe(true);
  });

  it('preserves the round-trip invariant tool_id === definition.name for every descriptor', () => {
    const registry = new ToolRegistry();
    registry.register(definition('round_trip_a'), async () => 'a');
    registry.register(definition('round_trip_b'), async () => 'b');
    const snapshot = registry.getDefinitionSnapshot('registry-rt');
    for (const d of snapshot.descriptors) {
      expect(d.tool_id).toBe(d.definition.name);
    }
  });

  it('does not expose the executor in the snapshot (identity+definition only)', () => {
    const registry = new ToolRegistry();
    registry.register(definition('no_exec'), async () => 'ne');
    const snapshot = registry.getDefinitionSnapshot('registry-noexec');
    // descriptor shape is { tool_id, canonical_order, definition } only
    for (const d of snapshot.descriptors) {
      expect(d).not.toHaveProperty('executor');
      expect(Object.keys(d).sort()).toEqual(['canonical_order', 'definition', 'tool_id']);
    }
  });
});
