# 第二阶段实施计划(修订版 2):输入框动态物理行模型

> 基线 `d24b022`(设计文档提交;`git log` 核实,前次误写 d76bc22)。本计划为可执行蓝图,待批准后按 TDD 步骤推进。
> 所有结论基于真实源码核实,无 stub/待核对。
> 状态:**等待批准,未开始编码。**

## 0. 核实结论(决策依据)

| 阻断项 | 核实结论 | 源码证据 |
|---|---|---|
| **wrapping 核心** | `wrapLine` 内部已是 `StyledChar[][]`(`lines: StyledChar[][]`,L52),最终 `lines.map(styledCharsToStringSafe)` 才转字符串。**断行点已显式 slice `beforeSpace`/`afterSpace`(L74-82)**——每个物理行在转字符串前就持有逐字符的源信息。故"扩展核心直接产出 spans"可行,不必反推 offset | `wrap-line.ts:45-132`;本轮 grep 核实 |
| cursor 单位 | 码点索引(`[...text].length`);`text.slice(0,cursor)` 用字符串偏移(UTF-16)。BMP(含 CJK、组合符 U+0301)一致;**仅代理对(emoji,>0xFFFF)slice 错位**。范围采用 B,见 §0a | `input-store.ts:64,71,82-85` |
| SelectionText 选区 | 基于 `globalRow`+`stringWidth(content)` 列范围,与源 offset 无关 | `SelectionText.tsx:62-77` |
| 双重 layout | ConnectedApp(`L162-164`)和 App(`L78-87`)各算一遍,须单算透传 | 真实读取确认 |
| 前缀语义 | 当前 Footer 对软折行已正确,但 `physicalLineCount` 把每逻辑行首当前缀行(错) | `Footer.tsx:77`;`input-viewport.ts:77-88` |
| scroll 钳位缺陷 | `ConnectedApp.tsx:167` `scrolledAway?scrollTop:maxScroll` 未调 `clampScrollTop`,visibleRows 变化致旧 scrollTop>maxScroll 时越界 | `ConnectedApp.tsx:165-167` |
| wrapLine 行为基线 | 空格断行**丢弃空格不进下一行**(已固化:`'hello world'`→`['hello','world']`)。故空格 sourceStart/End 归属**前一行区间尾部**(见 §2a) | `wrap-line.ts:74-82`;`wrap-line.test.ts:40-48` |
| getUsableWidth | `cols-1` | `wrap-line.ts:23` |
| InlineAppV2 历史 | 在 `<Static>` scrollback,footer 变高不挤压;scroll 契约仅适用 ConnectedApp | `InlineAppV2.tsx:206-239` |

**关键**:物理行 content 是已折好字符串,宽度自洽,SelectionText 接口无需改——**无源 offset 反推问题**。

### 0a. cursor 契约 —— 范围决策:**采用 B**(本轮用户已批准)

**现状事实**(已核实,非假设):
- store cursor 是码点索引(`[...text].length`,`input-store.ts:64,71,82-85`);
- 对 BMP 字符(含 CJK,中文在 BMP),码点索引与字符串偏移一致;
- `text.slice(0,cursor)` 用字符串偏移(UTF-16 单元);对 BMP 码点(≤0xFFFF,含组合符 U+0301)与码点偏移**一致**,不切错;
- **真正 `slice` 错位只发生在代理对(emoji,U+1F600 等 > 0xFFFF)**:slice 落在代理对中间会产生孤立代理(`'a😀b'.slice(0,2)` 劈开 `😀`)。**这是既有缺陷,本计划不修。**

> **勘误**:前版文档误称"组合字符 `e\u0301` 属于 UTF-16 slice 错位"——**错误**。U+0301 在 BMP(769 ≤ 0xFFFF),UTF-16 单元=1,slice 与码点偏移一致,**不切错**。组合字符的真正问题是 **grapheme cluster 光标语义**(用户感知 `é`=1 字但码点=2,光标移动语义),属另一类问题,本阶段不处理。

**采用 B 方案(本轮批准)**:
- **保证范围**:ASCII、BMP CJK、换行(`\n`)的 cursor offset 一致性与光标定位;
- **排除(不保证)**:
  1. **非 BMP offset 一致性**:代理对(emoji)的 `text.slice` 错位(既有缺陷,不修);
  2. **grapheme cluster 光标语义**:组合字符(`e\u0301`)按码点而非按用户感知字移动,本阶段不引入 grapheme segmenter。
- **不宣称**:完整 Unicode 编辑支持、完整 Unicode 光标支持;
- **不修**:input-store 既有缺陷;
- layout 源区间用**码点遍历产出**(`[...input]` 索引),对 BMP(含 CJK、组合字符)与 store 一致;对非 BMP 因 store 已有 slice 错位仍不保证。

**后续独立任务登记**(不在本阶段,不在此计划实现):
- Task-U1:input-store cursor 一致性修复(代理对 slice 错位);
- Task-U2:grapheme cluster 光标语义(引入 Intl.Segmenter,组合字符/emoji 按用户感知字移动)。

→ **不存在"RED 长期失败后继续执行"**:Step 1 全部用例(均在 ASCII/CJK/换行保证范围内)必须 GREEN 才前进。

## 1. 修改文件清单

**生产(7)**:
| 文件 | 改动 |
|---|---|
| `src/tui/state/wrap-line.ts` | **扩展 wrapping 核心**:提取 `wrapCore`(含 srcOffset 记账),新增 `wrapLineWithSpans(line, firstWidth, contWidth)` 产出 `WrappedSpan[]`(首行/续行不同宽度);`wrapLine(line, w)` 改调 `wrapLineWithSpans(line, w, w).map(.text)` |
| `src/tui/state/input-viewport.ts` | 新增 `InputPhysicalRow`/`InputViewportLayout` 接口、`computeInputViewportLayout`、prompt 常量;调 `wrapLineWithSpans` 拼装 `allRows`;迁移期保留旧函数至 Step 13 |
| `src/tui/App.tsx` | 删本地计算(`L78-87`),接收 `layout` prop |
| `src/tui/ConnectedApp.tsx` | 单算 layout + 修钳位(`L167`) |
| `src/tui/inline-v2/InlineAppV2.tsx` | useMemo 缓存 layout |
| `src/tui/components/Footer.tsx` | 消费 layout;**删除 raw `input`/`cursor` props**(改用 layout 的 cursorVisibleRow/Col);删 `cursorScreenPos` 调用 |
| `src/tui/inline-v2/FooterV2.tsx` | 同 Footer,**删 raw `input`/`cursor` props** |

**测试**:
- 新增 `src/tui/state/wrap-line-spans.test.ts`(**colocate 到 `src/tui/state/`**,与 `wrap-line.test.ts` 同目录);
- 新增 `src/__tests__/tui/input-cursor-units.test.ts`、`input-physical-rows.test.ts`、`scroll-clamp.test.ts`、`connected-app-scroll.test.tsx`;
- 改 `input-viewport-e2e.test.tsx`、`continuation-indent.test.ts`、`layout.test.tsx`、`footer-v2-memo.test.tsx`;
- 删 `physical-line-count.test.ts`(Step 13 覆盖映射后)。

## 2. 数据结构与 span 产出方式

### 2a. wrapping 核心:首物理行与续行用不同宽度(接口修正)

**问题**:旧计划用单一 `usableWidth` 包装整个逻辑行,无法表达"首物理行扣 firstPrefix、续物理行扣 continuationPrefix"。修正为**按物理行序号取宽度**。

```ts
// src/tui/state/wrap-line.ts 新增
/**
 * 光标列映射:源 cursor offset(相对本逻辑行)→ 本物理行内显示列(不含前缀)。
 * 在 wrapping 断行过程中逐可见字符累计生成,覆盖被丢弃空格(空格不计显示列)。
 * cursorVisibleCol 查询此映射,**禁止从 row.text + source offset 反推**。
 * 键 = cursor 可能落点的源码点区间值,值 = 该位置在本物理行的显示列。
 */
export type CursorColMap = Record<number, number>;

export interface WrappedSpan {
  /** 该物理行的可渲染文本(含 ANSI 样式,已 styledCharsToStringSafe,不含前缀) */
  text: string;
  /** 该物理行覆盖的源码点区间起始(相对传入逻辑行的码点索引,含) */
  charStart: number;
  /** 该物理行覆盖的源码点区间结束(相对传入逻辑行的码点索引,不含) */
  charEnd: number;
  /** 折行种类:本 span 是逻辑行的首物理行='none',软折续行='soft' */
  breakKind: 'none' | 'soft';
  /**
   * 光标列映射:cursor offset(相对本逻辑行)→ 本物理行内显示列(不含前缀)。
   * 断行过程中逐可见字符累计 stringWidth 生成。
   * 包含区间内每个 cursor 落点[charStart..charEnd],及边界 charEnd(若为本 span 末)。
   * 被丢弃空格:空格 srcOffset 是 key,但其显示列 = 前一可见字符的列(空格不计列)。
   */
  cursorColMap: CursorColMap;
}

/**
 * 按显示宽度折行,产出带源码点区间的 spans。
 * 首物理行与续物理行可用不同宽度(支持首行 prompt 扣宽)。
 * 与 wrapLine() 共用同一断行循环(提取为内部 wrapCore,见 §2b)。
 *
 * @param line 单逻辑行文本(不含 \n)
 * @param firstLineWidth 首物理行可用显示宽度
 * @param continuationWidth 续物理行可用显示宽度(≥1,见极窄契约 §2e)
 */
export function wrapLineWithSpans(
  line: string,
  firstLineWidth: number,
  continuationWidth: number,
): WrappedSpan[]
```

