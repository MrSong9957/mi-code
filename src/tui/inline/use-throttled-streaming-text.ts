// src/tui/inline/use-throttled-streaming-text.ts
// 流式文本渲染节流（第四层：对标 Claude Code 机制四）
//
// Claude Code 用 Ink 的 lodash throttle + React automatic batching 合并
// 同事件循环内的多次 setState，每秒最多 ~60 帧（16ms）。本项目 inline 模式
// 没有 Ink reconciler，每个 text_delta → store set → effect → commit → stdout.write，
// token 来多快就重绘多快 → "打印机感"。
//
// 本 hook 在数据层（messagesStore → InlineApp）之间插入一个 leading + trailing
// 节流层：cooldown（THROTTLE_MS）内的多次更新只 flush 最新值到消费者。
//
// 机制（leading + trailing）：
//   undefined → 值      ：leading 立即 flush（首个 token 不延迟，避免开始流式后空白）
//   cooldown 中再推值   ：吞中间值，cooldown 结束时 trailing flush 最新值
//   值 → undefined      ：立即同步（finalize 固化行不延迟）+ 清 timer
//   值未变              ：no-op（spinner tick 等触发 effect 重跑但值没变）
//
// 为什么在 UI 层节流而非管线层：节流是渲染关注点（控帧率），与数据正确性无关。
// 管线层（index.ts/pipeline/store）保持每个 token 的真实状态，UI 层决定何时落屏。
// 固化（finalize）走 undefined 路径，绕过节流，保证完整文本及时进 scrollback。

import { useEffect, useRef, useState } from 'react';

/** cooldown 窗口（ms）。
 *  250ms ≈ 4fps：流式文本更新频率。太高会导致"打印机感"，太低会导致
 *  inline 模式下 effect 重跑过于频繁，终端累积重复输出。
 *  流式文本已通过 rewriteStreamingLines 做 cursorUp 全行覆写，低帧率可接受。 */
export const THROTTLE_MS = 250;

/**
 * 对流式文本做 leading + trailing 节流。
 *
 * @param realText 当前真实的流式文本（来自 messagesStore）。undefined = 非流式 / 已固化。
 * @returns 节流后的文本，供 InlineApp 渲染消费。
 */
export function useThrottledStreamingText(
  realText: string | undefined,
): string | undefined {
  const [throttled, setThrottled] = useState<string | undefined>(realText);
  /** cooldown timer（pending 时吞中间值） */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 每轮渲染同步更新的最新值，trailing 回调读取（避免闭包捕获旧值） */
  const latestRef = useRef<string | undefined>(realText);
  /** 上次已 flush 的值，判断"值是否真变了"（避免 no-op 触发额外渲染） */
  const lastFlushedRef = useRef<string | undefined>(realText);

  latestRef.current = realText;

  useEffect(() => {
    // finalize：立即同步 + 清 timer（固化行不延迟）
    if (realText === undefined) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (lastFlushedRef.current !== undefined) {
        setThrottled(undefined);
        lastFlushedRef.current = undefined;
      }
      return;
    }

    // 值未变：no-op（spinner tick 等触发 effect 但 streamingText 没变）
    if (realText === lastFlushedRef.current) {
      return;
    }

    // cooldown 中：吞中间值，等 trailing flush
    if (timerRef.current !== null) {
      return;
    }

    // leading：立即 flush + 开 cooldown
    setThrottled(realText);
    lastFlushedRef.current = realText;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // trailing：flush cooldown 期间积累的最新值
      const latest = latestRef.current;
      if (latest !== undefined && latest !== lastFlushedRef.current) {
        setThrottled(latest);
        lastFlushedRef.current = latest;
      }
    }, THROTTLE_MS);
  }, [realText]);

  // 卸载清 timer 防泄漏
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return throttled;
}
