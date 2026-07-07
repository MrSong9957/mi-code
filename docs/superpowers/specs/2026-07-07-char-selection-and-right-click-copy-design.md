# 字符级文本选择 + 右键复制 Design Spec

> **Date:** 2026-07-07
> **Branch:** `feat/double-buffer-render`（延续当前分支，或基于此切 `feat/char-selection`）
> **Status:** 设计已与用户确认 §1–§6，待 spec review → writing-plans
> **对标：** Claude Code 的文本选择 + 自动复制机制（`selection.ts` / `useCopyOnSelect.ts` / `osc.ts`），但本项目采用 Ink 层高亮方案而非 Claude Code 的 Screen cell 覆盖方案。

---

## 1. 背景与目标

### 1.1 现状（复用审查结论）

项目已有「行级选择 + mouseup 自动复制」的 MVP，分散在：

| 模块 | 现状 |
|---|---|
| `src/tui/state/selection-store.ts` | **行级**：`anchorRow/focusRow/isDragging` |
| `src/tui/input/mouse-events.ts` | SGR `?1003h` 全追踪解析器（press/drag/release/wheel + 分块缓冲）✅ 可直接复用 |
| `src/tui/input/clipboard.ts` | 跨平台 OS 命令（clip/pbcopy/xclip）✅ 可复用，**缺 OSC 52 / tmux 回退** |
| `src/tui/components/ScrollBox.tsx` | mouseup → `copySelection()` 自动复制 |
| `src/tui/components/MessageRow.tsx` | `selected` → 整行 `inverse`（SGR 7） |
| `src/render/*`（DoubleBuffer + Screen） | 自研渲染层，**不感知 selection**（charter 隔离铁律） |

### 1.2 本次目标

把行级选择升级为**字符级**，并将复制语义改为**右键触发**，补齐双击选词、三击选行、滚动捕获、OSC 52 跨 SSH/tmux 回退。

### 1.3 已确认的需求决策（用户逐项拍板）

| 维度 | 决策 |
|---|---|
| 选区精度 | **字符级**（`Point = { row, col }`） |
| 复制触发 | **仅右键**（mouseup 不自动复制，只高亮） |
| 右键语义 | 复制高亮区 **+ 清除高亮** |
| 剪贴板路径 | OS 命令 **+ OSC 52 回退**（+ tmux 中间层） |
| 双击/三击 | **双击选词 + 三击选行** |
| 滚动捕获 | **做**（拖拽自动滚动 + 滚出行文本缓存） |
| 高亮层 | **Ink 层逐字符切片**（render/ 层零改动） |
| 缩进/前缀 | **缩进 + 前缀都参与选区**（终端原生语义） |
| 流式块 | **不可选**（未 finalized 的 assistant 流式块） |
| 多行形状 | **L 型选择**（首末行部分选中，中间整行）；`selectionRect()` 返回的外包矩形 minCol/maxCol 仅用于快速 rowIntersects 判断，真正的 L 型列范围由 `colsForRow` 实现 |
| 多击间隔 | **300ms 固定**，位置偏差 ≤2 格算同位置 |
| OSC 52 超长 | **不裂包**，一次写 |

---

## 2. 架构总览

### 2.1 两套渲染层与方案选择

项目有两套渲染设施：

- **`src/tui/*`（Ink/React）**：`<MessageRow>` 用 `inverse` prop 做高亮。Ink 输出经 `yoga-walk` 栅格化进 `Screen`。
- **`src/render/*`（自研 DoubleBuffer）**：`USE_DOUBLE_BUFFER` feature flag 默认开启，把 Ink 输出栅格化进 `Screen` cell 网格再 diff emit。**该层不持有任何业务状态**（charter 铁律）。

**结论：字符级高亮走 Ink 层**（方案 A）。理由：

1. **复用至上**——Ink → yoga-walk → Screen 管线已能正确栅格化 `inverse` 片段，无需让 `render/` 感知业务。
2. **隔离不破**——不让 `render/` 层知道 selection，保持其纯渲染职责。
3. **退路保留**——`USE_DOUBLE_BUFFER=0`（回退 Ink 原生 renderer）时方案 A 仍工作；若在 render/ 层做高亮则会哑火。
4. **滚动捕获适配**——选区用「屏幕行列」坐标，与 Screen 的瞬时 cell 状态解耦，滚动时只需调行号映射。

