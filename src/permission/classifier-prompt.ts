// classifier 固定 prompt（Task 4 / 设计 §7.2、§11）
//
// 物理本质：classifier 的“问题模板”。只构建固定 prefix + stage instruction，
// 不读 transcript、不随 mode/stage/provider capability 变化。
//
// 不变量：
//   - prefix 与 stage instruction 是深冻结静态常量；
//   - Stage 1 只问 ALLOW|FLAG，Stage 2 只问 ALLOW|DENY；
//   - 不承诺固定 tokenizer token / 字节数（协议是枚举值，不是编码承诺）。

import type { PermissionClassifierInput } from './classifier-input.js';

/**
 * Stage 1 instruction（fast filter）。
 * 权限协议只约束严格单枚举 ALLOW|FLAG、无额外文本；不承诺 token/byte 数。
 */
export const STAGE1_INSTRUCTION = Object.freeze(
  'Decide whether the tool call is clearly safe. Reply with exactly one of ALLOW or FLAG; no additional text.',
);

/**
 * Stage 2 instruction（reasoned review）。
 * 权限协议只约束严格单枚举 ALLOW|DENY、无额外文本；不承诺 token/byte 数。
 */
export const STAGE2_INSTRUCTION = Object.freeze(
  'Review the tool call for safety. Reply with exactly one of ALLOW or DENY; no additional text.',
);

/** 规则段输入（A33：非空 user 段替换 defaults） */
export interface ClassifierRuleSections {
  readonly defaults: readonly string[];
  readonly organization: readonly string[];
  readonly user: readonly string[];
}

/**
 * 渲染 classifier rule sections（A33）。
 *
 * 语义：非空 user 段替换 defaults（user + organization）；
 *       空 user 段回退 defaults + organization。
 * 不做普通字符串拼接——是段替换语义。
 */
export function renderClassifierRuleSections(sections: ClassifierRuleSections): string[] {
  const userPart = sections.user.length > 0 ? sections.user : sections.defaults;
  return [...userPart, ...sections.organization];
}

/**
 * 构建 classifier prompt prefix（不可变）。
 *
 * prefix = 投影后的用户意图 + executable tool call + 渲染后的 rule sections。
 * Stage 1/Stage 2 共用同一 prefix（设计 §7.2）；stage instruction 由 provider request 独立追加。
 */
export function buildClassifierPromptPrefix(
  input: PermissionClassifierInput,
  ruleSections: readonly string[],
): string {
  const userIntent = input.authenticUserMessages
    .map((m) => `User: ${m.content}`)
    .join('\n');
  const toolCall = `Tool: ${input.executableToolCall.canonicalToolName}\nInput: ${JSON.stringify(input.executableToolCall.input)}`;
  const rules = ruleSections.length > 0 ? `\nRules:\n${ruleSections.join('\n')}` : '';
  return Object.freeze(`${userIntent}\n${toolCall}${rules}`);
}
