# 设计文档：流式输出四层架构

**日期**: 2026-06-27
**状态**: 待实现
**复杂度**: Large

---

## 概述

为 mi-code 项目实现完整的流式输出架构，参考 Claude Code 的设计方案，采用 Anthropic SDK 直连方式，复用现有自研渲染器，实现四层架构：API 流式调用 → 查询引擎 → 查询循环 → UI 渲染。

### 关键决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| API 方案 | Anthropic SDK 直连 | 完全控制流式行为，获取结构化事件 |
| 渲染方案 | 复用自研渲染器 | 与现有架构一致，减少改造量 |
| 设计范围 | 完整四层架构 | 一次性设计完整，分阶段实现 |
| 并发模型 | 只读并发 + 写入独占 | 平衡性能与安全 |

---

## 第一层：流式事件类型系统

### 设计思想

定义一套**结构化的流式事件类型**，作为整个四层架构的"通用语言"。每一层都通过这些事件通信。

### 事件类型定义

```
StreamEvent = 以下六种之一：

1. MessageStartEvent
   触发时机：API 返回 message_start
   字段：messageId (string), model (string), inputTokens (number)
   物理类比：快递到了，开始拆

2. ContentBlockStartEvent
   触发时机：API 返回 content_block_start
   字段：index (number), blockType ('text' | 'tool_use' | 'thinking'), blockId (string?, 仅 tool_use)
   物理类比：打开一个新盒子

3. ContentBlockDeltaEvent
   触发时机：API 返回 content_block_delta（每个 token 一次）
   字段：index (number), deltaType ('text' | 'input_json' | 'thinking'), content (string)
   物理类比：从盒子里一点点拿出东西

4. ContentBlockStopEvent
   触发时机：API 返回 content_block_stop
   字段：index (number)
   物理类比：这个盒子拆完了

5. MessageDeltaEvent
   触发时机：API 返回 message_delta
   字段：stopReason (string | null), outputTokens (number)
   物理类比：更新账单

6. MessageStopEvent
   触发时机：API 返回 message_stop
   字段：无
   物理类比：所有盒子都拆完了
```

### 与现有类型的关系

```
现有类型（types.ts）         新增流式事件类型
─────────────────           ──────────────────
Message                     StreamEvent
ContentBlock                   ├─ MessageStartEvent
  ├─ TextBlock                 ├─ ContentBlockStartEvent
  ├─ ToolUseBlock              ├─ ContentBlockDeltaEvent
  └─ ToolResultBlock           ├─ ContentBlockStopEvent
                               ├─ MessageDeltaEvent
                               └─ MessageStopEvent

StreamEvent 是 API 的"原始脉搏"
Message/ContentBlock 是"组装完成的积木"
流式过程中：StreamEvent → 累积 → ContentBlock → 组装 → Message
```

### 接口定义

```typescript
interface StreamingLLMClient {
  stream(
    messages: Message[],
    tools: ToolDefinition[],
    options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage>
}

interface StreamOptions {
  systemPrompt: string
  maxTokens: number
  signal: AbortSignal
  thinkingConfig?: ThinkingConfig
}
```

---

## 第二层：API 流式调用层

### 模块职责

```
输入：Message[] + ToolDefinition[] + StreamOptions
输出：AsyncGenerator<StreamEvent | AssistantMessage>

职责：
1. 创建 Anthropic SDK 客户端
2. 调用 client.messages.create({ stream: true })
3. 遍历 for await (const event of stream)
4. 将每个 event 转换为结构化 StreamEvent
5. 在 content_block_stop 时累积并输出 AssistantMessage
6. 处理空闲超时看门狗（90秒无数据自动断开）
7. 处理流式停滞检测（30秒无事件记录日志）
```

### 核心算法：内容块累积

