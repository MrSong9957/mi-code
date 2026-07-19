// src/tui/inline-v2/InlineAppV2.tsx
//
// V2 inline 模式根组件。
//
// 物理本质:走 Ink reconciler + <Static> + 活动区(<Spinner>/<StreamingText>/<Footer>)。
// 与 V0 的 <InlineApp> 区别:返回真正的 React 元素,而非 <></> + 副作用。
//
// Stage 2:只渲染 <Static>(已固化消息) + 占位 footer,无 spinner/streaming。
// Stage 3 加 <Spinner>,Stage 4 加 <StreamingText>。

import React from 'react';
import { Box, Static, Text } from 'ink';
import { MessageLine } from './MessageLine.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectStore } from '../state/select-store.js';
import type { SelectionStore } from '../state/selection-store.js';
import type { OverlayStore } from '../state/overlay-store.js';

export interface InlineAppV2Stores {
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  selectStore: SelectStore;
  selectionStore: SelectionStore;
  overlayStore: OverlayStore;
}

export interface InlineAppV2Props {
  messages: TuiMessage[];
  status: StatusBarData;
  logo: LogoData;
  stores: InlineAppV2Stores;
  cols: number;
  rows: number;
}

export function InlineAppV2({ messages, cols }: InlineAppV2Props): React.ReactElement {
  const finalized = messages.filter((m) => m.finalized);
  return (
    <Box flexDirection="column">
      <Static items={finalized}>
        {(msg) => <MessageLine key={msg.uuid} msg={msg} cols={cols} />}
      </Static>
      {/* Stage 3 加 <SpinnerMemo>,Stage 4 加 <StreamingText> */}
      <Text color="gray">{'─'.repeat(cols)}</Text>
      <Text color="green">{'❯ '}</Text>
    </Box>
  );
}
