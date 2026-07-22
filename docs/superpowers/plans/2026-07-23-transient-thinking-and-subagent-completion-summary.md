# Transient Thinking and Subagent Completion Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将模型 thinking 渲染为一条固定高度、闪烁且可消失的活动消息，完成后留下可展开的永久 Thought 摘要；同时把已完成子代理收敛成一条可读状态行，并保留完整结果供主 Agent 和 Ctrl+O 使用。

**Architecture:** 复用现有 `MessagesStore` streaming-thinking API、`ExpandableBlockStore` 和 pending tool 共享时钟。`BlockPipeline` 负责 `awaitingContent → visible → idle` 状态机，`turn-lifecycle` 负责跨正常、乱序、中断路径的幂等结束；`spawn_agent` 的专用完成展示只改变 UI presentation，不改变模型收到的 tool result。

**Tech Stack:** TypeScript ES2022、Node.js >= 18、React/Ink、Zustand、Vitest、ink-testing-library。

## Global Constraints

- 只按本计划实施；不得恢复 `SubagentProgressBridge`、`subagent_tool_progress` 或子代理内部工具明细。
- 严格执行 RED → GREEN → REFACTOR；每个生产改动前先观察对应测试因正确原因失败。
- thinking 只有收到首个 `content.trim().length > 0` 的 delta 后才可见。
- 任意时刻最多一条 `thinking-progress`；它固定一物理行且不进入 `<Static>`。
- thinking 完成顺序固定为 `registerExpandable → eraseThinkingProgress → appendSummary → clearBuffer`。
- 正常 Anthropic 顺序下 `thinking_end` 先于 `tool_call`；乱序兼容路径必须先幂等结束 thinking，再创建工具行。
- `Thought` 首字母大写；duration 如实显示、至少 1s，不设上限；本次保持 `filesRead=0`。
- 完成子代理在消息区只留一行；完整 `SubagentResult` 仍原样返回主 Agent，并注册为最近的 expandable block。
- `description` 是可选字段；既有 `role/prompt/fork` 调用保持兼容。
- 中文、emoji、组合字符和 `cols < 30` 不能导致损坏截断或活动区高度漂移。
- 保留用户已有的 `package-lock.json` 修改和无关未跟踪文件，不纳入任何提交。

---

## Wheel Reuse Check

- 闪烁：复用 `src/tui/inline-v2/pending-tool-indicator.ts` 的 600ms 纯函数和共享 `SpinnerStore`。
- thinking store：复用 `startStreamingThinking()`、`removeStreamingThinking()` 和 `PipelineToStoreAdapter.appendStreamingThinking()`。
- 完整内容：复用 `BlockPipeline.thinkingBuffer` 与 `ExpandableBlockStore`。
- 工具配对：复用 `BufferedTool`、`startToolCall()`、`finishToolCall()` 和 `toolUseId` 原位更新。
- duration：复用 `ToolResultEvent.duration`，只补齐到 UI block 的传播。
- 通用降级：复用现有 `MessageFormatter.formatToolResult()` 四行预览路径。

## Core Anchor Functions

- `BlockPipeline.emit()`：thinking 输入事件到临时/永久消息的核心转换点。
- `finishTurnThinking()`：所有正常、工具乱序、loop-end 和 finally 路径共享的幂等结束函数。
- `buildSubagentCompletionPresentation()`：输入 tool input/output/duration，输出专用单行 presentation 或 `null`；`null` 强制走现有通用工具结果。

## File Map

- Create: `src/tui/inline-v2/PendingThinkingMessage.tsx`
- Create: `src/ui/subagent-presentation.ts`
- Create: `src/__tests__/ui/subagent-presentation.test.ts`
- Modify: `src/tui/inline-v2/pending-tool-indicator.ts`
- Modify: `src/tui/inline-v2/PendingToolMessage.tsx`
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`
- Modify: `src/tui/inline-v2/MessageLine.tsx`
- Modify: `src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts`
- Modify: `src/tui/state/messages-store.ts`
- Modify: `src/tui/state/pipeline-adapter.ts`
- Modify: `src/tui/turn-lifecycle.ts`
- Modify: `src/tui/types.ts`
- Modify: `src/ui/block-pipeline.ts`
- Modify: `src/ui/block-format.ts`
- Modify: `src/ui/types.ts`
- Modify: `src/index.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts`
- Modify: `src/__tests__/ui/thinking-stream.test.ts`
- Modify: `src/__tests__/ui/block-pipeline.test.ts`
- Modify: `src/__tests__/tui/messages-store.test.ts`
- Modify: `src/__tests__/tui/turn-lifecycle.test.ts`
- Modify: `src/__tests__/tui/pipeline-integration.test.ts`
- Modify: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`
- Modify: `src/__tests__/role-agents.test.ts`
- Modify: `logs/subagent-visibility-and-plan-isolation.md`

