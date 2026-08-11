# 父轮次取消 Pending Tool TUI 终结 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 父轮次 ESC 时，把本轮未完成工具以 `cancelled` UI 终态固化，使现有 `Partially completed` feedback 连续可见，同时不等待或伪造工具结果。

**Architecture:** `index.ts` 只在本轮确认 `aborted` 后，把本轮 `activeToolIds` 交给 `BlockPipeline`。pipeline 只终结仍在自身 `toolBuffer` 中的调用，并复用 `finishToolCall → resolveTool` 形成 ToolBlock；它用仅限 UI 的 tombstone 抑制同一 ID 的一次晚到 result。renderer 和 reducer 继续遵守 committed transcript 的连续前缀规则，不作绕过。

**Tech Stack:** TypeScript、Vitest、Zustand vanilla store、Ink、ink-testing-library、node-pty/ConPTY harness。

## Global Constraints

- 只实现已批准的 UI 生命周期；不修改 provider、subagent、tool executor 或 `selectCommittedTranscript`。
- `cancelled` 是用户取消，不得显示为 `error`，且不生成真实 `tool_result`。
- 只对本轮 `activeToolIds` 内、仍 buffered 且未解析的调用生效；已解析调用不得覆盖。
- 晚到 result 的 tombstone 仅影响 UI pipeline：命中后忽略并删除；普通 turn cleanup 后保留；仅真正 pipeline/session reset 清除；非取消的未知 result 保持 orphan fallback。
- 所有行为先写最小失败测试，再写最小实现使其通过；每个任务独立提交。

---

## File structure and boundaries

- `src/tui/transcript-types.ts`：定义工具展示的语义状态联合类型。
- `src/tui/state/transcript-reducer.ts`：维护 `ToolPresentation` 排序，新增状态必须有确定顺序。
- `src/tui/inline-v2/ToolBlockLine.tsx`：将已固化 ToolBlock 的取消状态显示为非错误终态。
- `src/locale/resources/en-US.ts`、`src/locale/resources/zh-CN.ts`：提供取消工具摘要的本地化文案；`CanonicalResources` 由 zh-CN 推导，两个资源结构必须一致。
- `src/ui/block-pipeline.ts`：拥有 call/result 配对缓冲与 tombstone；`clearTurnState()` 只清普通 turn 瞬态，`clear()` 才清 pipeline/session-reset 状态。
- `src/index.ts`：拥有父轮次 `aborted` 与 `activeToolIds`，负责在 final feedback 前触发 pipeline 终结。
- `src/__tests__/ui/block-pipeline.test.ts`：断言 pipeline 的 call/result 路由、tombstone 和 reset 行为。
- `src/__tests__/tui/pipeline-integration.test.ts`：使用真实 pipeline、adapter、messages store 验证 committed transcript 的端到端连续性。
- `src/__tests__/tui/inline-v2/tool-block-line.test.tsx`：验证取消 ToolBlock 的可见文本和非错误样式语义。
- `src/__tests__/tui/transcript-reducer.test.ts`：锁定 `cancelled` 的确定性排序。
- `scripts/tty-verify/verify-esc-subagent.cjs`：只更新真实 ConPTY 的可见验收断言。

## Shared interface introduced by this plan

```ts
// src/tui/transcript-types.ts
export type ToolPresentationStatus =
  | 'success'
  | 'empty'
  | 'error'
  | 'cancelled';

// src/ui/block-pipeline.ts
public cancelPendingTools(toolUseIds: ReadonlySet<string>): void;
```

`cancelPendingTools` 只处理在 `toolBuffer` 中且 `resolved !== true` 的 ID。每个调用仅当 `renderer.finishToolCall(id, cancelledPresentation)` 返回 `true` 时，才从 buffer 删除并加入 `cancelledToolUseIds` tombstone 集合。tombstone 跨 `clearTurnState()` 保留；仅 `clear()` 清除它。

### Task 1: Add the cancelled presentation vocabulary and rendering

