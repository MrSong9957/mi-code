# Claude Code 流式输出架构详解

> 本文档全面剖析 Claude Code 的流式输出实现方案，为移植到本项目提供完整的技术参考。
> 目标读者：即使是小白也能看懂。

---

## 目录

- [一、什么是流式输出？](#一什么是流式输出)
- [二、整体架构概览](#二整体架构概览)
- [三、核心数据流：从 API 到屏幕](#三核心数据流从-api-到屏幕)
- [四、第一层：API 流式调用（claude.ts）](#四第一层api-流式调用claudets)
- [五、第二层：查询引擎（QueryEngine.ts）](#五第二层查询引擎queryenginets)
- [六、第三层：查询循环与流式工具执行（query.ts）](#六第三层查询循环与流式工具执行queryts)
- [七、第四层：UI 渲染（Markdown.tsx）](#七第四层ui-渲染markdowntsx)
- [八、关键设计模式总结](#八关键设计模式总结)
- [九、移植到本项目的方案](#九移植到本项目的方案)
- [十、核心代码片段参考](#十核心代码片段参考)

---

## 一、什么是流式输出？

### 生活类比

想象你在和一个朋友打电话：

- **非流式**：朋友说完一整段话，你才能听到。说完之前，电话里一片沉默。
- **流式**：朋友每说一个字，你就能立刻听到。你不用等他说完整段话。

流式输出就是让 AI 的回答**一个字一个字地"蹦"出来**，而不是等整个回答生成完毕才一次性显示。

### 为什么需要流式？

| 非流式 | 流式 |
|--------|------|
| 用户等待时间长（可能 10-30 秒） | 几乎立即看到输出（<1 秒） |
| 无法中途取消 | 可以随时中断 |
| 无法实时显示工具执行状态 | 工具调用过程可视化 |
| 用户体验差 | 用户体验好 |

---

## 二、整体架构概览

Claude Code 的流式输出分为 **四层**，就像一条流水线：

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户看到的终端界面                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第四层：UI 渲染层（StreamingMarkdown）                      │  │
│  │  - 增量渲染 Markdown                                       │  │
│  │  - 稳定区/不稳定区分离                                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ▲                                   │
│                              │ yield 消息                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第三层：查询循环（query.ts）                                │  │
│  │  - 管理工具执行循环                                         │  │
│  │  - 流式工具执行器（StreamingToolExecutor）                   │  │
│  │  - 自动压缩、错误恢复                                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ▲                                   │
│                              │ yield 消息                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第二层：查询引擎（QueryEngine.ts）                          │  │
│  │  - 会话状态管理                                             │  │
│  │  - 消息规范化与分发                                         │  │
│  │  - 流式事件转换                                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ▲                                   │
│                              │ yield 流式事件                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  第一层：API 流式调用（claude.ts）                           │  │
│  │  - 调用 Anthropic API（stream: true）                       │  │
│  │  - 解析 SSE 事件流                                          │  │
│  │  - 累积内容块                                               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ▲                                   │
│                              │ HTTP SSE                          │
│                      Anthropic API 服务器                         │
└─────────────────────────────────────────────────────────────────┘
```

### 核心技术栈

| 技术 | 作用 | 类比 |
|------|------|------|
| **AsyncGenerator** | 异步生成器，逐个产出数据 | 传送带，一个一个送包裹 |
| **SSE (Server-Sent Events)** | 服务器推送事件流 | 水管，水（数据）持续流出 |
| **Anthropic SDK** | API 客户端库 | 快递公司的 API |
| **React + Ink** | 终端 UI 框架 | 终端里的 React |

---

## 三、核心数据流：从 API 到屏幕

整个流式输出的数据流转过程：

```
API 服务器
  │
  │ SSE 事件流（message_start, content_block_start, content_block_delta, ...）
  ▼
claude.ts（API 层）
  │
  │ yield StreamEvent | AssistantMessage | SystemAPIErrorMessage
  ▼
QueryEngine.ts（引擎层）
  │
  │ yield Message | StreamEvent（规范化后的消息）
  ▼
query.ts（循环层）
  │
  │ yield Message | StreamEvent（带工具执行结果）
  ▼
Messages.tsx → StreamingMarkdown（UI 层）
  │
  │ React 渲染
  ▼
终端屏幕显示
```

### 消息类型一览

```typescript
// 流式事件（从 API 直接返回的原始事件）
interface StreamEvent {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent  // API 原始事件
  session_id: string
  uuid: string
}

// 助手消息（AI 的回答）
interface AssistantMessage {
  type: 'assistant'
  message: {
    content: ContentBlock[]  // 文本、工具调用等
    stop_reason: string | null
    usage: Usage
  }
  uuid: string
  timestamp: string
}

// 用户消息（包含工具执行结果）
interface UserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: ContentBlockParam[]
  }
  uuid: string
}
```

---

## 四、第一层：API 流式调用（claude.ts）

### 文件位置

`src/services/api/claude.ts`

### 核心函数：`queryModelWithStreaming`

```typescript
export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages, systemPrompt, thinkingConfig,
      tools, signal, options,
    )
  })
}
```

**关键点：**
- 使用 `async function*`（异步生成器函数）
- 通过 `yield*` 将内部生成器的值逐个传递出去
- `withStreamingVCR` 是一个包装器，用于录制/回放流式数据（调试用）

### 流式 API 调用

```typescript
// 使用 Anthropic SDK 的流式 API
const result = await anthropic.beta.messages
  .create(
    { ...params, stream: true },  // 关键：stream: true
    { signal },
  )
  .withResponse()

stream = result.data  // Stream<BetaRawMessageStreamEvent>
```

**物理类比：** 这就像打开一个水龙头。`stream: true` 就是拧开水龙头的开关，之后水（数据）就会持续流出来。

### 流式事件处理循环

```typescript
// 遍历流中的每一个事件
for await (const part of stream) {
  switch (part.type) {
    case 'message_start':
      // 消息开始，初始化状态
      partialMessage = part.message
      ttftMs = Date.now() - start  // 首 token 时间（Time To First Token）
      break

    case 'content_block_start':
      // 内容块开始（文本、工具调用、思考等）
      switch (part.content_block.type) {
        case 'text':
          contentBlocks[part.index] = { ...part.content_block, text: '' }
          break
        case 'tool_use':
          contentBlocks[part.index] = { ...part.content_block, input: '' }
          break
        case 'thinking':
          contentBlocks[part.index] = { ...part.content_block, thinking: '' }
          break
      }
      break

    case 'content_block_delta':
      // 内容块增量更新（核心！每个 token 都在这里到达）
      const contentBlock = contentBlocks[part.index]
      switch (delta.type) {
        case 'text_delta':
          contentBlock.text += delta.text       // 追加文本
          break
        case 'input_json_delta':
          contentBlock.input += delta.partial_json  // 追加工具输入 JSON
          break
        case 'thinking_delta':
          contentBlock.thinking += delta.thinking   // 追加思考内容
          break
        case 'signature_delta':
          contentBlock.signature = delta.signature  // 思考内容签名
          break
      }
      break

    case 'content_block_stop':
      // 内容块完成，创建 AssistantMessage 并 yield
      const m: AssistantMessage = {
        message: {
          ...partialMessage,
          content: normalizeContentFromAPI([contentBlock]),
        },
        requestId: streamRequestId,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      }
      newMessages.push(m)
      yield m  // 输出给上层
      break

    case 'message_delta':
      // 消息级别更新（usage、stop_reason）
      usage = updateUsage(usage, part.usage)
      stopReason = part.delta.stop_reason

      // 写回到最后一条消息（直接修改引用）
      const lastMsg = newMessages.at(-1)
      if (lastMsg) {
        lastMsg.message.usage = usage
        lastMsg.message.stop_reason = stopReason
      }
      break

    case 'message_stop':
      // 消息结束
      break
  }

  // 每个事件都输出为 StreamEvent（供 UI 实时渲染）
  yield {
    type: 'stream_event',
    event: part,
    ...(part.type === 'message_start' ? { ttftMs } : undefined),
  }
}
```

**物理类比：** 就像拆快递的过程：
1. `message_start` → 快递到了，开始拆
2. `content_block_start` → 打开一个盒子
3. `content_block_delta` → 一点一点拿出里面的东西（**每个 token**）
4. `content_block_stop` → 这个盒子拆完了
5. `message_delta` → 更新账单（用了多少 token）
6. `message_stop` → 所有盒子都拆完了

### 流式空闲超时看门狗

```typescript
// 防止流式连接挂起（网络断开、服务器无响应等）
const STREAM_IDLE_TIMEOUT_MS = 90_000  // 90 秒

function resetStreamIdleTimer(): void {
  clearStreamIdleTimers()
  streamIdleTimer = setTimeout(() => {
    streamIdleAborted = true
    releaseStreamResources()  // 释放连接资源
  }, STREAM_IDLE_TIMEOUT_MS)
}

// 每收到一个事件就重置定时器
for await (const part of stream) {
  resetStreamIdleTimer()  // 收到数据，重置计时
  // ... 处理事件
}

// 流结束后清除定时器
clearStreamIdleTimers()
```

**物理类比：** 就像一个倒计时器。如果 90 秒内没收到任何数据，就认为连接断了，自动关闭水龙头。

### 流式停滞检测

```typescript
const STALL_THRESHOLD_MS = 30_000  // 30 秒算一次停滞
let totalStallTime = 0
let stallCount = 0
let lastEventTime: number | null = null

for await (const part of stream) {
  const now = Date.now()

  // 检测停滞（排除首 token 时间）
  if (lastEventTime !== null) {
    const timeSinceLastEvent = now - lastEventTime
    if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
      stallCount++
      totalStallTime += timeSinceLastEvent
      logForDebugging(`Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap`)
    }
  }
  lastEventTime = now
}
```

---

## 五、第二层：查询引擎（QueryEngine.ts）

### 文件位置

`src/QueryEngine.ts`（约 46K 行，项目最核心的文件）

### 核心职责

1. **会话状态管理**：维护消息历史、token 使用量、费用追踪
2. **消息规范化**：将不同类型的事件转换为统一格式
3. **流式事件分发**：将事件传递给 UI 层
4. **会话持久化**：将消息记录到磁盘

### 消息处理循环

```typescript
// QueryEngine 内部的 ask() 方法
for await (const message of query(...)) {
  // 记录到会话历史
  messages.push(message)

  // 持久化到磁盘（注意：assistant 消息是异步写入，不阻塞流式输出）
  if (persistSession) {
    if (message.type === 'assistant') {
      void recordTranscript(messages)  // fire-and-forget，不阻塞
    } else {
      await recordTranscript(messages)  // 其他消息确保写入
    }
  }

  // 根据消息类型分发
  switch (message.type) {
    case 'assistant':
      // 捕获 stop_reason
      if (message.message.stop_reason != null) {
        lastStopReason = message.message.stop_reason
      }
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)  // 规范化后输出给 UI
      break

    case 'stream_event':
      // 处理流式事件
      if (message.event.type === 'message_start') {
        currentMessageUsage = updateUsage(EMPTY_USAGE, message.event.message.usage)
      }
      if (message.event.type === 'message_delta') {
        currentMessageUsage = updateUsage(currentMessageUsage, message.event.usage)
        if (message.event.delta.stop_reason != null) {
          lastStopReason = message.event.delta.stop_reason
        }
      }
      if (message.event.type === 'message_stop') {
        this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
      }

      // 输出给 UI 层（用于实时渲染 token-by-token）
      if (includePartialMessages) {
        yield {
          type: 'stream_event' as const,
          event: message.event,
          session_id: getSessionId(),
          uuid: randomUUID(),
        }
      }
      break

    case 'user':
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)
      break

    case 'progress':
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)
      break

    case 'attachment':
      this.mutableMessages.push(message)
      // 处理特殊附件类型
      if (message.attachment.type === 'structured_output') {
        structuredOutputFromTool = message.attachment.data
      }
      break
  }
}
```

**关键设计决策：**
- `assistant` 消息使用 `void recordTranscript(messages)`（异步、不阻塞）
- 其他消息使用 `await recordTranscript(messages)`（同步、确保写入）
- 原因：流式输出时不能被磁盘 I/O 阻塞，否则用户会看到卡顿

---

## 六、第三层：查询循环与流式工具执行（query.ts）

### 文件位置

`src/query.ts`

### 核心职责

1. **查询循环**：AI 调用 → 工具执行 → 再次调用 AI 的循环
2. **流式工具执行**：在 AI 输出过程中就开始执行工具
3. **错误恢复**：自动重试、降级处理、上下文压缩

### 查询循环总览

```typescript
export async function* query(params: QueryParams): AsyncGenerator<...> {
  while (true) {
    // ═══════ 阶段 1：准备 ═══════
    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    // 应用 snip 压缩（裁剪旧消息）
    // 应用 microcompact（微压缩）
    // 应用 autocompact（自动压缩）
    // 检查 token 限制

    // ═══════ 阶段 2：调用 AI（流式）═══════
    const assistantMessages: AssistantMessage[] = []
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    for await (const message of deps.callModel({
      messages: messagesForQuery,
      systemPrompt: fullSystemPrompt,
      tools: toolUseContext.options.tools,
      signal: toolUseContext.abortController.signal,
      options: { ... },
    })) {
      // 处理流式消息
      if (message.type === 'assistant') {
        assistantMessages.push(message)
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            toolUseBlocks.push(block)
            needsFollowUp = true
            // 流式执行：AI 还在输出时就开始执行工具
            streamingToolExecutor?.addTool(block, message)
          }
        }
      }
      yield message  // 输出给上层（UI 可以实时渲染）
    }

    // ═══════ 阶段 3：检查是否继续 ═══════
    if (!needsFollowUp) {
      return { reason: 'end_turn' }  // 没有工具调用，结束循环
    }

    // ═══════ 阶段 4：获取工具执行结果 ═══════
    if (streamingToolExecutor) {
      // 流式执行器已经在后台执行了，这里等待结果
      for await (const results of streamingToolExecutor.getRemainingResults()) {
        for (const result of results) {
          toolResults.push(result)
          yield result  // 输出工具结果
        }
      }
    } else {
      // 传统方式：等所有工具执行完
      const results = await runTools(toolUseBlocks, toolUseContext)
      toolResults.push(...results)
      for (const result of results) {
        yield result
      }
    }

    // ═══════ 阶段 5：更新状态，继续循环 ═══════
    state = {
      ...state,
      messages: [...messages, ...assistantMessages, ...toolResults],
    }
  }
}
```

### 流式工具执行器（StreamingToolExecutor）

这是 Claude Code 的一个**精妙设计**：在 AI 还在输出时，就开始执行已经收到的工具调用。

```typescript
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private siblingAbortController: AbortController

  constructor(
    private readonly toolDefinitions: Tools,
    private readonly canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
  ) {
    this.siblingAbortController = createChildAbortController(
      toolUseContext.abortController,
    )
  }

  // ═══════ 添加工具到执行队列 ═══════
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
    const toolDefinition = findToolByName(this.toolDefinitions, block.name)
    if (!toolDefinition) {
      // 工具不存在，直接标记为完成并记录错误
      this.tools.push({
        id: block.id,
        block,
        assistantMessage,
        status: 'completed',
        isConcurrencySafe: true,
        results: [createErrorMessage(`No such tool: ${block.name}`)],
        pendingProgress: [],
      })
      return
    }

    // 解析输入，判断是否可以并发执行
    const parsedInput = toolDefinition.inputSchema.safeParse(block.input)
    const isConcurrencySafe = parsedInput?.success
      ? Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
      : false

    this.tools.push({
      id: block.id,
      block,
      assistantMessage,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
    })

    void this.processQueue()  // 立即尝试执行
  }

  // ═══════ 并发控制 ═══════
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter(t => t.status === 'executing')
    // 没有正在执行的工具，或者所有正在执行的工具都是并发安全的
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
    )
  }

  // ═══════ 处理执行队列 ═══════
  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool)
      } else {
        // 不能执行：如果是非并发工具，必须等待前面的完成
        if (!tool.isConcurrencySafe) break
      }
    }
  }

  // ═══════ 执行单个工具 ═══════
  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = 'executing'

    try {
      const results = await runToolUse(
        tool.block,
        tool.assistantMessage,
        this.toolDefinitions,
        this.canUseTool,
        this.toolUseContext,
        this.siblingAbortController.signal,
      )
      tool.results = results
      tool.status = 'completed'
    } catch (error) {
      tool.results = [createErrorMessage(String(error))]
      tool.status = 'completed'
    }

    // 通知等待者
    this.progressAvailableResolve?.()
  }

  // ═══════ 获取结果（按顺序，异步生成器）═══════
  async *getRemainingResults(): AsyncGenerator<Message[]> {
    for (const tool of this.tools) {
      // 等待工具完成
      while (tool.status !== 'completed' && tool.status !== 'yielded') {
        await new Promise<void>(resolve => {
          this.progressAvailableResolve = resolve
        })
      }

      if (tool.status === 'completed') {
        tool.status = 'yielded'
        yield tool.results ?? []
      }
    }
  }

  // ═══════ 丢弃所有待执行工具（流式降级时调用）═══════
  discard(): void {
    this.discarded = true
  }
}
```

### 并发模型图解

```
时间线 ─────────────────────────────────────────────────────►