---

### Task 1: Add the Fixed-Height Transient Thinking Row

**Files:**
- Modify: `src/tui/types.ts`
- Modify: `src/tui/state/messages-store.ts`
- Modify: `src/tui/inline-v2/pending-tool-indicator.ts`
- Modify: `src/tui/inline-v2/PendingToolMessage.tsx`
- Create: `src/tui/inline-v2/PendingThinkingMessage.tsx`
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`
- Modify: `src/__tests__/tui/messages-store.test.ts`
- Modify: `src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts`
- Modify: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`

**Interfaces:**
- Produces: `TuiMessage.kind === 'thinking-progress'` for one non-finalized activity row.
- Produces: `isPendingGlyphVisible(timeMs, intervalMs?)` while retaining `isPendingToolGlyphVisible` compatibility.
- Produces: `PendingThinkingMessage({ cols, spinnerStore })`. It intentionally has no unused `msg` prop: the row text is fixed, and speculative interface symmetry is not a requirement.
- Preserves: existing pending tool rendering and finalized message behavior.

- [ ] **Step 1: Write failing store tests for dedicated thinking progress**

Add to `messages-store.test.ts`:

```ts
it('thinking progress is unique and removed by kind without touching pending tools', () => {
  const store = createMessagesStore();
  store.getState().appendPendingTool('tool-1', [LINE('● spawn_agent')]);
  store.getState().startStreamingThinking('Thinking…');
  store.getState().startStreamingThinking('Thinking…');

  expect(store.getState().messages.filter(m => m.kind === 'thinking-progress')).toHaveLength(1);
  expect(store.getState().removeStreamingThinking()).toBe(true);
  expect(store.getState().messages.some(m => m.kind === 'thinking-progress')).toBe(false);
  expect(store.getState().messages.some(m => m.toolUseId === 'tool-1')).toBe(true);
  expect(store.getState().removeStreamingThinking()).toBe(false);
});
```

- [ ] **Step 2: Run the store test and observe RED**

```powershell
npx.cmd vitest run src/__tests__/tui/messages-store.test.ts -t "thinking progress is unique"
```

Expected: FAIL because thinking messages have no `thinking-progress` kind, duplicates are allowed, and removal returns `void`.

- [ ] **Step 3: Add the dedicated message kind and idempotent store operations**

Extend `TuiMessage.kind`:

```ts
kind?: 'turn-duration' | 'tool-progress' | 'thinking-progress';
```

Change the store interface and implementation:

```ts
startStreamingThinking: (initialText: string) => string;
removeStreamingThinking: () => boolean;

startStreamingThinking: (initialText) => {
  let uuid = '';
  set((s) => {
    const existing = s.messages.find(message =>
      message.kind === 'thinking-progress' && !message.finalized,
    );
    if (existing) {
      uuid = existing.uuid;
      return s;
    }
    const id = s._idCounter + 1;
    uuid = `msg-${id}`;
    return {
      _idCounter: id,
      messages: [...s.messages, {
        uuid,
        role: 'thinking',
        kind: 'thinking-progress',
        lines: [],
        finalized: false,
        streamingText: initialText,
      }],
    };
  });
  return uuid;
},

removeStreamingThinking: () => {
  let removed = false;
  set((s) => {
    const index = s.messages.findIndex(message =>
      message.kind === 'thinking-progress' && !message.finalized,
    );
    if (index < 0) return s;
    removed = true;
    return { messages: [...s.messages.slice(0, index), ...s.messages.slice(index + 1)] };
  });
  return removed;
},
```

Keep the UUID return intentionally for stable message identity and parity with pending-tool insertion, even though the first consumer removes the singleton by `kind` rather than UUID.

