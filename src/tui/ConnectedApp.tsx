// src/tui/ConnectedApp.tsx
// 连接版 App：从 zustand stores 读数据 + 装配输入处理 + 鼠标选区路由。
//
// 物理本质：stores 与 App 组件树的「接线员」+ 全屏鼠标选区的「中枢」。
// - 装配键盘处理（useInputHandler）
// - 持有 ScrollBox 滚动状态（scrollTop/scrolledAway）受控传给 App
// - 持有选区 store，注册鼠标 useInput + ?1003h 启用 + 路由事件（全屏，跨所有区域）
// - 构造统一 rowTextMap（屏幕行→文本），供 getSelectedText 提取

import React, { useMemo, useRef, useState, useEffect } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { useInput, useStdin } from 'ink';
import { App } from './App.js';
import { useInputHandler } from './input/use-input-handler.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { createSelectionStore } from './state/selection-store.js';
import { createMouseParser } from './input/mouse-events.js';
import { writeClipboard } from './input/clipboard.js';
import { classifyClick, type ClickState } from './selection/click-detector.js';
import { buildRowTextMap, type RowTextMap } from './selection/row-text-map.js';
import { getSelectedText } from './selection/get-selected-text.js';
import { computeScrollState } from './components/scroll-state.js';
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
}

