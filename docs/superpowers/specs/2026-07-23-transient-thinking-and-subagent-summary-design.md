# 临时 Thinking 与子代理完成摘要设计

**日期：** 2026-07-23
**状态：** 已纳入第一轮设计审查，待最终复核
**范围：** TUI 消息生命周期与展示格式；不改变模型调用、工具执行或子代理结果语义

## 背景

当前 UI 在收到模型的 `content_block_start(type="thinking")` 后，立即通过 `BlockPipeline` 打印一条 finalized 的 `● Thinking…`。工具结果写回后，agent loop 会再次调用模型；如果新一轮也返回 thinking block，主消息区就会再永久增加一条 `● Thinking…`。

这不是工具组件伪造的 thinking：事件来自模型流。但 UI 把一个运行阶段错误地固化成了历史消息，并且在尚未收到非空 `thinking_delta` 时就对用户声称正在思考。

项目已经具备大部分所需能力：

- `MessagesStore.startStreamingThinking()` 和 `removeStreamingThinking()` 可以维护未固化 thinking。
- `BlockPipeline.thinkingBuffer` 可以保存隐藏内容。
- `ExpandableBlockStore` 和 `Ctrl+O` 可以展示完整内容。
- `PendingToolMessage` 已实现固定一行、共享 600ms 时钟和两列 glyph 槽。
- `formatThinkingSummary()` 已能生成耗时摘要。

本设计复用这些轮子，不重写消息系统。

## 目标

1. 模型实际处于 thinking 阶段时，活动区显示一条 `● Thinking…`。
2. `●` 每 600ms 闪烁，正文和布局不移动。
3. thinking 结束时，临时行消失并生成一条永久摘要：

   ```text
     Thought for 2s (ctrl+o to expand)
   ```

4. 一个 thinking block 对应至多一条临时消息和一条永久摘要。
5. 子代理运行期间只显示稳定单行；完成后只在消息区保留一条简要状态。
6. 完整 thinking 内容和完整子代理结果仍可供内部逻辑或展开视图使用。
7. 不重新展示子代理内部 `read_file/run_bash` 明细。

## 非目标

- 不改变 provider 的 reasoning/thinking 配置。
- 不生成或推测模型没有返回的 thinking 内容。
- 不把隐藏 reasoning 写入会话历史。
- 不重写 agent loop 或工具执行器。
- 不恢复已经删除的子代理 progress bridge。
- 不在本次设计中实现 Claude Code 完整的后台代理面板或多层树形 UI。

## 方案选择

### 采用：复用现有 streaming thinking store，新增专用叶子组件

`BlockPipeline` 使用现有 `appendStreamingThinking/eraseStreamingThinking` 接口维护临时状态，`InlineAppV2` 使用专用组件渲染。组件复用 spinner 共享时钟，但不与 pending tool 共用消息类型。

优点：

- 改动集中在既有边界。
- 不触碰 provider 和 agent loop 核心逻辑。
- 与已验证的 pending tool 稳定渲染模式一致。
- thinking 和 tool 的生命周期仍可独立测试。

### 不采用：抽象通用 PendingStatusMessage

Thinking、工具和子代理可以共享一个高度参数化组件，但这会扩大刚稳定下来的工具渲染范围，并引入当前需求不需要的抽象。

### 不采用：只在 Footer 显示 Thinking

实现最简单，但不符合运行期间在消息区显示临时 `Thinking…`、结束后留下 Thought 摘要的要求。

## 数据模型

为 thinking 增加明确的专用消息类型：

```ts
type TuiMessageKind =
  | 'turn-duration'
  | 'tool-progress'
  | 'thinking-progress';
```

thinking-progress 的不变量：

- `role === 'thinking'`
- `finalized === false`
- `kind === 'thinking-progress'`
- `lines` 不保存 reasoning 正文
- 任意时刻最多存在一条
- 只在活动区渲染，不进入 `<Static>`

