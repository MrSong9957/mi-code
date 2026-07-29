# 终端 Markdown 表格固化渲染设计

日期：2026-07-29

## 1. 背景

MiCode 的 Inline V2 主对话当前把 assistant 内容作为纯文本渲染。模型输出 Markdown
表格时，用户看到的是 `| 工具 | 用途 |` 原文，而不是对齐的终端表格。

项目已经依赖 `marked@^18.0.5`，现有
`src/tui/markdown/render-markdown.tsx` 也已经通过 `marked.lexer` 消费
`Tokens.Table`。本设计复用该解析能力，不新增依赖，不实现第二套 Markdown 表格解析器。

## 2. 目标

- assistant 正常完成后，把 Markdown Table AST 渲染成带边框、严格对齐的终端表格。
- 流式阶段继续显示 raw Markdown，避免未完成数据导致列宽持续抖动。
- store 永远保留原始 Markdown，渲染结果不反写状态。
- 中文、英文、ANSI 样式均按真实终端显示宽度计算。
- 表格随终端 resize 自动重新布局。
- 宽终端、普通窄终端、极窄终端采用确定性的三层降级。
- 不改变标题、列表、分隔线等非表格 Markdown 的现有主对话表现。

## 3. 非目标

- 不在流式阶段绘制动态边框表格。
- 不把完整 Markdown Renderer 接入 Inline V2 主对话。
- 不修改 `AssistantBlock.text`，不把边框字符写入 transcript store。
- 不新增表格配置项、主题配置或第三方表格依赖。
- 不特殊修复被 Escape 中断的未完成表格；中断内容保留 raw Markdown。

## 4. 用户可见行为

### 4.1 正常完成

流式期间：

```text
| 工具 | 用途 |
|---|---|
| read_file | 读取文件内容 |
```

assistant 完成后：

```text
┌───────────┬──────────────────┐
│ 工具      │ 用途             │
├───────────┼──────────────────┤
│ read_file │ 读取文件内容     │
└───────────┴──────────────────┘
```

### 4.2 中断

Escape 中断后，assistant block 带 `interrupted: true`，继续显示 raw Markdown。
不尝试修补未闭合表格，也不绘制不完整边框。

### 4.3 Resize

终端宽度变化时，沿用 Inline V2 现有 resize 重挂载 `<Static>` 的机制。固化
assistant 重新解析原始 Markdown，并按新的 `cols` 重新计算表格布局。

## 5. 架构

### 5.1 数据所有权

`AssistantBlock.text` 是唯一事实来源，内容始终是模型产生的原始 Markdown。
表格 AST 和布局行都是渲染期派生数据，不进入 store。

### 5.2 组件边界

新增 `AssistantBlockLine`，职责是：

1. 接收已固化的 `AssistantBlock` 和终端宽度 `cols`。
2. 若 `interrupted === true`，直接渲染 raw Markdown。
3. 否则调用 `marked.lexer` 解析完整文本。
4. 非 table token 按 `token.raw` 保持当前纯文本表现。
5. table token 交给专用终端表格布局器。
6. 在首个可见内容前渲染单个 assistant `●` 标记，正文保持默认前景色。

`TranscriptBlockLine` 的 assistant 分支只负责路由到 `AssistantBlockLine`，不再承担
Markdown 解析或表格布局。

### 5.3 核心锚点函数

核心纯函数：

```ts
layoutMarkdownTable(table: Tokens.Table, availableWidth: number): TableLayout
```

输入：

- `marked` 产生的 `Tokens.Table`
- assistant 内容区可用终端宽度

`Tokens.Table.header` 与 `Tokens.Table.rows` 中的每个 `TableCell` 同时携带
`text` 和 `tokens`。布局器以 `cell.tokens` 作为单元格唯一的语义输入：

- 测量阶段递归遍历 inline tokens，提取用户最终看到的纯文本。
- 渲染阶段消费同一组 inline tokens，保留 code、strong、em 和 link 样式。
- 不对 `cell.text` 做正则 strip，也不二次调用 `marked.lexer` 或
  `marked.parseInline`。

输出：

- `mode: 'bordered' | 'key-value'`
- 已计算完成的可见文本行
- 每行可选的内联样式片段

该函数是 TDD、列宽算法和 resize 行为的唯一突破口。React 组件只消费其输出，不重复
计算宽度。

## 6. 数据流