### 2.2 模块边界

```
┌─ src/tui/selection/（新目录，纯逻辑层，无 React/Ink/stdout）─┐
│  click-detector.ts    多击分类（纯函数 + state）              │
│  slice-line.ts        单行按选区切片（CJK 钳位）              │
│  get-selected-text.ts 选区→文本提取（L 型 + 缓存拼接）         │
│  word-boundary.ts     词边界识别（双击选词用）                 │
└──────────────────────────────────────────────────────────────┘
        ↑ 单向依赖
┌─ src/tui/state/selection-store.ts（重写）───────────────────┐
│  Point{row,col} + scrolledOff 缓存 + anchorSpan              │
│  纯数据 store，不含渲染逻辑                                    │
└──────────────────────────────────────────────────────────────┘
        ↑
┌─ src/tui/components/ScrollBox.tsx（改）─────────────────────┐
│  事件路由：mousedown/drag/up + 右键 + 多击 + 滚动捕获         │
│  调 writeClipboard（走 clipboard.ts）                         │
└──────────────────────────────────────────────────────────────┘
        ↑ 注入 globalRow + selectionStore
┌─ src/tui/components/MessageRow.tsx（改）────────────────────┐
│  调 sliceLineBySelection 做字符切片高亮                       │
└──────────────────────────────────────────────────────────────┘
        ↑ 独立
┌─ src/tui/input/clipboard.ts（重写）─────────────────────────┐
│  OS 命令 → tmux → OSC 52 三级回退                             │
└──────────────────────────────────────────────────────────────┘
```

**边界铁律**：`selection/` 目录纯逻辑，可被任何层调用、可单测。三者单向依赖无环。

---

## 3. 详细设计

### 3.1 数据模型（selection-store 升级）

**物理本质**：从「行号记录簿」升级为「二维坐标记录簿」。

```ts
// src/tui/state/selection-store.ts

/** 屏幕坐标点（0-based：row 全局行，col 显示列，CJK 全角=1 col 由 string-width 算） */
export interface Point { row: number; col: number; }

export type ClickKind = 'single' | 'double' | 'triple';

export interface SelectionState {
  /** 拖拽起点（null=无选区） */
  anchor: Point | null;
  /** 拖拽当前/终点 */
  focus: Point | null;
  /** 是否拖拽中 */
  isDragging: boolean;
  /** 最近一次手势的多击类型 */
  lastClickKind: ClickKind | null;
  /** 双击/三击的锚定词/行边界（手势结束后保留，决定下次拖拽语义） */
  anchorSpan: { row: number; colStart: number; colEnd: number } | null;
  /** 拖拽超出视口时，滚出视口上/下方的已选行文本缓存
   *  join 顺序：above... + viewport + ...below */
  scrolledOffAbove: string[];
  scrolledOffBelow: string[];

  // —— 操作 ——
  startDrag: (p: Point, kind?: ClickKind) => void;
  dragTo: (p: Point) => void;
  endDrag: () => void;
  /** 双击选词：在 (row, col) 上以词边界扩展。返回是否命中（lineContent 为空或 col 越界返回 false） */
  selectWordAt: (row: number, col: number, fullLineContent: string) => boolean;
  /** 三击选行：整行选中 */
  selectLineAt: (row: number, fullLineContent: string) => void;
  /** 右键复制后调用：清空选区与高亮（含 scrolledOff 缓存） */
  clear: () => void;

  // —— 查询 ——
  hasSelection: () => boolean;
  /** 选区外包矩形 {minRow,maxRow,minCol,maxCol}；无选区返回 null */
  selectionRect: () => { minRow: number; maxRow: number; minCol: number; maxCol: number } | null;
  /** 某行是否与选区相交（MessageRow 据此决定是否走切片路径） */
  rowIntersects: (row: number) => boolean;
  /** 某行的选区列范围 [start, end)（end 不含端点）；行不在选区返回 null。
   *  L 型语义：首末行取实际列范围，中间整行返回 [0, lineWidth]。*/
  colsForRow: (row: number, lineWidth: number) => { start: number; end: number } | null;
}
```

