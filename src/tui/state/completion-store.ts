// src/tui/state/completion-store.ts
// 斜杠命令补全候选 store
//
// 物理本质：下拉菜单的「候选池 + 游标」。
// 用户输入 / 时，调用 filter('') 显示全部命令；
// 继续输入 /th 时，filter('th') 实时过滤；
// 上下箭头 cycle/cyclePrev 循环选择；Enter 写回 input。

import { createStore, type StoreApi } from 'zustand/vanilla';
import { COMMAND_NAMES } from '../../commands/executor.js';

export interface CompletionState {
  candidates: string[];
  /** 当前高亮的候选下标（0-based，cycle wrap） */
  index: number;
  /** 是否显示候选条 */
  visible: boolean;
  /** 设置候选（非空→visible=true 并 index=0；空→visible=false） */
  setCandidates: (c: string[]) => void;
  /** 按前缀过滤命令（实时过滤） */
  filter: (prefix: string) => void;
  /** 推进 index（向下循环） */
  cycle: () => void;
  /** 回退 index（向上循环） */
  cyclePrev: () => void;
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
    filter: (prefix) => {
      const filtered = COMMAND_NAMES.filter(n => n.startsWith(prefix));
      if (filtered.length > 0) {
        set({ candidates: filtered, index: 0, visible: true });
      } else {
        set({ candidates: [], visible: false, index: 0 });
      }
    },
    cycle: () => set((s) => {
      if (s.candidates.length === 0) return s;
      return { index: (s.index + 1) % s.candidates.length };
    }),
    cyclePrev: () => set((s) => {
      if (s.candidates.length === 0) return s;
      return { index: (s.index - 1 + s.candidates.length) % s.candidates.length };
    }),
    hide: () => set({ visible: false, index: 0 }),
    selected: () => {
      const s = get();
      return s.candidates[s.index] ?? null;
    },
  }));
}
