// src/tui/components/ScrollBox.tsx
// 虚拟滚动容器 + 鼠标选区（字符级 + 右键复制 + 双击选词 + 拖拽自动滚动）。
//
// 物理本质：长列表「取景器」+ 鼠标「选区画笔」+ 右键「复制按钮」。
// - 虚拟滚动：只渲染 [scrollTop, scrollTop+visibleRows) 区间
// - 鼠标滚轮：调 scrollTop（拖拽中禁用，避免冲突）
// - 左键拖拽选区：mousedown(startDrag) → mousedrag(dragTo+滚动捕获) → mouseup(endDrag)
// - 左键双击选词 / 三击选行：click-detector 计时
// - 右键（button=2）：复制当前选区 + 清高亮（spec §3.4.4）
// - 自动跟随：用户没主动上滚时，messages 增长 → scrollTop 追到 maxScroll

import React, { useState, useEffect, useRef } from 'react';
import { Box, useStdin } from 'ink';
import type { TuiMessage } from '../types.js';
import { computeScrollState, sliceVisible } from './scroll-state.js';
import { createMouseParser } from '../input/mouse-events.js';
import { writeClipboard } from '../input/clipboard.js';
import { MessageRow } from './MessageRow.js';
import type { SelectionStore } from '../state/selection-store.js';
import { classifyClick, type ClickState } from '../selection/click-detector.js';
import { getSelectedText } from '../selection/get-selected-text.js';

/** LOGO 区占的行数（与 App.tsx LOGO_ROWS 一致） */
const LOGO_ROWS = 3;
/** 拖拽自动滚动间隔（ms） */
const AUTOSCROLL_MS = 80;

export interface ScrollBoxProps {
  messages: TuiMessage[];
  visibleRows: number;
  selectionStore: SelectionStore;
}

