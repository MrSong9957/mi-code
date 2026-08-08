// ExitPlanModeOverlayV2 本地化测试（RED → GREEN）
//
// 验证：计划审批 overlay 的 8 个固定控件文案（标题/intro/prompt/Other 默认/
// Chat/hints/noPlanBody）跟随语言切换，而 Agent 生成的动态内容
// （计划正文 Markdown、option.label、option.description、Agent 提供的 otherLabel）
// 保持 RAW 不变。
//
// 对齐 AskQuestionOverlayV2 的同模式测试 ask-question-overlay-locale.test.tsx。

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ExitPlanModeOverlayV2 } from '../../../tui/inline-v2/ExitPlanModeOverlayV2.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';
import { LocaleProvider } from '../../../locale/context.js';
import { createLanguageStore } from '../../../locale/language-store.js';
import type { LanguageStore } from '../../../locale/types.js';
import type { AskQuestionRequest } from '../../../agent/ask-user-types.js';

// plan-approval request：带 presentation.kind === 'plan-approval'，
// 含三个批准选项（与 exit-plan-mode-routing.test.tsx 同形状）。
const planRequest: AskQuestionRequest = {
  questions: [
    {
      question: 'Claude 已拟定执行方案，是否继续？',
      header: 'Plan',
      options: [
        { label: '确认执行，清空上下文并使用自动模式', description: '重置对话，Agent 自动执行所有修改' },
        { label: '确认执行，使用自动模式', description: '保留当前上下文，Agent 自动执行所有修改' },
        { label: '确认执行，手动审核修改', description: '保留当前上下文，每步修改需你确认' },
      ],
      multiSelect: false,
    },
  ],
  // 不传 otherLabel：触发 fallback，验证 planApproval.otherDefault
  presentation: {
    kind: 'plan-approval',
    content: '# 计划正文 Markdown\n\n这是拟定的执行计划 RAW 内容。',
    filePath: '/tmp/plan.md',
  },
};

function openStore(request: AskQuestionRequest = planRequest): ReturnType<typeof createAskQuestionStore> {
  const store = createAskQuestionStore();
  store.getState().open('plan-1', request, () => {});
  return store;
}

/** 用指定语言 store 包裹 overlay 渲染。 */
function renderWith(store: ReturnType<typeof createAskQuestionStore>, languageStore: LanguageStore, cols = 80) {
  const { lastFrame } = render(
    React.createElement(
      LocaleProvider,
      { store: languageStore },
      React.createElement(ExitPlanModeOverlayV2, { store, cols }),
    ),
  );
  return lastFrame() ?? '';
}

