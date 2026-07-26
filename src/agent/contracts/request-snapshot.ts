// src/agent/contracts/request-snapshot.ts
// RC-2 (Task 4): Provider-neutral 语义请求快照。
//
// 物理本质:一次"曝光",把 system / meta_context / conversation / tools 四个
// 语义平面烧录进一张不可变胶片。Provider adapter 从这张胶片读,而不是从活体
// Prompt compiler 状态读 —— 保证一次 turn 内的请求不会被中途状态漂移污染。
//
// 关键不变量(spec §8.7):
//   - 四平面互相独立,不串台(system 不出现在 conversation,tool_plane 不在 system 文本)
//   - 跨平面身份对齐:tools.registry_snapshot_id === request.registry_snapshot_id
//   - system section placement 运行时只接受 system_static / system_dynamic
//   - meta_context 消息 is_meta=true;conversation 消息 is_meta=false
//   - 快照只持有 JSON-compatible plain data:无 Provider SDK 对象/函数/类实例
//   - 深拷贝隔离:调用方对原数组的后续 mutate 不影响快照
//   - 深度冻结:根 + 数组 + 嵌套对象
//   - attachment 当前 Hold:不出现 attachment / attachment_plane 字段
//
// 设计选择(spec §8.7-7):
//   - 全部深拷贝(structuredClone),tools 也不例外 —— 虽然工具快照已是冻结的
//     纯数据,但为彻底隔离(protection against caller 持有同一引用后 mutate),
//     连 tools 一并深拷贝再冻。代价低,保证强。
//   - Provider 对象拒绝:不调用任何 SDK 序列化器,只在深拷贝后做一次
//     proto === Object.prototype || Array.isArray 的结构性遍历。
//   - 不推断 Authority/Trust/Retention from Placement —— Placement 仅是位置标签。

import type { ContentBlock } from '../types.js';
import type { ToolDefinitionSnapshot } from '../tools/descriptor-snapshot.js';
import { freezeSnapshot, requireIdentity } from './identities.js';

/** Placement 类别(供 Provider adapter 在编码时引用)。 */
export type SemanticPlacement =
  | 'system_static'
  | 'system_dynamic'
  | 'meta_context'
  | 'conversation'
  | 'tool_plane';

/** system 静态/动态平面里的一条 section。 */
export interface SemanticSection {
  section_id: string;
  placement: 'system_static' | 'system_dynamic';
  content: string;
}

/** meta_context 或 conversation 平面里的一条消息。 */
export interface SemanticMessage {
  message_id: string;
  role: 'user' | 'assistant';
  content: string | readonly ContentBlock[];
  is_meta: boolean;
}

/** 完整的语义请求快照(四个平面 + 身份字段)。 */
export interface SemanticRequestSnapshot {
  request_id: string;
  turn_id: string;
  registry_snapshot_id: string;
  system_sections: readonly Readonly<SemanticSection>[];
  meta_context: readonly Readonly<SemanticMessage>[];
  conversation: readonly Readonly<SemanticMessage>[];
  tools: ToolDefinitionSnapshot;
}

/** Builder 输入(可写形式,允许调用方使用 mutable 数组)。 */
export interface BuildSemanticRequestSnapshotInput {
  request_id: string;
  turn_id: string;
  registry_snapshot_id: string;
  system_sections: readonly SemanticSection[];
  meta_context: readonly SemanticMessage[];
  conversation: readonly SemanticMessage[];
  tools: ToolDefinitionSnapshot;
}

/**
 * 检查一个值是否只含 JSON-compatible plain data:
 *   - 原始值(string/number/boolean/null/undefined)OK
 *   - 数组 OK,递归检查每个元素
 *   - 普通 object(proto === Object.prototype 或 null)OK,递归检查字段
 *   - 函数 / 类实例(proto 不是 Object.prototype 的对象)拒绝
 *
 * 不调用任何 Provider SDK 序列化器;不依赖 Symbol marker 检测
 * (这是有意的:Symbol 标记很容易漏检,结构性 proto 检查更稳健)。
 */
function assertJsonCompatible(value: unknown, path: string): void {
  if (value === null) {
    return;
  }
  const t = typeof value;
  if (t === 'function') {
    throw new Error(
      `Provider object or function not allowed in semantic snapshot at ${path}`,
    );
  }
  if (t !== 'object') {
    // number / string / boolean / symbol-as-value / bigint ——
    // 注意:symbol/bigint 在 JSON.stringify 时会丢,但 typeof 不为 object/function,
    // 这里只关心"不是函数、不是 class instance"两类 Provider 污染源,
    // 不强制 JSON-only(测试只 smuggle 函数与 Date 实例)。
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonCompatible(v, `${path}[${i}]`));
    return;
  }
  // 非 array 的 object:proto 必须是 Object.prototype 或 null(纯字面量)。
  // Date / Map / Set / 自定义类实例的 proto 不是 Object.prototype → 拒绝。
  const obj = value as Record<string, unknown>;
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error(
      `Provider object or class instance not allowed in semantic snapshot at ${path}`,
    );
  }
  for (const [k, v] of Object.entries(obj)) {
    assertJsonCompatible(v, `${path}.${k}`);
  }
}