```
状态变量：
  contentBlocks: ContentBlock[] = []  // 按 index 索引
  usage: Usage = { input: 0, output: 0 }

处理流程：

for each event in stream:
  match event.type:
    "message_start":
      usage = event.message.usage
      yield MessageStartEvent

    "content_block_start":
      contentBlocks[event.index] = {
        type: event.content_block.type,
        text: "",        // 如果是 text 类型
        input: "",       // 如果是 tool_use 类型
        thinking: "",    // 如果是 thinking 类型
      }
      yield ContentBlockStartEvent

    "content_block_delta":
      block = contentBlocks[event.index]
      match event.delta.type:
        "text_delta":       block.text += event.delta.text
        "input_json_delta": block.input += event.delta.partial_json
        "thinking_delta":   block.thinking += event.delta.thinking
      yield ContentBlockDeltaEvent

    "content_block_stop":
      block = contentBlocks[event.index]
      assistantMessage = createAssistantMessage([block], usage)
      yield assistantMessage
      yield ContentBlockStopEvent

    "message_delta":
      usage.update(event.usage)
      yield MessageDeltaEvent

    "message_stop":
      yield MessageStopEvent
```

### 空闲超时看门狗

```
算法：
  timeoutMs = 90_000（90秒）
  timer = null

  resetTimer():
    clearTimeout(timer)
    timer = setTimeout(() => {
      abort()  // 中断流
      releaseResources()
    }, timeoutMs)

  // 每收到一个事件就重置
  for each event:
    resetTimer()
    // ... 处理事件

  // 流结束后清除
  clearTimeout(timer)
```

### 错误处理

```
1. API 连接错误 → 抛出，由上层处理重试
2. 流式空闲超时 → 自动 abort，抛出超时错误
3. 流式停滞（30秒无事件）→ 记录日志，不中断
4. 流结束但无消息 → 抛出异常，触发非流式降级
```

### 新增文件

```
src/agent/anthropic-stream-client.ts
  └─ AnthropicStreamClient 实现 StreamingLLMClient 接口
```

---

## 第三层：查询引擎

### 模块职责

```
输入：用户消息 + 系统提示 + 工具定义
输出：AsyncGenerator<NormalizedMessage | StreamEvent>

职责：
1. 接收用户输入，构建完整的消息历史
2. 调用第一层的 stream() 获取流式事件
3. 将 StreamEvent 转换为 NormalizedMessage
4. 追踪 token 使用量（input/output/cache）
5. 将消息记录到会话存储（fire-and-forget，不阻塞流式输出）
6. 输出规范化消息给上层
```

### 消息规范化规则

```
输入：StreamEvent | AssistantMessage
输出：NormalizedMessage

规范化规则：
1. AssistantMessage（来自 content_block_stop）
   → NormalizedAssistantMessage
   - 保留 content、usage、stopReason
   - 添加 uuid、timestamp

2. StreamEvent（来自各事件）
   → 直接透传（供 UI 实时渲染 token）
   → 同时更新内部 usage 计数器

3. 特殊处理：
   - message_start → 重置当前消息 usage
   - message_delta → 累积 usage，捕获 stopReason
   - message_stop → 累积到总 usage
```

### 会话持久化策略

```
关键设计：assistant 消息使用 fire-and-forget

原因：流式输出时每个 token 都要实时显示给用户。
     如果等待磁盘写入完成，用户会看到卡顿。

实现：
  if message.type == 'assistant':
    void recordTranscript(messages)  // 异步，不等待
  else:
    await recordTranscript(messages)  // 同步，确保写入
```

### 接口定义

```typescript
interface QueryEngine {
  submit(
    userMessage: string,
    options: QueryOptions,
  ): AsyncGenerator<NormalizedMessage | StreamEvent>
}

interface QueryOptions {
  systemPrompt: string
  tools: ToolDefinition[]
  signal: AbortSignal
  maxTokens?: number
}

interface NormalizedMessage {
  type: 'assistant' | 'user' | 'system' | 'progress'
  content: ContentBlock[]
  usage?: Usage
  stopReason?: string
  uuid: string
  timestamp: string
}
```

### 新增文件

```
src/agent/query-engine.ts
  └─ QueryEngine 实现
```

---

## 第三层补充：非流式降级与重试

### 设计思想

流式 API 调用可能失败（网络中断、服务器错误、流式挂起等）。需要一套**自动降级 + 重试**机制保证鲁棒性。

### 错误分类

