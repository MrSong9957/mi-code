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

import React, { useMemo } from 'react';
import { Box } from 'ink';
import { ScrollBox } from './components/ScrollBox.js';
import { LogoBox } from './components/LogoBox.js';
import { Footer } from './components/Footer.js';
import { Overlay } from './components/Overlay.js';
import { DropdownOverlay } from './components/DropdownOverlay.js';
import { cursorScreenPos } from './state/cursor-position.js';
import { computeInputViewport, MAX_VISIBLE_INPUT_LINES } from './state/input-viewport.js';
import { useStore } from 'zustand/react';
import type { TuiMessage, StatusBarData, LogoData } from './types.js';
import type { FlatLine } from './selection/flatten-messages.js';
import type { SelectionStore } from './state/selection-store.js';
import type { SpinnerStore } from './state/spinner-store.js';
import { selectSpinnerView } from './state/spinner-view.js';
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
  /** ScrollBox scrollTop（受控，按行坐标，由 ConnectedApp 持有） */
  scrollTop: number;
  /** 已固化消息展开后的行列表（按行坐标，由 ConnectedApp 持有） */
  flatLines: FlatLine[];
}

export function App({ messages, status, logo, selectionStore, input, cursor, spinnerStore, completionStore, overlayStore, scrollTop, flatLines, cols = 80, rows = 24 }: AppProps): React.ReactElement {
  const overlayVisible = useStore(overlayStore, (s) => s.visible);
  // 订阅 spinner 是否激活——影响 Footer 占用行数
  const spinnerState = useStore(spinnerStore);
  const spinnerView = useMemo(() => selectSpinnerView(spinnerState), [spinnerState]);

  // 覆盖层激活：替换整个布局
  if (overlayVisible) {
    return <Overlay store={overlayStore} cols={cols} />;
  }

  // Footer 实际占用行数：基础 4（border×2 + 1 输入 + status）+ spinner? + 视口固定高度-1
  // 输入框视口固定为 MAX_VISIBLE_INPUT_LINES 行，不再随输入行数增长——历史区大小稳定。
  // 注意：下拉菜单已分离到 DropdownOverlay，不再占用 footer 行数
  const inputViewportExtraLines = MAX_VISIBLE_INPUT_LINES - 1;
  const footerRows = FOOTER_ROWS + spinnerView.rowCount + inputViewportExtraLines;
  const visibleRows = Math.max(0, rows - footerRows - LOGO_ROWS);
  // inputRowY 按行算（flatLines.length 是行数，修根因 2b）
  const scrollboxRenderedRows = Math.min(flatLines.length, visibleRows);
  const inputRowY = scrollboxRenderedRows + LOGO_ROWS + spinnerView.rowCount + 1;
  // 输入框视口：光标居中滚动，超 MAX_VISIBLE_INPUT_LINES 时 viewportTop 跟随光标。
  const totalInputLines = input.split('\n').length;
  const cursorLine = cursorScreenPos(input, cursor, '❯ ').y;
  const vp = computeInputViewport(totalInputLines, cursorLine, MAX_VISIBLE_INPUT_LINES);
  return (
    <Box flexDirection="column">
      <LogoBox logo={logo} selectionStore={selectionStore} />
      <ScrollBox messages={messages} flatLines={flatLines} visibleRows={visibleRows} scrollTop={scrollTop} selectionStore={selectionStore} />
      <DropdownOverlay />
      <Footer input={input} cursor={cursor} status={status} cols={cols} inputRowY={inputRowY} viewportTop={vp.viewportTop} spinnerView={spinnerView} completionStore={completionStore} selectionStore={selectionStore} />
    </Box>
  );
}