Do not use “last unfinalized message” as the deletion criterion.

- [ ] **Step 4: Generalize the existing blink helper without breaking imports**

Add a generic export and compatibility alias:

```ts
export function isPendingGlyphVisible(
  timeMs: number,
  intervalMs = PENDING_TOOL_BLINK_INTERVAL_MS,
): boolean {
  const safeTime = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
  return Math.floor(safeTime / intervalMs) % 2 === 0;
}

export const isPendingToolGlyphVisible = isPendingGlyphVisible;
```

Update `PendingToolMessage` to import `isPendingGlyphVisible`; retain the alias for external compatibility tests.

- [ ] **Step 5: Write failing Ink tests for blinking Thinking and stable layout**

Render the leaf component directly at `cols=24`; it deliberately does not consume a message object:

```tsx
it('renders one blinking Thinking row with a fixed glyph slot', () => {
  const stores = createStores();
  stores.spinnerStore.getState().start('thinking');
  const { lastFrame } = render(
    <PendingThinkingMessage cols={24} spinnerStore={stores.spinnerStore} />,
  );
  const visible = lastFrame() ?? '';
  expect(visible.replace(/\n+$/, '').split('\n')).toHaveLength(1);
  expect(visible).toContain('● Thinking…');

  for (let i = 0; i < 12; i++) stores.spinnerStore.getState().tick();
  const hidden = lastFrame() ?? '';
  expect(hidden).toContain('  Thinking…');
  expect(hidden.replace(/\n+$/, '').split('\n')).toHaveLength(1);
});
```

Also render `InlineAppV2` with one thinking-progress plus four tool-progress messages at `cols=28`; assert six activity rows at most (1 thinking + 4 tools + spinner), no wrapped `Thinking…`, and unchanged body columns across a tick.

- [ ] **Step 6: Run the Ink tests and observe RED**

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx -t "Thinking|thinking progress"
```

Expected: FAIL because the component and dedicated Inline V2 branch do not exist.

- [ ] **Step 7: Implement `PendingThinkingMessage` and wire Inline V2**

Create the leaf component:

```tsx
export const PendingThinkingMessage = React.memo(function PendingThinkingMessage({
  cols, spinnerStore,
}: PendingThinkingMessageProps): React.ReactElement {
  const time = useStore(spinnerStore, state => state.time);
  const active = useStore(spinnerStore, state => state.active);
  const visible = !active || isPendingGlyphVisible(time);
  return (
    <Box height={1} width={cols} flexDirection="row">
      <Box width={2} minWidth={2} height={1}>
        <Text>{visible ? '●' : ' '}</Text>
      </Box>
      <Text wrap="truncate-end">Thinking…</Text>
    </Box>
  );
});
```

In `InlineAppV2`:

```ts
const pendingThinking = messages.find(message =>
  !message.finalized && message.kind === 'thinking-progress',
);
const thinkingRowCount = pendingThinking ? 1 : 0;
const inputRowY = streamingRowCount + thinkingRowCount
  + pendingToolsRowCount + spinnerRowCount + 1;
```

Restrict the existing `streaming` selector to `role === 'assistant'`; render `PendingThinkingMessage` immediately before pending tools. Do not pass thinking through `StreamingText`.

- [ ] **Step 8: Run GREEN and commit**

```powershell
npx.cmd vitest run src/__tests__/tui/messages-store.test.ts src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git add src/tui/types.ts src/tui/state/messages-store.ts src/tui/inline-v2/pending-tool-indicator.ts src/tui/inline-v2/PendingToolMessage.tsx src/tui/inline-v2/PendingThinkingMessage.tsx src/tui/inline-v2/InlineAppV2.tsx src/__tests__/tui/messages-store.test.ts src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git commit -m "fix(tui): render transient thinking status"
```

Expected: all listed tests pass; no finalized Thinking behavior changes yet.

---

### Task 2: Implement the Thinking State Machine and Unified Cleanup

**Files:**
- Modify: `src/ui/block-pipeline.ts`
- Modify: `src/ui/block-format.ts`
- Modify: `src/tui/turn-lifecycle.ts`
- Modify: `src/index.ts`
- Modify: `src/__tests__/ui/thinking-stream.test.ts`
- Modify: `src/__tests__/ui/block-pipeline.test.ts`
- Modify: `src/__tests__/tui/turn-lifecycle.test.ts`
- Modify: `src/__tests__/tui/pipeline-integration.test.ts`

**Interfaces:**
- Produces: internal `ThinkingPhase = 'idle' | 'awaitingContent' | 'visible'` in `BlockPipeline`.
- Produces: `startTurnThinking(state, nowMs)` and `finishTurnThinking(lifecycle, state)`.
- Preserves: hidden reasoning, most-recent Ctrl+O semantics, and `filesRead=0`.

- [ ] **Step 1: Replace old pipeline expectations with failing lifecycle tests**

Test these exact sequences:

```ts
pipeline.emit({ kind: 'thinking_start' });
expect(renderer.calls).not.toContainEqual(expect.stringContaining('Thinking…'));