```
错误类型            触发条件                    恢复策略
─────────────────────────────────────────────────────────
connection_error   API 连接失败                重试（最多 3 次）
rate_limited_429   429 状态码                  退避重试（指数退避）
stream_idle_timeout 90 秒无数据               降级到非流式
stream_stall       30 秒无事件（记录日志）      不中断，继续等待
stream_no_events   流结束但无消息              降级到非流式
max_tokens         输出超限                    截断 + 续写
prompt_too_long    输入超限                    上下文压缩后重试
```

### 重试算法

```
重试状态：
  retryAttempt = 0
  maxRetries = 3
  baseDelay = 1000ms

重试流程：

function shouldRetry(error):
  if retryAttempt >= maxRetries:
    return false  // 超过重试次数

  match error.type:
    'connection_error':   return true
    'rate_limited_429':   return true
    'stream_idle_timeout': return true  // 降级到非流式
    'stream_no_events':   return true  // 降级到非流式
    'max_tokens':         return true  // 截断续写
    'prompt_too_long':    return true  // 压缩后重试
    default:              return false

function getRetryDelay(error):
  if error.type == 'rate_limited_429':
    // 指数退避 + 抖动
    delay = baseDelay * 2^retryAttempt
    jitter = random(0, delay * 0.1)
    return delay + jitter
  return 0  // 其他错误立即重试
```

### 非流式降级

```
降级触发条件：
  1. 流式空闲超时（90秒无数据）
  2. 流结束但无消息
  3. 连续 3 次流式失败

降级流程：
  1. 放弃当前流式连接
  2. 使用相同的参数调用非流式 API
  3. 等待完整响应返回
  4. 将非流式响应转换为 AssistantMessage
  5. 继续正常的查询循环

非流式 API 调用：
  response = await client.messages.create({
    ...params,
    stream: false,  // 关闭流式
  })
  // 将完整响应转换为 AssistantMessage
  yield convertToAssistantMessage(response)
```

### max_tokens 截断续写

```
触发条件：response.stop_reason == 'max_tokens'

续写算法：
  1. 将已有的 assistant 消息加入历史
  2. 追加续写提示："Continue from where you left off."
  3. 重新调用 API（不增加 max_tokens）
  4. 将续写内容追加到原 assistant 消息

续写次数限制：最多 3 次（防止无限循环）

state.maxOutputTokensRecoveryCount++
if state.maxOutputTokensRecoveryCount > 3:
  throw Error('max_tokens recovery failed')
```

---

## 第三层补充：Token 预算与上下文压缩

### 设计思想

长对话会导致上下文窗口溢出。需要两层防护：
1. **Token 预算**：限制单次对话的总 token 消耗
2. **上下文压缩**：当消息历史过长时自动压缩

### Token 预算控制

```
预算类型：
  totalBudget: number     // 总预算（美元或 token 数）
  spentSoFar: number      // 已消耗
  remaining: number       // 剩余 = total - spent

预算检查点（每个循环迭代开始时）：
  if spentSoFar >= totalBudget:
    yield ErrorAttachment('Budget limit reached')
    return  // 终止循环

Token 计费：
  每次 API 调用后，从 response.usage 中提取：
    input_tokens   → 按模型单价计费
    output_tokens  → 按模型单价计费
    cache_read     → 按折扣价计费
  累加到 spentSoFar
```

### 上下文压缩（Autocompact）

```
触发条件：
  tokenCount(messages) > compactThreshold
  compactThreshold 默认为模型上下文窗口的 80%

压缩算法（三级）：

L1 - 摘要压缩（最温和）：
  将旧的工具调用和结果替换为摘要
  保留：最近 N 条消息、系统提示、用户消息
  替换：旧的 tool_use + tool_result → 一条摘要消息

L2 - 历史裁剪（中等）：
  删除最早的对话轮次
  保留：系统提示 + 最近 N 轮对话

L3 - 全量压缩（最激进）：
  将整个对话历史压缩为一条摘要
  保留：系统提示 + 压缩摘要
  仅在 L1/L2 无法解决问题时使用

压缩流程：
  { messages, needsL4 } = runCompaction(state.messages)
  if needsL4:
    state.messages = compactHistory(messages)  // L3
  else:
    state.messages = messages  // L1 或 L2

压缩后重试：
  压缩完成后，不增加 turnCount，直接进入下一轮循环
  这样用户不会感知到压缩发生
```

### Reactive Compact（响应式压缩）