AI 输出:  [tool_use: read_file] [tool_use: grep] [tool_use: write_file]
                │                    │                    │
                ▼                    ▼                    ▼
执行队列:    queued               queued               queued
                │                    │                    │
                ▼                    ▼                    │
并发检查:  isConcurrencySafe=true  isConcurrencySafe=true  isConcurrencySafe=false
                │                    │                    │
                ▼                    ▼                    ▼
执行状态:   executing             executing              queued（等待）
           (并行执行)            (并行执行)                 │
                │                    │                    │
                ▼                    ▼                    ▼
完成:       completed             completed            executing（独占）
                │                    │                    │
                ▼                    ▼                    ▼
结果输出:   [结果1]               [结果2]               [结果3]
           (按顺序输出，即使 grep 先完成，也要等 read_file 输出)
```

**物理类比：** 就像一个快递分拣中心：
- AI 输出的每个工具调用就是一个快递包裹
- `addTool` → 包裹放到传送带上
- `processQueue` → 分拣员根据包裹类型决定怎么处理
- 并发安全的工具（读文件、搜索）→ 可以同时拆多个包裹
- 非并发工具（写文件、执行命令）→ 必须一个一个拆
- `getRemainingResults` → 等所有包裹拆完，按顺序取结果

---

## 七、第四层：UI 渲染（Markdown.tsx）

### 文件位置

`src/components/Markdown.tsx`

### 核心挑战

流式 Markdown 渲染的难点：
- 文本在不断增长（每个 token 到达都要重新渲染）
- 如果每次都解析全部 Markdown，会越来越慢
- 需要保持已渲染部分的稳定性（不能闪烁）

### 解决方案：稳定区/不稳定区分离

```typescript
/**
 * 流式 Markdown 渲染器
 *
 * 核心思想：将文本分为两部分
 * - 稳定区（stablePrefix）：已完成的 Markdown 块，缓存不重新解析
 * - 不稳定区（unstableSuffix）：正在增长的块，每次增量重新解析
 *
 * 物理类比：就像写黑板
 * - 稳定区 = 已经写好的部分，用粉笔画了线，不会再改
 * - 不稳定区 = 正在写的部分，可能随时修改
 */
