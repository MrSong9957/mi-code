// src/tui/components/Spinner.tsx
// Spinner 渲染组件（AltScreen 模式）：订阅 spinner-store，active 时 setInterval 推进时钟
//
// 物理本质：footer 顶部的「加载指示灯」。active 时转符号 + verb/label；
// 3s 无 token → stalled（变红）。inactive 时不占行（Yoga 重排）。
//
// 集成动画组件：
// - GlimmerMessage：shimmer 光效扫过 verb 文字
// - ThinkingIndicator：thinking 模式下 3s 延迟后显示 (thinking) 呼吸
// - DotsCycle：非 thinking 模式下尾部显示 .  ..  ... 循环

import React, { useEffect } from 'react';
import { Text } from 'ink';
import { useStore } from 'zustand/react';
import { SPINNER_FRAMES, type SpinnerStore } from '../state/spinner-store.js';
import { useTheme } from '../state/theme-context.js';
import { computeGlimmerIndex } from '../inline/shimmer.js';
import { GlimmerMessage } from './GlimmerMessage.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
import { DotsCycle } from './DotsCycle.js';
import { formatSpinnerDuration } from '../state/spinner-store.js';

const TICK_MS = 50;
const SHIMMER_SPEED = 200;
const SHIMMER_PAD = 10;

export interface SpinnerProps {
  store: SpinnerStore;
}

export function Spinner({ store }: SpinnerProps): React.ReactElement | null {
  const t = useTheme();
  const active = useStore(store, (s) => s.active);
  const time = useStore(store, (s) => s.time);
  const mode = useStore(store, (s) => s.mode);
  const verb = useStore(store, (s) => s.verb);
  const label = useStore(store, (s) => s.label);
  const stalled = useStore(store, (s) => s.stalled);
  const stalledIntensity = useStore(store, (s) => s.stalledIntensity);
  const thinkStartTime = useStore(store, (s) => s.thinkStartTime);
  const displayedTokens = useStore(store, (s) => s.displayedTokens);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { store.getState().tick(); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [active, store]);

  if (!active) return null;

  const frame = SPINNER_FRAMES[Math.floor(time / 120) % SPINNER_FRAMES.length];
  const displayText = label || verb;

  const messageWidth = displayText.length;
  const glimmerIndex = computeGlimmerIndex(time, messageWidth, {
    speed: mode === 'requesting' ? 50 : SHIMMER_SPEED,
    cyclePad: SHIMMER_PAD,
    stalled,
  });

  const glyphColor = stalledIntensity > 0.01 ? t.spinnerStalled : t.spinnerActive;
  const showMetrics = time >= 30_000;
  const tokens = displayedTokens > 0 ? ` ${mode === 'requesting' ? '↑' : '↓'} ${displayedTokens}` : '';

  return (
    <>
      <Text color={glyphColor} bold>{frame} </Text>
      <GlimmerMessage
        message={displayText}
        glimmerIndex={glimmerIndex}
        baseColor={glyphColor}
        shimmerColor={t.spinnerShimmer}
      />
      {mode === 'thinking' && (
        <ThinkingIndicator
          storeTime={time}
          thinkStartTime={thinkStartTime}
          text="thinking"
        />
      )}
      {mode !== 'thinking' && <DotsCycle time={time} color={t.textMuted} />}
      {showMetrics && <Text color={t.textMuted}>{`  ${formatSpinnerDuration(time)}${tokens}`}</Text>}
    </>
  );
}
