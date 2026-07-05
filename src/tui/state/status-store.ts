// src/tui/state/status-store.ts
// 状态栏 tokens + elapsed 状态（zustand vanilla，charter §顶层布局 L89）
//
// 物理本质：footer 状态栏的「计数器」。
// 只承载 charter 规定的两个字段：本次 turn 的累计输出 token + 已耗时秒数。
// mode/model/branch/dir 等静态信息不在状态栏，移至 LogoData（固定 LOGO 区）。
//
// 数据源：
// - tokenCount：index.ts agent loop 捕获 message_delta.outputTokens → setTokens
// - elapsedSec：index.ts handleUserSubmit 起 setInterval 每秒 → setElapsed

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { StatusBarData } from '../types.js';

export interface StatusState extends StatusBarData {
  /** 更新 token 计数（上游传累计值，store 直接覆盖） */
  setTokens: (n: number) => void;
  /** 更新已耗时（秒） */
  setElapsed: (sec: number) => void;
  /** 新 turn 开始时清零（tokenCount + elapsedSec 归 0） */
  resetTurn: () => void;
}

export type StatusStore = StoreApi<StatusState>;

export function createStatusStore(): StatusStore {
  return createStore<StatusState>((set) => ({
    tokenCount: 0,
    elapsedSec: 0,

    setTokens: (n) => set({ tokenCount: n }),
    setElapsed: (sec) => set({ elapsedSec: sec }),
    resetTurn: () => set({ tokenCount: 0, elapsedSec: 0 }),
  }));
}
