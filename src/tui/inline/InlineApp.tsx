// src/tui/inline/InlineApp.tsx
// Inline 模式的根组件：将消息追加到 stdout，渲染 InlineFooter。
// 物理本质：替代 App.tsx 的 flex 布局，改用纯 stdout.write 追加模型。

import React, { useEffect, useRef } from 'react';
import { InlineRenderer } from './InlineRenderer.js';
import { InlineFooter } from './InlineFooter.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore } from '../state/selection-store.js';

export interface InlineAppProps {
  messages: TuiMessage[];
  status: StatusBarData;
  logo: LogoData;
  renderer: InlineRenderer;
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  selectionStore: SelectionStore;
}

export function InlineApp({
  messages,
  status: _status,
  logo,
  renderer,
  messagesStore,
  inputStore,
  statusStore,
  spinnerStore,
  completionStore,
}: InlineAppProps): React.ReactElement {
  const renderedCountRef = useRef(0);

  // 追加新消息到 stdout（仅追加，不重绘旧消息）
  useEffect(() => {
    const newMessages = messages.slice(renderedCountRef.current);
    for (const msg of newMessages) {
      const text = msg.lines.map(l => l.content).join('\n');
      if (msg.role === 'user') {
        renderer.appendLine(text);
      } else if (msg.role === 'assistant') {
        if (text) renderer.appendLine(text);
      } else {
        renderer.appendLine(`[system] ${text}`);
      }
    }
    renderedCountRef.current = messages.length;
  }, [messages, renderer]);

  // 渲染 Logo（仅首次）
  useEffect(() => {
    const lines = [
      ` \u2590\u259B\u2588\u2588\u259C\u258F   MiCode v${logo.version}`,
      '\u259D\u259C\u2588\u2588\u2588\u2588\u2588\u259C\u2598  TypeScript CLI \u00B7 Node.js Runtime',
      `  \u2598\u2598 \u259D\u259D    ${logo.dir}`,
    ];
    for (const line of lines) {
      renderer.appendLine(line);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <InlineFooter
      renderer={renderer}
      messagesStore={messagesStore}
      inputStore={inputStore}
      statusStore={statusStore}
      spinnerStore={spinnerStore}
      completionStore={completionStore}
    />
  );
}