**`wrapLine()` 兼容签名保留**:`wrapLine(line, usableWidth)` 内部调 `wrapLineWithSpans(line, usableWidth, usableWidth)`(首行=续行同宽,旧行为),`wrap-line.test.ts` 全绿作回归。

### 2b. span 在断行过程中直接产生(不事后反推)

**核心:给断行状态附加源码点索引,在断行点当场确定区间。** 不在折行完成后按字符数累计。

提取内部 `wrapCore(line, firstWidth, contWidth): WrappedSpan[]`,直接产出与 emit 一致的 span 数组(不再声明 `StyledCharWithOffset[][]` 却 emit span)。内部用 `StyledCharWithOffset` 做断行记账:
```ts
interface StyledCharWithOffset {
  ch: StyledChar;        // 原字符(含样式)
  srcOffset: number;     // 该字符在源逻辑行中的码点索引(在 tokenize 后遍历赋值)
}
```
`wrapLineWithSpans` 即 `return wrapCore(...)`;`wrapLine` 即 `wrapCore(line, w, w).map(s => s.text)`。

**断行循环(伪代码,基于现有 L48-129 改造,算法不变只增 offset 记账 + cursorColMap)**:
```
chars = styledCharsFromTokens(tokenize(line)).map((ch, i) => ({ch, srcOffset: i}))
// 注:srcOffset 用码点索引([...line] 的下标),与 input-store cursor 单位一致

let lineStart = 0          // 当前物理行起始 srcOffset
let lineWidth = firstWidth // 首物理行宽度
// cursorColMap 构建:逐可见字符累计 stringWidth,记录每个 cursor 落点的显示列
//   cursorColMap[srcOffset] = 该位置在本物理行的显示列(不含前缀)
//   空格:空格本身是 key,但其显示列 = 前一可见字符的列(被丢弃空格不计列)
//   行首 cursor(lineStart):列=0
//   行末 cursor(charEnd):列=本物理行可见字符总 stringWidth
let colMap = { [lineStart]: 0 }   // 行首 cursor → 列 0
let runningCol = 0                 // 本物理行已累计显示列

for each charWithOffset {ch, srcOffset} at idx:
  if 超宽且当前行有内容:
    if 空格断行分支(beforeSpace/afterSpace,含 trimEnd 尾部连续空格):
      // ★ nextLineStart 必须来自 nextLineChars[0],兼容 afterSpace 为空
      //   afterSpace 可能为空(如 'aa   bb' 在第二个 b 触发:此时 beforeSpace='aa   ',
      //   afterSpace='',currentChar='b')。故下一行起点 = [...afterSpace, currentChar][0]
      const nextLineChars = [...afterSpace, currentChar]
      const nextLineStart = nextLineChars[0]!.srcOffset

      // ★ visibleBefore = trimEndWithOffsets(beforeSpace):去掉尾部连续空格后的可见字符(带 offset)
      //   visibleEnd = 最后一个保留可见字符的 srcOffset + 1;若无保留字符则 = lineStart
      const visibleBefore = trimEndWithOffsets(beforeSpace)
      const visibleEnd = visibleBefore.length > 0
        ? visibleBefore.at(-1)!.srcOffset + 1
        : lineStart

      // ★ visibleWidth = widthOf(visibleBefore):只用保留的可见字符算宽,**不含被丢弃空格**
      //   (旧版错用 runningCol,它含待 trim 的空格宽度。'aa   bb' runningCol=5,但 visibleWidth=2)
      const visibleWidth = widthOf(visibleBefore)

      // ★ 从第一个被隐藏字符前的 cursor(visibleEnd)到下一行起点前(nextLineStart),
      //   全部映射到前一行可见末列(visibleWidth)。这覆盖:被丢弃空格的 srcOffset、
      //   断行处空格 srcOffset、以及边界 nextLineStart(=下一行行首 cursor,列在前一行=visibleWidth)
      for (let offset = visibleEnd; offset <= nextLineStart; offset++) {
        colMap[offset] = visibleWidth
      }

      emit {
        text: styledCharsToStringSafe(visibleBefore),  // 只渲染保留的可见字符(不含被丢弃空格)
        charStart: lineStart,
        charEnd: nextLineStart,                        // [lineStart, nextLineStart) 含被丢弃空格
        breakKind: 本行是否首物理行 ? 'none' : 'soft',
        cursorColMap: colMap,
      }

      // ★ 下一行独立建立 colMap/runningCol(基于 nextLineChars,不从旧 runningCol 继承)
      //   rebuildColumns 返回下一行当前显示宽度,赋给 runningCol
      lineStart = nextLineStart
      currentLine = nextLineChars
      colMap = { [nextLineStart]: 0 }
      runningCol = rebuildColumns(nextLineChars, colMap)  // 逐字符重算并填 colMap,返回累计宽度
    else (字符级断行,无空格):
      colMap[idx] = runningCol   // 折行点 cursor(归下一行,见 Step 6 契约)
      emit { text: styledCharsToStringSafe(currentLine),
             charStart: lineStart, charEnd: idx, breakKind: 'soft', cursorColMap: colMap }
      // ★ 完整重置:currentLine 也必须重置为 [currentChar],不得保留旧 currentLine
      const charWidth = stringWidth(currentChar.ch.value)
      lineStart = currentChar.srcOffset
      currentLine = [currentChar]
      colMap = {
        [lineStart]: 0,
        [lineStart + 1]: charWidth,
      }
      runningCol = charWidth
    lineWidth = contWidth
  else:
    currentLine.push(char)
    runningCol += stringWidth(ch.value)
    colMap[srcOffset + 1] = runningCol   // cursor 在该字符之后 → 列 = runningCol
emit 最后一行 { charStart: lineStart, charEnd: 末字符.srcOffset + 1,
                cursorColMap: colMap(含末尾 cursor=runningCol) }
```

**`aa   bb`(3 空格, cols=8 → 首行 budget=5)推演验证**:
- `aa` 累计:colMap={0:0, 1:1, 2:2}, runningCol=2
- 第1个空格(srcOffset=2):加入后 currentWidth 不超 5,记录 lastSpaceIdx;runningCol += stringWidth(' ')=1 → runningCol=3,colMap[3]=3
- 第2、3 空格(srcOffset=3,4):runningCol=4(colMap[4]=4)、runningCol=5(colMap[5]=5)
- 第1个 `b`(srcOffset=5):currentWidth+1=6 > 5 触发断行;beforeSpace=`aa   `(含3空格),afterSpace=``,currentChar=`b`
  - nextLineChars=[`b`], nextLineStart=5
  - visibleBefore=trimEnd(`aa   `)=`aa`, visibleEnd=2(`a`.srcOffset+1=2), visibleWidth=2
  - for offset in [2..5]: colMap[2]=2, colMap[3]=2, colMap[4]=2, colMap[5]=2
  - emit 行0: text=`aa`, charStart=0, charEnd=5, cursorColMap={0:0,1:1,2:2,3:2,4:2,5:2}
  - 下一行重建:lineStart=5, currentLine=[`b`], colMap={5:0}, **rebuildColumns 返回 1** → runningCol=1, colMap={5:0, 6:1}
- 第2个 `b`(srcOffset=6):currentWidth+1=2 ≤ 5 不超,加入;runningCol += 1 → **runningCol=2**, colMap[7]=2
- 循环结束 emit 行1: text=`bb`, charStart=5, charEnd=7, cursorColMap=**{5:0, 6:1, 7:2}**

**结果**:
- 行0 colMap 中 cursor=2/3/4(三个空格)均映射到列 2(= `aa` 末列),与 Step 3 wrapped span 测试 + Step 6b 全局断言一致 ✓
- 行1 colMap {5:0, 6:1, 7:2}:下一行行首 cursor=5→列 0,cursor=6(`b` 后)→列 1,cursor=7(末)→列 2 ✓

