// src/tui/state/completion-store.ts
// 斜杠命令补全候选 store
//
// 物理本质：TAB 补全的「候选池 + 游标」。
// 用户输入 /pl 时，调用方算出 ['plan', 'provider', ...] 设进 candidates；
// 按 TAB 调 cycle() 在候选间循环；选中项写回 input-store 的 text。
//
// 设计：candidates 与 index 解耦——candidates 决定 visible，index 决定高亮哪一项。

import { createStore, type StoreApi } from 'zustand/vanilla';

export interface CompletionState {
  candidates: string[];
  /** 当前高亮的候选下标（0-based，cycle wrap） */
  index: number;
  /** 是否显示候选条 */
  visible: boolean;
  /** 设置候选（非空→visible=true 并 index=0；空→visible=false） */
  setCandidates: (c: string[]) => void;
  /** 推进 index（wrap） */
  cycle: () => void;
  /** 隐藏并重置 index */
  hide: () => void;
  /** 当前选中的候选名；无候选返回 null */
  selected: () => string | null;
}

export type CompletionStore = StoreApi<CompletionState>;

export function createCompletionStore(): CompletionStore {
  return createStore<CompletionState>((set, get) => ({
    candidates: [],
    index: 0,
    visible: false,

    setCandidates: (c) => set({
      candidates: c,
      visible: c.length > 0,
      index: 0,
    }),
    cycle: () => set((s) => {
      if (s.candidates.length === 0) return s;
      return { index: (s.index + 1) % s.candidates.length };
    }),
    hide: () => set({ visible: false, index: 0 }),
    selected: () => {
      const s = get();
      return s.candidates[s.index] ?? null;
    },
  }));
}
