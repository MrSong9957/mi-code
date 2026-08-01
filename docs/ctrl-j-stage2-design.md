# 第二阶段设计:输入框动态 1–5 行高度(物理行模型)

> 分支:`fix/ctrl-j-multiline-input`(基于 `a76bc25`)
> 状态:**设计修订完成,所有决策已收敛,未实现**
> 前置:第一阶段(`a76bc25`)已修复多行纵向分行,真实终端验收通过
> 日期:2026-08-01

## 目标契约

```ts
visibleRows = clamp(physicalInputRows, 1, MAX_VISIBLE_INPUT_LINES);  // MAX = 5
```

`physicalInputRows` 由**应用层折行算法**(`wrapLine`)产出,同时考虑:显式 `\n`、终端宽度自动折行、首行 prompt 宽度、续行缩进宽度、CJK/宽字符、ANSI 样式。

**核心原则(本次修订):采用物理行模型。** 布局函数必须产出**实际可渲染的物理行字符串数组**,Footer 直接逐行渲染,**不再依赖终端 DECAWM 自动折行**。高度、viewport、光标定位、渲染四者必须共用**同一个** wrapping/显示宽度算法,避免分别计算导致不一致。

## 行为要求

- 空输入 / 单行 → 1 行
- Ctrl+J 加一行 → 2 行
- 持续增加 → 最高 5 行
- 超过 5 行 → 保持 5 行 + 视口滚动(光标居中)
- 删除换行/文本 → 高度缩回
- resize → 重新计算物理行数和高度
- 光标始终在输入框边框内
- **一个逻辑行折成超过 5 个物理行时**:高度保持 5 行,viewportTop 跟随光标滚动

## 现状(第一阶段后)

输入区**固定撑到 5 行**(不足补空行)。`MAX_VISIBLE_INPUT_LINES=5` 在 6 个文件硬编码:

| 文件 | 用途 | 动态化影响 |
|---|---|---|
| `input-viewport.ts:16` | 常量定义 | 保留(作为上限) |
| `App.tsx:78-79` | `footerRows = FOOTER_ROWS + spinner + (MAX-1)` | 改为 `(visibleRows-1)` |
| `App.tsx:85-87` | `computeInputViewport(逻辑行, cursor, MAX)` | 改用新布局函数 |
| `ConnectedApp.tsx:162-164` | 同 App 的 footerRows/inputRowY 计算 | 同步改 |
| `InlineAppV2.tsx:184-187` | 同 App 的视口计算 | 同步改 |
| `Footer.tsx:53,56,60` | 切片上限/补空行/下边框行号 | 删补空行,用 visibleRows + 物理行 |
| `FooterV2.tsx:60,63,66` | 同 Footer | 同步改 |

**inputRowY 不依赖 MAX**(= scrollbox + LOGO + spinner + 1),改输入区高度**不影响 inputRowY**,只影响 footerRows 和下边框位置。

## 共享算法基础(复用,不重造)

| 已有函数 | 位置 | 作用 |
|---|---|---|
| `wrapLine(text, usableWidth)` | `src/tui/state/wrap-line.ts:45` | 应用层 wordWrap,英文按空格/CJK 按字符,ANSI/CJK 感知,产出物理行字符串数组 |
| `getUsableWidth(cols)` | `wrap-line.ts:23` | 统一可用宽度 `cols - 1` |
| `computeInputViewport` | `input-viewport.ts:45` | 光标居中滚动逻辑 |
| `clampScrollTop` | `scroll-state.ts` | 钳位 |

**关键:不再用 `physicalLineCount`(它只数行数不产出可渲染字符串)。** 新布局函数必须调 `wrapLine` 产出实际物理行,这样渲染、计数、光标定位共用同一份折行结果,不存在"算法分叉"。

## 新增纯函数(唯一布局来源)

文件:`src/tui/state/input-viewport.ts`(扩展现有文件,布局逻辑单一真理源)

