// src/tui/state/status-store.ts
// 状态栏 + spinner + hint 的统一状态（zustand vanilla）
//
// 物理本质：footer 状态栏的「仪表盘数据源」。
// 替代旧 Renderer 的 setStatus/setHint/startSpinner/setSpinnerLabel/stopSpinner 五个方法——
// 它们散落旧代码各处（index.ts ~15 个调用点），本 store 收敛成一个状态对象，
// App 订阅它渲染 Footer 的 StatusBar。
//
// 字段（对齐 StatusBarData）：
// - mode/model/branch/dir/contextUsage：静态/半静态状态栏字段
// - toolStatus：当前运行中的工具（spinner 显示），undefined = 空闲
// - hint：提示文本（翻页/权限/todo），undefined = 无提示

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { StatusBarData } from '../types.js';

export interface StatusInit {
  mode: string;
  model: string;
  branch: string;
  dir: string;
  contextUsage: number;
}

export interface StatusState extends StatusBarData {
  setStatus: (partial: Partial<Pick<StatusBarData, 'mode' | 'model' | 'branch' | 'dir' | 'contextUsage'>>) => void;
  startSpinner: (label: string) => void;
  setSpinnerLabel: (label: string) => void;
  stopSpinner: () => void;
  setHint: (hint: string | undefined) => void;
  setContextUsage: (usage: number) => void;
}

export type StatusStore = StoreApi<StatusState>;

export function createStatusStore(init: StatusInit): StatusStore {
  return createStore<StatusState>((set) => ({
    mode: init.mode,
    model: init.model,
    branch: init.branch,
    dir: init.dir,
    contextUsage: init.contextUsage,
    toolStatus: undefined,
    hint: undefined,

    setStatus: (partial) => set(partial),

    startSpinner: (label) => set({ toolStatus: { name: label, status: 'running' } }),

    setSpinnerLabel: (label) => set((s) => {
      if (!s.toolStatus) return s;
      return { toolStatus: { name: label, status: s.toolStatus.status } };
    }),

    stopSpinner: () => set({ toolStatus: undefined }),

    setHint: (hint) => set({ hint }),

    setContextUsage: (usage) => set({ contextUsage: usage }),
  }));
}