pipeline.emit({ kind: 'thinking_delta', content: '   \n' });
expect(renderer.calls).not.toContainEqual(expect.stringContaining('appendStreamingThinking'));

pipeline.emit({ kind: 'thinking_delta', content: '真实内容' });
expect(renderer.calls.filter(c => c.startsWith('appendStreamingThinking'))).toHaveLength(1);

pipeline.emit({ kind: 'thinking_end', durationSec: 2, filesRead: 0 });
expect(renderer.calls.indexOf('eraseStreamingThinking')).toBeGreaterThan(
  renderer.calls.findIndex(c => c.startsWith('registerExpandable')),
);
expect(renderer.calls.some(c => c.includes('Thought for 2s'))).toBe(true);
```

Because the real mock cannot see `ExpandableBlockStore.add()`, expose order through a test-only ordered renderer callback or spy on `pipeline.getLastExpandableFullLines()` immediately before `eraseStreamingThinking()` via a renderer callback. Do not add a production debug API.

Add separate tests for:

- no-start non-empty delta creates one visible phase;
- pure whitespace block produces neither temporary row nor summary;
- duplicate start remains idempotent in both `awaitingContent` and `visible`, and duplicate end remains idempotent;
- `formatThinkingSummary(0, 0)` still renders `Thought for 1s`; this protects the formatter's existing `Math.max(1, Math.round(sec))` minimum from regression;
- the first non-empty delta calls `openModelBlock()` exactly once before the temporary row, while later deltas add no extra separator;
- after a visible phase, `clear()` resets phase and buffer so a later `thinking_end` creates neither a summary nor expandable content;
- `clearTurnState()` erases a visible temporary row, resets phase and buffer, and preserves already-finalized messages;
- two thinking blocks leave two permanent summaries while Ctrl+O returns only the second full content.

- [ ] **Step 2: Run RED**

```powershell
npx.cmd vitest run src/__tests__/ui/thinking-stream.test.ts src/__tests__/ui/block-pipeline.test.ts
```

Expected: old static `● Thinking…` assertions fail and new transient lifecycle assertions fail.

- [ ] **Step 3: Implement the pipeline state machine**

Replace `thinkingActive` with:

```ts
type ThinkingPhase = 'idle' | 'awaitingContent' | 'visible';
private thinkingPhase: ThinkingPhase = 'idle';
```

Implement event branches with this behavior:

```ts
case 'thinking_start':
  if (this.thinkingPhase === 'idle') {
    this.thinkingPhase = 'awaitingContent';
    this.thinkingBuffer = '';
  }
  break;