**关键不变量**:
- charStart/charEnd/cursorColMap 由断行时的 `srcOffset` 与 `runningCol` 直接决定,**不靠 text.length 或事后 stringWidth 反推**。
- cursorColMap 在 emit 时已包含本物理行所有 cursor 落点的显示列;**被丢弃空格的 srcOffset 是 key,但其列值 = 前一可见字符的列**(空格不计显示列)。
- 查询 cursorVisibleCol = 该行 prefixKind 宽度 + `cursorColMap[cursor]`,**直接读映射,不反推**。

### 2c. 单词边界空格的区间归属(基于实测,断行时确定)

**实测 wrapLine 真实产出**(本轮 vitest 探查):
- `'aa   bb'`(3 连续空格) w=5 → `["aa","bb"]`:**3 个空格全部丢弃**(`beforeSpace` 尾部 `trimEnd` 连续空格 + 断行处空格)。
- `'a b c'` w=3 → `["a","b c"]`:断行处空格丢弃,行内空格保留。
- `'hello world'` w=10 → `["hello","world"]`:断行处 1 空格丢弃。

**区间归属规则**:被丢弃空格(含连续空格 + trimEnd 尾部空格)的 srcOffset **全部归前一行 charEnd 区间内**。下一行 charStart = afterSpace 首字符(首个非丢弃可见字符)的 srcOffset。
- `'hello world'`(w=10)→ 行0 `[charStart:0, charEnd:6)` 含空格(srcOffset=5),行1 `[charStart:6, charEnd:11)` 从 `'w'`。
- `'aa   bb'`(3空格, w=5)→ 行0 `[0, 5)` 含 3 个空格(srcOffset 2,3,4),行1 `[5, 7)` 从 `'b'`。

**cursorColMap 对被丢弃空格**:这些空格的 srcOffset 是 colMap 的 key,但列值 = 前一可见字符的列(空格不计显示列)。例 `'hello world'` 行0:空格(srcOffset=5)的列 = `'o'` 后的列 = 5(不因空格 +1)。

### 2d. ANSI offset 语义(明确边界,不保证对齐)

**已核实**:`wrap-line.test.ts:118-162` 测了 ANSI(SGR 31)且含 emoji(`🤖`),仅断言**折行文本**(`stringWidth`、行数、文本内容),**不断言 offset**。

**WrappedSpan 的 offset 定义**:charStart/charEnd/cursorColMap 的 key 一律为**可见字符码点偏移**(`styledCharsFromTokens(tokenize(line))` 产出的可见字符序列下标)。ANSI 转义序列的内部字符(ESC、`[`、数字、字母)**不单独占 offset**——它们附着在可见字符的 styles 里。

**两条保证边界**:
1. **`wrapLineWithSpans` 对 ANSI 只保证折行兼容**(文本产出与 `wrapLine` 一致,样式保留),**不保证 charStart/charEnd 与原始 ANSI 字符串的字符 offset 对齐**。tokenize 重排样式附着点,可见字符偏移 ≠ 原始字符串偏移。故 ANSI 测试只比较折行文本,**不断言 offset**。
2. **`computeInputViewportLayout` 仅处理无 ANSI 的用户输入**:键盘/粘贴的普通文本不含手写 ANSI,此时可见字符偏移 == cursor offset(input-store cursor 单位),**保证一致**。layout 不接受手写 ANSI 输入做 offset 保证。

→ Step 3 的 ANSI 回归用例(`'与 wrapLine 行为一致'`)只比 `spans.map(s=>s.text) === wrapLine(...)`,不查 span 的 offset 字段。

### 2e. 极窄 cols / budget ≤ 0 契约(新增)

`getUsableWidth(cols)=max(1, cols-1)`,再扣 prefix 可能 ≤0。契约:
- `wrapLineWithSpans` 内部 width 在进入断行循环前钳到 `max(1, width)`(与现有 `getUsableWidth` 一致,不产生 0/负 width);
- 极窄下每个可见字符都超宽 → 每个字符独占一物理行(字符级断行),不丢失字符;
- Step 3 增加极窄用例(cols=1/2、firstWidth 经钳位后=1)。

### 2f. InputPhysicalRow(layout 消费层,跨逻辑行全局区间 + cursorColMap)

```ts
export interface InputPhysicalRow {
  text: string;                  // 已折行可渲染文本(不含前缀,来自 WrappedSpan.text)
  sourceStart: number;           // 源输入码点索引(含,跨逻辑行累计)
  sourceEnd: number;             // 源输入码点索引(不含)
  logicalLineIndex: number;      // 所属逻辑行(input.split('\n') 下标)
  prefixKind: 'prompt' | 'continuation';  // 仅整个输入第0物理行 prompt,其余 continuation
  breakKind: 'soft' | 'hard' | 'none';
  /**
   * 光标列映射:全局源 cursor offset → 本物理行内显示列(不含前缀)。
   * 由 WrappedSpan.cursorColMap(相对逻辑行)转为全局 offset(加 lineOffset)。
   * 在 wrapping 断行过程中生成,覆盖被丢弃空格。
   * **Step 4 即产出此字段**(物理行模型 Step 4 就调 wrapLineWithSpans,span 带 cursorColMap)。
   * cursorVisibleCol = prefixKind 宽度 + cursorColMap[cursor],直接查询不反推(Step 6 用)。
   */
  cursorColMap: Record<number, number>;
}

export interface InputViewportLayout {
  physicalRowCount: number;
  visibleRowCount: number;
  viewportTop: number;
  visibleRows: InputPhysicalRow[];
  // ↓ 仅以下两字段由 Step 6 加入(Step 4 接口暂不含);InputPhysicalRow.cursorColMap 在 Step 4 即有
  cursorVisibleRow: number;       // 相对视口(Step 6 新增)
  cursorVisibleCol: number;       // 含前缀(Step 6)
}

export function computeInputViewportLayout(
  input: string,
  cursor: number,
  cols: number,
  firstLinePrefixWidth: number,      // PROMPT_WIDTH
  continuationPrefixWidth: number,   // CONTINUATION_INDENT_WIDTH
  maxVisible: number = MAX_VISIBLE_INPUT_LINES,
): InputViewportLayout
```

**拼装 `allRows`(调用算法,宽度按物理行角色区分)**:
```
logicalLines = input.split('\n')
firstWidth  = max(1, getUsableWidth(cols) - firstLinePrefixWidth)
contWidth   = max(1, getUsableWidth(cols) - continuationPrefixWidth)
lineOffset  = 0   // 该逻辑行在整输入中的码点偏移(累计,含已过的 \n)

isVeryFirstPhysicalRow = true   // 整个输入的第 0 物理行(只有它用 firstWidth)
for li, line in logicalLines:
  // 关键:每个逻辑行调 wrapLineWithSpans 时,
  //   首物理行宽度 = isVeryFirstPhysicalRow ? firstWidth : contWidth
  //   (只有整个输入的第 0 物理行用 prompt budget;其他逻辑行的首物理行也是 continuation)
  //   续物理行宽度一律 contWidth
  const logicalFirstWidth = isVeryFirstPhysicalRow ? firstWidth : contWidth
  spans = wrapLineWithSpans(line, logicalFirstWidth, contWidth)
  for si, span in spans:
    prefixKind = isVeryFirstPhysicalRow ? 'prompt' : 'continuation'
    breakKind  = (si === 0 && li === 0) ? 'none'
               : (si === 0 && li > 0)   ? 'hard'   // \n 后新逻辑行首物理行
               : span.breakKind                     // 软折续行 'soft'
    // cursorColMap 全局转换:相对逻辑行 offset → 全局 offset(加 lineOffset)
    // 作为 cursorColMap 字段传入,**不展开到对象顶层**
    const cursorColMap = Object.fromEntries(
      Object.entries(span.cursorColMap).map(([offset, column]) => [
        lineOffset + Number(offset),
        column,
      ]),
    )
    allRows.push({
      text: span.text,
      sourceStart: lineOffset + span.charStart,
      sourceEnd:   lineOffset + span.charEnd,
      logicalLineIndex: li, prefixKind, breakKind,
      cursorColMap,   // 作为字段,不展开到顶层(Step 4 即产出)
    })
    isVeryFirstPhysicalRow = false
  lineOffset += [...line].length + 1   // +1 跳过 \n(末逻辑行无 \n 但 +1 不影响末行 sourceEnd)
```

> **宽度规则修正(阻断项)**:旧版对每个逻辑行都传 `(firstWidth, contWidth)`——错。`firstWidth`(扣 prompt budget)**只用于整个输入的第 0 物理行**;其余逻辑行(含 `\n` 后的新逻辑行首物理行)的首物理行也用 `contWidth`(扣 continuation budget)。由 `logicalFirstWidth` 变量在调用前决定。

光标/viewport/渲染读 `allRows` 的 `sourceStart/End` + `cursorColMap` 定位 cursor(**不靠 stringWidth 反推**)。四者同源。

