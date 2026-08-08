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
import type { Translator } from '../locale/index.js';
import type { InteractiveAskInput, DialogResult } from './interactive-ask.js';
import { mapDialogResult, PERMISSION_ANSWER_VALUES } from './permission-answer-mapping.js';

/**
 * 构造 auto permission dialog provider（spec §5.1）。
 *
 * 返回的 dialog 函数：InteractiveAskInput → askManager.ask(4选项问卷) → mapDialogResult → DialogResult。
 * 复用共享 AskUserManager 单例与 ask-question-store TUI（不新建第二套问卷组件）。
 */
export function createAutoPermissionDialogProvider(
  askMgr: AskUserManager,
  translator: Translator,
): (input: InteractiveAskInput) => Promise<DialogResult> {
  return async (input: InteractiveAskInput): Promise<DialogResult> => {
    const request: AskQuestionRequest = {
      questions: [{
        question: translator.t('permission.question', {
          tool: input.toolName,
          reason: input.decision.human_reason ?? '',
        }),
        header: translator.t('permission.header'),
        options: [
          {
            label: translator.t('permission.options.allowOnce.label'),
            description: translator.t('permission.options.allowOnce.description'),
            value: PERMISSION_ANSWER_VALUES.allowOnce,
          },
          {
            label: translator.t('permission.options.allowExactSession.label'),
            description: translator.t('permission.options.allowExactSession.description'),
            value: PERMISSION_ANSWER_VALUES.allowExactSession,
          },
          {
            label: translator.t('permission.options.allowAlways.label'),
            description: translator.t('permission.options.allowAlways.description'),
            value: PERMISSION_ANSWER_VALUES.allowAlways,
          },
          {
            label: translator.t('permission.options.reject.label'),
            description: translator.t('permission.options.reject.description'),
            value: PERMISSION_ANSWER_VALUES.reject,
          },
        ],
        multiSelect: false,
      }],
    };
    const outcome = await askMgr.ask(request);
    return mapDialogResult(outcome);
  };
}
