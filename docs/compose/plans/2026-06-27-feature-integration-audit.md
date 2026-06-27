# 功能集成审计报告

> **审计日期**：2026-06-27
> **审计范围**：`src/` 目录下所有模块，检查 `index.ts` 主入口的实际使用情况

---

## 审计结果摘要

| 类别 | 数量 |
|------|------|
| 已集成功能 | 16 |
| 未集成功能 | 16 |
| 集成率 | 50% |

---

## ✅ 已集成功能（16 个）

| 模块 | 功能 | 集成状态 |
|------|------|----------|
| `config/` | ConfigStore 配置管理 | ✅ 实例化并使用 |
| `agent/todo.ts` | TodoManager 待办管理 | ✅ 实例化并使用 |
| `skills/` | SkillRegistry 技能注册 | ✅ 实例化并使用 |
| `skills/` | SkillNegotiator 技能协商 | ✅ 实例化并使用 |
| `permission/` | PermissionChecker 权限检查 | ✅ 实例化并使用 |
| `hooks/` | HookRunner 钩子系统 | ✅ 实例化并使用 |
| `agent/team/` | TeammateManager 团队管理 | ✅ 实例化并使用 |
| `agent/team/` | NegotiationManager 协商管理 | ✅ 实例化并使用 |
| `agent/scheduler/` | ScheduleManager 调度管理 | ✅ 实例化并使用 |
| `worktree/` | WorktreeManager 工作树管理 | ✅ 实例化并使用 |
| `task-board/` | TaskBoard 任务看板 | ✅ 实例化并使用 |
| `agent/anthropic-stream-client.ts` | AnthropicStreamClient 流式客户端 | ✅ 实例化并使用 |
| `agent/streaming-query.ts` | streamingQuery 流式查询 | ✅ 调用并迭代 |
| `agent/stream-event-bus.ts` | StreamEventBus 事件总线 | ✅ 实例化并传递 |
| `renderer/markdown-renderer.ts` | MarkdownStreamRenderer | ✅ 刚集成 |
| `renderer/renderer.ts` | renderTree 渲染树 | ✅ 调用渲染 |
| `commands/` | parseCommand/executeCommand | ✅ 调用执行 |
| `agent/tool-registry.ts` | ToolRegistry 工具注册 | ✅ 注册 20+ 工具 |

---

## ❌ 未集成功能（16 个）

| 模块 | 功能 | 状态 | 说明 |
|------|------|------|------|
| `renderer/stream-renderer.ts` | **StreamEventRenderer** | ❌ 从未使用 | 导入后从未实例化，设计用于监听 EventBus 渲染流式内容 |
| `renderer/code-highlighter.ts` | **CodeHighlighter** | ❌ 从未导入 | 代码语法高亮器，未被任何模块引用 |
| `renderer/tool-status-panel.ts` | **ToolStatusPanel** | ❌ 从未导入 | 工具执行状态面板，未被任何模块引用 |
| `background/` | **BackgroundManager** | ❌ 从未导入 | 后台任务管理器，createDefaultRegistry 接受参数但未传入 |
| `mcp/` | **MCP 客户端/路由** | ❌ 从未导入 | MCP 协议集成（client, router, plugin-loader）完全未使用 |
| `memory/` | **MemoryManager** | ❌ 从未导入 | 记忆系统，完全未使用 |
| `agent/loop.ts` | **agentLoop** | ❌ 从未导入 | 非流式 Agent 循环，已被 streamingQuery 替代 |
| `agent/recovery.ts` | **错误恢复模块** | ❌ 从未导入 | classifyError, handleError, FailureInbox 等全部未使用 |
| `agent/backoff.ts` | **退避策略模块** | ❌ 从未导入 | exponentialBackoff, jitteredBackoff 等全部未使用 |
| `agent/compression.ts` | **上下文压缩模块** | ❌ 从未导入 | snipCompact, microCompact, compactHistory 全部未使用 |
| `agent/subagent.ts` | **子代理模块** | ❌ 从未导入 | 子代理生成功能完全未使用 |
| `agent/self-organizing.ts` | **自组织模块** | ❌ 从未导入 | 自组织 Agent 逻辑完全未使用 |
| `agent/llm-vercel.ts` | **Vercel AI SDK 客户端** | ❌ 已注释 | 旧路径，已被 AnthropicStreamClient 替代 |
| `agent/query-engine.ts` | **QueryEngine** | ❌ 从未导入 | 查询引擎，未被 streaming-query 使用 |
| `agent/streaming-executor.ts` | **StreamingToolExecutor** | ❌ 从未导入 | 流式工具执行器，streaming-query 中未使用 |
| `agent/llm-client.ts` | **MockLLMClient** | ❌ 从未导入 | 测试用 mock 客户端，生产代码未使用 |

---

## 🔴 关键缺失分析

### 1. 流式渲染管线断裂

```
streamingQuery → StreamEventBus → ??? → 终端显示
                          ↑
                   StreamEventRenderer 从未 attach
                   CodeHighlighter 从未使用
                   ToolStatusPanel 从未使用
```

**现状**：流式消息通过 `renderMarkdown()` 直接转为 ANSI 文本存入 `messages[]`，绕过了整个流式渲染管线。

**影响**：
- 工具调用状态面板不显示
- 代码块无语法高亮
- Thinking 块不显示

### 2. 错误恢复与重试机制缺失

`recovery.ts` 和 `backoff.ts` 已实现但未使用，API 调用失败时直接报错，无自动重试。

### 3. 上下文压缩未启用

`compression.ts` 实现了 L1-L4 压缩策略，但 `streaming-query.ts` 中仅集成了基础压缩，未使用完整的压缩模块。

### 4. 后台任务管理器未传入

`BackgroundManager` 已实现，`createDefaultRegistry` 接受参数，但 `index.ts` 调用时未传入 `backgroundManager`，导致 `background-tool` 未注册。

---

## 📋 修复优先级

| 优先级 | 功能 | 工作量 | 说明 |
|--------|------|--------|------|
| P0 | 集成 StreamEventRenderer 到流式管线 | 中 | 核心渲染功能缺失 |
| P0 | 注册 BackgroundManager + background-tool | 低 | 参数未传入 |
| P1 | 集成错误恢复 + 重试机制 | 中 | API 调用无容错 |
| P1 | 集成上下文压缩 | 低 | 长对话会溢出 |
| P2 | 集成 CodeHighlighter 到代码块渲染 | 低 | 代码块无高亮 |
| P2 | 集成 ToolStatusPanel 到工具调用显示 | 低 | 工具状态不显示 |
| P3 | MCP 协议集成 | 高 | 外部工具扩展 |
| P3 | MemoryManager 记忆系统 | 高 | 跨会话记忆 |
| P3 | 子代理 / 自组织模块 | 高 | 多 Agent 协作 |

---

## 建议

1. **P0 问题立即修复**：StreamEventRenderer 和 BackgroundManager 应立即集成
2. **P1 问题本周修复**：错误恢复和上下文压缩影响稳定性
3. **P2 问题按需修复**：代码高亮和工具状态面板提升体验
4. **P3 问题评估后决定**：MCP、Memory、子代理是否为当前阶段必需

---

> 最后更新：2026-06-27T15:30:00Z
