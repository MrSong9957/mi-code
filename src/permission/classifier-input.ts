// classifier 输入投影（Task 4 / 设计 §7.1 最小可信输入）
//
// 物理本质：classifier 只看“用户真实意图 + 当前一个待审核 tool call”。
//   - authentic user-authored messages：role=user 且 authoredByUser===true 且 content
//     是纯文本（string 或 TextBlock[]），不含 tool_result 块。
//   - executableToolCall：当前待审核的这一个 tool call，不含同 turn 其他 tool call。
//
// 安全边界（Task 4 fix）：旧实现用“role=user 且无 tool_result”猜测 authentic，会被
// hook/background/recovery/compaction/agent 转述等注入内容冒充。修复后要求
// authoredByUser === true（只在用户输入可信边界 handleUserSubmit 设置）。
// 未知来源（无 authoredByUser）一律排除 —— 默认未知 ≠ 用户。
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
 * 判断一条 Message 是否是真实用户-authored 文本消息（安全边界）。
 *
 * 必须同时满足：
 *   1. authoredByUser === true（只在可信用户输入边界设置）；
 *   2. role === 'user'；
 *   3. content 不含 tool_result 块（工具输出不是用户原文，即使伪造 authoredByUser）；
 *   4. content 为 string 或全 TextBlock（纯文本）。
 *
 * 未知来源（无 authoredByUser）-> 排除。assistant/thinking/tool_use/tool_result -> 排除。
 */
function extractAuthenticUserText(msg: Message): string | null {
  // 1. 必须显式 authoredByUser === true（默认未知 ≠ 用户）
  if (msg.authoredByUser !== true) return null;
  // 2. role === 'user'
  if (msg.role !== 'user') return null;
  // 3. content 为 string
  if (typeof msg.content === 'string') return msg.content;
  // 4. content 是 ContentBlock[]：含 tool_result -> 排除（即使伪造 authoredByUser）
  const blocks = msg.content as ContentBlock[];
  if (!Array.isArray(blocks)) return null;
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
