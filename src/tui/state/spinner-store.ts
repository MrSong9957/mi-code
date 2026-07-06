// src/tui/state/spinner-store.ts
// Spinner 数据 store（zustand vanilla）
//
// 物理本质：footer spinner 区的「数据源」。对齐旧 src/renderer/spinner.ts：
// - braille 10 帧（⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏），120ms 一帧（由 Spinner 组件的 setInterval 驱动）
// - 3s 无 token → stalled（红）
// - label 由调用方决定（Thinking…/Running X/Generating…）
//
// store 只管数据；动画 setInterval 在 Spinner.tsx 里（React 生命周期管理）。

import { createStore, type StoreApi } from 'zustand/vanilla';

/** braille 帧序（10 帧）——导出供组件消费 */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** 无 token 多久判 stall（ms） */
const STALL_MS = 3000;

export interface SpinnerState {
  active: boolean;
  label: string;
  frameIndex: number;
  stalled: boolean;
  /** 最近一次收到 token 的时间戳（Date.now()） */
  lastTokenAt: number;
  start: (label: string) => void;
  stop: () => void;
  setLabel: (label: string) => void;
  /** 推进一帧（120ms 一次）；inactive 时 no-op */
  tick: () => void;
  /** 收到 token：刷新 lastTokenAt，清 stalled */
  onToken: () => void;
}

export type SpinnerStore = StoreApi<SpinnerState>;

export function createSpinnerStore(): SpinnerStore {
  return createStore<SpinnerState>((set) => ({
    active: false,
    label: '',
    frameIndex: 0,
    stalled: false,
    lastTokenAt: 0,

    start: (label) => set({
      active: true, label, frameIndex: 0, stalled: false, lastTokenAt: Date.now(),
    }),
    stop: () => set({ active: false, label: '', stalled: false }),
    setLabel: (label) => set({ label }),
    tick: () => set((s) => {
      if (!s.active) return s;
      const next = (s.frameIndex + 1) % SPINNER_FRAMES.length;
      const stalled = Date.now() - s.lastTokenAt > STALL_MS;
      return { frameIndex: next, stalled };
    }),
    onToken: () => set({ lastTokenAt: Date.now(), stalled: false }),
  }));
}
