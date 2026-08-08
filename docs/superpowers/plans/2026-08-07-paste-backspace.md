# Paste-as-Backspace-Unit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次粘贴进输入框的整段文本，光标停在其末尾时按一次 Backspace 删除整段；普通逐键输入仍逐字符删除。

**Architecture:** 在 `InputState`（`text: string + cursor: number`）上附加 `pasteRanges: PasteRange[]` 元数据。`cursor` 与 ranges 统一为 code-point offset。新增模块私有 `spliceCodePoints` 让所有维护 range 的文本原语在 code-point 坐标执行实际删除/替换；新增模块私有 `reconcileRanges` 统一同步 ranges；新增专用 `insertPaste(str)` 原语（仅 paste 通道调用）。渲染层/提交链路/submit-transformer/paste-handler 占位符逻辑零改动。

**Tech Stack:** TypeScript (ESM, target ES2022, strict), Zustand vanilla store, Vitest。

**Spec:** `docs/superpowers/specs/2026-08-07-paste-backspace-design.md`（已批准，commit `52efdb4`）。

**测试执行约定（来自 AGENTS.md）：**
- L1 当前测试：`npx vitest run src/__tests__/tui/input-store.test.ts`
- L2 影响模块：`npx vitest run src/__tests__/tui/`
- L3 全量回归：`npm test`

**设计原则（本版约束）：**
- `spliceCodePoints` 与 `reconcileRanges` **从始至终模块私有**（不 export），通过 input-store 的公开行为测试覆盖。不为临时公共 API 建 commit。
- helper 与第一个使用它的实现落在同一 Task，一起 RED → GREEN → COMMIT。

---

## 文件结构

| 文件 | 责任 | 改动性质 |
|---|---|---|
| `src/tui/state/input-store.ts` | 输入态 store + 所有文本原语 + range 同步 + 私有 helper | 修改（核心） |
| `src/tui/ConnectedApp.tsx:236` | usePaste 回调 | 修改（1 行） |
| `src/tui/input/use-input-handler.ts` | 键盘分发 | **不动** |
| `src/__tests__/tui/input-store.test.ts` | 行为测试 | 修改（新增测试） |

**零改动确认**：渲染层、提交链路、submit-transformer、paste-handler 占位符、ask-question store、4 处 setText 调用方、5 处只读 `.text` 判断。

---

## Task 1: `pasteRanges` 字段 + 私有 helper + insert/insertPaste/insertNewline（首块实现）

**目标**：第一个实际需要 helper 的实现块。一并落地：
- `PasteRange` 类型 + `InputState.pasteRanges: PasteRange[]` 字段（初始 `[]`）；
- 模块私有 `spliceCodePoints`（code-point 文本替换）+ 模块私有 `reconcileRanges`（range 同步三规则）；
- `insert`（签名不变，内部走 spliceCodePoints + reconcileRanges）；
- `insertPaste`（新原语，push range）；
- `insertNewline`（走 insert 逻辑）。

helper 不导出，直接由本任务的 insert/insertPaste 行为测试覆盖。

**Files:**
- Modify: `src/tui/state/input-store.ts`
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/tui/input-store.test.ts` 末尾追加：

```ts
describe('input-store pasteRanges 字段（初始化）', () => {
  it('初始：pasteRanges 为空数组', () => {
    const store = createInputStore();
    expect(store.getState().pasteRanges).toEqual([]);
  });
});

