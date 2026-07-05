// src/tui/App.tsx
// 顶层布局：flexbox 列，footer 紧贴（charter §顶层布局结构）+ 固定 LOGO 区
//
// 物理本质：一根垂直 flex 容器，三段：
// - 消息区 flexGrow=1（ScrollBox 虚拟滚动）：空时塌缩 → LogoBox+Footer 紧贴顶部；
//   有消息时撑开占满 → LogoBox+Footer 被挤到底。
// - LogoBox flexShrink=0：固定 LOGO 区（ASCII art + model/dir/branch/mode），不随滚动消失。
// - Footer flexShrink=0：上边框 + 输入框 + 下边框 + StatusBar(tokens|elapsed)。
//
// 坐标全由 Yoga 自动算（charter 铁律：禁止手动 CUP 定位）。
// ScrollBox 的 visibleRows = rows - LOGO_ROWS - FOOTER_ROWS。
//
// Props 注入策略：
// - messages / input / cursor / status / logo：由 zustand store（Phase 4）或测试直接注入
// - cols / rows：终端尺寸，生产由 useTerminalSize hook 提供，测试可控注入

import React from 'react';
import { Box } from 'ink';
import { ScrollBox } from './components/ScrollBox.js';
import { LogoBox } from './components/LogoBox.js';
import { Footer } from './components/Footer.js';
import type { TuiMessage, StatusBarData, LogoData } from './types.js';

/** Footer 固定占用的行数：上边框 + 输入 + 下边框 + 状态栏 */
const FOOTER_ROWS = 4;
/** LogoBox 固定占用的行数：3 行 ASCII art + 1 行信息 */
const LOGO_ROWS = 4;

export interface AppProps {
  messages: TuiMessage[];
  status: StatusBarData;
  logo: LogoData;
  input: string;
  cursor: number;
  /** 终端列数（边框宽度用）；默认 80（ink-testing-library 默认） */
  cols?: number;
  /** 终端行数（算 ScrollBox visibleRows 用）；默认 24 */
  rows?: number;
}

export function App({ messages, status, logo, input, cursor, cols = 80, rows = 24 }: AppProps): React.ReactElement {
  const visibleRows = Math.max(0, rows - FOOTER_ROWS - LOGO_ROWS);
  return (
    <Box flexDirection="column">
      <ScrollBox messages={messages} visibleRows={visibleRows} />
      <LogoBox logo={logo} />
      <Footer input={input} cursor={cursor} status={status} cols={cols} />
    </Box>
  );
}
