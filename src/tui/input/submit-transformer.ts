// src/tui/input/submit-transformer.ts
// 提交文本处理：两个阶段，勿混杂物。
//
// 阶段1 - Text transformation：splitSubmitTracks 把 rawText 分裂成两轨
// 阶段2 - Commit orchestration：commitNewTurn 编排副作用（history 落盘 + pipeline 发射）
//
// 未来若有 file/command reference 需双轨，在阶段1聚合，不污染 paste-handler。

import { expandPastedTextRefs } from './paste-handler.js';

export interface SubmitTexts {
  historyText: string;  // 占位符版本 → 历史（省磁盘）
  agentText: string;    // 展开版本 → agent（需完整上下文）
}

/** 阶段1：提交文本双轨分裂 */
export function splitSubmitTracks(rawText: string): SubmitTexts {
  const historyText = rawText.trim();
  const agentText = expandPastedTextRefs(historyText);
  return { historyText, agentText };
}

/** 阶段2：新 turn 提交的最小副作用接口 */
export interface SubmitDeps {
  addEntry: (input: string, project: string) => Promise<void>;
  clearTurnState: () => void;
  emit: (block: { kind: 'user_input'; text: string }) => void;
}

/**
 * 阶段2：执行新 turn 提交副作用，返回是否真正提交。
 *
 * 双轨契约的调用侧守护：historyText → addEntry，agentText → emit。
 * 抽出此函数是因为 historyText/agentText 都是 string，
 * TypeScript 无法在调用侧区分，两者接反只能靠运行时测试防护。
 */
export async function commitNewTurn(
  deps: SubmitDeps,
  args: { historyText: string; agentText: string; project: string; isProcessing: boolean }
): Promise<boolean> {
  const { addEntry, clearTurnState, emit } = deps;
  const { historyText, agentText, project, isProcessing } = args;
  if (!agentText || isProcessing) return false;
  await addEntry(historyText, project);
  // clearTurnState 必须在 user_input emit 之前（emit 后消费者读清空后的 turn 状态）
  clearTurnState();
  emit({ kind: 'user_input', text: agentText });
  return true;
}
