// src/tui/inline-v2/FooterV2.tsx
//
// V2 inline 模式的 Footer(独立于 alt-screen 的 <Footer>)。
//
// 物理本质:flex 列:SuggestionBar? + 上边框 + 输入框 + 下边框 + StatusBar。
// 与 alt-screen <Footer> 区别:**不含 spinner**(spinner 是兄弟组件 <SpinnerMemo>)。
//
// 加 memo:所有 props 在 spinner tick 时不变化 → spinner tick 不触发本组件重渲染。
// 父组件 <InlineAppV2> 不订阅 spinnerStore,spinner tick 只在 <SpinnerMemo> 内部爆炸,
// 不会传新 props 到 <FooterV2>,React.memo 拦住 → Ink createIncremental 不重写 footer 行。

import React from 'react';
import { Box, useCursor } from 'ink';
import { StatusBar } from '../components/StatusBar.js';
import { SelectionText } from '../components/SelectionText.js';
import { SuggestionBar } from '../components/SuggestionBar.js';
import { PROMPT, CONTINUATION_INDENT, type InputViewportLayout } from '../state/input-viewport.js';
import type { StatusBarData } from '../types.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore } from '../state/selection-store.js';

export interface FooterV2Props {
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标(用于光标定位 + 选区行号) */
  inputRowY: number;
  /** 物理行布局(必传)。光标定位/行渲染/下边框位置都来自此。 */
  layout: InputViewportLayout;
  completionStore: CompletionStore;
  selectionStore: SelectionStore;
}

export const FooterV2 = React.memo(function FooterV2({
  status,
  cols,
  inputRowY,
  layout,
  completionStore,
  selectionStore,
}: FooterV2Props): React.ReactElement {
  const { setCursorPosition } = useCursor();
  // 光标定位:直接查 layout.cursorVisibleRow/Col(物理行模型)。
  setCursorPosition({ x: layout.cursorVisibleCol, y: inputRowY + layout.cursorVisibleRow });

  const border = '─'.repeat(Math.max(0, cols));
  const lowerBorderRow = inputRowY + layout.visibleRowCount;
  const statusBarRow = lowerBorderRow + 1;

  return (
    <Box flexShrink={0} flexDirection="column">
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
});
