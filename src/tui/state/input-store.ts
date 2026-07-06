// src/tui/state/input-store.ts
// 输入态 store（zustand vanilla store，可被 React useStore 订阅 + 测试直接 getState）
//
// 物理本质：单行文本编辑器的「状态机」。
// 维护 text + cursor（光标字符偏移，0-based，[0, text.length]），
// 提供 insert/backspace/delete/move/submit 原语。
// 键事件（useInput）→ 这些原语 → store 更新 → App 重渲染 footer 输入框。
//
// 本期：单行编辑（多行/Ctrl+J 留 Phase 7）。submit 时 trim 后回调 onSubmit，
// 并清空（对齐旧 index.ts:572 的 userInput = input.trim() 行为）。

import { createStore, type StoreApi } from 'zustand/vanilla';

export type InputStore = StoreApi<InputState>;

export interface InputState {
  text: string;
  cursor: number;
  /** 在光标处插入字符串，光标前移 str.length */
  insert: (str: string) => void;
  /** 删光标前一字符（Backspace），光标后移；光标=0 时无操作 */
  backspace: () => void;
  /** 删光标处字符（Delete），光标不动 */
  deleteForward: () => void;
  /** 光标左移一格（钳位 0） */
  moveCursorLeft: () => void;
  /** 光标右移一格（钳位 text.length） */
  moveCursorRight: () => void;
  /** 光标移到绝对位置（钳位 [0, text.length]） */
  moveCursorTo: (pos: number) => void;
  /** 光标到最前 */
  moveCursorToStart: () => void;
  /** 光标到最后 */
  moveCursorToEnd: () => void;
  /** 清空文本，光标归 0 */
  clear: () => void;
  /** 整串替换文本（补全用），光标移到末尾 */
  setText: (text: string) => void;
  /** 在光标处插入换行（≤3 行上限，超出无操作） */
  insertNewline: () => void;
  /** 光标上移一行（保留列，钳到上行长度；第 0 行无操作） */
  moveCursorUp: () => void;
  /** 光标下移一行（保留列，钳到下行长度；末行无操作） */
  moveCursorDown: () => void;
  /** 提交：trim 后调 onSubmit，清空；空文本返回 null 不触发 */
  submit: () => string | null;
}

export interface InputStoreOptions {
  onSubmit?: (text: string) => void;
}

export function createInputStore(opts: InputStoreOptions = {}): InputStore {
  const onSubmit = opts.onSubmit;
  return createStore<InputState>((set, get) => ({
    text: '',
    cursor: 0,

    insert: (str) => set((s) => {
      const { text, cursor } = s;
      const next = text.slice(0, cursor) + str + text.slice(cursor);
      return { text: next, cursor: cursor + [...str].length };
    }),

    backspace: () => set((s) => {
      if (s.cursor <= 0) return s;
      const chars = [...s.text];
      chars.splice(s.cursor - 1, 1);
      return { text: chars.join(''), cursor: s.cursor - 1 };
    }),

    deleteForward: () => set((s) => {
      if (s.cursor >= [...s.text].length) return s;
      const chars = [...s.text];
      chars.splice(s.cursor, 1);
      return { text: chars.join(''), cursor: s.cursor };
    }),

    moveCursorLeft: () => set((s) => ({ cursor: Math.max(0, s.cursor - 1) })),
    moveCursorRight: () => set((s) => ({ cursor: Math.min([...s.text].length, s.cursor + 1) })),
    moveCursorTo: (pos) => set((s) => ({ cursor: Math.max(0, Math.min([...s.text].length, pos)) })),
    moveCursorToStart: () => set({ cursor: 0 }),
    moveCursorToEnd: () => set((s) => ({ cursor: [...s.text].length })),
    clear: () => set({ text: '', cursor: 0 }),
    setText: (text) => set({ text, cursor: [...text].length }),
    insertNewline: () => set((s) => {
      const lineCount = s.text.split('\n').length;
      if (lineCount >= 3) return s; // 上限 3 行
      const { text, cursor } = s;
      const next = text.slice(0, cursor) + '\n' + text.slice(cursor);
      return { text: next, cursor: cursor + 1 };
    }),
    moveCursorUp: () => set((s) => {
      const lines = s.text.split('\n');
      let offset = 0;
      for (let li = 0; li < lines.length; li++) {
        const lineLen = [...lines[li]!].length;
        if (s.cursor <= offset + lineLen) {
          if (li === 0) return s; // 已在第 0 行
          const col = s.cursor - offset;
          const prevLineLen = [...lines[li - 1]!].length;
          const prevOffset = offset - prevLineLen - 1;
          return { cursor: prevOffset + Math.min(col, prevLineLen) };
        }
        offset += lineLen + 1;
      }
      return s;
    }),
    moveCursorDown: () => set((s) => {
      const lines = s.text.split('\n');
      let offset = 0;
      for (let li = 0; li < lines.length; li++) {
        const lineLen = [...lines[li]!].length;
        if (s.cursor <= offset + lineLen) {
          if (li === lines.length - 1) return s; // 已在末行
          const col = s.cursor - offset;
          const nextOffset = offset + lineLen + 1;
          const nextLineLen = [...lines[li + 1]!].length;
          return { cursor: nextOffset + Math.min(col, nextLineLen) };
        }
        offset += lineLen + 1;
      }
      return s;
    }),

    submit: () => {
      const trimmed = get().text.trim();
      if (trimmed === '') return null;
      onSubmit?.(trimmed);
      set({ text: '', cursor: 0 });
      return trimmed;
    },
  }));
}