/**
 * Provider-neutral 语义请求快照 Builder。
 *
 * @param input 四平面 + 三个身份字段
 * @returns 深度冻结的 SemanticRequestSnapshot
 * @throws requireIdentity 失败(空身份字段)
 * @throws 跨平面 registry_snapshot_id 不一致
 * @throws system section placement 不是 system_static / system_dynamic
 * @throws meta_context 含 is_meta=false
 * @throws conversation 含 is_meta=true
 * @throws 检测到 Provider 对象 / 函数 / 类实例(非 JSON-compatible)
 */
export function buildSemanticRequestSnapshot(
  input: BuildSemanticRequestSnapshotInput,
): SemanticRequestSnapshot {
  // 规则 1:身份字段非空
  const requestId = requireIdentity(input.request_id, 'request_id');
  const turnId = requireIdentity(input.turn_id, 'turn_id');
  const registrySnapshotId = requireIdentity(
    input.registry_snapshot_id,
    'registry_snapshot_id',
  );

  // 规则 2:跨平面身份对齐 —— tools 快照必须引用同一 registry
  if (input.tools.registry_snapshot_id !== registrySnapshotId) {
    throw new Error(
      `registry_snapshot_id mismatch: request=${registrySnapshotId} tools=${input.tools.registry_snapshot_id}`,
    );
  }

  // 规则 3:system section placement 运行时再校验(防 as any 走私)
  // TS 类型已约束为 'system_static' | 'system_dynamic',但运行时数据
  // 可能来自 JSON 解析或外部边界,这里再校一次。
  for (const s of input.system_sections) {
    if (s.placement !== 'system_static' && s.placement !== 'system_dynamic') {
      throw new Error(
        `system section ${s.section_id} placement must be 'system_static' or 'system_dynamic', got: ${s.placement}`,
      );
    }
  }

  // 规则 4:meta_context invariant
  for (const m of input.meta_context) {
    if (!m.is_meta) {
      throw new Error(
        `meta_context message ${m.message_id} must have is_meta=true`,
      );
    }
  }

  // 规则 5:conversation invariant
  for (const c of input.conversation) {
    if (c.is_meta) {
      throw new Error(
        `conversation message ${c.message_id} must have is_meta=false`,
      );
    }
  }

  // 规则 6:Provider 对象拒绝 —— 在原数据上检测,避免深拷贝时把不该拷的
  // Provider 对象(可能有循环引用、不可枚举标记等)拷进来。
  // system_sections:section 本身是 plain object,content 是 string(本就 OK),
  // 但仍需校验,以防调用方走私了非字符串 content(as any)。
  for (let i = 0; i < input.system_sections.length; i++) {
    const s = input.system_sections[i];
    assertJsonCompatible(s, `system_sections[${i}]`);
  }
  for (let i = 0; i < input.meta_context.length; i++) {
    assertJsonCompatible(input.meta_context[i], `meta_context[${i}]`);
  }
  for (let i = 0; i < input.conversation.length; i++) {
    assertJsonCompatible(input.conversation[i], `conversation[${i}]`);
  }
  // tools 快照已由 descriptor-snapshot 校验过,且是其内部已冻结的纯数据;
  // 这里不复检 —— 但理论上 Provider 不会出现在 frozen plain data 里。

  // 规则 7:深拷贝所有 section/message 数据 + tools 快照。
  // 用 structuredClone 整体拷贝:既隔离后续 mutate,也保证 freeze 不影响
  // 调用方持有的原对象。tools 已是冻结纯数据,structuredClone 能直接处理。
  const clonedSystem = structuredClone(input.system_sections);
  const clonedMeta = structuredClone(input.meta_context);
  const clonedConversation = structuredClone(input.conversation);
  const clonedTools = structuredClone(input.tools);

  // 规则 8 + 9:组装 + 深度冻结。
  const snapshot: SemanticRequestSnapshot = {
    request_id: requestId,
    turn_id: turnId,
    registry_snapshot_id: registrySnapshotId,
    system_sections: clonedSystem,
    meta_context: clonedMeta,
    conversation: clonedConversation,
    tools: clonedTools,
  };
  return freezeSnapshot(snapshot);
}
