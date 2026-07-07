// src/tui/components/ScrollBox.tsx
// 虚拟滚动容器（受控组件，滚动状态由 ConnectedApp 持有）。
//
// 物理本质：长列表「取景器」。只渲染 [scrollTop, scrollTop+visibleRows) 区间。
// 自动跟随：用户没主动上滚时，messages 增长 → scrollTop 追到 maxScroll。
//
// 鼠标事件（拖拽选区/双击/三击/右键复制/滚轮/自动滚动）由 ConnectedApp 统一路由。
// 本组件只负责按 scrollTop 渲染可见消息行（MessageRow 自带选区高亮）。
// 滚动状态受控：scrollTop 由父级传入，变更经 onScrollTopChange 回调上抛。

import React, { useEffect } from 'react';
import { Box } from 'ink';
import type { TuiMessage } from '../types.js';
import { computeScrollState, sliceVisible } from './scroll-state.js';
import { MessageRow } from './MessageRow.js';
import type { SelectionStore } from '../state/selection-store.js';

/** LOGO 区占的行数（与 App.tsx LOGO_ROWS 一致） */
const LOGO_ROWS = 3;

export interface ScrollBoxProps {
  messages: TuiMessage[];
  visibleRows: number;
  selectionStore: SelectionStore;
  /** 当前 scrollTop（受控，由 ConnectedApp 持有） */
  scrollTop: number;
  /** scrollTop 变更回调（ConnectedApp 更新状态） */
  onScrollTopChange: (updater: (prev: number) => number) => void;
  /** 是否已主动上滚（暂停自动跟随）—— ConnectedApp 的 ref 透传 */
  scrolledAway: boolean;
}

export function ScrollBox({ messages, visibleRows, selectionStore, scrollTop, onScrollTopChange, scrolledAway }: ScrollBoxProps): React.ReactElement {
  const state = computeScrollState({ total: messages.length, visibleRows, scrollTop });
  const visible = sliceVisible(messages, state);

  // 自动跟随：用户没主动上滚时，messages 增长 → scrollTop 追到 maxScroll
  useEffect(() => {
    if (!scrolledAway && scrollTop !== state.maxScroll) {
      onScrollTopChange(() => state.maxScroll);
    }
  }, [messages.length, state.maxScroll]);

  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {visible.map((m, i) => {
        const globalRow = LOGO_ROWS + state.scrollTop + i;
        return (
          <MessageRow
            key={m.uuid}
            message={m}
            globalRow={globalRow}
            selectionStore={selectionStore}
          />
        );
      })}
    </Box>
  );
}