**预计修改文件**:`src/tui/state/wrap-line.ts`(提取 wrapCore 含 offset 记账 + 新增 wrapLineWithSpans);`src/tui/state/wrap-line.test.ts`(保持原断言,wrapLine 回归);新增 `src/tui/state/wrap-line-spans.test.ts`(colocate,见 §1 路径修正)。

## 3. 前缀语义与宽度规则(修正)

- **语义**:整个输入仅第 0 物理行 `prefixKind='prompt'`,其余全 `'continuation'`。`AAA\n888`→`[prompt, continuation(hard)]`。
- **宽度**:第 0 物理行 budget=`getUsableWidth(cols)-firstLinePrefixWidth`;**其他所有物理行**=`getUsableWidth(cols)-continuationPrefixWidth`(含硬换行新逻辑行首、软折行续行)。
- 删除旧计划"续行 budget 不扣前缀"错误表述。

## 4. 数据流(单算)

```
ConnectedApp(持有 inputText/cursor/cols)
  └─ layout = computeInputViewportLayout(...)  // 唯一计算
       ├─ footerRows = BASE + spinner + suggestion + (layout.visibleRowCount - 1)
       ├─ visibleRows(历史区) = max(0, rows - footerRows - LOGO_ROWS)
       └─ <App layout={layout} .../>  →  <Footer layout={layout} .../>
            ├─ 光标: setCursorPosition({ x: layout.cursorVisibleCol, y: inputRowY + layout.cursorVisibleRow })
            ├─ 行渲染: layout.visibleRows.map(r => <SelectionText content={prefixOf(r)+r.text} globalRow={inputRowY+i} />)
            └─ lowerBorderRow = inputRowY + layout.visibleRowCount

InlineAppV2(独立路径)
  └─ layout = useMemo(() => computeInputViewportLayout(...), [inputText, cursor, cols])
       └─ <FooterV2 layout={layout} .../>  // memo 依赖 layout 引用稳定
```

**Footer/FooterV2 不再接收 raw `input`/`cursor` props**(已核实:`Footer.tsx:44,49` 这两处 `cursorScreenPos(input,cursor)` 与 `input.split` 均被 layout 取代;SelectionText 用 `globalRow`+content,不读 input/cursor)。Footer 只接收 `layout` + `inputRowY` + `status`/`cols`/`completionStore`/`selectionStore`/`spinnerView`(FooterV2 无 spinner)。

## 5. scroll/resize 契约(修正钳位)

**缺陷**:`ConnectedApp.tsx:167` `scrolledAway ? scrollTop : maxScroll`——`scrolledAway=true` 分支未钳位。
**修正**:提取真实决策函数 `computeEffectiveScrollTop(scrolledAway, scrollTop, maxScroll) = scrolledAway ? clampScrollTop(scrollTop, maxScroll) : maxScroll`(Step 8 提取并测试,Step 10 接入 ConnectedApp)。

5 RED 场景(测提取后的真实决策函数,见 Step 8):
1. 底部状态输入区增高(maxScroll↑):钉底到新 maxScroll
2. 向上滚动时输入区增高(maxScroll↑):保持旧 scrollTop
3. 删除内容输入区缩回(maxScroll↓):钳到新 maxScroll
4. resize 变窄(maxScroll↑):钳位正确
5. resize 变宽(maxScroll↓):旧 scrollTop>新 maxScroll **必须钳位**(当前缺陷越界)

## 6. TDD 步骤(每步 RED/预期失败/最小实现/验证/commit)

> 顺序原则:
> 1. **cursor 单位 characterization 最先**(Step 1)——锁定 store BMP 行为,作为物理行模型的前置停止条件,失败则不进入后续;
> 2. 常量与 span 核心 **先行**(被物理行模型依赖);
> 3. 真实决策函数 **先提取并测试**,再接入组件;
> 4. 接入按层级 **App+Footer → ConnectedApp → FooterV2** 拆分,且每个会改生产接口的 Task **必须 `npm run typecheck` 通过才提交**(阻断项:保证每提交可编译)。
>
> **typecheck 规则**:每个会修改生产代码/接口的 Task(Step 2,3,4,5,6,6b,7,8,9,10,11,12,13),commit 前必须运行 `npm run typecheck`(= `tsc --noEmit`)并通过。纯新增测试文件且不改生产的 Task(Step 1)可选。**此规则在每个 Task 的"验证"段重复列出,执行 Agent 只读当前 Task 时也能看到。**

### Step 1:cursor 单位 characterization(前置停止条件,锁定 BMP 行为)
- **性质:characterization(锁定既有行为),不是 RED。物理行模型的前置:失败则不进入 Step 2+。**
- 新建 `src/__tests__/tui/input-cursor-units.test.ts`,**仅 BMP 范围**:
```ts
import { createInputStore } from '../../tui/state/input-store.js';
it('ASCII:insert 后 cursor = 码点数', () => {
  const s = createInputStore(); s.getState().insert('abc');
  expect(s.getState().cursor).toBe(3);
});
it('CJK:cursor = 码点数,text.length 一致(BMP)', () => {
  const s = createInputStore(); s.getState().insert('你好');
  expect(s.getState().cursor).toBe(2);
  expect(s.getState().text.length).toBe(2);
});
it('换行边界:insertNewline 后 cursor +1 跨 \\n', () => {
  const s = createInputStore(); s.getState().insert('ab'); s.getState().insertNewline();
  expect(s.getState().cursor).toBe(3);
  expect(s.getState().text).toBe('ab\n');
});
```
- **预期直接 GREEN**(store 对 BMP 已码点一致)。**若失败 → 停止,说明 store 在 BMP 也有缺陷,回到 §0a 重新评估**(不允许带失败继续进入物理行模型)。
- **不驱动新代码**(input-store 在禁改区);锁定 BMP 基线,作为 layout 与 store 交接的契约参照。
- 验证:`npx vitest run src/__tests__/tui/input-cursor-units.test.ts`
- commit:`test(tui): characterize input cursor units for BMP (ascii/cjk/newline)`

### Step 2:prompt 常量导出(物理行模型前置)
- RED:新建 `src/__tests__/tui/input-physical-rows.test.ts`,首条用例断言:
```ts
import { PROMPT, CONTINUATION_INDENT, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../../tui/state/input-viewport.js';
it('PROMPT/CONTINUATION 常量与宽度(从字符串计算,非硬编码)', () => {
  expect(PROMPT).toBe('❯ ');
  expect(CONTINUATION_INDENT).toBe('  ');
  expect(PROMPT_WIDTH).toBe(2);
  expect(CONTINUATION_INDENT_WIDTH).toBe(2);
  expect(PROMPT_WIDTH).toBeGreaterThan(0);
});
```
- 预期失败:常量未从 `input-viewport.ts` 导出,导入报错。
- 最小实现:`input-viewport.ts` 顶部 import `stringWidth`,定义并 export 四常量。
- 验证:`npx vitest run src/__tests__/tui/input-physical-rows.test.ts` + `npm run typecheck`
- commit:`feat(tui): export prompt/continuation width constants`

