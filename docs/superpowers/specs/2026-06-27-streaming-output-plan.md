# 实现计划：流式输出四层架构

**源设计文档**: `docs/superpowers/specs/2026-06-27-streaming-output-design.md`
**复杂度**: Large
**预计总工时**: 15-20 小时

---

## 概述

将设计文档中的五层架构（类型系统 → API 调用 → 查询引擎 → 查询循环 → UI 渲染）拆分为 8 个可独立验证的任务，按依赖顺序执行。

---

## 现有模式参考

| 类别 | 来源 | 模式 |
|------|------|------|
| 命名 | `src/agent/types.ts` | 接口用 PascalCase，类型用 `export type`，字段用 camelCase |
| 命名 | `src/agent/recovery.ts` | 文件名用 kebab-case，注释用"物理本质"类比 |
| 错误处理 | `src/agent/recovery.ts:10` | `ErrorType` 联合类型 + `classifyError()` 分流 |
| 错误处理 | `src/agent/backoff.ts:49` | `withBackoff()` 通用重试包装器 |
| 测试 | `src/__tests__/streaming-executor.test.ts` | Vitest + `describe/it/expect` + 工厂函数创建测试夹具 |
| 数据访问 | `src/agent/compression.ts` | 阈值常量 + 纯函数 + 磁盘持久化 |

---

## 文件变更清单

| 文件 | 操作 | 原因 |
|------|------|------|
| `src/agent/types.ts` | UPDATE | 新增 6 种 StreamEvent 类型 + StreamingLLMClient 接口 |
| `src/agent/anthropic-stream-client.ts` | CREATE | API 流式调用层（Anthropic SDK 直连） |
| `src/agent/query-engine.ts` | CREATE | 查询引擎（消息规范化 + usage 追踪） |
| `src/agent/streaming-query.ts` | CREATE | 查询循环（AI → 工具 → AI 循环） |
| `src/agent/streaming-executor.ts` | UPDATE | 改造为基于结构化事件 + 并发控制 |
| `src/agent/stream-event-bus.ts` | CREATE | 事件总线（EventEmitter 封装） |
| `src/agent/compression.ts` | UPDATE | 适配流式调用（已有 L1-L4，需增加流式感知） |
| `src/agent/recovery.ts` | UPDATE | 增加流式错误类型（stream_idle_timeout 等） |
| `src/renderer/renderer.ts` | UPDATE | 集成事件监听（增量渲染） |
| `src/__tests__/streaming-types.test.ts` | CREATE | 流式事件类型单元测试 |
| `src/__tests__/anthropic-stream-client.test.ts` | CREATE | API 流式调用层单元测试 |
| `src/__tests__/query-engine.test.ts` | CREATE | 查询引擎单元测试 |
| `src/__tests__/streaming-query.test.ts` | CREATE | 查询循环集成测试 |
| `src/__tests__/streaming-executor.test.ts` | UPDATE | 适配新的结构化事件接口 |

---

## 任务分解

### Task 1: 流式事件类型定义

- **目标**: 在 `types.ts` 中定义 6 种 StreamEvent 类型和 StreamingLLMClient 接口
- **依赖**: 无
- **操作**:
  1. 在 `src/agent/types.ts` 末尾新增以下类型：
     - `MessageStartEvent`（messageId, model, inputTokens）
     - `ContentBlockStartEvent`（index, blockType, blockId?）
     - `ContentBlockDeltaEvent`（index, deltaType, content）
     - `ContentBlockStopEvent`（index）
     - `MessageDeltaEvent`（stopReason, outputTokens）
     - `MessageStopEvent`（无字段）
     - `StreamEvent`（联合类型）
     - `AssistantMessage`（type, content, usage, stopReason, uuid, timestamp）
     - `StreamOptions`（systemPrompt, maxTokens, signal, thinkingConfig?）
     - `StreamingLLMClient`（stream 方法）
  2. 编写单元测试 `src/__tests__/streaming-types.test.ts`：
     - 验证类型结构正确性
     - 验证 StreamEvent 联合类型的类型收窄
- **验证**: `npm run typecheck && npm test -- streaming-types`
- **预计工时**: 1 小时

