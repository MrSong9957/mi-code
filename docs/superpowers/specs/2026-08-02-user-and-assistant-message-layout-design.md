# UserBlock 与 Completed Assistant 消息布局修复设计

**日期：** 2026-08-02

**状态：** 已确认，待实施计划

**范围：** Inline V2 的已固化 UserBlock 与 completed Assistant Markdown

## 1. 背景

当前 Inline V2 有三个相关的显示问题：

1. 多行用户输入在提交后丢失可见缩进，无法忠实显示 Tab 和空逻辑行。
2. 用户输入缺少完整的块级背景，不易与 Assistant、Tool 输出区分。
3. completed Assistant Markdown 的段落边界被放大，常出现两行或更多空白物理行；子代理相关回复只是该公共问题的一个表现。

问题位于渲染层。提交入口、历史记录和 transcript store 仍持有原始消息，因此不应在数据层清洗字符串。

## 2. 目标与非目标

### 2.1 目标

- UserBlock 仅在渲染副本中把 Tab 展开为 4 个空格。
- 保留 UserBlock 的逻辑空白行和正文字符。
- 按当前 UserBlock 的实际可渲染宽度进行显示宽度折行。
- 使用主题 `bgMuted` 覆盖 UserBlock 的整个可渲染行宽，包括空逻辑行。
- completed Assistant Markdown 的两个可渲染 token 之间，段落边界最终恰好为 1 个空白物理行。
- 保持代码块、列表、引用和表格的 token 内部结构。
- 用确定性测试覆盖 Unicode、极窄宽度和消息类型隔离。

### 2.2 非目标

- 不修改 submit-transformer、history、transcript store、消息类型或 reducer。
- 不修改 streaming、interrupted、lexer fallback、tool 或 system 渲染。
- 不建立通用 `PhysicalRow[]` 或其他全局消息中间模型；AssistantBlockLine 内部用于检查 token 首尾空白的局部行结果不属于全局模型。
- 不顺带重构相邻渲染组件。
- 不承诺操作系统或终端的原生鼠标选区会排除背景填充单元格；应用持有的消息文本和选区模型不得增加视觉填充字符。

## 3. 方案选择

采用语义渲染层定点修复：

- UserBlock 使用局部纯布局函数生成未填充的可见文本行，再由 Ink Box 提供整行背景。
- completed Assistant 在现有 Markdown token 渲染路径中规范化 token 之间的段落边界。

不采用渲染前字符串清洗，因为它可能改变 Markdown 语义并污染原始消息；不建立通用物理行模型，因为改动面超过当前问题所需。

## 4. 复用检查

实现应复用：

- `src/tui/state/wrap-line.ts` 的显示宽度折行能力；
- 项目现有的 `string-width` 使用方式；
- `src/utils/theme.ts` 的 `bgMuted` 主题槽位；
- `marked` lexer 与现有 `layoutMarkdownTable` 表格路径；
- `TranscriptBlockLine` 和 `AssistantBlockLine` 的现有语义分派。

Ink 7.1 的 `Box` 已原生支持 `backgroundColor`。其渲染器按 Yoga 计算后的内容区域填充背景，因此无需把尾随空格加入 UserBlock 的文本行。

现有 `wrapLine` 使用的 `@alcalzone/ansi-tokenize` 已通过 `Intl.Segmenter` 按 grapheme 生成可见字符 token，因此可以复用其 ANSI 样式保持和 grapheme 安全折行能力，无需另建 Unicode 分词器。

## 5. 架构与数据流

### 5.1 UserBlock

数据流保持为：

```text
原始用户输入
  -> submit-transformer
  -> transcript store 保存原文
  -> layoutUserBlockRows(text, width)
  -> UserBlock Ink 渲染
  -> 终端物理行
```

核心锚点为局部纯函数：

```ts
layoutUserBlockRows(text: string, width: number): string[]
```

`width` 表示当前 UserBlock 的实际可渲染安全宽度。它由组件所在布局计算并传入，已经考虑终端安全列、父级缩进和 padding；纯函数不得读取全局 terminal columns。

该函数只负责：

1. 创建渲染副本，并在副本中把每个 `\t` 展开为 4 个空格。
2. 使用 `split('\n')` 保留连续空逻辑行。
3. 按显示宽度折成物理行。
4. 返回未为背景追加尾随空格的文本行。

