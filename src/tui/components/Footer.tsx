// src/tui/components/Footer.tsx
// Footer：flexShrink=0 钉底 + 输入框光标定位（支持字符级选区高亮）。
//
// 物理本质：flexbox 列布局里 flexShrink=0 的固定高度块。
// 结构：Spinner? + SuggestionBar? + 上边框 / ❯ 输入 / 下边框 / 状态栏。
// 选区高亮：边框行、输入行、状态栏都订阅 selectionStore，复用 SelectionText 蓝底黑字。
//
// 光标定位（Bug 1 修复）：用 Ink useCursor 把终端光标定位到输入框 `❯ ` 之后 + cursor 偏移处。
// y 坐标由 App 算好传入（输入行的全局 y）。

import React from 'react';
import { Box, Text, useCursor } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { StatusBar } from './StatusBar.js';
import { SelectionText } from './SelectionText.js';
import { Spinner } from './Spinner.js';
import { SuggestionBar } from './SuggestionBar.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import type { StatusBarData } from '../types.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore, Point } from '../state/selection-store.js';

const PROMPT = '❯ '; // 第 0 行 prompt（影响 x 偏移）

/** 占位 store（selectionStore 缺省时） */
const _noopStore = createStore<{ anchor: Point | null; focus: Point | null }>(() => ({
  anchor: null, focus: null,
}));

export interface FooterProps {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标（用于光标定位 + 选区行号） */
  inputRowY: number;
  /** spinner store */
  spinnerStore: SpinnerStore;
  /** 补全候选 store */
  completionStore: CompletionStore;
  /** 选区 store（由 App 注入，支持选区高亮） */
  selectionStore?: SelectionStore;
}

export function Footer({ input, cursor, status, cols, inputRowY, spinnerStore, completionStore, selectionStore }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  // 光标定位（Bug 1 修复）：用 stringWidth 算显示宽度，CJK 不再被一分为二。
  // 多行时 y 还要加上光标所在行偏移。
  const pos = cursorScreenPos(input, cursor, PROMPT);
  setCursorPosition({ x: pos.x, y: inputRowY + pos.y });

  // 订阅选区
  const sel = useStore(
    selectionStore ?? _noopStore,
    useShallow((s: { anchor: Point | null; focus: Point | null }) => ({ anchor: s.anchor, focus: s.focus })),
  );

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
        anchor={sel.anchor}
        focus={sel.focus}
        baseProps={{ color: 'gray' }}
      />
      <Box {...{ internal_cursorTarget: true } as Record<string, unknown>}>
        {inputSplit.map((line, i) => (
          <SelectionText
            key={i}
            content={i === 0 ? `${PROMPT}${line}` : line}
            globalRow={inputRowY + i}
            anchor={sel.anchor}
            focus={sel.focus}
            baseProps={i === 0 ? { color: 'green', bold: true } : {}}
          />
        ))}
      </Box>
      <SelectionText
        content={border}
        globalRow={lowerBorderRow}
        anchor={sel.anchor}
        focus={sel.focus}
        baseProps={{ color: 'gray' }}
      />
      <StatusBar status={status} selectionStore={selectionStore} globalRow={statusBarRow} />
    </Box>
  );
}
