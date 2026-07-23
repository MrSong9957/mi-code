# Subagent Stable Running Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子代理启动后立即显示固定高度的 `spawn_agent` 行，通过闪烁的 `●` 表示运行中，同时隐藏子代理内部工具明细，消除活动区闪烁、空白和内容暂时消失。

**Architecture:** 保留现有外层 `tool_call -> pending message -> tool_result -> finalized message` 生命周期。运行中的 pending 工具改由专用叶子组件渲染，组件只订阅现有 spinner 共享时钟并在固定宽度槽位内切换 `●/空格`；子代理内部 `read_file/run_bash` 不再进入主消息正文。完成后继续使用现有 `resolvePendingTool()` 一次性固化最终结果。

**Tech Stack:** TypeScript ES2022、Node.js >= 18、React/Ink、Zustand、Vitest。

## Global Constraints

- 只探索所得方案，不在本计划中执行实现。
- 实施时严格执行 RED -> GREEN -> REFACTOR。
- `spawn_agent` 必须在 executor Promise 完成前可见。
- 运行中每个 pending 工具固定占一物理行；输入过长时单行截断，不允许换行改变活动区高度。
- 闪烁周期为 600ms；所有 pending 工具复用现有 spinner 时钟，不创建每行独立的 `setInterval`。
- 闪烁只改变前导符号，正文、key、行数和布局尺寸保持不变。
- 子代理内部工具事件不写入 `TuiMessage.lines`，不在主消息列表展示。
- 最终结果、强制总结轮和显式子代理委派策略保持现状，不在本次修复中重写。
- 保留用户已有的 `package-lock.json` 修改，不纳入提交。

---

## Root Cause

当前实现对每个子工具事件执行：

```text
subagent tool event
-> BlockPipeline.subagentProgress 增长或替换
-> updatePendingToolProgress()
-> TuiMessage.lines 重建
-> InlineAppV2/MessageLine 重渲染
-> pendingToolsRowCount 改变
-> footer/inputRowY 改变
```

这会造成三个确定性问题：

1. 每出现一个新的子工具，pending 消息增加一行，Ink 必须清除并重画整个活动区。
2. `pendingToolsRowCount` 使用 `lines.length` 估算高度，但 `MessageLine` 会按终端宽度换行；逻辑行数与物理行数不一致时，footer 坐标错误。
3. 消息更新和 spinner tick 同时发生，根节点因 `messages` 数组变化重渲染，扩大清屏重画范围。

Claude Code 源码验证了正确边界：进行中工具保持动态，完成后才静态冻结；运行符号使用共享动画时钟；可变 progress 消息不直接进入主消息列表；子代理明细只在专用 UI 中有界聚合。结合本项目需求，采用更简单的“一行父调用 + 闪烁符号”方案。

当前格式化契约已经由源码确认：`src/ui/message-formatter.ts` 的 `formatToolCall()` 返回以下内容：

```ts
return { content: `● ${display}`, style: BLOCK_STYLES.magenta, indent: 0 };
```

因此 pending 组件只需要兼容三种输入：规范的 `● spawn_agent(...)`、无前导符号的 `spawn_agent(...)`，以及缺失/空首行；不得假设其他前缀格式。

## Reuse Check

- 复用 `useSpinnerClock()` 维护的 `SpinnerStore.time`，不新增动画调度器。
- 复用 `TuiMessage.kind === 'tool-progress'` 和 `resolvePendingTool()`。
- 复用 Ink `Box/Text` 的固定宽度和 `wrap="truncate-end"`。
- 复用当前 finalized `MessageLine`，不改变历史消息格式。
- 删除仅为展示子工具明细而引入的进度桥接，不保留无消费者的抽象。

## Pre-Implementation Audits