**Files:**
- Modify: `src/tui/transcript-types.ts:14-35`
- Modify: `src/tui/state/transcript-reducer.ts:344-353`
- Modify: `src/tui/inline-v2/ToolBlockLine.tsx:10-66`
- Modify: `src/locale/resources/en-US.ts:261-295`
- Modify: `src/locale/resources/zh-CN.ts:212-246`
- Modify: `src/__tests__/tui/transcript-reducer.test.ts:179-188`
- Modify: `src/__tests__/tui/inline-v2/tool-block-line.test.tsx:1-150`

**Interfaces:**
- Consumes: existing `ToolPresentation` and `orderToolPresentations`.
- Produces: `ToolPresentationStatus` accepts `cancelled`; `toolPresentation.status.cancelled` accepts `{ subject: string }`; cancelled presentation renders dim rather than red.

- [ ] **Step 1: Write the failing type, ordering, and Ink-render tests**

Add a `ToolPresentation` fixture with `status: 'cancelled'`, summary `spawn_agent → cancelled`, and assert:

```ts
expect(orderToolPresentations([cancelled, error, success]).map(p => p.status))
  .toEqual(['success', 'error', 'cancelled']);
expect(renderToolBlockLine({
  id: 'cancelled-tool', kind: 'tool', toolName: 'spawn_agent',
  presentations: [cancelled], thinking: [],
})).toContain('spawn_agent → cancelled');
```

Run: `npx vitest run src/__tests__/tui/transcript-reducer.test.ts src/__tests__/tui/inline-v2/tool-block-line.test.tsx`

Expected: FAIL because `cancelled` is not in `ToolPresentationStatus` and no rank/render treatment exists.

- [ ] **Step 2: Implement the smallest semantic and visible vocabulary**

```ts
export type ToolPresentationStatus = 'success' | 'empty' | 'error' | 'cancelled';

const rank: Record<ToolPresentation['status'], number> = {
  success: 0, empty: 1, error: 2, cancelled: 3,
};
```

Add `toolPresentation.status.cancelled` with `'{subject} → cancelled'` and its Chinese equivalent to both resource files. In `ToolBlockLine`, preserve red exclusively for `error` and make `cancelled` dim with `empty`; update its rendering comment to state all four statuses.

- [ ] **Step 3: Run focused tests and typecheck the locale shape**

Run: `npx vitest run src/__tests__/tui/transcript-reducer.test.ts src/__tests__/tui/inline-v2/tool-block-line.test.tsx src/__tests__/locale/resource-shape.test.ts`

Expected: PASS; the test proves cancellation has a localized, non-error UI representation and a total ordering rank.

- [ ] **Step 4: Commit the vocabulary task**

```bash
git add src/tui/transcript-types.ts src/tui/state/transcript-reducer.ts src/tui/inline-v2/ToolBlockLine.tsx src/locale/resources/en-US.ts src/locale/resources/zh-CN.ts src/__tests__/tui/transcript-reducer.test.ts src/__tests__/tui/inline-v2/tool-block-line.test.tsx
git commit -m "feat: add cancelled tool presentation"
```

### Task 2: Terminalize buffered tools and suppress their late UI results

**Files:**
- Modify: `src/ui/block-pipeline.ts:84-122,225-300,396-415`
- Modify: `src/__tests__/ui/block-pipeline.test.ts:24-122,220-330`
- Modify: `src/__tests__/tui/pipeline-integration.test.ts:1-220`

**Interfaces:**
- Consumes: Task 1 `ToolPresentationStatus='cancelled'`, existing `PipelineRenderer.finishToolCall` boolean result, `toolBuffer` call metadata, and translator.
- Produces: `cancelPendingTools(toolUseIds: ReadonlySet<string>): void`; private `cancelledToolUseIds: Set<string>` consumed by a matching late result and cleared only by `clear()`.

- [ ] **Step 1: Write failing routing tests for cancellation, idempotence, late results, and reset**

Extend `RecordingRenderer` so `finishToolCall` can return `false`. Add these cases:

