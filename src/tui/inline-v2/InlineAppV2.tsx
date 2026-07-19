// src/tui/inline-v2/InlineAppV2.tsx
//
// V2 inline 模式根组件。
//
// 物理本质:走 Ink reconciler + <Static> + 活动区(<SpinnerMemo>/<FooterV2>)。
// 与 V0 的 <InlineApp> 区别:返回真正的 React 元素,而非 <></> + 副作用。
//
// 订阅策略(关键):
// - **不**订阅 spinnerStore 整个 state(否则 spinner tick 会触发本组件重渲染,
//   再下传 props 给 <FooterV2>,破坏 memo 隔离)。
// - 只订阅 spinner 的 rowCount(只在 active/variant/auxiliaryLines 变化时变,
//   tick 不影响 rowCount)→ 本组件重渲染频率与 spinner tick 解耦。
// - <SpinnerMemo> 自己订阅整个 spinnerStore,tick 爆炸范围限制在它内部。
//
// <Static> 已固化消息由 Ink 直接写入 scrollback(永久区),不占活动区 y 坐标。
// 活动区(spinner + footer)从 y=0 开始(spinner 占 rowCount 行 + footer 上边框 1 行
// → inputRowY = spinnerRowCount + 1)。

import React from 'react';
import { Box, Static } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { MessageLine } from './MessageLine.js';
import { SpinnerMemo } from './spinner-memo.js';
import { FooterV2 } from './FooterV2.js';
import { StreamingText } from './StreamingText.js';
import { SelectOverlayV2 } from './SelectOverlayV2.js';
import { selectSpinnerView } from '../state/spinner-view.js';
import { computeInputViewport, MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import { cursorScreenPos } from '../state/cursor-position.js';
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

export function InlineAppV2({ messages, stores, cols }: InlineAppV2Props): React.ReactElement {
  const finalized = messages.filter((m) => m.finalized);

  // 订阅末条未固化消息的 streamingText + role(流式 token 到达触发重渲染——必要)。
  // 找到末条 finalized=false 的消息(流式中草稿)。
  // 用 useShallow 让 selector 输出引用稳定(浅比较相等时返回同一对象),
  // 避免每次都返回新对象触发 React "getSnapshot should be cached" 警告。
  const streaming = useStore(stores.messagesStore, useShallow((s) => {
    const last = s.messages[s.messages.length - 1];
    if (!last || last.finalized) return null;
    return { uuid: last.uuid, streamingText: last.streamingText, role: last.role };
  }));

  // 订阅 input(输入变化触发重渲染,这是必要的)
  const inputText = useStore(stores.inputStore, (s) => s.text);
  const cursor = useStore(stores.inputStore, (s) => s.cursor);

  // 订阅 status(用 useShallow 避免引用抖动)
  const statusData = useStore(stores.statusStore, useShallow((s) => ({
    mode: s.mode, model: s.model, dir: s.dir, branch: s.branch, contextPct: s.contextPct,
  })));

  // 订阅 spinner 的 rowCount(不订阅整个 state——tick 只改 time,不改 rowCount,
  // 故 spinner tick 不会触发本组件重渲染)
  const spinnerRowCount = useStore(stores.spinnerStore, (s) => selectSpinnerView(s).rowCount);

  // 订阅 select 是否可见:visible 时用 SelectOverlay 替代 spinner+footer。
  // 用 boolean selector,只在 visible 翻转时触发本组件重渲染。
  const selectVisible = useStore(stores.selectStore, (s) => s.visible);

  // 输入框视口:光标居中滚动,超出 MAX_VISIBLE_INPUT_LINES 时 viewportTop 跟随。
  const totalInputLines = inputText.split('\n').length;
  const cursorLine = cursorScreenPos(inputText, cursor, '❯ ').y;
  const vp = computeInputViewport(totalInputLines, cursorLine, MAX_VISIBLE_INPUT_LINES);

  // 流式文本占的行数(用于计算 spinner/footer 的 y 偏移)。
  // 物理行数近似:每行按 cols 折算,首行扣除 ● 前缀。粗估即可(精确行数由 Ink yoga 算)。
  // 注:streamingText 末尾不完整的行被 wrapStreamingTextTrimmed 隐藏,这里按完整行估算。
  const streamingRowCount = streaming?.streamingText
    ? Math.max(1, streaming.streamingText.split('\n').length)
    : 0;

  // inputRowY(活动区内坐标,<Static> 不占活动区):
  //   流式文本行数(streamingRowCount) + spinner 行数(spinnerRowCount,0 或 1+) + 上边框 1 行
  const inputRowY = streamingRowCount + spinnerRowCount + 1;

  return (
    <Box flexDirection="column">
      <Static items={finalized}>
        {(msg) => <MessageLine key={msg.uuid} msg={msg} cols={cols} />}
      </Static>
      {streaming && (
        <StreamingText
          text={streaming.streamingText}
          role={streaming.role === 'thinking' ? 'thinking' : 'assistant'}
          cols={cols}
        />
      )}
      {selectVisible ? (
        // Select 选择器:替代 spinner+footer 占据活动区(自订阅 selectStore)
        <SelectOverlayV2 store={stores.selectStore} cols={cols} />
      ) : (
        <>
          <SpinnerMemo store={stores.spinnerStore} />
          <FooterV2
            input={inputText}
            cursor={cursor}
            status={statusData}
            cols={cols}
            inputRowY={inputRowY}
            viewportTop={vp.viewportTop}
            completionStore={stores.completionStore}
            selectionStore={stores.selectionStore}
          />
        </>
      )}
    </Box>
  );
}