export function StreamingMarkdown({ children }: StreamingProps): React.ReactNode {
  // 告诉 React Compiler 不要优化这个组件
  // 因为我们会在渲染期间修改 ref（这是设计如此）
  'use no memo'

  configureMarked()

  // 去除 XML 标签（与 <Markdown> 组件保持一致）
  const stripped = stripPromptXMLTags(children)

  // 稳定区的引用（跨渲染保持）
  const stablePrefixRef = useRef('')

  // 如果文本被替换（正常情况下由组件卸载处理）
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  // 只从当前边界开始解析 —— O(不稳定长度)，不是 O(全文长度)
  const boundary = stablePrefixRef.current.length
  const tokens = marked.lexer(stripped.substring(boundary))

  // 找到最后一个非空 token（这就是正在增长的块）
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--
  }

  // 计算稳定区的推进量
  // 最后一个 token 之前的都是已完成的块
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length
  }

  // 推进稳定区边界（单调递增，不会回退）
  if (advance > 0) {
    stablePrefixRef.current = stripped.substring(0, boundary + advance)
  }

  const stablePrefix = stablePrefixRef.current
  const unstableSuffix = stripped.substring(stablePrefix.length)

  // stablePrefix 在 <Markdown> 内部通过 useMemo 缓存
  // 所以它永远不会随着 unstableSuffix 的增长而重新解析
  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}
    </Box>
  )
}
```

### 图解：稳定区/不稳定区的工作原理

假设 AI 正在输出一段 Markdown：

```
第 1 帧（收到 "# 标题\n\n"）:
  稳定区: ""（空）
  不稳定区: "# 标题\n\n"
  解析范围: "# 标题\n\n"（全部）