**关键设计点**：

1. **`col` 单位是显示列**（string-width 语义，CJK 全角=1 col）——与终端 SGR 鼠标的 col 语义一致。
2. **`colsForRow(row, lineWidth)` 是 MessageRow 的核心入口**——L 型语义在此实现：首行（anchor 所在行）`[anchorCol, lineWidth]`、末行（focus 所在行）`[0, focusCol]`、中间整行 `[0, lineWidth]`。`lineWidth` 由调用方（MessageRow）传入 `stringWidth(line.content)`（与 §3.2.2 的 `displayWidth` 同义，统一为 `stringWidth`），让 store 不必知道每行多宽。单行选区（minRow==maxRow）时首末行合一，返回 `[min(anchorCol,focusCol), max(anchorCol,focusCol)]`。
3. **`scrolledOffAbove/Below` 是滚动捕获的载体**——拖拽自动滚动时由 ScrollBox 填充，mouseup 冻结，clear 清空。
4. **`anchorSpan` 记录词/行选区**——后续若 Shift+click 扩展选区可据此判断（本期 YAGNI 不做，但字段预留避免 store 频繁改形状）。

**YAGNI**：矩形选区、Shift+click 扩展、选区跨会话持久化。

### 3.2 高亮渲染（MessageRow 逐字符切片）

**物理本质**：把一行文本切成「选区前 / 选区内 / 选区后」三段，中间段加 `inverse`。

#### 3.2.1 切片纯函数

```ts
// src/tui/selection/slice-line.ts

export interface LineSelectionRange { startCol: number; endCol: number; } // [start, end)

/**
 * 把一行 content 按 [startCol, endCol) 切成最多 3 段。
 * 切片单位：显示列（string-width）。
 *
 * CJK 钳位规则：若切片点落在全角字符中间，
 *  - startCol 向左钳到该字符起点（保证不切坏字符）
 *  - endCol   向右钳到该字符终点
 * 选区可能比拖拽位置少半个字符，但永不出现半字。
 */
export function sliceLineBySelection(
  content: string,
  range: LineSelectionRange | null,
): Array<{ text: string; selected: boolean }>;
```

**CJK 钳位算法**：用 `string-width` + 码点序列 `[...content]` 建立累积宽度表，按显示列定位切片点，落在全角字符中间时按规则钳位。复用 `cursor-position.ts` 已验证的 `stringWidth` + 码点迭代模式。

#### 3.2.2 MessageRow 改造

```tsx
// src/tui/components/MessageRow.tsx
// （需 import stringWidth from 'string-width'，与 cursor-position.ts 一致）
export function MessageRow({ message, globalRow, selectionStore }: MessageRowProps) {
  // 流式分支：不参与选区，早返回（保持现状）
  if (!message.finalized && message.role === 'assistant' && message.streamingText !== undefined) {
    return <Box flexDirection="column"><StreamingMarkdown text={message.streamingText} /></Box>;
  }

  return (
    <Box flexDirection="column">
      {message.lines.map((line, i) => {
        const cols = selectionStore.getState().colsForRow(globalRow, stringWidth(line.content));
        const segs = sliceLineBySelection(line.content, cols);
        const props = styleToInkProps(line.style);
        return (
          <Text key={i} {...props}>
            {segs.map((seg, j) =>
              seg.selected
                ? <Text key={j} {...props} inverse>{seg.text}</Text>
                : <Text key={j} {...props}>{seg.text}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
```

**关键设计点**：

1. **缩进 + 前缀都参与选区**——`FormattedLine.content` 含缩进空格和前缀（●/⎿/❯）。SGR 鼠标的 col 是屏幕绝对列，content 从屏幕 col 0 开始，故屏幕列 == content 内列，**无需坐标转换**。
2. **流式块不参与选区**——streaming 分支早返回，不读 selectionStore。用户要复制流式内容，等 `finalized=true` 转 `lines` 后再选。
3. **性能 mitigation**：
   - `colsForRow` 返回 null 时（行不在选区），`sliceLineBySelection` 返回单段不切片，无损耗。
   - **只有与选区相交的行**走切片路径。`globalRow` 由 ScrollBox 注入。
   - 选区稳定时（mouseup 后）store 不变，MessageRow 不重渲染。