case 'thinking_delta': {
  if (this.thinkingPhase === 'idle') this.thinkingPhase = 'awaitingContent';
  this.thinkingBuffer += block.content;
  if (this.thinkingPhase === 'awaitingContent' && this.thinkingBuffer.trim().length > 0) {
    this.openModelBlock();
    this.renderer.appendStreamingThinking('Thinking…');
    this.thinkingPhase = 'visible';
  }
  break;
}
```

For `thinking_end`, first build and add full content, then erase, append summary, and clear. Use `thinkingPhase === 'visible'` as the summary predicate. Empty `awaitingContent` only resets state.

`openModelBlock()` is required here because it inserts the model-block separator before the first visible activity row. Call it only on the single `awaitingContent → visible` transition; never on start or later deltas.

Change `formatThinkingSummary()` to start with uppercase `Thought`. Preserve its existing minimum-one-second clamp, update the stale comment that claims zero is possible, keep real elapsed duration with no upper cap, and keep `filesRead=0`.

Add one private reset helper and use it from both `clear()` and `clearTurnState()`:

```ts
private resetThinkingState(eraseVisible: boolean): void {
  if (eraseVisible && this.thinkingPhase === 'visible') {
    this.renderer.eraseStreamingThinking();
  }
  this.thinkingPhase = 'idle';
  this.thinkingBuffer = '';
}
```

`clear()` may rely on `renderer.clearMessages()` for physical removal but must still reset phase and buffer. `clearTurnState()` must erase a visible activity row before resetting because it deliberately preserves existing messages.

- [ ] **Step 4: Write failing turn-lifecycle tests for implicit start and idempotent tool cleanup**

Define tests around a state object rather than `index.ts` internals:

```ts
let state = idleTurnThinking();
state = startTurnThinking(state, 1_000);
state = finishTurnThinking(lifecycle, state);
state = finishTurnThinking(lifecycle, state); // second parallel tool_call
expect(events).toEqual(['thinking_end:2']);
expect(state).toEqual(idleTurnThinking());
```

Add a no-start delta test that calls `startTurnThinking(idle, now)` before emitting the implicit pipeline delta, and a loop-end/finally double-cleanup test that asserts one summary and one spinner completion.

Add a duration-boundary test with `startedAtMs=0` and `now()=1_500`: `finishTurnThinking()` must emit `thinking_end:1`, and the rendered summary must be `Thought for 1s`. This locks the intentional conservative policy: lifecycle conversion floors elapsed milliseconds to whole seconds so displayed time never exceeds measured elapsed time; the formatter's `Math.round` then receives an integer and only supplies the minimum-one-second defense.

Add an integration-order assertion for the adapter edge case: with thinking still active, the first of two parallel `tool_call` events emits exactly one `thinking_end` before that tool call is created; the second tool call observes idle state and emits no second cleanup. Reuse the same cleanup entry point used by ESC, abort, error, and loop-end rather than duplicating logic in the tool-call branch.

- [ ] **Step 5: Run the lifecycle tests and observe RED**

```powershell
npx.cmd vitest run src/__tests__/tui/turn-lifecycle.test.ts src/__tests__/tui/pipeline-integration.test.ts
```

Expected: FAIL because the reusable state helpers do not exist and current state includes duplicated content fields.

- [ ] **Step 6: Implement shared turn-level thinking helpers**

Use an immutable state shape:

```ts
export interface TurnThinkingState {
  active: boolean;
  startedAtMs: number;
}

export function idleTurnThinking(): TurnThinkingState {
  return { active: false, startedAtMs: 0 };
}

export function startTurnThinking(
  state: TurnThinkingState,
  nowMs: number,
): TurnThinkingState {
  return state.active ? state : { active: true, startedAtMs: nowMs };
}

export function finishTurnThinking(
  lifecycle: TurnLifecycle,
  state: TurnThinkingState,
): TurnThinkingState {
  if (!state.active) return state;
  const elapsed = Math.max(0, lifecycle.now() - state.startedAtMs);
  lifecycle.emitThinkingEnd(Math.floor(elapsed / 1000));
  return idleTurnThinking();
}
```

Make `finalizeTurnLifecycle()` call `finishTurnThinking()` and then stop the spinner. Keep `handleTurnLoopEnd()` responsible for clearing tool IDs.

Keep the two-stage duration policy explicit: `finishTurnThinking()` uses `Math.floor(elapsedMs / 1000)` to avoid overstating elapsed time, while `formatThinkingSummary()` retains `Math.round(sec)` for its standalone numeric input contract and the `Math.max(1, ...)` display minimum. Because the lifecycle supplies whole seconds, these operations do not conflict.

- [ ] **Step 7: Route every index.ts exit through the shared helper**

Replace primitive `thinkingActive/thinkingContent/thinkingStart` bookkeeping with one `TurnThinkingState` variable.

Required routing:

```ts
// explicit start
thinking = startTurnThinking(thinking, Date.now());
pipeline.emit({ kind: 'thinking_start' });