```ts
export interface InputViewportLayout {
  /** 物理行总数(应用层折行后,含 \n 与折行,≥1) */
  physicalRowCount: number;
  /** 实际渲染的可见行数 = clamp(physicalRowCount, 1, maxVisible) */
  visibleRowCount: number;
  /** 视口顶部物理行号(0-based,超 maxVisible 时跟随光标滚动) */
  viewportTop: number;
  /** 渲染用的可见物理行(已切好,Footer 直接 map,每行已是可渲染字符串) */
  visibleLines: string[];
  /** 每个可见行是否是"逻辑行首行"(决定显示 prompt 还是续行缩进) */
  visibleLineKinds: Array<'first' | 'continuation'>;
  /** 光标所在的可见物理行号(0-based,相对视口,用于光标定位) */
  cursorVisibleRow: number;
  /** 光标在可见物理行内的列(0-based,含前缀,用于光标 x 定位) */
  cursorVisibleCol: number;
}

export function computeInputViewportLayout(
  input: string,
  cursor: number,
  cols: number,
  firstLinePrefixWidth: number,   // 首行 prompt 宽度(来自共享常量)
  continuationPrefixWidth: number,// 续行缩进宽度(来自共享常量)
  maxVisible: number = MAX_VISIBLE_INPUT_LINES,
): InputViewportLayout
```

### 算法(物理行模型)

1. `logicalLines = input.split('\n')`
2. 对每个逻辑行,按其**前缀宽度**算可用宽度,调 `wrapLine` 产出物理行:
   - 逻辑行 i=0 的物理行:首物理行 budget = `getUsableWidth(cols) - firstLinePrefixWidth`,续物理行 budget = `getUsableWidth(cols)`(因为只有该逻辑行的第一个物理行带 prompt)
   - 逻辑行 i>0 的物理行:首物理行 budget = `getUsableWidth(cols) - continuationPrefixWidth`,续物理行 budget = `getUsableWidth(cols)`
   - 记录每个物理行的 kind('first'=逻辑行首 / 'continuation'=折行续)
3. 拼成 `allPhysicalLines: string[]` + `allKinds: Array<'first'|'continuation'>`
4. `physicalRowCount = allPhysicalLines.length`
5. `visibleRowCount = clamp(physicalRowCount, 1, maxVisible)`
6. 光标定位:遍历物理行累计码点,找到 cursor 落在哪个物理行 + 行内列(用 stringWidth,CJK 感知)
7. `viewportTop`:当 `physicalRowCount > maxVisible` 时,用光标居中公式(`cursorRow - floor(maxVisible/2)` 钳到 `[0, physicalRowCount-maxVisible]`);否则 0
8. `visibleLines = allPhysicalLines.slice(viewportTop, viewportTop + visibleRowCount)`
9. `visibleLineKinds = allKinds.slice(viewportTop, viewportTop + visibleRowCount)`

**渲染、计数、光标、viewport 全部基于 `allPhysicalLines` 这一份折行结果,无算法分叉。**

## promptWidth 共享常量(不硬编码)

新增常量文件或扩展现有(如 `src/tui/state/input-viewport.ts` 或专门的 layout 常量):

```ts
export const PROMPT = '❯ ';
export const CONTINUATION_INDENT = '  ';
// 宽度从字符串计算,不硬编码 2——若 prompt 改样式,宽度自动跟随
export const PROMPT_WIDTH = stringWidth(PROMPT);
export const CONTINUATION_INDENT_WIDTH = stringWidth(CONTINUATION_INDENT);
```

Footer/FooterV2 和布局函数都从这些常量取宽度和前缀字符串,不再各自硬编码 `❯ ` / `'  '`。

## 消费点改造

### App.tsx / ConnectedApp.tsx / InlineAppV2.tsx
```ts
const layout = computeInputViewportLayout(input, cursor, cols, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);
const inputViewportExtraLines = layout.visibleRowCount - 1;
const footerRows = FOOTER_ROWS + spinnerRows + inputViewportExtraLines;
// inputRowY 不变(不依赖输入区高度)
// 传 layout 给 Footer/FooterV2
```

