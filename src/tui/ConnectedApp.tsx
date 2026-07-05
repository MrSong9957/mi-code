// src/tui/ConnectedApp.tsx
// 连接版 App：从 zustand stores 读数据 + 装配 useInputHandler/useAltScreen/useTerminalSize
//
// 物理本质：stores 与 App 组件树的「接线员」。
// App.tsx 是纯 props 组件（便于测试），ConnectedApp 把四个 store 的状态注入 props，
// 并挂上输入处理（useInputHandler）、alt screen（useAltScreen）、终端尺寸（useTerminalSize）。
//
// 这是 production 入口（bootstrap 渲染它）；测试直接渲染 App（注入假数据）。

import React from 'react';
import { useStore } from 'zustand/react';
import { App } from './App.js';
import { useInputHandler } from './input/use-input-handler.js';
import { useAltScreen } from './hooks/useAltScreen.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import type { MessagesStore } from './state/messages-store.js';
import type { InputStore } from './state/input-store.js';
import type { StatusStore } from './state/status-store.js';
import type { LogoStore } from './state/logo-store.js';

export interface ConnectedAppProps {
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  logoStore: LogoStore;
  onExit: () => void;
}

export function ConnectedApp({
  messagesStore, inputStore, statusStore, logoStore, onExit,
}: ConnectedAppProps): React.ReactElement {
  // alt screen 生命周期（mount 进，unmount 退）
  useAltScreen();
  // 终端尺寸（响应 resize）
  const { rows, cols } = useTerminalSize();
  // 输入处理（useInput → store）
  useInputHandler(inputStore, onExit);

  // 订阅四个 store
  const messages = useStore(messagesStore, (s) => s.messages);
  const inputText = useStore(inputStore, (s) => s.text);
  const cursor = useStore(inputStore, (s) => s.cursor);
  const status = useStore(statusStore, (s) => ({
    tokenCount: s.tokenCount, elapsedSec: s.elapsedSec,
  }));
  const logo = useStore(logoStore, (s) => ({
    version: s.version, dir: s.dir, model: s.model, branch: s.branch, mode: s.mode,
  }));

  return (
    <App
      messages={messages}
      status={status}
      logo={logo}
      input={inputText}
      cursor={cursor}
      rows={rows}
      cols={cols}
    />
  );
}
