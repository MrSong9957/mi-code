// src/tui/components/Footer.tsx
// Footer：flexShrink=0 钉底 + 输入框光标定位（支持字符级选区高亮）。
//
// 物理本质：flexbox 列布局里 flexShrink=0 的固定高度块。
// 结构：Spinner? + SuggestionBar? + 上边框 / ❯ 输入 / 下边框 / 状态栏。
// 选区高亮：边框行、输入行用 SelectionText（自订阅 selectionStore）；状态栏由 StatusBar 处理。
//
// 光标定位（Bug 1 修复）：用 Ink useCursor 把终端光标定位到输入框 `❯ ` 之后 + cursor 偏移处。

import React from 'react';
import { Box, useCursor } from 'ink';
import { StatusBar } from './StatusBar.js';
import { SelectionText } from './SelectionText.js';
import { SpinnerWithVerb } from './Spinner.js';
import { SuggestionBar } from './SuggestionBar.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import { MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import type { StatusBarData } from '../types.js';
import type { SpinnerView } from '../state/spinner-view.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore } from '../state/selection-store.js';

const PROMPT = '❯ ';
/** 续行缩进：与 PROMPT 宽度对齐（❯ 占 1 列 + 空格 1 列 = 2 列）。 */
const CONTINUATION_INDENT = '  ';

export interface FooterProps {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标（用于光标定位 + 选区行号） */
  inputRowY: number;
  /** 输入框视口顶部行号（0-based）。光标/行渲染都相对此偏移。默认 0=无滚动。 */
  viewportTop: number;
  spinnerView: SpinnerView;
  completionStore: CompletionStore;
  /** 选区 store（由 App 注入；SelectionText 自订阅） */
  selectionStore?: SelectionStore;
}

export function Footer({ input, cursor, status, cols, inputRowY, viewportTop, spinnerView, completionStore, selectionStore }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  const pos = cursorScreenPos(input, cursor, PROMPT);
  // 视口化：光标 y 减去 viewportTop 得到视口内行号，保证光标落在可见区。
  setCursorPosition({ x: pos.x, y: inputRowY + (pos.y - viewportTop) });

  const border = '─'.repeat(Math.max(0, cols));
  const allInputLines = input.split('\n');
  // 视口切片：只渲染 [viewportTop, viewportTop + MAX_VISIBLE_INPUT_LINES) 区间。
  const visibleInputLines = allInputLines.slice(
    viewportTop,
    viewportTop + MAX_VISIBLE_INPUT_LINES,
  );
  // 不足时补空行撑高——否则下边框会上移，footer 高度不稳定（破坏历史区布局）。
  while (visibleInputLines.length < MAX_VISIBLE_INPUT_LINES) {
    visibleInputLines.push('');
  }
  const upperBorderRow = inputRowY - 1;
  const lowerBorderRow = inputRowY + MAX_VISIBLE_INPUT_LINES;
  const statusBarRow = lowerBorderRow + 1;

  return (
    <Box flexShrink={0} flexDirection="column">
      <SpinnerWithVerb view={spinnerView} />
      <SuggestionBar store={completionStore} />
      <SelectionText
        content={border}
        globalRow={upperBorderRow}
        selectionStore={selectionStore}
        baseProps={{ color: 'gray' }}
      />
      <Box {...{ internal_cursorTarget: true } as Record<string, unknown>}>
        {visibleInputLines.map((line, i) => {
          // 首行 prompt 仅在视口顶=0（真首行）时显示；滚动后窗口首行用缩进对齐 prompt 宽度。
          const absLine = viewportTop + i;
          const prefix = absLine === 0 ? PROMPT : CONTINUATION_INDENT;
          const isFirstLine = absLine === 0;
          return (
            <SelectionText
              key={i}
              content={`${prefix}${line}`}
              globalRow={inputRowY + i}
              selectionStore={selectionStore}
              baseProps={isFirstLine ? { color: 'green', bold: true } : {}}
            />
          );
        })}
      </Box>
      <SelectionText
        content={border}
        globalRow={lowerBorderRow}
        selectionStore={selectionStore}
        baseProps={{ color: 'gray' }}
      />
      <StatusBar status={status} selectionStore={selectionStore} globalRow={statusBarRow} />
    </Box>
  );
}
