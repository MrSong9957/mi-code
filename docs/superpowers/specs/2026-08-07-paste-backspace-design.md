# Paste 作为一个 Backspace 删除单元 — 设计

- 分支：`auto-0025-paste-backspace`
- 日期：2026-08-07
- 状态：设计已批准，待写实施计划

## 1. 问题

TUI 中一次粘贴进输入框的整段文本，表现成散装字符，Backspace 只能逐字符删除。
目标体验：光标停在本次 paste 末尾时，一次 Backspace 删除整次 paste 内容；
普通逐键输入仍逐字符删除。

### 已确认根因（systematic-debugging 阶段）

- Ink `usePaste` 能收到 bracketed paste（`ConnectedApp.tsx:230`）；
- paste payload 经 `storePastedContent(text)` 折叠为占位符或短文本直显后，
  由 `ConnectedApp.tsx:236` 的 `insert(string)` 平铺进 `InputState.text`；
- `InputState` 只有 `text + cursor`，paste 边界在 insert 后即丢失；
- `backspace()` 当前只删一个 Unicode code point（`input-store.ts:67-72`）。

### 目标语义（用户锁定）

- range 半开 `[start, end)`；
- `cursor === range.end` 时 Backspace 一次删除整个 paste；
- 光标位于 range 内部时执行普通编辑 → 该 range 失效，文本退化为普通文本；
- 单纯移动光标不使 range 失效；
- range 后方编辑不影响它；
- range 前方编辑只平移 start/end；
- 编辑触及或跨越 range 内容时使其失效；
- paste 后继续手敲字符不破坏 range：先逐字删除新增字符，回到 range.end
  后下一次 Backspace 删除整个 paste；
- 连续 paste 保留独立 ranges，一次 Backspace 只删除最近一个。

## 2. 推荐方案

**`text: string` 不变 + 附加 `pasteRanges: PasteRange[]`。**

淘汰理由（基于真实代码审计）：

- **segment/edit-unit 模型**：把 `text: string` 改成 `EditUnit[]` 会触动渲染核心
  `computeInputViewportLayout`（`input-viewport.ts:100-205`）、2 个 React selector
  （`ConnectedApp.tsx:139`、`InlineAppV2.tsx:145`）、选区映射 `row-text-map.ts`、
  提交链路、4 处 `setText` 调用方、5 处只读 `.text` 判断 ≈ 15 处改动，且都落在
  折行/光标映射这种最易回归的区域。违反最小修改原则。
- **仅识别 `[Pasted text #N]` 占位符**：paste-handler.ts:43-44 显示 ≤80 字符单行
  走直显，这段文本进入 `text` 后无任何标记。纯靠正则识别占位符无法覆盖短文本直显
  路径，而短串正是高频场景。治标不治本。

选定方案：`text` 保持 string，**渲染层、提交链路、submit-transformer、
paste-handler 占位符逻辑全部零改动**；`pasteRanges` 是纯附加元数据，
只参与 `backspace` 决策。改动集中在 `input-store.ts` 一个文件 +
`ConnectedApp.tsx` 一行调用。

提交语义读 `text`（含占位符），backspace 语义读 range 元数据 —— 两者解耦。

## 3. 坐标系（闭合）

### 事实核对（以代码为准）

`InputState.cursor` 的运行时真实坐标是 **code point offset**：

- `input-store.ts:64` `cursor: cursor + [...str].length`（code point 推进）；
- `input-store.ts:69-71` `[...s.text]` + `splice(cursor-1, 1)`（code point 索引）；
- `input-store.ts:82/83/85/87` `[...s.text].length`（code point 钳位）。

文件头注释（L5/L19）写的 `text.length` / `str.length` 过时不准确。

既有不一致（独立 issue，本次不修）：`insert`（L63）、`insertNewline`（L90）、
`deleteToLineStart`（L129/134/139/148）使用 JS `slice(cursor)`，对非 BMP 字符
是 UTF-16 坐标，与 cursor 的 code point 语义矛盾。

### 本设计的坐标决策

- `cursor` 与 `pasteRanges.start/end` **统一为 code point offset**；
- 由于本功能要求"实际 text 修改"与"range 维护"使用同一 cursor，
  不能把它视为既有 emoji bug —— 非 BMP 字符会让两套位置分叉，直接破坏
  本功能的数据 invariant。因此本次所有会维护 pasteRanges 的文本修改原语
  **必须通过 code-point 坐标执行实际 text 修改**；
