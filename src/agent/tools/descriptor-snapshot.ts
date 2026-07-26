// src/agent/tools/descriptor-snapshot.ts
// RC-2 (Task 3):Tool 身份 + 确定性基础序。
//
// 物理本质:工具清单的"快照底片"。给定一个 ToolRegistry 的内部 Map,
// 按 Map 插入顺序(= 注册顺序)给每个工具分配 canonical_order,深拷贝定义,
// 三层冻结(数组 + descriptor + 嵌套 definition/parameters)。
//
// 关键不变量:
//   - canonical_order = Map 插入序(0-based),不排序、不去重
//   - tool_id === Map key === definition.name(由 ToolRegistry.register 保证)
//   - 快照只暴露 identity + definition,不暴露 executor(不可执行)
//   - 快照不可变:后续注册表增删、原始 definition 被 mutate 都不影响快照
//
// 实现要点:
//   - 先 structuredClone 再 freezeSnapshot(freezeSnapshot 是就地冻结,
//     必须先深拷贝否则会把注册表里活体 definition 冻死)。
//   - descriptors 数组本身也要冻结。

import type { RegisteredTool, ToolDefinition } from '../types.js';
import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

/** 单个工具的描述符:身份(tool_id)+ 位置(canonical_order)+ 定义副本。 */
export interface ToolDescriptor {
  tool_id: string;
  canonical_order: number;
  definition: ToolDefinition;
}

/**
 * 工具定义快照:一次曝光的不可变胶片。
 *
 * - registry_snapshot_id:本次快照的身份(由调用方传入,需校验非空)。
 * - descriptors:按 canonical_order 排列的只读描述符数组。
 */
export interface ToolDefinitionSnapshot {
  registry_snapshot_id: string;
  descriptors: readonly Readonly<ToolDescriptor>[];
}

/**
 * 根据 ToolRegistry 的内部 Map 构建一份不可变的工具定义快照。
 *
 * @param registrySnapshotId 本次快照的身份(非空字符串)
 * @param tools              ToolRegistry._tools(ReadonlyMap 视图)
 * @returns 三层冻结的 ToolDefinitionSnapshot
 * @throws 当 registrySnapshotId 为空时(requireIdentity 校验失败)
 */
export function buildToolDefinitionSnapshot(
  registrySnapshotId: string,
  tools: ReadonlyMap<string, RegisteredTool>,
): ToolDefinitionSnapshot {
  // 规则 1:校验身份非空
  const validatedId = requireIdentity(registrySnapshotId, 'registry_snapshot_id');

  // 规则 2 + 3:按 Map 插入顺序遍历,tool_id = Map key,canonical_order = index
  let index = 0;
  const descriptors: ToolDescriptor[] = [];
  for (const [toolId, tool] of tools.entries()) {
    // 规则 4:深拷贝定义,隔离后续 mutate(必须在 freeze 之前)
    const definitionCopy = structuredClone(tool.definition) as ToolDefinition;
    // 规则 6:只暴露 identity + definition,不暴露 executor
    descriptors.push({
      tool_id: toolId,
      canonical_order: index,
      definition: definitionCopy,
    });
    index += 1;
  }

  // 规则 5:三层冻结 —— 先冻每个 descriptor(含嵌套 definition/parameters),
  // 再冻 descriptors 数组,最后冻快照对象本身。
  for (const descriptor of descriptors) {
    // definition/parameters 通过 freezeSnapshot 的递归被一并冻结
    freezeSnapshot(descriptor);
  }
  freezeSnapshot(descriptors);

  const snapshot: ToolDefinitionSnapshot = {
    registry_snapshot_id: validatedId,
    descriptors,
  };
  return freezeSnapshot(snapshot);
}