永久 Thought 摘要继续使用 finalized 消息，不复用 thinking-progress 的 UUID。临时行被删除后才追加摘要，避免 Ink 同一帧同时看到两个版本。

## Thinking 状态机

```text
idle
  │ thinking_start
  ▼
awaitingContent
  │ first non-empty thinking_delta
  ▼
visible
  │ thinking_end
  ├──────────────► remove temporary row
  │                register expandable content
  │                append permanent Thought summary
  ▼
idle
```

### 空 thinking block

为保证 UI 诚实，`thinking_start` 只初始化 pipeline 状态，不立即显示。内部状态名为 `awaitingContent`，表示已收到 start、尚未观察到实际内容；收到首个 `content.trim().length > 0` 的 `thinking_delta` 后才创建 thinking-progress 并进入 `visible`。

如果 `thinking_end` 到来前始终没有非空 delta：

- 不显示临时 `Thinking…`。
- 不生成误导性的 Thought 摘要。
- 清空内部状态并回到 idle。

是否生成摘要以“是否曾进入 `visible`、即是否创建过 thinking-progress”为唯一判据，而不是在结束时重新检查 buffer。只要用户实际看见过闪烁的 `Thinking…`，结束时就必须生成对应摘要；纯空白 block 从未进入 visible，因此不生成。

### 正常完成

1. `thinking_start` 记录开始时间并进入 `awaitingContent`。
2. 首个非空 delta 创建 thinking-progress；后续 delta 只追加到 `thinkingBuffer`。
3. `thinking_end` 先从 buffer 构造完整内容并注册 expandable block。
4. 删除 thinking-progress。
5. 追加永久 Thought 摘要。
6. 清空 buffer 和活动状态。

操作顺序必须是 `registerExpandable → eraseThinkingProgress → appendSummary → clearBuffer`。即使 UI 删除或摘要追加失败，完整 thinking 内容也不能因为提前清空 buffer 而丢失。

### 异常和中止

下列路径必须调用同一个幂等清理入口：

- 用户 ESC/abort。
- provider error。
- 空响应。
- `loop_end`。
- 新 turn 开始时发现旧状态残留。

如果已经收到非空 delta，可以生成带已耗时的 Thought 摘要；如果没有实际 delta，只删除状态。不得留下 pending thinking 行。

thinking duration 始终按实际 `thinking_start → thinking_end/cleanup` 时间如实显示，不设五分钟等人为上限；长时间网络停顿属于真实观测时间。只需防御负数、`NaN` 和时钟倒退。

### 与 tool_call 的事件顺序

当前 Anthropic 适配器按 SSE 顺序逐个 yield：thinking 的 `content_block_stop` 先进入 `index.ts` 并触发 `thinking_end`；tool_use 只有在自己的 block stop 生成 AssistantMessage 后，`streamingQuery` 才发出 `tool_call`。因此正常路径不会出现 tool-progress 先于 thinking_end。

第三方兼容流或未来 adapter 仍可能乱序。防御规则是：收到任何 `tool_call` 时，如果 thinking 仍处于 `awaitingContent` 或 `visible`，先通过统一入口完成/清理 thinking，再创建 pending tool。一次状态提交中必须保持这个逻辑顺序，不允许留下同时可见的 thinking-progress 和由同一模型阶段产生的 tool-progress。

## PendingThinkingMessage

新增专用叶子组件，结构与 `PendingToolMessage` 保持一致：

```text
[固定 2 列 glyph 槽][Thinking…，单行]
```

渲染契约：

- `height={1}`，不允许换行。
- glyph 槽 `width={2}` 且 `minWidth={2}`。
- `active=true` 时按共享时钟每 600ms 切换 `●/空格`。
- `active=false` 但消息尚未清理时强制显示 `●`，避免空白槽。
- 组件只订阅 `spinnerStore.time` 和 `spinnerStore.active` 原始值。
- spinner tick 不得触发 `InlineAppV2` 根组件或 finalized 列表重渲染。

