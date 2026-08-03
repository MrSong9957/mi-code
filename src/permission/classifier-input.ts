// classifier 输入投影（Task 4 / 设计 §7.1 最小可信输入）
//
// 物理本质：classifier 只看“用户真实意图 + 当前一个待审核 tool call”。
//   - authentic user-authored messages：role=user 且 content 是纯文本（string 或 TextBlock[]），
//     不含 tool_result 块。assistant/thinking/tool_use/tool_result 全部排除。
//   - executableToolCall：当前待审核的这一个 tool call，不含同 turn 其他 tool call。
//
// 真实数据模型适配：现有 Message 是 { role, content: string | ContentBlock[] }，
// 没有 source/authoredByUser 字段。判定“真实用户文本”的规则：
//   role === 'user' && content 不含 tool_result 块（tool_result 是工具输出，非用户原文）。
//   content 为 string 或 TextBlock[]（纯文本）均算真实用户文本。
//
// 投影结果 frozen；调用方（classifier）据此决定 allow/deny，不重新解释 Message[]。

import type { Message, ContentBlock } from '../agent/types.js';

/** 真实用户-authored 消息（投影后的最小形式） */
export interface AuthenticUserMessage {
  readonly role: 'user';
  readonly content: string;
}

/** 当前待审核的 executable tool call */
export interface ExecutableToolCall {
  readonly callId: string;
  readonly canonicalToolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** classifier 最小可信输入（设计 §7.1） */
export interface PermissionClassifierInput {
  readonly authenticUserMessages: readonly AuthenticUserMessage[];
  readonly executableToolCall: ExecutableToolCall;
}

/**
 * 判断一条 Message 是否是真实用户-authored 文本消息。
 *
 * 规则：role === 'user' 且 content 不含 tool_result 块。
 * - content 是 string -> 真实用户文本。
 * - content 是 ContentBlock[] 且全部是 TextBlock -> 真实用户文本（拼接）。
 * - content 含 tool_result 块 -> 工具输出，排除。
 * - role === 'assistant' -> 排除（含 thinking/tool_use）。
 */
function extractAuthenticUserText(msg: Message): string | null {
  if (msg.role !== 'user') return null;
  if (typeof msg.content === 'string') return msg.content;
  // content 是 ContentBlock[]：检查是否含 tool_result（工具输出，非用户原文）
  const blocks = msg.content as ContentBlock[];
  if (!Array.isArray(blocks)) return null;
  // 含 tool_result -> 排除
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  // 全部 TextBlock -> 拼接为纯文本
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') texts.push(b.text);
    else return null; // 含 image/其他非文本块 -> 不投影（保守）
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/** freeze 工具 call（深 freeze input 的第一层） */
function freezeToolCall(call: ExecutableToolCall): ExecutableToolCall {
  return Object.freeze({
    callId: call.callId,
    canonicalToolName: call.canonicalToolName,
    input: Object.freeze({ ...call.input }),
  }) as ExecutableToolCall;
}

/**
 * 投影 messages + 当前 executableToolCall 为 classifier 最小可信输入。
 *
 * 只保留 authentic user-authored 文本消息 + 当前一个 tool call；
 * assistant/thinking/tool output/tool result/tool_use/其他 tool call 全部在投影前丢弃。
 * 返回 frozen 对象。
 */
export function projectPermissionClassifierInput(
  messages: readonly Message[],
  executableToolCall: ExecutableToolCall,
): PermissionClassifierInput {
  const authenticUserMessages: AuthenticUserMessage[] = [];
  for (const msg of messages) {
    const text = extractAuthenticUserText(msg);
    if (text !== null) {
      authenticUserMessages.push(Object.freeze({ role: 'user', content: text }));
    }
  }
  return Object.freeze({
    authenticUserMessages: Object.freeze(authenticUserMessages) as readonly AuthenticUserMessage[],
    executableToolCall: freezeToolCall(executableToolCall),
  }) as PermissionClassifierInput;
}