### Step 3:wrapping 核心扩展 —— wrapLineWithSpans(首行/续行不同宽度 + span 当场产出)
- RED:新建 `src/tui/state/wrap-line-spans.test.ts`(**colocate,与 wrap-line.test.ts 同目录**,import 用 `./wrap-line.js`):
```ts
import { wrapLineWithSpans, wrapLine } from './wrap-line.js';

it('与 wrapLine 行为一致(首行=续行同宽时,产出相同文本行)', () => {
  for (const [text, w] of [['hello world', 10], ['a'.repeat(100), 79], ['中'.repeat(10), 10]] as const) {
    const spans = wrapLineWithSpans(text, w, w);
    const lines = wrapLine(text, w);
    expect(spans.map(s => s.text)).toEqual(lines);
  }
});
it('空文本:1 span,text="",charStart=0,charEnd=0,breakKind=none,cursorColMap:{0:0}', () => {
  // 用 toMatchObject 避免后续字段增加导致 toEqual 脆性;cursorColMap 行首 cursor(0)→列 0
  expect(wrapLineWithSpans('', 80, 80)).toMatchObject([{
    text: '', charStart: 0, charEnd: 0, breakKind: 'none', cursorColMap: { 0: 0 },
  }]);
});
it('首行/续行不同宽度:首行窄、续行宽时折行点不同', () => {
  // 首行 width=5,续行 width=10;'abcdefghij' 首行放 5、续行放 5
  const s = wrapLineWithSpans('abcdefghij', 5, 10);
  expect(s).toHaveLength(2);
  expect(s[0]).toMatchObject({ text: 'abcde', charStart: 0, charEnd: 5, breakKind: 'none' });
  expect(s[1]).toMatchObject({ text: 'fghij', charStart: 5, charEnd: 10, breakKind: 'soft' });
});
it('单词边界空格:被丢弃空格归属前一行区间尾部(当场决定)', () => {
  const s = wrapLineWithSpans('hello world', 10, 10);
  expect(s[0]).toMatchObject({ text: 'hello', charStart: 0, charEnd: 6 });   // charEnd=6 含空格
  expect(s[1]).toMatchObject({ text: 'world', charStart: 6, charEnd: 11 });
});
it('CJK 连续无空格:区间无间隙', () => {
  const s = wrapLineWithSpans('中'.repeat(10), 10, 10);
  expect(s[0]!.charEnd).toBe(s[1]!.charStart);
});
it('极窄 cols(经钳位 width=1):每字符独占一物理行,不丢字符', () => {
  const s = wrapLineWithSpans('abc', 1, 1);
  expect(s).toHaveLength(3);
  expect(s.map(x => x.text)).toEqual(['a', 'b', 'c']);
  expect(s[0]).toMatchObject({ charStart: 0, charEnd: 1 });
  expect(s[2]).toMatchObject({ charStart: 2, charEnd: 3 });
});
it('极窄 width≤0 钳到 1(不产生负/零宽)', () => {
  // 调用方可能传 cols-prefix≤0;wrapLineWithSpans 内部钳位,行为同 width=1
  const s = wrapLineWithSpans('ab', 0, -1);
  expect(s).toHaveLength(2);
});
// === wrapped span 层空格 cursorColMap 测试(阻断项:首次实现 dropped-space map) ===
it('单空格断行:cursorColMap 覆盖被丢弃空格(列=前一可见字符列)', () => {
  // 'hello world' w=10 → ['hello','world'],空格(srcOffset=5)丢弃,列='o'后=5
  const s = wrapLineWithSpans('hello world', 10, 10);
  expect(s[0]!.cursorColMap[5]).toBe(5);  // 被丢弃空格 → 列 5
  expect(s[0]!.cursorColMap[6]).toBe(5);  // 行末边界(下一行起点)→ 列 5
});
it('aa   bb 连续空格(3):3 个空格均映射到列 2(=aa 末列)', () => {
  // cols=8 推演见 §2b:行0 cursorColMap={0:0,1:1,2:2,3:2,4:2,5:2}
  const s = wrapLineWithSpans('aa   bb', 5, 5);  // firstWidth=contWidth=5(与 cols=8 首行 budget 一致)
  expect(s[0]!.cursorColMap[2]).toBe(2);
  expect(s[0]!.cursorColMap[3]).toBe(2);
  expect(s[0]!.cursorColMap[4]).toBe(2);
});
it('下一行行首 cursorColMap:bb 行 {5:0,6:1,7:2}', () => {
  const s = wrapLineWithSpans('aa   bb', 5, 5);
  expect(s[1]!.cursorColMap).toMatchObject({ 5: 0, 6: 1, 7: 2 });
});
```
- 预期失败:`wrapLineWithSpans` 未实现,导入报错。
- 最小实现:按 §2b 提取 `wrapCore(line, firstWidth, contWidth)`,char 附加 `srcOffset`;**断行时当场记 `charStart`/`charEnd`/`cursorColMap`**(逐可见字符累计 runningCol,cursor 落点写入 colMap;被丢弃空格的 srcOffset 也写入,列=前一可见字符列);`wrapLine` 改调 `wrapLineWithSpans(line,w,w).map(s=>s.text)`;内部 width 入循环前 `max(1, width)`(§2e)。
- 验证:`npx vitest run src/tui/state/wrap-line-spans.test.ts src/tui/state/wrap-line.test.ts`(后者须全绿,确认 wrapLine 行为不变) + `npm run typecheck`
- commit:`feat(tui): wrapLineWithSpans with per-line widths, inline source ranges, cursor col map`

### Step 4:物理行模型 —— computeInputViewportLayout(前缀/宽度/breakKind/源区间)
- RED:在 `input-physical-rows.test.ts` 追加:
```ts
import { computeInputViewportLayout, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../../tui/state/input-viewport.js';
const L = (input, cursor, cols=80) => computeInputViewportLayout(input, cursor, cols, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);

it('AAA\\n888:2 物理行,[prompt,continuation],[none,hard],源区间连续', () => {
  const l = L('AAA\n888', 7);
  expect(l.physicalRowCount).toBe(2);
  expect(l.visibleRows.map(r => r.prefixKind)).toEqual(['prompt', 'continuation']);
  expect(l.visibleRows.map(r => r.breakKind)).toEqual(['none', 'hard']);
  expect(l.visibleRows[0]).toMatchObject({ sourceStart: 0, sourceEnd: 3, text: 'AAA', logicalLineIndex: 0 });
  expect(l.visibleRows[1]).toMatchObject({ sourceStart: 4, sourceEnd: 7, text: '888', logicalLineIndex: 1 });
});
it('软折行:首物理行扣 PROMPT_WIDTH,续物理行扣 CONTINUATION_INDENT_WIDTH', () => {
  const firstBudget = (80-1) - PROMPT_WIDTH;   // 77
  const l = L('a'.repeat(firstBudget + 1), firstBudget + 1, 80);
  expect(l.physicalRowCount).toBe(2);
  expect(l.visibleRows[0]!.breakKind).toBe('none');
  expect(l.visibleRows[1]!.breakKind).toBe('soft');
  expect(l.visibleRows[1]!.prefixKind).toBe('continuation');
});
```
- 预期失败:函数未实现。
- **接口分阶段(收敛后)**:Step 4 的 `InputViewportLayout` 含 `physicalRowCount`/`visibleRowCount`/`viewportTop`/`visibleRows`,**`visibleRows[i]` 已含真实 `cursorColMap`**(Step 4 即调 wrapLineWithSpans,span 自带 cursorColMap,转全局 offset 填入)。**仅 `cursorVisibleRow`/`cursorVisibleCol` 两字段由 Step 6 新增并实现**。Step 4 暂不读取 cursor——入参命名为 `_cursor`(标记未用,Step 6 启用)。**禁止提交返回固定 0 的生产 cursor 字段**(cursorVisibleRow/Col 在 Step 6 加入前,Step 4 接口不含它们;cursorColMap 是真实映射非 stub)。
- 最小实现:`computeInputViewportLayout(input, _cursor, cols, ...)` —— `split('\n')` 逐逻辑行,按 prefixKind 算 budget(第0物理行用 firstLinePrefixWidth,其余 continuationPrefixWidth),调 `wrapLineWithSpans`,把 charStart/End 加逻辑行全局偏移转 `sourceStart/End`,**cursorColMap 同样转全局 offset 填入 InputPhysicalRow**(§2f),标 prefixKind/breakKind。visibleRowCount=clamp(physicalRowCount,1,max)。**不产出 cursorVisibleRow/Col**(Step 6 扩展);**不读 `_cursor`**。
- 验证:`npx vitest run src/__tests__/tui/input-physical-rows.test.ts` + `npm run typecheck`
- commit:`feat(tui): physical row model with source ranges and prefix semantics`

### Step 5:物理行边界 edge-case coverage(空/尾\n/空行/单\n/单词空格归属)
- **性质:edge-case 覆盖测试。不强行宣称必然 RED**——Step 4 实现可能已正确处理这些边界(因 split + wrapLineWithSpans 天然覆盖空逻辑行)。仅在测试实际失败时补最小实现。
- 在 `input-physical-rows.test.ts` 追加边界用例:
```ts
it('空输入:1 物理行,prompt,none,源区间 [0,0)', () => {
  const l = L('', 0);
  expect(l.physicalRowCount).toBe(1);
  expect(l.visibleRows[0]).toMatchObject({ prefixKind: 'prompt', breakKind: 'none', sourceStart: 0, sourceEnd: 0, text: '' });
});
it('AAA\\n:2 物理行,第二行是空逻辑行(hard),源区间 [4,4)', () => {
  const l = L('AAA\n', 4);
  expect(l.physicalRowCount).toBe(2);
  expect(l.visibleRows[1]).toMatchObject({ breakKind: 'hard', text: '', sourceStart: 4, sourceEnd: 4, logicalLineIndex: 1 });
});
it('AAA\\n\\n888:3 物理行,中间空逻辑行(hard)', () => {
  const l = L('AAA\n\n888', 8);
  expect(l.physicalRowCount).toBe(3);
  expect(l.visibleRows.map(r => r.logicalLineIndex)).toEqual([0, 1, 2]);
  expect(l.visibleRows[1]).toMatchObject({ text: '', breakKind: 'hard' });
});
it('\\n:2 物理行,首行空(prompt,none),次行空(hard)', () => {
  const l = L('\n', 1);
  expect(l.physicalRowCount).toBe(2);
  expect(l.visibleRows[0]).toMatchObject({ prefixKind: 'prompt', breakKind: 'none', text: '' });
  expect(l.visibleRows[1]).toMatchObject({ prefixKind: 'continuation', breakKind: 'hard', text: '' });
});
it('单词边界空格:sourceStart/sourceEnd 归属前一行尾部(不进下一行)', () => {
  // 'hello world' 软折行:空格属前一行
  const l = L('hello world', 11, 10); // usableWidth=9, 首行扣 PROMPT_WIDTH=7
  // 找含 'hello' 与 'world' 的物理行,验证空格不进 'world' 区间
  const helloRow = l.visibleRows.find(r => r.text === 'hello')!;
  const worldRow = l.visibleRows.find(r => r.text === 'world')!;
  expect(helloRow.sourceEnd).toBe(worldRow.sourceStart); // 连续,空格在 helloRow 区间内
});
```
- 预期:**可能直接 GREEN**(Step 4 的 split + wrapLineWithSpans 已天然处理空逻辑行)。若某用例失败(如 `AAA\n` 末空行漏算、`\n` 首行 prefixKind 错)→ 补最小实现。
- 最小实现(仅在失败时):补全 split 后空逻辑行处理、breakKind 标记(首个物理行 none,`\n` 后新逻辑行首 hard,wrapLine 软折 soft)。
- 验证:`npx vitest run src/__tests__/tui/input-physical-rows.test.ts` + `npm run typecheck`
- commit(若有实现补全):`feat(tui): physical row boundary handling (empty/trailing-nl/blank-line/word-space)`;若纯测试无实现改动则 `test(tui): edge-case coverage for physical row boundaries`