第 2 帧（收到 "这是第一段。\n\n"）:
  稳定区: ""（还没推进）
  不稳定区: "# 标题\n\n这是第一段。\n\n"
  解析范围: "# 标题\n\n这是第一段。\n\n"（全部）

第 3 帧（收到 "这是第二段，正在"）:
  稳定区: "# 标题\n\n这是第一段。\n\n" ← 推进了！
  不稳定区: "这是第二段，正在"
  解析范围: "这是第二段，正在"（只解析这一小段！）

第 4 帧（收到 "写...\n"）:
  稳定区: "# 标题\n\n这是第一段。\n\n"（不变）
  不稳定区: "这是第二段，正在写...\n"
  解析范围: "这是第二段，正在写...\n"（只解析这一小段！）
```

**性能优势：** 当文本很长时（比如 10000 字），每次增量只需要解析最后几十个字，而不是全部 10000 字。

---

## 八、关键设计模式总结

### 1. AsyncGenerator 模式

整个流式架构的核心是 **异步生成器**（AsyncGenerator）：

```typescript
// 生产者：逐个产出数据
async function* fetchData(): AsyncGenerator<Data> {
  for await (const chunk of apiStream) {
    yield processChunk(chunk)
  }
}

// 消费者：逐个处理数据
for await (const data of fetchData()) {
  render(data)
}