- `ToolExecutionContext` 全库消费者已核对：仅存在于 `agent/types.ts`、`agent/tool-registry.ts`、`agent/tools/spawn-agent-tool.ts` 和对应测试中；唯一运行时读取是 `spawn-agent-tool.ts` 的 `context?.toolUseId`，用途仅为关联父 `spawn_agent` 与子 UI progress。没有权限、会话、审计或其他工具执行器依赖它。Task 3 开始前必须重新运行同一搜索，若结果漂移则停止删除并改为精简类型。
- `pendingToolsRowCount` 仅在 `InlineAppV2.tsx` 中使用。`flatten-messages.ts` 与 `row-text-map.ts` 虽读取 `msg.lines.length`，但都先跳过 `!msg.finalized`，不会参与 pending 高度计算。Task 2 后必须复查这些不变量。
- pending 解析由 `tool_result` 事件驱动；spinner 生命周期可能在更晚的 loop-end 才停止。因此不采用“spinner 停止到 finalize ≤ 1 帧”的墙钟断言。真实 UX 不变量是：只要消息仍 pending，符号槽始终存在；`active=false` 时符号强制可见；消息 finalized 后 pending 组件立即消失。

## Core Anchor Function

`InlineAppV2()` 是本次核心入口：输入 `TuiMessage[]` 和 stores，输出活动区与静态区。成功标准是同一个 pending `spawn_agent` 在任意数量的子代理内部工具事件和动画 tick 下始终只占一物理行。

## File Map

- Create: `src/tui/inline-v2/PendingToolMessage.tsx` — 固定一行、只闪烁前导符号的运行中工具组件。
- Create: `src/tui/inline-v2/pending-tool-indicator.ts` — 600ms 可见性计算纯函数。
- Modify: `src/tui/inline-v2/InlineAppV2.tsx` — 用专用组件替代 pending `MessageLine`，行数按 pending 数量精确计算。
- Modify: `src/index.ts` — 停止把子代理内部工具事件发到主 pipeline。
- Modify: `src/agent/subagent.ts` — 删除无消费者的 UI 进度回调。
- Modify: `src/agent/tools/spawn-agent-tool.ts` — 删除进度桥接工厂和父调用 ID 透传。
- Modify: `src/agent/types.ts` — 删除仅供进度桥接使用的类型。
- Modify: `src/agent/tool-registry.ts` — 恢复无需 `ToolExecutionContext` 的 executor 调用。
- Modify: `src/agent/streaming-query.ts` — 不再为 UI 进度传递工具执行上下文。
- Modify: `src/ui/types.ts` — 删除 `subagent_tool_progress` block。
- Modify: `src/ui/block-pipeline.ts` — 删除子代理进度缓存和格式化逻辑。
- Modify: `src/tui/types.ts` — 删除 `originalCallLines`。
- Modify: `src/tui/state/messages-store.ts` — 删除 `updatePendingToolProgress()`。
- Modify: `src/tui/state/pipeline-adapter.ts` — 删除对应 adapter API。
- Test: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx` — 验证真实 Ink 输出、固定高度和状态迁移。
- Create: `src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts` — 验证 600ms 闪烁函数。
- Modify: `src/__tests__/tui/pipeline-integration.test.ts` — 删除“展示子工具明细”的错误契约，保留外层 pending 生命周期。
- Modify: `src/__tests__/tui/messages-store.test.ts` — 删除进度正文更新测试。
- Modify: `src/__tests__/subagent-result-integrity.test.ts` — 保留结果完整性，删除 UI 回调测试。
- Delete: `src/__tests__/tool-execution-context.test.ts` — 该上下文只为已移除的进度桥接存在。
- Modify: `logs/subagent-visibility-and-plan-isolation.md` — 记录根因、RED/GREEN 和实测证据。

---

### Task 1: Add a Fixed-Height Blinking Pending Tool Component

**Files:**
- Create: `src/tui/inline-v2/pending-tool-indicator.ts`
- Create: `src/tui/inline-v2/PendingToolMessage.tsx`
- Create: `src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts`
- Modify: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`