### Step 6:光标定位(三条边界契约明确,匹配优先级)
- RED:追加。**三条边界契约(本轮确定,无占位)**:
  1. **软折行边界归下一物理行行首**:cursor 在软折行点(= 前行 sourceEnd 且 = 后行 sourceStart)→ 归下一物理行(后行),cursorVisibleCol = 后行前缀宽 + 0(行首)。
  2. **硬换行字符位置归前一行末**:cursor 在 `\n` 处(= 前逻辑行末物理行 sourceEnd,且 `\n` 不占物理行)→ 归前逻辑行的末物理行,cursorVisibleCol = 前缀宽 + 该行末显示列。
  3. **`\n` 后的 cursor 归下一逻辑行行首**:cursor 跨过 `\n`(在下一逻辑行 sourceStart)→ 归下一逻辑行首物理行。

**cursor 行匹配算法(可执行伪代码,定义匹配优先级)**:
```
function findCursorRow(allRows, cursor):
  # 优先级 1: cursor 严格落在某行开区间 (sourceStart, sourceEnd) 内 → 该行(区间内非边界)
  for i, row in allRows:
    if row.sourceStart < cursor && cursor < row.sourceEnd:
      return i
  # 优先级 2: cursor == 某行 sourceStart(行首)
  #   覆盖:软折行边界(归下一物理行行首)、\n 后归下一逻辑行行首、零长度空行
  #   从前往后找第一个 sourceStart === cursor 的行
  for i, row in allRows:
    if cursor === row.sourceStart:
      return i
  # 优先级 3: cursor == 某行 sourceEnd(行末)
  #   覆盖:硬换行字符位置归前一行末、输入末尾
  #   从后往前找第一个 sourceEnd === cursor 的行(归前一行)
  for i from allRows.length-1 downto 0:
    if cursor === allRows[i].sourceEnd:
      return i
  # 优先级 4: 兜底末行
  return allRows.length - 1

# 列定位:cursorVisibleCol = row.prefixKind 宽度 + row.cursorColMap[cursor]
#   (cursorColMap 在 wrapping 时生成,直接查询,不反推;见 §2b/§2f)
```

> **匹配优先级**:开区间内(1) > 行首 sourceStart(2,从前往后) > 行末 sourceEnd(3,从后往前归前一行) > 末行兜底(4)。
> 三条契约对应:软折行边界→优先级2(行首,归下一行);硬换行字符位置→优先级3(行末,归前一行);`\n`后→优先级2(下一逻辑行行首)。

```ts
// === 契约1:软折行边界归下一物理行行首 ===
it('软折行边界:cursor 在折行点归下一物理行行首(cursorVisibleCol=前缀宽+0)', () => {
  const firstBudget = (80 - 1) - PROMPT_WIDTH; // 77
  const text = 'a'.repeat(firstBudget + 1);     // 折成 [0,77)+[77,78)
  const l = L(text, firstBudget, 80);           // cursor=77 在折行点
  expect(l.cursorVisibleRow).toBe(1);           // 归下一物理行(行1)
  expect(l.cursorVisibleCol).toBe(CONTINUATION_INDENT_WIDTH + 0); // 行首,内容列=0
});

// === 契约2:硬换行字符位置归前一行末 ===
it('硬换行:cursor 指向 \\n(cursor=3 in "AAA\\n888")归前一行末(cursorVisibleRow=0)', () => {
  const l = L('AAA\n888', 3);
  expect(l.cursorVisibleRow).toBe(0);
  expect(l.cursorVisibleCol).toBe(PROMPT_WIDTH + 3); // 'AAA' 末,内容列=3
});
it('硬换行:cursor 在源区间内("AAA\\n888" cursor=5)→ cursorVisibleRow=1', () => {
  expect(L('AAA\n888', 5).cursorVisibleRow).toBe(1);
});

// === 契约3:\\n 后的 cursor 归下一逻辑行行首 ===
it('\\n 后 cursor:AAA\\n888 cursor=4(下一逻辑行行首)→ cursorVisibleRow=1,内容列=0', () => {
  const l = L('AAA\n888', 4);
  expect(l.cursorVisibleRow).toBe(1);
  expect(l.cursorVisibleCol).toBe(CONTINUATION_INDENT_WIDTH + 0);
});

// === 零长度空行 / 连续空行 / 尾随空行(优先级2 行首命中)===
it('零长度空行:AAA\\n\\n888 cursor=4(空行 sourceStart==sourceEnd==4)→ cursorVisibleRow=1', () => {
  const l = L('AAA\n\n888', 4);
  expect(l.cursorVisibleRow).toBe(1);
  expect(l.cursorVisibleCol).toBe(CONTINUATION_INDENT_WIDTH);
});
it('连续空行:\\n\\n cursor=1 → cursorVisibleRow=1(第二行行首)', () => {
  // '\n\n' split → ['','',''] → 物理行 3 个,sourceStart 分别 0,1,2
  // cursor=1 = 第二行 sourceStart(优先级2,行首)→ 行1
  expect(L('\n\n', 1).cursorVisibleRow).toBe(1);
});
it('连续空行:\\n\\n cursor=2 → cursorVisibleRow=2(第三行行首)', () => {
  expect(L('\n\n', 2).cursorVisibleRow).toBe(2);
});
it('尾随空行:AAA\\n cursor=4(末空行 sourceStart==sourceEnd==4)→ cursorVisibleRow=1', () => {
  expect(L('AAA\n', 4).cursorVisibleRow).toBe(1);
});
it('输入末尾:AAA cursor=3(末行 sourceEnd=3)→ cursorVisibleRow=0(优先级3 末行)', () => {
  const l = L('AAA', 3);
  expect(l.cursorVisibleRow).toBe(0);
  expect(l.cursorVisibleCol).toBe(PROMPT_WIDTH + 3);
});

// === CJK 列定位(查 cursorColMap)===
it('CJK cursorVisibleCol:cursorColMap 查询(中=2),不落字符中间', () => {
  const l = L('你好世界', 2, 80); // cursor=2 在 '你好' 后
  expect(l.cursorVisibleCol).toBe(PROMPT_WIDTH + 4);
});
```
- 预期失败:Step 4 接口尚未含 `cursorVisibleRow`/`cursorVisibleCol`(cursorColMap 已在 Step 4 产出);Step 6 本步扩展接口加这两字段并实现 findCursorRow;测试引用这两字段会 typecheck/运行失败。
- 最小实现:按伪代码实现 `findCursorRow`(优先级 1→2→3→4);`cursorVisibleCol = row.prefixKind 宽度 + row.cursorColMap[cursor]`(**直接查询映射,禁止从 row.text 反推**)。
- 验证:同文件(`input-physical-rows.test.ts`) + `npm run typecheck`
- commit:`feat(tui): cursor mapping with priority (soft-fold→next, hard-nl→prev, post-nl→next)`