### 3.3 文本提取（getSelectedText）+ 滚动捕获

**物理本质**：复制 = 把选区覆盖的所有屏幕格子的字符按行拼成纯文本。终端标准语义是 **L 型选择**：

- **单行**（minRow == maxRow）：取 `[minCol, maxCol)`。
- **多行**：
  - 首行（anchor 所在行）：取 `[anchorCol, 行尾]`
  - 中间行：整行
  - 末行（focus 所在行）：取 `[行首, focusCol)`
  - 拖拽方向（向上 vs 向下）决定首末归属。

#### 3.3.1 屏幕行 → 消息行映射

选区坐标是屏幕全局行（0-based，含 `LOGO_ROWS` 偏移）。文本存在 `messagesStore` 的 `TuiMessage.lines[]`。`getSelectedText` 复用 ScrollBox 的同一套映射：

```
屏幕全局行 row  →  (messageIndex, lineIndexInMessage)
                  via  row - LOGO_ROWS - scrollTop  →  消息内线性行号
```

#### 3.3.2 滚动捕获（scrolledOffAbove/Below）

**触发时机**：拖拽中（`isDragging=true`），focus.row 超出视口上界或下界。

**ScrollBox 责任**：

1. focus.row < `viewportTopRow` → 自动上滚 `scrollTop--`。
2. focus.row > `viewportBottomRow` → 自动下滚 `scrollTop++`。
3. 滚动用 **setInterval(80ms)** 驱动（匀速滚动）；focus 离开边界或 mouseup 时停。
4. 每次滚动后，把**滚出视口的整行文本**塞进 `selection.scrolledOffAbove/Below`。

**文本拼接**：

```
最终文本 = scrolledOffAbove.join('\n')
         + 视口内相交行的切片文本（L 型）
         + scrolledOffBelow.join('\n')
```

**缓存去重权衡**（实现期验证点）：拖拽中可能多次上下滚导致缓存重复。本期采用**简单方案**：缓存只在「focus 在该侧边界外」时追加；`getSelectedText` 在拼接后按行去重排序（用 row 标签）。若实测重复严重，退化为每次 focus 进入新区域时清空对侧缓存重新累积。spec 标注此为实现期验证项。

#### 3.3.3 getSelectedText 算法

```ts
// src/tui/selection/get-selected-text.ts
export function getSelectedText(params: {
  messages: TuiMessage[];
  scrollTop: number;
  visibleRows: number;
  viewportTopRow: number;  // = LOGO_ROWS + scrollTop
  selection: SelectionState;
}): string;
```

**流式块落地**：`mapRowToMessage` 命中流式块（`!finalized && streamingText !== undefined`）时该行返回空文本，选区跳过流式块（与 §3.2.2 决策一致）。

### 3.4 鼠标事件路由 + 右键复制

#### 3.4.1 事件路由表

| 事件 | button | 新行为 |
|---|---|---|
| mousedown | 0（左键） | `startDrag({row,col}, clickKind)`（含多击检测） |
| mousedrag | 0+motion | `dragTo({row,col})` + 滚动捕获 |
| mouseup | 0 | 仅 `endDrag()`（**不复制**） |
| mousedown | 2（右键） | **复制 + 清高亮** |
| wheelup/down | 64/65 | 滚动（不变，但 `isDragging` 时禁用） |

#### 3.4.2 多击检测

SGR 鼠标不直接报双击，需应用层检测：同一位置、300ms 内的连续 mousedown 计数。

```ts
// src/tui/selection/click-detector.ts
const DOUBLE_CLICK_MS = 300;
const CLICK_SLOP = 2;  // 位置偏差 ≤2 格算同位置

export function classifyClick(
  state: ClickState | null,
  button: number, row: number, col: number, now: number,
): { kind: ClickKind; state: ClickState };
```

