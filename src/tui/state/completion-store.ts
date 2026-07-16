// src/tui/state/completion-store.ts
// 斜杠命令补全候选 store
//
// 物理本质：下拉菜单的「候选池 + 游标」。
// 用户输入 / 时，调用 filter('') 显示全部命令；
// 继续输入 /th 时，filter('th') 实时过滤；
// 上下箭头 cycle/cyclePrev 循环选择；Enter 写回 input。
//
// candidates 存 SuggestionItem(含描述/参数/分组),selected() 返回命令名字符串。

import { createStore, type StoreApi } from 'zustand/vanilla';
import Fuse from 'fuse.js';
import { COMMAND_SUGGESTIONS, type SuggestionItem } from '../../commands/suggestion-data.js';

/** Fuse 模糊搜索实例(命令名高权重 + 描述低权重) */
const fuse = new Fuse([...COMMAND_SUGGESTIONS], {
  threshold: 0.3,
  location: 0,
  distance: 100,
  keys: [
    { name: 'name', weight: 3 },
    { name: 'description', weight: 0.5 },
  ],
});

export interface CompletionState {
  candidates: SuggestionItem[];
  /** 当前高亮的候选下标（0-based，cycle wrap） */
  index: number;
  /** 是否显示候选条 */
  visible: boolean;
  /** 设置候选（非空→visible=true 并 index=0；空→visible=false） */
  setCandidates: (c: SuggestionItem[]) => void;
  /** 按前缀过滤命令（前缀优先,无前缀匹配时模糊搜索兜底） */
  filter: (prefix: string) => void;
  /** 推进 index（向下循环） */
  cycle: () => void;
  /** 回退 index（向上循环） */
  cyclePrev: () => void;
  /** 隐藏并重置 index */
  hide: () => void;
  /** 当前选中的候选名(字符串);无候选返回 null */
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
      if (!prefix) {
        // 空前缀:显示全部
        set({ candidates: [...COMMAND_SUGGESTIONS], index: 0, visible: true });
        return;
      }
      const lower = prefix.toLowerCase();
      // 1. 前缀匹配(优先)
      const prefixMatches = COMMAND_SUGGESTIONS.filter(s => s.name.startsWith(lower));
      if (prefixMatches.length > 0) {
        set({ candidates: prefixMatches, index: 0, visible: true });
        return;
      }
      // 2. 模糊搜索兜底
      const fuseResults = fuse.search(lower);
      set({
        candidates: fuseResults.map(r => r.item),
        index: 0,
        visible: fuseResults.length > 0,
      });
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
      return s.candidates[s.index]?.name ?? null;
    },
  }));
}