- **不扩展到 grapheme / ZWJ / ask-question 或其他无关问题**。

### 新增模块私有 helper

```ts
// code-point 坐标下的文本替换：把 [start, end) 替换为 inserted
// 不导出（模块私有）；仅 input-store 内部使用
function spliceCodePoints(text: string, start: number, end: number, inserted: string): string {
  const chars = [...text];
  chars.splice(start, end - start, inserted);
  return chars.join('');
}
```

本次所有维护 pasteRanges 的原语通过它执行实际 text 修改：
`insert` / `insertPaste` / `backspace` / `deleteForward` / `insertNewline` /
`deleteToLineStart`。

`deleteToLineStart` 既有的 `slice`/`indexOf`（UTF-16 坐标）分支逻辑需通过
`[...text]` 重写为 code-point 坐标执行实际删除，使删除位置与 reconcileRanges
的 `editStart`/`deletedLen` 同坐标系。

## 4. 数据结构

```ts
/** Paste 范围。半开区间 [start, end)，code point offset（与 cursor 同坐标系）。 */
interface PasteRange {
  start: number;
  end: number;
}

interface InputState {
  text: string;                // 不变
  cursor: number;              // 不变（code point offset）
  pasteRanges: PasteRange[];   // 新增：当前 text 中"来自一次 paste"的区段
  insert: (str: string) => void;              // 签名不变
  insertPaste: (str: string) => void;         // 新增：仅 paste 通道
  backspace: () => void;                      // 签名不变
  deleteForward: () => void;                  // 签名不变
  insertNewline: () => void;                  // 签名不变
  deleteToLineStart: () => void;              // 签名不变
  // moveCursor*/moveCursorTo*/clear/setText/submit 签名不变
}
```

`pasteRanges` 不存原文副本。backspace 整段删只需切片，原文展开仍走既有
submit-transformer 链路。

## 5. API 最小化（专用 insertPaste 原语）

代码证据支持专用原语完全可行：

| 调用点 | 现状 | 修正后 |
|---|---|---|
| `use-input-handler.ts:253` 手敲字符 | `s.insert(input)` | **不动** |
| `use-input-handler.ts:152` completion 插入 | `s.insert(input)` | **不动** |
| `ConnectedApp.tsx:236` usePaste | `insert(storePastedContent(text))` | 改为 `insertPaste(storePastedContent(text))`（1 行） |

`insert` **签名不变**（无 opts 参数），调用点零改动。
新增 `insertPaste`，仅 paste 通道调用。

### 数据一致性约束（非 API 扩展，是正确性要求）

虽然 `insert` **签名**不变，但其**内部实现必须同步 ranges** —— 否则"手敲字符
插入到 paste range 内部"时该 range 不会失效。这是所有改写 `text` 的原语统一
遵守的，与 source 参数无关：**签名稳定，内部扩展**。

## 6. paste range 生命周期

所有改写 `text` 的原语统一通过私有 `reconcileRanges` 同步 ranges，
不为每个操作写特殊逻辑。

### reconcileRanges（模块私有，不导出）

通用编辑语义：把 `[editStart, editStart+deletedLen)` 替换为长度 `insertedLen`
的新内容。

**以被删 range 视角表述**（删除区间 `[ds, de)`，deletedLen = de - ds）：

- `r.end <= ds`：range 在被删区段**前方**，**不变**；
- `r.start >= de`：range 在被删区段**后方**，**左移 deletedLen**；
- 被删 range 自身：移除。

通用编辑规则等价表述（任意替换）：

- `editEnd <= r.start`（编辑完全在 range 前方）→ range 右移 `insertedLen - deletedLen`；
- `editStart >= r.end`（编辑完全在 range 后方，含紧贴 end 插入）→ 不变；
- 否则（触及 range 内容）→ 丢弃该 range。

```ts
// 模块私有，不导出；通过 input-store 行为测试间接覆盖
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
    // 否则触及 range 内容 → 丢弃
  }
  return next;
}
```

### 各原语映射

