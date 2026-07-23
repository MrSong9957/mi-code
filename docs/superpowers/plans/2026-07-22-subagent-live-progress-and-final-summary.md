# Subagent Live Progress and Final Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `spawn_agent` 在执行开始时立即真实显示，让子代理内部工具进度实时附着到对应调用，并保证轮次耗尽前产出基于工具证据的最终总结。

**Architecture:** 保留现有 `StreamEventBus -> BlockPipeline -> MessagesStore -> InlineAppV2` 主链路。修复分三层：Inline V2 渲染活动中的工具消息；把子代理私有事件总线的工具进度按父 `toolUseId` 桥接到外层 pending 消息；在子代理最大轮次的最后一轮关闭工具并强制总结。显式要求使用子代理的用户请求失败时只报告失败，不由主 Agent 静默改用文件工具重做。

**Tech Stack:** TypeScript ES2022、Node.js >= 18、React/Ink、Zustand、Vitest。

## Global Constraints

- 默认 TDD，严格执行 RED -> GREEN -> REFACTOR。
- 只修改子代理事件链、Inline V2 活动消息渲染和相关提示词；不重构无关 TUI 或 Agent Loop。
- pending 工具必须在 executor Promise resolve 前可见。
- 并行子代理进度必须按父 `toolUseId` 隔离，禁止“最后一条消息”匹配。
- 子代理最后总结必须基于已经写回消息历史的工具结果；不得把 `Now let me check...` 等过程句当作结果。
- `maxTurns` 仍是硬安全边界；最后一轮计入该边界，不通过无限增加轮次规避问题。
- 不改变普通自动委派失败后的主 Agent 容错策略；只约束用户明确要求“使用子代理”的场景。

---

## Wheel Reuse Check

- 复用 `StreamEventBus` 的 `tool_call`、`tool_result` 和 `loop_end` 事件，不新增第二套事件系统。
- 复用 `BlockPipeline`、`PipelineToStoreAdapter` 和 `MessagesStore` 的 pending-tool 生命周期。
- 复用 `toolUseId` 作为父调用关联键，不使用全局 FIFO 或“最近完成工具”。
- 复用 `InlineAppV2` 的活动区域；pending 消息不能提前写入 Ink `<Static>`，否则最终内容无法安全原地更新。
- 复用 `streamingQuery` 的最后一轮模型调用，不额外创建脱离消息历史的总结 API。

## Core Anchor Functions

- UI 可见性：`InlineAppV2()`，输入为 `TuiMessage[]`，输出为终端活动区和静态区。
- 子代理事件桥接：`runSubagentWithClient()`，输入为子代理客户端、工具集和回调，输出为 `SubagentResult`。
- 轮次收尾：`streamingQuery()`，负责决定本轮可用工具以及何时 `end_turn/max_turns`。

## File Map