### Step 6b:全局 offset + 最终 cursor 位置集成覆盖(不改 wrapping 生产代码)
- **性质:集成覆盖测试,不修改 wrapping 生产代码。** dropped-space map 已在 Step 3 首次实现(wrapped span 层),全局 offset 转换在 Step 4(InputPhysicalRow.cursorColMap),cursor 定位在 Step 6(findCursorRow + cursorVisibleCol)。**Step 3+4+6 正确后,本步预期直接 GREEN。** 若失败,说明前序某步有缺陷,回到对应步骤修(不在本步改 wrapping 代码)。
- 追加用例(全局视角:验证 InputPhysicalRow.cursorColMap 已转全局 offset,且 cursorVisibleRow/Col 端到端正确):
```ts
// 全局 offset 验证:'aa   bb'(3空格) cols=8 → 行0 全局 cursorColMap 含被丢弃空格
it('全局 offset:aa   bb 行0 cursorColMap 被丢弃空格(全局 offset 2,3,4)→ 列 2', () => {
  const l = L('aa   bb', 0, 8);
  const aaRow = l.visibleRows.find(r => r.text === 'aa')!;
  expect(aaRow.cursorColMap[2]).toBe(2);
  expect(aaRow.cursorColMap[3]).toBe(2);
  expect(aaRow.cursorColMap[4]).toBe(2);
});
it('全局 offset:下一行 bb 行 cursorColMap {5:0,6:1,7:2}', () => {
  const l = L('aa   bb', 0, 8);
  const bbRow = l.visibleRows.find(r => r.text === 'bb')!;
  expect(bbRow.cursorColMap).toMatchObject({ 5: 0, 6: 1, 7: 2 });
});
// 最终 cursor 位置(cursorVisibleRow/Col 端到端,跨被丢弃空格)
it('cursor 在被丢弃空格之间(cursor=2,3,4):cursorVisibleRow=0,Col=PROMPT_WIDTH+2', () => {
  expect(L('aa   bb', 2, 8).cursorVisibleCol).toBe(PROMPT_WIDTH + 2);
  expect(L('aa   bb', 3, 8).cursorVisibleCol).toBe(PROMPT_WIDTH + 2);
  expect(L('aa   bb', 4, 8).cursorVisibleCol).toBe(PROMPT_WIDTH + 2);
});
it('cursor 在下一单词行首(cursor=5):cursorVisibleRow=1,Col=CONTINUATION_INDENT_WIDTH+0', () => {
  const l = L('aa   bb', 5, 8);
  expect(l.cursorVisibleRow).toBe(1);
  expect(l.cursorVisibleCol).toBe(CONTINUATION_INDENT_WIDTH + 0);
});
it('单空格断行 hello world:全局 offset 行0 空格(5)→列5,行末边界(6)→列5', () => {
  const l = L('hello world', 0, 8);
  const helloRow = l.visibleRows.find(r => r.text === 'hello')!;
  expect(helloRow.cursorColMap[5]).toBe(5);
  expect(helloRow.cursorColMap[6]).toBe(5);
});
```
- 预期:**直接 GREEN**(Step 3 wrapped span map + Step 4 全局转换 + Step 6 cursor 定位 已覆盖)。若失败 → 定位到具体前序步骤修复,本步不改 wrapping 生产代码。
- 最小实现:**无**(纯测试)。仅在用例本身写错时修测试,不动生产代码。
- 验证:同文件(`input-physical-rows.test.ts`) + `npm run typecheck`
- commit:`test(tui): integration cover for global dropped-space map and cursor position`

### Step 7:viewport 滚动 + >5 物理行
- RED:追加:
```ts
it('6 逻辑行:visibleRowCount=5,光标居中,cursorVisibleRow∈[0,5)', () => {
  const input = Array.from({length:6},(_,i)=>`l${i}`).join('\n');
  const l = L(input, input.length);
  expect(l.visibleRowCount).toBe(5);
  expect(l.cursorVisibleRow).toBeGreaterThanOrEqual(0);
  expect(l.cursorVisibleRow).toBeLessThan(5);
});
it('一逻辑行折 >5 物理行:visibleRowCount=5,光标恒在视口', () => {
  const budget = (80-1) - PROMPT_WIDTH;
  const text = 'a'.repeat(budget * 7);
  const l = L(text, text.length);
  expect(l.physicalRowCount).toBeGreaterThan(5);
  expect(l.visibleRowCount).toBe(5);
  expect(l.cursorVisibleRow).toBeGreaterThanOrEqual(0);
  expect(l.cursorVisibleRow).toBeLessThan(5);
});
```
- 预期失败:viewportTop 切片未实现。
- 最小实现:复用 `computeScrollState`/`clampScrollTop` 算 viewportTop(居中公式 `cursorRow - floor(maxVisible/2)` 钳位),`visibleRows = allRows.slice(...)`,重算相对 cursorVisibleRow。
- 验证:同文件(`input-physical-rows.test.ts`) + `npm run typecheck`
- commit:`feat(tui): viewport scrolling over 5 physical rows`

### Step 8:提取真实 scroll 决策函数 + 测试(接入 ConnectedApp 前的纯函数层)
- RED:新建 `src/__tests__/tui/scroll-clamp.test.ts`,测**从 ConnectedApp 提取的真实决策函数** `computeEffectiveScrollTop`:
```ts
import { computeEffectiveScrollTop } from '../../tui/state/effective-scroll.js';
it('底部(scrolledAway=false):返回 maxScroll(钉底)', () => {
  expect(computeEffectiveScrollTop(false, 5, 10)).toBe(10);
});
it('上滚(scrolledAway=true) maxScroll↑:保持旧 scrollTop', () => {
  expect(computeEffectiveScrollTop(true, 5, 10)).toBe(5);
});
it('删内容 maxScroll↓:旧 scrollTop>新 maxScroll 钳位', () => {
  expect(computeEffectiveScrollTop(true, 8, 3)).toBe(3);
});
it('resize 变窄 maxScroll↑:钳位正确', () => {
  expect(computeEffectiveScrollTop(true, 4, 9)).toBe(4);
});
it('resize 变宽 maxScroll↓:旧 scrollTop>新 maxScroll 必须钳位(当前缺陷)', () => {
  expect(computeEffectiveScrollTop(true, 9, 4)).toBe(4);
});
```
- 预期失败:`computeEffectiveScrollTop` 不存在(新提取),导入报错。
- 最小实现:**新建** `src/tui/state/effective-scroll.ts`,导出 `computeEffectiveScrollTop(scrolledAway, scrollTop, maxScroll) = scrolledAway ? clampScrollTop(scrollTop, maxScroll) : maxScroll`。把 ConnectedApp L167 的内联决策**提取为可测纯函数**。**本步只新增函数,不接入 ConnectedApp——生产缺陷(漏钳位)在 Step 10 接入后才算修复。**
- 验证:`npx vitest run src/__tests__/tui/scroll-clamp.test.ts` + `npm run typecheck`
- commit:`feat(tui): add effective scroll-top decision helper`

### Step 9-11:alt-screen 接入(三段迁移,每段独立 commit + typecheck)

> **可编译性约束(阻断项)**:App/Footer 改必传 layout 而 ConnectedApp 未跟上会造成中间提交 typecheck 失败。故拆三段,每段结束时全树可编译(`npm run typecheck` 通过)。

#### Step 9:App/Footer 增加可选 layout,保留旧路径(兼容态)
- 改动:`App.tsx`/`Footer.tsx` 的 `layout` props 改为**可选**(`layout?: InputViewportLayout`);Footer 内 `if (layout) { 走新渲染 } else { 走旧 split/slice/补空行 }`。App 同理 `inputViewportExtraLines = layout ? layout.visibleRowCount-1 : MAX-1`。**input/cursor props 暂保留**(旧路径仍用)。
- RED:`continuation-indent.test.ts` 加一个新用例——传入 layout 时渲染实际行数(不补空行);旧用例(不传 layout)保持 GREEN(走旧路径)。
- 验证:`npx vitest run src/__tests__/tui/continuation-indent.test.ts` + **`npm run typecheck`**(此时 ConnectedApp 仍传旧 input/cursor,因 layout 可选,typecheck 通过)
- commit:`feat(tui): App/Footer accept optional layout (legacy path retained)`

#### Step 10:ConnectedApp 单算 layout 并传入(切换到新路径)
- 改动:`ConnectedApp.tsx` 算 `layout = computeInputViewportLayout(...)`,footerRows 用 `layout.visibleRowCount-1`,`effectiveScrollTop = computeEffectiveScrollTop(...)`(Step 8 函数,修钳位);透传 `<App layout={layout} input={inputText} cursor={cursor}>`(input/cursor 暂仍传,Footer 旧路径分支不再命中但保留)。
- RED:新建 `src/__tests__/tui/connected-app-scroll.test.tsx`(集成回归):渲染 ConnectedApp(stores 注入),驱动 inputStore 变化,断言:
  1. 输入区增高(多行)时,footer 高度增加、历史区可见行减少、`msgLast` 仍可见(底部锚定);
  2. 向上滚(scrolledAway=true)后输入区增高,scrollTop 保持不越界;
  3. 删内容输入区缩回,scrollTop 钳到新 maxScroll;
  4. cols 变化(resize 模拟)触发 layout 重算 + scrollTop 钳位。
