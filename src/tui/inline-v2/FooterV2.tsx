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
import { cursorScreenPos } from '../state/cursor-position.js';
import { MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import type { StatusBarData } from '../types.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore } from '../state/selection-store.js';

const PROMPT = '❯ ';
/** 续行缩进:与 PROMPT 宽度对齐(❯ 占 1 列 + 空格 1 列 = 2 列)。 */
const CONTINUATION_INDENT = '  ';

export interface FooterV2Props {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标(用于光标定位 + 选区行号) */
  inputRowY: number;
  /** 输入框视口顶部行号(0-based)。光标/行渲染都相对此偏移。默认 0=无滚动。 */
  viewportTop: number;
  completionStore: CompletionStore;
  selectionStore: SelectionStore;
}

export const FooterV2 = React.memo(function FooterV2({
  input,
  cursor,
  status,
  cols,
  inputRowY,
  viewportTop,
  completionStore,
  selectionStore,
}: FooterV2Props): React.ReactElement {
  const { setCursorPosition } = useCursor();
  const pos = cursorScreenPos(input, cursor, PROMPT);
  // 视口化:光标 y 减去 viewportTop 得到视口内行号,保证光标落在可见区。
  setCursorPosition({ x: pos.x, y: inputRowY + (pos.y - viewportTop) });

  const border = '─'.repeat(Math.max(0, cols));
  const allInputLines = input.split('\n');
  // 视口切片:只渲染 [viewportTop, viewportTop + MAX_VISIBLE_INPUT_LINES) 区间。
  const visibleInputLines = allInputLines.slice(
    viewportTop,
    viewportTop + MAX_VISIBLE_INPUT_LINES,
  );
  // 不足时补空行撑高——否则下边框会上移,footer 高度不稳定(破坏上方已固化消息布局)。
  while (visibleInputLines.length < MAX_VISIBLE_INPUT_LINES) {
    visibleInputLines.push('');
  }
  const lowerBorderRow = inputRowY + MAX_VISIBLE_INPUT_LINES;
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
      <Box {...{ internal_cursorTarget: true } as Record<string, unknown>}>
        {visibleInputLines.map((line, i) => {
          // 首行 prompt 仅在视口顶=0(真首行)时显示;滚动后窗口首行用缩进对齐 prompt 宽度。
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
});
