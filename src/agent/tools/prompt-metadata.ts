// src/agent/tools/prompt-metadata.ts
// Wave B Task 3 (M-020/M-024): Tool-local Prompt Metadata (BRC-2).
//
// 物理本质:把单个工具"在 prompt 层面的元数据"压成一份不可变记录。这份记录
// 只描述身份与声明,不携带任何 enforcement 真值 —— `declared_policy_refs` 只是
// 引用,`evaluation_status` 只决定 description asset 是否进入 Provider schema,
// 真正的 policy 判断由 runtime policy(M-026, Wave C)负责。
//
// 关键不变量:
//   - tool_id 非空(requireIdentity 校验)。
//   - evaluation_status 必须恰好是 'approved' | 'candidate' | 'rejected',
//     其他字符串一律拒绝(避免调用方走私中间态)。
//   - 输出深拷贝数组(required_capabilities / declared_policy_refs)+ 深冻结,
//     调用方之后 mutate 输入数组不能影响 metadata。
//   - description_asset_ref 若非 null,则连同 asset_id / asset_version 一起冻结。
//
// 本模块不感知 overlay、不感知 base snapshot、不感知 capability ——
// 它只是一个值的构造器。把"是否存在 / 是否批准"留给 overlay 层判断。

import { freezeSnapshot, requireIdentity } from '../contracts/identities.js';

/** 描述资产引用:asset_id + asset_version 组成的二元组,或 null(无 description asset)。 */
export type DescriptionAssetRef = { asset_id: string; asset_version: string };

/** evaluation_status 的合法字面量集合(精确匹配)。 */
export type EvaluationStatus = 'approved' | 'candidate' | 'rejected';

const ALLOWED_EVALUATION_STATUS: ReadonlySet<string> = new Set([
  'approved',
  'candidate',
  'rejected',
]);

/**
 * 单个工具的 Prompt 元数据(不可变)。
 *
 * - tool_id:对应 base snapshot 中的 tool_id(身份字段,非空)。
 * - description_asset_ref:工具说明资产引用(可为 null)。
 *   非 null 时必须 approved,否则对应工具不进入 Provider schema。
 * - required_capabilities:工具声明依赖的能力名数组。
 *   只要其中任一在 capability snapshot 中是 'unsupported' 或 'unknown',
 *   该工具在 overlay 派生时必须被 excluded。
 * - declared_policy_refs:声明与哪些 runtime policy 对齐的引用数组。
 *   仅作引用,不把文本声明当作 enforcement(M-026 负责真实 enforcement)。
 * - evaluation_status:描述资产的评估状态。
 *   只有 'approved' 才允许进入 Provider schema;'candidate'/'rejected' 一律排除。
 */
export interface ToolPromptMetadata {
  readonly tool_id: string;
  readonly description_asset_ref: Readonly<DescriptionAssetRef> | null;
  readonly required_capabilities: readonly string[];
  readonly declared_policy_refs: readonly string[];
  readonly evaluation_status: EvaluationStatus;
}

/**
 * 构造 ToolPromptMetadata 的输入。结构上与输出一致,但不保证不可变性;
 * createToolPromptMetadata 会负责校验、深拷贝、冻结。
 */
export interface ToolPromptMetadataInput {
  tool_id: string;
  description_asset_ref: DescriptionAssetRef | null;
  required_capabilities: string[];
  declared_policy_refs: string[];
  evaluation_status: EvaluationStatus;
}

/**
 * 构建一份不可变的 ToolPromptMetadata。
 *
 * 规则(spec §8.3):
 *   1. tool_id 必须非空(requireIdentity)。
 *   2. evaluation_status 必须恰好是 'approved' | 'candidate' | 'rejected',
 *      其他字符串一律拒绝(抛错信息提及 evaluation_status)。
 *   3. description_asset_ref 非 null 时,深拷贝;为 null 时保持 null。
 *   4. required_capabilities / declared_policy_refs 深拷贝(隔离后续 mutate)。
 *   5. 输出递归冻结(freezeSnapshot):顶层 + 两个数组 + description_asset_ref。
 *
 * @throws 当 tool_id 为空或 evaluation_status 非法时。
 */
export function createToolPromptMetadata(
  input: ToolPromptMetadataInput,
): ToolPromptMetadata {
  // 规则 1:tool_id 非空校验
  const tool_id = requireIdentity(input.tool_id, 'tool_id');

  // 规则 2:evaluation_status 精确校验。必须在拷贝/冻结之前完成,
  // 这样校验失败时不会留下部分冻结的对象。
  if (
    typeof input.evaluation_status !== 'string' ||
    !ALLOWED_EVALUATION_STATUS.has(input.evaluation_status)
  ) {
    throw new Error(
      `invalid evaluation_status: ${JSON.stringify(input.evaluation_status)} ` +
        `(must be one of: approved, candidate, rejected)`,
    );
  }
  const evaluation_status = input.evaluation_status as EvaluationStatus;

  // 规则 3 + 4:深拷贝(隔离后续 mutate)。description_asset_ref 非 null 时也深拷贝。
  const required_capabilities: string[] = structuredClone(input.required_capabilities);
  const declared_policy_refs: string[] = structuredClone(input.declared_policy_refs);
  const description_asset_ref: DescriptionAssetRef | null =
    input.description_asset_ref === null
      ? null
      : structuredClone(input.description_asset_ref);

  // 规则 5:递归冻结 —— 两个数组、description_asset_ref、以及顶层 metadata。
  // freezeSnapshot 会就地递归冻结,因此先拷贝再冻,避免影响调用方的输入。
  freezeSnapshot(required_capabilities);
  freezeSnapshot(declared_policy_refs);
  if (description_asset_ref !== null) {
    freezeSnapshot(description_asset_ref);
  }

  const metadata: ToolPromptMetadata = {
    tool_id,
    description_asset_ref,
    required_capabilities,
    declared_policy_refs,
    evaluation_status,
  };
  return freezeSnapshot(metadata);
}