```text
assistant token stream
  → StreamingText
  → raw Markdown

finishAssistant
  → StreamingAssistant 转为 AssistantBlock
  → AssistantBlock.text 保留 raw Markdown
  → 判断 AssistantBlock.interrupted
    → true: 跳过 marked.lexer，直接输出 raw Markdown
    → false: 继续固化渲染
  → AssistantBlockLine
  → marked.lexer
  → 普通 token 保留 raw
  → Table token 进入 layoutMarkdownTable
  → 终端表格行
```

resize 时不改 store，只重新执行最后三步。

## 7. 表格布局算法

### 7.1 宽度单位

所有宽度均为终端显示列数，不使用 JavaScript `string.length`。

单元格内容从 `TableCell.tokens` 读取。测宽函数递归遍历 inline token：

- `text`、`escape`、`html` 使用最终可见文本。
- `strong`、`em`、`del` 递归遍历其子 tokens。
- `codespan` 使用 `token.text`。
- `link` 使用链接标签的可见文本，不计 URL。
- `br` 形成单元格内部换行，各逻辑行分别测量。
- `image` 使用替代文本 `token.text`。
- 未明确列出的 inline token 优先递归测量其子 `tokens`；没有子 tokens 时，
  使用字符串类型的 `token.text`，否则使用 `token.raw`。渲染兜底使用
  `token.raw`，避免静默丢失未知 token。

单个单元格对列宽的贡献，是该单元格所有逻辑行中最大的显示宽度；因此包含多个
`br` 的单元格不会把各逻辑行宽度相加。

复用现有 `displayWidth` 规则：

- 常见中文、日文、韩文和全角字符宽度为 2。
- 普通 ASCII 字符宽度为 1。
- ANSI SGR 序列宽度为 0。

换行函数必须使用相同的字符宽度规则，保证测量与绘制一致。

### 7.2 Padding 与边框

每个单元格左右各保留一个空格。对于 `N` 列：

```text
总宽度 = Σ(各列内容宽度 + 2) + N + 1
```

其中 `N + 1` 是左右外边框和内部竖边框。

横边框、标题分隔线和数据行必须消费同一份最终列宽数组。禁止对不同类型的行分别
测量，以免出现边框错位。

### 7.3 最优列宽

每列最优内容宽度为：

```text
max(标题显示宽度, 该列所有单元格的最大显示宽度)
```

如果最优总宽度不超过可用宽度，使用完整表格，不换行。

### 7.4 最小列宽

每列最小内容宽度等于该列标题的显示宽度。加上左右 padding 后，每列至少能完整容纳
标题。

如果所有最小列宽、padding 和边框之和超过可用宽度，降级为无边框键值形式。

### 7.5 收缩与换行

当可用宽度小于最优总宽度但不小于最小总宽度：

1. 在进入收缩循环前计算最小总宽度。
2. 若 `minimumTotalWidth > availableWidth`，直接进入 §7.7 键值降级，不进入
   收缩循环。
3. 只有 `minimumTotalWidth <= availableWidth < optimalTotalWidth` 时才从最优
   内容宽度开始收缩。
4. 反复收缩当前最宽且尚未到最小值的列。
5. 宽度相同时按原列顺序稳定选择。
6. 当总宽度等于可用宽度时终止。由于前置条件保证最小总宽度不超过可用宽度，
   循环必然在所有列到达最小值之前或恰好到达最小值时满足终止条件。
7. 按最终内容宽度对单元格进行字符宽度感知换行。

同一数据行的物理高度取该行所有单元格换行后行数的最大值。较短单元格在缺失的物理
行补空格，保证每条竖边框落在完全相同的列坐标。

### 7.6 对齐

读取 `Tokens.Table.align`：

- `left` 或未指定：内容右侧补空格。
- `center`：左右均分补空格，奇数余量稳定放在右侧。
- `right`：内容左侧补空格。

左右单元格 padding 不参与 Markdown alignment，只包裹已经对齐的内容区域。

### 7.7 极窄终端降级

按每一条数据记录输出无边框键值对：

```text
工具: read_file
用途: 读取文件内容或列出目录

工具: glob
用途: 按文件名模式搜索文件
```

三列及以上表格按列顺序输出全部 `标题: 值`。记录之间保留一个空行。值仍按可用宽度
换行，续行缩进到值的起始位置，即：

```text
续行缩进 = 标题显示宽度 + displayWidth(": ")
```