- 同时改 `input-viewport-e2e.test.tsx`/`layout.test.tsx`:`renderApp` 传 layout(切新路径),断言动态高度。
- 验证:`npx vitest run src/__tests__/tui/connected-app-scroll.test.tsx src/__tests__/tui/input-viewport-e2e.test.tsx src/__tests__/tui/layout.test.tsx` + **`npm run typecheck`**
- commit:`feat(tui): ConnectedApp single layout calc + scroll clamp (dynamic footer)`

#### Step 11:删除旧 input/cursor props 与 fallback(清理态)
- 改动:确认所有调用方(App 由 ConnectedApp、e2e/layout fixture)都已传 layout 后:
  - `Footer.tsx`:删旧路径分支(else)、删 `input`/`cursor` props、删本地 PROMPT/CONTINUATION 常量(改 import)、删 `cursorScreenPos` 调用;layout 改**必传**。
  - `App.tsx`:删本地重算(L78-87);layout 改**必传**;不再透传 input/cursor 给 Footer。
  - 删 Footer 内 `input.split`/补空行残留。
- RED:`continuation-indent.test.ts` L55 旧用例(不传 layout)此时应改为传 layout;`input-viewport-e2e` 确认无残留旧路径依赖。
- 验证:`npx vitest run src/__tests__/tui/continuation-indent.test.ts src/__tests__/tui/input-viewport-e2e.test.tsx` + **`npm run typecheck`**(layout 必传后,任何漏传的调用方在此暴露)
- commit:`refactor(tui): drop legacy input/cursor props from App/Footer (layout mandatory)`

### Step 12:inline-v2 接入(FooterV2 + InlineAppV2)
- RED:改 `footer-v2-memo.test.tsx`(props `viewportTop`→`layout`,用 useMemo 构造稳定 layout;保留 memo 隔离断言)。
- 预期失败:FooterV2 props 形状变更。
- 最小实现:`FooterV2.tsx` 同 Footer 改造 props `layout`;`InlineAppV2.tsx` `const layout = useMemo(() => computeInputViewportLayout(...), [inputText, cursor, cols])` 透传(memo 引用稳定)。
- 验证:`npx vitest run src/__tests__/tui/inline-v2/` + `npm run typecheck`
- commit:`feat(tui): wire physical row layout into inline-v2 footer`

### Step 13:旧函数迁移(覆盖映射确认后删)
- 覆盖映射核对(先跑 GREEN 确认等价保护):

| 旧用例(`physical-line-count.test.ts`) | 新等价用例 | 等价点 |
|---|---|---|
| 空文本 1 物理行 | Step 5 空输入 | physicalRowCount=1 |
| 短文本=逻辑行数 | Step 4 `AAA\n888` | 2 逻辑行=2 物理行 |
| ASCII 超宽折行 | Step 4 软折行 | 软折 |
| CJK 折行 | Step 6 CJK | stringWidth=2 |
| 首行 prompt budget | Step 4 软折行 | firstBudget 扣 PROMPT_WIDTH |
| 多行混合求和 | Step 4/7 | physicalRowCount 累计 |
| `physicalLineOfCursor` 短文本 | Step 6 cursor=5 | cursorVisibleRow |
| `physicalLineOfCursor` 超宽 | Step 6/7 | cursor 在末物理行 |

- 跑 `input-physical-rows.test.ts` GREEN 确认等价→删 `physical-line-count.test.ts` + `physicalLineCount`/`physicalLineOfCursor`。
- `input-viewport.test.ts` 的 `computeInputViewport` 钳位用例**保留**(函数仍在)。
- 删除前二次 grep 确认无其他生产引用。
- 验证:`npx vitest run src/__tests__/tui/ && npm run typecheck`
- commit:`refactor(tui): remove physicalLineCount/OfCursor superseded by layout (coverage mapped)`

### Step 14:全量回归 + 类型/lint
- `npm test`(= `vitest run`)+ `npm run typecheck`(= `tsc --noEmit`)+ `npm run lint`(= `eslint src/`)。
- 停止条件:全绿;既有非本改动失败隔离记录。
- commit(若有适配修复):`test(tui): adapt full suite to physical row model`

## 7. Windows TTY 验收矩阵(全绿后)

| # | 场景 | 操作 | 预期 |
|---|---|---|---|
| 1 | 1 行 | 启动空输入 | 输入区 1 行,下边框紧贴 |
| 2 | 2–5 行 | Ctrl+J 逐行加 | 每行增高 1,历史区缩 ≤4,下边框下移 |
| 3 | 超过 5 行 | Ctrl+J 到 6+ | 锁 5 行,viewportTop 跟随光标,光标可见 |
| 4 | 长英文折行 | 粘贴超长英文 | wrapLine 折行,单词不劈 |
| 5 | CJK 折行 | 粘贴长中文 | 字符级折行,CJK=2 列,光标不落字中 |
| 6 | 删除后缩回 | Backspace 删到 1 行 | 高度缩回,下边框上移,scrollTop 钳位 |
| 7 | resize | 缩放终端窗口 | 物理行重算,无残影/漂移,scrollTop 钳位 |

判据:7/7 肉眼正确 + 光标在内容区。证据存 `logs/`。

## 8. 风险/回滚/禁改

**高风险点**:
1. **非 BMP / grapheme cluster —— 范围采用 B(§0a,本轮批准)**。保证 ASCII/BMP CJK/换行;排除非 BMP offset 一致性(代理对 slice 错位)与 grapheme cluster 光标语义(组合字符按码点移动)。Agent **不**宣称完整 Unicode 编辑/光标支持,**不**修 input-store 既有缺陷。后续独立任务:Task-U1(store cursor 一致性)、Task-U2(grapheme segmenter)。本阶段 layout 用码点遍历(`[...input]`)产出源区间(对 BMP 含 CJK/组合字符与 store 一致)。
2. FooterV2 memo:`layout` 每渲染新对象致 memo 失效→InlineAppV2 `useMemo` 缓存(Step 12)。
3. `wrapLine` 行为回归:`wrapLineWithSpans` 提取 wrapCore 后,`wrap-line.test.ts`(含 ANSI/emoji 既有用例 L118-162)必须全绿(Step 3 验证)——若破坏旧断言,回滚提取。
4. cursorColMap 完整性:dropped-space map 在 **Step 3 首次实现**(wrapped span 层),Step 4 转全局 offset,Step 6b 做集成覆盖。若 colMap 缺 key 导致 cursorVisibleCol=undefined,Step 3/6/6b 失败暴露。
5. 极窄 cols(budget≤0):`wrapLineWithSpans` 内部钳位 `max(1,width)`(§2e),Step 3 极窄用例验证不丢字符;若终端实际极窄导致每个字符独占一行,viewport 滚动需仍正确(Step 7 覆盖)。
6. **中间提交可编译性**:Step 9/10/11 三段迁移每段必须 `npm run typecheck` 通过才 commit;若某段失败,回滚该段重做(不允许跳过 typecheck 提交)。
7. `computeInputViewport` 删前 Step 13 二次 grep 确认引用。
8. inline-v2 E2E(`inline-app-v2.test.tsx`/`e2e-bug-regression.test.tsx`)可能因 FooterV2 删 raw input/cursor props 变化红,Step 14 暴露。

**回滚点**:每 Step 独立 commit;Step 1-8 纯函数+测试可单独回滚;Step 9/10/11 三段接入各自回滚(Step 9 回滚=App/Footer 退回旧必传 input/cursor;Step 11 回滚=恢复旧 props fallback);Step 12 inline 接入;Step 13 删除点回滚恢复旧函数。

**禁改范围**:`use-input-handler.ts`、`input-store.ts`(Step 1 仅 characterization 不改)、paste 路径、Enter 提交、`wrapLine`/`getUsableWidth` 断行算法本身(只提取共享核心不改算法)、`scroll-state.ts`(仅复用 `clampScrollTop`/`computeScrollState`)。

## 9. 完成验证

- `npx vitest run src/__tests__/tui/ src/tui/state/` 全绿(含 colocate 的 wrap-line-spans.test.ts)
- `npm test`(= `vitest run`)全绿(或既有失败隔离)
- `npm run typecheck`(= `tsc --noEmit`)通过
- `npm run lint`(= `eslint src/`)通过(无 unused/floating promise)
- §7 矩阵 7/7
- 三条 cursor 边界契约在 Step 6 精确断言通过(软折行→下一物理行行首、硬换行→前一行末、`\n`后→下一逻辑行行首)
- 每个改生产接口的 Task(Step 2,3,4,5,6,6b,7,8,9,10,11,12,13)commit 前 `npm run typecheck` 通过
- 证据存 `logs/`