| 原语 | range 同步 |
|---|---|
| `insert(str)` | `reconcileRanges(ranges, cursor, 0, [...str].length)`（签名不变，内部扩展） |
| `insertPaste(str)` | 同上 + `push({start:cursor, end:cursor+[...str].length})`（仅非空 str） |
| `backspace()` | 见 §7 |
| `deleteForward()` | `reconcileRanges(ranges, cursor, 1, 0)` |
| `insertNewline()` | 等同 `insert('\n')` |
| `deleteToLineStart()` | `reconcileRanges(ranges, lineStart, cursor-lineStart, 0)`（lineStart 走 code-point 坐标） |
| `clear()` / `submit()` / `setText()` | `pasteRanges = []` |
| `moveCursor*` 全系列 | 不改 text，**不动 ranges** |

## 7. Backspace 精确语义

```
backspace():
  1. cursor <= 0 → 无操作
  2. hit = pasteRanges.find(r => r.end === cursor)
  3. 若 hit 存在（光标恰在某次 paste 末尾）:
       - 整段删 [hit.start, hit.end)，实际删除走 spliceCodePoints
       - text = spliceCodePoints(text, hit.start, hit.end, '')
       - cursor = hit.start
       - deletedLen = hit.end - hit.start（code point 数）
       - ranges = reconcileRanges(ranges.filter(r => r !== hit), hit.start, deletedLen, 0)
  4. 否则（光标不在任何 paste 末尾）:
       - 普通删 1 个 code point（spliceCodePoints(text, cursor-1, cursor, '')）
       - cursor = cursor - 1
       - ranges = reconcileRanges(ranges, cursor - 1, 1, 0)
```

### 语义对照（逐条）

| 用户锁定语义 | 实现 |
|---|---|
| range 半开 `[start, end)` | 数据结构定义 |
| `cursor === range.end` 整段删 | step 3 `find(r => r.end === cursor)` |
| 光标在 range 内部普通编辑 → 失效 | step 4 普通删 1，reconcile 触及 case 丢弃该 range |
| 单纯移动光标不失效 | moveCursor* 不碰 ranges |
| range 后方编辑不影响 | reconcile case 2（`editStart >= r.end`，含 `==`） |
| range 前方编辑平移 | reconcile case 1 |
| 编辑触及/跨越 → 失效 | reconcile 否则丢弃 |
| paste 后手敲不破坏 range | 手敲在 cursor==range.end 处，reconcile case 2 不变；逐字 backspace 删手敲字符时 case 2 仍不变；直到 cursor 回 range.end 触发整段删 |
| 连续 paste 独立、删最近一个 | 连续 paste 时新 range.end = 旧 range.end + len > 旧 end，光标在最末 range 的 end，find 自然命中最近一个 |

### 关键推演验证（连续 paste + 手敲 + 逐次 backspace）

```
text=''           cursor=0  ranges=[]
insertPaste 'AAA' cursor=3  ranges=[{0,3}]
insertPaste 'BBB' cursor=6  ranges=[{0,3},{3,6}]   # {0,3} case2 不变
insert 'x'        cursor=7  ranges=[{0,3},{3,6}]   # case2 (editStart=6>=end=6)
backspace         cursor=6  text='AAABBB'           # 普通(7!=6)，删 x，{3,6} case2 不变
backspace         cursor=3  text='AAA'              # hit {3,6}(end=6==6) 整段删 BBB
backspace         cursor=0  text=''                 # hit {0,3}(end=3==3) 整段删 AAA
```

## 8. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/tui/state/input-store.ts` | 加 `PasteRange` 类型 + `pasteRanges` 字段 + 私有 `reconcileRanges` + 私有 `spliceCodePoints`；新增 `insertPaste`；insert/backspace/deleteForward/insertNewline/deleteToLineStart/clear/setText/submit 内部加 range 同步；上述维护 range 的原语实际删除走 spliceCodePoints |
| `src/tui/ConnectedApp.tsx:236` | `insert(...)` → `insertPaste(...)`（1 行） |
| `src/tui/input/use-input-handler.ts` | **不动**（insert 调用点免改） |
| `src/__tests__/tui/input-store.test.ts` | 新增行为测试 |

**零改动确认**：渲染层（computeInputViewportLayout / Footer / row-text-map）、
提交链路（submit-transformer / paste-handler 占位符 / splitSubmitTracks）、
ask-question store、4 处 setText 调用方、5 处只读 `.text` 判断。

## 9. RED 测试（行为测试，不暴露 ranges）

