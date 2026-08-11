# 父轮次取消时 Pending Tool 的 TUI 终结语义

日期：2026-08-11
状态：设计已确认

## 根因

父轮次 ESC 已正确中止父、子 provider；最终 `Partially completed` feedback 也已生成并持久化。问题在于，已发出的 `spawn_agent` 没有产生被父轮次消费的 `tool_result`，从而留下 unresolved `PendingTool`。

`selectCommittedTranscript` 按既有规则在第一个 ActivityItem 截断。后续已固化的 final feedback 因而不进入 committed transcript，也不会出现在 TUI。此问题是 UI 生命周期缺口，不是 provider、子代理或工具执行未停止。

## 产品契约

- 父轮次由用户取消后，属于该轮次且仍 pending 的工具必须获得明确的 UI 终态。
- 该终态为 `cancelled`，不得伪装为 `error`；取消不是工具执行失败。
- 父轮次不等待子代理返回，也不伪造真实 `tool_result`。
- 不承诺显示 `Subagent incomplete: user_abort`；它不是父轮次取消时的既有可见契约。
- 父轮次最终状态继续使用现有的 `Partially completed` 语义。

## 生命周期

父轮次确认 `aborted` 后，在提交 final feedback 之前执行以下顺序：

1. 以该轮次的 `activeToolIds` 作为候选集合。
2. 只选择仍存在于 `BlockPipeline.toolBuffer`、尚未配对结果的调用。
3. 为这些调用生成 UI-only `ToolPresentation(status: 'cancelled')`。
4. 经既有 `finishToolCall → resolveTool` 路径，把已关闭的 `PendingTool` 原地固化为 `ToolBlock(status: cancelled)`。
5. 提交既有 `Partially completed` final feedback。

该 UI-only presentation 仅描述父轮次已取消时的显示终态；它不是 provider 或子代理的执行结果，也不会进入父 agent 的 tool-result 数据流。

## 不变量

### 幂等与不覆盖

取消终结必须幂等。已完成、失败或被拒绝而已有 presentation 的工具不得被取消路径覆盖；不存在于 `toolBuffer` 的调用不得被修改。

### 晚到真实结果

`BlockPipeline` 的未知 result 路径会创建 orphan 展示，不能自然满足此不变量。只有实际从 `toolBuffer` 成功终结为 `cancelled` 的 tool-use ID，才写入最小 UI tombstone。

对命中 tombstone 的晚到真实 `tool_result`，pipeline 仅忽略该 UI result，并立即删除 tombstone；它不得进入 orphan-result fallback，也不得重建 pending 状态、生成第二个 ToolBlock 或扰乱时间线。非 cancelled 的未知 result 继续保留现有 orphan-result 兜底。

未被晚到 result 消费的 tombstone 不在父轮次 finalization 后立即清除；它随 `BlockPipeline` / session reset 清理。tombstone 仅影响 UI pipeline，不改变 agent、provider 或 tool-result 的数据语义。

## 修改范围

- `src/index.ts`：仅在本轮 `aborted` 的 finalization 路径触发 pending-tool UI 终结，并在 final feedback 前执行。
- `src/ui/block-pipeline.ts`：基于现有 `toolBuffer` 提供按 tool-use ID 终结 unresolved 调用的最小入口，并仅记录已取消 ID 以忽略其晚到 result。
- `src/tui/transcript-types.ts`：增加 `cancelled` 工具展示状态。
- `src/tui/inline-v2/ToolBlockLine.tsx`：渲染取消状态。
- 对应 locale：提供取消工具的可见文案。
- 对应 pipeline/reducer 集成测试：保护以下验收契约。

不修改 provider、subagent、tool executor、`selectCommittedTranscript` 或其 selector 规则。

## 验收设计

- `pending tool → parent abort → cancelled ToolBlock → Partially completed` 在 committed transcript 中按顺序连续可见。
- 没有真实 `tool_result` 时也能解除 transcript 阻塞。
- 非 abort 的 pending tool 保持现有行为。
- 已完成的工具不会被改写为 cancelled。
- 晚到 result 不产生重复 ToolBlock，也不重建 pending 状态。
- 最终 ConPTY 验收要求显示取消工具状态和 `Partially completed`；不再要求 `Subagent incomplete: user_abort`。