---

### Task 2: API 流式调用层

- **目标**: 实现 `AnthropicStreamClient`，封装 Anthropic SDK 流式 API
- **依赖**: Task 1
- **操作**:
  1. 创建 `src/agent/anthropic-stream-client.ts`：
     - 实现 `StreamingLLMClient` 接口
     - `stream()` 方法返回 `AsyncGenerator<StreamEvent | AssistantMessage>`
     - 核心算法：内容块累积（按 index 索引，delta 追加）
     - 空闲超时看门狗（90 秒无数据自动 abort）
     - 流式停滞检测（30 秒无事件记录日志）
  2. 需要安装 `@anthropic-ai/sdk` 依赖：
     ```bash
     npm install @anthropic-ai/sdk
     ```
  3. 编写单元测试 `src/__tests__/anthropic-stream-client.test.ts`：
     - Mock Anthropic SDK 的 stream 方法
     - 验证事件转换正确性
     - 验证超时看门狗触发
     - 验证内容块累积逻辑
- **验证**: `npm run typecheck && npm test -- anthropic-stream-client`
- **预计工时**: 3 小时

---

### Task 3: 事件总线

- **目标**: 实现 `StreamEventBus`，用于流式事件的发布/订阅
- **依赖**: Task 1
- **操作**:
  1. 创建 `src/agent/stream-event-bus.ts`：
     - 基于 Node.js `EventEmitter` 封装
     - 类型安全的 `emit`/`on`/`off` 方法
     - 支持的事件类型：`stream_event`, `assistant_message`, `tool_call`, `tool_result`, `error`, `loop_end`
  2. 单元测试可选（EventEmitter 已被 Node.js 充分测试）
- **验证**: `npm run typecheck`
- **预计工时**: 0.5 小时

---

### Task 4: 查询引擎

- **目标**: 实现 `QueryEngine`，封装消息规范化和 usage 追踪
- **依赖**: Task 2, Task 3
- **操作**:
  1. 创建 `src/agent/query-engine.ts`：
     - `submit()` 方法返回 `AsyncGenerator<NormalizedMessage | StreamEvent>`
     - 消息规范化：StreamEvent → NormalizedMessage
     - Usage 追踪：message_start 重置，message_delta 累积，message_stop 汇总
     - Fire-and-forget 持久化（assistant 消息异步写入，不阻塞流式输出）
  2. 编写单元测试 `src/__tests__/query-engine.test.ts`：
     - Mock StreamingLLMClient
     - 验证消息规范化正确性
     - 验证 usage 追踪准确性
- **验证**: `npm run typecheck && npm test -- query-engine`
- **预计工时**: 2 小时

---

### Task 5: 流式工具执行器改造

- **目标**: 将现有 `StreamingToolExecutor` 从文本解析改为基于结构化事件
- **依赖**: Task 1
- **操作**:
  1. 更新 `src/agent/streaming-executor.ts`：
     - 移除 `processChunk()` 文本解析逻辑
     - 新增 `addTool(block: ToolUseBlock, assistantMessage: AssistantMessage)` 方法
     - 实现并发控制：
       - `canExecuteTool(isConcurrencySafe)` 检查
       - `processQueue()` 队列处理
       - `executeTool()` 执行单个工具
     - 实现 `getRemainingResults()` AsyncGenerator（按顺序输出）
     - 实现 `discard()` 方法（流式降级时丢弃待执行工具）
  2. 更新 `src/__tests__/streaming-executor.test.ts`：
     - 适配新的 `addTool()` 接口
     - 测试并发控制（只读并发、写入独占）
     - 测试结果按顺序输出
     - 测试 discard 语义
- **验证**: `npm run typecheck && npm test -- streaming-executor`
- **预计工时**: 3 小时

---

### Task 6: 查询循环