## Inline V2 布局

`InlineAppV2` 将未固化内容拆成三类：

```text
assistant streaming   → StreamingText
thinking-progress     → PendingThinkingMessage
tool-progress         → PendingToolMessage
```

活动区行数按结构计算：

```text
streaming assistant rows
+ pending thinking count（0 或 1）
+ pending tool count
+ spinner rows
```

不得再用 thinking 正文长度推算活动区高度。

## Thought 永久摘要

格式：

```text
  Thought for 2s (ctrl+o to expand)
  Thought for 1m 20s, read 12 files (ctrl+o to expand)
```

规则：

- `Thought` 首字母大写。
- 时间至少显示 `1s`。
- `>=60s` 使用 `Nm` 或 `Nm Ns`。
- `filesRead=0` 时省略读取数量。
- 只有存在可展开 thinking 内容时才添加 `(ctrl+o to expand)`。
- 每个具有非空 delta 的 thinking block生成一条摘要，不跨工具调用合并。

### 文件读取统计

当前 `index.ts` 固定传入 `filesRead: 0`。读取数量必须来自真实工具事件，不能扫描 assistant 文本猜测。

实现时按 thinking block 建立计数窗口：从首个非空 thinking delta 开始，到该 block 的永久摘要提交前结束。只有在该窗口内完成且工具名属于读取类白名单的调用才计数，同一调用按 `toolUseId` 去重。

如果当前事件时序证明工具调用总发生在 `thinking_end` 之后，则本次核心修复保留 `filesRead=0`，并把跨阶段读取统计拆为独立后续任务；不得为追求参考样式而错误归属计数。

## 子代理消息生命周期

### 运行中

继续使用现有固定单行 pending tool：

```text
● spawn_agent({role: "explore", prompt: "..."})
```

- 内部工具事件不进入主消息区。
- 输入过长时单行截断。
- 并行子代理各占一行并共享闪烁时钟。

### 完成

`spawn_agent` 的 UI 结果使用专用摘要，不走通用 raw-output 前四行预览：

```text
● Agent "列出可用技能" finished · 16s
```

状态映射：

```text
completed  → Agent "…" finished · 16s
incomplete → Agent "…" incomplete · 16s
unverified → Agent "…" unverified · 16s
error      → Agent "…" failed · 16s
```

为避免从长 prompt 猜测标题，给 `spawn_agent` 增加可选 `description` 展示字段，不改变既有必填参数或执行语义。名称提取顺序：

1. 非空 `description`。
2. `prompt` 的首个非空、非纯标点、且不是 JSON 容器开头的行；有效性使用 Unicode 字母/数字判断，不使用 ASCII-only 正则。
3. 兜底名称 `Agent`。

最终名称使用终端列宽截断函数处理，不能按 UTF-8 字节或 JavaScript code unit 生硬切片；中文、emoji 和组合字符不得被截成损坏文本。不得让模型额外生成标题。

完整 `SubagentResult` 保持原样：

- 原样返回给主 Agent，保证回答整合和状态判断不变。
- 注册为 expandable 内容，供 `Ctrl+O` 查看。
- 不写入简要完成行正文。
- `evidence.toolCallCount`、termination reason 和最终 summary 不得因 UI 格式化丢失。

### 时长数据

`StreamEventBus.onToolResult` 已提供 `duration`。UI block 必须显式携带 `durationMs`，只用于显示，不修改模型收到的 tool result。

## Ctrl+O 边界

本次保留现有“最近一个 expandable block”语义，不扩展成可选择的历史面板：

- 最新 Thought 摘要对应最新 thinking buffer。
- 最新子代理完成摘要对应完整子代理结果。
- 新 expandable block 会取代 Ctrl+O 当前目标。

这是现有架构限制；实现完整 Claude Code transcript 切换属于独立功能。

