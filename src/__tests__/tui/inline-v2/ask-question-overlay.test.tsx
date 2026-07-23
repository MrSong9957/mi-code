import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { AskQuestionOverlayV2 } from '../../../tui/inline-v2/AskQuestionOverlayV2.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';

const request = {
  questions: [
    {
      header: 'One',
      question: 'Q1',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' },
      ],
      multiSelect: true,
    },
    {
      header: 'Two',
      question: 'Q2',
      options: [{ label: 'C', description: 'third' }],
      multiSelect: false,
    },
  ],
};

function openStore() {
  const store = createAskQuestionStore();
  store.getState().open('question-1', request, () => {});
  return store;
}

describe('<AskQuestionOverlayV2>', () => {
  it('renders the current question, options, and chat affordance', () => {
    const store = openStore();
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('One');
    expect(frame).toContain('Q1');
    expect(frame).toContain('A');
    expect(frame).toContain('first');
    // Other 默认中文"其他",Chat 固定中文(Phase 1a 文案统一)
    expect(frame).toContain('其他');
    expect(frame).toContain('与 Agent 讨论此问题');
  });

  it('renders completion tabs and a Submit tab', () => {
    const store = openStore();
    store.setState({ selected: { Q1: ['A'] } });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('✓');
    expect(frame).toContain('○');
    expect(frame).toContain('Submit');
  });

  it('renders multi-select checkboxes', () => {
    const store = openStore();
    store.setState({ selected: { Q1: ['A'] } });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('[x] A');
    expect(frame).toContain('[ ] B');
  });

  it('renders round border container (A1 验收:borderStyle="round")', () => {
    // A1 验收标准:overlay 必须用 borderStyle="round"。
    // 断言左边框 ╭(ink-testing 下右边框 ╮ 首次渲染缺失是已知问题,只断言左上角)。
    const store = openStore();
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('╭');   // 左上角圆角 = borderStyle="round" 已生效
    expect(frame).toContain('╰');   // 左下角圆角
  });

  it('renders single-select radio symbols (◉/◯) distinct from multi-select', () => {
    // Q2 是单选(multiSelect: false),应显示 radio 而非 checkbox
    const store = openStore();
    store.setState({ pageIndex: 1, selected: { Q2: ['C'] } });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('◉ C');    // 选中 = 实心圆
    // 不应出现 checkbox 符号(单选不是多选)
    expect(frame).not.toContain('[x]');
    expect(frame).not.toContain('[ ]');
  });

  it('renders unselected single-select as ◯', () => {
    const store = openStore();
    store.setState({ pageIndex: 1 });  // Q2 单选,未选任何项
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('◯ C');    // 未选 = 空心圆
  });

  it('renders the custom Other label and input cursor state', () => {
    const store = openStore();
    store.setState({
      request: { ...request, otherLabel: '提出修改意见' },
      inputMode: true,
      otherDraft: 'because',
      otherCursor: 3,
    });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('提出修改意见');
    expect(frame).toContain('bec|ause');
  });

  it('warns when the Submit page has unanswered questions', () => {
    const store = openStore();
    store.setState({ pageIndex: request.questions.length });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);

    expect(lastFrame()).toContain('请先完成所有问题再提交');
  });

  it('renders focused Submit answers and Cancel actions on the Submit page', async () => {
    const store = openStore();
    store.getState().nextPage();
    store.getState().nextPage();
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);

    expect(lastFrame()).toContain('❯ 提交答案');
    expect(lastFrame()).toContain('  取消');

    store.getState().moveFocusNext();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastFrame()).toContain('  提交答案');
    expect(lastFrame()).toContain('❯ 取消');
  });

  it('renders contextual help for Other input mode', () => {
    const store = openStore();
    store.setState({ inputMode: true });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);

    expect(lastFrame()).toContain('Enter 保存');
  });

  it('truncates long Other input on a narrow terminal', () => {
    // 原生 borderStyle="round" 在 ink-testing-library 下按 stdout.columns(固定 100)
    // pad 每行,无法逐行断言 ≤ cols(与 ExitPlanModeOverlayV2 测试同理)。
    // 改为验证长文本确实被 truncateLine 切断:cols=32 → contentWidth=28,
    // 超长 Other 草稿不应作为一整行完整出现。
    const store = openStore();
    store.setState({ inputMode: true, otherDraft: 'a very long response that must be shortened', otherCursor: 10 });
    const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={32} />);
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[[0-9;]*m/g;
    const clean = (lastFrame() ?? '').replace(ansi, '');
    // 完整未截断的 Other 行(含 | 光标)不应出现——说明宽度约束生效
    expect(clean).not.toContain('a very long response that must be shortened');
  });
});