**Interfaces:**
- Produces: `isPendingToolGlyphVisible(timeMs: number, intervalMs?: number): boolean`.
- Produces: `PendingToolMessage({ msg, cols, spinnerStore })` rendering exactly one physical row.

- [ ] **Step 1: Write the failing blink-cycle test**

```ts
import { describe, expect, it } from 'vitest';
import { isPendingToolGlyphVisible } from '../../../tui/inline-v2/pending-tool-indicator.js';

describe('isPendingToolGlyphVisible', () => {
  it('toggles every 600ms', () => {
    expect(isPendingToolGlyphVisible(0)).toBe(true);
    expect(isPendingToolGlyphVisible(599)).toBe(true);
    expect(isPendingToolGlyphVisible(600)).toBe(false);
    expect(isPendingToolGlyphVisible(1199)).toBe(false);
    expect(isPendingToolGlyphVisible(1200)).toBe(true);
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure visibility function**

```ts
export const PENDING_TOOL_BLINK_INTERVAL_MS = 600;

export function isPendingToolGlyphVisible(
  timeMs: number,
  intervalMs = PENDING_TOOL_BLINK_INTERVAL_MS,
): boolean {
  const safeTime = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
  return Math.floor(safeTime / intervalMs) % 2 === 0;
}
```

- [ ] **Step 4: Write a failing one-row component test**

Render a pending message whose call text is wider than `cols=40`. Assert the rendered frame contains exactly one line belonging to the pending tool, contains `spawn_agent`, and ends with Ink truncation rather than wrapping onto a second line.

Also advance `SpinnerStore.time` across 600ms and assert only the two-column glyph slot changes; the visible tool text and total frame line count remain identical.

Add these boundary cases to the same test file:

- Render `● spawn_agent(查询工作区中的技能并汇总详细信息)` at a narrow width. Assert it remains exactly one physical row and truncates according to terminal column width; this protects Chinese double-width behavior.
- Compare visible and hidden glyph frames after removing the two-character glyph cell. Assert the remaining body text starts at the same terminal column and total row width is unchanged.
- Pass canonical `● spawn_agent(...)` and assert only the leading glyph plus following space are stripped.
- Pass `spawn_agent(...)` without a glyph and assert it is unchanged.
- Pass a message with `lines=[]` and one with an empty first-line content; assert both render the fallback `tool` on one row without throwing.
- Set `spinnerStore.active=false` while the message remains pending and assert `●` is visible, independent of the last clock phase.

- [ ] **Step 5: Implement `PendingToolMessage`**

Use a leaf subscription so spinner ticks do not rerender `InlineAppV2`:

```tsx
export const PendingToolMessage = React.memo(function PendingToolMessage({
  msg,
  cols,
  spinnerStore,
}: PendingToolMessageProps): React.ReactElement {
  const time = useStore(spinnerStore, state => state.time);
  const active = useStore(spinnerStore, state => state.active);
  const visible = !active || isPendingToolGlyphVisible(time);
  const callText = stripLeadingToolGlyph(msg.lines[0]?.content);

  return (
    <Box height={1} width={cols} flexDirection="row">
      <Box width={2} minWidth={2} height={1}>
        <Text>{visible ? '●' : ' '}</Text>
      </Box>
      <Text wrap="truncate-end">{callText}</Text>
    </Box>
  );
});
```

`stripLeadingToolGlyph(content?: string)` 只删除开头的 `●` 和紧随空格，不修改正文中的其他字符。其输入契约来自当前 `formatToolCall()` 的具体输出 `● ${display}`；没有前导符号时必须保持原文，缺失、空字符串或仅空白输入必须回退到 `tool`。组件不得读取 `msg.lines.slice(1)`，从结构上保证内部明细不会影响高度。

- [ ] **Step 6: Run GREEN and commit**

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git add src/tui/inline-v2/pending-tool-indicator.ts src/tui/inline-v2/PendingToolMessage.tsx src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git commit -m "fix(tui): add stable pending tool indicator"
```