// delta without start
if (!thinking.active) {
  thinking = startTurnThinking(thinking, Date.now());
  pipeline.emit({ kind: 'thinking_start' });
}
pipeline.emit({ kind: 'thinking_delta', content: delta.content });

// content_block_stop, first tool_call, first assistant text, loop_end, finally
thinking = finishTurnThinking(turnLifecycle, thinking);
```

In `onToolCall`, invoke `finishTurnThinking()` before `pipeline.emit({ kind: 'tool_call' })`. Multiple parallel calls naturally become one real cleanup followed by idempotent no-ops. Do not duplicate elapsed-time code in callbacks.

- [ ] **Step 8: Run GREEN and commit**

```powershell
npx.cmd vitest run src/__tests__/ui/thinking-stream.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/turn-lifecycle.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/streaming-query.test.ts
git add src/ui/block-pipeline.ts src/ui/block-format.ts src/tui/turn-lifecycle.ts src/index.ts src/__tests__/ui/thinking-stream.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/turn-lifecycle.test.ts src/__tests__/tui/pipeline-integration.test.ts
git commit -m "fix(tui): finalize thinking phases cleanly"
```

Expected: tests pass; searches find no permanent `thinking_header` creation and no duplicated inline duration calculation outside the shared helper.

---

### Task 3: Replace Completed Subagent Output with One Stable Summary Line

**Files:**
- Create: `src/ui/subagent-presentation.ts`
- Create: `src/__tests__/ui/subagent-presentation.test.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts`
- Modify: `src/ui/types.ts`
- Modify: `src/ui/block-format.ts`
- Modify: `src/ui/block-pipeline.ts`
- Modify: `src/tui/types.ts`
- Modify: `src/tui/state/messages-store.ts`
- Modify: `src/tui/state/pipeline-adapter.ts`
- Modify: `src/tui/inline-v2/MessageLine.tsx`
- Modify: `src/index.ts`
- Modify: `src/__tests__/role-agents.test.ts`
- Modify: `src/__tests__/ui/block-pipeline.test.ts`
- Modify: `src/__tests__/tui/pipeline-integration.test.ts`
- Modify: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`

**Interfaces:**
- Produces: optional `spawn_agent.description` schema property.
- Produces: `buildSubagentCompletionPresentation(input, output, durationMs): SubagentCompletionPresentation | null`.
- Produces: finalized `TuiMessage.kind === 'agent-completion'` rendered at exactly one row.
- Preserves: exact tool output delivered to the model and generic fallback for malformed output.

- [ ] **Step 1: Write failing pure presentation tests**

Create tests for status parsing, label priority and fallback:

```ts
expect(buildSubagentCompletionPresentation(
  { description: '查找 AgentTool 实现', prompt: 'long prompt' },
  '[Subagent status=completed]\n完整结果',
  147_000,
)).toEqual({
  line: '● Agent "查找 AgentTool 实现" finished · 2m 27s',
  fullOutput: '完整结果',
});

expect(buildSubagentCompletionPresentation(
  { prompt: '\n!!!\n{"task":"x"}' },
  '[Subagent status=incomplete reason=max_turns]\npartial',
  2_000,
)?.line).toBe('● Agent "Agent" incomplete · 2s');

expect(buildSubagentCompletionPresentation(
  { prompt: '正常任务' }, 'malformed output', 1_000,
)).toBeNull();
```

Also cover `unverified`, negative/NaN duration, Chinese, an explicit emoji-bearing description such as `🔎 查找实现`, and combining characters. Pure helpers must not truncate by UTF-8 byte or JavaScript code unit; visual truncation belongs to Ink.

- [ ] **Step 2: Run RED**

```powershell
npx.cmd vitest run src/__tests__/ui/subagent-presentation.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure parser and formatter**

Use the structured envelope already produced by `formatSubagentResult()`:

```ts
const ENVELOPE = /^\[Subagent status=(completed|incomplete|unverified)(?: reason=[^\]]+)?\]\r?\n([\s\S]*)$/;
const HAS_UNICODE_WORD = /[\p{L}\p{N}]/u;

function meaningfulLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('{') || line.startsWith('[')) continue;
    if (HAS_UNICODE_WORD.test(line)) return line;
  }
  return null;
}
```

Label priority is description → prompt → `Agent`. Status words are exactly `finished/incomplete/unverified`. Duration formatter clamps invalid or negative input to 0 and displays at least `1s`.

Return regex capture group 2 as `fullOutput`: Ctrl+O shows only the child result body, without the structural `[Subagent status=...]` envelope. This presentation cleanup must not mutate the original tool output forwarded to the main Agent.

- [ ] **Step 4: Add and test the optional schema field**

In `spawn-agent-tool.ts` add:

```ts
description: {
  type: 'string',
  description: 'Short user-facing label for this delegated task.',
},
```

Keep `required: ['role', 'prompt']`. Add a `role-agents.test.ts` assertion that `description` is present in `properties`, absent from `required`, and that existing calls without it still execute. The schema has no `additionalProperties: false`; document that adding the explicit property is nevertheless required so the model knows it is supported.

- [ ] **Step 5: Write failing pipeline tests for replacement and fallback**

Test a normal result:

```ts
pipeline.emit({
  kind: 'tool_call', name: 'spawn_agent', toolUseId: 'a1',
  input: { role: 'explore', description: '查找实现', prompt: '...' },
});
pipeline.emit({
  kind: 'tool_result', name: 'spawn_agent', toolUseId: 'a1', durationMs: 147_000,
  output: '[Subagent status=completed]\nfull child result',
});
```

Assert the finalized message contains only `● Agent "查找实现" finished · 2m 27s`, is `kind='agent-completion'`, and Ctrl+O full lines contain `full child result`.

Test malformed output with the same call and assert it retains the existing call line plus generic raw-output preview, does not contain `Agent "..." finished`, and leaves `pipeline.getLastExpandableFullLines()` as `null`.

Test two concurrent `spawn_agent` calls (`a1`, `a2`) whose results arrive in reverse order. Assert each `toolUseId` is finalized with its own description and duration, with neither summary nor expandable content overwriting the other pending entry.

- [ ] **Step 6: Run RED**

```powershell
npx.cmd vitest run src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/pipeline-integration.test.ts -t "Agent|subagent completion|malformed"
```

Expected: FAIL because duration and completion presentation are not propagated.

- [ ] **Step 7: Propagate duration and specialized finalization metadata**

Before changing the interface, audit every caller:

```powershell
Get-ChildItem -Path src -Recurse -File | Select-String -Pattern '\bresolvePendingTool\b'
```

Expected current result: the store definition/implementation plus a single production caller in `pipeline-adapter.ts`; remaining hits are tests. If another production caller exists by implementation time, explicitly decide whether it needs the new `finalKind` rather than relying on the default silently.

Extend the UI block:

```ts
| {
    kind: 'tool_result'; name: string; input?: Record<string, unknown>;
    output: string; toolUseId?: string; durationMs?: number;
  }
```

Pass `d.duration` from `index.ts`. Extend renderer/store interfaces without changing default calls:

```ts
type FinalToolMessageKind = 'tool-progress' | 'agent-completion';

finishToolCall?(
  toolUseId: string,
  lines: FormattedLine[],
  finalKind?: FinalToolMessageKind,
): boolean;