`reconcileRanges` 私有，通过可观察的 text/cursor/backspace 行为间接覆盖每个 case：

| reconcile case | 行为测试（通过可观察效果验证） |
|---|---|
| 后方不变 | paste A，paste B，删 B → text 只剩 A；再 backspace 整段删 A（证明 A 的 range 未受 B 删除影响） |
| 前方平移 | paste A，paste B，删 A → text 只剩 B；再 backspace 整段删 B（证明 B 坐标正确左移） |
| 内部编辑失效 | paste A，moveCursor 进 A 内部，backspace 删 1 字符；moveCursorToEnd，backspace → 不整段删，只删 1 字符 |
| 连续 paste 独立 | paste A，paste B，连续 backspace → 先删 B 再删 A |
| paste 后手敲 | paste A，手敲 x（insert 默认 keystroke），backspace 删 x，backspace 整段删 A |
| 紧贴 end 插入不破坏 | paste A，在 A.end 处手敲 x → backspace 删 x，backspace 整段删 A |
| 短 paste 直显 | `insertPaste('shortpastedtext')`，backspace 一次 → `text=''` |
| 多行占位符 | `insertPaste(storePastedContent('a\nb\nc'))`，backspace 一次 → `text=''` |
| 手敲回归 | 手敲 a/b/c，逐次 backspace → `ab`→`a`→`''`（未被误伤） |
| 非 BMP 坐标闭合（防假阳性） | `insertPaste('𝄞')`（U+1D11E，1 code point / 2 UTF-16 unit）→ `insertPaste('X')`，**立即断言** `text === '𝄞X'` 且 `cursor === 2`（直接捕获 UTF-16 surrogate 被拆又恢复的假阳性：若坐标错则 text 乱码或 cursor=3）；随后 backspace 一次删 X（`text === '𝄞'`, `cursor === 1`），再 backspace 一次删 𝄞（`text === ''`） |
| 前方插入右移（正 delta） | `insertPaste('AAA')`，moveCursorTo(0)，`insert('x')` → 断言 `text === 'xAAA'`；moveCursorToEnd，backspace 一次 → 断言 `text === 'x'`（证明 range 随前方插入右移，end 仍命中 cursor，覆盖 reconcileRanges 的正 delta） |

## 10. 验收方案

### 自动化

- `npx vitest run src/__tests__/tui/input-store.test.ts` — 新 RED 转 GREEN +
  现有原语测试不回归；
- `npx vitest run src/__tests__/tui/` — paste-handler / submit-transformer /
  paste-history-contract / paste-inline-integration 全绿（验证提交链路未受影响）；
- `npm test` — 全量回归，确认渲染层（connected-app-dynamic-footer /
  ctrl-j-multiline-contract / keyboard-regression）未破坏。

### 真实 TTY（不可由单测替代）

1. 启动 TUI，粘贴约 30 字符单行文本 → 光标在末尾，按**一次** Backspace → 整段消失；
2. 手敲 `abc`，逐次 Backspace → `ab`→`a`→`` 逐字符（未被误伤）；
3. 粘贴多行文本（生成 `[Pasted text #N]`）→ 末尾 Backspace → 占位符整段消失；
4. 粘贴后手敲 `x`，Backspace → 先删 `x`，再 Backspace → 删整段 paste；
5. 连续粘贴两段，Backspace → 先删第二段，再 Backspace → 删第一段。

## 11. 阻断问题

无。坐标闭合、语义无歧义、API 最小（ConnectedApp 1 行 + input-store 内部），
爆炸半径在 input-store.ts 内部。

### 已知外部风险（非本方案引入）

Ink `usePaste` 在真实终端所有粘贴方式下是否都可靠触发，上轮调查未在真实 TTY
验证（`ConnectedApp.tsx:230` 只确认回调挂载）。若某终端 usePaste 不触发，
paste 会泄漏进 useInput 走逐字符路径 —— 此情况下本方案的 range 根本不会被
创建。真实 TTY 验收步骤顺带验证 usePaste 可靠性。

### 已知跨 turn 限制（按"不处理 undo/redo"指示，不修复）

rewind 回填（`index.ts:661`）走 setText 塞入展开后的纯文本，ranges 被清空，
回填后的文本退化为普通逐字符。符合"局部修改后退化为普通文本"语义，可接受。