Expected: tests pass; no implementation outside the four listed files changes in this task.

---

### Task 2: Use the Stable Indicator in Inline V2

**Files:**
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`
- Modify: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`

**Interfaces:**
- Consumes: `PendingToolMessage` from Task 1.
- Produces: one fixed activity row per pending tool and unchanged finalized rendering.

- [ ] **Step 1: Write the failing dynamic-to-static test**

Use `ink-testing-library` rerendering with the same message UUID:

1. Pending frame contains `spawn_agent` and exactly one pending row.
2. Blink tick changes only `●` visibility.
3. Finalized frame contains the normal tool result.
4. Finalized frame contains no active pending copy.
5. No frame contains child `read_file/run_bash` text.
6. Finalized output contains no pending indicator component or leftover blinking glyph slot.

- [ ] **Step 2: Run RED**

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/inline-app-v2.test.tsx -t "stable pending"
```

Expected: FAIL because pending tools currently use the multi-line `MessageLine` component.

- [ ] **Step 3: Replace the pending renderer**

Replace:

```tsx
<MessageLine key={msg.uuid} msg={msg} cols={cols} />
```

with:

```tsx
<PendingToolMessage
  key={msg.uuid}
  msg={msg}
  cols={cols}
  spinnerStore={stores.spinnerStore}
/>
```

Change row accounting to the exact invariant:

```ts
const pendingToolsRowCount = pendingTools.length;
```

Do not subscribe `InlineAppV2` to `spinnerStore.time`; only the leaf component may subscribe.

- [ ] **Step 4: Cover parallel pending calls**

Render four pending calls and assert exactly four stable rows. Advance the shared clock once and assert all glyphs change in phase while every tool body and row position remains unchanged.

While the clock is in its hidden phase, resolve one pending tool using the normal `resolvePendingTool()` path. Assert the resolved message is rendered only by the finalized renderer, contains no pending indicator, and the remaining three pending rows neither move nor duplicate. Then set `spinnerStore.active=false` before resolving another call and assert its pending glyph becomes visible; this deterministic state transition covers the perceived-race case without relying on wall-clock timing.

Audit row accounting after the renderer change:

```powershell
Get-ChildItem -Path src -Recurse -File | Select-String -Pattern 'pendingToolsRowCount|msg\.lines\.length'
```

Expected: `pendingToolsRowCount` is local to `InlineAppV2`; every other `msg.lines.length` consumer either handles finalized messages only or is explicitly proven unrelated to pending layout.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/connected-app-spinner-clock.test.tsx
git add src/tui/inline-v2/InlineAppV2.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git commit -m "fix(tui): keep pending tool layout fixed"
```

Expected: Inline V2 tests pass and existing spinner clock isolation remains green.

---

### Task 3: Remove Child Tool Details from the Main Message Pipeline

**Files:**
- Modify: `src/index.ts`
- Modify: `src/agent/subagent.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/tool-registry.ts`
- Modify: `src/agent/streaming-query.ts`
- Modify: `src/ui/types.ts`
- Modify: `src/ui/block-pipeline.ts`
- Modify: `src/tui/types.ts`
- Modify: `src/tui/state/messages-store.ts`
- Modify: `src/tui/state/pipeline-adapter.ts`
- Delete: `src/__tests__/tool-execution-context.test.ts`
- Modify: `src/__tests__/subagent-result-integrity.test.ts`
- Modify: `src/__tests__/tui/messages-store.test.ts`
- Modify: `src/__tests__/tui/pipeline-integration.test.ts`

**Interfaces:**
- Preserves: outer `tool_call/tool_result` events and `SubagentResult.evidence` counts.
- Removes: `SubagentProgressEvent`, `SubagentProgressBridge`, `subagent_tool_progress`, `updatePendingToolProgress`, `originalCallLines`, and UI-only `ToolExecutionContext`.

