// src/tui/components/Footer.tsx
// Footer：flexShrink=0 钉底 + 输入框光标定位（支持字符级选区高亮）。
//
// 物理本质：flexbox 列布局里 flexShrink=0 的固定高度块。
// 结构：Spinner? + SuggestionBar? + 上边框 / ❯ 输入 / 下边框 / 状态栏。
// 选区高亮：边框行、输入行用 SelectionText（自订阅 selectionStore）；状态栏由 StatusBar 处理。
//
// 光标定位（Bug 1 修复）：用 Ink useCursor 把终端光标定位到输入框 `❯ ` 之后 + cursor 偏移处。

import React from 'react';
import { Box, Text, useCursor } from 'ink';
import { StatusBar } from './StatusBar.js';
import { SelectionText } from './SelectionText.js';
import { Spinner } from './Spinner.js';
import { SuggestionBar } from './SuggestionBar.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import type { StatusBarData } from '../types.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore } from '../state/selection-store.js';

const PROMPT = '❯ ';

export interface FooterProps {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标（用于光标定位 + 选区行号） */
  inputRowY: number;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  /** 选区 store（由 App 注入；SelectionText 自订阅） */
  selectionStore?: SelectionStore;
}

export function Footer({ input, cursor, status, cols, inputRowY, spinnerStore, completionStore, selectionStore }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  const pos = cursorScreenPos(input, cursor, PROMPT);
  setCursorPosition({ x: pos.x, y: inputRowY + pos.y });

  const border = '─'.repeat(Math.max(0, cols));
  const inputSplit = input.split('\n');
  const inputLineCount = inputSplit.length;
  const upperBorderRow = inputRowY - 1;
  const lowerBorderRow = inputRowY + inputLineCount;
  const statusBarRow = lowerBorderRow + 1;

  return (
    <Box flexShrink={0} flexDirection="column">
      <Spinner store={spinnerStore} />
      <SuggestionBar store={completionStore} />
      <SelectionText
        content={border}
        globalRow={upperBorderRow}
        selectionStore={selectionStore}
        baseProps={{ color: 'gray' }}
      />
      <Box {...{ internal_cursorTarget: true } as Record<string, unknown>}>
        {inputSplit.map((line, i) => (
          <SelectionText
            key={i}
            content={i === 0 ? `${PROMPT}${line}` : line}
            globalRow={inputRowY + i}
            selectionStore={selectionStore}
            baseProps={i === 0 ? { color: 'green', bold: true } : {}}
          />
        ))}
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
