// src/tui/state/status-store.ts
// 状态栏数据 store（zustand vanilla）
//
// 物理本质：footer 状态栏的「数据源」。
// 承载用户规格的字段：mode/model/dir/branch/contextPct。
// mode 随权限切换、contextPct 随 message_start 的 inputTokens 更新。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { StatusBarData } from '../types.js';

export interface StatusInit {
  mode: string;
  model: string;
  dir: string;
  branch: string;
}

export interface StatusState extends StatusBarData {
  /** 更新权限模式（plan/build/auto 切换） */
  setMode: (mode: string) => void;
  /** 更新上下文占用比例 [0,1]（来自 message_start.inputTokens / 200000） */
  setContextPct: (pct: number) => void;
}

export type StatusStore = StoreApi<StatusState>;

export function createStatusStore(init: StatusInit): StatusStore {
  return createStore<StatusState>((set) => ({
    mode: init.mode,
    model: init.model,
    dir: init.dir,
    branch: init.branch,
    contextPct: 0,

    setMode: (mode) => set({ mode }),
    setContextPct: (pct) => set({ contextPct: Math.max(0, Math.min(1, pct)) }),
  }));
}
