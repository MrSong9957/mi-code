// src/tui/components/ScrollBox.tsx
// 虚拟滚动容器（charter §核心模块 1）+ 鼠标选区（charter §核心模块 2）
//
// 物理本质：长列表「取景器」+ 鼠标拖拽「选区画笔」。
// - 虚拟滚动：只渲染 [scrollTop, scrollTop+visibleRows) 区间（裁剪省渲染）
// - 鼠标滚轮：调 scrollTop（钳位 [0, maxScroll]）
// - 鼠标选区：?1003h 全追踪，mousedown 设 anchor、mousedrag 更新 focus、mouseup 结束；
//   selected 行叠加 inverse（SGR 7）高亮
// - 自动跟随：用户没主动上滚时，messages 增长 → scrollTop 追到 maxScroll
//
// 屏幕行号约定（0-based 全局）：SGR 鼠标 row 为 1-origin 全局，减 1 转 0-based。
// ScrollBox 顶部全局行 = LOGO_ROWS（LOGO 在上方）；消息 i 全局行 = LOGO_ROWS + scrollTop + i。

import React, { useState, useEffect, useRef } from 'react';
import { Box, useStdin } from 'ink';
import type { TuiMessage } from '../types.js';
import { computeScrollState, sliceVisible } from './scroll-state.js';
import { createMouseParser } from '../input/mouse-events.js';
import { writeClipboard } from '../input/clipboard.js';
import { MessageRow } from './MessageRow.js';
import type { SelectionStore } from '../state/selection-store.js';

/** LOGO 区占的行数（与 App.tsx LOGO_ROWS 一致，用于鼠标全局行→ScrollBox 内行换算） */
const LOGO_ROWS = 3;

export interface ScrollBoxProps {
  messages: TuiMessage[];
  visibleRows: number;
  selectionStore: SelectionStore;
}

export function ScrollBox({ messages, visibleRows, selectionStore }: ScrollBoxProps): React.ReactElement {
  /** 用户是否手动上滚过（上滚后暂停自动跟随，直到重新到底） */
  const userScrolledAwayRef = useRef(false);
  // 初始 scrollTop 直接算到底部（首次渲染即显示最新内容，不依赖 effect 异步修正）
  const [scrollTopRaw, setScrollTop] = useState(() => Math.max(0, messages.length - visibleRows));
  const { stdin, setRawMode } = useStdin();
  const parserRef = useRef(createMouseParser());

  // 自动跟随（同步）：用户没上滚时，每次 render 都把 scrollTop 钉到 maxScroll
  const effectiveScrollTop = userScrolledAwayRef.current ? scrollTopRaw : Math.max(0, messages.length - visibleRows);
  const state = computeScrollState({ total: messages.length, visibleRows, scrollTop: effectiveScrollTop });
  const visible = sliceVisible(messages, state);

  // 同步 scrollTopRaw 与 effective
  useEffect(() => {
    if (!userScrolledAwayRef.current && scrollTopRaw !== state.maxScroll) {
      setScrollTop(state.maxScroll);
    }
  }, [messages.length, state.maxScroll]);

  // 鼠标事件：滚轮 + 选区（统一经 mouse-events 解析器，charter §4 全局鼠标）
  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      const str = typeof data === 'string' ? data : data.toString('utf8');
      const events = parserRef.current.feed(str);
      for (const ev of events) {
        const globalRow = ev.row - 1; // SGR row 1-origin → 0-based 全局
        const globalCol = ev.col - 1; // SGR col 1-origin → 0-based 显示列
        if (ev.type === 'wheelup' || ev.type === 'wheeldown') {
          setScrollTop((prev) => {
            const cur = computeScrollState({ total: messages.length, visibleRows, scrollTop: prev });
            const delta = 3;
            const next = ev.type === 'wheelup' ? prev - delta : prev + delta;
            const clamped = Math.max(0, Math.min(cur.maxScroll, next));
            if (clamped < cur.maxScroll) userScrolledAwayRef.current = true;
            else userScrolledAwayRef.current = false;
            return clamped;
          });
        } else if (ev.type === 'mousedown') {
          // Task 7-8 will rewrite this with full Point-based gesture + word/line detection;
          // here we bridge the new char-level API with col=0 (row-level approximation).
          selectionStore.getState().startDrag({ row: globalRow, col: 0 });
        } else if (ev.type === 'mousedrag') {
          selectionStore.getState().dragTo({ row: globalRow, col: globalCol });
        } else if (ev.type === 'mouseup') {
          selectionStore.getState().endDrag();
          // 释放后自动复制选中行（MVP：拖拽完即复制，charter §2 步骤 3）
          void copySelection(messages, state.scrollTop, selectionStore, visibleRows);
        }
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, messages.length, visibleRows, selectionStore]);

  // 开启鼠标追踪：?1003h（全追踪，charter §2 要求）+ ?1006h（SGR 编码）
  useEffect(() => {
    if (!stdin) return;
    setRawMode(true);
    process.stdout.write('\x1b[?1003h\x1b[?1006h');
    return () => {
      process.stdout.write('\x1b[?1003l\x1b[?1006l');
      setRawMode(false);
    };
  }, [stdin, setRawMode]);

  // 当前选区（订阅 selectionStore，selected 判断用）
  const sel = selectionStore.getState();

  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {visible.map((m, i) => {
        // 消息 i 的全局行 = LOGO_ROWS + scrollTop + i
        const globalRow = LOGO_ROWS + state.scrollTop + i;
        return (
          <MessageRow
            key={m.uuid}
            message={m}
            // Task 7 will rewrite MessageRow to read colsForRow for char-level highlight;
            // here we bridge with row-level rowIntersects.
            selected={sel.rowIntersects(globalRow)}
          />
        );
      })}
    </Box>
  );
}

/**
 * 释放鼠标后复制选中行到系统剪贴板（MVP，charter §2 步骤 3）。
 * 选区是全局行号；消息 i 全局行 = LOGO_ROWS + scrollTop + i。
 * 提取所有 globalRow 落在 [rangeMin, rangeMax] 的消息行的纯文本，join 成多行字符串。
 */
async function copySelection(
  messages: TuiMessage[],
  scrollTop: number,
  selectionStore: SelectionStore,
  _visibleRows: number,
): Promise<void> {
  void _visibleRows;
  // Task 5 will rewrite copySelection to use selectionRect/colsForRow/scrolledOff for char-level text extraction;
  // here we bridge with the new API (row range from selectionRect).
  const rect = selectionStore.getState().selectionRect();
  if (!rect) return;
  const [minRow, maxRow] = [rect.minRow, rect.maxRow];
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const globalRow = LOGO_ROWS + scrollTop + i;
    if (globalRow < minRow) continue;
    if (globalRow > maxRow) break;
    const msg = messages[i]!;
    // 已固化消息：取 lines 的 content；流式：取 streamingText
    const text = !msg.finalized && msg.streamingText !== undefined
      ? msg.streamingText
      : msg.lines.map(l => `${' '.repeat(l.indent ?? 0)}${l.content}`).join('\n');
    lines.push(text);
  }
  if (lines.length === 0) return;
  try {
    await writeClipboard(lines.join('\n'));
  } catch {
    // 剪贴板写入失败（命令不存在等）静默忽略——选区高亮仍生效
  }
}