// 链式组合：yield* 传递给上层
async function* outer(): AsyncGenerator<Data> {
  yield* fetchData()  // 内部生成器的值直接传递出去
}
```

**为什么用 AsyncGenerator 而不是 EventEmitter？**

| AsyncGenerator | EventEmitter |
|----------------|--------------|
| 内置背压控制 | 需要手动实现 |
| 类型安全 | 类型不安全 |
| 可组合（yield*） | 不可组合 |
| 惰性计算 | 主动推送 |

### 2. 事件驱动的状态累积

```typescript
// 状态在事件处理过程中逐步累积
// 就像拼图：每收到一块就拼上去，最后拼出完整画面
let contentBlocks: ContentBlock[] = []
let usage: Usage = EMPTY_USAGE

for await (const event of stream) {
  switch (event.type) {
    case 'content_block_start':
      // 放一块新拼图
      contentBlocks[event.index] = { ...event.content_block, text: '' }
      break
    case 'content_block_delta':
      // 在这块拼图上添加细节
      contentBlocks[event.index].text += event.delta.text
      break
    case 'content_block_stop':
      // 这块拼图完成了，输出
      yield createMessage(contentBlocks[event.index])
      break
  }
}
```

### 3. 并发控制的工具执行

```typescript
// 工具执行的并发模型
type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

