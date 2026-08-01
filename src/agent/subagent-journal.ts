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

import type { Message } from './types.js';

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
