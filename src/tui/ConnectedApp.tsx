// src/tui/ConnectedApp.tsx
// 连接版 App：从 zustand stores 读数据 + 装配输入处理 + 鼠标选区路由 + 滚动状态。
//
// 物理本质：stores 与 App 组件树的「接线员」+ 全屏鼠标选区 + 滚动状态的「中枢」。
// - 装配键盘处理（useInputHandler，含 PageUp/PageDown）
// - 持有 ScrollBox 滚动状态（scrollTop/scrolledAway，scrolledAway 是 state 触发重渲染）
// - 持有选区 store，注册鼠标 useInput + ?1003h 启用 + 路由事件（全屏，跨所有区域）
// - 构造统一 rowTextMap（屏幕行→文本，按行坐标），供 getSelectedText 提取
//
// 滚动坐标统一为「行」（不再按消息）：flattenMessages 把消息展开成行，
// scroll-state 的 total/visibleRows/scrollTop 都是行数，杜绝多行消息行号撞车。

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { useInput, useStdin } from 'ink';
import { App } from './App.js';
import { useInputHandler } from './input/use-input-handler.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useRenderMode } from './state/render-mode.js';
import { DropdownProvider } from './state/dropdown-context.js';
import { InlineApp } from './inline/InlineApp.js';
import { createSelectionStore } from './state/selection-store.js';
import { createMouseParser } from './input/mouse-events.js';
import { writeClipboard } from './input/clipboard.js';
import { classifyClick, type ClickState } from './selection/click-detector.js';
import { buildRowTextMap, type RowTextMap } from './selection/row-text-map.js';
import { getSelectedText } from './selection/get-selected-text.js';
import { flattenMessages } from './selection/flatten-messages.js';
import { MAX_VISIBLE_INPUT_LINES } from './state/input-viewport.js';
import type { MessagesStore } from './state/messages-store.js';
import type { InputStore } from './state/input-store.js';
import type { StatusStore } from './state/status-store.js';
import type { LogoStore } from './state/logo-store.js';
import type { SpinnerStore } from './state/spinner-store.js';
import type { CompletionStore } from './state/completion-store.js';
import type { OverlayStore } from './state/overlay-store.js';

/** LOGO 区占的行数（与 App.tsx 一致） */
const LOGO_ROWS = 3;
/** Footer 基础行数（边框/输入/边框/状态栏） */
const FOOTER_BASE_ROWS = 4;
/** 拖拽自动滚动间隔（ms） */
const AUTOSCROLL_MS = 80;
/** 滚轮一次滚动的行数 */
const WHEEL_DELTA = 3;
/** inline 模式下 completionStore 订阅的常量短路值（零候选，避免重渲染） */
const EMPTY_CANDIDATES: readonly string[] = Object.freeze([]);

/** SGR 鼠标残片检测：Ink useInput 把 \x1b[<button;col;rowM|m 整段当 escape sequence 交付，前导 \x1b 被剥 */
// eslint-disable-next-line no-control-regex
const SGR_FRAGMENT_RE = /^\[<\d+;\d+;\d+[Mm]/;

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
  /** inline 模式渲染器（alt-screen 模式为 undefined） */
  inlineRenderer?: import('./inline/InlineRenderer.js').InlineRenderer;
}