`TranscriptBlockLine` 为每个结果行渲染定宽、定高的 Box，并把 `theme.bgMuted` 应用于 Box。空逻辑行由空的定高 Box 承载。背景属于容器布局，不属于消息文本。

### 5.2 Completed Assistant Markdown

数据流保持为：

```text
completed AssistantBlock
  -> marked lexer
  -> 各非 space token 复用现有 raw/table 逻辑生成局部可检查行结果
  -> 检查相邻 token 的 trailing/leading 外部空白行
  -> inter-token 边界归一为恰好 1 个空白物理行
  -> 终端物理行
```

这是 `AssistantBlockLine` 内部的局部两阶段布局，不建立可供其他消息类型消费的物理行模型。第一阶段把每个非 `space` token 转成保留现有 raw/table 表现的可检查行结果；第二阶段只处理 token 之间的段落边界。局部行结果只需明确区分“有效内容行”和“显式空白行”：有效内容行之后仍可由 Ink 软折，显式空白行则一对一对应段落边界的空白物理行。边界规范化不得根据非空内容的软折结果作判断。

边界规则如下：

- 连续 `space` token 合并为一个待处理边界。
- 只有当边界位于两个可渲染 token 之间时才输出。
- 如果相邻 token 的既有 renderer 已在外部边界留下空白物理行，则不得再叠加第二行。
- 最终结果是两个可渲染 token 之间恰好 1 个空白物理行。
- 消息开头和结尾的 `space` token 不产生空白行。
- 非 `space` token 首尾、且参与相邻 token 分隔的空白行属于 token 外部边界，可以被计入或收紧到最终 1 行。
- 位于同一个非 `space` token 两个有效内容行之间的空白行属于 token 内部结构，不得压缩。

表格继续走 `layoutMarkdownTable`；lexer 或特定 token 渲染失败时沿用现有 raw fallback。

## 6. UserBlock 详细行为

### 6.1 Prefix

- 先在 Tab 展开后的首个逻辑行中取得正文首个 grapheme，并计算其显示宽度。
- 若存在正文首 grapheme，只有 `displayWidth('❯ ') + displayWidth(firstGrapheme) <= width` 时才显示 `❯ `；否则完全省略 prefix，优先保留正文。
- 若不存在正文首 grapheme，只有 prefix 自身能合法容纳时才允许显示；该兼容边界不得挤占后续逻辑行的正文宽度。
- prefix 决策完成后，首行使用扣除 prefix 后的预算折行；所有后续物理行使用完整 `width`。
- 例如 `width=3` 时，ASCII 首字符 `a` 可以显示为 `❯ a`；CJK 首字符 `中` 必须省略 prefix 并直接显示正文。
- 后续硬换行和软折行不注入额外缩进；原输入中的空格由渲染副本保留。
- `❯` 继续使用当前绿色粗体样式，正文前景色保持现状。

### 6.2 折行与 Unicode

- 折行以 grapheme 和显示宽度为约束，不得按 UTF-16 code unit 拆分字符。
- 不得为了满足宽度拆开或丢弃 CJK、Emoji 或组合字符。
- 仅当单个不可拆分 grapheme 的显示宽度本身大于 `width` 时，允许该 grapheme 占用超过 `width` 的原生列数。
- 除上述唯一例外外，每个物理行的显示宽度不得超过 `width`。
- 宽度输入需要安全钳制，异常宽度不得导致崩溃或丢失正文。

### 6.3 背景与文本边界

- 每个物理行的 Box 宽度等于传入的实际可渲染 `width`。
- 普通行、软折行和空逻辑行都使用 `theme.bgMuted`。
- 布局函数不为背景补齐尾随空格。
- 原始消息、transcript、history 和发给 Agent 的内容绝对不变。
- 应用内部选区模型不得把视觉背景填充加入消息文本。
- 终端原生鼠标复制是否包含背景填充单元格取决于终端行为，不作为本变更的验收承诺。

## 7. Assistant 详细行为

