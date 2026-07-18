import { createStore, type StoreApi } from 'zustand/vanilla';
import { sampleVerb } from './spinner-verbs.js';

/** Claude Code 的 6 帧往返序列；time 的单位始终是毫秒。 */
export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'] as const;
export const TICK_MS = 50;
const STALL_MS = 3_000;
const STALL_RAMP_MS = 2_000;
const TURN_COMPLETION_VERBS = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked'] as const;

/** 与流生命周期对应的五种视觉状态。 */
export type SpinnerMode = 'requesting' | 'responding' | 'thinking' | 'tool-use' | 'tool-input';
export interface SpinnerCompletion { verb: string; durationMs: number; }

export function formatSpinnerDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export interface SpinnerState {
  active: boolean;
  /** 从同一个动画时钟派生帧、shimmer、thinking 与计时。 */
  time: number;
  mode: SpinnerMode;
  verb: string;
  label: string;
  thinkStartTime: number | null;
  stalled: boolean;
  stalledIntensity: number;
  lastTokenAt: number;
  responseLength: number;
  displayedTokens: number;
  startedAt: number;
  start: (mode: SpinnerMode) => void;
  stop: () => SpinnerCompletion | null;
  setMode: (mode: SpinnerMode) => void;
  setLabel: (label: string) => void;
  tick: () => void;
  /** 流式增量到达；长度用于 token 粗估与停滞检测。 */
  onToken: (length?: number) => void;
}

export type SpinnerStore = StoreApi<SpinnerState>;

export function createSpinnerStore(): SpinnerStore {
  return createStore<SpinnerState>((set, get) => ({
    active: false, time: 0, mode: 'responding', verb: '', label: '',
    thinkStartTime: null, stalled: false, stalledIntensity: 0,
    lastTokenAt: 0, responseLength: 0, displayedTokens: 0, startedAt: 0,

    start: (mode) => {
      const now = Date.now();
      set({ active: true, time: 0, mode, verb: sampleVerb(), label: '',
        thinkStartTime: mode === 'thinking' ? 0 : null,
        stalled: false, stalledIntensity: 0, lastTokenAt: now,
        responseLength: 0, displayedTokens: 0, startedAt: now });
    },
    stop: () => {
      const current = get();
      if (!current.active) return null;
      const durationMs = Math.max(0, Date.now() - current.startedAt);
      const verb = TURN_COMPLETION_VERBS[Math.floor(Math.random() * TURN_COMPLETION_VERBS.length)]!;
      set({ active: false, time: 0, verb: '', label: '', thinkStartTime: null,
        stalled: false, stalledIntensity: 0, responseLength: 0, displayedTokens: 0 });
      return { verb, durationMs };
    },
    setMode: (mode) => set((s) => ({
      mode,
      thinkStartTime: mode === 'thinking' ? s.time : null,
      label: mode === 'tool-use' || mode === 'tool-input' ? s.label : '',
    })),
    setLabel: (label) => set({ label }),
    tick: () => set((s) => {
      if (!s.active) return s;
      const now = Date.now();
      const time = Math.max(0, now - s.startedAt);
      const quietMs = now - s.lastTokenAt;
      const targetIntensity = quietMs <= STALL_MS ? 0 : Math.min(1, (quietMs - STALL_MS) / STALL_RAMP_MS);
      const stalledIntensity = s.stalledIntensity + (targetIntensity - s.stalledIntensity) * 0.1;
      const targetTokens = Math.round(s.responseLength / 4);
      const difference = targetTokens - s.displayedTokens;
      const displayedTokens = difference <= 0 ? s.displayedTokens
        : s.displayedTokens + (difference < 70 ? Math.min(3, difference) : difference < 200 ? Math.ceil(difference * 0.15) : 50);
      return { time, stalled: quietMs > STALL_MS, stalledIntensity, displayedTokens };
    }),
    onToken: (length = 0) => set((s) => ({
      lastTokenAt: Date.now(), stalled: false,
      responseLength: s.responseLength + Math.max(0, length),
    })),
  }));
}
