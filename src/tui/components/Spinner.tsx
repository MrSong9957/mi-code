// src/tui/components/Spinner.tsx
// Spinner 渲染组件：订阅 spinner-store，active 时 setInterval(120ms) 推进帧
//
// 物理本质：footer 顶部的「加载指示灯」。active 时转 braille 点阵 + label；
// 3s 无 token → stalled（变红）。inactive 时不占行（Yoga 重排）。
//
// 动画 setInterval 挂在 React useEffect 上，unmount/stop 时清理（避免泄漏）。

import React, { useEffect } from 'react';
import { Text } from 'ink';
import { useStore } from 'zustand/react';
import { SPINNER_FRAMES, type SpinnerStore } from '../state/spinner-store.js';

const TICK_MS = 120;

export interface SpinnerProps {
  store: SpinnerStore;
}

export function Spinner({ store }: SpinnerProps): React.ReactElement | null {
  const active = useStore(store, (s) => s.active);
  const label = useStore(store, (s) => s.label);
  const frameIndex = useStore(store, (s) => s.frameIndex);
  const stalled = useStore(store, (s) => s.stalled);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { store.getState().tick(); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [active, store]);

  if (!active) return null;
  const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
  return (
    <Text color={stalled ? 'red' : '#78e6e6'} bold>
      {frame} {label}
    </Text>
  );
}