describe('<ExitPlanModeOverlayV2> 本地化', () => {
  it('导航模式：8 个固定文案中文/英文切换，计划正文/option/agent-otherLabel 保持 RAW', () => {
    const zhStore = createLanguageStore('zh-CN');
    const enStore = createLanguageStore('en-US');
    const overlayZh = openStore();
    const overlayEn = openStore();

    const frameZh = renderWith(overlayZh, zhStore);
    const frameEn = renderWith(overlayEn, enStore);

    // ── 动态内容保持 RAW（两种语言下完全一致）──
    // 计划正文 Markdown（Agent 生成，不翻译）。
    // 注:renderMarkdown 会把 '# 标题' 渲染为带样式的标题文本(去掉 '#' 标记),
    // 因此断言渲染后的标题文本 + 段落正文(均 RAW,两种语言下完全一致)。
    expect(frameZh).toContain('计划正文 Markdown');
    expect(frameEn).toContain('计划正文 Markdown');
    expect(frameZh).toContain('这是拟定的执行计划 RAW 内容。');
    expect(frameEn).toContain('这是拟定的执行计划 RAW 内容。');
    // option.label / option.description（Agent 提供）
    expect(frameZh).toContain('确认执行，清空上下文并使用自动模式');
    expect(frameEn).toContain('确认执行，清空上下文并使用自动模式');
    expect(frameZh).toContain('重置对话，Agent 自动执行所有修改');
    expect(frameEn).toContain('重置对话，Agent 自动执行所有修改');

    // ── 中文：8 个固定文案 ──
    expect(frameZh).toContain('准备开始编码？');                                    // title
    expect(frameZh).toContain('以下是 Agent 拟定的计划：');                          // intro
    expect(frameZh).toContain('Agent 已完成计划，是否继续执行？');                    // prompt
    expect(frameZh).toContain('提出修改意见');                                      // otherDefault (fallback)
    expect(frameZh).toContain('与 Agent 讨论此计划');                                // chatAction
    expect(frameZh).toContain('↑↓ 导航 · Enter 选择 · Esc 取消');                    // navigationHint

    // ── 英文：8 个固定文案 ──
    expect(frameEn).toContain('Ready to start coding?');
    expect(frameEn).toContain('Here is the plan proposed by the Agent:');
    expect(frameEn).toContain('The Agent has completed the plan. Continue with execution?');
    expect(frameEn).toContain('Suggest changes');
    expect(frameEn).toContain('Discuss this plan with the Agent');
    expect(frameEn).toContain('↑↓ to navigate · Enter to select · Esc to cancel');

    // ── 关键：英文 frame 不应出现中文固定文案 ──
    expect(frameEn).not.toContain('准备开始编码？');
    expect(frameEn).not.toContain('以下是 Agent 拟定的计划');
    expect(frameEn).not.toContain('Agent 已完成计划');
    expect(frameEn).not.toContain('与 Agent 讨论此计划');
    expect(frameEn).not.toContain('↑↓ 导航');
  });

  it('input 模式：保存提示随语言切换（inputModeHint）', () => {
    const zhStore = createLanguageStore('zh-CN');
    const enStore = createLanguageStore('en-US');
    const overlayZh = openStore();
    overlayZh.setState({ inputMode: true });
    const overlayEn = openStore();
    overlayEn.setState({ inputMode: true });

    const frameZh = renderWith(overlayZh, zhStore);
    const frameEn = renderWith(overlayEn, enStore);

    expect(frameZh).toContain('Enter 保存修改意见 · Esc 取消');
    expect(frameEn).toContain('Enter to save feedback · Esc to cancel');
    // 英文 frame 不应出现中文 hint
    expect(frameEn).not.toContain('Enter 保存修改意见');
  });

  it('无计划正文时：noPlanBody fallback 随语言切换', () => {
    const emptyBodyRequest: AskQuestionRequest = {
      ...planRequest,
      presentation: { kind: 'plan-approval', content: '   ', filePath: '/tmp/plan.md' },
    };
    const zhStore = createLanguageStore('zh-CN');
    const enStore = createLanguageStore('en-US');
    const overlayZh = openStore(emptyBodyRequest);
    const overlayEn = openStore(emptyBodyRequest);

    const frameZh = renderWith(overlayZh, zhStore);
    const frameEn = renderWith(overlayEn, enStore);

    expect(frameZh).toContain('未找到计划正文');
    expect(frameEn).toContain('Plan body not found');
  });

  it('Agent 提供 otherLabel 时使用 otherLabel 而非本地化默认（RAW 保持）', () => {
    const withOtherLabel: AskQuestionRequest = {
      ...planRequest,
      otherLabel: '自定义反馈入口',
    };
    const zhStore = createLanguageStore('zh-CN');
    const enStore = createLanguageStore('en-US');
    const overlayZh = openStore(withOtherLabel);
    const overlayEn = openStore(withOtherLabel);

    const frameZh = renderWith(overlayZh, zhStore);
    const frameEn = renderWith(overlayEn, enStore);

    // Agent 提供的 otherLabel 两种语言下完全一致（不本地化）
    expect(frameZh).toContain('自定义反馈入口');
    expect(frameEn).toContain('自定义反馈入口');
    // 此时不再出现本地化默认 '提出修改意见' / 'Suggest changes'
    expect(frameZh).not.toContain('提出修改意见');
    expect(frameEn).not.toContain('Suggest changes');
  });
});