export function ConnectedApp({
  messagesStore, inputStore, statusStore, logoStore, spinnerStore, completionStore, overlayStore, onExit, onTab, onToggleOverlay, inlineRenderer: _inlineRenderer,
}: ConnectedAppProps): React.ReactElement {
  // 选区 store（拖拽写入，所有区域订阅高亮）
  const selectionStore = useMemo(() => createSelectionStore(), []);
  // ScrollBox 滚动状态（受控持有）。scrolledAway 是 state，变化触发重渲染（修根因 1a/1b）。
  const [scrollTop, setScrollTop] = useState(0);
  const [scrolledAway, setScrolledAway] = useState(false);
  const { rows, cols } = useTerminalSize();

  // 渲染模式检测（须在 completion 订阅之前——后者据 isInline 短路）
  const { mode } = useRenderMode();
  const isInline = mode === 'inline';

  // 订阅所有 store
  const messages = useStore(messagesStore, (s) => s.messages);
  const inputText = useStore(inputStore, (s) => s.text);
  const cursor = useStore(inputStore, (s) => s.cursor);
  const status = useStore(statusStore, useShallow((s) => ({
    mode: s.mode, model: s.model, dir: s.dir, branch: s.branch, contextPct: s.contextPct,
  })));
  const logo = useStore(logoStore, useShallow((s) => ({
    version: s.version, dir: s.dir,
  })));
  const spinnerActive = useStore(spinnerStore, (s) => s.active);
  // completionStore 订阅：inline 模式下用常量短路，避免每次候选变化触发 ConnectedApp 重渲染
  // （inline 模式的下拉渲染在 InlineApp 内部直接读 completionStore，不经此处）。
  // useStore 用 Object.is 比较 selector 输出，常量 false/[] 永远不变 → 零重渲染。
  const completionVisible = useStore(completionStore, (s) => (isInline ? false : s.visible));
  const completionCandidates = useStore(completionStore, (s) => (isInline ? EMPTY_CANDIDATES : s.candidates));

  // ── 以下所有 hooks 必须在 early return 之前（React hooks 规则） ──

  // 把消息展开成行（按行坐标统一）。流式块不展开。
  const flatLines = useMemo(() => flattenMessages(messages), [messages]);
  const flatLineCount = flatLines.length;

  // Footer 行数 + 可见区（按行算）
  // 输入框视口固定为 MAX_VISIBLE_INPUT_LINES 行，不再随输入行数增长——历史区大小稳定。
  const inputViewportExtraLines = MAX_VISIBLE_INPUT_LINES - 1;
  const suggestionRows = completionVisible ? Math.min(completionCandidates.length, 8) : 0;
  const footerRows = FOOTER_BASE_ROWS + (spinnerActive ? 1 : 0) + suggestionRows + inputViewportExtraLines;
  const visibleRows = Math.max(0, rows - footerRows - LOGO_ROWS);
  const maxScroll = Math.max(0, flatLineCount - visibleRows);
  const effectiveScrollTop = scrolledAway ? scrollTop : maxScroll;
  const scrollboxRenderedRows = Math.min(flatLineCount, visibleRows);
  const inputRowY = scrollboxRenderedRows + LOGO_ROWS + (spinnerActive ? 1 : 0) + suggestionRows + 1;

  // 统一行文本映射
  const rowTextMap: RowTextMap = useMemo(() => buildRowTextMap({
    rows, cols,
    logo, messages, scrollTop: effectiveScrollTop, visibleRows,
    input: inputText, inputRowY, status,
    spinnerActive, completionVisible,
  }), [rows, cols, logo, messages, effectiveScrollTop, visibleRows, inputText, inputRowY, status, spinnerActive, completionVisible]);

  // ref 镜像最新值（useInput/useEffect 回调注册一次，避免 stale closure）
  const rowTextMapRef = useRef(rowTextMap);
  rowTextMapRef.current = rowTextMap;
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;
  const flatLineCountRef = useRef(flatLineCount);
  flatLineCountRef.current = flatLineCount;

  // 鼠标状态（跨事件持久）
  const parserRef = useRef(createMouseParser());
  const clickStateRef = useRef<ClickState | null>(null);
  const autoScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 通用滚动 */
  const scrollBy = useCallback((delta: number): void => {
    const total = flatLineCountRef.current;
    const vr = visibleRowsRef.current;
    const ms = Math.max(0, total - vr);
    setScrollTop((prev) => {
      const cur = Math.max(0, Math.min(ms, prev));
      const next = Math.max(0, Math.min(ms, cur + delta));
      setScrolledAway(next < ms);
      return next;
    });
  }, []);

  function handleWheel(ev: { type: string }): void {
    if (selectionStore.getState().isDragging) return;
    scrollBy(ev.type === 'wheelup' ? -WHEEL_DELTA : WHEEL_DELTA);
  }

  function handlePageScroll(direction: 'up' | 'down'): void {
    const vr = visibleRowsRef.current;
    scrollBy(direction === 'up' ? -vr : vr);
  }

  // 键盘处理（必须在 early return 之前，inline 模式也需要）
  useInputHandler(inputStore, onExit, onTab, onToggleOverlay, () => overlayStore.getState().visible, handlePageScroll, completionStore);

  function maybeStartAutoScroll(focusRow: number): void {
    const est = effectiveScrollTop;
    const vr = visibleRows;
    const viewportTopRow = LOGO_ROWS + est;
    const viewportBottomRow = viewportTopRow + vr - 1;
    const outOfTop = focusRow < viewportTopRow;
    const outOfBottom = focusRow > viewportBottomRow;
    if (!outOfTop && !outOfBottom) { stopAutoScroll(); return; }
    if (autoScrollTimerRef.current !== null) return;
    autoScrollTimerRef.current = setInterval(() => {
      setScrollTop((prev) => {
        const total = flatLineCountRef.current;
        const vr2 = visibleRowsRef.current;
        const ms = Math.max(0, total - vr2);
        const cur = Math.max(0, Math.min(ms, prev));
        const dir = outOfTop ? -1 : 1;
        const next = Math.max(0, Math.min(ms, cur + dir));
        if (next === cur) return prev;
        setScrolledAway(next < ms);
        if (outOfTop && next < cur) {
          const rowLeaving = LOGO_ROWS + cur + vr2 - 1;
          const txt = rowTextMapRef.current.getLineContent(rowLeaving);
          if (txt) selectionStore.getState().pushScrolledOff('below', txt);
        } else if (outOfBottom && next > cur) {
          const rowLeaving = LOGO_ROWS + cur;
          const txt = rowTextMapRef.current.getLineContent(rowLeaving);
          if (txt) selectionStore.getState().pushScrolledOff('above', txt);
        }
        return next;
      });
    }, AUTOSCROLL_MS);
  }

  function stopAutoScroll(): void {
    if (autoScrollTimerRef.current !== null) {
      clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }

  function routeMouseEvent(ev: { type: string; button: number; row: number; col: number }): void {
    const row = ev.row - 1;
    const col = ev.col - 1;

    if (ev.type === 'wheelup' || ev.type === 'wheeldown') {
      handleWheel(ev);
      return;
    }

    if (ev.button === 0 || ev.button === 32) {
      if (ev.type === 'mousedown') {
        const click = classifyClick(clickStateRef.current, ev.button, ev.row, ev.col, Date.now());
        clickStateRef.current = click.state;
        const lineContent = rowTextMapRef.current.getLineContent(row);
        if (click.kind === 'double' && lineContent !== null) {
          const hit = selectionStore.getState().selectWordAt(row, col, lineContent);
          if (hit) return;
        } else if (click.kind === 'triple' && lineContent !== null) {
          selectionStore.getState().selectLineAt(row, lineContent);
          return;
        }
        selectionStore.getState().startDrag({ row, col });
      } else if (ev.type === 'mousedrag') {
        selectionStore.getState().dragTo({ row, col });
        maybeStartAutoScroll(row);
      } else if (ev.type === 'mouseup') {
        selectionStore.getState().endDrag();
        stopAutoScroll();
      }
      return;
    }

    if (ev.type === 'mousedown' && ev.button === 2) {
      stopAutoScroll();
      void copyOnRightClick();
      return;
    }
  }

  async function copyOnRightClick(): Promise<void> {
    const sel = selectionStore.getState();
    const text = getSelectedText({ rowTextMap: rowTextMapRef.current, selection: sel });
    selectionStore.getState().clear();
    if (text) {
      try { await writeClipboard(text); } catch { /* 剪贴板失败静默 */ }
    }
  }

  // 鼠标事件处理（仅 alt-screen 模式需要，inline 模式跳过）
  if (!isInline) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useInput((input: string) => {
      if (!SGR_FRAGMENT_RE.test(input)) return;
      const events = parserRef.current.feed('\x1b' + input);
      for (const ev of events) {
        routeMouseEvent(ev);
      }
    });

    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { stdin, setRawMode } = useStdin();
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      if (!stdin) return;
      setRawMode(true);
      process.stdout.write('\x1b[?1003h\x1b[?1006h');
      return () => {
        process.stdout.write('\x1b[?1003l\x1b[?1006l');
        setRawMode(false);
        stopAutoScroll();
      };
    }, [stdin, setRawMode]);
  }

  // ── early return 只影响 JSX 输出，不影响 hooks ──

  if (isInline && _inlineRenderer) {
    return (
      <DropdownProvider>
        <InlineApp
          messages={messages}
          status={status}
          logo={logo}
          renderer={_inlineRenderer}
          messagesStore={messagesStore}
          inputStore={inputStore}
          statusStore={statusStore}
          spinnerStore={spinnerStore}
          completionStore={completionStore}
          selectionStore={selectionStore}
          overlayStore={overlayStore}
        />
      </DropdownProvider>
    );
  }

  return (
    <DropdownProvider>
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
        scrollTop={effectiveScrollTop}
        flatLines={flatLines}
      />
    </DropdownProvider>
  );
}