- [ ] **Step 0: Reconfirm `ToolExecutionContext` deletion boundary**

Run before editing:

```powershell
Get-ChildItem -Path src -Recurse -File | Select-String -Pattern '\bToolExecutionContext\b'
```

Expected consumers are limited to the type definition/imports in `agent/types.ts`, `agent/tool-registry.ts`, `agent/tools/spawn-agent-tool.ts`, plus `tool-execution-context.test.ts`. Confirm the only runtime field read remains `context?.toolUseId` for the child-progress bridge. If any permission, session, metadata, auditing, or non-spawn executor consumer appears, do not delete the context; instead narrow it to the still-required non-UI fields and revise Steps 3-4.

- [ ] **Step 1: Write the failing behavior test**

Drive a real scripted subagent through three internal tool calls while the outer `spawn_agent` remains pending. Assert the main `MessagesStore` contains one pending tool with one call line and no `read_file/run_bash` content.

The test must still assert that `SubagentResult.evidence.toolCallCount === 3`, proving internal activity remains available to result accounting even though it is hidden from the message body.

- [ ] **Step 2: Run RED**

```powershell
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts src/__tests__/tui/pipeline-integration.test.ts -t "hidden child progress"
```

Expected: FAIL because the current progress bridge appends every child tool to the parent pending message.

- [ ] **Step 3: Remove the production UI bridge**

Remove the `progressBridge` argument supplied by `src/index.ts` and its `pipeline.emit({ kind: 'subagent_tool_progress', ... })` callback.

Remove from `createSpawnAgentTool()`:

```ts
progressBridge?: SubagentProgressBridge
parentToolUseId
onProgress
```

Keep `formatSubagentResult()`, final summary handling, permission forwarding, role selection and reserved final turn unchanged.

- [ ] **Step 4: Remove orphaned agent plumbing**

Delete the UI-only progress types and listeners from `subagent.ts`. Continue counting tool calls and successful evidence through the existing normalized assistant/tool-result messages.

Because `ToolExecutionContext` was introduced solely to associate child UI progress with the parent spawn, restore the original executor signature:

```ts
export type ToolExecutor = (input: Record<string, unknown>) => Promise<string>;
```

Restore `ToolRegistry.execute(name, input)` and remove context arguments from every `streamingQuery` execution branch. Delete `tool-execution-context.test.ts`.

- [ ] **Step 5: Remove orphaned TUI plumbing**

Delete:

- `Block.kind === 'subagent_tool_progress'`.
- `BlockPipeline.subagentProgress` and `formatSubagentProgressLine()`.
- `PipelineRenderer.updateToolProgress()`.
- `MessagesState.updatePendingToolProgress()`.
- `TuiMessage.originalCallLines`.

Simplify `resolvePendingTool()` back to updating `lines` and `finalized` without stripping `originalCallLines`.

- [ ] **Step 6: Replace obsolete tests**

Delete tests that require child tool names/results inside pending messages. Retain or add tests for:

- outer pending call appears immediately;
- outer result resolves the same message;
- parallel outer calls remain isolated;
- child activity affects evidence counts but not visible lines;
- forced final summary still succeeds.

- [ ] **Step 7: Run affected tests and commit**

```powershell
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/streaming-query.test.ts src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/ui/block-pipeline.test.ts
git add src/index.ts src/agent/subagent.ts src/agent/tools/spawn-agent-tool.ts src/agent/types.ts src/agent/tool-registry.ts src/agent/streaming-query.ts src/ui/types.ts src/ui/block-pipeline.ts src/tui/types.ts src/tui/state/messages-store.ts src/tui/state/pipeline-adapter.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/tool-execution-context.test.ts
git commit -m "refactor(subagent): hide internal tool progress"
```

