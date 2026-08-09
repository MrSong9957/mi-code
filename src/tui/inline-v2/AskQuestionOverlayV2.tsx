// src/tui/inline-v2/AskQuestionOverlayV2.tsx
// 通用 ask_user_question 问卷渲染(Phase 1a 重构)。
//
// 对齐 ExitPlanModeOverlayV2 的容器模式:圆角边框 + theme.suggestion。
// 本组件不处理任何键盘输入(由 useInputHandler 路由到 AskQuestionStore),
// 只读 store 状态并渲染。
//
// 关键改动(Phase 1a):
// - 圆角边框 + theme.suggestion 色(overlay 语义,非 inline message)
// - 单选 radio(◉/◯),多选 checkbox([x]/[ ]),聚焦符 ❯
// - tabs 用 computeTabLayout 纯函数(权重分配 + CJK 安全截断)
// - Other 默认"其他",Chat 中文"与 Agent 讨论此问题"

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { displayWidth, foldLine } from '../inline/text-layout.js';
import { useTheme } from '../state/theme-context.js';
import { useLocale } from '../../locale/context.js';
import { computeTabLayout } from './ask-question-layout.js';
import type { AskQuestionStore } from '../state/ask-question-store.js';

export interface AskQuestionOverlayV2Props {
  store: AskQuestionStore;
  cols: number;
}

/** 按显示宽度截断单行(CJK 感知)。与 ExitPlanModeOverlayV2 的同名辅助函数一致。 */
function truncateLine(text: string, budget: number): string {
  let result = '';
  let width = 0;
  for (const character of text) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > budget) break;
    result += character;
    width += characterWidth;
  }
  return result;
}

function isAnswered(
  question: { question: string },
  selected: Record<string, string[]>,
  others: Record<string, string>,
): boolean {
  return (selected[question.question]?.length ?? 0) > 0 || Boolean(others[question.question]?.trim());
}

export const AskQuestionOverlayV2 = React.memo(function AskQuestionOverlayV2({
  store,
  cols,
}: AskQuestionOverlayV2Props): React.ReactElement | null {
  const theme = useTheme();
  const { t } = useLocale();
  const state = useStore(store, useShallow((value) => ({
    visible: value.visible,
    request: value.request,
    pageIndex: value.pageIndex,
    focusIndex: value.focusIndex,
    inputMode: value.inputMode,
    otherDraft: value.otherDraft,
    otherCursor: value.otherCursor,
    selected: value.selected,
    others: value.others,
  })));

  if (!state.visible || !state.request) return null;

  // contentWidth = cols - 4(左右边框各1 + paddingX 各1)。
  // 注:Ink border box 首次渲染时右边框可能被 Yoga 布局溢出(既存缺陷,resize 后恢复),
  // 该问题影响所有 Ink border box(非 ask 专属),单独立项处理,不在本组件 hack。
  const contentWidth = Math.max(1, cols - 4);
  const questions = state.request.questions;

  // tabs 用 computeTabLayout(权重分配 + CJK 安全截断)
  const answeredFlags = questions.map((q) => isAnswered(q, state.selected, state.others));
  const tabs = computeTabLayout(questions, {
    pageIndex: state.pageIndex,
    answered: answeredFlags,
    cols,
    submitText: t('overlay.submit'),
  });
  const tabsLine = truncateLine(tabs.map((t) => t.label).join(' '), contentWidth);

  const question = questions[state.pageIndex];

  // ── Submit 页(pageIndex === questions.length)──
  if (!question) {
    const unanswered = questions.some((item, i) => !answeredFlags[i]);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.suggestion} paddingX={1}>
        <Text>{tabsLine}</Text>
        <Text color={theme.suggestion} bold>{truncateLine(t('overlay.submit'), contentWidth)}</Text>
        {unanswered && <Text color={theme.warning}>{truncateLine(t('overlay.unansweredWarning'), contentWidth)}</Text>}
        <Text color={state.focusIndex === 0 ? theme.suggestion : undefined}>{truncateLine(`${state.focusIndex === 0 ? '❯ ' : '  '}${t('overlay.submitAnswers')}`, contentWidth)}</Text>
        <Text color={state.focusIndex === 1 ? theme.suggestion : undefined}>{truncateLine(`${state.focusIndex === 1 ? '❯ ' : '  '}${t('overlay.cancel')}`, contentWidth)}</Text>
        <Text color={theme.textMuted}>{truncateLine(t('overlay.submitHint'), contentWidth)}</Text>
      </Box>
    );
  }

  const selected = state.selected[question.question] ?? [];
  const divider = '┄'.repeat(contentWidth);

  // ── 选项行 ──
  const optionRows: React.ReactNode[] = [];
  question.options.forEach((option, index) => {
    const isFocused = state.focusIndex === index;
    const focused = isFocused ? '❯ ' : '  ';
    // 单选 radio,多选 checkbox(视觉区分:用户一眼判断能选几个)
    const checkSymbol = question.multiSelect
      ? (selected.includes(option.label) ? '[x]' : '[ ]')
      : (selected.includes(option.label) ? '◉' : '◯');
    optionRows.push(
      <Text key={`option-${option.label}`} color={isFocused ? theme.suggestion : undefined}>
        {truncateLine(`${focused}${checkSymbol} ${option.label}`, contentWidth)}
      </Text>
    );
    foldLine(option.description, Math.max(1, contentWidth - 2)).forEach((line, lineIndex) => {
      optionRows.push(
        <Text key={`desc-${option.label}-${lineIndex}`} color={theme.textMuted}>
          {truncateLine(`  ${line}`, contentWidth)}
        </Text>
      );
    });
  });

  // ── Other 行 ──
  const otherIndex = question.options.length;
  const otherLabel = state.request.otherLabel ?? t('overlay.otherDefault');
  const otherFocused = state.focusIndex === otherIndex;
  if (state.inputMode) {
    const cursor = Math.min(state.otherCursor, state.otherDraft.length);
    const draft = `${state.otherDraft.slice(0, cursor)}|${state.otherDraft.slice(cursor)}`;
    optionRows.push(
      <Text key="other" color={otherFocused ? theme.suggestion : undefined}>
        {truncateLine(`${otherFocused ? '❯ ' : '  '}${otherLabel}: ${draft}`, contentWidth)}
      </Text>
    );
  } else {
    optionRows.push(
      <Text key="other" color={otherFocused ? theme.suggestion : undefined}>
        {truncateLine(`${otherFocused ? '❯ ' : '  '}${otherLabel}`, contentWidth)}
      </Text>
    );
  }

  // ── Chat 行(系统行为入口)──
  const chatFocused = state.focusIndex === otherIndex + 1;
  optionRows.push(
    <Text key="chat" color={chatFocused ? theme.suggestion : theme.textMuted}>
      {truncateLine(`${chatFocused ? '❯ ' : '  '}${t('overlay.chatAction')}`, contentWidth)}
    </Text>
  );

  const help = state.inputMode
    ? t('overlay.inputModeHint')
    : t('overlay.navigationHint');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.suggestion} paddingX={1}>
      <Text>{tabsLine}</Text>
      <Text color={theme.suggestion} bold>{truncateLine(question.header, contentWidth)}</Text>
      {foldLine(question.question, contentWidth).map((line, index) => (
        <Text key={`question-${index}`}>{line}</Text>
      ))}
      <Text color={theme.borderMuted}>{divider}</Text>
      {optionRows}
      <Text color={theme.textMuted}>{truncateLine(help, contentWidth)}</Text>
    </Box>
  );
});