```
触发条件：
  模型返回错误/拒绝，且未尝试过压缩
  错误特征：response.text 包含 'error' | 'too long' | 'context length'

流程：
  if isRejected && !state.hasAttemptedReactiveCompact:
    state.hasAttemptedReactiveCompact = true
    state.messages = compactHistory(state.messages)  // L3 全量压缩
    continue  // 压缩后重试（不增加 turnCount）

防止无限循环：
  hasAttemptedReactiveCompact 标记确保只尝试一次
  如果压缩后仍然失败，正常报错退出
```

---

## 第四层：查询循环与流式工具执行

### 查询循环算法

```
输入：用户消息、系统提示、工具定义
输出：AsyncGenerator<StreamMessage>

算法：

state = { messages: [userMessage], turnCount: 0 }

while turnCount < maxTurns:
  // ═══════ 阶段 1：调用 AI（流式）═══════
  assistantMessages = []
  toolUseBlocks = []
  needsFollowUp = false

  创建 StreamingToolExecutor（如果启用流式执行）

  for each message in queryEngine.submit(...):
    yield message  // 实时输出给 UI

    if message.type == 'assistant':
      assistantMessages.push(message)
      for each block in message.content:
        if block.type == 'tool_use':
          toolUseBlocks.push(block)
          needsFollowUp = true
          streamingToolExecutor.addTool(block, message)  // 流式执行

  // ═══════ 阶段 2：检查是否继续 ═══════
  if !needsFollowUp:
    return  // 没有工具调用，结束循环

  // ═══════ 阶段 3：获取工具执行结果 ═══════
  if streamingToolExecutor:
    // 流式执行器已经在后台执行了，这里等待结果
    for each results in streamingToolExecutor.getRemainingResults():
      for each result in results:
        toolResults.push(result)
        yield result  // 输出工具结果
  else:
    // 传统方式：等所有工具执行完
    results = await runTools(toolUseBlocks)
    for each result in results:
      yield result

  // ═══════ 阶段 4：更新状态，继续循环 ═══════
  state.messages = [...messages, ...assistantMessages, ...toolResults]
  turnCount++
```

### 流式工具执行器（StreamingToolExecutor）

#### 并发模型

```
工具分类：
  只读工具（FileReadTool, GlobTool, GrepTool, WebFetchTool）
    → 可并发执行
    → 多个只读工具可以同时运行

  写入工具（FileWriteTool, FileEditTool, BashTool, etc.）
    → 必须独占执行
    → 前一个写入工具完成后才能执行下一个

执行队列元素（TrackedTool）：
  id: string              // 工具调用 ID
  block: ToolUseBlock     // 工具调用块
  status: 'queued' | 'executing' | 'completed' | 'yielded'
  isConcurrencySafe: boolean  // 是否可并发
  results?: Message[]     // 执行结果
```

#### 并发控制算法

```
addTool(block, assistantMessage):
  tool = 查找工具定义(block.name)
  isConcurrencySafe = tool.isConcurrencySafe(block.input)
  队列.push({ block, status: 'queued', isConcurrencySafe })
  processQueue()

canExecuteTool(isConcurrencySafe):
  executing = 队列.filter(t => t.status == 'executing')
  return executing.length == 0 ||
    (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))

processQueue():
  for each tool in 队列:
    if tool.status != 'queued': continue
    if canExecuteTool(tool.isConcurrencySafe):
      executeTool(tool)
    else:
      if !tool.isConcurrencySafe: break  // 非并发工具必须等待

executeTool(tool):
  tool.status = 'executing'
  try:
    results = await runToolUse(tool.block)
    tool.results = results
    tool.status = 'completed'
  catch error:
    tool.results = [errorMessage(error)]
    tool.status = 'completed'
  notifyWaiters()  // 通知 getRemainingResults
```

#### 结果按顺序输出

```
getRemainingResults()（AsyncGenerator）:
  for each tool in 队列:
    // 等待工具完成
    while tool.status != 'completed' && tool.status != 'yielded':
      await notify()  // 等待 executeTool 的 notifyWaiters

    if tool.status == 'completed':
      tool.status = 'yielded'
      yield tool.results
```