- Modify: `src/tui/inline-v2/InlineAppV2.tsx` — 渲染所有未完成工具消息并计算活动区行数。
- Modify: `src/tui/state/messages-store.ts` — 按父 `toolUseId` 更新 pending 工具的临时子代理进度。
- Modify: `src/tui/state/pipeline-adapter.ts` — 暴露精确的工具进度更新接口。
- Modify: `src/ui/types.ts` — 增加子代理工具进度 block 类型。
- Modify: `src/ui/block-pipeline.ts` — 将子代理进度路由到匹配的父工具消息。
- Modify: `src/agent/types.ts` — 增加工具执行上下文和子代理进度事件类型。
- Modify: `src/agent/tool-registry.ts` — 把当前 `toolUseId` 传给 executor。
- Modify: `src/agent/streaming-query.ts` — 传递执行上下文，并为子代理保留最终文本轮。
- Modify: `src/agent/subagent.ts` — 转发私有事件总线事件并启用最终文本轮。
- Modify: `src/agent/tools/spawn-agent-tool.ts` — 将父调用 ID 传给子代理进度回调。
- Modify: `src/index.ts` — 把子代理进度桥接到主 `BlockPipeline`，并增加显式委派约束。
- Test: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx` — 验证终端真实输出，而非仅检查 store。
- Test: `src/__tests__/tui/messages-store.test.ts` — 验证父 ID 精确更新和并行隔离。
- Test: `src/__tests__/tui/pipeline-integration.test.ts` — 验证子代理进度的 pipeline/store 数据流。
- Test: `src/__tests__/subagent-result-integrity.test.ts` — 验证最终轮禁用工具并产出总结。
- Test: `src/__tests__/role-agents.test.ts` — 验证 spawn executor 收到父调用 ID 并转发进度。
- Create: `src/__tests__/subagent-explicit-delegation.test.ts` — 验证显式委派失败后主 Agent 不自行读取文件。
- Modify: `logs/subagent-visibility-and-plan-isolation.md` — 只记录 RED/GREEN、根因和最终验证结果。

---

### Task 1: Make Pending Tool Calls Visible in Inline V2

**Files:**
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`
- Test: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`

**Interfaces:**
- Consumes: `TuiMessage.kind === 'tool-progress'`, `TuiMessage.finalized === false`, and `TuiMessage.lines`.
- Produces: pending tools rendered in the active Ink region before their results arrive.

- [ ] **Step 1: Write the failing real-render test**

Add a test that renders `InlineAppV2` with this message and checks rendered terminal output:

```ts
const pendingTool: TuiMessage = {
  uuid: 'tool-1',
  role: 'tool',
  kind: 'tool-progress',
  toolUseId: 'spawn-1',
  lines: [{ content: '● spawn_agent({"role":"explore"})', style: {}, indent: 0 }],
  finalized: false,
};

expect(output()).toContain('spawn_agent');
```

Then rerender the same UUID as finalized with a result and assert that the visible output contains one logical call/result block, not a pending duplicate.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/inline-app-v2.test.tsx -t "pending tool"
```

Expected: FAIL because `InlineAppV2` filters the message out of `finalized` and its dynamic renderer only consumes `streamingText`.

- [ ] **Step 3: Render pending tools in the active region**

In `InlineAppV2()`, separate active messages by kind:

```ts
const finalized = messages.filter(message => message.finalized);
const pendingTools = messages.filter(message =>
  !message.finalized && message.kind === 'tool-progress',
);
```

Render `pendingTools` with `MessageLine` immediately before the spinner/footer. Keep assistant/thinking streaming on `StreamingText`. Do not put pending tools into `<Static>`.

Include pending tool line count in `inputRowY`; calculate from `message.lines` using the same terminal-width wrapping rules already used by message rendering. Do not assume one tool equals one physical row.

- [ ] **Step 4: Cover parallel pending tools**

Add a render test with `spawn-1` and `spawn-2`; assert both are visible before either result is delivered and remain in call order.

- [ ] **Step 5: Run the focused UI suite and verify GREEN**

Run:

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/pipeline-integration.test.ts
```

Expected: both files pass; a standalone pending `spawn_agent` is present in rendered output.

- [ ] **Step 6: Commit**

```powershell
git add src/tui/inline-v2/InlineAppV2.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git commit -m "fix(tui): render pending tool calls live"
```

---

### Task 2: Associate Child Progress with the Parent Spawn Call

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/tool-registry.ts`
- Modify: `src/agent/streaming-query.ts`
- Modify: `src/agent/subagent.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts`
- Test: `src/__tests__/role-agents.test.ts`
- Test: `src/__tests__/subagent-result-integrity.test.ts`

**Interfaces:**
- Produces: `ToolExecutionContext { toolUseId: string }` passed from `streamingQuery` to tool executors.
- Produces: `SubagentProgressEvent` carrying parent ID plus child call/result data.
- Consumes: existing `StreamEventBus.onToolCall/onToolResult` events.

- [ ] **Step 1: Write a failing executor-context test**

Register a test executor, call it through the real `streamingQuery` path, and capture its second argument:

```ts
expect(receivedContext).toEqual({ toolUseId: 'spawn-1' });
```

Expected failure: current `ToolExecutor` receives only input.

- [ ] **Step 2: Add the minimal execution context**

Define:

```ts
export interface ToolExecutionContext {
  toolUseId: string;
}

export type ToolExecutor = (
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
) => Promise<string>;
```

Update `ToolRegistry.execute()` to accept the optional context and pass it through. In every `streamingQuery` execution branch call:

```ts
registry.execute(block.name, block.input, { toolUseId: block.id });
```

Keep the context optional so existing executors and direct unit tests remain source-compatible.

- [ ] **Step 3: Write a failing child-progress forwarding test**

Use a scripted subagent client that emits one `read_file` call and result. Pass an `onProgress` spy to `runSubagent()` and assert the order:

```ts
expect(events.map(event => event.kind)).toEqual(['tool_call', 'tool_result']);
expect(events[0]).toMatchObject({ parentToolUseId: 'spawn-1', name: 'read_file' });
```

- [ ] **Step 4: Add typed subagent progress forwarding**

Add to `SubagentOptions`:

```ts
onProgress?: (event: SubagentProgressEvent) => void;
parentToolUseId?: string;
```

Subscribe `runSubagentWithClient()` to its private event bus before starting `streamingQuery`. Forward `tool_call` and `tool_result` with `parentToolUseId`. Remove all three listeners (`tool_call`, `tool_result`, `loop_end`) in `finally`.

In `createSpawnAgentTool`, read `context?.toolUseId` and pass it to `runSubagentFn`. Do not use generated global IDs or FIFO matching.

- [ ] **Step 5: Verify parallel isolation at the agent boundary**

Run two mocked spawn executors with parent IDs `spawn-1` and `spawn-2`; interleave child events and assert every forwarded event retains the correct parent ID.

- [ ] **Step 6: Run focused tests and commit**

Run:

```powershell
npx.cmd vitest run src/__tests__/role-agents.test.ts src/__tests__/subagent-result-integrity.test.ts
```

Expected: PASS.

Commit:

```powershell
git add src/agent/types.ts src/agent/tool-registry.ts src/agent/streaming-query.ts src/agent/subagent.ts src/agent/tools/spawn-agent-tool.ts src/__tests__/role-agents.test.ts src/__tests__/subagent-result-integrity.test.ts
git commit -m "feat(subagent): expose live child tool progress"
```

---

### Task 3: Update the Matching Parent Pending Message

**Files:**
- Modify: `src/ui/types.ts`
- Modify: `src/ui/block-pipeline.ts`
- Modify: `src/tui/state/messages-store.ts`
- Modify: `src/tui/state/pipeline-adapter.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/tui/messages-store.test.ts`
- Test: `src/__tests__/tui/pipeline-integration.test.ts`

**Interfaces:**
- Consumes: `SubagentProgressEvent` from Task 2.
- Produces: `Block` variant `subagent_tool_progress` keyed by `parentToolUseId`.
- Produces: precise `updatePendingToolProgress(parentToolUseId, lines)` store operation.

- [ ] **Step 1: Write failing store tests for exact parent matching**

Create pending messages `spawn-1` and `spawn-2`, update only `spawn-2`, and assert:

```ts
expect(linesFor('spawn-1')).not.toContain('read_file');
expect(linesFor('spawn-2')).toContain('read_file');
```

Also assert an unknown parent ID returns `false` and changes no message.

- [ ] **Step 2: Add the narrow store and adapter API**

Add:

```ts
updatePendingToolProgress(
  parentToolUseId: string,
  progressLines: FormattedLine[],
): boolean;
```

The update must rebuild the matched message as `original call lines + current transient progress`. Keep the original call lines separately or derive them from an explicit field; do not repeatedly append the entire accumulated progress and create duplicates.

- [ ] **Step 3: Write the failing pipeline integration test**

Emit:

```ts
pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'spawn-1' });
pipeline.emit({
  kind: 'subagent_tool_progress',
  parentToolUseId: 'spawn-1',
  childToolUseId: 'read-1',
  name: 'read_file',
  phase: 'running',
});
```

Assert the existing `spawn-1` message contains a nested `read_file` progress line and no second top-level tool message was created.

- [ ] **Step 4: Route progress through BlockPipeline**

