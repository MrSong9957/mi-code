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

/** Paste 范围。半开区间 [start, end)，code point offset（与 cursor 同坐标系）。 */
interface PasteRange {
  start: number;
  end: number;
}

/**
 * code-point 坐标下的文本替换：把 text 的 [start, end) 替换为 inserted。
 * start/end/插入长度全部按 Unicode code point 计数（与 cursor 同坐标系）。
 *
 * 实现：[...text] 把字符串拆成 code point 数组（BMP=1 元素，非 BMP=1 元素，
 * 不拆 UTF-16 surrogate pair），Array.splice 的 deleteCount/插入项按数组元素计，
 * join('') 重组。保证 start/end 直接对应 cursor 偏移。模块私有。
 */
function spliceCodePoints(text: string, start: number, end: number, inserted: string): string {
  const chars = [...text];
  chars.splice(start, end - start, inserted);
  return chars.join('');
}

/**
 * 一次文本编辑后同步 paste ranges。模块私有。
 *
 * 编辑语义：把 [editStart, editStart+deletedLen) 替换为长度 insertedLen 的新内容。
 * 三规则（等价于"被删 range 视角"，见 spec §6）：
 *   - editEnd <= r.start（编辑完全在 range 前方）→ 右移 delta = insertedLen - deletedLen
 *   - editStart >= r.end（编辑完全在 range 后方，含紧贴 end 插入）→ 不变
 *   - 否则（触及 range 内容）→ 丢弃该 range
 *
 * code-point 坐标，与 spliceCodePoints / cursor 同坐标系。
 */
function reconcileRanges(
  ranges: PasteRange[],
  editStart: number,
  deletedLen: number,
  insertedLen: number,
): PasteRange[] {
  const editEnd = editStart + deletedLen;
  const delta = insertedLen - deletedLen;
  const next: PasteRange[] = [];
  for (const r of ranges) {
    if (editEnd <= r.start) next.push({ start: r.start + delta, end: r.end + delta });
    else if (editStart >= r.end) next.push(r);
    // 否则触及 range 内容 → 丢弃（不 push）
  }
  return next;
}

export type InputStore = StoreApi<InputState>;

export interface InputState {
  text: string;
  cursor: number;
  /** 来自一次 paste 的区段（半开 [start,end)，code point offset）。光标进入或局部编辑后退化为空。 */
  pasteRanges: PasteRange[];
  /** 在光标处插入字符串，光标前移 str.length */
  insert: (str: string) => void;
  /** 在光标处插入来自一次 paste 的字符串，光标前移，并记录该段为 paste range（仅 ConnectedApp.usePaste 调用）。 */
  insertPaste: (str: string) => void;
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
  /** 在光标处插入换行（任意行数，超出 MAX_VISIBLE_INPUT_LINES 由视口滚动处理） */
  insertNewline: () => void;
  /** 光标上移一行（保留列，钳到上行长度；第 0 行无操作） */
  moveCursorUp: () => void;
  /** 光标下移一行（保留列，钳到下行长度；末行无操作） */
  moveCursorDown: () => void;
  /** 删光标到行首；光标已在行首时删整行（含前导 \n），光标移到上一行末尾。连续调用可逐行删到全空 */
  deleteToLineStart: () => void;
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
    pasteRanges: [],

    insert: (str) => set((s) => {
      const insertedLen = [...str].length;
      const next = spliceCodePoints(s.text, s.cursor, s.cursor, str);
      return {
        text: next,
        cursor: s.cursor + insertedLen,
        pasteRanges: reconcileRanges(s.pasteRanges, s.cursor, 0, insertedLen),
      };
    }),

    insertPaste: (str) => set((s) => {
      const insertedLen = [...str].length;
      if (insertedLen === 0) return s; // 空 paste 不创建 range
      const next = spliceCodePoints(s.text, s.cursor, s.cursor, str);
      return {
        text: next,
        cursor: s.cursor + insertedLen,
        pasteRanges: [
          ...reconcileRanges(s.pasteRanges, s.cursor, 0, insertedLen),
          { start: s.cursor, end: s.cursor + insertedLen },
        ],
      };
    }),

    backspace: () => set((s) => {
      if (s.cursor <= 0) return s;
      // 命中：光标恰在某次 paste 末尾 → 整段删该 range
      const hit = s.pasteRanges.find((r) => r.end === s.cursor);
      if (hit !== undefined) {
        const deletedLen = hit.end - hit.start;
        const next = spliceCodePoints(s.text, hit.start, hit.end, '');
        return {
          text: next,
          cursor: hit.start,
          // 移除 hit 后对其余 ranges 同步：被删区间 [hit.start, hit.end)
          pasteRanges: reconcileRanges(
            s.pasteRanges.filter((r) => r !== hit),
            hit.start,
            deletedLen,
            0,
          ),
        };
      }
      // 普通：删光标前一 code point（spliceCodePoints 保证坐标一致）
      const prev = s.cursor - 1;
      const next = spliceCodePoints(s.text, prev, s.cursor, '');
      return {
        text: next,
        cursor: prev,
        pasteRanges: reconcileRanges(s.pasteRanges, prev, 1, 0),
      };
    }),

