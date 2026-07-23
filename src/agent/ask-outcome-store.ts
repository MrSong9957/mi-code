// src/agent/ask-outcome-store.ts
// AUTO-0025 Phase B (Task 6):ask_user_question 结构化结果的临时存储(meta 旁路)。
//
// 物理本质:executor 拿到结构化 outcome 后暂存到此处,
// streaming-query 阶段3 take 后消费。take 即删(一次性消费语义)。
//
// 不进 API 通道:ToolResultBlock.content 仍是 serializeAskQuestionOutcome 产出的字符串。
// 此 store 是纯 UI 通道的临时载体。
//
// 生命周期三级清理(防 orphan/内存泄漏):
// 1. take(id) 即删 —— 正常路径:streaming-query take 后立即消费
// 2. finally sweep —— turn 结束兜底:streamingQuery finally 块调用 sweep() 清理未消费的
// 3. TTL 5min 兜底 —— 极端情况(take miss / 进程异常):sweep 时删超时 entry

import type { StructuredAskResult } from './ask-user-types.js';

const TTL_MS = 5 * 60 * 1000;

interface StoredEntry {
  result: StructuredAskResult;
  createdAt: number;
}

const store = new Map<string, StoredEntry>();

export const askOutcomeStore = {
  /** 暂存结构化结果(executor 调用)。 */
  set(id: string, result: StructuredAskResult): void {
    store.set(id, { result, createdAt: Date.now() });
  },

  /** 取出并删除(一次性消费)。streaming-query 阶段3 调用。 */
  take(id: string): StructuredAskResult | undefined {
    const entry = store.get(id);
    if (!entry) return undefined;
    store.delete(id);
    return entry.result;
  },

  /** 删除超 TTL 的 entry(streamingQuery finally 调用,兜底清理)。 */
  sweep(): void {
    const now = Date.now();
    for (const [id, entry] of store) {
      if (now - entry.createdAt > TTL_MS) store.delete(id);
    }
  },

  /** 全清(极端兜底/测试用)。 */
  clear(): void {
    store.clear();
  },

  /** 当前 entry 数(供测试验证无残留:turn 结束后应为 0)。 */
  size(): number {
    return store.size;
  },
};