// 并发安全检查
// 只读工具（读文件、搜索）→ 并发安全
// 写入工具（写文件、执行命令）→ 必须独占
canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executing = this.tools.filter(t => t.status === 'executing')
  return executing.length === 0 ||
    (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))
}
```

### 4. 增量渲染的缓存策略

```typescript
// 稳定区/不稳定区分离
// 就像看书：已经读过的页不用重新读，只看正在读的这页
const stablePrefix = stablePrefixRef.current   // 已读的页，缓存
const unstableSuffix = text.substring(stablePrefix.length)  // 正在读的页

// 渲染
<Markdown>{stablePrefix}</Markdown>    // 缓存的，不重新渲染
<Markdown>{unstableSuffix}</Markdown>  // 增量的，每次重新渲染
```

---

## 九、移植到本项目的方案

### 方案概述

本项目（mi-code）是一个 TypeScript CLI 工具，需要实现类似 Claude Code 的流式输出。

### 需要实现的核心模块

| 模块 | 对应 Claude Code 文件 | 优先级 | 复杂度 | 说明 |
|------|----------------------|--------|--------|------|
| 消息类型定义 | `types/message.ts` | P0 | 低 | 定义所有消息类型 |
| API 流式调用 | `services/api/claude.ts` | P0 | 中 | 封装 Anthropic SDK 流式调用 |
| 流式 Markdown 渲染 | `components/Markdown.tsx` | P1 | 中 | 增量渲染 |
| 查询循环 | `query.ts` | P1 | 高 | 工具执行循环 |
| 流式工具执行器 | `StreamingToolExecutor.ts` | P2 | 中 | 并发工具执行 |
| 查询引擎 | `QueryEngine.ts` | P2 | 高 | 会话状态管理 |

### 第一步：定义消息类型

```typescript
// src/types/stream.ts

/** API 流式事件 */
export interface StreamEvent {
  type: 'stream_event'
  event: RawStreamEvent
}

/** 原始流式事件（来自 API） */
export type RawStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent

export interface MessageStartEvent {
  type: 'message_start'
  message: {
    id: string
    model: string
    usage: Usage
  }
}

export interface ContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block: ContentBlock
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'thinking_delta'; thinking: string }
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

export interface MessageDeltaEvent {
  type: 'message_delta'
  delta: { stop_reason: string | null }
  usage: Usage
}

export interface MessageStopEvent {
  type: 'message_stop'
}

/** 助手消息 */
export interface AssistantMessage {
  type: 'assistant'
  content: ContentBlock[]
  stopReason: string | null
  usage: Usage
  requestId?: string
}

/** 内容块 */
export interface ContentBlock {
  type: 'text' | 'tool_use' | 'thinking'
  text?: string
  name?: string
  input?: string | Record<string, unknown>
  thinking?: string
}

/** 使用量 */
export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** 所有可能的流式消息类型 */
export type StreamMessage =
  | StreamEvent
  | AssistantMessage
  | UserMessage
  | ToolResultMessage
```

### 第二步：实现 API 流式调用

```typescript
// src/services/streaming.ts

import Anthropic from '@anthropic-ai/sdk'
import type { StreamMessage, AssistantMessage, ContentBlock } from '../types/stream.js'

export interface StreamChatOptions {
  client: Anthropic
  model: string
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>
  systemPrompt: string
  tools?: Tool[]
  signal: AbortSignal
  maxTokens?: number
}

/**
 * 流式调用 AI API
 *
 * 物理类比：打开水龙头，水（token）持续流出
 */
export async function* streamChat(
  options: StreamChatOptions,
): AsyncGenerator<StreamMessage> {
  const { client, model, messages, systemPrompt, tools, signal, maxTokens = 8192 } = options

  // 创建流式请求（stream: true = 打开水龙头）
  const stream = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      messages,
      system: systemPrompt,
      tools,
      stream: true,
    },
    { signal },
  )

  // 状态累积
  const contentBlocks: ContentBlock[] = []
  let usage = { input_tokens: 0, output_tokens: 0 }

  // 遍历每一个流式事件
  for await (const event of stream) {
    // 输出原始事件（供 UI 实时显示 token）
    yield { type: 'stream_event', event }

    switch (event.type) {
      case 'message_start':
        usage = event.message.usage
        break

      case 'content_block_start':
        contentBlocks[event.index] = {
          type: event.content_block.type as ContentBlock['type'],
          text: '',
        }
        break

      case 'content_block_delta':
        if (event.delta.type === 'text_delta') {
          contentBlocks[event.index].text =
            (contentBlocks[event.index].text ?? '') + event.delta.text
        } else if (event.delta.type === 'input_json_delta') {
          const current = contentBlocks[event.index].input
          contentBlocks[event.index].input =
            (typeof current === 'string' ? current : '') + event.delta.partial_json
        } else if (event.delta.type === 'thinking_delta') {
          contentBlocks[event.index].thinking =
            (contentBlocks[event.index].thinking ?? '') + event.delta.thinking
        }
        break

      case 'content_block_stop':
        // 内容块完成，输出助手消息
        yield {
          type: 'assistant',
          content: [contentBlocks[event.index]],
          stopReason: null,
          usage,
        }
        break

      case 'message_delta':
        usage = { ...usage, ...event.usage }
        break
    }
  }
}
```

### 第三步：实现流式 Markdown 渲染

```typescript
// src/components/StreamingMarkdown.tsx