### Footer.tsx / FooterV2.tsx
```tsx
// 删除 input.split + slice + 补空行 三段逻辑
// 改为消费 props.layout:
const { visibleLines, visibleLineKinds, visibleRowCount, cursorVisibleRow, cursorVisibleCol } = layout;
const lowerBorderRow = inputRowY + visibleRowCount;  // 动态
// visibleLines.map((line, i) => 前缀用 visibleLineKinds[i]==='first' ? PROMPT : CONTINUATION_INDENT)
// 不补空行,渲染实际行数
```

## 历史区契约(本次修订明确)

**接受:输入区增高时历史区最多缩小 4 行(MAX_VISIBLE_INPUT_LINES - 1)。** 补充以下契约保证体验:

1. **底部锚定**:输入区增高时,footer 钉在底部(flexShrink=0 已保证),输入区从底部向上撑高,历史区从底部被挤压(顶部 LOGO 不动)。
2. **向上滚动保持**:历史区被挤压时,若用户原本滚动在底部(看最新消息),挤压后仍应保持能看到最新消息——即 ScrollBox 的 scrollTop 需在输入区增高时**跟随调整**,避免最新消息被挤出可视区。具体:当 `footerRows` 增大导致 `visibleRows` 减小时,若 `scrollTop + visibleRows > totalMessages`,将 scrollTop 钳到 `max(0, totalMessages - visibleRows)`。
3. **resize 钳位**:终端 resize 改变 cols/rows 时,重新计算 `physicalRowCount`(折行可能变)和 `visibleRows`,scrollTop 同样按上述公式钳位,确保不越界。

**说明**:第 2 点(向上滚动保持)依赖 ConnectedApp 的 scrollTop 受控逻辑在 `visibleRows` 变化时执行上述钳位公式。这是已确定的契约实现要求,不属于可选项,列入 `src/tui/ConnectedApp.tsx` 的修改清单。

## 不修改

- Ctrl+J 输入处理(use-input-handler.ts)
- input store
- paste 路径
- Enter 提交
- `wrapLine` / `getUsableWidth` 算法本身(只复用,不改)

## 预计修改文件

| 文件 | 改动 |
|---|---|
| `src/tui/state/input-viewport.ts` | 新增 `computeInputViewportLayout` + `InputViewportLayout` 接口 + prompt 常量 |
| `src/tui/App.tsx` | 用 layout 算 footerRows,传 layout 给 Footer |
| `src/tui/ConnectedApp.tsx` | 同步 App 的改动 + scrollTop 钳位配合 |
| `src/tui/inline-v2/InlineAppV2.tsx` | 同步视口计算 |
| `src/tui/components/Footer.tsx` | 消费 layout,删补空行,物理行渲染,动态下边框 |
| `src/tui/inline-v2/FooterV2.tsx` | 同步 Footer |
| 测试 | RED 用例 + 现有测试适配 |

## TDD 顺序(实现阶段)

按需求用例依次 RED→GREEN:

1. 空输入/单行 → 1 行
2. `AAA\n888` → 2 行
3. 5 行 → 5 行
4. 6 行 → 5 行 + 滚动
5. 删换行 → 2→1
6. 长文本自动折行 → 动态增高(物理行模型下,折行确实增高)
7. CJK 宽字符折行(stringWidth=2,折行正确)
8. resize 重算(cols 变 → 折行变 → 行数变)
9. Footer === FooterV2 结果一致(同一布局函数)
10. 光标不落边框/状态栏
11. **(新增)一个逻辑行折成 >5 个物理行**:高度仍 5 行,viewportTop 跟随光标滚动,光标始终在可见区
12. **(新增)向上滚动保持**:输入区增高挤压历史区时,最新消息保持可见(scrollTop 钳位)

## 决策点(全部已收敛)

1. **物理行 vs 逻辑行** → 物理行(本设计)
2. **历史区挤压** → 接受最多 4 行 + 底部锚定 + 向上滚动保持 + resize 钳位
3. **promptWidth 硬编码** → 共享常量从字符串计算,first-line 与 continuation 宽度分别传入
4. **向上滚动保持** → ConnectedApp scrollTop 受控逻辑在 visibleRows 变化时执行钳位公式(已列入修改清单)

---

**当前状态:设计修订完成,所有决策已收敛。未实现任何代码。**
