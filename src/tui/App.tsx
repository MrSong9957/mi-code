// src/tui/App.tsx
// 顶层布局：flexbox 列，footer 紧贴（charter §顶层布局结构）
//
// 物理本质：一根垂直 flex 容器。
// - 消息区 flexGrow=1：空时塌缩为 0 高度 → footer 紧贴顶部；
//   有消息时撑开占满 → footer 被挤到底。
// - footer flexShrink=0：固定高度，永不被压缩。
//
// 坐标全由 Yoga 自动算，应用层不维护行号（charter 铁律：禁止手动 CUP 定位）。
//
// Props 注入策略：
// - messages / input / cursor / status：由 zustand store（Phase 4）或测试直接注入
// - cols：终端宽度，生产由 useTerminalSize hook 提供，测试可控注入

import React from 'react';
import { Box } from 'ink';
import { MessageRow } from './components/MessageRow.js';
import { Footer } from './components/Footer.js';
import type { TuiMessage, StatusBarData } from './types.js';

export interface AppProps {
  messages: TuiMessage[];
  status: StatusBarData;
  input: string;
  cursor: number;
  /** 终端列数（边框宽度用）；默认 80（ink-testing-library 默认） */
  cols?: number;
}

export function App({ messages, status, input, cursor, cols = 80 }: AppProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box flexGrow={1} flexDirection="column">
        {messages.map(m => (
          <MessageRow key={m.uuid} message={m} />
        ))}
      </Box>
      <Footer input={input} cursor={cursor} status={status} cols={cols} />
    </Box>
  );
}
