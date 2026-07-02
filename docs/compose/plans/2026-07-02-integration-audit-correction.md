# 集成审计核实与修正（2026-07-02）

> 本文档修正 `2026-06-27-feature-integration-audit.md` 的多处误报，记录本次实际完成的集成工作。

## 一、审计报告核实结论

审计报告声称"16 项未集成 / 集成率 50%"。经逐文件 + git 历史核实，**实际只有 5 项真未集成**，其余 11 项已在生产路径生效或已被取代。审计报告的主要问题是**只看了 `index.ts`，没追踪真正的生产 agent 循环 `streaming-query.ts`**，且引用了已重命名/删除的旧文件名。

### 核对表

| 审计项 | 审计结论 | 核实结果 | 证据 |
|--------|----------|----------|------|
| `renderer/stream-renderer.ts` (StreamEventRenderer) | P0 未集成 | **无效** | 文件不存在，已被 `ui/` 目录（UILayout + BlockPipeline）取代 |
| `background/` (BackgroundManager) | P0 未传参 | **正确** | `index.ts:77-78` 第 4 参传 undefined → **本次已修复** |
| `agent/recovery.ts` | P1 全未用 | **错误** | `streaming-query.ts:25-30` 已 import 并使用 classifyError/handleError |
| `agent/backoff.ts` | P1 全未用 | **基本正确** | 仅 `loop.ts`（孤儿循环）用，流式路径无退避 → **本次已修复** |
| `agent/compression.ts` | P1 未用 | **错误** | `streaming-query.ts:24` 已 import，compactClient 传入时实际压缩 |
| `renderer/code-highlighter.ts` | P2 需集成 | **文件名错** | 实际为 `renderer/highlight.ts`，被 `markdown.ts:12` 调用，已接入 |
| `renderer/tool-status-panel.ts` | P2 需集成 | **无效** | 文件不存在，已由 `ui/BlockPipeline` 替代 |
| `mcp/` | P3 未用 | **正确** | 零导入（且当前为教学版内存模拟，非真实 JSON-RPC）→ **本次未接入** |
| `memory/` (MemoryManager) | P3 未用 | **正确** | memory-tool 未注册 → **本次已修复** |
| `agent/subagent.ts` | P3 未用 | **错误** | 经 `task-tool.ts` 已接入主 registry |
| `agent/self-organizing.ts` | P3 未用 | **正确** | 零引用 → **本次已接入** |
| `agent/loop.ts` (agentLoop) | 已被替代 | **正确** | 未接入主入口，是参考实现，保留不动 |
| `agent/query-engine.ts` | 从未导入 | **错误** | `streaming-query.ts:20` 已 import |
| `agent/streaming-executor.ts` | 从未导入 | **错误** | `streaming-query.ts:21` 已 import |
| `agent/llm-vercel.ts` | 已注释 | **错误** | 未注释，是 subagent/self-organizing 的运行时依赖 |
| `agent/llm-client.ts` (Mock) | 测试用 | **正确** | 仅测试用 |

## 二、output/ 目录为何不接入（决策记录）

`output/` 目录的 `OutputGate` / `MessageQueue` / `LayoutScheduler` / `StylePool` 是一套**已被取代的旧渲染架构**，接入会复活已知布局 bug。

### 证据链

1. **git 历史**：
   - commit `fb65cab`（2026-06-30）"fix: prevent layout corruption by routing OutputGate through Renderer" —— OutputGate 接线后破坏布局，两个输出通道（OutputGate 直写 + Renderer 帧缓冲）冲突，导致输入框位置错乱，被迫降级。
   - commit `c7454f9`（同日）移除 OutputGate 的 re-export，引入 `UILayout + BlockPipeline` 取代它。

2. **设计文档对照**：同日存在两份计划：
   - `docs/superpowers/plans/2026-06-30-output-gate.md`（旧，被取代）
   - `docs/superpowers/plans/2026-06-30-ui-layout.md`（新，最终胜出）

3. **技术原因**：
   - `MessageQueue` 做**优先级重排**（`message-queue.ts:44-55`），而流式渲染的 `thinking/assistant/tool_call/tool_result` 必须**严格保序**（`block-pipeline.ts:12` 明确禁止重排）。接入会让流式输出错乱。
   - `StylePool` 与 `renderer/cell.ts` 的 `styleKey/packStyle` **功能完全重复**。
   - `LayoutScheduler` 与 `renderer/` 内部布局逻辑**功能完全重复**。
   - `OutputGate.processMessage`（`output-gate.ts:104`）直接 `writer(output + '\n')`，绕过 Renderer 帧缓冲坐标系，是布局错乱的根因。

### 处理决定

- **保留** `Encoder`（已被 `agent/tool-registry.ts:3` 复用，用于解码工具输出）。
- **不动** `OutputGate` / `MessageQueue` / `LayoutScheduler` / `StylePool` 及其测试（留作历史参考，不接入生产路径，也不删除）。

## 三、self-organizing 与 team/ 的关系

**澄清**：`self-organizing.ts` 不是多 agent 协作的"核心"，`team/` 才是已被 index.ts 接入的成熟实现。两者是**功能重叠的并列实现**：

| 维度 | self-organizing.ts | team/ |
|------|-------------------|-------|
| 消息层 | InboxManager（内存 Map） | MessageBus（文件持久化） |
| 名册 | 无 | TeammateManager（config.json 持久化） |
| 生命周期 | 单文件 WORK/IDLE 循环 | autonomous-agent + idle-loop 分离 |
| 已接入 | 本次新增 spawn_self_organizing 工具 | 已有 spawn_teammate 等 6 个工具 |

两者并存提供不同轻量级选择：self-organizing 适合简单单进程场景，team/ 适合需要持久化和多角色协作的场景。

## 四、本次实际集成的清单

| # | 任务 | 改动文件 | 验证 |
|---|------|---------|------|
| 1 | BackgroundManager 接入 | `src/index.ts`（实例化 + 传参 + 退出清理） | typecheck ✓ |
| 2 | ScheduleManager 接入 | `src/index.ts`（传参） | typecheck ✓ |
| 3 | backoff 退避接入流式重试 | `src/agent/streaming-query.ts` + 测试 | TDD RED→GREEN ✓ |
| 4 | MemoryManager + 3 个 memory 工具 | `src/index.ts`（实例化 + 散装注册） | typecheck ✓ |
| 5 | self-organizing 新工具接入 | 新建 `spawn-self-organizing-tool.ts` + `src/index.ts` + 测试 | TDD RED→GREEN ✓ |
| 6 | history.test.ts 测试隔离加固 | `src/__tests__/history.test.ts` | 28/28 GREEN ✓ |
| 7 | output/ 选择性收割 | 仅本文档记录，不动代码 | — |

### 新增工具清单（接入后 LLM 可调用）

- `background`（run/status/list/follow 后台命令）
- `schedule_create` / `schedule_list` / `schedule_remove` / `schedule_update`（定时调度）
- `memory_write` / `memory_read` / `memory_list`（跨会话记忆）
- `spawn_self_organizing`（派生 WORK/IDLE 自组织子代理）

## 五、核实方法说明

本次核实采用"双源验证"：每个模块都同时检查 (a) `grep` 全仓库 import 命中，(b) git 历史，(c) 设计文档对照。避免单一信息源（如审计报告只看 index.ts）导致的误判。