resolvePendingTool(
  toolUseId: string,
  lines: FormattedLine[],
  finalKind: FinalToolMessageKind = 'tool-progress',
): boolean;
```

When `buildSubagentCompletionPresentation()` succeeds, set final lines to the single Agent line, set final kind to `agent-completion`, and register `presentation.fullOutput` (the envelope-stripped child body) as expandable full lines before finalizing. Keep the original tool output unchanged on the model-facing path. Do not prepend `item.callLines`. When the helper returns `null`, execute the existing generic path unchanged and do not register an expandable block.

- [ ] **Step 8: Guarantee one physical finalized row**

Extend `TuiMessage.kind` with `agent-completion`. In `MessageLine` branch before generic rendering:

```tsx
if (msg.kind === 'agent-completion') {
  const line = msg.lines[0];
  return (
    <Box height={1} width={cols}>
      <Text wrap="truncate-end">{line?.content ?? '● Agent finished'}</Text>
    </Box>
  );
}
```

Add an Ink test at `cols=24` with a long Chinese/emoji label; assert exactly one physical row and no malformed replacement character.

- [ ] **Step 9: Run GREEN and commit**

```powershell
npx.cmd vitest run src/__tests__/ui/subagent-presentation.test.ts src/__tests__/role-agents.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/subagent-result-integrity.test.ts
git add src/ui/subagent-presentation.ts src/agent/tools/spawn-agent-tool.ts src/ui/types.ts src/ui/block-format.ts src/ui/block-pipeline.ts src/tui/types.ts src/tui/state/messages-store.ts src/tui/state/pipeline-adapter.ts src/tui/inline-v2/MessageLine.tsx src/index.ts src/__tests__/ui/subagent-presentation.test.ts src/__tests__/role-agents.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git commit -m "fix(tui): summarize completed subagents"
```

Expected: all listed tests pass; result integrity test proves full output is unchanged for the main Agent.

---

### Task 4: Verify the Complete Terminal Lifecycle

**Files:**
- Modify: `logs/subagent-visibility-and-plan-isolation.md`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: automated and real-terminal evidence; no new production interface.

- [ ] **Step 1: Run the focused regression suite**

```powershell
npx.cmd vitest run src/__tests__/ui/thinking-stream.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/ui/subagent-presentation.test.ts src/__tests__/tui/messages-store.test.ts src/__tests__/tui/turn-lifecycle.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/tui/inline-v2/pending-tool-indicator.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/role-agents.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/streaming-query.test.ts
```

Expected: all focused files pass with zero failed tests.

- [ ] **Step 2: Run static checks**

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: typecheck exits 0. If global lint has a documented baseline failure, run scoped ESLint over every changed source/test file and record both commands and outputs; do not claim global lint success.

- [ ] **Step 3: Run the full suite**

```powershell
npm.cmd test
```

Expected: zero new failures relative to the recorded baseline.

- [ ] **Step 4: Perform the real TTY scenario**

Input:

```text
用子代理告诉我你能看到哪些技能
```

Acceptance sequence:

1. Empty thinking envelope produces no row.
2. First real reasoning content produces one blinking `● Thinking…` row.
3. The row stays one line and the glyph slot does not move.
4. Before `spawn_agent` appears, temporary Thinking disappears and one `Thought for Ns (ctrl+o to expand)` remains.
5. `spawn_agent` runs as one stable blinking row; no child `read_file/run_bash` lines appear.
6. Completion replaces it with one `● Agent "…" finished · Ns` line.
7. A later thinking phase repeats the transient-to-summary lifecycle without overwriting the earlier summary.
8. Ctrl+O opens the most recently registered expandable block; earlier Thought summaries remain visible but are not selectable, matching the documented limitation.
9. Final Agent answer is complete and does not redo explicit delegation.
10. ESC during Thinking and a provider error leave no pending Thinking row.

- [ ] **Step 5: Record evidence and commit**

Append exact RED/GREEN commands, test counts, commit hashes, terminal width, provider, model and observed output to `logs/subagent-visibility-and-plan-isolation.md`.

```powershell
git add logs/subagent-visibility-and-plan-isolation.md
git commit -m "test(tui): verify transient thinking lifecycle"
```

---

## Deferred Work

- `read N files` remains zero because current tool calls occur after thinking_end; cross-stage attribution requires a separate semantic design.
- Ctrl+O remains “most recent expandable only”; historical selection/transcript mode is a separate feature.
- Small-terminal active-task pagination is deferred; hiding live agents would violate current visibility requirements.

## Plan Self-Review

- Spec coverage: transient visibility, non-empty delta gate, uppercase permanent summary, operation order, implicit start, 乱序 tool cleanup, multiple parallel calls, duration truthfulness, optional description, Unicode fallback, malformed-result downgrade, full-result preservation and Ctrl+O limitation each map to an explicit task and test.
- Incomplete-marker scan: clean; every mutation step names exact files, interfaces and code shape.
- Type consistency: `thinking-progress` is introduced in Task 1 before consumption; `agent-completion` and `FinalToolMessageKind` are introduced together in Task 3; duration remains milliseconds end-to-end until formatting.
- Scope: no provider configuration changes, no agent-loop rewrite, no progress bridge restoration, no filesRead guesswork and no expandable history UI.
- Safety: store removals use kind/ID rather than last-message position; malformed subagent envelopes fall back to current behavior; all cleanup entry points share one idempotent helper.
