// src/tui/components/ScrollBox.tsx
// 虚拟滚动容器（charter §核心模块 1）
//
// 物理本质：长列表上的「取景器 + 自动跟随」。
// alt screen 无原生 scrollback，应用层全权管理滚动：
// - 只渲染 [scrollTop, scrollTop+visibleRows) 区间的消息（裁剪，省渲染开销）
// - 鼠标滚轮（SGR 编码）调整 scrollTop，钳位 [0, maxScroll]
// - 自动跟随：用户没主动上滚时，messages 增长 → scrollTop 自动追到 maxScroll（看最新）
// - 用户上滚后，新消息不再自动跟随（直到重新滚到底）
//
// visibleRows 来自终端高度 - footer 高度（由父组件传入）。

import React, { useState, useEffect, useRef } from 'react';
import { Box, useStdin } from 'ink';
import type { TuiMessage } from '../types.js';
import { computeScrollState, sliceVisible } from './scroll-state.js';
import { parseMouseWheel } from '../input/mouse-wheel.js';
import { MessageRow } from './MessageRow.js';

export interface ScrollBoxProps {
  messages: TuiMessage[];
  visibleRows: number;
}

export function ScrollBox({ messages, visibleRows }: ScrollBoxProps): React.ReactElement {
  /** 用户是否手动上滚过（上滚后暂停自动跟随，直到重新到底） */
  const userScrolledAwayRef = useRef(false);
  // 初始 scrollTop 直接算到底部（首次渲染即显示最新内容，不依赖 effect 异步修正）
  const [scrollTopRaw, setScrollTop] = useState(() => Math.max(0, messages.length - visibleRows));
  const { stdin, setRawMode } = useStdin();

  // 自动跟随（同步）：用户没上滚时，每次 render 都把 scrollTop 钉到 maxScroll。
  // 这样 messages 增长能立刻反映在新帧里，不依赖 effect 的异步 setState。
  const effectiveScrollTop = userScrolledAwayRef.current ? scrollTopRaw : Math.max(0, messages.length - visibleRows);
  const state = computeScrollState({ total: messages.length, visibleRows, scrollTop: effectiveScrollTop });
  const visible = sliceVisible(messages, state);

  // 同步 scrollTopRaw 与 effective（用户没上滚时保持 raw 也追到底，避免上滚瞬间跳）
  useEffect(() => {
    if (!userScrolledAwayRef.current && scrollTopRaw !== state.maxScroll) {
      setScrollTop(state.maxScroll);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, state.maxScroll]);

  // 鼠标滚轮：监听 stdin raw data，解析 SGR 滚轮
  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      const str = typeof data === 'string' ? data : data.toString('utf8');
      const wheel = parseMouseWheel(str);
      if (wheel === null) return;
      setScrollTop((prev) => {
        const cur = computeScrollState({ total: messages.length, visibleRows, scrollTop: prev });
        const delta = 3; // 每次滚 3 条
        const next = wheel === 'up' ? prev - delta : prev + delta;
        const clamped = Math.max(0, Math.min(cur.maxScroll, next));
        // 用户上滚 → 标记离开底部；滚到底 → 清除标记
        if (clamped < cur.maxScroll) {
          userScrolledAwayRef.current = true;
        } else {
          userScrolledAwayRef.current = false;
        }
        return clamped;
      });
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, messages.length, visibleRows]);

  // 开启鼠标追踪：?1000h（报告滚轮+按下）+ ?1006h（SGR 编码）
  // 注意：不开 ?1003h（全追踪，属 selection，留后续期）
  useEffect(() => {
    if (!stdin) return;
    setRawMode(true);
    process.stdout.write('\x1b[?1000h\x1b[?1006h');
    return () => {
      process.stdout.write('\x1b[?1000l\x1b[?1006l');
      setRawMode(false);
    };
  }, [stdin, setRawMode]);

  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {visible.map((m) => (
        <MessageRow key={m.uuid} message={m} />
      ))}
    </Box>
  );
}