当一个 turn 留下多个 Thought 摘要时，较早摘要仍保留，但 `Ctrl+O` 只能打开最近注册的 expandable block。此限制必须写入用户文档和回归测试。当前不添加 `(1/2)` 编号：编号会暗示用户可以选择第一个块，而现有交互并不支持该能力。

## 错误处理与防御边界

- 重复 `thinking_start`：保持单例，不创建第二条 pending。
- 无 start 的 delta：按隐式 start 处理，但必须收到非空 delta 才显示。
- 重复 `thinking_end`：第二次为空操作，不追加第二条摘要。
- 清理目标不在消息列表：幂等返回，不删除相邻 assistant/tool 消息。
- pending thinking 与 pending tool 同时存在：按独立 kind 定位，禁止使用“删除最后一条未固化消息”的宽泛逻辑。
- 子代理结果解析失败：完全降级到当前通用 `tool_result` finalized 格式，即原始输出前四行加现有截断提示；不应用 Agent 专用模板，不能伪造 completed。
- 缺少 duration：使用安全兜底，不显示 `NaN` 或负数。
- 窄终端和中文双宽 prompt：摘要必须单行截断，不能改变 footer 坐标。

当 thinking 与多个并行 pending agent 同时存在时，活动区按真实行数增长。在高度很小的终端中可能占用大部分可视区；本次不增加隐藏、分页或折叠活跃任务的策略，以免用户失去正在运行任务的可见性。这是已知 UX 限制，不是行数计算错误。

## 测试策略

### 纯函数测试

- 600ms glyph 周期。
- `Thought` 时间和文件数格式。
- 子代理状态解析与标题提取。
- description 优先级、空首行、纯标点、JSON prompt 和 `Agent` 兜底。
- 中文双宽文本截断。

### Store 单元测试

- 首个非空 delta 后只有一个 thinking-progress。
- 删除 thinking 只按 kind/ID 定位，不误删 pending tool。
- 重复 start/end 幂等。
- buffer 只有空白字符时保持 awaitingContent，不创建摘要。
- abort/error/loop-end 后没有 pending thinking。
- 子代理完成时同一 toolUseId 原位转换为 finalized 摘要。

### Pipeline 集成测试

- `thinking_start → delta → end`：临时行消失，永久摘要出现一次。
- 空 thinking block：无临时行、无摘要。
- 正常 provider 顺序下 thinking_end 先于 tool_call；模拟乱序 tool_call 时先清理/完成 thinking，再创建工具行，中间状态无双 pending。
- `thinking → spawn_agent → thinking → final`：两个 Thought 摘要、一个子代理完成摘要，无残留 Thinking。
- 完整 thinking 和子代理内容仍进入 expandable store。
- 多个 thinking block 后 `Ctrl+O` 只指向最后一个，较早摘要仍可见；验证这是已记录限制。
- 畸形 SubagentResult 降级为现有通用四行预览，不生成 Agent finished。
- 完整子代理结果仍交付主 Agent。

### Ink 渲染测试

- Thinking glyph 闪烁时正文列和总行数不变。
- pending thinking、四个 pending agents 和 footer 同时存在时布局稳定。
- thinking 完成帧不存在临时与永久两份内容。
- 中文和窄终端（包括 `cols < 30`）不换行、不闪烁、不留下空白区域。

### Provider 回归测试

- Anthropic thinking 事件触发新生命周期。
- OpenAI/Google 没有 thinking 事件时不创建临时状态或摘要。
- tool call 本身不隐式创建 thinking。

## 成功标准

实际终端流程应符合：

```text
● Thinking…                         # 运行中，● 闪烁

  Thought for 11s (ctrl+o to expand) # thinking 完成后永久保留

● spawn_agent(...)                  # 子代理运行中，● 闪烁

● Agent "查找实现" finished · 2m 27s # 完成后永久保留一行
```

并满足：

- 不出现永久 `● Thinking…`。
- 不出现空 thinking 摘要。
- 不显示子代理内部工具明细。
- 不丢失完整子代理结果。
- 不出现 footer 位移、内容闪烁或空白活动区。
