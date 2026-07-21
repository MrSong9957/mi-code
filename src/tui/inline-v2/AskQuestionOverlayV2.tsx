import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { displayWidth, foldLine } from '../inline/text-layout.js';
import type { AskQuestionStore } from '../state/ask-question-store.js';

export interface AskQuestionOverlayV2Props {
  store: AskQuestionStore;
  cols: number;
}

interface Row {
  key: string;
  text: string;
}

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

  const width = Math.max(1, cols);
  const questions = state.request.questions;
  const tabs = truncateLine(questions.map((question) => {
    const symbol = isAnswered(question, state.selected, state.others) ? '✓' : '○';
    return `${symbol} ${question.header}`;
  }).concat('Submit').join(' · '), width);
  const question = questions[state.pageIndex];

  if (!question) {
    const unanswered = questions.some((item) => !isAnswered(item, state.selected, state.others));
    return (
      <Box flexDirection="column">
        <Text>{tabs}</Text>
        <Text bold>{truncateLine('Submit', width)}</Text>
        {unanswered && <Text>{truncateLine('Answer all questions before submitting', width)}</Text>}
        <Text dimColor>{truncateLine('Enter submit · Esc cancel', width)}</Text>
      </Box>
    );
  }

  const selected = state.selected[question.question] ?? [];
  const rows: Row[] = [];
  question.options.forEach((option, index) => {
    const focused = state.focusIndex === index ? '> ' : '  ';
    const checked = selected.includes(option.label) ? '[x]' : '[ ]';
    rows.push({ key: `option-${option.label}`, text: truncateLine(`${focused}${checked} ${option.label}`, width) });
    foldLine(option.description, Math.max(1, width - 4)).forEach((line, lineIndex) => {
      rows.push({ key: `description-${option.label}-${lineIndex}`, text: truncateLine(`    ${line}`, width) });
    });
  });

  const otherIndex = question.options.length;
  const otherLabel = state.request.otherLabel ?? 'Other';
  const otherFocused = state.focusIndex === otherIndex ? '> ' : '  ';
  if (state.inputMode) {
    const cursor = Math.min(state.otherCursor, state.otherDraft.length);
    const draft = `${state.otherDraft.slice(0, cursor)}|${state.otherDraft.slice(cursor)}`;
    rows.push({ key: 'other', text: truncateLine(`${otherFocused}${otherLabel}: ${draft}`, width) });
  } else {
    rows.push({ key: 'other', text: truncateLine(`${otherFocused}${otherLabel}`, width) });
  }

  const chatFocused = state.focusIndex === otherIndex + 1 ? '> ' : '  ';
  rows.push({ key: 'chat', text: truncateLine(`${chatFocused}Chat about this`, width) });
  const help = state.inputMode
    ? 'Enter save Other · Esc cancel'
    : '↑↓ navigate · Enter select · Esc cancel';

  return (
    <Box flexDirection="column">
      <Text>{tabs}</Text>
      <Text bold>{truncateLine(question.header, width)}</Text>
      {foldLine(question.question, width).map((line, index) => <Text key={`question-${index}`}>{line}</Text>)}
      {rows.map((row) => <Text key={row.key}>{row.text}</Text>)}
      <Text dimColor>{truncateLine(help, width)}</Text>
    </Box>
  );
});
