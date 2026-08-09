// ask overlay 控件文案本地化测试（RED → GREEN）
//
// 验证：固定控件文案（Submit/Cancel/hints/Other 默认/Chat）跟随语言切换，
// 而 Agent 提供的动态内容（question 文本、option label、Agent 提供的 otherLabel）
// 保持 RAW 不变。

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { AskQuestionOverlayV2 } from '../../../tui/inline-v2/AskQuestionOverlayV2.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';
import { LocaleProvider } from '../../../locale/context.js';
import { createLanguageStore } from '../../../locale/language-store.js';
import type { LanguageStore } from '../../../locale/types.js';

const request = {
  questions: [
    {
      header: 'Plan Header',
      question: 'What is your name?',
      options: [
        { label: 'AliceOption', description: 'first choice' },
        { label: 'BobOption', description: 'second choice' },
      ],
      multiSelect: false,
    },
  ],
};

function openStore(): ReturnType<typeof createAskQuestionStore> {
  const store = createAskQuestionStore();
  store.getState().open('question-1', request, () => {});
  return store;
}

/** 用指定语言 store 包裹 overlay 渲染。 */
function renderWith(store: ReturnType<typeof createAskQuestionStore>, languageStore: LanguageStore, cols = 80) {
  const { lastFrame } = render(
    React.createElement(
      LocaleProvider,
      { store: languageStore },
      React.createElement(AskQuestionOverlayV2, { store, cols }),
    ),
  );
  return lastFrame() ?? '';
}

describe('<AskQuestionOverlayV2> 本地化', () => {
  it('问题页：控件提示文案中文/英文切换，question 文本与 option label 保持 RAW', () => {
    const zhStore = createLanguageStore('zh-CN');
    const enStore = createLanguageStore('en-US');
    const overlayZh = openStore();
    const overlayEn = openStore();

    const frameZh = renderWith(overlayZh, zhStore);
    const frameEn = renderWith(overlayEn, enStore);

    // 动态内容保持 RAW（两种语言下完全一致）
    expect(frameZh).toContain('What is your name?');
    expect(frameEn).toContain('What is your name?');
    expect(frameZh).toContain('AliceOption');
    expect(frameEn).toContain('AliceOption');
    expect(frameZh).toContain('BobOption');
    expect(frameEn).toContain('BobOption');
    expect(frameZh).toContain('Plan Header');
    expect(frameEn).toContain('Plan Header');

    // Submit tab 是固定控件，随 locale 切换；question/header 仍保持 RAW。
    expect(frameZh).toContain('✓ 提交');
    expect(frameEn).toContain('✓ Submit');

    // 中文：Other 默认、Chat、导航提示
    expect(frameZh).toContain('其他');
    expect(frameZh).toContain('与 Agent 讨论此问题');
    expect(frameZh).toContain('↑↓ 导航 · Enter 选择 · Esc 取消本次访谈');

    // 英文：Other 默认、Chat、导航提示
    expect(frameEn).toContain('Other');
    expect(frameEn).toContain('Discuss this question with the Agent');
    expect(frameEn).toContain('↑↓ to navigate · Enter to select · Esc to cancel');

    // 关键：英文 frame 不应出现中文控件文案
    expect(frameEn).not.toContain('与 Agent 讨论此问题');
    expect(frameEn).not.toContain('↑↓ 导航');
  });

  it('问题页：input 模式下保存提示随语言切换', () => {
    const zhStore = createLanguageStore('zh-CN');
    const enStore = createLanguageStore('en-US');
    const overlayZh = openStore();
    overlayZh.setState({ inputMode: true });
    const overlayEn = openStore();
    overlayEn.setState({ inputMode: true });

    const frameZh = renderWith(overlayZh, zhStore);
    const frameEn = renderWith(overlayEn, enStore);

    expect(frameZh).toContain('Enter 保存 · Esc 取消本次访谈');
    expect(frameEn).toContain('Enter to save · Esc to cancel');
  });

  it('Submit 页：Submit 标题/提交答案/取消/未完成警告/提交提示随语言切换', () => {
    const zhStore = createLanguageStore('zh-CN');
    const enStore = createLanguageStore('en-US');
    const overlayZh = openStore();
    overlayZh.setState({ pageIndex: request.questions.length });
    const overlayEn = openStore();
    overlayEn.setState({ pageIndex: request.questions.length });

    const frameZh = renderWith(overlayZh, zhStore);
    const frameEn = renderWith(overlayEn, enStore);

    // 中文
    expect(frameZh).toContain('提交');
    // 注：截断前缀 '❯ '/'  '，最终中文字串 '提交答案' / '取消' 仍在
    expect(frameZh).toContain('提交答案');
    expect(frameZh).toContain('取消');
    expect(frameZh).toContain('请先完成所有问题再提交');
    expect(frameZh).toContain('Enter 提交 · Esc 取消本次访谈');

    // 英文
    expect(frameEn).toContain('Submit');
    expect(frameEn).toContain('Submit answers');
    expect(frameEn).toContain('Cancel');
    expect(frameEn).toContain('Please answer all questions before submitting');
    expect(frameEn).toContain('Enter to submit · Esc to cancel');
  });

  it('Agent 提供 otherLabel 时，使用 otherLabel 而 非 本地化默认（RAW 保持）', () => {
    const zhStore = createLanguageStore('zh-CN');
    const enStore = createLanguageStore('en-US');
    const overlayZh = openStore();
    overlayZh.setState({ request: { ...request, otherLabel: '提出修改意见' } });
    const overlayEn = openStore();
    overlayEn.setState({ request: { ...request, otherLabel: '提出修改意见' } });

    const frameZh = renderWith(overlayZh, zhStore);
    const frameEn = renderWith(overlayEn, enStore);

    // Agent 提供的 otherLabel 两种语言下完全一致（不本地化）
    expect(frameZh).toContain('提出修改意见');
    expect(frameEn).toContain('提出修改意见');
    // 此时不再出现本地化默认 '其他'/'Other'
    expect(frameZh).not.toContain('其他');
    expect(frameEn).not.toContain('Other');
  });
});
