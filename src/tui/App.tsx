// src/tui/App.tsx
// 顶层布局：flexbox 列，footer 紧贴（charter §顶层布局结构）
//
// 物理本质：一根垂直 flex 容器。
// - 消息区 flexGrow=1（ScrollBox 虚拟滚动）：空时塌缩为 0 高度 → footer 紧贴顶部；
//   有消息时撑开占满 → footer 被挤到底。
// - footer flexShrink=0：固定高度，永不被压缩。
//
// 坐标全由 Yoga 自动算，应用层不维护行号（charter 铁律：禁止手动 CUP 定位）。
// ScrollBox 的 visibleRows = rows - footerHeight（footer 占 4 行：上边框+输入+下边框+状态栏）。
//
// Props 注入策略：
// - messages / input / cursor / status：由 zustand store（Phase 4）或测试直接注入
// - cols / rows：终端尺寸，生产由 useTerminalSize hook 提供，测试可控注入

import React from 'react';
import { Box } from 'ink';
import { ScrollBox } from './components/ScrollBox.js';
import { Footer } from './components/Footer.js';
import type { TuiMessage, StatusBarData } from './types.js';

/** Footer 固定占用的行数：上边框 + 输入 + 下边框 + 状态栏 */
const FOOTER_ROWS = 4;

export interface AppProps {
  messages: TuiMessage[];
  status: StatusBarData;
  input: string;
  cursor: number;
  /** 终端列数（边框宽度用）；默认 80（ink-testing-library 默认） */
  cols?: number;
  /** 终端行数（算 ScrollBox visibleRows 用）；默认 24 */
  rows?: number;
}

export function App({ messages, status, input, cursor, cols = 80, rows = 24 }: AppProps): React.ReactElement {
  const visibleRows = Math.max(0, rows - FOOTER_ROWS);
  return (
    <Box flexDirection="column">
      <ScrollBox messages={messages} visibleRows={visibleRows} />
      <Footer input={input} cursor={cursor} status={status} cols={cols} />
    </Box>
  );
}
