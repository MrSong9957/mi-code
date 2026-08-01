// src/agent/model-message-sanitizer.ts
//
// sanitizeMessagesForModel:把含 uiOnly 内部标记的 messages 转为 provider 可见的标准 messages。
//
// 唯一职责(在 streamingQuery 构造 model messages 时调用):
//   - 删除所有 uiOnly===true 的 text block
//   - 保留其他 text/tool_use/tool_result 等 block,顺序不变
//   - 输出 block 不携带 uiOnly 内部字段
//   - 某 message 过滤后 content 为空 → 删除整条 message
//   - string content 原样保留
//   - 不修改输入 messages(返回新数组/新对象)
//
// 不用文本匹配("当前状态:"等)——只认 uiOnly 结构化标记。

import type { Message, ContentBlock, TextBlock } from './types.js';

/**
 * 剔除 uiOnly text block,返回 provider 可见的纯净 messages。
 * 不修改输入。输出不含 uiOnly 字段。空 message 删除。
 */
export function sanitizeMessagesForModel(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    // string content 原样保留(深拷贝以避免共享引用)
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }
    // array content:过滤 uiOnly block,清理输出不带 uiOnly 字段
    const kept: ContentBlock[] = [];
    for (const block of msg.content) {
      if (isUiOnlyText(block)) continue; // 删除 uiOnly block
      kept.push(stripBlock(block));
    }
    // 过滤后为空 → 删除整条 message
    if (kept.length === 0) continue;
    result.push({ role: msg.role, content: kept });
  }
  return result;
}

/** 判断 block 是否为 uiOnly text block */
function isUiOnlyText(block: ContentBlock): boolean {
  return block.type === 'text' && (block as TextBlock).uiOnly === true;
}

/** 输出 block 不携带 uiOnly 字段(text block 重建为纯净 {type,text}) */
function stripBlock(block: ContentBlock): ContentBlock {
  if (block.type === 'text') {
    // 重建纯净 text block,丢弃 uiOnly 字段
    return { type: 'text', text: block.text };
  }
  // 非 text block(tool_use/tool_result/image)原样返回(它们无 uiOnly)
  return block;
}
