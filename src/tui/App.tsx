// src/tui/App.tsx
// 顶层布局：flexbox 列，三段式 LogoBox → ScrollBox → Footer
//
// 物理本质：一根垂直 flex 容器，三段（自上而下）：
// - LogoBox flexShrink=0：固定 LOGO 区（ASCII art + version + dir），不随滚动消失，在最顶。
// - ScrollBox flexGrow=1（消息区虚拟滚动）：空时塌缩为 0 行 → Footer 紧贴 LogoBox（charter snug）；
//   有消息时撑开占满中间 → 把 Footer 挤到底。
// - Footer flexShrink=0：上边框 + 输入框 + 下边框 + StatusBar。
//
// charter §顶层布局 L93-96 snug 行为：无消息 Footer 紧贴顶部，有消息被挤到底。
// 不给根 Box height="100%"——加了会破坏 snug（空消息时 flexGrow 把 Footer 推到底）。
//
// 坐标全由 Yoga 自动算（charter 铁律：禁止手动 CUP 定位）。
// ScrollBox 的 visibleRows = rows - LOGO_ROWS - FOOTER_ROWS。
// inputRowY = LOGO_ROWS + scrollboxRenderedRows + 1（LOGO 在顶 + 消息行 + Footer 上边框）。
//
// Props 注入策略：
// - messages / input / cursor / status / logo：由 zustand store（Phase 4）或测试直接注入
// - cols / rows：终端尺寸，生产由 useTerminalSize hook 提供，测试可控注入

import React from 'react';
import { Box } from 'ink';
import { ScrollBox } from './components/ScrollBox.js';
import { LogoBox } from './components/LogoBox.js';
import { Footer } from './components/Footer.js';
import { Overlay } from './components/Overlay.js';
import { useStore } from 'zustand/react';
import type { TuiMessage, StatusBarData, LogoData } from './types.js';
import type { SelectionStore } from './state/selection-store.js';
import type { SpinnerStore } from './state/spinner-store.js';
import type { CompletionStore } from './state/completion-store.js';
import type { OverlayStore } from './state/overlay-store.js';

/** Footer 固定占用的行数：上边框 + 输入 + 下边框 + 状态栏 */
const FOOTER_ROWS = 4;
/** LogoBox 固定占用的行数：3 行 ASCII art */
const LOGO_ROWS = 3;

export interface AppProps {
  messages: TuiMessage[];
  status: StatusBarData;
  logo: LogoData;
  selectionStore: SelectionStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  overlayStore: OverlayStore;
  input: string;
  cursor: number;
  /** 终端列数（边框宽度用）；默认 80（ink-testing-library 默认） */
  cols?: number;
  /** 终端行数（算 ScrollBox visibleRows 用）；默认 24 */
  rows?: number;
  /** ScrollBox scrollTop（受控，由 ConnectedApp 持有） */
  scrollTop: number;
  /** ScrollBox scrollTop 变更回调 */
  onScrollTopChange: (updater: (prev: number) => number) => void;
  /** ScrollBox 是否已主动上滚 */
  scrolledAway: boolean;
}

export function App({ messages, status, logo, selectionStore, input, cursor, spinnerStore, completionStore, overlayStore, scrollTop, onScrollTopChange, scrolledAway, cols = 80, rows = 24 }: AppProps): React.ReactElement {
  const overlayVisible = useStore(overlayStore, (s) => s.visible);
  // 订阅 spinner/completion 是否激活——影响 Footer 占用行数（激活时多 1-2 行）
  const spinnerActive = useStore(spinnerStore, (s) => s.active);
  const completionVisible = useStore(completionStore, (s) => s.visible);

  // 覆盖层激活：替换整个布局
  if (overlayVisible) {
    return <Overlay store={overlayStore} cols={cols} />;
  }

  // Footer 实际占用行数：基础 4（边框/输入/边框/状态栏）+ spinner 1? + completion 1?
  // + 多行输入的额外行数（input 含 \n 时每多一个 \n 多 1 行）
  const inputExtraLines = Math.max(0, input.split('\n').length - 1);
  const footerRows = FOOTER_ROWS + (spinnerActive ? 1 : 0) + (completionVisible ? 1 : 0) + inputExtraLines;
  const visibleRows = Math.max(0, rows - footerRows - LOGO_ROWS);
  // 输入行全局 y：ScrollBox 实际渲染行数 + LOGO_ROWS + spinner? + completion? + 上边框 1 行
  const scrollboxRenderedRows = Math.min(messages.length, visibleRows);
  const inputRowY = scrollboxRenderedRows + LOGO_ROWS + (spinnerActive ? 1 : 0) + (completionVisible ? 1 : 0) + 1;
  return (
    <Box flexDirection="column">
      <LogoBox logo={logo} selectionStore={selectionStore} />
      <ScrollBox messages={messages} visibleRows={visibleRows} selectionStore={selectionStore} scrollTop={scrollTop} onScrollTopChange={onScrollTopChange} scrolledAway={scrolledAway} />
      <Footer input={input} cursor={cursor} status={status} cols={cols} inputRowY={inputRowY} spinnerStore={spinnerStore} completionStore={completionStore} selectionStore={selectionStore} />
    </Box>
  );
}
