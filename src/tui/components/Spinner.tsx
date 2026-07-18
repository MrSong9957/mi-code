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
import {
  shouldShowSpinnerTimer,
  thinkingStatusText,
  thoughtStatusText,
  totalSpinnerTokens,
  TICK_MS,
  type SpinnerStore,
} from '../state/spinner-store.js';
import { useTheme } from '../state/theme-context.js';
import {
  computeGlimmerIndex,
  measureShimmerMessage,
  toolUseFlashOpacity,
} from '../inline/shimmer.js';
import { GlimmerMessage } from './GlimmerMessage.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
import { DotsCycle } from './DotsCycle.js';
import { formatSpinnerDuration } from '../state/spinner-store.js';
import { SpinnerGlyph } from './SpinnerGlyph.js';

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
  const reducedMotion = useStore(store, (s) => s.reducedMotion);
  const thinkStartTime = useStore(store, (s) => s.thinkStartTime);
  const thinkingEffort = useStore(store, (s) => s.thinkingEffort);
  const thinkingSummary = useStore(store, (s) => s.thinkingSummary);
  const displayedTokens = useStore(store, (s) => s.displayedTokens);
  const verbose = useStore(store, (s) => s.verbose);
  const activeTeammateCount = useStore(store, (s) => s.activeTeammateCount);
  const teammateTokens = useStore(store, (s) => s.teammateTokens);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { store.getState().tick(); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [active, store]);

  if (!active) return null;

  const displayText = label || verb;

  const messageWidth = measureShimmerMessage(displayText);
  const glimmerIndex = computeGlimmerIndex(time, messageWidth, {
    speed: mode === 'requesting' ? TICK_MS : SHIMMER_SPEED,
    cyclePad: SHIMMER_PAD,
    stalled,
    direction: mode === 'requesting' ? 'left-to-right' : 'right-to-left',
  });

  const showMetrics = shouldShowSpinnerTimer(time, verbose, activeTeammateCount);
  const totalTokens = totalSpinnerTokens(displayedTokens, teammateTokens);
  const tokens = totalTokens > 0 ? ` ${mode === 'requesting' ? '↑' : '↓'} ${totalTokens}` : '';
  const thinkingText = mode === 'thinking'
    ? thinkingStatusText(thinkingEffort)
    : thinkingSummary
      ? thoughtStatusText(thinkingSummary.durationMs)
      : null;

  return (
    <>
      <SpinnerGlyph
        time={time}
        activeColor={t.spinnerActive}
        stalledIntensity={stalledIntensity}
        reducedMotion={reducedMotion}
      />
      <GlimmerMessage
        message={displayText}
        glimmerIndex={glimmerIndex}
        baseColor={t.spinnerActive}
        shimmerColor={t.spinnerShimmer}
        flashOpacity={mode === 'tool-use' && !stalled ? toolUseFlashOpacity(time) : undefined}
        stalledIntensity={stalledIntensity}
      />
      {thinkingText && (
        <ThinkingIndicator
          storeTime={time}
          thinkStartTime={mode === 'thinking' ? thinkStartTime : null}
          text={thinkingText}
        />
      )}
      {!thinkingText && <DotsCycle time={time} color={t.textMuted} />}
      {showMetrics && <Text color={t.textMuted}>{`  ${formatSpinnerDuration(time)}${tokens}`}</Text>}
    </>
  );
}