- **双击**（count==2）→ `selectWordAt(row, col, lineContent)`
- **三击**（count==3）→ `selectLineAt(row, lineContent)`

#### 3.4.3 词边界（双击选词）

```ts
// src/tui/selection/word-boundary.ts
/** 以 col 为中心，向左右扩展到非词字符边界。
 *  词字符：字母、数字、下划线、CJK。
 *  非词字符：空格、标点、ANSI 前缀符（●⎿❯）。
 *  返回 [startCol, endCol)。*/
export function findWordBounds(content: string, col: number): { start: number; end: number };
```

#### 3.4.4 右键复制

```ts
// ScrollBox onData 内
if (ev.type === 'mousedown' && ev.button === 2) {
  void copyOnRightClick(...);
}
async function copyOnRightClick(...) {
  const text = getSelectedText(...);
  if (text) {
    await writeClipboard(text);      // clipboard.ts（含 OSC 52 回退）
    selectionStore.getState().clear();
  }
}
```

**右键无选区**：什么都不做（不报错、不弹菜单）。**clipboard 失败**：静默，高亮照清（clear 仍执行，用户看到选区消失）。

### 3.5 OSC 52 + clipboard.ts 升级

**物理本质**：从单条 OS 命令路径升级为**三级回退链**。

```
writeClipboard(text)
  ├─ 1. 本地（非 SSH）→ OS 命令（clip/pbcopy/xclip）—— 现有
  ├─ 2. tmux 环境 → tmux load-buffer -w（转发外层终端）
  └─ 3. 通用回退 → OSC 52 序列（ESC ] 52 ; c ; <base64> BEL）
```

```ts
// src/tui/input/clipboard.ts
const SSH_CONNECTION = !!process.env.SSH_CONNECTION || !!process.env.SSH_TTY;
const TMUX = !!process.env.TMUX;

export async function writeClipboard(text: string): Promise<void> {
  if (!SSH_CONNECTION) {
    try { await copyNative(text); return; } catch { /* 落下一级 */ }
  }
  if (TMUX) {
    try { await tmuxLoadBuffer(text); return; } catch { /* 落 OSC 52 */ }
  }
  osc52(text);
}

function osc52(text: string): void {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}
```

**实现期验证点**：OSC 52 写 `process.stdout`（非 Ink output channel），需确认自研 renderer 下一帧不覆盖该序列。OSC 52 是 DCS 转义序列，Ink diff emit 只写 cell diff，不重写 DCS，预期不冲突。若实测被覆盖，改在 renderer commit hook 后写。

**长度上限**：本期不裂包（一次写），现代终端（Windows Terminal/iTerm2/Alacritty）支持任意长度。超长文本（>100KB）在极端旧终端可能截断，接受此限制。

**依赖**：Buffer + spawn 全部 Node 内置，不引第三方库（charter 要求）。

---

## 4. 文件清单

### 4.1 新增（4 源 + 4 测试）

| 文件 | 职责 |
|---|---|
| `src/tui/selection/click-detector.ts` | 多击分类纯函数 |
| `src/tui/selection/slice-line.ts` | 单行选区切片（CJK 钳位） |
| `src/tui/selection/get-selected-text.ts` | 选区→文本（L 型 + 缓存拼接） |
| `src/tui/selection/word-boundary.ts` | 词边界（双击选词） |
| `src/__tests__/tui/selection/click-detector.test.ts` | 多击时序（fake timers） |
| `src/__tests__/tui/selection/slice-line.test.ts` | 切片 + CJK 钳位 |
| `src/__tests__/tui/selection/get-selected-text.test.ts` | L 型 + 缓存拼接 |
| `src/__tests__/tui/selection/word-boundary.test.ts` | 词边界识别 |

### 4.2 修改（4 源 + 2 测试）

