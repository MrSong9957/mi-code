// src/tui/components/Spinner.tsx
// Spinner 渲染组件（AltScreen 模式）：订阅 spinner-store，active 时 setInterval 推进时钟
//
// 物理本质：footer 顶部的「加载指示灯」。active 时转符号 + verb/label；
// 3s 无 token → stalled（变红）。inactive 时不占行（Yoga 重排）。
//
// 注：四套完整动画（shimmer/点循环/thinking 呼吸）在 inline 模式的 buildSpinnerLine 实现。
// AltScreen 模式（Ink/React）保持基础渲染——符号旋转 + verb 文字，shimmer 由 Ink reconciler 节流。
// 符号帧由 store.time 派生（floor(time/120)%12），与 inline 共享同一时钟。

import React, { useEffect } from 'react';
import { Text } from 'ink';
import { useStore } from 'zustand/react';
import { SPINNER_FRAMES, type SpinnerStore } from '../state/spinner-store.js';
import { useTheme } from '../state/theme-context.js';

const TICK_MS = 50;

export interface SpinnerProps {
  store: SpinnerStore;
}

export function Spinner({ store }: SpinnerProps): React.ReactElement | null {
  const t = useTheme();
  const active = useStore(store, (s) => s.active);
  const time = useStore(store, (s) => s.time);
  const verb = useStore(store, (s) => s.verb);
  const label = useStore(store, (s) => s.label);
  const stalled = useStore(store, (s) => s.stalled);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { store.getState().tick(); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [active, store]);

  if (!active) return null;
  const frame = SPINNER_FRAMES[Math.floor(time / 120) % SPINNER_FRAMES.length];
  const text = label || verb;
  return (
    <Text color={stalled ? t.spinnerStalled : t.spinnerActive} bold>
      {frame} {text}
    </Text>
  );
}
