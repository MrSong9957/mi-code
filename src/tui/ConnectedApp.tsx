// src/tui/ConnectedApp.tsx
// 连接版 App：从 zustand stores 读数据 + 装配 useInputHandler/useAltScreen/useTerminalSize
//
// 物理本质：stores 与 App 组件树的「接线员」。
// App.tsx 是纯 props 组件（便于测试），ConnectedApp 把四个 store 的状态注入 props，
// 并挂上输入处理（useInputHandler）、alt screen（useAltScreen）、终端尺寸（useTerminalSize）。
//
// 这是 production 入口（bootstrap 渲染它）；测试直接渲染 App（注入假数据）。

import React, { useMemo } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { App } from './App.js';
import { useInputHandler } from './input/use-input-handler.js';
import { useAltScreen } from './hooks/useAltScreen.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import type { MessagesStore } from './state/messages-store.js';
import type { InputStore } from './state/input-store.js';
import type { StatusStore } from './state/status-store.js';
import type { LogoStore } from './state/logo-store.js';
import type { SpinnerStore } from './state/spinner-store.js';
import type { CompletionStore } from './state/completion-store.js';
import type { OverlayStore } from './state/overlay-store.js';
import { createSelectionStore } from './state/selection-store.js';

export interface ConnectedAppProps {
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  logoStore: LogoStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  overlayStore: OverlayStore;
  onExit: () => void;
  onTab?: (text: string) => void;
  onToggleOverlay?: () => void;
}

export function ConnectedApp({
  messagesStore, inputStore, statusStore, logoStore, spinnerStore, completionStore, overlayStore, onExit, onTab, onToggleOverlay,
}: ConnectedAppProps): React.ReactElement {
  // 选区 store：ScrollBox 鼠标拖拽写入，MessageRow 读 selected 高亮
  const selectionStore = useMemo(() => createSelectionStore(), []);
  // alt screen 生命周期（mount 进，unmount 退）
  useAltScreen();
  // 终端尺寸（响应 resize）
  const { rows, cols } = useTerminalSize();
  // 输入处理（useInput → store）
  useInputHandler(inputStore, onExit, onTab, onToggleOverlay, () => overlayStore.getState().visible);

  // 订阅四个 store
  const messages = useStore(messagesStore, (s) => s.messages);
  const inputText = useStore(inputStore, (s) => s.text);
  const cursor = useStore(inputStore, (s) => s.cursor);
  // 返回对象字面量的 selector 必须用 useShallow 包裹：zustand v5 useStore 走 useSyncExternalStore
  // 的 Object.is 比较，对象每次新引用会触发无限重渲染。useShallow 改为浅比较字段。
  const status = useStore(statusStore, useShallow((s) => ({
    mode: s.mode, model: s.model, dir: s.dir, branch: s.branch, contextPct: s.contextPct,
  })));
  const logo = useStore(logoStore, useShallow((s) => ({
    version: s.version, dir: s.dir,
  })));

  return (
    <App
      messages={messages}
      status={status}
      logo={logo}
      selectionStore={selectionStore}
      spinnerStore={spinnerStore}
      completionStore={completionStore}
      overlayStore={overlayStore}
      input={inputText}
      cursor={cursor}
      rows={rows}
      cols={cols}
    />
  );
}
