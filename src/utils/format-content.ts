// src/utils/format-content.ts
// 纯函数:把 user 消息的 content 转人类可读字符串,用于 resume 时回显到 TUI。
//
// 本函数只管「显示」,不管发送给模型的真实数据——后者由 streamingQuery 处理。
// 字符串 content 原样透传;数组 content 按 block.type 分支转占位符,空格连接。

import type { ContentBlock } from '../agent/types.js';

/**
 * 格式化 user 消息的 content 用于 resume 回显。
 *
 * 分支:
 *   - text       原文
 *   - image      [图片 <cachePath>] 或 [图片](无 cachePath 防御)
 *   - tool_use   [工具调用]
 *   - tool_result [工具结果]
 *
 * 拼接:非空片段用空格连接。空数组返回空字符串。
 */
export function formatUserContentForResume(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map(block => {
      switch (block.type) {
        case 'text': return block.text;
        case 'image': return block.cachePath ? `[图片 ${block.cachePath}]` : '[图片]';
        case 'tool_use': return '[工具调用]';
        case 'tool_result': return '[工具结果]';
        default: return '';
      }
    })
    .filter(s => s.length > 0)
    .join(' ');
}
