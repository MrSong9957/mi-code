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
import { Box, useInput, useStdin } from 'ink';
import type { TuiMessage } from '../types.js';
import { computeScrollState, sliceVisible } from './scroll-state.js';
import { createMouseParser } from '../input/mouse-events.js';
import { writeClipboard } from '../input/clipboard.js';
import { MessageRow } from './MessageRow.js';
import type { SelectionStore } from '../state/selection-store.js';
import { classifyClick, type ClickState } from '../selection/click-detector.js';
import { getSelectedText } from '../selection/get-selected-text.js';

/**
 * SGR 鼠标残片检测：Ink 的 useInput 把 \x1b[<button;col;rowM|m 整段当作一个
 * escape sequence 交付，且先剥离前导 \x1b，故到达这里的 input 形如 [<0;10;5M。
 * 此正则识别这种残片（key 全 false，无 key.sequence 可读）。
 */
// eslint-disable-next-line no-control-regex
const SGR_FRAGMENT_RE = /^\[<\d+;\d+;\d+[Mm]/;

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

  // ⚠️ 鼠标事件走 Ink useInput 通道（不再直接 stdin.on('data')）。
  // 原因：Ink 7 用 'readable'+stdin.read() 拉输入，与 stdin.on('data') 的 flowing 模式互斥，
  // 鼠标 SGR 字节会被 Ink InputParser 抢先消费、经 useInput 交付（前导 \x1b 被剥），
  // 永远到不了 stdin.on('data')。故改在 useInput 回调里识别 SGR 残片、重建完整序列、
  // 喂给 mouseParser。useInput 回调在 Ink 内部稳定注册一次，故需用 ref 读最新易变值，
  // 避免 stale closure。相关 ref 每次 render 同步更新（见下）。
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;
  const effectiveScrollTopRef = useRef(effectiveScrollTop);
  effectiveScrollTopRef.current = effectiveScrollTop;

  useEffect(() => {
    if (!userScrolledAwayRef.current && scrollTopRaw !== state.maxScroll) {
      setScrollTop(state.maxScroll);
    }
  }, [messages.length, state.maxScroll]);

  /** 取某屏幕全局行对应的「整行文本」（用于双击选词/三击选行/滚动缓存）。
   *  读 ref 持有的最新 messages/effectiveScrollTop，useInput 回调与 setInterval 均安全。 */
  function getLineContentByRow(row: number): string | null {
    const est = effectiveScrollTopRef.current;
    const flatRow = row - LOGO_ROWS - est;
    if (flatRow < 0) return null;
    let acc = 0;
    for (const msg of messagesRef.current) {
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
    const est = effectiveScrollTopRef.current;
    const vr = visibleRowsRef.current;
    const viewportTopRow = LOGO_ROWS + est;
    const viewportBottomRow = viewportTopRow + vr - 1;
    const outOfTop = focusRow < viewportTopRow;
    const outOfBottom = focusRow > viewportBottomRow;
    if (!outOfTop && !outOfBottom) {
      stopAutoScroll();
      return;
    }
    if (autoScrollTimerRef.current !== null) return; // 已在跑
    autoScrollTimerRef.current = setInterval(() => {
      setScrollTop((prev) => {
        const total = messagesRef.current.length;
        const vr2 = visibleRowsRef.current;
        const cur = computeScrollState({ total, visibleRows: vr2, scrollTop: prev });
        const dir = outOfTop ? -1 : 1;
        const next = Math.max(0, Math.min(cur.maxScroll, prev + dir));
        if (next === prev) return prev; // 钳到边界，不动
        // 滚出视口的行文本入缓存（用 prev 反推滚出行，与 getLineContentByRow 的 ref 一致）
        if (outOfTop && next < prev) {
          const rowLeaving = LOGO_ROWS + prev + vr2 - 1; // 底部滚出 → below 缓存
          const txt = getLineContentByRow(rowLeaving);
          if (txt) selectionStore.getState().pushScrolledOff('below', txt);
        } else if (outOfBottom && next > prev) {
          const rowLeaving = LOGO_ROWS + prev; // 顶部滚出 → above 缓存
          const txt = getLineContentByRow(rowLeaving);
          if (txt) selectionStore.getState().pushScrolledOff('above', txt);
        }
        return next;
      });
    }, AUTOSCROLL_MS);
  }

  /** 路由单个解析后的鼠标事件到 selectionStore / scrollTop */
  function routeMouseEvent(ev: { type: string; button: number; row: number; col: number }): void {
    // SGR col/row 1-origin → 0-based
    const row = ev.row - 1;
    const col = ev.col - 1;

    // 滚轮（拖拽中禁用）
    if (ev.type === 'wheelup' || ev.type === 'wheeldown') {
      if (selectionStore.getState().isDragging) return;
      setScrollTop((prev) => {
        const total = messagesRef.current.length;
        const vr = visibleRowsRef.current;
        const cur = computeScrollState({ total, visibleRows: vr, scrollTop: prev });
        const delta = 3;
        const next = ev.type === 'wheelup' ? prev - delta : prev + delta;
        const clamped = Math.max(0, Math.min(cur.maxScroll, next));
        if (clamped < cur.maxScroll) userScrolledAwayRef.current = true;
        else userScrolledAwayRef.current = false;
        return clamped;
      });
      return;
    }

    // 左键（button 0/32-motion）
    if (ev.button === 0 || ev.button === 32) {
      if (ev.type === 'mousedown') {
        const click = classifyClick(clickStateRef.current, ev.button, ev.row, ev.col, Date.now());
        clickStateRef.current = click.state;
        const lineContent = getLineContentByRow(row);
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
    const est = effectiveScrollTopRef.current;
    const vr = visibleRowsRef.current;
    const sel = selectionStore.getState();
    const text = getSelectedText({
      messages: messagesRef.current, scrollTop: est, visibleRows: vr,
      viewportTopRow: LOGO_ROWS + est, selection: sel,
    });
    if (text) {
      try {
        await writeClipboard(text);
      } catch {
        // 剪贴板失败静默（spec §6 防御边界 4/5）
      }
    }
    selectionStore.getState().clear();
  }

  // 鼠标事件：经 Ink useInput 通道（Ink 把 SGR 整段当 escape sequence 交付，前导 \x1b 被剥）。
  // 重建 \x1b + input 喂给 parser，解析出的事件路由到 selectionStore。
  useInput((input: string) => {
    if (!SGR_FRAGMENT_RE.test(input)) return; // 非鼠标残片，交给键盘 handler
    // 重建完整 SGR 序列（补回被 Ink 剥的前导 \x1b）
    const events = parserRef.current.feed('\x1b' + input);
    for (const ev of events) {
      routeMouseEvent(ev);
    }
  });

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
