# Paste-as-Backspace-Unit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次粘贴进输入框的整段文本，光标停在其末尾时按一次 Backspace 删除整段；普通逐键输入仍逐字符删除。

**Architecture:** 在 `InputState`（`text: string + cursor: number`）上附加 `pasteRanges: PasteRange[]` 元数据。`cursor` 与 ranges 统一为 code-point offset。新增模块私有 `spliceCodePoints` 让所有维护 range 的文本原语在 code-point 坐标执行实际删除/替换；新增模块私有 `reconcileRanges` 统一同步 ranges；新增专用 `insertPaste(str)` 原语（仅 paste 通道调用）。渲染层/提交链路/submit-transformer/paste-handler 占位符逻辑零改动。

**Tech Stack:** TypeScript (ESM, target ES2022, strict), Zustand vanilla store, Vitest。

**Spec:** `docs/superpowers/specs/2026-08-07-paste-backspace-design.md`（已批准，commit `52efdb4`）。

**测试执行约定（来自 AGENTS.md）：**
- L1 当前测试：`npx vitest run src/__tests__/tui/input-store.test.ts`
- L2 影响模块：`npx vitest run src/__tests__/tui/`
- L3 全量回归：`npm test`

---

## 文件结构

| 文件 | 责任 | 改动性质 |
|---|---|---|
| `src/tui/state/input-store.ts` | 输入态 store + 所有文本原语 + range 同步 | 修改（核心） |
| `src/tui/ConnectedApp.tsx:236` | usePaste 回调 | 修改（1 行） |
| `src/tui/input/use-input-handler.ts` | 键盘分发 | **不动** |
| `src/__tests__/tui/input-store.test.ts` | 行为测试 | 修改（新增测试） |

**零改动确认**：渲染层、提交链路、submit-transformer、paste-handler 占位符、ask-question store、4 处 setText 调用方、5 处只读 `.text` 判断。

---

## Task 1: 私有 `spliceCodePoints` helper（TDD 基础设施）

**目标**：先建立 code-point 坐标的文本替换原语，作为后续所有 range 维护原语的统一执行点。此 helper 不导出，通过 input-store 的行为测试间接覆盖；但本任务先用临时导出 + 临时单测验证它自身正确，Task 2 起去掉导出与临时测试，转为行为测试覆盖。

**Files:**
- Modify: `src/tui/state/input-store.ts`（文件顶部，在 `createInputStore` 之前）
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试（临时导出 + 临时单测）**

在 `src/__tests__/tui/input-store.test.ts` 末尾追加：

```ts
import { spliceCodePoints } from '../../tui/state/input-store.js';

describe('spliceCodePoints（code-point 坐标文本替换，模块私有 helper）', () => {
  it('BMP 区：在中间插入', () => {
    expect(spliceCodePoints('abcd', 1, 1, 'XY')).toBe('aXYcd'); // 删 b 插 XY
  });
  it('BMP 区：删除区间', () => {
    expect(spliceCodePoints('abcdef', 1, 4, '')).toBe('aef'); // 删 [1,4) = bcd
  });
  it('非 BMP：surrogate pair 不被拆开', () => {
    // 𝄞 = U+1D11E，1 code point / 2 UTF-16 unit
    expect(spliceCodePoints('𝄞', 0, 0, 'X')).toBe('X𝄞');
    expect(spliceCodePoints('X𝄞', 1, 1, '')).toBe('𝄞'); // 删 X，𝄞 完整
    expect(spliceCodePoints('𝄞X', 0, 1, '')).toBe('X'); // 删 𝄞（1 code point），X 完整
  });
  it('非 BMP + BMP 混合：start/end 按 code point 偏移', () => {
    expect(spliceCodePoints('𝄞ab', 1, 2, 'Z')).toBe('𝄞Zb'); // 删 a 插 Z
  });
  it('空插入区间（纯插入）', () => {
    expect(spliceCodePoints('abc', 2, 2, 'Z')).toBe('abZc');
  });
  it('边界：start=0,end=0 前插', () => {
    expect(spliceCodePoints('abc', 0, 0, 'Z')).toBe('Zabc');
  });
  it('边界：删除到末尾', () => {
    expect(spliceCodePoints('abc', 1, 3, '')).toBe('a');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — `spliceCodePoints is not exported`（import 失败或函数不存在）。

- [ ] **Step 3: 实现 spliceCodePoints（临时导出）**

在 `src/tui/state/input-store.ts` 的 `import` 之后、`export type InputStore` 之前插入：

```ts
/**
 * code-point 坐标下的文本替换：把 text 的 [start, end) 替换为 inserted。
 * start/end/插入长度全部按 Unicode code point 计数（与 cursor 同坐标系）。
 *
 * 实现本质：[...text] 把字符串拆成 code point 数组（BMP=1 元素，非 BMP=1 元素，
 * 不会拆开 UTF-16 surrogate pair），Array.splice 的 deleteCount/插入项按数组元素计，
 * join('') 重组。这保证 start/end 直接对应 cursor 偏移。
 *
 * 临时导出仅用于本 Task 的单测；Task 2 起改为模块私有（去 export）。
 */
