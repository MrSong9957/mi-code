// src/tui/state/clear-screen-store.ts
//
// 物理本质:计划批准后清屏(auto+clear 模式)的信号通道。
// applyPlanApproval(clearContext=true) 调 triggerClearScreen() 自增 tick,
// ConnectedApp 订阅 tick 变化 → 执行清屏 ANSI + 重挂载 <InlineAppV2>(与 resize 路径复用)。
// 这条通道让 agent 层(index.ts)能在不直接持有 React 引用的前提下触发 UI 侧清屏。

import { createStore } from 'zustand/vanilla';

export interface ClearScreenState {
  /** 递增计数器:每次 triggerClearScreen 自增,ConnectedApp 订阅变化执行清屏 */
  tick: number;
  triggerClearScreen: () => void;
}

export function createClearScreenStore() {
  return createStore<ClearScreenState>((set) => ({
    tick: 0,
    triggerClearScreen: () => set((state) => ({ tick: state.tick + 1 })),
  }));
}

export type ClearScreenStore = ReturnType<typeof createClearScreenStore>;