Format child activity as nested/dim content and update only the parent pending message. On child result, replace that child's running line with its completed summary. Maintain a per-parent map keyed by child tool ID so result arrival order cannot corrupt another child.

When the outer `spawn_agent` result arrives, the existing `finishToolCall()` remains authoritative and replaces transient child progress with the final call/result block.

- [ ] **Step 5: Connect the production callback**

When constructing `createSpawnAgentTool()` in `src/index.ts`, provide an `onProgress` callback that emits `subagent_tool_progress` into the current `pipeline`. Because `pipeline` is assigned after bootstrap, the callback must read the live outer variable at execution time rather than capture the initial no-op renderer.

- [ ] **Step 6: Run the UI data-flow tests and commit**

Run:

```powershell
npx.cmd vitest run src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/ui/block-pipeline.test.ts
```

Expected: PASS, including interleaved progress for two parent spawn calls.

Commit:

```powershell
git add src/ui/types.ts src/ui/block-pipeline.ts src/tui/state/messages-store.ts src/tui/state/pipeline-adapter.ts src/index.ts src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/ui/block-pipeline.test.ts
git commit -m "fix(tui): stream child progress into parent spawn"
```

---

### Task 4: Reserve a Guaranteed Final Summary Turn

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/streaming-query.ts`
- Modify: `src/agent/subagent.ts`
- Test: `src/__tests__/subagent-result-integrity.test.ts`

**Interfaces:**
- Produces: `StreamingQueryOptions.reserveFinalTextTurn?: boolean`.
- Consumes: existing `maxTurns` and accumulated `messages` containing tool results.

- [ ] **Step 1: Replace the test that blesses process text**

Remove the expectation that an exhausted subagent returns `Now let me check...`. Add a two-turn script:

1. Turn 1 calls `read_file`.
2. Turn 2 returns `Verified skills: code-review, git-workflow`.

Capture the tool definitions passed to each model call and assert:

```ts
expect(toolNamesForTurn(1)).toContain('read_file');
expect(toolNamesForTurn(2)).toEqual([]);
expect(result.text).toBe('Verified skills: code-review, git-workflow');
expect(result.status).toBe('completed');
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts -t "final summary turn"
```

Expected: FAIL because the current last turn still exposes tools and the max-turn guard can exit before synthesis.

- [ ] **Step 3: Implement the reserved final turn**

Before each model submission in `streamingQuery`, calculate whether the upcoming call is the final allowed turn. When `reserveFinalTextTurn` is true and the upcoming call is final:

```ts
const finalTextTurn = reserveFinalTextTurn
  && maxTurns !== undefined
  && turnCount === maxTurns - 1;

const queryOptions = {
  systemPrompt: finalTextTurn
    ? `${systemPrompt}\n\nFinal turn: do not call tools. Return a concise factual summary based only on tool results already present in the conversation.`
    : systemPrompt,
  tools: finalTextTurn ? [] : tools,
  signal,
  maxTokens: recoveryState.maxTokens,
};
```

Enable the option only in `runSubagentWithClient()`. Main Agent behavior remains unchanged.

- [ ] **Step 4: Preserve a safe failure path**

Add a scripted client that emits no final text even with no tools. Assert the result is `incomplete` with `(no final text)` and does not contain a process narration sentence.

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts src/__tests__/streaming-query.test.ts
```

Expected: PASS.

Commit:

```powershell
git add src/agent/types.ts src/agent/streaming-query.ts src/agent/subagent.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/streaming-query.test.ts
git commit -m "fix(subagent): reserve a final summary turn"
```

---

### Task 5: Honor Explicit Subagent Delegation

**Files:**
- Modify: `src/index.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts`
- Create: `src/__tests__/subagent-explicit-delegation.test.ts`

**Interfaces:**
- Consumes: `SubagentResult.status` serialized in the spawn tool result.
- Produces: explicit-delegation policy: report incomplete/error instead of silently invoking main-agent filesystem tools.

- [ ] **Step 1: Write a failing scripted main-agent test**

Script the main model as follows:

1. User input explicitly says `Use a subagent to list skills`.
2. Main model calls `spawn_agent`.
3. Spawn result is incomplete.
4. The next scripted response attempts `read_file` from the main Agent.

Assert the explicit-delegation policy rejects or prevents that fallback and the final response reports the subagent failure.

- [ ] **Step 2: Preserve structured status in tool output**

Do not return only an ambiguous prose summary. Serialize at least:

```text
[Subagent status=incomplete reason=max_turns]
<partial or diagnostic text>
```

Completed output should likewise carry `status=completed`, allowing the main prompt to distinguish success from partial execution without guessing from arbitrary prose.

- [ ] **Step 3: Add the narrow prompt rule**

Add to the main system prompt:

```text
When the user explicitly requires a subagent, do not replace an incomplete or failed
subagent run with your own filesystem/tool investigation. Report the subagent status
and available partial result. This restriction does not apply to automatic delegation
that you selected yourself.
```

Do not add a global prohibition against fallback; it would reduce reliability for ordinary tasks.

- [ ] **Step 4: Run the policy test and commit**

Run:

```powershell
npx.cmd vitest run src/__tests__/subagent-explicit-delegation.test.ts src/__tests__/role-agents.test.ts
```

Expected: PASS.

Commit:

```powershell
git add src/index.ts src/agent/tools/spawn-agent-tool.ts src/__tests__/subagent-explicit-delegation.test.ts
git commit -m "fix(subagent): honor explicit delegation requests"
```

---

### Task 6: End-to-End Verification and Build Provenance

**Files:**
- Modify: `logs/subagent-visibility-and-plan-isolation.md`

**Interfaces:**
- Consumes: all behavior implemented in Tasks 1-5.
- Produces: terminal evidence that the real user path works and records the exact tested commit/worktree.

- [ ] **Step 1: Run affected tests**

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/subagent-explicit-delegation.test.ts src/__tests__/streaming-query.test.ts
```

Expected: all affected files pass.

- [ ] **Step 2: Run static checks**

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: both exit 0. If lint remains baseline-red, run scoped ESLint over every changed source/test file and record both the baseline failure and scoped result without claiming global lint success.

- [ ] **Step 3: Run the full suite**

```powershell
npm.cmd test
```

Expected: exit 0. If baseline failures remain, compare with the pre-change baseline and block merge on any new failure.

- [ ] **Step 4: Verify the exact build source**

Record:

```powershell
git rev-parse HEAD
git branch --show-current
git worktree list
```

Build and launch from `D:\Files\Projects\mi-code\.worktrees\auto-0025`, not the separate `master` checkout.

- [ ] **Step 5: Perform the real manual scenario**

Input:

```text
用子代理告诉我你能看到哪些技能
```

Acceptance criteria:

1. `spawn_agent(...)` appears before the child finishes.
2. While the child runs, its current `Read/Bash` activity appears nested under that spawn call.
3. The child returns a factual skill summary before the limit.
4. The final outer tool message replaces transient progress without duplicates.
5. The main Agent integrates the child result and does not call its own `Read/Bash` for this explicit-delegation request.

- [ ] **Step 6: Record evidence and commit**

Append only root cause, RED/GREEN evidence, commands, counts, manual result, branch, and commit hash to the log.

```powershell
git add logs/subagent-visibility-and-plan-isolation.md
git commit -m "test(subagent): verify live progress and final summary"
```

---

## Plan Self-Review

- Spec coverage: covers delayed outer call visibility, invisible child tool progress, max-turn process-text leakage, and main-Agent silent fallback.
- Placeholder scan: no TODO/TBD or unspecified implementation step remains.
- Type consistency: parent correlation consistently uses `parentToolUseId`; child correlation consistently uses `childToolUseId`; executor context uses `ToolExecutionContext.toolUseId`.
- Scope: no plan-store or AskUser implementation is touched; the previously fixed stale-plan issue remains outside this repair.
- Defensive boundary: unknown parent IDs return `false` and never fall back to FIFO; final summary mode exposes zero tools; explicit-delegation restriction is conditional rather than global.

