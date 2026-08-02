// 子代理工作日志接口
//
// 物理本质:子代理执行期间的"流水账本"。子代理每完成一条消息边界
// (工具调用配对完成 / 最终 assistant),把当前 messages 快照交给 journal.checkpoint()
// 持久化。这样即使后续 provider/通信失败,已完成的工作也能从 journal.load() 恢复。
//
// 实现契约:
//   - 每个 child 拥有独立的 executionId 和独立的 JSONL 文件
//   - checkpoint 只追加新增的消息(增量),不重复已有记录
//   - load 返回完整的有序 transcript
//   - 写入是 awaited 且串行的(一个 journal 只有一个 writer)
//   - 失败的写入直接抛错(fail-fast),调用方将其转为 incomplete/error

import type { ContentBlock, Message } from './types.js';

/**
 * 子代理执行期间的增量工作日志。
 *
 * 一个 journal 实例对应一次子代理执行(executionId)。同一 parent 下不同
 * executionId 写不同的文件,互不干扰。
 */
export interface SubagentJournal {
  /** 本次子代理执行的唯一标识(对应一个独立的 JSONL 文件) */
  readonly executionId: string;
  /** 日志文件的绝对路径(供恢复输出引用,完整留痕) */
  readonly reference: string;
  /**
   * 持久化当前完整的 messages 快照(增量)。
   *
   * 多次调用同一快照时只追加新增的消息(已持久化的不重复写)。
   * 写入失败必须抛错(fail-fast),绝不静默继续。
   */
  checkpoint(messages: readonly Message[]): Promise<void>;
  /** 加载完整的有序 transcript。损坏的尾部行会被跳过,保留更早的有效记录。 */
  load(): Promise<Message[]>;
}

/**
 * 子代理工作日志工厂。
 *
 * 每次前台子代理执行调用一次,创建一个绑定到新 executionId 的独立 journal。
 * 由 index.ts 注入到 spawn_agent / task 工具,生产路径用 SessionStore 实现。
 */
export type SubagentJournalFactory = () => SubagentJournal;

// ────────────────────────────────────────────────────────────────────────────
// 确定式恢复:从结构化 child messages 提取已完成的工作
//
// 物理本质:provider 崩溃 / final turn 交白卷后,从 journal 的 Message[] 里
// 把"真实发生过的工作"按 transcript 顺序拼出来给父代理看。journal 是无损源,
// 内联文本只是有界视图(默认 12000 字符上限)。
//
// 关键不变量:
//   - 只在存在至少一个"成功配对的 tool_result"时返回非空文本
//     (与现有 evidence gate 对齐:无证据则不展示假结果)
//   - 保留所有 assistant 非空文本 + 成功配对的 tool_result,按 transcript 顺序
//   - 同一 assistant 消息内的 text 块(无论在 tool_use 前还是后)都先于
//     紧随其后的 user tool_result —— 因为 provider 完成整条 assistant 消息后
//     runtime 才执行工具,执行顺序严格晚于该消息内所有 text 块
//   - 错误输出的 tool_result(以 [Tool Error]/[Blocked/Error: 开头)不算成功
//   - 截断只影响展示;journal 仍是无损源,reference 总是附在末尾

/** recoverSubagentWork 的输出:有界内联文本 + 成功配对的工具结果计数。 */
export interface RecoveredSubagentWork {
  /** 已恢复的内联文本(有界)。无成功配对结果时为空字符串。 */
  readonly text: string;
  /** 成功配对的 tool_result 数量(与现有 SubagentEvidence 解耦,不替换它)。 */
  readonly successfulToolResults: number;
}

/** 错误输出的 tool_result 内容前缀(与现有 isSuccessfulEvidence 一致)。 */
const ERROR_OUTPUT = /^\s*(?:\[Tool Error\]|\[Blocked|Error:)/i;

/** 内联恢复的字符上限(超出截断,journal 仍是无损源)。 */
const DEFAULT_MAX_RECOVERY_CHARS = 12_000;

/**
 * 从结构化的 child transcript 确定式地恢复已完成的工作。
 *
 * @param messages journal.load() 返回的有序 child 消息
 * @param journalReference journal 文件绝对路径(附在恢复文本末尾,供完整留痕)
 * @param maxChars 内联文本上限(默认 12000);截断只影响展示,不影响 journal
 */
export function recoverSubagentWork(
  messages: readonly Message[],
  journalReference: string,
  maxChars: number = DEFAULT_MAX_RECOVERY_CHARS,
): RecoveredSubagentWork {
  // 配对表:tool_use.id → { name, input }(用于在 result 出现时回查调用信息)
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  // 按顺序累积的恢复片段(assistant 文本 + 成功工具结果)
  const sections: string[] = [];
  let successfulToolResults = 0;

  for (const message of messages) {
    const blocks: ContentBlock[] = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;

    if (message.role === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          uses.set(block.id, { name: block.name, input: block.input });
        } else if (block.type === 'text' && block.text.trim()) {
          // assistant 文本:作为分析上下文保留(无论在 tool_use 前后)
          sections.push(`已有分析:${block.text.trim()}`);
        }
      }
      continue;
    }

    // user 消息:配对 tool_result
    for (const block of blocks) {
      if (block.type !== 'tool_result' || ERROR_OUTPUT.test(block.content)) continue;
      const use = uses.get(block.tool_use_id);
      if (!use) continue;
      successfulToolResults += 1;
      sections.push(
        `工具 ${use.name}(${JSON.stringify(use.input)})：\n${block.content}`,
      );
    }
  }

  // 无任何成功配对结果 → 返回空(不展示假结果,与 evidence gate 对齐)
  if (successfulToolResults === 0) {
    return { text: '', successfulToolResults: 0 };
  }

  const raw = [
    '已恢复的子代理工作：',
    ...sections,
    `完整留痕：${journalReference}`,
  ].join('\n');

  // 截断只影响展示;journal 仍是无损源
  const text = raw.length <= maxChars
    ? raw
    : `${raw.slice(0, maxChars)}\n[内联恢复内容已截断]\n完整留痕：${journalReference}`;

  return { text, successfulToolResults };
}