Expected: all listed tests pass and `Select-String` finds no remaining `subagent_tool_progress`, `updatePendingToolProgress`, `SubagentProgressBridge`, or `originalCallLines` symbols.

Also assert that no dangling `ToolExecutionContext` reference remains after its confirmed UI-only consumers are removed:

```powershell
Get-ChildItem -Path src -Recurse -File | Select-String -Pattern '\bToolExecutionContext\b'
```

Expected: no matches.

---

### Task 4: Verify Flicker-Free Rendering and Regression Safety

**Files:**
- Modify: `logs/subagent-visibility-and-plan-isolation.md`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: automated and manual evidence for stable rendering.

- [ ] **Step 1: Run the complete affected suite**

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/connected-app-spinner-clock.test.tsx src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/streaming-query.test.ts src/__tests__/subagent-explicit-delegation.test.ts
```

Expected: all affected tests pass.

- [ ] **Step 2: Run static checks**

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: typecheck exits 0. If lint has known baseline failures, run scoped ESLint over every changed source/test file and record both results without claiming global lint success.

- [ ] **Step 3: Run the full test suite**

```powershell
npm.cmd test
```

Expected: no new failures compared with the pre-change baseline.

- [ ] **Step 4: Perform the real terminal scenario**

Input:

```text
用子代理告诉我你能看到哪些技能
```

Acceptance criteria:

1. `spawn_agent(...)` immediately appears.
2. It occupies one fixed physical row throughout execution.
3. `●` alternates visible/hidden every 600ms; the two-column glyph slot never collapses.
4. No child `read_file/run_bash` line appears in the main message area.
5. Footer and input do not move vertically while the subagent runs.
6. Completion replaces the pending row with the existing final result once, with no blank frame or duplicate call.
7. The child still returns its complete summary and the main Agent does not redo explicit delegation.
8. Use a long Chinese `spawn_agent` prompt and confirm double-width characters truncate on the same row without shifting the footer.
9. Start four parallel pending calls and confirm all glyphs blink in phase from the shared clock while the activity area remains four rows high.

- [ ] **Step 5: Record evidence and commit**

Append the root cause, RED/GREEN commands, test counts, tested commit and manual result to the existing log.

```powershell
git add logs/subagent-visibility-and-plan-isolation.md
git commit -m "test(tui): verify stable subagent indicator"
```

---

## Alternatives Considered

1. **Recommended: one fixed parent row plus blinking `●`.** Smallest render surface, stable height, matches the user's stated preference and common agent UI behavior.
2. **Claude Code parity: show the last three child operations plus `+N more`.** More informative, but requires a dedicated capped-height progress component, aggregation state and stronger dynamic/static transition machinery. It is unnecessary for the current requirement and should be a separate feature if later requested.
3. **Keep every child detail visible.** Rejected because unbounded height changes are the direct cause of the observed flicker and blank regions.

## Plan Self-Review

- Requirement coverage: immediate visibility remains; child details are hidden; `●` animates; completion behavior and result integrity remain protected.
- Placeholder scan: every implementation step contains concrete files, code and verification commands.
- Type consistency: Task 3 removes every UI-progress symbol introduced by the previous bridge; no later task depends on those symbols.
- Scope: final summary, delegation policy, PlanStore and AskUser behavior are explicitly preserved.
- Defensive boundaries: animation uses one shared clock; fixed two-column glyph slot prevents horizontal movement; one-row truncation prevents vertical movement; parallel pending calls remain independent by existing message UUID/toolUseId.
- Review incorporation: Chinese double-width truncation, no-glyph and empty-line inputs, hidden-glyph slot width, four-way shared-clock rendering, mid-blink resolution, finalized-output cleanup, context-consumer audit, and pending-row-count audit are explicit gates.
- Timing rationale: the plan tests observable state transitions instead of a brittle “≤1 frame” debug-time threshold; inactive pending state forces `●` visible, and finalized state removes the pending component entirely.