```ts
pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'child-1' });
pipeline.cancelPendingTools(new Set(['child-1']));
expect(recorder.of('finishToolCall')).toMatchObject([
  { toolUseId: 'child-1', presentation: { status: 'cancelled' } },
]);

pipeline.cancelPendingTools(new Set(['child-1']));
expect(recorder.of('finishToolCall')).toHaveLength(1);
pipeline.emit({ kind: 'tool_result', name: 'spawn_agent', output: 'late', toolUseId: 'child-1' });
expect(recorder.of('startToolCall')).toHaveLength(1);
expect(recorder.of('finishToolCall')).toHaveLength(1);
```

Also assert: an ID absent from `toolBuffer`, an already normally resolved ID, and a renderer `false` result create neither cancelled presentation nor tombstone; an unknown non-cancelled result still adds the existing orphan `startToolCall` plus `finishToolCall`. After `clearTurnState()`, emit a late result for the cancelled ID and assert it is still suppressed with no orphan calls. In a fresh setup, call `clear()` and then emit that same ID; assert the tombstone has been reset and the existing orphan path runs.

In `pipeline-integration.test.ts`, add the real reducer/store contract before implementation:

```ts
pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: {}, toolUseId: 'spawn-1' });
pipeline.cancelPendingTools(new Set(['spawn-1']));
pipeline.emit({ kind: 'assistant_text', text: 'Current status: Partially completed', isFinal: true });

expect(selectCommittedTranscript(store.getState().model.items).map(item => item.kind))
  .toEqual(['tool', 'assistant']);
expect(store.getState().model.items[0]).toMatchObject({
  kind: 'tool', presentations: [{ toolUseId: 'spawn-1', status: 'cancelled' }],
});
```

Also assert that no `tool_result` is emitted, an unlisted pending ID remains pending, and an already resolved tool preserves its original `success` or `error` presentation.

Run: `npx vitest run src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/pipeline-integration.test.ts`

Expected: FAIL because `cancelPendingTools` and tombstone handling do not exist.

- [ ] **Step 2: Implement the minimal cancellation/tombstone state machine**

Add only these private fields and method behavior to `BlockPipeline`:

```ts
private cancelledToolUseIds = new Set<string>();

cancelPendingTools(toolUseIds: ReadonlySet<string>): void {
  for (const toolUseId of toolUseIds) {
    const index = this.toolBuffer.findIndex(item => item.toolUseId === toolUseId && !item.resolved);
    if (index < 0) continue;
    const item = this.toolBuffer[index]!;
    const presentation: ToolPresentation = {
      toolUseId, toolName: item.name,
      summary: this.translator.t('toolPresentation.status.cancelled', { subject: item.name }),
      details: [], status: 'cancelled',
    };
    if (!this.renderer.finishToolCall(toolUseId, presentation)) continue;
    this.toolBuffer.splice(index, 1);
    this.cancelledToolUseIds.add(toolUseId);
  }
}
```

At the start of the explicit-ID `tool_result` branch, consume a matching tombstone and return without invoking orphan fallback:

```ts
if (block.toolUseId && this.cancelledToolUseIds.delete(block.toolUseId)) break;
```

Clear `cancelledToolUseIds` only in `clear()`, beside its full message/pipeline reset. Do not clear it in `clearTurnState()`: that method is called by `commitNewTurn` for each ordinary user turn and must leave a pending late-result suppression window intact. Do not alter the existing unknown-result fallback or provider/event semantics.

- [ ] **Step 3: Run the focused pipeline suite**

Run: `npx vitest run src/__tests__/ui/block-pipeline.test.ts src/__tests__/ui/block-pipeline-locale.test.ts src/__tests__/tui/pipeline-integration.test.ts`

Expected: PASS; it proves only successfully terminalized calls become tombstones, each tombstone consumes one late result, `clearTurnState()` preserves the suppression window, and only `clear()` restores normal orphan behavior.

- [ ] **Step 4: Commit the pipeline lifecycle task**

```bash
git add src/ui/block-pipeline.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/pipeline-integration.test.ts
git commit -m "feat: settle cancelled pending tools in UI"
```

