// src/tui/inline/spinner-visibility.test.ts
// 回归测试：spinner 在 assistant 正文固化后、stopSpinner 前的闪烁 bug。
//
// 根因：message finalize (T2) 早于 emitLoopEnd→stopSpinner (T3)，
// 两者之间存在一个 React 渲染窗口：此时 spinner.active=true 且
// isStreamingNow=false（已 finalized），导致 spinnerVisible 从 false 跳回 true，
// spinner 行被重新画一帧 → T3 stop 后再擦掉 = 闪烁。
//
// 修复：finalized 后不再显示 spinner（正文已输出完毕，残影无意义）。

import { describe, it, expect } from 'vitest';
import { computeSpinnerVisible } from './spinner-visibility.js';

describe('computeSpinnerVisible', () => {
  it('正文流式中(active + streaming)：显示 spinner（方案 A1：active 期间持续显示）', () => {
    expect(computeSpinnerVisible({
      spinnerActive: true,
      isStreamingNow: true,
      streamingText: '部分正文',
      lastRole: 'assistant',
      lastFinalized: false,
    })).toBe(true);
  });

  it('thinking 流式中(active + streaming thinking)：显示 spinner', () => {
    expect(computeSpinnerVisible({
      spinnerActive: true,
      isStreamingNow: true,
      streamingText: '思考内容',
      lastRole: 'thinking',
      lastFinalized: false,
    })).toBe(true);
  });

  it('未流式且 active（如纯工具调用间隙）：显示 spinner', () => {
    expect(computeSpinnerVisible({
      spinnerActive: true,
      isStreamingNow: false,
      streamingText: undefined,
      lastRole: 'assistant',
      lastFinalized: false,
    })).toBe(true);
  });

  // ── 回归：闪烁 bug 的核心场景 ──
  it('正文刚固化(finalized=true)、spinner 尚未 stop(active=true)：隐藏 spinner（不闪烁）', () => {
    expect(computeSpinnerVisible({
      spinnerActive: true,        // stopSpinner 还没执行
      isStreamingNow: false,      // 已 finalized
      streamingText: undefined,   // finalizeStreaming 清除了 streamingText
      lastRole: 'assistant',
      lastFinalized: true,        // ← 关键：正文已固化
    })).toBe(false);
  });

  it('spinner 已 stop(active=false)：隐藏', () => {
    expect(computeSpinnerVisible({
      spinnerActive: false,
      isStreamingNow: false,
      streamingText: undefined,
      lastRole: 'assistant',
      lastFinalized: true,
    })).toBe(false);
  });
});
