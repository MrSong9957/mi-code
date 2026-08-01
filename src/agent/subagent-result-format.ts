// 子代理结果格式化器(共享 envelope)
//
// 物理本质:派工单回执上的"工单状态戳"。把 SubagentResult 序列化成
// 带结构化 status 前缀的字符串,让主 agent 看到戳就能区分:
//   - status=completed → 子代理成功,直接用后面的 summary 文本
//   - status=incomplete reason=xxx → 子代理未完成(含已恢复的工作)
//   - status=unverified → 子代理没拿到证据,结果不可信
//
// 此模块从 spawn-agent-tool.ts 抽取,供 spawn_agent 和 task 两个工具共享,
// 保证两个用户可见的子代理工具走同一套可靠性路径(envelope 一致)。

import type { SubagentResult } from './subagent.js';

/**
 * 把 SubagentResult 序列化为带结构化 status 前缀的字符串。
 *
 * 格式:
 *   [Subagent status=completed]
 *   <summary>
 *
 *   [Subagent status=incomplete reason=max_turns]
 *   <partial or diagnostic text>
 *
 * reason 仅在 incomplete 时附加:incomplete 的诊断价值在于"为什么没完成"。
 * unverified 是独立状态(无证据),不加 reason 避免噪音。
 * background 不加 status 戳(它不是最终结果,只是"已派发"通知)。
 */
export function formatSubagentResult(result: SubagentResult): string {
  if (result.status === 'background') return result.text;
  const reason = result.status === 'incomplete' && result.terminationReason
    ? ` reason=${result.terminationReason}`
    : '';
  return `[Subagent status=${result.status}${reason}]\n${result.text}`;
}
