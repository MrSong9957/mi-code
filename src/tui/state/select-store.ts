// src/tui/state/select-store.ts
// 交互式选择器 store(通用组件,可复用给 /model /theme /provider 等)
//
// 物理本质:选择列表的「候选池 + 游标」(与 completion-store 对称)。
// open(title, options) 打开选择界面;↑↓ cycle/cyclePrev 循环选择;
// Enter 确认(调用方从 selected() 取值);Esc close 取消。

import { createStore, type StoreApi } from 'zustand/vanilla';

/** 选择器选项(对标 Claude Code SelectOption) */
export interface SelectOption {
  /** 选项值,如 'gpt-4o' */
  value: string;
  /** 显示名,如 'GPT-4o' */
  label: string;
  /** 描述,如 'OpenAI flagship' */
  description?: string;
}

export interface SelectState {
  /** 是否显示选择界面 */
  visible: boolean;
  /** 标题,如 'Select model' */
  title: string;
  /** 选项列表 */
  options: SelectOption[];
  /** 当前高亮下标(0-based, cycle wrap) */
  index: number;
  /** 打开选择界面,onConfirm 在 Enter 时调用(传选中项) */
  open: (title: string, options: SelectOption[], onConfirm?: (opt: SelectOption) => void) => void;
  /** 关闭(清空状态) */
  close: () => void;
  /** 确认当前选中项(Enter):调 onConfirm 回调后关闭 */
  confirm: () => void;
  /** 向下循环 */
  cycle: () => void;
  /** 向上循环 */
  cyclePrev: () => void;
  /** 当前选中项;无选项返回 null */
  selected: () => SelectOption | null;
}

export type SelectStore = StoreApi<SelectState>;

export function createSelectStore(): SelectStore {
  // onConfirm 回调(非状态,模块级存储)
  let onConfirmCb: ((opt: SelectOption) => void) | null = null;

  return createStore<SelectState>((set, get) => ({
    visible: false,
    title: '',
    options: [],
    index: 0,

    open: (title, options, onConfirm) => {
      onConfirmCb = onConfirm ?? null;
      set({ visible: true, title, options, index: 0 });
    },
    close: () => {
      onConfirmCb = null;
      set({ visible: false, title: '', options: [], index: 0 });
    },
    confirm: () => {
      const opt = get().selected();
      const cb = onConfirmCb;
      set({ visible: false, title: '', options: [], index: 0 });
      onConfirmCb = null;
      if (opt && cb) cb(opt);
    },
    cycle: () => set((s) => {
      if (s.options.length === 0) return s;
      return { index: (s.index + 1) % s.options.length };
    }),
    cyclePrev: () => set((s) => {
      if (s.options.length === 0) return s;
      return { index: (s.index - 1 + s.options.length) % s.options.length };
    }),
    selected: () => {
      const s = get();
      return s.options[s.index] ?? null;
    },
  }));
}