    deleteForward: () => set((s) => {
      if (s.cursor >= [...s.text].length) return s;
      const next = spliceCodePoints(s.text, s.cursor, s.cursor + 1, '');
      return {
        text: next,
        cursor: s.cursor,
        pasteRanges: reconcileRanges(s.pasteRanges, s.cursor, 1, 0),
      };
    }),

    moveCursorLeft: () => set((s) => ({ cursor: Math.max(0, s.cursor - 1) })),
    moveCursorRight: () => set((s) => ({ cursor: Math.min([...s.text].length, s.cursor + 1) })),
    moveCursorTo: (pos) => set((s) => ({ cursor: Math.max(0, Math.min([...s.text].length, pos)) })),
    moveCursorToStart: () => set({ cursor: 0 }),
    moveCursorToEnd: () => set((s) => ({ cursor: [...s.text].length })),
    clear: () => set({ text: '', cursor: 0, pasteRanges: [] }),
    setText: (text) => set({ text, cursor: [...text].length, pasteRanges: [] }),
    insertNewline: () => set((s) => {
      const next = spliceCodePoints(s.text, s.cursor, s.cursor, '\n');
      return {
        text: next,
        cursor: s.cursor + 1,
        pasteRanges: reconcileRanges(s.pasteRanges, s.cursor, 0, 1),
      };
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

    deleteToLineStart: () => set((s) => {
      // Unix 行编辑语义（Ctrl+U）：删光标到行首；光标已在行首时删整行（含前导 \n）。
      // 保持当前实现的既有用户语义不变，仅做两类一致性修复：
      //   (1) 坐标：UTF-16 slice/indexOf → code-point 坐标（[...text] + spliceCodePoints）
      //   (2) range 同步：所有分支加 reconcileRanges，并用
      //       delEnd = 有下一\n ? lineEnd+1 : chars.length
      //       统一删除终点，修复"最后一行 lineEnd+1 > chars.length 导致实际删除长度
      //       与 reconcileRanges deletedLen 不一致"的 off-by-one。
      const chars = [...s.text];
      // 在 cursor 之前的 code points 里找最后一个 \n
      let lastNl = -1;
      for (let i = 0; i < s.cursor; i++) {
        if (chars[i] === '\n') lastNl = i;
      }
      const lineStart = lastNl + 1; // lastNl=-1 时 lineStart=0（首行行首）

      if (lineStart < s.cursor) {
        // 光标不在行首：删 [lineStart, cursor) 区间（光标前到行首）
        const deletedLen = s.cursor - lineStart;
        const next = spliceCodePoints(s.text, lineStart, s.cursor, '');
        return {
          text: next,
          cursor: lineStart,
          pasteRanges: reconcileRanges(s.pasteRanges, lineStart, deletedLen, 0),
        };
      }
      // 光标已在行首：找本行的结尾（下一个 \n 或文本末尾）
      let nextNlInRest = -1;
      for (let i = s.cursor; i < chars.length; i++) {
        if (chars[i] === '\n') { nextNlInRest = i; break; }
      }
      const lineEnd = nextNlInRest === -1 ? chars.length : nextNlInRest;
      // 统一删除终点：有下一 \n 时多删一个 \n（保持现有语义），无下一 \n 时到文本末尾
      const delEnd = nextNlInRest === -1 ? chars.length : lineEnd + 1;
      if (s.cursor === 0) {
        // 首行行首：删 [0, delEnd)（首行内容，有下一\n 时含它的 \n）
        if (nextNlInRest === -1) {
          // 整段就是一行：全删
          return {
            text: '',
            cursor: 0,
            pasteRanges: reconcileRanges(s.pasteRanges, 0, chars.length, 0),
          };
        }
        const next = spliceCodePoints(s.text, 0, delEnd, '');
        return {
          text: next,
          cursor: 0,
          pasteRanges: reconcileRanges(s.pasteRanges, 0, delEnd, 0),
        };
      }
      // 非首行行首：删 [lastNl, delEnd)（前导 \n + 本行内容，有下一\n 时含 lineEnd 处的 \n），
      // 光标移到 lastNl（上一行末尾位置）
      const next = spliceCodePoints(s.text, lastNl, delEnd, '');
      return {
        text: next,
        cursor: lastNl,
        pasteRanges: reconcileRanges(s.pasteRanges, lastNl, delEnd - lastNl, 0),
      };
    }),

    submit: () => {
      const trimmed = get().text.trim();
      if (trimmed === '') return null;
      onSubmit?.(trimmed);
      set({ text: '', cursor: 0, pasteRanges: [] });
      return trimmed;
    },
  }));
}
