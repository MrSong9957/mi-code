// Auto permission dialog provider（Task 7 production wiring, spec §5.1）。
//
// 物理本质：auto resolver 的 dialogProvider 生产实现。把 InteractiveAskInput 转成
// 4 选项问卷，经共享 AskUserManager 弹出，outcome 经 mapDialogResult 映射为 DialogResult。
//
// 职责（严格，spec §5）：InteractiveAskInput → AskUserManager.ask() → AskQuestionOutcome
// → DialogResult。**不持有** onSessionAllow/onPersistRule/recheck —— 那些是
// resolveInteractiveAsk 的 options，由 resolver 层 handleDialogResult 消费。
//
// 模块边界：side-effect-free。不放 index.ts（index.ts 是带 shebang 的 CLI 入口，
// 顶层有 new AskUserManager / new RuntimeSecurityGate / bootstrap 等 TUI 副作用，
// 无 main guard；测试 import 它会触发副作用）。index.ts import 本模块做生产 wiring。
// permission → agent（AskUserManager）是既有依赖模式，非新循环。

import type { AskUserManager } from '../agent/ask-user-manager.js';
import type { AskQuestionRequest } from '../agent/ask-user-types.js';
import type { InteractiveAskInput, DialogResult } from './interactive-ask.js';
import {
  mapDialogResult,
  ALLOW_ONCE_LABEL,
  ALLOW_EXACT_LABEL,
  ALLOW_ALWAYS_LABEL,
} from './permission-answer-mapping.js';

/**
 * 构造 auto permission dialog provider（spec §5.1）。
 *
 * 返回的 dialog 函数：InteractiveAskInput → askManager.ask(4选项问卷) → mapDialogResult → DialogResult。
 * 复用共享 AskUserManager 单例与 ask-question-store TUI（不新建第二套问卷组件）。
 */
export function createAutoPermissionDialogProvider(
  askMgr: AskUserManager,
): (input: InteractiveAskInput) => Promise<DialogResult> {
  return async (input: InteractiveAskInput): Promise<DialogResult> => {
    const request: AskQuestionRequest = {
      questions: [{
        question:
          `Allow this action?\n\n` +
          `Tool: ${input.toolName}\n` +
          `Reason: ${input.decision.human_reason ?? ''}`,
        header: 'Permission (auto)',
        options: [
          { label: ALLOW_ONCE_LABEL, description: 'Run this action exactly once. Not remembered.' },
          { label: ALLOW_EXACT_LABEL, description: 'Run now and remember this exact command for this session.' },
          { label: ALLOW_ALWAYS_LABEL, description: 'Run now and always allow (persisted to config; re-checked against hard deny).' },
          { label: 'Reject', description: 'Do not run this action.' },
        ],
        multiSelect: false,
      }],
    };
    const outcome = await askMgr.ask(request);
    return mapDialogResult(outcome);
  };
}
