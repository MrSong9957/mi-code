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
import { type InputViewportLayout } from '../state/input-viewport.js';
import type { StatusBarData } from '../types.js';
import type { SpinnerView } from '../state/spinner-view.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore } from '../state/selection-store.js';

const PROMPT = '❯ ';
/** 续行缩进：与 PROMPT 宽度对齐（❯ 占 1 列 + 空格 1 列 = 2 列）。 */
const CONTINUATION_INDENT = '  ';

export interface FooterProps {
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标（用于光标定位 + 选区行号） */
  inputRowY: number;
  /** 物理行布局（必传，Step 11 起）。光标定位/行渲染/下边框位置都来自此。 */
  layout: InputViewportLayout;
  spinnerView: SpinnerView;
  completionStore: CompletionStore;
  /** 选区 store（由 App 注入；SelectionText 自订阅） */
  selectionStore?: SelectionStore;
}

export function Footer({ status, cols, inputRowY, layout, spinnerView, completionStore, selectionStore }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  const border = '─'.repeat(Math.max(0, cols));

  // 光标定位：直接查 layout.cursorVisibleRow/Col（物理行模型）。
  setCursorPosition({ x: layout.cursorVisibleCol, y: inputRowY + layout.cursorVisibleRow });
  const lowerBorderRow = inputRowY + layout.visibleRowCount;
  const statusBarRow = lowerBorderRow + 1;

  return (
    <Box flexShrink={0} flexDirection="column">
      <SpinnerWithVerb view={spinnerView} />
      <SuggestionBar store={completionStore} />
      <SelectionText
        content={border}
        globalRow={inputRowY - 1}
        selectionStore={selectionStore}
        baseProps={{ color: 'gray' }}
      />
      <Box flexDirection="column" {...{ internal_cursorTarget: true } as Record<string, unknown>}>
        {layout.visibleRows.map((row, i) => {
          const prefix = row.prefixKind === 'prompt' ? PROMPT : CONTINUATION_INDENT;
          const isFirstLogical = row.breakKind === 'none';
          return (
            <SelectionText
              key={i}
              content={`${prefix}${row.text}`}
              globalRow={inputRowY + i}
              selectionStore={selectionStore}
              baseProps={isFirstLogical ? { color: 'green', bold: true } : {}}
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