- 仅正常 completed Assistant Markdown 进入 token 边界规范化。
- 每个非 `space` token 先通过现有 raw/table 逻辑转换成 AssistantBlockLine 内部的可检查行结果，再执行跨 token 归一化。
- 边界规则针对两个可渲染 token 之间的最终物理结果，不以 `space` token 数量作为结果。
- 连续多个 `space` token、或相邻 renderer 已产生边界空行时，最终都只能保留 1 个空白物理行。
- token 首尾的外部空白行参与上述计数和归一化；token 有效内容内部的空白行不参与。
- fenced code、列表、引用和表格内部的空行完全保留。
- 表格与相邻正文之间遵守同一段落边界规则。
- `interrupted` Assistant 保持 raw 路径。
- lexer fallback 和 streaming Assistant 保持现状。
- 外层消息块现有 `marginBottom={1}` 保持不变；它负责消息之间的间距，不参与消息内部段落规范化。

## 8. 错误处理与防御边界

- `layoutUserBlockRows` 对非法或极小宽度采取确定性降级，不抛出布局异常。
- prompt prefix 永远可以降级省略，正文字符优先级更高。
- 单个 grapheme 超过可用宽度时只允许该 grapheme 自身产生最小必要溢出，不得把该例外泛化到普通行。
- Markdown token 边界规范化失败时回退到现有 raw 渲染，不得吞掉消息。
- 不在数据层捕获或修复渲染异常，避免改变消息语义。

## 9. 测试设计

### 9.1 UserBlock 纯函数

- Tab 在返回行中展开为 4 空格，输入文本仍保留原始 `\t`。
- 连续 `\n` 产生对应的空逻辑行。
- ASCII、CJK、Emoji 和组合字符按 grapheme 显示宽度折行。
- `width=3` 且首字符为 ASCII 时显示 `❯ `；同宽度下首字符为 CJK 时省略 prefix。
- 任意宽度下，只有 prefix 与正文首 grapheme 能在首行合法共存时才显示 prefix。
- 单个 grapheme 显示宽度大于 `width` 时不拆分、不丢失，只允许该 grapheme 的最小必要溢出。
- 其他所有返回行的显示宽度不超过 `width`。
- 返回行不含仅为背景添加的尾随空格。
- 相同输入重复调用得到完全相同结果。

### 9.2 UserBlock Ink 组件

- 父级传入的局部宽度决定 Box 宽度，不读取全局 terminal columns。
- 普通行、软折行和空逻辑行都有完整 `bgMuted` 背景。
- 深色与浅色主题分别解析为对应的 `bgMuted`。
- 只有 `❯` 保持绿色粗体，正文前景色不改变。
- 使用真实 Ink frame 验证物理行数量和 ANSI 背景，不只验证纯函数返回值。
- 需求样例中的命令和说明保留 4 空格缩进，并形成连续背景块。

### 9.3 Completed Assistant

- 两个普通段落之间最终恰好 1 个空白物理行。
- 非 `space` token 先生成局部可检查行结果，测试以组合后的最终行结果断言边界数量。
- 连续多个 `space` token 仍只产生 1 行。
- 开头和结尾的段落边界不产生额外空行。
- 相邻 renderer 已留下边界空行时不叠加第二行。
- fenced code、列表、引用和表格内部换行保持不变。
- 表格前后各遵守 1 行段落边界。
- 需求样例不再出现双倍空白行。
- interrupted、lexer fallback 和 streaming Assistant 输出保持现状。

### 9.4 集成回归与静态检查

- `TranscriptBlockLine` 的 user、assistant、tool、system 路由保持不变。
- 现有消息块 `marginBottom={1}` 保持不变。
- 运行新增或修改的当前测试。
- 运行 Inline V2 影响模块测试。
- 运行 TypeScript、lint，并确认无 unused 或 floating promise。

## 10. 验收标准

实现完成需要同时满足：

1. 用户需求样例中的内部缩进、空逻辑行和正文字符完整显示。
2. 每个 UserBlock 物理行的 `bgMuted` 覆盖当前实际可渲染宽度。
3. 原始消息和 transcript 内容未发生修改。
4. completed Assistant 的段落边界最终恰好为 1 个空白物理行。
5. 代码块、列表、引用、表格、streaming、interrupted、fallback、tool 和 system 行为未回归。
6. 目标测试、影响模块测试、TypeScript 和 lint 均通过。