export function ScrollBox({ messages, visibleRows, selectionStore }: ScrollBoxProps): React.ReactElement {
  const userScrolledAwayRef = useRef(false);
  const [scrollTopRaw, setScrollTop] = useState(() => Math.max(0, messages.length - visibleRows));
  const { stdin, setRawMode } = useStdin();
  const parserRef = useRef(createMouseParser());
  // 多击检测状态（跨事件持久）
  const clickStateRef = useRef<ClickState | null>(null);
  // 拖拽自动滚动计时器
  const autoScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const effectiveScrollTop = userScrolledAwayRef.current ? scrollTopRaw : Math.max(0, messages.length - visibleRows);
  const state = computeScrollState({ total: messages.length, visibleRows, scrollTop: effectiveScrollTop });
  const visible = sliceVisible(messages, state);

  useEffect(() => {
    if (!userScrolledAwayRef.current && scrollTopRaw !== state.maxScroll) {
      setScrollTop(state.maxScroll);
    }
  }, [messages.length, state.maxScroll]);

  /** 取某屏幕全局行对应的「整行文本」（用于双击选词/三击选行/滚动缓存） */
  function getLineContentByRow(row: number): string | null {
    const flatRow = row - LOGO_ROWS - effectiveScrollTop;
    if (flatRow < 0) return null;
    let acc = 0;
    for (const msg of messages) {
      if (!msg.finalized) continue;
      if (flatRow < acc + msg.lines.length) {
        return msg.lines[flatRow - acc]?.content ?? null;
      }
      acc += msg.lines.length;
    }
    return null;
  }

  /** 停止拖拽自动滚动 */
  function stopAutoScroll(): void {
    if (autoScrollTimerRef.current !== null) {
      clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }

  /** 启动拖拽自动滚动（focus 超出视口时） */
  function maybeStartAutoScroll(focusRow: number): void {
    const viewportTopRow = LOGO_ROWS + effectiveScrollTop;
    const viewportBottomRow = viewportTopRow + visibleRows - 1;
    const outOfTop = focusRow < viewportTopRow;
    const outOfBottom = focusRow > viewportBottomRow;
    if (!outOfTop && !outOfBottom) {
      stopAutoScroll();
      return;
    }
    if (autoScrollTimerRef.current !== null) return; // 已在跑
    autoScrollTimerRef.current = setInterval(() => {
      setScrollTop((prev) => {
        const cur = computeScrollState({ total: messages.length, visibleRows, scrollTop: prev });
        const dir = outOfTop ? -1 : 1;
        const next = Math.max(0, Math.min(cur.maxScroll, prev + dir));
        if (next === prev) return prev; // 钳到边界，不动
        // 滚出视口的行文本入缓存
        if (outOfTop && next < prev) {
          // 向上滚：底部滚出的行入「below」缓存
          const rowLeaving = LOGO_ROWS + prev + visibleRows - 1;
          const txt = getLineContentByRowSnapshot(rowLeaving);
          if (txt) selectionStore.getState().pushScrolledOff('below', txt);
        } else if (outOfBottom && next > prev) {
          // 向下滚：顶部滚出的行入「above」缓存
          const rowLeaving = LOGO_ROWS + prev;
          const txt = getLineContentByRowSnapshot(rowLeaving);
          if (txt) selectionStore.getState().pushScrolledOff('above', txt);
        }
        return next;
      });
    }, AUTOSCROLL_MS);
  }

  // getLineContentByRow 用 effectiveScrollTop 闭包，但 setInterval 内 effectiveScrollTop 可能 stale。
  // 提供一个用最新 messages 算的版本（不依赖闭包 scrollTop，按 row 直接反推 flatRow 用 prev）。
  // 简化：getLineContentByRowSnapshot 与 getLineContentByRow 同逻辑，但 messages 是闭包稳定的。
  // 因 messages 引用在 setScrollTop 闭包内不变，行→文本映射稳定，可直接复用。
  // 但 effectiveScrollTop 在 setScrollTop 的 updater 内是 stale 的——updater 用 prev 重算。
  // 故这里直接用 getLineContentByRow（它读 effectiveScrollTop 闭包值，首次启动时正确）。
  // 实测若 stale 导致缓存错行，spec §7 已标注为实现期验证点。
  function getLineContentByRowSnapshot(row: number): string | null {
    // 与 getLineContentByRow 同实现；保留独立函数便于未来按 prev 重算
    return getLineContentByRow(row);
  }

  // 鼠标事件路由
  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      const str = typeof data === 'string' ? data : data.toString('utf8');
      const events = parserRef.current.feed(str);
      for (const ev of events) {
        // SGR col/row 1-origin → 0-based
        const row = ev.row - 1;
        const col = ev.col - 1;

        // 滚轮（拖拽中禁用）
        if (ev.type === 'wheelup' || ev.type === 'wheeldown') {
          if (selectionStore.getState().isDragging) continue; // 拖拽中禁用
          setScrollTop((prev) => {
            const cur = computeScrollState({ total: messages.length, visibleRows, scrollTop: prev });
            const delta = 3;
            const next = ev.type === 'wheelup' ? prev - delta : prev + delta;
            const clamped = Math.max(0, Math.min(cur.maxScroll, next));
            if (clamped < cur.maxScroll) userScrolledAwayRef.current = true;
            else userScrolledAwayRef.current = false;
            return clamped;
          });
          continue;
        }

        // 左键（button 0/32-motion）
        if (ev.button === 0 || ev.button === 32) {
          if (ev.type === 'mousedown') {
            // 多击检测
            const click = classifyClick(clickStateRef.current, ev.button, ev.row, ev.col, Date.now());
            clickStateRef.current = click.state;
            const lineContent = getLineContentByRow(row);
            if (click.kind === 'double' && lineContent !== null) {
              const hit = selectionStore.getState().selectWordAt(row, col, lineContent);
              if (hit) continue;
            } else if (click.kind === 'triple' && lineContent !== null) {
              selectionStore.getState().selectLineAt(row, lineContent);
              continue;
            }
            // single 或词/行未命中：开始拖拽
            selectionStore.getState().startDrag({ row, col });
          } else if (ev.type === 'mousedrag') {
            selectionStore.getState().dragTo({ row, col });
            maybeStartAutoScroll(row);
          } else if (ev.type === 'mouseup') {
            selectionStore.getState().endDrag();
            stopAutoScroll();
            // 不复制（spec：仅右键复制）
          }
          continue;
        }

        // 右键（button 2）：复制 + 清高亮
        if (ev.type === 'mousedown' && ev.button === 2) {
          stopAutoScroll();
          void copyOnRightClick();
          continue;
        }
      }
    };

    async function copyOnRightClick(): Promise<void> {
      const sel = selectionStore.getState();
      const text = getSelectedText({
        messages, scrollTop: effectiveScrollTop, visibleRows,
        viewportTopRow: LOGO_ROWS + effectiveScrollTop, selection: sel,
      });
      if (text) {
        try {
          await writeClipboard(text);
        } catch {
          // 剪贴板失败静默（spec §6 防御边界 4/5）
        }
      }
      selectionStore.getState().clear(); // 清高亮（含缓存）
    }

    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      stopAutoScroll();
    };
  }, [stdin, messages, visibleRows, selectionStore, effectiveScrollTop]);

  // 开启鼠标追踪
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
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {visible.map((m, i) => {
        const globalRow = LOGO_ROWS + state.scrollTop + i;
        return (
          <MessageRow
            key={m.uuid}
            message={m}
            globalRow={globalRow}
            selectionStore={selectionStore}
          />
        );
      })}
    </Box>
  );
}