export function spliceCodePoints(text: string, start: number, end: number, inserted: string): string {
  const chars = [...text];
  chars.splice(start, end - start, inserted);
  return chars.join('');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS（新增 spliceCodePoints describe 块全绿，现有测试不回归）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task1): spliceCodePoints helper (code-point text replace)"
```

---

## Task 2: 私有 `reconcileRanges` + 类型定义 + 去 helper 导出

**目标**：定义 `PasteRange` 类型与 `InputState.pasteRanges` 字段；实现私有 `reconcileRanges` 并通过临时单测验证三规则；同时把 `spliceCodePoints` 改为模块私有（去 export），删除 Task 1 的临时 spliceCodePoints 单测。

**Files:**
- Modify: `src/tui/state/input-store.ts`
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 改写测试 —— 删除 spliceCodePoints 临时单测，加 reconcileRanges 临时单测**

把 Task 1 追加的 `import { spliceCodePoints } ...` 整个 describe 块**删除**。
在文件末尾追加（用临时 export 验证）：

```ts
import { reconcileRanges, type PasteRange } from '../../tui/state/input-store.js';

describe('reconcileRanges（range 同步三规则，模块私有，临时导出验证）', () => {
  const R = (s: number, e: number): PasteRange => ({ start: s, end: e });

  it('规则1：编辑完全在 range 前方（editEnd <= r.start）→ range 右移 delta', () => {
    // 删 [0,2) 插入长度 4 → delta=+2；range {5,8} 在前方
    expect(reconcileRanges([R(5, 8)], 0, 2, 4)).toEqual([R(7, 10)]);
  });
  it('规则2：编辑完全在 range 后方（editStart >= r.end，含 ==）→ 不变', () => {
    // 紧贴 end 插入：editStart=6 == r.end=6
    expect(reconcileRanges([R(3, 6)], 6, 0, 1)).toEqual([R(3, 6)]);
    // 编辑在后方
    expect(reconcileRanges([R(3, 6)], 7, 1, 2)).toEqual([R(3, 6)]);
  });
  it('规则3（触及-前方边界）：编辑结尾正好在 range.start（editEnd == r.start）→ 走规则1 平移', () => {
    // editEnd=5 == r.start=5：编辑在前方，range 右移 delta
    expect(reconcileRanges([R(5, 8)], 3, 2, 4)).toEqual([R(7, 10)]); // delta +2
  });
  it('规则3（触及-后方边界）：编辑开始正好在 range.end（editStart == r.end）→ 走规则2 不变', () => {
    expect(reconcileRanges([R(3, 6)], 6, 1, 1)).toEqual([R(3, 6)]); // delta 0
    expect(reconcileRanges([R(3, 6)], 6, 2, 1)).toEqual([R(3, 6)]); // 后方删，不变
  });
  it('规则3（触及-内部）：删除区间落在 range 内部 → 丢弃该 range', () => {
    // range {3,8}，删 [4,6)（在内部）
    expect(reconcileRanges([R(3, 8)], 4, 2, 0)).toEqual([]);
  });
  it('规则3（跨越）：删除区间跨越 range 边界 → 丢弃该 range', () => {
    // range {3,8}，删 [2,5)（跨左边界）
    expect(reconcileRanges([R(3, 8)], 2, 3, 0)).toEqual([]);
    // range {3,8}，删 [6,10)（跨右边界）
    expect(reconcileRanges([R(3, 8)], 6, 4, 0)).toEqual([]);
  });
  it('多 range：混合三规则', () => {
    // ranges [{0,3},{3,6},{10,15}]，删 [3,6) 插入长度 1（delta=-2）
    // {0,3}: editStart=3 >= end=3 → 不变
    // {3,6}: 触及内部 → 丢弃
    // {10,15}: editEnd=6 <= start=10 → 右移 -2 → {8,13}
    expect(reconcileRanges([R(0, 3), R(3, 6), R(10, 15)], 3, 3, 1)).toEqual([R(0, 3), R(8, 13)]);
  });
  it('空 ranges 输入 → 空输出', () => {
    expect(reconcileRanges([], 0, 0, 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — `reconcileRanges` / `PasteRange` 未导出。

- [ ] **Step 3: 实现 reconcileRanges + 类型定义；spliceCodePoints 去 export**

在 `src/tui/state/input-store.ts`：

3a. 在 `spliceCodePoints` 函数前加 `PasteRange` 类型，并把 `spliceCodePoints` 的 `export` 去掉：

```ts
/** Paste 范围。半开区间 [start, end)，code point offset（与 cursor 同坐标系）。 */
export interface PasteRange {
  start: number;
  end: number;
}

/** code-point 坐标下的文本替换（模块私有，Task 2 去掉导出）。 */
function spliceCodePoints(text: string, start: number, end: number, inserted: string): string {
  const chars = [...text];
  chars.splice(start, end - start, inserted);
  return chars.join('');
}
```

3b. 在 `spliceCodePoints` 之后插入 `reconcileRanges`（临时 export，Task 3 起去 export）：

```ts
/**
 * 一次文本编辑后同步 paste ranges。模块私有（临时导出仅本 Task 单测）。
 *
 * 编辑语义：把 [editStart, editStart+deletedLen) 替换为长度 insertedLen 的新内容。
 * 以"编辑"视角（等价于"被删 range 视角"，见 spec §6）：
 *   - editEnd <= r.start（编辑完全在 range 前方）→ 右移 delta = insertedLen - deletedLen
 *   - editStart >= r.end（编辑完全在 range 后方，含紧贴 end 插入）→ 不变
 *   - 否则（触及 range 内容）→ 丢弃该 range
 *
 * code-point 坐标，与 spliceCodePoints / cursor 同坐标系。
 */
export function reconcileRanges(
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS（新增 reconcileRanges describe 全绿；spliceCodePoints 临时单测已删除，现有测试不回归）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task2): PasteRange type + reconcileRanges (3 rules); unexport spliceCodePoints"
```

---

## Task 3: InputState 加 `pasteRanges` 字段 + 初始化 + clear/setText/submit 清空

**目标**：扩展 `InputState` 接口加 `pasteRanges: PasteRange[]`，store 初始值 `[]`，所有"整体清空文本"的原语（clear / setText / submit）同步清空 ranges。本任务**不**改 insert/backspace 等编辑原语（下一任务做）—— 因此本任务的测试只能验证初始值与清空路径。

**Files:**
- Modify: `src/tui/state/input-store.ts`
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试（仅覆盖初始化 + 清空路径）**

在 `src/__tests__/tui/input-store.test.ts` 末尾追加（在 reconcileRanges describe 之后）：

```ts
describe('input-store pasteRanges 字段（初始化 + 清空路径）', () => {
  it('初始：pasteRanges 为空数组', () => {
    const store = createInputStore();
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('clear：清空 text 同时清空 pasteRanges', () => {
    const store = createInputStore();
    // 暂时直接注入 range 验证 clear 清空（insertPaste 在 Task 4）
    store.setState({ pasteRanges: [{ start: 0, end: 3 }] });
    store.getState().clear();
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('setText：替换文本同时清空 pasteRanges', () => {
    const store = createInputStore();
    store.setState({ pasteRanges: [{ start: 0, end: 3 }] });
    store.getState().setText('/plan');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('submit：提交同时清空 pasteRanges', () => {
    const store = createInputStore({ onSubmit: () => {} });
    store.getState().insert('abc');
    store.setState({ pasteRanges: [{ start: 0, end: 3 }] });
    store.getState().submit();
    expect(store.getState().pasteRanges).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — `pasteRanges` 属性 undefined（`store.getState().pasteRanges` 不存在）；`setState({ pasteRanges })` 可能 TS 报错。

- [ ] **Step 3: 扩展 InputState 接口 + 初始值 + 清空路径**

在 `src/tui/state/input-store.ts`：

3a. `interface InputState` 内，在 `cursor: number;` 之后、`insert:` 之前加：

```ts
  /** 来自一次 paste 的区段（半开 [start,end)，code point offset）。光标进入或局部编辑后退化为空。 */
  pasteRanges: PasteRange[];
```

3b. `createInputStore` 的初始 state，在 `cursor: 0,` 之后加：

```ts
    pasteRanges: [],
```

3c. `clear` 原语（L86）：

```ts
    clear: () => set({ text: '', cursor: 0, pasteRanges: [] }),
```

3d. `setText` 原语（L87）：

```ts
    setText: (text) => set({ text, cursor: [...text].length, pasteRanges: [] }),
```

3e. `submit` 原语（L156）的 `set`：

```ts
      set({ text: '', cursor: 0, pasteRanges: [] });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task3): InputState.pasteRanges field + init + clear/setText/submit reset"
```

---

## Task 4: `insertPaste(str)` 新原语 + `insert` 内部同步 ranges + 实际删除走 spliceCodePoints

**目标**：新增专用 `insertPaste(str)`（push range）；`insert(str)` 签名不变但内部走 spliceCodePoints + reconcileRanges（手敲字符落在 range 内部 → 失效）；`insertNewline` 等同 `insert('\n')`。

这是 paste range 的**创建路径**，也建立"手敲不破坏 range / 手敲进内部破坏 range"的契约。

**Files:**
- Modify: `src/tui/state/input-store.ts`
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/tui/input-store.test.ts` 末尾追加：

```ts
describe('insertPaste / insert（range 创建与手敲同步）', () => {
  it('insertPaste：在光标处插入并创建 range', () => {
    const store = createInputStore();
    store.getState().insertPaste('ABC');
    expect(store.getState().text).toBe('ABC');
    expect(store.getState().cursor).toBe(3);
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('insertPaste 在已有文本后方：range 起点是当前 cursor', () => {
    const store = createInputStore();
    store.getState().insert('xx');        // cursor=2, text='xx'
    store.getState().insertPaste('ABC');  // range {2,5}
    expect(store.getState().pasteRanges).toEqual([{ start: 2, end: 5 }]);
    expect(store.getState().text).toBe('xxABC');
  });

  it('insert（手敲）紧贴 range.end 后方插入：不破坏该 range', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');  // range {0,3}, cursor=3
    store.getState().insert('x');         // editStart=3==end=3 → reconcile 规则2 不变
    expect(store.getState().text).toBe('AAAx');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('insert（手敲）插进 range 内部：该 range 失效', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAAA');  // range {0,4}, cursor=4
    store.getState().moveCursorTo(2);      // 进内部 AA|AA
    store.getState().insert('x');          // editStart=2 < end=4 → 触及 → 丢弃
    expect(store.getState().text).toBe('AAxAA');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('insert（手敲）在 range 前方插入：range 右移（正 delta）', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');   // range {0,3}
    store.getState().moveCursorTo(0);
    store.getState().insert('x');          // editStart=0, editEnd=0 <= r.start=0 → 规则1 右移 +1
    expect(store.getState().text).toBe('xAAA');
    expect(store.getState().pasteRanges).toEqual([{ start: 1, end: 4 }]);
  });

  it('insertPaste 空字符串：不创建空 range', () => {
    const store = createInputStore();
    store.getState().insertPaste('');
    expect(store.getState().text).toBe('');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('insertNewline：等同 insert("\\n")，与 range 同步', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');   // range {0,3}
    store.getState().moveCursorTo(1);      // 进内部
    store.getState().insertNewline();      // 触及 → 丢弃
    expect(store.getState().text).toBe('A\nAA');
    expect(store.getState().pasteRanges).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — `insertPaste is not a function`；`pasteRanges` 在 insert 后仍为初始 `[]`（未同步）。

- [ ] **Step 3: 实现**

在 `src/tui/state/input-store.ts`：

3a. `interface InputState` 内，在 `insert` 声明之后加：

```ts
  /** 在光标处插入来自一次 paste 的字符串，光标前移，并记录该段为 paste range（仅 ConnectedApp.usePaste 调用）。 */
  insertPaste: (str: string) => void;
```

3b. 把 `insert` 原语（L61-65）重写为走 spliceCodePoints + reconcileRanges：

```ts
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
```

3c. 把 `insertNewline`（L88-92）重写为走 insert 逻辑（复用 reconcile）：

```ts
    insertNewline: () => set((s) => {
      const next = spliceCodePoints(s.text, s.cursor, s.cursor, '\n');
      return {
        text: next,
        cursor: s.cursor + 1,
        pasteRanges: reconcileRanges(s.pasteRanges, s.cursor, 0, 1),
      };
    }),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task4): insertPaste primitive + insert/insertNewline sync ranges via spliceCodePoints"
```

---

## Task 5: `backspace` 整段删（命中 range.end）+ 普通删走 spliceCodePoints

**目标**：核心契约——`cursor === range.end` 时一次 Backspace 删除整个 paste；否则普通删 1 code point。普通删落在 range 内部 → 该 range 失效。

**Files:**
- Modify: `src/tui/state/input-store.ts`
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/tui/input-store.test.ts` 末尾追加：

```ts
describe('backspace（整段删契约 + 普通删）', () => {
  it('短 paste 直显：cursor 在末尾一次 Backspace 删整段', () => {
    const store = createInputStore();
    store.getState().insertPaste('shortpastedtext');
    store.getState().backspace();
    expect(store.getState().text).toBe('');
    expect(store.getState().cursor).toBe(0);
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('多行占位符：cursor 在末尾一次 Backspace 删整个占位符串', () => {
    const store = createInputStore();
    store.getState().insertPaste('[Pasted text #1 +3 lines]');
    store.getState().backspace();
    expect(store.getState().text).toBe('');
  });

  it('手敲字符：Backspace 仍逐字符删（回归保护）', () => {
    const store = createInputStore();
    store.getState().insert('a');
    store.getState().insert('b');
    store.getState().insert('c');
    store.getState().backspace();
    expect(store.getState().text).toBe('ab');
    store.getState().backspace();
    expect(store.getState().text).toBe('a');
    store.getState().backspace();
    expect(store.getState().text).toBe('');
  });

  it('paste 后手敲：先删手敲字符，再删整段 paste', () => {
    const store = createInputStore();
    store.getState().insertPaste('PASTED');
    store.getState().insert('x');
    store.getState().backspace();   // 删 x
    expect(store.getState().text).toBe('PASTED');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 6 }]);
    store.getState().backspace();   // 整段删
    expect(store.getState().text).toBe('');
  });

  it('连续 paste：Backspace 一次删最近一个', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');   // range {0,3}
    store.getState().insertPaste('BBB');   // range {3,6}
    store.getState().backspace();          // hit {3,6}（end=6==cursor=6）
    expect(store.getState().text).toBe('AAA');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
    store.getState().backspace();          // hit {0,3}
    expect(store.getState().text).toBe('');
  });

  it('range 在被删 range 后方：左移 deletedLen（保留并平移）', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');   // {0,3}
    store.getState().insertPaste('BBB');   // {3,6}
    store.getState().moveCursorTo(3);      // 命中 {0,3}.end=3
    store.getState().backspace();          // 删 AAA，{3,6} 应左移 3 → {0,3}
    expect(store.getState().text).toBe('BBB');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
    store.getState().backspace();          // 命中新 {0,3}
    expect(store.getState().text).toBe('');
  });

  it('光标在 range 内部 Backspace：range 失效，逐字符删', () => {
    const store = createInputStore();
    store.getState().insertPaste('PASTED'); // range {0,6}, cursor=6
    store.getState().moveCursorTo(4);       // 进内部 PAST|ED
    store.getState().backspace();           // 删 'T'，触及 {0,6} → 失效
    expect(store.getState().text).toBe('PASED');
    expect(store.getState().pasteRanges).toEqual([]);
    store.getState().moveCursorToEnd();     // cursor=5
    store.getState().backspace();           // 不再整段删（range 已失效）
    expect(store.getState().text).toBe('PASE');
  });

  it('单纯移动光标不失效：进入内部再退回 end 仍能整段删', () => {
    const store = createInputStore();
    store.getState().insertPaste('PASTED');
    store.getState().moveCursorTo(3);       // 进内部
    store.getState().moveCursorToEnd();     // 退回 end=6
    store.getState().backspace();           // 仍整段删
    expect(store.getState().text).toBe('');
  });

  it('紧贴 end 手敲后退回 end 仍能整段删', () => {
    const store = createInputStore();
    store.getState().insertPaste('PASTED'); // range {0,6}
    store.getState().insert('x');           // 紧贴 end，range 不变
    store.getState().backspace();           // 删 x（普通，6!=7）
    expect(store.getState().text).toBe('PASTED');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 6 }]);
    store.getState().backspace();           // 命中 end=6，整段删
    expect(store.getState().text).toBe('');
  });

  it('前方插入导致 range 右移（正 delta，端到端）', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');    // range {0,3}
    store.getState().moveCursorTo(0);
    store.getState().insert('x');           // 前方插入 → range 右移 → {1,4}
    expect(store.getState().text).toBe('xAAA');
    expect(store.getState().pasteRanges).toEqual([{ start: 1, end: 4 }]);
    store.getState().moveCursorToEnd();     // cursor=4，命中 {1,4}.end
    store.getState().backspace();           // 整段删 AAA
    expect(store.getState().text).toBe('x');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('非 BMP 坐标闭合：insertPaste 后立即断言防假阳性', () => {
    // 𝄞 = U+1D11E，1 code point / 2 UTF-16 unit。
    // 关键：insertPaste('X') 后立即断言 text/cursor，捕获 surrogate 被拆又恢复的假阳性。
    const store = createInputStore();
    store.getState().insertPaste('𝄞');      // text='𝄞', cursor=1, range {0,1}
    store.getState().insertPaste('X');      // 立即断言
    expect(store.getState().text).toBe('𝄞X'); // 若坐标错（UTF-16）：text 可能乱码
    expect(store.getState().cursor).toBe(2);   // 若坐标错：cursor=3（surrogate 计 2）
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
    // backspace 一次删 X（命中 {1,2}.end=2）
    store.getState().backspace();
    expect(store.getState().text).toBe('𝄞');
    expect(store.getState().cursor).toBe(1);
    // backspace 一次删 𝄞（命中 {0,1}.end=1）
    store.getState().backspace();
    expect(store.getState().text).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — 当前 backspace 不识别 range，"短 paste 直显"测试会得到 `text === 'shortpastedte'`（只删 1 字符）。

- [ ] **Step 3: 重写 backspace**

在 `src/tui/state/input-store.ts` 把 `backspace`（L67-72）替换为：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS（新增 backspace describe 全绿；现有 backspace 测试不回归）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task5): backspace deletes whole paste when cursor===range.end; plain delete via spliceCodePoints"
```

---

## Task 6: `deleteForward` + `deleteToLineStart` 走 spliceCodePoints + reconcileRanges

**目标**：剩余两个会改 text 的删除原语统一走 code-point 坐标 + range 同步。`deleteForward` 简单；`deleteToLineStart` 的 5 个分支需把基于 UTF-16 slice 的实际删除改为基于 `[...text]` 的 code-point 操作，使删除位置与 reconcileRanges 的 `editStart`/`deletedLen` 同坐标系。

**Files:**
- Modify: `src/tui/state/input-store.ts`
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/tui/input-store.test.ts` 末尾追加：

```ts
describe('deleteForward / deleteToLineStart（range 同步）', () => {
  it('deleteForward：删光标处字符，range 同步', () => {
    const store = createInputStore();
    store.getState().insertPaste('ABC');   // range {0,3}
    store.getState().moveCursorTo(1);      // 进内部
    store.getState().deleteForward();      // 删 B，触及 → 失效
    expect(store.getState().text).toBe('AC');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('deleteForward 在 range 后方：不破坏 range', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');   // range {0,3}
    store.getState().insert('x');          // text='AAAx', cursor=4
    store.getState().moveCursorTo(3);      // 命中 range.end=3
    // 注意：deleteForward 在 cursor=3 删的是 'x'（位置 3 处），触及 range {0,3}？
    // editStart=3 == r.end=3 → reconcile 规则2（后方）不变；但删除的实际字符 'x' 不在 range 内
    store.getState().deleteForward();
    expect(store.getState().text).toBe('AAA');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('deleteToLineStart：删光标到行首，触及 range → 失效', () => {
    const store = createInputStore();
    store.getState().insertPaste('hello'); // range {0,5}
    store.getState().moveCursorTo(3);      // hel|lo，进 range 内部
    store.getState().deleteToLineStart();  // 删 [0,3)，触及 range → 失效
    expect(store.getState().text).toBe('lo');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('deleteToLineStart：range 在被删区间后方 → 左移', () => {
    const store = createInputStore();
    store.getState().insert('abc');        // text='abc', cursor=3
    store.getState().insertPaste('XYZ');   // range {3,6}
    store.getState().moveCursorTo(6);      // 末尾
    // Ctrl+U 删 [3,6)？不对——lineStart 是行首。当前只有一行，lineStart=0。
    // 删 [0,6)：触及 range {3,6} → 失效。改测：让 range 在被删区间后方。
    // 重新构造：先 paste，再前方手敲，光标在手敲末尾，lineStart 在 paste 之后
    store.clear();
    store.getState().insertPaste('XYZ');   // range {0,3}
    store.getState().insert('\n');         // text='XYZ\n', cursor=4, range {0,3} 规则2 不变
    store.getState().insert('abc');        // text='XYZ\nabc', cursor=7
    store.getState().moveCursorTo(7);      // 第二行末尾
    store.getState().deleteToLineStart();  // 删第二行 [4,7) → text='XYZ\n'
    // range {0,3} 在被删区间 [4,7) 前方（r.end=3 <= ds=4）→ 不变
    expect(store.getState().text).toBe('XYZ\n');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('deleteToLineStart 多行：非首行行首删整行（含 \\n），range 平移', () => {
    const store = createInputStore();
    store.getState().insertPaste('XYZ');   // range {0,3}
    store.getState().insertNewline();      // text='XYZ\n', cursor=4, range 不变
    store.getState().insert('def');        // text='XYZ\ndef', cursor=7
    store.getState().moveCursorTo(4);      // 第二行行首（d 之前）
    store.getState().deleteToLineStart();  // 删 [lastNl=3, lineEnd=7] → text='XYZ', cursor=3
    // 被删区间 [3,8)（含 \n 和 def，5 code points）；range {0,3} r.end=3 <= ds=3 → 不变
    expect(store.getState().text).toBe('XYZ');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — deleteForward / deleteToLineStart 不改 pasteRanges（仍是初始/上次值），且 deleteToLineStart 的实际删除走 UTF-16 slice（对非 BMP 坐标错，但本测试用 BMP 不触发该 bug；失败原因是 ranges 未同步）。

- [ ] **Step 3: 重写 deleteForward 与 deleteToLineStart**

在 `src/tui/state/input-store.ts`：

3a. 替换 `deleteForward`（L74-79）：

```ts
    deleteForward: () => set((s) => {
      if (s.cursor >= [...s.text].length) return s;
      const next = spliceCodePoints(s.text, s.cursor, s.cursor + 1, '');
      return {
        text: next,
        cursor: s.cursor,
        pasteRanges: reconcileRanges(s.pasteRanges, s.cursor, 1, 0),
      };
    }),
```

3b. 替换整个 `deleteToLineStart`（L126-150）为 code-point 坐标版本。关键：所有 `slice`/`indexOf`/`lastIndexOf` 改在 `[...text]` 数组上做，删除走 spliceCodePoints。`lineEnd = ... : s.cursor + nextNlInRest` 中的 `s.text.length` 改为 `[...s.text].length`：

```ts
    deleteToLineStart: () => set((s) => {
      // Unix 行编辑语义（Ctrl+U）：删光标到行首；光标已在行首时删整行（含内容 + 前导 \n），
      // 光标移到上一行末尾。这样连续按 Ctrl+U 能从下往上逐行吞掉，直到全空。
      //
      // 全程 code-point 坐标：用 [...text] 数组做 \n 查找，实际删除走 spliceCodePoints，
      // 使 editStart/deletedLen 与 reconcileRanges 同坐标系。
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
      // 光标已在行首：删整行（本行全部内容 + 前导 \n），光标移到上一行末尾。
      // 找本行的结尾（下一个 \n 或文本末尾）。
      let nextNlInRest = -1;
      for (let i = s.cursor; i < chars.length; i++) {
        if (chars[i] === '\n') { nextNlInRest = i; break; }
      }
      const lineEnd = nextNlInRest === -1 ? chars.length : nextNlInRest;
      if (s.cursor === 0) {
        // 首行行首：删第一行内容（[0, lineEnd] 或 [0, lineEnd+1)）。若后面还有 \n，保留后续行。
        if (nextNlInRest === -1) {
          // 整段就是一行：全删
          return {
            text: '',
            cursor: 0,
            pasteRanges: reconcileRanges(s.pasteRanges, 0, chars.length, 0),
          };
        }
        // 删 [0, lineEnd+1)（首行内容 + 它的 \n）
        const delEnd = lineEnd + 1;
        const next = spliceCodePoints(s.text, 0, delEnd, '');
        return {
          text: next,
          cursor: 0,
          pasteRanges: reconcileRanges(s.pasteRanges, 0, delEnd, 0),
        };
      }
      // 非首行行首：删 [lastNl, lineEnd+1)（前导 \n + 本行全部内容），光标移到 lastNl（上一行末尾位置）
      const delEnd = lineEnd + 1;
      const next = spliceCodePoints(s.text, lastNl, delEnd, '');
      return {
        text: next,
        cursor: lastNl,
        pasteRanges: reconcileRanges(s.pasteRanges, lastNl, delEnd - lastNl, 0),
      };
    }),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS（新增 describe 全绿；现有 deleteToLineStart 多行回归测试也必须仍绿 —— 它们是契约保护，见 Step 5 验证）。

- [ ] **Step 5: 确认现有 deleteToLineStart 回归测试不破坏**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts -t "deleteToLineStart"`
Expected: 所有 deleteToLineStart 测试 PASS（含 §"多行" describe 里既有的 6 个回归测试 + 本任务新增 3 个）。

如有失败：**不要修改既有测试**（那是契约），回到 Step 3 检查 code-point 重写是否引入 off-by-one（最常见：`lineEnd + 1` vs `lineEnd`、`chars.length` vs `s.text.length`）。

- [ ] **Step 6: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task6): deleteForward/deleteToLineStart via spliceCodePoints + reconcileRanges (code-point coords)"
```

---

## Task 7: 收尾 —— 去 helper 临时导出 + 接入 ConnectedApp + 全量回归

**目标**：(a) 移除 `reconcileRanges` 的临时 `export`（模块私有），把 reconcileRanges 的临时单测 describe 块从测试文件删除（已由行为测试覆盖）；(b) `ConnectedApp.tsx:236` 接入 `insertPaste`；(c) 全量回归。

**Files:**
- Modify: `src/tui/state/input-store.ts`（去 export）
- Modify: `src/tui/ConnectedApp.tsx:236`
- Modify: `src/__tests__/tui/input-store.test.ts`（删临时单测）

- [ ] **Step 1: 去掉 reconcileRanges 临时 export**

在 `src/tui/state/input-store.ts`，把：

```ts
export function reconcileRanges(
```

改为：

```ts
function reconcileRanges(
```

- [ ] **Step 2: 删除 reconcileRanges 临时单测块**

在 `src/__tests__/tui/input-store.test.ts`，删除整个：

```ts
import { reconcileRanges, type PasteRange } from '../../tui/state/input-store.js';

describe('reconcileRanges（range 同步三规则，模块私有，临时导出验证）', () => {
  ...
});
```

（保留 Task 3/4/5/6 的行为测试 describe 块 —— 它们通过 backspace/insert/deleteToLineStart 的可观察效果覆盖了 reconcile 的所有 case。）

- [ ] **Step 3: 运行测试确认仍绿**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS（删除临时单测后行为测试仍覆盖三规则；spliceCodePoints 早已私有）。

- [ ] **Step 4: 接入 ConnectedApp**

在 `src/tui/ConnectedApp.tsx` L236，把：

```tsx
    inputStore.getState().insert(storePastedContent(text));
```

改为：

```tsx
    inputStore.getState().insertPaste(storePastedContent(text));
```

（注意：只改这一行。`storePastedContent(text)` 的返回值（短文本直显原文 / 多行占位符串）直接喂给 insertPaste，由 insertPaste 创建对应 range。）

- [ ] **Step 5: 运行影响模块回归**

Run: `npx vitest run src/__tests__/tui/`
Expected: PASS —— 重点确认：
- `paste-handler.test.ts`（占位符生成逻辑未动）
- `submit-transformer.test.ts`（占位符展开未动）
- `paste-history-contract.test.ts`（双轨契约未动）
- `paste-inline-integration.test.tsx`
- `connected-app-dynamic-footer.test.tsx`（用 setText 驱动，setText 已清空 ranges，不应受影响）
- `ctrl-j-multiline-contract.test.tsx`
- `keyboard-regression.test.ts`

- [ ] **Step 6: 全量回归**

Run: `npm test`
Expected: PASS。

- [ ] **Step 7: TypeScript + Lint 静态检查**

Run:
```bash
npx tsc --noEmit
```
Expected: 无错误（重点：`ConnectedApp.tsx` 的 `insertPaste` 类型匹配；`InputState` 接口完整）。

如有 lint 配置，运行项目既定 lint 命令。无 unused（私有 reconcileRanges / spliceCodePoints 都被使用；临时 export 已去）。

- [ ] **Step 8: 提交**

```bash
git add src/tui/state/input-store.ts src/tui/ConnectedApp.tsx src/__tests__/tui/input-store.test.ts
git commit -m "feat(task7): wire insertPaste in usePaste; unexport reconcileRanges; cleanup temp unit tests"
```

---

## 真实 TTY 验收（在所有 Task 完成且 npm test 绿之后）

自动化测试不能替代真实终端验证。以下是必须手动验证的场景：

1. **启动 TUI**（`npm run dev` 或项目既定启动方式），进入输入框。
2. **短文本直显**：粘贴约 30 字符单行文本 → 确认光标在末尾 → 按**一次** Backspace → 整段消失，输入框为空。
3. **手敲回归**：手敲 `abc` → 逐次 Backspace → `ab` → `a` → 空（逐字符，未被误伤）。
4. **多行占位符**：粘贴多行文本（生成 `[Pasted text #N +M lines]`）→ 末尾 Backspace → 占位符整段消失。
5. **paste 后手敲**：粘贴一段 → 手敲 `x` → Backspace（删 `x`）→ Backspace（删整段 paste）。
6. **连续两段 paste**：粘贴 A → 粘贴 B → Backspace（删 B）→ Backspace（删 A）。
7. **光标进入内部失效**：粘贴一段 → 方向键进入中间 → Backspace（逐字符删，该 paste 退化为普通文本）→ End → Backspace（不再整段删）。

如某步行为与预期不符：回到对应 Task 的失败测试，先复现，再修。**禁止在未复现的情况下猜改。**

---

## Self-Review 记录

完成计划撰写后，对照 spec 逐项检查：

**1. Spec 覆盖**：
- spec §3 坐标闭合（code point + spliceCodePoints）→ Task 1（spliceCodePoints）+ Task 4/5/6（所有 range 维护原语走它）+ Task 6（deleteToLineStart code-point 重写）✓
- spec §4 数据结构（PasteRange + pasteRanges）→ Task 2（类型）+ Task 3（字段）✓
- spec §5 API 最小化（insertPaste，insert 签名不变）→ Task 4（insertPaste + insert 内部扩展）+ Task 7（ConnectedApp 1 行接入）✓
- spec §6 reconcileRanges 三规则 → Task 2（单测）+ Task 4/5/6（各原语映射）✓
- spec §7 backspace 精确语义 → Task 5（命中整段删 + 普通删）✓
- spec §9 RED 测试全表 → Task 4（创建/手敲/紧贴/内部/前方右移 pasteRanges 断言/空/insertNewline）+ Task 5（短 paste/多行/手敲回归/paste 后手敲/连续 paste/后方左移/内部失效/单纯移动/紧贴手敲/**前方右移端到端**/**非 BMP 端到端**）+ Task 6（deleteForward/forward 后方/deleteToLineStart 三场景）✓
- spec §9 非 BMP 测试（立即断言防假阳性）→ Task 5 "非 BMP 坐标闭合"测试，在 `insertPaste('X')` 后立即断言 `text==='𝄞X'` + `cursor===2`，并顺带验证两次 backspace 整段删 𝄞 与 X ✓
- spec §9 前方插入右移测试 → Task 5 "前方插入导致 range 右移（正 delta，端到端）"测试，覆盖 pasteRanges 断言 + moveCursorToEnd + backspace → text='x' ✓

**2. 占位符扫描**：无 TBD/TODO/等占位符；每个代码步骤都有完整代码；测试步骤都有完整断言。✓

**3. 类型一致性**：
- `PasteRange { start, end }` 在 Task 2 定义，Task 3 字段、Task 4/5/6 实现都用同名同形 ✓
- `insertPaste(str: string)` 在 Task 4 接口声明 + 实现 + Task 7 ConnectedApp 调用签名一致 ✓
- `spliceCodePoints(text, start, end, inserted)` 签名在 Task 1 定义，Task 4/5/6 调用一致 ✓
- `reconcileRanges(ranges, editStart, deletedLen, insertedLen)` 签名在 Task 2 定义，Task 4/5/6 调用一致 ✓

**修复项（已补入 Task 5）**：Self-Review 发现 spec §9 的"非 BMP 端到端"与"前方插入右移端到端"两个测试原计划只在 pasteRanges 断言层面覆盖，缺少端到端行为断言。已在 Task 5 补入两个端到端测试（"前方插入导致 range 右移（正 delta，端到端）" 与 "非 BMP 坐标闭合：insertPaste 后立即断言防假阳性"）。无其他缺口。
