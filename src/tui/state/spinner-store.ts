// src/tui/state/spinner-store.ts
// Spinner 数据 store（zustand vanilla）
//
// 改造后（对标 Claude Code 四套动画）：
// - 单时间戳 time（tick +TICK_MS），各动画在渲染层用 floor(time/period) 派生帧
//   （符号 120ms、点 300ms、shimmer 200ms、thinking sine 2s 周期）
// - mode（thinking/generating/tool）决定配色，verb（随机 -ing 动词）决定文字
// - label 用于工具模式覆盖显示文字（如 "Running Bash"）
// - SPINNER_FRAMES 换 Claude Code 序列 ['·','✢','✳','✶','✻','✽'] + 反向

import { createStore, type StoreApi } from 'zustand/vanilla';
import { sampleVerb } from './spinner-verbs.js';

/** Claude Code 符号序列：6 帧 + 反向 = 12 帧（一轮 1440ms @ 120ms/帧） */
export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'] as const;

/** tick 步进（ms）。50ms 高频，各动画按 floor(time/period) 派生（对标 useAnimationFrame(50)） */
export const TICK_MS = 50;

/** 无 token 多久判 stall（ms） */
const STALL_MS = 3000;

export type SpinnerMode = 'thinking' | 'generating' | 'tool';

export interface SpinnerState {
  active: boolean;
  /** 动画累计时间（ms），tick 时 +TICK_MS。start 时重置 0 */
  time: number;
  /** 当前模式（决定配色：thinking 灰系呼吸 / generating 主题色 / tool 主题色） */
  mode: SpinnerMode;
  /** 随机动词（start 时选定，整个 turn 不变） */
  verb: string;
  /** 工具模式覆盖文字（如 "Running Bash"）；空则用 verb */
  label: string;
  /** thinking 开始时刻（Date.now()）；非 thinking 模式为 null。
   *  渲染层用 (time) 算 sine 呼吸（前 3s opacity=0，对标 THINKING_DELAY_MS） */
  thinkStartTime: number | null;
  stalled: boolean;
  /** 最近一次收到 token 的时间戳（Date.now()） */
  lastTokenAt: number;
  start: (mode: SpinnerMode) => void;
  stop: () => void;
  setMode: (mode: SpinnerMode) => void;
  /** 工具模式覆盖显示文字（如 "Running Bash"）；空字符串清回 verb */
  setLabel: (label: string) => void;
  /** 推进动画时钟（TICK_MS 一次）；inactive 时 no-op；顺带判 stall */
  tick: () => void;
  /** 收到 token：刷新 lastTokenAt，清 stalled */
  onToken: () => void;
}

export type SpinnerStore = StoreApi<SpinnerState>;

export function createSpinnerStore(): SpinnerStore {
  return createStore<SpinnerState>((set) => ({
    active: false,
    time: 0,
    mode: 'generating',
    verb: '',
    label: '',
    thinkStartTime: null,
    stalled: false,
    lastTokenAt: 0,

    start: (mode) => set({
      active: true,
      time: 0,
      mode,
      verb: sampleVerb(),
      label: '',
      thinkStartTime: mode === 'thinking' ? Date.now() : null,
      stalled: false,
      lastTokenAt: Date.now(),
    }),
    stop: () => set({
      active: false, time: 0, verb: '', label: '',
      thinkStartTime: null, stalled: false,
    }),
    setMode: (mode) => set((s) => ({
      mode,
      thinkStartTime: mode === 'thinking' ? Date.now() : null,
      // 切到非 tool 模式清 label（回到 verb 显示）
      label: mode === 'tool' ? s.label : '',
    })),
    setLabel: (label) => set({ label }),
    tick: () => set((s) => {
      if (!s.active) return s;
      const stalled = Date.now() - s.lastTokenAt > STALL_MS;
      return { time: s.time + TICK_MS, stalled };
    }),
    onToken: () => set({ lastTokenAt: Date.now(), stalled: false }),
  }));
}