import React, { useRef } from 'react'
import { marked } from 'marked'

interface StreamingMarkdownProps {
  children: string
}

/**
 * 流式 Markdown 渲染器
 *
 * 核心思想：将文本分为稳定区和不稳定区
 * - 稳定区：已完成的 Markdown 块，缓存不重新解析
 * - 不稳定区：正在增长的块，每次增量重新解析
 *
 * 性能优势：当文本 10000 字时，每次只解析最后几十个字
 */
export function StreamingMarkdown({ children }: StreamingMarkdownProps) {
  const stablePrefixRef = useRef('')

  // 如果文本被替换（正常情况下由组件卸载处理）
  if (!children.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  // 只从当前边界开始解析
  const boundary = stablePrefixRef.current.length
  const tokens = marked.lexer(children.substring(boundary))

  // 找到最后一个非空 token（正在增长的块）
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx].type === 'space') {
    lastContentIdx--
  }

  // 计算稳定区推进量
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i].raw.length
  }

  if (advance > 0) {
    stablePrefixRef.current = children.substring(0, boundary + advance)
  }

  const stablePrefix = stablePrefixRef.current
  const unstableSuffix = children.substring(stablePrefix.length)

  return (
    <div>
      {stablePrefix && (
        <div dangerouslySetInnerHTML={{ __html: marked.parse(stablePrefix) }} />
      )}
      {unstableSuffix && (
        <div dangerouslySetInnerHTML={{ __html: marked.parse(unstableSuffix) }} />
      )}
    </div>
  )
}
```

### 第四步：实现查询循环

```typescript
// src/query/streaming.ts

import type { StreamMessage } from '../types/stream.js'
import { streamChat } from '../services/streaming.js'

export interface QueryParams {
  client: Anthropic
  model: string
  messages: Message[]
  systemPrompt: string
  tools: Tool[]
  signal: AbortSignal
  maxIterations?: number
}

/**
 * 查询循环：AI 调用 → 工具执行 → 再次调用 AI
 *
 * 物理类比：就像打乒乓球
 * 1. 用户发球（发消息）
 * 2. AI 接球并回球（调用 AI，可能触发工具）
 * 3. 工具执行（捡球）
 * 4. AI 继续回球（用工具结果继续对话）
 * 5. 直到 AI 不再需要工具（回合结束）
 */
export async function* streamingQuery(
  params: QueryParams,
): AsyncGenerator<StreamMessage> {
  const { client, model, systemPrompt, tools, signal, maxIterations = 10 } = params
  let messages = [...params.messages]
  let iteration = 0

  while (iteration < maxIterations) {
    iteration++

    // 调用 AI（流式）
    const assistantMessages: AssistantMessage[] = []
    const toolUseBlocks: ToolUseBlock[] = []

    for await (const message of streamChat({
      client,
      model,
      messages,
      systemPrompt,
      tools,
      signal,
    })) {
      yield message  // 实时输出给 UI

      // 收集助手消息和工具调用
      if (message.type === 'assistant') {
        assistantMessages.push(message)
        for (const block of message.content) {
          if (block.type === 'tool_use') {
            toolUseBlocks.push(block)
          }
        }
      }
    }

    // 如果没有工具调用，结束循环
    if (toolUseBlocks.length === 0) {
      break
    }

    // 执行工具
    const toolResults = await executeTools(toolUseBlocks, tools)

    // 输出工具结果
    for (const result of toolResults) {
      yield result
    }

    // 更新消息历史，继续循环
    messages = [
      ...messages,
      ...assistantMessages.map(m => ({
        role: 'assistant' as const,
        content: m.content,
      })),
      ...toolResults.map(r => ({
        role: 'user' as const,
        content: r.content,
      })),
    ]
  }
}
```

---

## 十、核心代码片段参考

### 1. 创建流式 API 客户端

```typescript
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// 创建流式请求
const stream = await client.messages.create(
  {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,  // 关键：开启流式
  },
  { signal: abortController.signal },
)
```

### 2. 处理流式事件（实时输出到终端）

```typescript
for await (const event of stream) {
  switch (event.type) {
    case 'message_start':
      console.log('消息开始，模型:', event.message.model)
      break

    case 'content_block_start':
      console.log('内容块开始，类型:', event.content_block.type)
      break

    case 'content_block_delta':
      if (event.delta.type === 'text_delta') {
        process.stdout.write(event.delta.text)  // 实时输出文本，不换行
      }
      break

    case 'content_block_stop':
      console.log('')  // 换行
      break

    case 'message_delta':
      console.log('停止原因:', event.delta.stop_reason)
      break

    case 'message_stop':
      console.log('消息结束')
      break
  }
}
```

### 3. 实现中断控制

```typescript
const abortController = new AbortController()