- **目标**: 实现 `streamingQuery()`，完整的 AI → 工具 → AI 循环
- **依赖**: Task 4, Task 5
- **操作**:
  1. 创建 `src/agent/streaming-query.ts`：
     - `streamingQuery()` 返回 `AsyncGenerator<StreamMessage>`
     - 四阶段循环：调用 AI → 检查继续 → 获取工具结果 → 更新状态
     - 集成 `StreamingToolExecutor`（流式执行）
     - 集成 `QueryEngine`（流式调用）
     - 错误恢复：复用现有 `recovery.ts` 的 `classifyError`/`handleError`
     - 非流式降级：流式失败时降级到非流式 API
     - max_tokens 截断续写（最多 3 次）
     - Token 预算检查（每个循环迭代开始时）
     - 上下文压缩：复用现有 `compression.ts`
  2. 编写集成测试 `src/__tests__/streaming-query.test.ts`：
     - Mock StreamingLLMClient + Mock ToolRegistry
     - 测试基本对话循环（无工具调用）
     - 测试工具调用循环（单轮）
     - 测试多轮工具调用
     - 测试 max_tokens 截断续写
     - 测试预算超限退出
- **验证**: `npm run typecheck && npm test -- streaming-query`
- **预计工时**: 4 小时

---

### Task 7: 错误恢复适配

- **目标**: 扩展现有 `recovery.ts`，增加流式错误类型
- **依赖**: Task 1
- **操作**:
  1. 更新 `src/agent/recovery.ts`：
     - 在 `ErrorType` 中新增：`stream_idle_timeout`, `stream_no_events`, `connection_error`
     - 更新 `classifyError()` 识别新的错误类型
     - 更新 `handleError()` 处理流式降级逻辑
  2. 更新 `src/__tests__/recovery.test.ts`：
     - 测试新的错误类型分类
     - 测试流式降级逻辑
- **验证**: `npm run typecheck && npm test -- recovery`
- **预计工时**: 1 小时

---

### Task 8: UI 渲染层集成

- **目标**: 在现有渲染器中集成流式事件监听
- **依赖**: Task 3, Task 6
- **操作**:
  1. 更新 `src/renderer/renderer.ts`：
     - 新增 `attachStreamEvents(bus: StreamEventBus)` 方法
     - 监听 `stream_event` → 增量更新当前行文本
     - 监听 `assistant_message` → 将完成的消息加入消息列表
     - 监听 `tool_call` → 显示工具执行状态
     - 监听 `tool_result` → 显示工具执行结果
     - 监听 `error` → 显示错误信息
     - 监听 `loop_end` → 清理 UI 状态
  2. 手动测试：运行完整对话，验证终端流式显示
- **验证**: `npm run typecheck && npm test && 手动测试`
- **预计工时**: 2 小时

---

## 依赖关系图

```
Task 1 (类型定义)
  ├─→ Task 2 (API 调用层) ──→ Task 4 (查询引擎) ──→ Task 6 (查询循环) ──→ Task 8 (渲染集成)
  ├─→ Task 3 (事件总线)   ──────────────────────────→ Task 6                ──→ Task 8
  ├─→ Task 5 (工具执行器) ──────────────────────────→ Task 6
  └─→ Task 7 (错误恢复)

执行顺序：
  Task 1 → (Task 2, Task 3, Task 5, Task 7 并行) → Task 4 → Task 6 → Task 8
```

---

## 风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| Anthropic SDK 类型不兼容 | 中 | 高 | 先写类型适配层，隔离 SDK 依赖 |
| 流式事件顺序不确定 | 低 | 中 | 严格按 index 索引，不假设顺序 |
| 并发工具有副作用 | 中 | 高 | 默认所有工具串行，白名单标记并发安全 |
| 渲染器集成复杂 | 中 | 中 | 先用简单 stdout 输出验证，再集成渲染器 |
| 测试 mock 复杂 | 中 | 低 | 使用 AsyncGenerator mock 工厂函数 |

---

## 验收标准

- [ ] 所有 8 个任务完成
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全部通过
- [ ] `npm run lint` 通过
- [ ] 手动测试：完整对话流式输出正常
- [ ] 手动测试：工具调用流式执行正常
- [ ] 手动测试：错误恢复（模拟网络中断）正常

---

## 等待确认

**是否按此计划开始实现？**

可选调整：
- "跳过 Task 8（渲染集成），先实现核心链路"
- "跳过 Task 7（错误恢复），先实现基本功能"
- "调整执行顺序：先做 Task 5 再做 Task 2"