describe('insertPaste / insert / insertNewline（range 创建与手敲同步）', () => {
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

  it('非 BMP 坐标闭合：insertPaste 后立即断言防 surrogate 假阳性', () => {
    // 𝄞 = U+1D11E，1 code point / 2 UTF-16 unit。
    // 关键：insertPaste('X') 后立即断言 text/cursor，捕获 surrogate 被拆又恢复的假阳性。
    const store = createInputStore();
    store.getState().insertPaste('𝄞');      // text='𝄞', cursor=1, range {0,1}
    store.getState().insertPaste('X');      // 立即断言
    expect(store.getState().text).toBe('𝄞X'); // 若坐标错（UTF-16）：text 可能乱码
    expect(store.getState().cursor).toBe(2);   // 若坐标错：cursor=3（surrogate 计 2）
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — `pasteRanges` 属性 undefined（TS 也可能报 `insertPaste is not a function` / `Property 'pasteRanges' does not exist`）。

- [ ] **Step 3: 实现**

在 `src/tui/state/input-store.ts`：

3a. 在 `import` 之后、`export type InputStore` 之前，加类型与两个私有 helper（**不 export**）：

```ts
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
```

3b. `interface InputState` 内，在 `cursor: number;` 之后、`insert:` 之前加字段声明；在 `insert` 声明之后加 `insertPaste` 声明：

```ts
  /** 来自一次 paste 的区段（半开 [start,end)，code point offset）。光标进入或局部编辑后退化为空。 */
  pasteRanges: PasteRange[];

  /** 在光标处插入来自一次 paste 的字符串，光标前移，并记录该段为 paste range（仅 ConnectedApp.usePaste 调用）。 */
  insertPaste: (str: string) => void;
```

3c. `createInputStore` 初始 state，在 `cursor: 0,` 之后加：

```ts
    pasteRanges: [],
```

3d. 把 `insert` 原语（L61-65）重写为走 spliceCodePoints + reconcileRanges；紧跟其后新增 `insertPaste`：

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

3e. 把 `insertNewline`（L88-92）重写为走 insert 逻辑（复用 reconcile）：

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
Expected: PASS（新增 describe 全绿；现有 insert/insertNewline/多行测试不回归）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task1): pasteRanges field + private spliceCodePoints/reconcileRanges + insert/insertPaste/insertNewline"
```

---

## Task 2: clear / setText / submit 清空 pasteRanges

**目标**：所有"整体清空文本"的原语同步清空 ranges。这是 paste range 生命周期的终点之一（提交 / 清空 / rewind 回填）。

**Files:**
- Modify: `src/tui/state/input-store.ts`
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/tui/input-store.test.ts` 末尾追加：

```ts
describe('clear / setText / submit（清空 pasteRanges）', () => {
  it('clear：清空 text 同时清空 pasteRanges', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');  // 建 range {0,3}
    expect(store.getState().pasteRanges).toHaveLength(1);
    store.getState().clear();
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('setText：替换文本同时清空 pasteRanges', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');
    store.getState().setText('/plan');  // 补全/rewind 回填路径
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('submit：提交同时清空 pasteRanges', () => {
    const store = createInputStore({ onSubmit: () => {} });
    store.getState().insertPaste('abc');
    store.getState().submit();
    expect(store.getState().pasteRanges).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — clear/setText/submit 后 `pasteRanges` 仍是 insertPaste 建立的 `[{start:0,end:3}]`（未清空）。

- [ ] **Step 3: 实现**

在 `src/tui/state/input-store.ts`：

3a. `clear`（L86）：
```ts
    clear: () => set({ text: '', cursor: 0, pasteRanges: [] }),
```

3b. `setText`（L87）：
```ts
    setText: (text) => set({ text, cursor: [...text].length, pasteRanges: [] }),
```

3c. `submit`（L156）的 `set`：
```ts
      set({ text: '', cursor: 0, pasteRanges: [] });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task2): clear/setText/submit reset pasteRanges"
```

---

## Task 3: backspace 整段删（命中 range.end）+ 普通删走 spliceCodePoints

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

  it('range 在被删 range 前方：不变（删后方 range，前方保留）', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');   // {0,3}
    store.getState().insertPaste('BBB');   // {3,6}
    store.getState().moveCursorTo(6);      // 命中 {3,6}.end=6（注意：insertPaste 后 cursor 已在 6，moveCursorTo 等价）
    store.getState().backspace();          // 删 BBB，{0,3} 在被删区间 [3,6) 前方（r.end=3 <= ds=3）→ 不变
    expect(store.getState().text).toBe('AAA');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
    store.getState().backspace();          // 命中 {0,3}.end=3
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

  it('非 BMP 坐标闭合：两次 backspace 分别整段删 X 与 𝄞', () => {
    // 𝄞 = U+1D11E，1 code point / 2 UTF-16 unit。承接 Task 1 的 insertPaste 立即断言。
    const store = createInputStore();
    store.getState().insertPaste('𝄞');      // range {0,1}
    store.getState().insertPaste('X');      // range {1,2}, cursor=2
    expect(store.getState().text).toBe('𝄞X');
    store.getState().backspace();           // 命中 {1,2}.end=2，删 X
    expect(store.getState().text).toBe('𝄞');
    expect(store.getState().cursor).toBe(1);
    store.getState().backspace();           // 命中 {0,1}.end=1，删 𝄞
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
git commit -m "feat(task3): backspace deletes whole paste when cursor===range.end; plain delete via spliceCodePoints"
```

---

## Task 4: deleteForward 走 spliceCodePoints + reconcileRanges

**目标**：Delete 键原语统一走 code-point 坐标 + range 同步。简单原语，单独成块便于独立验证。

**Files:**
- Modify: `src/tui/state/input-store.ts`
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/tui/input-store.test.ts` 末尾追加：

```ts
describe('deleteForward（range 同步）', () => {
  it('deleteForward 触及 range 内部：range 失效', () => {
    const store = createInputStore();
    store.getState().insertPaste('ABC');   // range {0,3}
    store.getState().moveCursorTo(1);      // 进内部
    store.getState().deleteForward();      // 删 B（位置 1），触及 {0,3} → 失效
    expect(store.getState().text).toBe('AC');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('deleteForward 在 range 后方（删 range.end 之后字符）：不破坏 range', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');   // range {0,3}
    store.getState().insert('x');          // text='AAAx', cursor=4
    store.getState().moveCursorTo(3);      // cursor=3，删位置 3 处的 'x'
    // editStart=3 == r.end=3 → reconcile 规则2（后方）不变；'x' 不在 range 内
    store.getState().deleteForward();
    expect(store.getState().text).toBe('AAA');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('deleteForward 在 range 前方：range 右移', () => {
    const store = createInputStore();
    store.getState().clear();
    store.getState().insert('a');          // text='a', cursor=1
    store.getState().insertPaste('AAA');   // range {1,4}
    store.getState().moveCursorTo(0);      // 前方
    store.getState().deleteForward();      // 删 'a'（位置 0），editEnd=1 <= r.start=1 → 右移 -1 → {0,3}
    expect(store.getState().text).toBe('AAA');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — deleteForward 不改 pasteRanges。

- [ ] **Step 3: 重写 deleteForward**

在 `src/tui/state/input-store.ts` 替换 `deleteForward`（L74-79）：

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

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task4): deleteForward via spliceCodePoints + reconcileRanges"
```

---

## Task 5: deleteToLineStart 走 code-point 坐标 + reconcileRanges

**目标**：Ctrl+U 原语统一走 code-point 坐标 + range 同步。**严格保持既有 Ctrl+U 用户语义不变**（当前实现已是既定行为，本次不改变它；若该行为本身有问题，另开 issue）。

本次只修两类一致性问题：
- **坐标一致性**：现有 `slice(cursor)` / `indexOf` / `lastIndexOf` 是 UTF-16 坐标，重写为基于 `[...text]` 的 code-point 坐标，使删除位置与 reconcileRanges 的 `editStart`/`deletedLen` 同坐标系（非 BMP 字符场景下不再分叉）。
- **range 同步一致性**：给所有分支加 reconcileRanges 调用，并修复"最后一行删整行时 `lineEnd + 1 > chars.length` 导致实际删除长度与 reconcileRanges 的 `deletedLen` 不一致"的 off-by-one（用 `delEnd = 有下一\n ? lineEnd+1 : chars.length` 统一）。

非首行行首分支的删除区间（保持现有语义）：
- 存在下一 `\n`：`[lastNl, lineEnd+1)` —— 含前导 `\n` + 本行内容 + lineEnd 处的 `\n`，即上一行与下一行直接相连（`'abc\ndef\nghi'` cursor=4 → `'abcghi'`，与当前实现一致）。
- 不存在下一 `\n`（最后一行）：`[lastNl, chars.length)` —— 含前导 `\n` + 本行全部内容到文本末尾。

**Files:**
- Modify: `src/tui/state/input-store.ts`
- Test: `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/tui/input-store.test.ts` 末尾追加：

```ts
describe('deleteToLineStart（code-point 坐标 + range 同步 + off-by-one 修正）', () => {
  it('删光标到行首，触及 range → 失效', () => {
    const store = createInputStore();
    store.getState().insertPaste('hello'); // range {0,5}
    store.getState().moveCursorTo(3);      // hel|lo，进 range 内部
    store.getState().deleteToLineStart();  // 删 [0,3)，触及 range → 失效
    expect(store.getState().text).toBe('lo');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('range 在被删区间前方：不变（最后一行场景）', () => {
    // 'XYZ\nabc'，cursor=7（第二行末尾），lineStart=4，删 [4,7)
    const store = createInputStore();
    store.getState().insertPaste('XYZ');   // range {0,3}
    store.getState().insertNewline();      // text='XYZ\n', cursor=4, range 规则2 不变
    store.getState().insert('abc');        // text='XYZ\nabc', cursor=7
    store.getState().moveCursorTo(7);
    store.getState().deleteToLineStart();  // 删 [4,7) → text='XYZ\n'
    // range {0,3} r.end=3 <= ds=4 → 不变
    expect(store.getState().text).toBe('XYZ\n');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('非首行中间行：保持现有 Ctrl+U 语义（删 [lastNl, lineEnd+1)，上一行与下一行相连）', () => {
    // 'abc\ndef\nghi'，cursor=4（第二行行首 d 之前），lineStart=4==cursor → 走"行首删整行"分支
    // lastNl=3, 下一 \n 在 index 7 → lineEnd=7
    // 删除区间 [3, 7+1) = [3,8) = '\ndef\n'，结果 'abcghi'（保持当前实现语义）
    const store = createInputStore();
    store.getState().insert('abc\ndef\nghi');
    store.getState().moveCursorTo(4);
    store.getState().deleteToLineStart();
    expect(store.getState().text).toBe('abcghi'); // 锁定现有行为
    expect(store.getState().cursor).toBe(3);
  });

  it('非首行最后一行行首删整行：删到末尾，deletedLen=4 不越界', () => {
    // 'XYZ\ndef'，cursor=4（第二行行首），lastNl=3，无下一 \n → delEnd=chars.length=7
    // 删 [3,7) = '\ndef'，结果 'XYZ'，deletedLen=4（delEnd-lastNl = 7-3）
    const store = createInputStore();
    store.getState().insert('XYZ\ndef');
    store.getState().moveCursorTo(4);
    store.getState().deleteToLineStart();
    expect(store.getState().text).toBe('XYZ');
    expect(store.getState().cursor).toBe(3);
  });

  it('非首行最后一行：后方 paste range 按真实 deletedLen 平移，不多移 1', () => {
    // 关键 off-by-one 防护：旧实现的 lineEnd+1 在最后一行会超出 chars.length，
    // 若 reconcileRanges 用 lineEnd+1-lastNl 作 deletedLen 会比实际多 1，导致 range 多移。
    // 构造：'A\nBC\ndef'，cursor=2（第二行 BC 行首），删第二行 → 上一行 'A' 与 'def' 相连。
    // 但要 paste range 在后方，需 paste 在被删行之后。
    // 构造：'A\nBC\ndefXYZ'，其中 XYZ 是 paste；cursor 在第二行行首删第二行。
    const store = createInputStore();
    store.getState().insert('A\nBC\ndef');  // text='A\nBC\ndef', cursor=8
    store.getState().insertPaste('XYZ');    // range {8,11}, cursor=11
    store.getState().moveCursorTo(2);       // 第二行 BC 行首（index 2）
    // lastNl=1（第一个 \n），无下一 \n → delEnd=chars.length=11
    // 删 [1,11) = '\nBC\ndefXYZ'？不对——删到末尾会把 XYZ 也删了。重新构造。
    store.clear();
    // 改：被删行后面还有换行 + paste 行
    store.getState().insert('A\nBC\n');     // text='A\nBC\n', cursor=5
    store.getState().insertPaste('XYZ');    // range {5,8}, cursor=8
    store.getState().moveCursorTo(2);       // 第二行 BC 行首（index 2）
    // lastNl=1，下一 \n 在 index 4 → lineEnd=4 → delEnd=4+1=5
    // 删 [1,5) = '\nBC\n'，deletedLen=4；range {5,8} 后方 → 左移 4 → {1,4}
    store.getState().deleteToLineStart();
    expect(store.getState().text).toBe('AXYZ');
    expect(store.getState().pasteRanges).toEqual([{ start: 1, end: 4 }]); // 左移 4，不是 5
  });

  it('非首行最后一行（无下一 \\n）：被删区间触及后方 paste range → 失效', () => {
    // 此场景 paste 紧贴被删行后方（无 \n 分隔），删整行会连 paste 一起触及 → range 失效。
    // 验证 delEnd=chars.length 不越界、触及判定正确。
    const store = createInputStore();
    store.getState().insert('A\nBC');       // text='A\nBC', cursor=4
    store.getState().insertPaste('XYZ');    // 紧贴后方插，range {4,7}，text='A\nBCXYZ'
    store.getState().moveCursorTo(2);       // 第二行 BC 行首（index 2）
    // cursor=2, lastNl=1, lineStart=2==cursor → 行首删整行分支
    // 无下一 \n → lineEnd=chars.length=7 → delEnd=7
    // 删 [1,7) = '\nBCXYZ'，deletedLen=6；range {4,7} 触及（editStart=1 < end=7 且 editEnd=7 > start=4）→ 丢弃
    store.getState().deleteToLineStart();
    expect(store.getState().text).toBe('A');
    expect(store.getState().pasteRanges).toEqual([]); // range 被删区间触及，失效
  });

  it('首行行首 + 存在下一 \\n：删 [0, lineEnd+1) 吃掉首行+换行', () => {
    // 'abc\ndef'，cursor=0，首行行首分支，下一 \n 在 index 3
    // lineEnd=3，删 [0,4) = 'abc\n'，结果 'def'
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorTo(0);
    store.getState().deleteToLineStart();
    expect(store.getState().text).toBe('def');
    expect(store.getState().cursor).toBe(0);
  });

  it('首行行首 + 无下一 \\n：整段就是一行，全删', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    store.getState().moveCursorToStart();
    store.getState().deleteToLineStart();
    expect(store.getState().text).toBe('');
    expect(store.getState().cursor).toBe(0);
  });

  it('非 BMP：lineStart/lineEnd 按 code point 偏移，坐标闭合', () => {
    // '𝄞ab\ncd'，cursor=4（第二行行首 c 之前）
    // 𝄞 占 1 code point；'𝄞ab\ncd' 的 code points: 𝄞(0) a(1) b(2) \n(3) c(4) d(5)
    // cursor=4，lastNl=3，无下一 \n → lineEnd=6
    // 删 [3,6) = '\ncd'，结果 '𝄞ab'
    const store = createInputStore();
    store.getState().insert('𝄞ab\ncd');
    store.getState().moveCursorTo(4);
    store.getState().deleteToLineStart();
    expect(store.getState().text).toBe('𝄞ab');
    expect(store.getState().cursor).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: FAIL — 当前 deleteToLineStart 不维护 pasteRanges（仅改 text/cursor）：
- "删光标到行首，触及 range → 失效"：文本断言通过，但 `pasteRanges` 仍是 Task 1 建的 `[{start:0,end:5}]`，未清空 → 断言 `toEqual([])` 失败。
- "range 在被删区间前方：不变"：文本通过，但 `pasteRanges` 断言失败（未同步或仍为原值）。
- "非首行中间行" / "最后一行"：文本断言**通过**（当前实现的文本结果本就是 `'abcghi'`/`'XYZ'`，与锁定现有行为的期望一致），失败点在 `pasteRanges` 断言或"后方 paste range 左移"场景的 range 平移。
- "非首行最后一行：后方 paste range 按真实 deletedLen 平移"：当前实现若有 off-by-one（lineEnd+1 > chars.length）会导致 range 多移，本测试锁定 deletedLen 正确。

注意：部分测试的文本断言在当前代码下可能通过（因为保持现有语义），这正常——RED 的有效失败点是 pasteRanges 断言。只要 describe 块整体有测试失败即满足 RED。

- [ ] **Step 3: 重写 deleteToLineStart（code-point 坐标 + 修复最后一行 off-by-one，保持现有 Ctrl+U 语义）**

在 `src/tui/state/input-store.ts` 替换整个 `deleteToLineStart`（L126-150）：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts`
Expected: PASS（新增 describe 全绿 + 现有 deleteToLineStart 回归测试不破坏）。

- [ ] **Step 5: 确认现有 deleteToLineStart 回归测试不破坏**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts -t "deleteToLineStart"`
Expected: 所有 deleteToLineStart 测试 PASS（含 §"input-store 多行" describe 里既有的回归测试 + 本任务新增测试）。

**重点核对既有测试**（它们是契约保护，不能为通过新测试而改动）：
- `'abc\ndef'` cursor=4 → `'abc'`：本版 delEnd=chars.length=7(无下一\n), 删 [3,7) = '\ndef' → 'abc' ✓
- `'hello'` cursor=3 → `'lo'`：lineStart=0 < cursor=3，删 [0,3) → 'lo' ✓
- CJK `'你好世界'` cursor=2 → `'世界'`：同上 ✓
- "连续按能逐行删到全空"（`'aaa\nbbb\nccc'`）：依赖每步 cursor 跳到上一行末，本版保留该语义 ✓（非首行行首分支有下一\n时 delEnd=lineEnd+1，含本行末\n，与当前实现一致）

如有既有测试失败：**不要修改既有测试**（那是契约），回到 Step 3 检查 code-point 重写是否改变了既有语义。本次目标是**保持现有行为**，若某既有测试失败说明重写引入了语义偏差（最常见错位点：`delEnd` 公式、`chars.length` vs `s.text.length`、非首行行首分支漏掉 lineEnd 处的 `\n`）。

- [ ] **Step 6: 提交**

```bash
git add src/tui/state/input-store.ts src/__tests__/tui/input-store.test.ts
git commit -m "feat(task5): deleteToLineStart via code-point coords + reconcileRanges; preserve existing Ctrl+U semantics; fix last-line off-by-one (delEnd)"
```

---

## Task 6: 接入 ConnectedApp + 全量回归

**目标**：`ConnectedApp.tsx:236` 接入 `insertPaste`；全量回归 + 静态检查。helper 已在 Task 1 即为模块私有，本任务无需去 export。

**Files:**
- Modify: `src/tui/ConnectedApp.tsx:236`

- [ ] **Step 1: 接入 ConnectedApp**

在 `src/tui/ConnectedApp.tsx` L236，把：

```tsx
    inputStore.getState().insert(storePastedContent(text));
```

改为：

```tsx
    inputStore.getState().insertPaste(storePastedContent(text));
```

（只改这一行。`storePastedContent(text)` 的返回值——短文本直显原文 / 多行占位符串——直接喂给 insertPaste，由 insertPaste 创建对应 range。）

- [ ] **Step 2: 运行影响模块回归**

Run: `npx vitest run src/__tests__/tui/`
Expected: PASS —— 重点确认：
- `paste-handler.test.ts`（占位符生成逻辑未动）
- `submit-transformer.test.ts`（占位符展开未动）
- `paste-history-contract.test.ts`（双轨契约未动）
- `paste-inline-integration.test.tsx`
- `connected-app-dynamic-footer.test.tsx`（用 setText 驱动，setText 已清空 ranges，不应受影响）
- `ctrl-j-multiline-contract.test.tsx`
- `keyboard-regression.test.ts`

- [ ] **Step 3: 全量回归**

Run: `npm test`
Expected: PASS。

- [ ] **Step 4: TypeScript + Lint 静态检查**

Run:
```bash
npx tsc --noEmit
```
Expected: 无错误（重点：`ConnectedApp.tsx` 的 `insertPaste` 类型匹配；`InputState` 接口完整；无 unused —— 私有 `reconcileRanges` / `spliceCodePoints` 都被使用）。

如有项目既定 lint 命令，一并运行。

- [ ] **Step 5: 提交**

```bash
git add src/tui/ConnectedApp.tsx
git commit -m "feat(task6): wire insertPaste in usePaste callback"
```

---

## 真实 TTY 验收（在所有 Task 完成且 npm test 绿之后）

自动化测试不能替代真实终端验证。以下是必须手动验证的场景：

1. **启动 TUI**（项目既定启动方式），进入输入框。
2. **短文本直显**：粘贴约 30 字符单行文本 → 确认光标在末尾 → 按**一次** Backspace → 整段消失，输入框为空。
3. **手敲回归**：手敲 `abc` → 逐次 Backspace → `ab` → `a` → 空（逐字符，未被误伤）。
4. **多行占位符**：粘贴多行文本（生成 `[Pasted text #N +M lines]`）→ 末尾 Backspace → 占位符整段消失。
5. **paste 后手敲**：粘贴一段 → 手敲 `x` → Backspace（删 `x`）→ Backspace（删整段 paste）。
6. **连续两段 paste**：粘贴 A → 粘贴 B → Backspace（删 B）→ Backspace（删 A）。
7. **光标进入内部失效**：粘贴一段 → 方向键进入中间 → Backspace（逐字符删，该 paste 退化为普通文本）→ End → Backspace（不再整段删）。
8. **Ctrl+U 非首行行首**：手敲 `abc`，Ctrl+J 换行，手敲 `def`，Ctrl+J 换行，手敲 `ghi` → 光标移到第二行行首 → Ctrl+U → 应删第二行（保留 `abc\nghi`，不是 `abcghi`）。

如某步行为与预期不符：回到对应 Task 的失败测试，先复现，再修。**禁止在未复现的情况下猜改。**

---

## Self-Review 记录

**1. Spec 覆盖**：
- spec §3 坐标闭合（code point + spliceCodePoints）→ Task 1（spliceCodePoints 私有）+ Task 3/4/5（所有 range 维护原语走它）+ Task 5（deleteToLineStart code-point 重写）✓
- spec §4 数据结构（PasteRange + pasteRanges）→ Task 1（类型 + 字段 + 初始）✓
- spec §5 API 最小化（insertPaste，insert 签名不变）→ Task 1（insertPaste + insert 内部扩展）+ Task 6（ConnectedApp 1 行接入）✓
- spec §6 reconcileRanges 三规则 → Task 1（私有实现，由行为测试覆盖）+ Task 1/3/4/5（各原语映射）✓
- spec §7 backspace 精确语义 → Task 3（命中整段删 + 普通删）✓
- spec §9 RED 测试全表 → Task 1（创建/手敲/紧贴/内部/前方右移 pasteRanges/空/insertNewline/非 BMP 立即断言）+ Task 3（短 paste/多行/手敲回归/paste 后手敲/连续 paste/前方不变/后方左移/内部失效/单纯移动/紧贴手敲/前方右移端到端/非 BMP 两次 backspace）+ Task 4（forward 触及/后方/前方）+ Task 5（触及/前方不变/中间行 off-by-one/最后一行/后方左移/首行首有\n/首行首无\n/非 BMP）✓
- spec §9 非 BMP 测试（立即断言防假阳性）→ Task 1 "非 BMP 坐标闭合"立即断言 + Task 3 "两次 backspace 分别整段删" ✓
- spec §9 前方插入右移测试 → Task 1 pasteRanges 断言 + Task 3 端到端（moveCursorToEnd + backspace → text='x'）✓

**2. 占位符扫描**：无 TBD/TODO/"add error handling"/"similar to Task N"；每个代码步骤都有完整代码；每个测试步骤都有完整断言。helper 无临时 export 流程（从 Task 1 即私有）。✓

**3. 类型一致性**：
- `PasteRange { start, end }` 在 Task 1 定义，Task 1 字段、Task 1/3/4/5 实现都用同名同形 ✓
- `insertPaste(str: string)` 在 Task 1 接口声明 + 实现 + Task 6 ConnectedApp 调用签名一致 ✓
- `spliceCodePoints(text, start, end, inserted)` 在 Task 1 定义，Task 1/3/4/5 调用一致 ✓
- `reconcileRanges(ranges, editStart, deletedLen, insertedLen)` 在 Task 1 定义，Task 1/3/4/5 调用一致 ✓

**4. deleteToLineStart 一致性修复（Task 5 重点，严格保持现有 Ctrl+U 语义）**：
- 非首行行首分支：删 `[lastNl, delEnd)`，`delEnd = 有下一\n ? lineEnd+1 : chars.length`。保持现有语义——有下一\n时含 lineEnd 处的 `\n`（`'abc\ndef\nghi'` cursor=4 → `'abcghi'`，与当前实现一致）；无下一\n（最后一行）时到文本末尾。
- 首行行首 + 有下一 `\n`：删 `[0, delEnd)`，delEnd=lineEnd+1（吃首行 + 它的 `\n`）✓
- 首行行首 + 无下一 `\n`：删 `[0, chars.length)`（全删）✓
- **off-by-one 修复点**：旧实现最后一行用 `lineEnd+1` 可能 `> chars.length`，导致实际删除长度与 reconcileRanges 的 `deletedLen` 不一致（差 1）；统一用 `delEnd = 有下一\n ? lineEnd+1 : chars.length` 后，实际删除 `[lastNl, delEnd)` 与 `deletedLen = delEnd - lastNl` 严格一致。
- 与既有回归测试兼容：`'abc\ndef'` cursor=4 → `'abc'`（delEnd=7 无下一\n，删 [3,7)='\ndef'）✓；`'hello'` cursor=3 → `'lo'`（删 [0,3)）✓；`'aaa\nbbb\nccc'` 连续逐行删到全空 ✓
- 新增锁定测试：中间行保持现有 `'abcghi'` 语义、最后一行 deletedLen=4 不越界、后方 paste range 按真实 deletedLen 平移（有下一\n场景 + 触及失效场景）、非 BMP 坐标闭合 ✓

**5. 任务结构（去除临时 export 流程）**：
- 旧 Task 1（spliceCodePoints 临时 export + 单测）+ 旧 Task 2（reconcileRanges 临时 export + 单测）+ 旧 Task 7（去 export + 删临时单测）→ 合并进新 Task 1（私有 helper + 首块实现一起落地）✓
- 任务数从 7 减为 6，无"为临时公共 API 建 commit"✓

无缺口。