// 用户按 Ctrl+C 时中断
process.on('SIGINT', () => {
  console.log('\n用户中断，正在停止...')
  abortController.abort()
})

// 超时中断（60 秒）
const timeout = setTimeout(() => {
  console.log('请求超时，正在停止...')
  abortController.abort()
}, 60000)

try {
  for await (const event of streamChat({ ..., signal: abortController.signal })) {
    // 处理事件
  }
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('请求已取消')
  } else {
    throw error
  }
} finally {
  clearTimeout(timeout)
}
```

### 4. 简化版流式工具执行器

```typescript
type ToolStatus = 'pending' | 'running' | 'done'

interface TrackedTool {
  block: ToolUseBlock
  status: ToolStatus
  result?: unknown
}

class SimpleStreamingToolExecutor {
  private queue: TrackedTool[] = []
  private onProgress?: () => void

  addTool(block: ToolUseBlock) {
    this.queue.push({ block, status: 'pending' })
    this.processQueue()
  }

  private async processQueue() {
    for (const item of this.queue) {
      if (item.status !== 'pending') continue

      // 检查是否可以并发执行
      const running = this.queue.filter(i => i.status === 'running')
      if (running.length > 0 && !this.isConcurrencySafe(item.block)) {
        continue  // 等待前面的完成
      }

      item.status = 'running'
      this.executeTool(item).then(() => {
        item.status = 'done'
        this.onProgress?.()  // 通知等待者
      })
    }
  }

  private isConcurrencySafe(block: ToolUseBlock): boolean {
    // 只读工具可以并发，写入工具必须独占
    const readOnlyTools = ['FileReadTool', 'GlobTool', 'GrepTool', 'WebFetchTool']
    return readOnlyTools.includes(block.name)
  }

  private async executeTool(item: TrackedTool): Promise<void> {
    // 执行工具
    const tool = this.tools.find(t => t.name === item.block.name)
    item.result = await tool.execute(item.block.input)
  }

  async *getResults(): AsyncGenerator<unknown> {
    for (const item of this.queue) {
      while (item.status !== 'done') {
        await new Promise<void>(resolve => {
          this.onProgress = resolve
        })
      }
      yield item.result
    }
  }
}
```

---

## 附录：关键文件索引

| 文件 | 行数 | 核心作用 |
|------|------|----------|
| `src/services/api/claude.ts` | ~3400 | API 流式调用、事件处理、重试逻辑 |
| `src/QueryEngine.ts` | ~46K | 查询引擎、会话状态、消息规范化 |
| `src/query.ts` | ~1300 | 查询循环、工具执行、错误恢复 |
| `src/services/tools/StreamingToolExecutor.ts` | ~200 | 流式工具执行器（并发控制） |
| `src/components/Markdown.tsx` | ~240 | 流式 Markdown 渲染（稳定区/不稳定区） |
| `src/types/message.ts` | ~420 | 消息类型定义 |
| `src/services/api/client.ts` | ~200 | Anthropic SDK 客户端创建 |
| `src/utils/messages.ts` | — | 消息工具函数（创建、规范化） |

---

## 附录：常见问题

### Q1: 为什么用 AsyncGenerator 而不是 EventEmitter？

**A:** AsyncGenerator 有更好的背压控制。当消费者处理速度跟不上生产者时，生产者会自动暂停。EventEmitter 则需要手动实现背压，容易导致内存溢出。

### Q2: 流式工具执行会不会有并发问题？

**A:** 会，但 Claude Code 通过 `isConcurrencySafe` 方法来控制。只读工具（如读文件、搜索）可以并发执行，写入工具（如写文件、执行命令）必须独占执行。

### Q3: 稳定区/不稳定区的边界怎么确定？

**A:** 通过 Markdown lexer 解析。最后一个非空 token 之前的都是稳定区，最后一个是不稳定区（正在增长的块）。这个边界是单调递增的，不会回退。

### Q4: 如何处理流式中断？

**A:** 使用 `AbortController`。当用户按 Ctrl+C 或超时时，调用 `abortController.abort()`，流式循环会自动退出，然后在 `finally` 块中释放资源。

### Q5: 为什么 assistant 消息用 fire-and-forget 写入磁盘？

**A:** 因为流式输出时每个 token 都要实时显示给用户。如果等待磁盘写入完成，用户会看到卡顿。其他消息（如用户消息、系统消息）不频繁，等待写入没问题。

### Q6: 流式空闲超时看门狗是什么？

**A:** 一个定时器，如果 90 秒内没收到任何数据，就认为连接断了，自动关闭。防止网络问题导致程序永远挂起。

---

> 最后更新：2026-06-27