| 文件 | 改动 |
|---|---|
| `src/tui/state/selection-store.ts` | **重写**：anchorRow/focusRow → anchor/focus:Point；加 scrolledOff/anchorSpan/selectWord/selectLine/colsForRow/selectionRect/rowIntersects |
| `src/tui/components/ScrollBox.tsx` | 事件路由：右键复制、多击检测、滚动捕获；移除 mouseup 自动复制；给 MessageRow 注入 globalRow |
| `src/tui/components/MessageRow.tsx` | 字符切片高亮（调 sliceLineBySelection） |
| `src/tui/input/clipboard.ts` | 加 OSC 52 + tmux 回退 |
| `src/__tests__/tui/selection-store.test.ts` | 适配 Point 模型 |
| `src/__tests__/tui/clipboard.test.ts` | 加 OSC 52/tmux 回退测试 |

---

## 5. 测试策略（TDD 铁律）

- **纯逻辑层**（click-detector / slice-line / word-boundary / get-selected-text）：100% 单测。fake timers 测多击时序；CJK 测切片钳位；L 型测多行提取；缓存测拼接去重。
- **selection-store**：单测覆盖所有新 action/query（Point 模型、colsForRow 边界、scrolledOff 累积/清空）。
- **clipboard.ts**：单测覆盖 OSC 52 序列格式（mock stdout，断言 `\x1b]52;c;<b64>\x07`）；tmux 路径 mock spawn。
- **组件层**（ScrollBox/MessageRow）：ink-testing-library smoke——渲染不崩、右键触发复制（mock clipboard）。深度交互测试（真实鼠标序列驱动）退化为集成测试或手动验证（与现有 `mouse-events.test.ts` 一致的权衡）。

**命令**：`npm test`（vitest run）、`npm run typecheck`、`npm run build`。

---

## 6. 防御边界（charter 极致防御）

依据 charter「极致防御」+「场景触发」，识别高频崩溃边界：

1. **空选区复制**：右键时无选区 → `getSelectedText` 返回 '' → 不调 writeClipboard，不 crash。
2. **流式块被选**：`mapRowToMessage` 命中流式块返回空文本，选区跳过，不 crash。
3. **CJK 半字切割**：钳位规则保证永不切在全角字符中间。
4. **OSC 52 失败**：stdout.write 抛错时静默 catch（极端：stdout 已关闭）。
5. **tmux 命令不存在**：spawn ENOENT → catch → 落 OSC 52。
6. **拖拽中进程退出**：ScrollBox cleanup 时清 setInterval，selectionStore clear（防泄漏）。
7. **selection 坐标越界**：`colsForRow`/`selectionRect` 对 row/col 越界返回 null/钳位，不抛错。

---

## 7. 实现期验证点（spec 标注，非 TODO）

- **scrolledOff 缓存去重策略**（§3.3.2）：先实现简单追加 + 拼接时去重；实测重复严重再改清空策略。
- **OSC 52 与 renderer 时序**（§3.5）：实测 OSC 52 写入后下一帧是否被覆盖；若覆盖改 commit hook 写入。
- **MessageRow 切片性能**（§3.2.2）：大量小 `<Text>` 片段的 diff 开销；Ink + DoubleBuffer 应能去重，实测若卡顿再 memo。

---

## 8. 不做的事（YAGNI）

- ❌ 矩形选区（Alt+drag）
- ❌ Shift+click 扩展选区
- ❌ 选区跨会话持久化
- ❌ OSC 52 超长分块
- ❌ 多击间隔动态配置
- ❌ 右键上下文菜单（复制/全选/清除）
- ❌ 选区拖放（drag-and-drop）

---

## 9. 与 Claude Code 实现的差异说明

| 方面 | Claude Code | 本项目 |
|---|---|---|
| 高亮层 | render 层 `applySelectionOverlay(screen, sel)` 翻 cell inverse 位 | Ink 层 `<Text inverse>` 逐字符切片 |
| 复制触发 | 选中即复制（`copyOnSelect: true`，iTerm2 默认） | **右键触发** |
| 右键语义 | 无（选中即复制已足够） | 复制 + 清高亮 |
| Screen 角色 | 选区直接读写 Screen cell | Screen 不感知选区（charter 隔离） |
| 多击 | 双击选词、三击选行 | 同 |
| 滚动捕获 | `scrolledOffAbove/Below` | 同（独立文本缓存，不依赖 Screen） |

差异主要源自本项目「render 层不持有业务状态」的 charter 铁律，以及用户明确的「右键复制」需求。