export function ConnectedApp({
  messagesStore, inputStore, statusStore, logoStore, spinnerStore, completionStore, overlayStore, onExit, onTab, onToggleOverlay,
}: ConnectedAppProps): React.ReactElement {
  // 选区 store（拖拽写入，所有区域订阅高亮）
  const selectionStore = useMemo(() => createSelectionStore(), []);
  // ScrollBox 滚动状态（受控持有，供 rowTextMap + 鼠标路由用）
  const [scrollTop, setScrollTop] = useState(0);
  const scrolledAwayRef = useRef(false);
  const { rows, cols } = useTerminalSize();
  // 键盘处理
  useInputHandler(inputStore, onExit, onTab, onToggleOverlay, () => overlayStore.getState().visible);

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
  const completionVisible = useStore(completionStore, (s) => s.visible);

  // Footer 行数 + 可见区 + inputRowY（与 App.tsx 同算法，用于 rowTextMap）
  const inputExtraLines = Math.max(0, inputText.split('\n').length - 1);
  const footerRows = FOOTER_BASE_ROWS + (spinnerActive ? 1 : 0) + (completionVisible ? 1 : 0) + inputExtraLines;
  const visibleRows = Math.max(0, rows - footerRows - LOGO_ROWS);
  const effectiveScrollTop = scrolledAwayRef.current ? scrollTop : Math.max(0, messages.length - visibleRows);
  const scrollboxRenderedRows = Math.min(messages.length, visibleRows);
  const inputRowY = scrollboxRenderedRows + LOGO_ROWS + (spinnerActive ? 1 : 0) + (completionVisible ? 1 : 0) + 1;

  // 统一行文本映射（每次 render 重建，参数都是订阅到的最新值）
  const rowTextMap: RowTextMap = useMemo(() => buildRowTextMap({
    rows, cols,
    logo, messages, scrollTop: effectiveScrollTop, visibleRows,
    input: inputText, inputRowY, status,
    spinnerActive, completionVisible,
  }), [rows, cols, logo, messages, effectiveScrollTop, visibleRows, inputText, inputRowY, status, spinnerActive, completionVisible]);

  // 鼠标状态（跨事件持久，useInput 回调注册一次）
  const parserRef = useRef(createMouseParser());
  const clickStateRef = useRef<ClickState | null>(null);
  const autoScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ref 镜像最新值（避免 useInput 回调 stale closure）
  const rowTextMapRef = useRef(rowTextMap);
  rowTextMapRef.current = rowTextMap;
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;
  const messagesLenRef = useRef(messages.length);
  messagesLenRef.current = messages.length;
  const effectiveScrollTopRef = useRef(effectiveScrollTop);
  effectiveScrollTopRef.current = effectiveScrollTop;

  // 滚轮：调 scrollTop（拖拽中禁用）
  function handleWheel(ev: { type: string }): void {
    if (selectionStore.getState().isDragging) return;
    setScrollTop((prev) => {
      const cur = computeScrollState({ total: messagesLenRef.current, visibleRows: visibleRowsRef.current, scrollTop: prev });
      const delta = 3;
      const next = ev.type === 'wheelup' ? prev - delta : prev + delta;
      const clamped = Math.max(0, Math.min(cur.maxScroll, next));
      if (clamped < cur.maxScroll) scrolledAwayRef.current = true;
      else scrolledAwayRef.current = false;
      return clamped;
    });
  }

  // 拖拽自动滚动（focus 超出消息视口时）
  function maybeStartAutoScroll(focusRow: number): void {
    const est = effectiveScrollTopRef.current;
    const vr = visibleRowsRef.current;
    const viewportTopRow = LOGO_ROWS + est;
    const viewportBottomRow = viewportTopRow + vr - 1;
    const outOfTop = focusRow < viewportTopRow;
    const outOfBottom = focusRow > viewportBottomRow;
    if (!outOfTop && !outOfBottom) { stopAutoScroll(); return; }
    if (autoScrollTimerRef.current !== null) return;
    autoScrollTimerRef.current = setInterval(() => {
      setScrollTop((prev) => {
        const cur = computeScrollState({ total: messagesLenRef.current, visibleRows: visibleRowsRef.current, scrollTop: prev });
        const dir = outOfTop ? -1 : 1;
        const next = Math.max(0, Math.min(cur.maxScroll, prev + dir));
        if (next === prev) return prev;
        // 滚出视口的行文本入缓存
        if (outOfTop && next < prev) {
          const rowLeaving = LOGO_ROWS + prev + visibleRowsRef.current - 1;
          const txt = rowTextMapRef.current.getLineContent(rowLeaving);
          if (txt) selectionStore.getState().pushScrolledOff('below', txt);
        } else if (outOfBottom && next > prev) {
          const rowLeaving = LOGO_ROWS + prev;
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

  // 路由单个解析后的鼠标事件
  function routeMouseEvent(ev: { type: string; button: number; row: number; col: number }): void {
    const row = ev.row - 1; // SGR 1-origin → 0-based
    const col = ev.col - 1;

    if (ev.type === 'wheelup' || ev.type === 'wheeldown') {
      handleWheel(ev);
      return;
    }

    // 左键（button 0/32-motion）
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

    // 右键（button 2）：复制 + 清高亮
    if (ev.type === 'mousedown' && ev.button === 2) {
      stopAutoScroll();
      void copyOnRightClick();
      return;
    }
  }

  async function copyOnRightClick(): Promise<void> {
    const sel = selectionStore.getState();
    const text = getSelectedText({ rowTextMap: rowTextMapRef.current, selection: sel });
    // 先提取（读选区）再 clear（清选区），最后写剪贴板。clear 不依赖剪贴板成功。
    selectionStore.getState().clear();
    if (text) {
      try { await writeClipboard(text); } catch { /* 剪贴板失败静默 */ }
    }
  }

  // 鼠标事件：经 Ink useInput 通道（SGR 残片识别 + 重建 + 解析 + 路由）
  useInput((input: string) => {
    if (!SGR_FRAGMENT_RE.test(input)) return;
    const events = parserRef.current.feed('\x1b' + input);
    for (const ev of events) {
      routeMouseEvent(ev);
    }
  });

  // 开启鼠标追踪 ?1003h（全追踪）+ ?1006h（SGR 编码）
  const { stdin, setRawMode } = useStdin();
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
      scrollTop={effectiveScrollTop}
      onScrollTopChange={(updater) => setScrollTop(updater)}
      scrolledAway={scrolledAwayRef.current}
    />
  );
}
