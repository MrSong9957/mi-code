import { describe, expect, test } from 'vitest';
import { createLanguageStore, createTranslator, type Language } from '../../locale/index.js';
import { createAutoPermissionDialogProvider } from '../../permission/auto-permission-dialog.js';
import type { AskQuestionOutcome, AskQuestionRequest } from '../../agent/ask-user-types.js';
import type { DialogResult } from '../../permission/interactive-ask.js';

class ScriptedAskManager {
  lastRequest: AskQuestionRequest | null = null;

  constructor(private readonly outcome: AskQuestionOutcome) {}

  async ask(request: AskQuestionRequest): Promise<AskQuestionOutcome> {
    this.lastRequest = request;
    return this.outcome;
  }
}

const askInput = {
  decision: { decision_id: 'd1', behavior: 'ask' as const, reason_code: 'x', human_reason: 'r' },
  toolName: 'run_bash',
  input: { command: 'echo hi' },
  origin: 'main' as const,
};

function createDialog(outcome: AskQuestionOutcome, language: Language = 'zh-CN') {
  const manager = new ScriptedAskManager(outcome);
  const translator = createTranslator(createLanguageStore(language));
  return {
    manager,
    dialog: createAutoPermissionDialogProvider(manager as never, translator),
  };
}

describe('createAutoPermissionDialogProvider', () => {
  test.each([
    ['permission.allowOnce', { kind: 'approved_once' }],
    ['permission.allowExactSession', { kind: 'approved_session' }],
    ['permission.allowAlways', { kind: 'approved_always' }],
    ['permission.reject', { kind: 'rejected' }],
  ] as const)('returns the decision mapped from stable value %s', async (value, expected) => {
    const { dialog } = createDialog({
      kind: 'submitted',
      answers: { q0: '本地化标签' },
      answerValues: { q0: value },
    });

    expect(await dialog(askInput as never)).toEqual(expected satisfies DialogResult);
  });

  test('preserves cancelled and chat safety behavior', async () => {
    expect(await createDialog({ kind: 'cancelled' }).dialog(askInput as never))
      .toEqual({ kind: 'escape' });
    expect(await createDialog({ kind: 'chat', feedback: 'later' }).dialog(askInput as never))
      .toEqual({ kind: 'rejected' });
  });

  test.each([
    ['zh-CN' as const, 'Bash 命令包含无法解析的变量，需要审核'],
    ['en-US' as const, 'Bash command has unresolvable variable, needs review'],
  ])('localizes the unresolvable-variable reason for %s', async (language, expectedReason) => {
    const { manager, dialog } = createDialog({ kind: 'cancelled' }, language);

    await dialog({
      ...askInput,
      decision: {
        ...askInput.decision,
        reason_code: 'permission.command_unresolvable_var',
        human_reason: 'Bash command has unresolvable variable, needs review',
      },
    } as never);

    expect(manager.lastRequest?.questions[0]?.question).toContain(expectedReason);
  });

  test('keeps an unknown reason code as its raw human reason', async () => {
    const { manager, dialog } = createDialog({ kind: 'cancelled' }, 'zh-CN');

    await dialog({
      ...askInput,
      decision: {
        ...askInput.decision,
        reason_code: 'permission.unknown',
        human_reason: 'Unrecognized policy diagnostic',
      },
    } as never);

    expect(manager.lastRequest?.questions[0]?.question).toContain('Unrecognized policy diagnostic');
  });

  test.each([
    {
      language: 'zh-CN' as const,
      question: '允许执行此操作吗？\n\n工具：run_bash\n原因：r',
      header: '权限',
      options: [
        { label: '允许一次', description: '仅执行这一次，不记住此选择。', value: 'permission.allowOnce' },
        { label: '本会话允许此精确操作', description: '立即执行，并在本会话中记住这个精确操作。', value: 'permission.allowExactSession' },
        { label: '始终允许', description: '立即执行并持久允许；仍会重新检查硬拒绝规则。', value: 'permission.allowAlways' },
        { label: '拒绝', description: '不执行此操作。', value: 'permission.reject' },
      ],
    },
    {
      language: 'en-US' as const,
      question: 'Allow this action?\n\nTool: run_bash\nReason: r',
      header: 'Permission',
      options: [
        { label: 'Allow once', description: 'Run this action exactly once. Not remembered.', value: 'permission.allowOnce' },
        { label: 'Allow this exact action for this session', description: 'Run now and remember this exact action for this session.', value: 'permission.allowExactSession' },
        { label: 'Always allow', description: 'Run now and persist this permission; hard-deny rules are still re-checked.', value: 'permission.allowAlways' },
        { label: 'Reject', description: 'Do not run this action.', value: 'permission.reject' },
      ],
    },
  ])('builds a $language request from typed translations and stable values', async ({ language, question, header, options }) => {
    const { manager, dialog } = createDialog({ kind: 'cancelled' }, language);

    await dialog(askInput as never);

    expect(manager.lastRequest?.questions[0]).toEqual({
      question,
      header,
      options,
      multiSelect: false,
    });
  });
});