### Task 3: Wire parent abort before final feedback and prove it in ConPTY

**Files:**
- Modify: `src/index.ts:866-899,948-978` (event-bus active IDs and turn `finally` finalization)
- Modify: `scripts/tty-verify/verify-esc-subagent.cjs:88-132`

**Interfaces:**
- Consumes: Task 2 `pipeline.cancelPendingTools(activeToolIds)`, existing `activeToolIds` lifecycle (`onToolCall` adds; `onToolResult` deletes), and the existing mock provider call/connection observations in the ConPTY harness.
- Produces: when `aborted === true`, every current active buffered call is UI-terminalized before `commitFinalizedTurn` emits the existing final feedback.

- [ ] **Step 1: Make the ConPTY acceptance assertion fail before wiring index.ts**

In the existing normal child-running branch, add the new visible requirement while retaining all current provider and connection checks:

```js
if (!visible.includes('cancelled')) throw new Error('missing cancelled tool state');
if (!visible.includes('Current status: Partially completed')) {
  throw new Error('missing incomplete user-facing status');
}
```

Do not add a requirement for `Subagent incomplete: user_abort`.

Run: `node scripts/tty-verify/verify-esc-subagent.cjs`

Expected: non-zero exit before the index wiring, because Task 2 makes the UI transition available but no parent-abort path invokes it.

- [ ] **Step 2: Make the minimal parent finalization wiring change**

Immediately before `finalizeTurnForUser` / `commitFinalizedTurn` in the existing turn `finally`, add the UI-only call guarded by the already computed parent state:

```ts
if (aborted) {
  pipeline.cancelPendingTools(activeToolIds);
}
```

Keep it after `aborted` has been set by either the normal-return signal check or catch path, and before `commitFinalizedTurn` emits `assistant_text`. Do not add waits, tool facts, provider branches, or subagent result synthesis.


- [ ] **Step 3: Run the real ConPTY acceptance path**

Run: `node scripts/tty-verify/verify-esc-subagent.cjs`

Expected: exit `0`; child provider is observed before ESC, TUI contains a cancelled tool and `Current status: Partially completed`, contains neither API error nor Failed, provider calls do not increase after ESC, both connections close, and the prompt returns without a spinner.

- [ ] **Step 4: Run bounded failure and scoped verification, then commit**

Run:

```bash
npx vitest run src/__tests__/ui/block-pipeline.test.ts src/__tests__/ui/block-pipeline-locale.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/tui/transcript-reducer.test.ts src/__tests__/tui/inline-v2/tool-block-line.test.tsx src/__tests__/turn-final-feedback.test.ts
node scripts/tty-verify/verify-esc-subagent.cjs --skip-child
npx.cmd tsc --noEmit --pretty false
npm run build
git diff --check
```

Expected: selected tests, typecheck, build, and diff check all pass. `--skip-child` exits non-zero within its existing timeout. The normal ConPTY run from Step 3 remains the positive user-level acceptance proof.

```bash
git add src/index.ts scripts/tty-verify/verify-esc-subagent.cjs
git commit -m "fix: finalize pending tools on parent abort"
```

## Plan self-review

- Spec coverage: Task 1 covers the `cancelled` type, localization, ordering, and rendering; Task 2 covers successful-only finalization, idempotence, late-result suppression, non-cancelled orphan behavior, `clearTurnState()` persistence, true `clear()` reset, and committed-transcript continuity; Task 3 covers current-turn ID scope, ordering before final feedback, and every required ConPTY observation.
- Interface consistency: Task 2 defines `cancelPendingTools(ReadonlySet<string>)`; Task 3 is its only production caller. The tombstone set is private to `BlockPipeline` and is never referenced by provider, executor, or reducer code.
- Scope: no task changes provider, subagent, tool executor, or `selectCommittedTranscript`.
- Completeness: all test cases named in the approved spec have an explicit RED command, Green command, or final ConPTY assertion; every code path has a deterministic terminal behavior.