例如标题 `Description` 的显示宽度为 11，`: ` 宽度为 2，则值从第 13 列开始，
续行前置 13 个空格。若 `标题 + ": "` 已占满或超过一行可用宽度，标题单独占一行，
值和续行从下一行第 0 列开始。

## 8. 内联 Markdown

单元格直接消费 `TableCell.tokens`。宽度基于用户最终看到的文本计算，而不是
Markdown 源码长度：

- `` `code` `` 测量为 `code`
- `**bold**` 测量为 `bold`
- `*em*` 测量为 `em`
- `[text](url)` 测量为 `text`

测量和渲染共享同一组 inline tokens：测量函数递归提取纯文本，渲染函数递归生成
样式片段。因此不需要先 strip Markdown 再尝试恢复样式。边框和 padding 使用默认前景
色，不对整张表格上色。

非 table token 继续使用 `token.raw`，因此本功能不会顺带改变标题、列表或分隔线。

## 9. 复制与选区

Inline V2 使用终端原生选区。用户拖选复制的是物理屏幕内容，包括边框字符。这与
项目中其他渲染内容（工具摘要、进度指示符）的复制行为一致。

store 保留 raw Markdown，选区复制和 store 数据是独立的两条路径。“拖选表格时自动
复制原始 Markdown”需要物理坐标到原始内容的逆映射，属于独立功能，不纳入本次表格
渲染范围。

## 10. 错误与降级

- `marked.lexer` 抛错：整个 assistant block 回退为 raw Markdown。
- 单个 table token 数据异常：该 token 回退为 `token.raw`，其他 token 正常渲染。
- 单元格为空：按空字符串参与布局，仍保留单元格。
- 标题为空：最小内容宽度至少为 1，防止零宽列。
- 终端可用宽度小于 1：回退 raw Markdown，不绘制边框。
- 未完成或 interrupted assistant：不进入表格布局器。

## 11. 复用清单

- Markdown 解析：`marked.lexer`、`Tokens.Table`
- 显示宽度：`src/tui/inline/text-layout.ts` 的 `displayWidth`
- React/终端渲染：Ink `Box`、`Text`
- resize：Inline V2 现有 `<Static>` 重挂载机制
- 测试：`ink-testing-library`、Vitest

不引入新的表格库、Markdown 库或宽度库。

## 12. 测试策略

### 12.1 单元测试

围绕 `layoutMarkdownTable` 进行 TDD：

- ASCII 两列表格在最优宽度下边框完全对齐。
- 中文标题和内容按宽度 2 对齐。
- 混合中英文不会使右边框漂移。
- 最优宽度下不换行。
- 中间宽度下收缩最宽列并在单元格内换行。
- 所有横边框和数据行的 `displayWidth` 完全相等。
- 最小宽度不足时降级键值形式。
- 三列键值降级不丢字段。
- left、center、right 对齐正确。
- 空单元格、空标题、ANSI 和 inline Markdown 测量正确。
- `br` 产生的多条逻辑行按其中最宽一行贡献列宽。
- image、裸链接和未知 inline token 的测宽兜底不会漏算或抛异常。

### 12.2 组件测试

- 正常完成的 assistant 把 table token 渲染为边框表格。
- 同一回答中的普通段落保持 raw Markdown。
- interrupted assistant 保留 raw table。
- interrupted 分支跳过 `marked.lexer` 和表格布局器。
- 表格前只有一个 assistant `●`。
- 两张表格按原始顺序渲染。
- resize 后使用新列宽重新布局。

### 12.3 集成回归

- `finishAssistant` 不修改 `AssistantBlock.text`。
- 流式阶段仍显示 raw Markdown。
- 固化切换只发生一次，不出现重复表格或 scrollback 重复写入。
- store 中的 assistant 原文不包含边框字符。
- Inline V2 物理帧包含表格边框，符合终端原生选区的既定复制行为。
- 现有 TUI/UI 测试、TypeScript 和本次文件 ESLint 通过。

## 13. 完成标准

- 示例工具列表在正常终端宽度下渲染为严格对齐的完整边框表格。
- 任一输出物理行的显示宽度与其对应边框宽度一致。
- 三层宽度策略均有失败先行的自动化测试。
- 流式、中断、resize 和原生选区行为符合本设计。
- 不新增依赖，不修改 store 中的原始 Markdown。