**关键：即使 grep 先完成，也要等 read_file 输出后再输出 grep 的结果。保证顺序。**

### 新增文件

```
src/agent/streaming-query.ts
  └─ streamingQuery() 函数
  └─ 改造 StreamingToolExecutor（基于结构化事件）
```

---

## 第五层：UI 渲染层集成

### 事件驱动模型

```
流式查询层（生产者）
  │
  │ emit('stream_event', event)
  │ emit('assistant_message', message)
  │ emit('tool_result', result)
  ▼
EventBus（事件总线）
  │
  ├─→ 渲染器（消费者）
  │     监听事件，增量更新终端显示
  │
  ├─→ 会话存储（消费者）
  │     监听事件，持久化到磁盘
  │
  └─→ 统计模块（消费者）
        监听事件，追踪 token 使用量
```

### 事件总线接口

```typescript
interface StreamEventBus {
  emit(eventType: string, data: unknown): void
  on(eventType: string, handler: (data: unknown) => void): void
  off(eventType: string, handler: (data: unknown) => void): void
}

事件类型：
  'stream_event'       → 原始流式事件（用于实时 token 渲染）
  'assistant_message'  → 助手消息完成（用于消息渲染）
  'tool_call'          → 工具调用开始（用于工具状态显示）
  'tool_result'        → 工具执行结果（用于工具结果显示）
  'error'              → 错误事件（用于错误显示）
  'loop_end'           → 循环结束（用于清理 UI 状态）
```

### 渲染器集成

```
现有 renderer/ 结构：
  renderer.ts    → 主渲染器
  screen-buffer.ts → 屏幕缓冲区
  writer.ts      → 输出写入器
  cell.ts        → 字符单元
  colors.ts      → 颜色定义
  optimizer.ts   → 渲染优化
  pool.ts        → 对象池

集成方式：
  1. 在 renderer.ts 中注册事件监听
  2. 收到 stream_event → 更新当前行的文本内容（增量渲染）
  3. 收到 assistant_message → 将完成的消息加入消息列表
  4. 收到 tool_call → 显示工具执行状态
  5. 收到 tool_result → 显示工具执行结果
```

### 增量渲染策略

```
对于 ContentBlockDeltaEvent（每个 token）：
  1. 将 token 文本追加到当前行
  2. 调用 renderer.updateLine(lineId, newText)
  3. renderer 只重写变化的部分（差量渲染）

对于 ContentBlockStopEvent（内容块完成）：
  1. 将完成的内容块加入消息列表
  2. 渲染完整的消息组件（Markdown 渲染等）

对于 ToolCall/ToolResult：
  1. 显示工具名称和状态（执行中/完成/失败）
  2. 显示工具输出（可折叠）
```

### 新增文件

```
src/agent/stream-event-bus.ts
  └─ StreamEventBus 实现（简单的 EventEmitter 封装）
```

---

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/types.ts` | UPDATE | 新增流式事件类型定义 |
| `src/agent/anthropic-stream-client.ts` | CREATE | API 流式调用层 |
| `src/agent/query-engine.ts` | CREATE | 查询引擎 |
| `src/agent/streaming-query.ts` | CREATE | 查询循环 |
| `src/agent/streaming-executor.ts` | UPDATE | 改造为基于结构化事件 |
| `src/agent/stream-event-bus.ts` | CREATE | 事件总线 |
| `src/agent/compression.ts` | UPDATE | 上下文压缩（已有，需适配流式） |
| `src/agent/recovery.ts` | UPDATE | 错误恢复（已有，需适配流式） |
| `src/renderer/renderer.ts` | UPDATE | 集成事件监听 |

## 实现优先级

| 阶段 | 模块 | 验证方式 |
|------|------|----------|
| P0 | 流式事件类型定义 | 类型检查通过 |
| P1 | API 流式调用层 | 单元测试：mock stream → 结构化事件 |
| P2 | 查询引擎 | 单元测试：消息规范化、usage 追踪 |
| P3 | 查询循环 + 流式工具执行 | 集成测试：完整对话循环 |
| P4 | UI 渲染层集成 | 手动测试：终端流式显示 |

---

## 验证命令

```bash
npm run typecheck    # 类型检查
npm test             # 单元测试
npm run lint         # 代码检查
```
