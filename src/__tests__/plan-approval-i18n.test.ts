// exit_plan_mode 工具的 i18n 缺口回归测试
//
// 物理本质：exit_plan_mode 构造的 plan-approval 问卷是程序固定 UI（非模型内容），
// label/description/otherLabel/question 必须随 locale 翻译；但决策映射必须依赖
// 稳定 value（answerValues），不能依赖可翻译的 label 文本，否则换语言后三个审批
// 分支会静默失效。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PlanStore } from '../plan/plan-store.js';
import { createExitPlanModeTool } from '../agent/tools/plan-tools.js';
import { AskUserManager } from '../agent/ask-user-manager.js';
import { createLanguageStore } from '../locale/language-store.js';
import { createTranslator } from '../locale/translator.js';
import type { Translator } from '../locale/types.js';
import type { AskQuestionOutcome, AskQuestionOutcomeCallback, AskQuestionRequest } from '../agent/ask-user-types.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'micode-plan-i18n-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeUi() {
  return {
    open: vi.fn<(id: string, request: AskQuestionRequest, done: AskQuestionOutcomeCallback) => void>(),
    close: vi.fn<(id: string) => void>(),
  };
}

interface Ready {
  ui: ReturnType<typeof makeUi>;
  onApprove: ReturnType<typeof vi.fn>;
  tool: ReturnType<typeof createExitPlanModeTool>;
}

function createReady(translator: Translator, usagePercent = 22): Ready {
  const store = new PlanStore(join(tempDir, 'micode'));
  const context = { sessionId: 'sess-1', turnId: 'turn-1' };
  store.beginTurn(context);
  store.write(context, 'plan body');
  const ui = makeUi();
  const manager = new AskUserManager(ui);
  const onApprove = vi.fn<(mode: 'auto' | 'build', clearContext: boolean) => void>();
  const tool = createExitPlanModeTool(manager, store, translator, {
    getUsagePercent: () => usagePercent,
    onApprove,
    getPlanContext: () => context,
  });
  return { ui, onApprove, tool };
}

function settle(ui: ReturnType<typeof makeUi>, outcome: AskQuestionOutcome): void {
  const [id, , done] = ui.open.mock.calls[0]!;
  done(id, outcome);
}

describe('exit_plan_mode i18n', () => {
  it('zh-CN request 使用中文的 question/option label/description/otherLabel', async () => {
    const translator = createTranslator(createLanguageStore('zh-CN'));
    const { ui, tool } = createReady(translator);
    const pending = tool.executor({});
    const request = ui.open.mock.calls[0]![1];

    expect(request.questions[0]!.question).toBe('Claude 已拟定执行方案，是否继续？');
    expect(request.questions[0]!.options.map((o) => o.label)).toEqual([
      '确认执行，清空上下文并使用自动模式',
      '确认执行，使用自动模式',
      '确认执行，手动审核修改',
    ]);
    expect(request.questions[0]!.options[0]!.description).toBe('重置对话（已占用 22%），Agent 自动执行所有修改');
    expect(request.questions[0]!.options[1]!.description).toBe('保留当前上下文，Agent 自动执行所有修改');
    expect(request.questions[0]!.options[2]!.description).toBe('保留当前上下文，每步修改需你确认');
    expect(request.otherLabel).toBe('提出修改意见');
    // 计划正文保持 RAW，不翻译
    expect(request.presentation?.content).toBe('plan body\n');

    settle(ui, { kind: 'cancelled' });
    await pending;
  });

  it('en-US request 使用英文的 question/option label/description/otherLabel', async () => {
    const translator = createTranslator(createLanguageStore('en-US'));
    const { ui, tool } = createReady(translator);
    const pending = tool.executor({});
    const request = ui.open.mock.calls[0]![1];

    expect(request.questions[0]!.question).toBe('Claude has drafted an execution plan. Continue?');
    expect(request.questions[0]!.options.map((o) => o.label)).toEqual([
      'Confirm, clear context and use auto mode',
      'Confirm, use auto mode',
      'Confirm, manually review changes',
    ]);
    expect(request.questions[0]!.options[0]!.description).toBe('Reset the conversation (22% used), Agent executes all changes automatically');
    expect(request.questions[0]!.options[1]!.description).toBe('Keep current context, Agent executes all changes automatically');
    expect(request.questions[0]!.options[2]!.description).toBe('Keep current context, each change needs your confirmation');
    expect(request.otherLabel).toBe('Suggest changes');
    // 计划正文保持 RAW
    expect(request.presentation?.content).toBe('plan body\n');

    settle(ui, { kind: 'cancelled' });
    await pending;
  });

  it('每个选项携带稳定 value ID，且两种 locale 的 value 完全一致', async () => {
    const zh = createReady(createTranslator(createLanguageStore('zh-CN')));
    zh.tool.executor({});
    const zhValues = zh.ui.open.mock.calls[0]![1].questions[0]!.options.map((o) => o.value);
    settle(zh.ui, { kind: 'cancelled' });

    const en = createReady(createTranslator(createLanguageStore('en-US')));
    en.tool.executor({});
    const enValues = en.ui.open.mock.calls[0]![1].questions[0]!.options.map((o) => o.value);
    settle(en.ui, { kind: 'cancelled' });

    // value 是不可翻译的稳定 ID，不能是可翻译 label
    expect(zhValues).toEqual(['planApproval.option.autoClear', 'planApproval.option.autoKeep', 'planApproval.option.buildKeep']);
    expect(enValues).toEqual(zhValues);
  });

  it.each([
    { value: 'planApproval.option.autoClear', mode: 'auto' as const, clearContext: true },
    { value: 'planApproval.option.autoKeep', mode: 'auto' as const, clearContext: false },
    { value: 'planApproval.option.buildKeep', mode: 'build' as const, clearContext: false },
  ])('en-US 下通过 answerValues=$value 映射到 $mode/$clearContext（不依赖 label 文本）', async ({ value, mode, clearContext }) => {
    const translator = createTranslator(createLanguageStore('en-US'));
    const { ui, onApprove, tool } = createReady(translator);
    const pending = tool.executor({});
    // outcome 的 answers 用英文 label，answerValues 用稳定 value——证明映射不靠 label
    settle(ui, {
      kind: 'submitted',
      answers: { [ui.open.mock.calls[0]![1].questions[0]!.question]: 'some english label' },
      answerValues: { [ui.open.mock.calls[0]![1].questions[0]!.question]: value },
    });
    await pending;

    expect(onApprove).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledWith(mode, clearContext);
  });
});
