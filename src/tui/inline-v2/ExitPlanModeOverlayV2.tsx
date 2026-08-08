// src/tui/inline-v2/ExitPlanModeOverlayV2.tsx
//
// 计划审批专用纯展示组件（ExitPlanMode V2）。
//
// 物理本质：在计划审批场景同时展示「计划正文（Markdown）」+「审批操作」，
// 替代通用问卷（AskQuestionOverlayV2）在该场景的视觉。
//
// 关键约束：本组件不处理任何键盘输入。所有 ↑↓/Enter/Esc/字符交互仍由
// useInputHandler 路由到 AskQuestionStore，本组件只读 store 状态并渲染。
// 单题单选 request：questions[0] 是审批题，focusIndex 在
// [0..options.length+1] 间移动（0..2 三个批准选项，3=Other，4=Chat）。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { displayWidth, foldLine } from '../inline/text-layout.js';
import { renderMarkdown } from '../markdown/render-markdown.js';
import { useTheme } from '../state/theme-context.js';
import { useLocale } from '../../locale/context.js';
import type { AskQuestionStore } from '../state/ask-question-store.js';

export interface ExitPlanModeOverlayV2Props {
  store: AskQuestionStore;
  cols: number;
}

/**
 * 把单行文本按显示宽度截断（CJK 感知）。
 * 与 AskQuestionOverlayV2 的同名辅助函数一致，保证每行不超 budget。
 */
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

/**
 * 渲染计划正文 Markdown，带错误边界降级。
 * renderMarkdown 内部调用 marked.lexer 等可能抛错，捕获后降级为纯文本。
 */
function renderPlanBody(content: string): React.ReactNode {
  try {
    return renderMarkdown(content);
  } catch (error) {
    console.error('Failed to render plan markdown:', error);
    return <Text>{content}</Text>;
  }
}

interface LineRow {
  key: string;
  text: string;
  /** 着色（undefined=默认色） */
  color?: string;
}

export const ExitPlanModeOverlayV2 = React.memo(function ExitPlanModeOverlayV2({
  store,
  cols,
}: ExitPlanModeOverlayV2Props): React.ReactElement | null {
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

  // 减去左右边框(各1) + paddingX(各1)。
  // 注:Ink incrementalRendering 首次布局右边框可能缺失(既存缺陷,见
  // docs/known-issues/ink-border-initial-render.md),与本 contentWidth 无关。
  const contentWidth = Math.max(1, cols - 4);

  const presentation = state.request.presentation;
  const question = state.request.questions[0];
  const options = question?.options ?? [];
  const otherIndex = options.length;
  const chatIndex = otherIndex + 1;
  const otherLabel = state.request.otherLabel ?? t('planApproval.otherDefault');

  const hasPlanBody = presentation?.kind === 'plan-approval'
    && presentation.content.trim() !== '';

  const divider = '┄'.repeat(contentWidth);

  // 审批操作行（选项 + 描述 + Other + Chat）
  const rows: LineRow[] = [];

  options.forEach((option, index) => {
    const isFocused = state.focusIndex === index;
    const focused = isFocused ? '❯ ' : '  ';
    rows.push({
      key: `option-${index}`,
      text: truncateLine(`${focused}${option.label}`, contentWidth),
      color: isFocused ? theme.suggestion : undefined,
    });
    foldLine(option.description, Math.max(1, contentWidth - 2)).forEach((line, lineIndex) => {
      rows.push({
        key: `desc-${index}-${lineIndex}`,
        text: truncateLine(`  ${line}`, contentWidth),  // 2空格缩进(对齐 CC paddingLeft={2})
        color: theme.textMuted,
      });
    });
  });

  // Other 行
  if (state.inputMode) {
    const cursor = Math.min(state.otherCursor, state.otherDraft.length);
    const draft = `${state.otherDraft.slice(0, cursor)}|${state.otherDraft.slice(cursor)}`;
    const isOtherFocused = state.focusIndex === otherIndex;
    rows.push({
      key: 'other',
      text: truncateLine(`${isOtherFocused ? '❯ ' : '  '}${otherLabel}：${draft}`, contentWidth),
      color: isOtherFocused ? theme.suggestion : undefined,
    });
  } else {
    const isOtherFocused = state.focusIndex === otherIndex;
    rows.push({
      key: 'other',
      text: truncateLine(`${isOtherFocused ? '❯ ' : '  '}${otherLabel}`, contentWidth),
      color: isOtherFocused ? theme.suggestion : undefined,
    });
  }

  // Chat 行（低强调：非焦点用 textMuted，焦点用 suggestion）
  {
    const isChatFocused = state.focusIndex === chatIndex;
    rows.push({
      key: 'chat',
      text: truncateLine(`${isChatFocused ? '❯ ' : '  '}${t('planApproval.chatAction')}`, contentWidth),
      color: isChatFocused ? theme.suggestion : theme.textMuted,
    });
  }

  const help = state.inputMode
    ? t('planApproval.inputModeHint')
    : t('planApproval.navigationHint');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.planMode} paddingX={1}>
      <Text color={theme.planMode} bold>{truncateLine(t('planApproval.title'), contentWidth)}</Text>
      {foldLine(t('planApproval.intro'), contentWidth).map((line, i) => (
        <Text key={`intro-${i}`}>{line}</Text>
      ))}
      <Text color={theme.borderMuted}>{divider}</Text>
      {hasPlanBody
        ? renderPlanBody(presentation!.content)
        : <Text color={theme.textMuted}>{t('planApproval.noPlanBody')}</Text>}
      <Text color={theme.borderMuted}>{divider}</Text>
      {foldLine(t('planApproval.prompt'), contentWidth).map((line, i) => (
        <Text key={`prompt-${i}`} color={theme.textMuted}>{line}</Text>
      ))}
      {rows.map((row) => row.color
        ? <Text key={row.key} color={row.color}>{row.text}</Text>
        : <Text key={row.key}>{row.text}</Text>)}
      <Text color={theme.textMuted}>{truncateLine(help, contentWidth)}</Text>
    </Box>
  );
});
