# Message Presentation v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the five message-presentation noise classes (`Thought for 0s`, routine `[Hook] … done`, generic `Ran N operation(s)`, raw `spawn_agent → cancelled`, four-field outcome template) by promoting the existing `TranscriptModel + transcript-reducer + MessagesStore` into a UI Presentation Model with a derived channel classification and a normal-visibility boundary.

**Architecture:** Single-state-source evolution — no parallel PresentationModel store. A pure derived classifier `presentationChannel(block)` + `isVisibleInNormalMode(block)` introduces a Conversation/Activity/Diagnostics boundary between the reducer and the Ink renderer. `BlockPipeline` / `pipeline-adapter` / raw `Block` are retained; `spawn_agent` reuses the existing `toolBuffer` (no second buffer). `spawn_agent` is promoted from a generic `ToolBlock` to a first-class `AgentBlock`. Thinking uses one commit-boundary threshold (`1000ms`). Outcome `TurnStatus` is a structural fallback decided by a single production helper `shouldEmitTurnStatus(candidate, items)`.

**Tech Stack:** TypeScript (strict), React 19 + Ink 7 (`inline-v2` is the only active render path), Zustand (vanilla `createStore`), Vitest, `@testing-library/react` + `ink-testing-library`, ConPTY TTY verify (`scripts/tty-verify/`). Locale is type-safe: `CanonicalResources = typeof zhCN` (`src/locale/types.ts:14`).

---

## Global Constraints

- The existing `TranscriptModel + transcript-reducer + MessagesStore` is the **only** Presentation Model. No parallel store, no second status source (no `agentBuffer`).
- `BlockPipeline` / `pipeline-adapter` / raw `Block` (`src/ui/types.ts:71-79`) are **retained** in v1. `spawn_agent` reuses the existing `toolBuffer` (`block-pipeline.ts:84-93` `BufferedTool = { toolUseId; name; input; resolved? }`).
- Agent/Session History (`Message[]`, `sessionStore`) and UI Presentation are separate concerns; raw `tool_result` may persist/be model-visible while its UI projection is Activity, not Conversation.
- Routine successful hooks are **suppressed at source** (empty `message`), never entering the Presentation Model. Diagnostics is **not** a raw-event archive.
- v1 implements **no** verbosity API / `/verbose` / `/debug`. The normal-visibility boundary is a single predicate, not a mode enum.
- `TurnStatus` is a **structural fallback only**. The decision funnels through one production helper `shouldEmitTurnStatus(candidate, items)` (`Task 5`); `index.ts` and the `Task 7` test both call it. Dedup is structural (`hasVisibleAbnormalActivity`), never NLP/text similarity.
- `TurnStatus` cancelled candidate comes **only** from `TurnFinalizationInput.aborted`; `classifyTurn` (`UserTurnStatus = '成功' | '部分完成' | '失败'`) is **not** extended.
- `AgentBlock` adds **no** child progress / new events / `SubagentOptions` changes, and does **not** refactor the `SubagentExecutionResult → string → regex` path.
- Tool semantics derive **only** from deterministic tool name + input + structured output. No Bash command-text guessing; no path-shape heuristics (trailing slash / extension) for read_file directory detection — only `path === '.'` is treated as a directory in v1.
- Thinking has exactly **one** user-visible threshold `THINKING_COMMIT_THRESHOLD_MS = 1000`, applied at the final summary commit boundary (grouped = aggregate total; standalone = per-summary duration). Raw `thinking_end` is **never** gated and never drops duration early.
- Assistant substantive text is never auto-deduplicated (no NLP/text similarity).
- `permission` / `plan approval` / `ask question` / `modal-progress` overlays stay separate UI control state; they are not folded into the Presentation Model.
- Do **not** clean up unrelated legacy/dead code.
- All other v1 out-of-scope items from the design spec §14 are honored.

```text
Execution baseline gate:
Before Task 1 changes any production code, run a fresh full baseline in the isolated worktree
(`npm --prefix <worktree> test`). If it fails (beyond the known flaky
`unified-tool-execution-paths.test.ts` ESLint cold-start timeout, which must be confirmed
by an isolated rerun), STOP implementation and use superpowers:systematic-debugging.
Recorded baseline: Full-suite baseline: 1 non-reproduced timeout; isolated rerun
unified-tool-execution-paths.test.ts 14/14 green. No production code had been changed.
```

Locale rule (applies to every task touching locale): **edit `src/locale/resources/zh-CN.ts` first** (it defines `CanonicalResources`), then `src/locale/resources/en-US.ts` with the same shape, or `tsc` fails.

---

## Task dependency order (each task leaves HEAD independently typecheck/review-clean)

```
Task 1 (channel primitives) ─┐
Task 2 (thinking) ───────────┤
Task 3 (hook + filter wire) ◂┘ (needs Task 1)
Task 4 (AgentBlock) ◂────────── needs Task 1 ('agent' channel case)
Task 5 (Outcome fallback) ◂──── needs Task 4 (hasVisibleAbnormalActivity inspects AgentBlock)
Task 6 (Tool semantics) ◂────── independent (spawn_agent already routed in Task 4)
Task 7 (Integrated acceptance) ◂ needs all
```

---

## File Structure

New files:
- `src/tui/state/presentation-channel.ts` — pure derived classifier + normal-visibility predicate.
- `src/tui/inline-v2/AgentBlockLine.tsx` — renders committed `AgentBlock`.
- `src/tui/inline-v2/PendingAgentMessage.tsx` — renders `PendingAgent` activity row.
- `src/__tests__/tui/presentation-channel.test.ts`
- `src/__tests__/tui/inline-v2/agent-block-line.test.tsx`
- `src/__tests__/tui/inline-v2/pending-agent-message.test.tsx`

Modified files (per task; exact ranges in each task):
- `src/tui/transcript-types.ts` — new union variants, `completeActivity` overload, `TRANSCRIPT_KINDS`/`ACTIVITY_KINDS`.
- `src/tui/state/transcript-reducer.ts` — `BoundaryBlock`, thinking threshold, agent reducer actions, `hasVisibleAbnormalActivity`.
- `src/tui/state/messages-store.ts` — agent actions.
- `src/tui/state/pipeline-adapter.ts` — agent adapter methods.
- `src/ui/types.ts` — `turn_status` `Block` kind.
- `src/ui/block-pipeline.ts` — `PipelineRenderer` interface, spawn_agent routing (reuse `toolBuffer`), cancel label, `turn_status` routing.
- `src/ui/tool-presentation.ts` — memory / `read_file` (`path === '.'`) semantic cases.
- `src/ui/subagent-presentation.ts` — export `deriveAgentLabel`.
- `src/tui/inline-v2/InlineAppV2.tsx` — normal-visibility filter, `PendingAgent` activity, input-row math.
- `src/tui/inline-v2/TranscriptBlockLine.tsx` — `agent` / `turn-status` switch cases.
- `src/hooks/builtins.ts` — `postToolLogger` source suppression.
- `src/agent/turn-final-feedback.ts` — remove 4-field emission; add `TurnStatusCandidate` / `buildTurnStatusCandidate` / `shouldEmitTurnStatus`; `commitFinalizedTurn` persist-only.
- `src/index.ts` — build candidate, call `shouldEmitTurnStatus`, emit `turn_status` Block.
- `src/locale/resources/zh-CN.ts`, `src/locale/resources/en-US.ts` — semantic / turn-status keys.

---

## Interfaces (shared, canonical names — do not drift)

```ts
// src/tui/state/presentation-channel.ts
export type PresentationChannel = 'conversation' | 'activity' | 'diagnostics';
export function presentationChannel(block: TranscriptBlock): PresentationChannel;
export function isVisibleInNormalMode(block: TranscriptBlock): boolean;

// src/tui/state/transcript-reducer.ts (thinking)
export const THINKING_COMMIT_THRESHOLD_MS = 1000;
export function shouldCommitThinking(durationMs: number): boolean;

// src/tui/state/transcript-reducer.ts (agent actions)
export interface StartAgentInput { activityId: string; agentUseId: string; label: string; }
export function startAgent(model: TranscriptModel, call: StartAgentInput): TranscriptModel;
export function resolveAgent(model: TranscriptModel, agentUseId: string, block: Omit<AgentBlock, 'id' | 'kind'>): TranscriptModel;
export function cancelAgent(model: TranscriptModel, agentUseId: string, label: string): TranscriptModel;

// src/tui/state/transcript-reducer.ts (outcome query; introduced in Task 5)
export function hasVisibleAbnormalActivity(items: readonly TimelineItem[]): boolean;

// src/agent/turn-final-feedback.ts (Task 5)
export type TurnStatusCandidate = { status: 'partial' | 'failed' | 'cancelled'; line: string };
export function buildTurnStatusCandidate(
  input: TurnFinalizationInput,
  classified: UserTurnStatus,
  translator: Translator,
): TurnStatusCandidate | null;
export function shouldEmitTurnStatus(
  candidate: TurnStatusCandidate | null,
  items: readonly TimelineItem[],
): boolean;
```

> `shouldEmitTurnStatus` is the single production decision seam. `index.ts` calls it at finalize; the `Task 7` test calls the same function with real `TimelineItem[]` fixtures (no duplicated `if` logic in tests).

Types added in their owning tasks (names fixed):
- `AgentBlock { id; kind:'agent'; label; status:'completed'|'partial'|'failed'|'cancelled'|'unknown'; summary?; durationMs? }` (Task 4)
- `PendingAgent { id; kind:'pending-agent'; label }` (Task 4)
- `TurnStatusBlock { id; kind:'turn-status'; status:'partial'|'failed'|'cancelled'; line:string }` (Task 5)

Adapter / renderer methods (Task 4): add `startAgent/finishAgent/cancelAgent` to the `PipelineRenderer` interface (`src/ui/block-pipeline.ts:36-67`); `PipelineToStoreAdapter` implements them; `messages-store` exposes `startAgent/resolveAgent/cancelAgent`. TurnStatus (Task 5) flows through the **existing** `appendTranscriptBlock` (`TurnStatusBlock` is automatically a `BoundaryBlock` since `BoundaryBlock = Exclude<TranscriptBlock, ToolBlock | AgentBlock>`).

---

## Task 1: Presentation channel / visibility primitives

Establish the pure derived presentation layer over the **current** union only. No new block kinds, no production render behavior change yet.

**Files:**
- Create: `src/tui/state/presentation-channel.ts`
- Test: `src/__tests__/tui/presentation-channel.test.ts`

**Interfaces:**
- Consumes: `TranscriptBlock` (existing variants only), esp. `SystemBlock` (`subkind` + `tone`, `transcript-types.ts:83-100`).
- Produces: `PresentationChannel`, `presentationChannel(block)`, `isVisibleInNormalMode(block)`.

- [ ] **Step 1: Write the failing test**

`src/__tests__/tui/presentation-channel.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { presentationChannel, isVisibleInNormalMode } from '../../tui/state/presentation-channel.js';
import type { TranscriptBlock } from '../../tui/transcript-types.js';

const user = (id = 'u'): TranscriptBlock => ({ id, kind: 'user', text: 'hi' });
const tool = (id = 't'): TranscriptBlock => ({ id, kind: 'tool', toolName: 'read_file', presentations: [], thinking: [] });
const thinkingSummary = (id = 'ts'): TranscriptBlock => ({ id, kind: 'system', subkind: 'thinking-summary', text: 'Thought for 2s', durationMs: 2000, groupBoundary: 'transparent' });
const hookOk = (id = 'h'): TranscriptBlock => ({ id, kind: 'system', subkind: 'notification', text: '[Hook] x done', groupBoundary: 'break' });
const hookErr = (id = 'he'): TranscriptBlock => ({ id, kind: 'system', subkind: 'notification', text: 'blocked', groupBoundary: 'break', tone: 'error' });

describe('presentationChannel', () => {
  it('classifies conversation vs activity vs diagnostics', () => {
    expect(presentationChannel(user())).toBe('conversation');
    expect(presentationChannel(tool())).toBe('activity');
    expect(presentationChannel(thinkingSummary())).toBe('activity');
    expect(presentationChannel(hookOk())).toBe('diagnostics');
    expect(presentationChannel(hookErr())).toBe('activity');
  });
});

describe('isVisibleInNormalMode', () => {
  it('hides only non-error diagnostics', () => {
    expect(isVisibleInNormalMode(user())).toBe(true);
    expect(isVisibleInNormalMode(tool())).toBe(true);
    expect(isVisibleInNormalMode(hookErr())).toBe(true);
    expect(isVisibleInNormalMode(hookOk())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/presentation-channel.test.ts`
Expected: FAIL — `Cannot find module '../../tui/state/presentation-channel.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/tui/state/presentation-channel.ts`:
```ts
import type { TranscriptBlock } from '../transcript-types.js';

export type PresentationChannel = 'conversation' | 'activity' | 'diagnostics';

export function presentationChannel(block: TranscriptBlock): PresentationChannel {
  switch (block.kind) {
    case 'user':
    case 'assistant':
      return 'conversation';
    case 'tool':
    case 'ask':
    case 'turn-duration':
      return 'activity';
    case 'system':
      return block.subkind === 'notification' && block.tone !== 'error' ? 'diagnostics' : 'activity';
  }
}

export function isVisibleInNormalMode(block: TranscriptBlock): boolean {
  return presentationChannel(block) !== 'diagnostics';
}
```

> The switch is exhaustive over the **current** union. Task 4 adds the `'agent'` case; Task 5 adds the `'turn-status'` case (TypeScript forces both at their respective tasks).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/presentation-channel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + regression**

Run: `npm --prefix . run typecheck`
Run: `npx vitest run src/__tests__/tui/transcript-types.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/state/presentation-channel.ts src/__tests__/tui/presentation-channel.test.ts
git diff --check
git commit -m "feat(tui): classify presentation channels"
```

---

## Task 2: Thinking commit semantics (single 1000ms threshold)

Lock the commit-boundary rule. **Do not** gate at raw `thinking_end` (`src/ui/block-pipeline.ts:185-215` stays untouched). Gate at `summarizeThinking` (grouped aggregate) and standalone flush (`flushDeferredThinking` + `startTool` path 3).

**Files:**
- Modify: `src/tui/state/transcript-reducer.ts` (`summarizeThinking` ~`:366-384`; `flushDeferredThinking` `:148-156`; `startTool` path-3 spread `:232`).
- Test: `src/__tests__/tui/transcript-reducer.test.ts`.

**Interfaces:**
- Consumes: `ThinkingSummaryBlock`, `ThinkingGroupMetadata`, `TranscriptModel.deferredThinking`.
- Produces: `THINKING_COMMIT_THRESHOLD_MS`, `shouldCommitThinking(durationMs)`.

- [ ] **Step 1: Write failing tests (add to `transcript-reducer.test.ts`)**

```ts
import { summarizeThinking, flushDeferredThinking, emptyModel, shouldCommitThinking, THINKING_COMMIT_THRESHOLD_MS } from '../../tui/state/transcript-reducer.js';

describe('thinking commit threshold (single 1000ms rule)', () => {
  it('exposes a single 1000ms threshold', () => {
    expect(THINKING_COMMIT_THRESHOLD_MS).toBe(1000);
    expect(shouldCommitThinking(999)).toBe(false);
    expect(shouldCommitThinking(1000)).toBe(true);
  });
  it('shows a single grouped entry only at >=1s (was hidden below 2000ms)', () => {
    expect(summarizeThinking([{ durationMs: 1500 }])).toBe('Thought 1.5s');   // RED: old rule returned null
    expect(summarizeThinking([{ durationMs: 500 }])).toBeNull();
  });
  it('gates multi-entry by aggregate total, not "always show"', () => {
    expect(summarizeThinking([{ durationMs: 300 }, { durationMs: 400 }])).toBeNull();            // 700 < 1000
    expect(summarizeThinking([{ durationMs: 600 }, { durationMs: 600 }])).toBe('Thought 1.2s (2 entries)');
  });
  it('flushDeferredThinking drops standalone summaries <1s', () => {
    const model = {
      ...emptyModel(),
      deferredThinking: [
        { id: 'a', kind: 'system', subkind: 'thinking-summary', text: 'Thought for 0s', durationMs: 300, groupBoundary: 'transparent' },
        { id: 'b', kind: 'system', subkind: 'thinking-summary', text: 'Thought for 2s', durationMs: 2000, groupBoundary: 'transparent' },
      ],
    };
    const flushed = flushDeferredThinking(model);
    expect(flushed.items).toHaveLength(1);
    expect((flushed.items[0] as any).durationMs).toBe(2000);
  });
});
```
(Reuse the file-local `thinkingSummary()` helper if present instead of inline literals; match `ThinkingSummaryBlock` at `transcript-types.ts:83-92`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/transcript-reducer.test.ts`
Expected: FAIL — threshold undefined; `summarizeThinking([1500])` returns null; flush keeps the 300ms item.

- [ ] **Step 3: Write minimal implementation**

In `src/tui/state/transcript-reducer.ts`:
```ts
export const THINKING_COMMIT_THRESHOLD_MS = 1000;
export function shouldCommitThinking(durationMs: number): boolean {
  return durationMs >= THINKING_COMMIT_THRESHOLD_MS;
}
```
Rewrite `summarizeThinking` to gate on aggregate total:
```ts
export function summarizeThinking(entries: readonly ThinkingGroupMetadata[]): string | null {
  if (entries.length === 0) return null;
  const totalMs = entries.reduce((sum, e) => sum + e.durationMs, 0);
  if (!shouldCommitThinking(totalMs)) return null;
  if (entries.length === 1) return `Thought ${entries[0]!.durationMs / 1000}s`;
  return `Thought ${totalMs / 1000}s (${entries.length} entries)`;
}
```
Gate standalone flush:
```ts
// flushDeferredThinking
const visible = model.deferredThinking.filter(s => shouldCommitThinking(s.durationMs));
return model.deferredThinking.length === 0 ? model
  : { items: [...model.items, ...visible], deferredThinking: [] };
// startTool path 3 (the `...deferred` spread at :232)
items: [...prefix, ...deferred.filter(s => shouldCommitThinking(s.durationMs)), closedPending],
```
Do **not** change `startTool` paths 1/2 (attach all deferred; the aggregate gate handles them). Do **not** touch `src/ui/block-pipeline.ts:185-215`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/transcript-reducer.test.ts`
Expected: PASS. The pre-existing test `returns Thought Ns for a single entry at 2000ms` still passes (2000 ≥ 1000). If any existing test encoded the `<2000ms` cutoff, update it to `<1000ms` keeping its intent.

- [ ] **Step 5: Regression**

Run: `npx vitest run src/__tests__/tui/ src/__tests__/ui/block-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/state/transcript-reducer.ts src/__tests__/tui/transcript-reducer.test.ts
git diff --check
git commit -m "fix(tui): unify thinking summary threshold to 1000ms"
```

---

## Task 3: Routine hook suppression + normal-visibility filter wiring

Suppress routine success hooks at source; wire `isVisibleInNormalMode` into the committed-transcript render path so any diagnostics-channel block is hidden in normal UI.

**Files:**
- Modify: `src/hooks/builtins.ts` (`postToolLogger` `:32-35`).
- Modify: `src/tui/inline-v2/InlineAppV2.tsx` (`finalized` → `staticItems` ~`:213-223`).
- Test: `src/__tests__/hooks.test.ts`; `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`.

**Interfaces:**
- Consumes: `isVisibleInNormalMode` (Task 1), `HookEvent`/`HookResult` (`src/hooks/types.ts:11-20`).
- Produces: `postToolLogger` returning empty `message` on routine success.

- [ ] **Step 1: Write failing tests**

In `src/__tests__/hooks.test.ts`, under the existing `postToolLogger` describe, replace/add:
```ts
it('suppresses routine success: empty message, exitCode 0', () => {
  const r = postToolLogger({ name: 'PostToolUse', payload: { tool_name: 'memory_list', output: 'x' } });
  expect(r.exitCode).toBe(0);
  expect(r.message).toBe('');   // RED: currently '[Hook] memory_list done'
});
```
In `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`:
```ts
import { isVisibleInNormalMode } from '../../../../tui/state/presentation-channel.js';
it('hides diagnostics-channel committed blocks from the normal transcript', () => {
  const stores = createStores();   // createStores() returns the stores object directly (inline-app-v2.test.tsx:40)
  const diag = { id: 'h1', kind: 'system', subkind: 'notification', text: '[Hook] x done', groupBoundary: 'break' as const };
  stores.messagesStore.getState().appendTranscript(diag);
  expect(isVisibleInNormalMode(diag)).toBe(false);
  // render InlineAppV2 via the file's existing render helper and assert lastFrame() omits '[Hook] x done'
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/hooks.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`
Expected: FAIL — `postToolLogger` returns non-empty; `[Hook] x done` appears in frame.

- [ ] **Step 3: Write minimal implementation**

`src/hooks/builtins.ts`:
```ts
export function postToolLogger(event: HookEvent): HookResult {
  // Routine success has no user/diagnostic value: suppress at source (design spec §3).
  void event;
  return { exitCode: 0, message: '' };
}
```
`src/tui/inline-v2/InlineAppV2.tsx`:
```ts
import { isVisibleInNormalMode } from '../state/presentation-channel.js';
// after `const finalized = committedTranscript;` (~:128)
const visibleFinalized = finalized.filter(isVisibleInNormalMode);
// use visibleFinalized in staticItems (~:218) instead of finalized
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/hooks.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`
Expected: PASS. **Update** the pre-existing hook test whose assertion encoded `message 含工具名` to reflect source suppression (intended behavior change). Keep its "does not echo output content" intent.

- [ ] **Step 5: Regression**

Run: `npx vitest run src/__tests__/hooks.test.ts src/__tests__/tui/inline-v2/ src/__tests__/ui/block-pipeline-locale.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/builtins.ts src/tui/inline-v2/InlineAppV2.tsx src/__tests__/hooks.test.ts src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git diff --check
git commit -m "fix(hooks): suppress routine success notifications"
```

---

## Task 4: AgentActivity / AgentBlock (first-class)

Promote `spawn_agent` from a generic `ToolBlock` to a first-class `AgentBlock`/`PendingAgent`. **Reuse the existing `toolBuffer`** (`BufferedTool = { toolUseId; name; input; resolved? }`, `block-pipeline.ts:84-93`) — no second buffer. Route by `item.name === 'spawn_agent'` at finish/cancel time. Derive `label` from buffered `input` (including on cancel).

**Files:**
- Modify: `src/tui/transcript-types.ts` (`AgentBlock`, `PendingAgent`, `completeActivity` overload `:194-197`, `TRANSCRIPT_KINDS`/`ACTIVITY_KINDS`).
- Modify: `src/tui/state/transcript-reducer.ts` (`BoundaryBlock = Exclude<TranscriptBlock, ToolBlock | AgentBlock>`; `startAgent`/`resolveAgent`/`cancelAgent`).
- Modify: `src/tui/state/presentation-channel.ts` (add `'agent'` → `'activity'` case + test).
- Modify: `src/tui/state/messages-store.ts` (`startAgent`/`resolveAgent`/`cancelAgent` actions).
- Modify: `src/tui/state/pipeline-adapter.ts` (implement agent methods).
- Modify: `src/ui/block-pipeline.ts` (`PipelineRenderer` interface `:36-67`; spawn_agent routing in `tool_call`/`tool_result`; `cancelPendingTools` spawn_agent label — all via existing `toolBuffer`).
- Modify: `src/ui/subagent-presentation.ts` (export `deriveAgentLabel`).
- Create: `src/tui/inline-v2/AgentBlockLine.tsx`, `src/tui/inline-v2/PendingAgentMessage.tsx`.
- Modify: `src/tui/inline-v2/TranscriptBlockLine.tsx` (`'agent'` case), `src/tui/inline-v2/InlineAppV2.tsx` (`pending-agent` activity + input-row math).
- Test: `transcript-reducer.test.ts`, `block-pipeline.test.ts`, `pipeline-integration.test.ts` (update existing spawn_agent assertion `:24-27`), `transcript-block-line.test.tsx`, `presentation-channel.test.ts`, new `agent-block-line.test.tsx` + `pending-agent-message.test.tsx`, `inline-app-v2.test.tsx`.

**Interfaces:**
- Consumes: `PipelineRenderer` (extend), `BufferedTool` (reuse, do **not** duplicate), `buildSubagentCompletionPresentation` (`subagent-presentation.ts:96-115`) for envelope parsing, `meaningfulLine`/label logic, `tool_call.input` at cancel.
- Produces: `AgentBlock`, `PendingAgent`, `startAgent`/`resolveAgent`/`cancelAgent`, `deriveAgentLabel`, `AgentBlockLine`, `PendingAgentMessage`, `presentationChannel` `'agent'` case.

- [ ] **Step 1: Write failing tests**

`src/__tests__/tui/transcript-reducer.test.ts`:
```ts
import { startAgent, resolveAgent, cancelAgent, emptyModel } from '../../tui/state/transcript-reducer.js';
describe('agent activity reducer', () => {
  it('creates PendingAgent on startAgent and never groups', () => {
    const m = startAgent(emptyModel(), { activityId: 'a1', agentUseId: 'ag1', label: '调查项目' });
    expect(m.items[0]!.kind).toBe('pending-agent');
  });
  it('resolveAgent completes to AgentBlock with envelope-derived status', () => {
    const started = startAgent(emptyModel(), { activityId: 'a1', agentUseId: 'ag1', label: 'x' });
    const m = resolveAgent(started, 'ag1', { label: 'x', status: 'completed', summary: 'done', durationMs: 5000 });
    expect(m.items[0]!.kind).toBe('agent');
    expect((m.items[0] as any).status).toBe('completed');
  });
  it('cancelAgent completes to AgentBlock(cancelled) using buffered label', () => {
    const started = startAgent(emptyModel(), { activityId: 'a1', agentUseId: 'ag1', label: '调查项目' });
    const m = cancelAgent(started, 'ag1', '调查项目');
    expect((m.items[0] as any).status).toBe('cancelled');
    expect((m.items[0] as any).label).toBe('调查项目');
  });
});
```
`src/__tests__/ui/block-pipeline.test.ts` (`setup()` returns `{ recorder, pipeline }`, `:119-122`; `RecordingRenderer` at `:39`):
```ts
it('routes spawn_agent through agent lifecycle via toolBuffer, not generic ToolBlock', () => {
  const { recorder, pipeline } = setup();
  pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { description: '调查项目' }, toolUseId: 'ag1' });
  expect(recorder.startAgent).toHaveBeenCalledWith(expect.objectContaining({ label: '调查项目' }));
  pipeline.emit({ kind: 'tool_result', name: 'spawn_agent', output: '[Subagent status=completed]\ndone', toolUseId: 'ag1', durationMs: 4000 });
  expect(recorder.finishAgent).toHaveBeenCalled();
  expect(recorder.finishToolCall).not.toHaveBeenCalled();
});
it('cancel derives label from buffered toolBuffer input (no raw spawn_agent → cancelled)', () => {
  const { recorder, pipeline } = setup();
  pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { description: '架构调查' }, toolUseId: 'ag2' });
  pipeline.cancelPendingTools(new Set(['ag2']));
  expect(recorder.cancelAgent).toHaveBeenCalledWith('ag2', '架构调查');
});
```
(Extend `RecordingRenderer` to record `startAgent`/`finishAgent`/`cancelAgent` once added to the interface.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/transcript-reducer.test.ts src/__tests__/ui/block-pipeline.test.ts`
Expected: FAIL — agent actions not exported; `PipelineRenderer` has no agent methods; spawn_agent routes to `startToolCall`/`finishToolCall`.

- [ ] **Step 3: Write minimal implementation**

`src/tui/transcript-types.ts`:
```ts
export interface AgentBlock { id: string; kind: 'agent'; label: string; status: 'completed'|'partial'|'failed'|'cancelled'|'unknown'; summary?: string; durationMs?: number; }
export interface PendingAgent { id: string; kind: 'pending-agent'; label: string; }
// TranscriptBlock += AgentBlock ; ActivityItem += PendingAgent
// TRANSCRIPT_KINDS += 'agent'; ACTIVITY_KINDS += 'pending-agent'
// completeActivity overload: export function completeActivity(item: PendingAgent): AgentBlock;
```
`src/tui/state/transcript-reducer.ts`:
```ts
export type BoundaryBlock = Exclude<TranscriptBlock, ToolBlock | AgentBlock>;  // agent is activity-completed, not a boundary
```
Implement `startAgent` (push `PendingAgent`), `resolveAgent` (find pending-agent by agentUseId, `completeActivity` → AgentBlock), `cancelAgent` (complete to `AgentBlock{status:'cancelled', label}`).
`src/tui/state/presentation-channel.ts`:
```ts
    case 'agent': return 'activity';
```
(+ an `it('classifies agent as activity', …)` case in `presentation-channel.test.ts`.)
`src/tui/state/messages-store.ts` — add `startAgent(call): string`, `resolveAgent(agentUseId, block): boolean`, `cancelAgent(agentUseId, label): boolean` mirroring `startTool`/`resolveTool` (`:164-186`).
`src/tui/state/pipeline-adapter.ts` — implement `startAgent`/`finishAgent`/`cancelAgent` delegating to store actions.
`src/ui/block-pipeline.ts`:
```ts
// PipelineRenderer interface additions (required, not optional):
startAgent(call: { agentUseId: string; label: string }): void;
finishAgent(agentUseId: string, block: Omit<AgentBlock, 'id' | 'kind'>): boolean;
cancelAgent(agentUseId: string, label: string): boolean;
```
**Reuse `toolBuffer`** (no `agentBuffer`). In `emit` `tool_call` case: unconditionally `toolBuffer.push({ toolUseId, name, input })` as today; then branch:
```ts
if (block.name === 'spawn_agent') {
  this.renderer.startAgent({ agentUseId: toolUseId, label: deriveAgentLabel(block.input, this.translator) });
} else {
  this.renderer.startToolCall({ toolUseId, name: block.name, input: block.input });
}
```
In `emit` `tool_result` case: after pairing via the existing `toolBuffer.findIndex`, branch on `item.name === 'spawn_agent'`:
```ts
if (item.name === 'spawn_agent') {
  const pres = buildSubagentCompletionPresentation(input, block.output, block.durationMs ?? 0, this.translator);
  const status = pres ? /* map envelope status -> AgentBlock status */ 'completed' : 'unknown';
  const block2 = { label: deriveAgentLabel(input, this.translator), status, summary: pres?.fullOutput, durationMs: block.durationMs };
  this.renderer.finishAgent(toolUseId, block2);
} else {
  // existing buildPresentationSafely + renderer.finishToolCall(...)
}
```
(map envelope `completed→completed`, `incomplete→partial`, `unverified→partial`, malformed `null→unknown`. No `failed` from envelope; `failed`/`cancelled` come from error/cancel paths.)
In `cancelPendingTools` (`:136-152`), after finding `item`, branch:
```ts
if (item.name === 'spawn_agent') {
  this.renderer.cancelAgent(toolUseId, deriveAgentLabel(item.input, this.translator));
} else {
  // existing ToolPresentation(cancelled) + renderer.finishToolCall(...)
}
```
`src/ui/subagent-presentation.ts`:
```ts
export function deriveAgentLabel(input: Record<string, unknown>, translator: Translator): string {
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  return description || meaningfulLine(input.prompt) || translator.t('subagent.agentFallback');
}
```
(reuse internal `meaningfulLine` + `subagent.agentFallback` key `en-US.ts:332`.)
`src/tui/inline-v2/AgentBlockLine.tsx` — render `● {statusLineLabel} "{label}" {statusWord(status)} {duration? '· ' + fmt : ''}`; cancelled/partial/unknown → `dimColor`, failed → red. Reuse `subagent.presentation.status.*` keys (`en-US.ts:316-324`) + `formatDurationFromMs` logic.
`src/tui/inline-v2/PendingAgentMessage.tsx` — model on `PendingToolMessage.tsx` (`height={1}` + `width={2}` glyph slot); props `{ agent: PendingAgent; cols; spinnerStore }`; body `● {statusLineLabel} "{label}" …`.
`src/tui/inline-v2/TranscriptBlockLine.tsx` — add `case 'agent': return <AgentBlockLine block cols/>` before `default`.
`src/tui/inline-v2/InlineAppV2.tsx` — `const pendingAgents = activityItems.filter(i => i.kind === 'pending-agent');` near `:131-137`; render `<PendingAgentMessage>` near `:271-278`; include agent rows in `inputRowY` math (`:198`/`:201`/`:208`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/transcript-reducer.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/tui/inline-v2/ src/__tests__/tui/presentation-channel.test.ts`
Expected: PASS. Add `agent-block-line.test.tsx` (cancelled → dim; completed → `● Agent "x" finished · 4s`) and `pending-agent-message.test.tsx` (running row). Extend `inline-app-v2.test.tsx` `agent-completion 单行展示` to assert cancelled agent renders `Agent "调查项目" cancelled`, never `spawn_agent → cancelled`. **Update the existing `pipeline-integration.test.ts:24-27`** spawn_agent assertion from tool semantics to agent semantics (intended behavior change).

- [ ] **Step 5: Regression**

Run: `npx vitest run src/__tests__/ui/subagent-presentation.test.ts src/__tests__/ui/block-pipeline-locale.test.ts src/__tests__/tui/`
Run: `npm --prefix . run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/transcript-types.ts src/tui/state/ src/ui/ src/tui/inline-v2/ src/__tests__/
git diff --check
git commit -m "feat(tui): add agent activity blocks"
```

---

## Task 5: Outcome fallback semantics

Remove the four-field template from normal UI. Keep structured classification (`classifyTurn` not extended); build a `TurnStatusCandidate` (cancelled **only** from `aborted`); emit a concise `TurnStatusBlock` only when the single production helper `shouldEmitTurnStatus(candidate, items)` says so. Add the `TurnStatusBlock` render path (RED proves visibility).

**Files:**
- Modify: `src/tui/transcript-types.ts` (add `TurnStatusBlock`; add `'turn-status'` to `TRANSCRIPT_KINDS`).
- Modify: `src/tui/state/transcript-reducer.ts` (add `hasVisibleAbnormalActivity`).
- Modify: `src/tui/state/presentation-channel.ts` (add `'turn-status'` → `'activity'` case + test).
- Modify: `src/ui/types.ts` (add `{ kind: 'turn_status'; status; line }` to `Block`).
- Modify: `src/ui/block-pipeline.ts` (route `turn_status` → `renderer.appendTranscriptBlock`).
- Modify: `src/agent/turn-final-feedback.ts` (remove 4-field emission; add `TurnStatusCandidate`/`buildTurnStatusCandidate`/`shouldEmitTurnStatus`; `commitFinalizedTurn` persist-only).
- Modify: `src/index.ts` (build candidate, call `shouldEmitTurnStatus`, emit `turn_status`).
- Modify: `src/tui/inline-v2/TranscriptBlockLine.tsx` (add `case 'turn-status'`).
- Modify: `src/locale/resources/zh-CN.ts` then `en-US.ts` (turn-status line keys).
- Test: `src/__tests__/turn-final-feedback.test.ts`; `src/__tests__/tui/inline-v2/transcript-block-line.test.tsx`; `src/__tests__/tui/presentation-channel.test.ts`.

**Interfaces:**
- Consumes: `TurnFinalizationInput` (`aborted` `:17-26`), `UserTurnStatus = '成功'|'部分完成'|'失败'` (`:7`) — **not extended**, `classifyTurn` (internal), `AgentBlock`/`ToolBlock` (Task 4) via `hasVisibleAbnormalActivity`.
- Produces: `TurnStatusBlock`, `TurnStatusCandidate`, `buildTurnStatusCandidate`, `hasVisibleAbnormalActivity`, `shouldEmitTurnStatus`.

- [ ] **Step 1: Write failing tests**

Add to `src/__tests__/tui/inline-v2/transcript-block-line.test.tsx` (renderer RED — proves fallback is actually visible, not just present in reducer):
```ts
it('renders a turn-status fallback line', () => {
  const block = { id: 'ts1', kind: 'turn-status', status: 'partial', line: '⚠ Partial — reason' };
  const { lastFrame } = renderBlock(block);   // reuse the file's existing renderBlock helper
  expect(lastFrame()).toContain('⚠ Partial — reason');
});
it('never renders the legacy four-field template', () => {
  // TurnStatusBlock is a single line; the renderer has no path that emits 'Current status'
  const block = { id: 'ts2', kind: 'turn-status', status: 'failed', line: '✖ Failed — x' };
  expect(renderBlock(block).lastFrame()).not.toMatch(/Current status/);
});
```
Add to `src/__tests__/turn-final-feedback.test.ts`:
```ts
import { buildTurnStatusCandidate, shouldEmitTurnStatus, type TurnStatusCandidate } from '../agent/turn-final-feedback.js';
import { hasVisibleAbnormalActivity } from '../tui/state/transcript-reducer.js';

describe('TurnStatus candidate mapping (cancelled only from aborted)', () => {
  it('aborted -> cancelled candidate; classifyTurn status otherwise maps 成功/部分完成/失败', () => {
    // aborted overrides classifyTurn
    expect(buildTurnStatusCandidate({ ...baseInput, aborted: true }, '部分完成', zhTranslator)?.status).toBe('cancelled');
    expect(buildTurnStatusCandidate({ ...baseInput, aborted: false }, '成功', zhTranslator)).toBeNull();
    expect(buildTurnStatusCandidate({ ...baseInput, aborted: false }, '部分完成', zhTranslator)?.status).toBe('partial');
    expect(buildTurnStatusCandidate({ ...baseInput, aborted: false }, '失败', zhTranslator)?.status).toBe('failed');
  });
});

describe('shouldEmitTurnStatus (single production seam)', () => {
  const candidate: TurnStatusCandidate = { status: 'partial', line: 'x' };
  it('emits when no visible abnormal activity', () => {
    expect(shouldEmitTurnStatus(candidate, [])).toBe(true);
  });
  it('suppresses when an Agent cancelled already explains the turn', () => {
    const items = [{ id: 'a1', kind: 'agent', label: '调查项目', status: 'cancelled' }] as any;
    expect(shouldEmitTurnStatus(candidate, items)).toBe(false);
  });
  it('null candidate never emits', () => {
    expect(shouldEmitTurnStatus(null, [])).toBe(false);
  });
});

describe('no four-field template', () => {
  it('finalizeTurnForUser produces no Current-status text', () => {
    const r = finalizeTurnForUser({ /* partial fixture */ }, zhTranslator);
    expect(JSON.stringify(r)).not.toMatch(/Current status/);
  });
});
```
(`baseInput` reuses the file's existing `TurnFinalizationInput` fixture pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/turn-final-feedback.test.ts src/__tests__/tui/inline-v2/transcript-block-line.test.tsx src/__tests__/tui/presentation-channel.test.ts`
Expected: FAIL — `buildTurnStatusCandidate`/`shouldEmitTurnStatus` not exported; `hasVisibleAbnormalActivity` not exported; `case 'turn-status'` missing; `TurnStatusBlock` type missing.

- [ ] **Step 3: Write minimal implementation**

`src/tui/transcript-types.ts`:
```ts
export interface TurnStatusBlock { id: string; kind: 'turn-status'; status: 'partial'|'failed'|'cancelled'; line: string; }
// TranscriptBlock += TurnStatusBlock ; TRANSCRIPT_KINDS += 'turn-status'
// (BoundaryBlock auto-includes TurnStatusBlock since it is not ToolBlock/AgentBlock.)
```
`src/tui/state/transcript-reducer.ts`:
```ts
export function hasVisibleAbnormalActivity(items: readonly TimelineItem[]): boolean {
  return items.some(i =>
    (i.kind === 'tool' && i.presentations.some(p => p.status === 'error' || p.status === 'cancelled'))
    || (i.kind === 'agent' && i.status !== 'completed')
    || (i.kind === 'system' && i.subkind === 'notification' && i.tone === 'error'),
  );
}
```
`src/tui/state/presentation-channel.ts` — add `case 'turn-status': return 'activity';` (+ test case).
`src/ui/types.ts` — extend `Block`: `| { kind: 'turn_status'; status: 'partial'|'failed'|'cancelled'; line: string }`.
`src/ui/block-pipeline.ts` — in `emit` switch:
```ts
      case 'turn_status': {
        this.renderer.appendTranscriptBlock({ id: `turn-status-${++this.idCounter}`, kind: 'turn-status', status: block.status, line: block.line });
        break;
      }
```
`src/tui/inline-v2/TranscriptBlockLine.tsx` — add before `default`:
```tsx
      case 'turn-status': {
        const color = block.status === 'failed' ? 'red' : undefined;
        const dim = block.status === 'cancelled';
        return <Text color={color} dimColor={dim}>{block.line}</Text>;
      }
```
(No new component — single line is inlined. Add a new component only if the file's conventions require it.)
`src/agent/turn-final-feedback.ts`:
- Keep `classifyTurn` producing `UserTurnStatus` (do **not** extend).
- Remove `buildFeedbackText`/`buildFeedbackFields` four-field assembly and `appendFeedback`'s uiOnly text append to `Message[]`.
- Add the candidate mapping (cancelled **only** from `aborted`):
```ts
export type TurnStatusCandidate = { status: 'partial' | 'failed' | 'cancelled'; line: string };

export function buildTurnStatusCandidate(
  input: TurnFinalizationInput,
  classified: UserTurnStatus,
  translator: Translator,
): TurnStatusCandidate | null {
  if (input.aborted) return { status: 'cancelled', line: translator.t('status.turnFinal.cancelledLine') };
  switch (classified) {
    case '成功': return null;
    case '部分完成': return { status: 'partial', line: translator.t('status.turnFinal.partialLine') };
    case '失败': return { status: 'failed', line: translator.t('status.turnFinal.failedLine') };
  }
}

export function shouldEmitTurnStatus(candidate: TurnStatusCandidate | null, items: readonly TimelineItem[]): boolean {
  return candidate !== null && !hasVisibleAbnormalActivity(items);
}
```
- `finalizeTurnForUser` returns `{ status: UserTurnStatus; messages: Message[]; candidate: TurnStatusCandidate | null }` (drop `feedbackText`/`requiresFeedback`); it computes `candidate` from `buildTurnStatusCandidate(input, classifyTurn(input), translator)`.
- Refactor `commitFinalizedTurn(result, persistedMessageCount, append): Promise<number>` to **persist-only** (drop `emit` param and the `result.requiresFeedback`/`result.feedbackText` read at `:386-388`).
- Locale: add `status.turnFinal.{partialLine, failedLine, cancelledLine}` to `zh-CN.ts` then `en-US.ts`.

`src/index.ts` (`finally` ~`:1108-1146`):
```ts
const finalized = finalizeTurnForUser({ messages: baseMessages, turnStartIndex, toolFacts, error: terminalError, aborted }, translator);
await commitFinalizedTurn(finalized, persistedMessageCount,
  message => sessionStore.append(sessionState.currentId, stripImagesForPersistence(message)));
const turnItems = tuiHandle.messagesStore.getState().model.items;
if (shouldEmitTurnStatus(finalized.candidate, turnItems)) {
  pipeline.emit({ kind: 'turn_status', status: finalized.candidate!.status, line: finalized.candidate!.line });
}
```
Apply the same conditional `turn_status` emit in the persist-failure catch (replacing `pipeline.emit({ kind:'assistant_text', text: persistenceFailure.feedbackText })` at `:1145`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/turn-final-feedback.test.ts src/__tests__/tui/inline-v2/transcript-block-line.test.tsx src/__tests__/tui/presentation-channel.test.ts src/__tests__/ui/block-pipeline.test.ts`
Expected: PASS. **Update** pre-existing turn-final-feedback tests that asserted the 4-field `feedbackText` and the `uiOnly` status block (`array content → feedback block …`, `persists and emits fallback text …`) to assert the new candidate/fallback semantics (no uiOnly append; concise line only when `shouldEmitTurnStatus` is true).

- [ ] **Step 5: Regression**

Run: `npx vitest run src/__tests__/turn-final-feedback.test.ts src/__tests__/index.test.ts src/__tests__/tui/ src/__tests__/ui/block-pipeline.test.ts`
Run: `npm --prefix . run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/transcript-types.ts src/tui/state/ src/ui/types.ts src/ui/block-pipeline.ts src/agent/turn-final-feedback.ts src/index.ts src/tui/inline-v2/TranscriptBlockLine.tsx src/locale/resources/zh-CN.ts src/locale/resources/en-US.ts src/__tests__/
git diff --check
git commit -m "feat(tui): render turn status fallback"
```

---

## Task 6: Deterministic ToolActivity semantics

Cover the spec's high-frequency tools with **only** deterministic summaries. read_file directory detection is restricted to the single provable case (`path === '.'`); no path-shape heuristics.

**read_file structured-data finding (verified read-only):** `src/agent/tools/file-tools.ts:33-44` — read_file input is `{ path: string; limit?: number }`. The tool internally `statSync().isDirectory()` branches (`:52`), but by the time it reaches the presentation layer (`tool_result` `Block.output: string`; `ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure` at `tool-execution.ts:60-62`, no file/directory discriminator), the type information is gone. **Option A is unavailable; Option B applies:** only `path === '.'` is deterministically a directory (workspace root). All other paths keep the existing read summary — no trailing-slash / extension guessing.

**Files:**
- Modify: `src/ui/tool-presentation.ts` (`buildToolPresentation` switch, `read_file` case + new `memory_*` case).
- Modify: `src/locale/resources/zh-CN.ts` then `en-US.ts` (`toolPresentation.semantic.{memory,readDirectory}`).
- Test: `src/__tests__/ui/tool-presentation.test.ts`.

**Interfaces:**
- Consumes: `buildToolPresentation(input: BuildToolPresentationInput, translator)` (`tool-presentation.ts:95-99`; destructures `const { toolUseId, toolName, input: toolInput, output, durationMs } = input`).
- Produces: deterministic summaries for `memory_*` and `read_file` `path === '.'` only.

- [ ] **Step 1: Write failing tests**

In `src/__tests__/ui/tool-presentation.test.ts`:
```ts
it.each(['zh-CN','en-US'])('semantic memory summary in %s', (language) => {
  const t = translatorFor(language);
  const p = buildToolPresentation({ toolUseId: 'tu1', toolName: 'memory_list', input: {}, output: '' }, t);
  expect(p.summary).toBe(t('toolPresentation.semantic.memory'));
});
it.each(['zh-CN','en-US'])('only path "." is treated as directory in %s', (language) => {
  const t = translatorFor(language);
  // deterministic directory: workspace root
  const dirP = buildToolPresentation({ toolUseId: 'tu2', toolName: 'read_file', input: { path: '.' }, output: '' }, t);
  expect(dirP.summary).toBe(t('toolPresentation.semantic.readDirectory'));
  // any other path: NO guessing — keep existing read summary, never readDirectory
  const otherP = buildToolPresentation({ toolUseId: 'tu3', toolName: 'read_file', input: { path: 'src/index.ts' }, output: '' }, t);
  expect(otherP.summary).not.toBe(t('toolPresentation.semantic.readDirectory'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui/tool-presentation.test.ts`
Expected: FAIL — `toolPresentation.semantic.*` keys missing; memory still `Ran 1 operation`; `path === '.'` still `Read 1 item`.

- [ ] **Step 3: Write minimal implementation**

`src/locale/resources/zh-CN.ts` then `en-US.ts` under `toolPresentation`:
```ts
semantic: {
  memory: 'Checked memory',              // zh-CN: '检查了记忆'
  readDirectory: 'Read project structure',  // zh-CN: '读取了项目结构'
}
```
`src/ui/tool-presentation.ts` — add a `memory_*` branch and extend the existing `case 'read_file':` branch:
```ts
    case 'memory_list':
    case 'memory_search':
    case 'memory_add':
      return { ...base, summary: translator.t('toolPresentation.semantic.memory'), details: [] };
    case 'read_file': {
      const path = typeof toolInput.path === 'string' ? toolInput.path : '';
      if (path === '.') {
        return { ...base, summary: translator.t('toolPresentation.semantic.readDirectory'), details: [] };
      }
      // any other path: fall through to the existing read summary (no directory/file guessing)
      return { ...base, summary: translator.t('toolPresentation.group.read.one', { count: 1 }), details: [] };
    }
```
(Keep `glob`/`grep` semantics; leave `bash` on the existing concise path; `spawn_agent` no longer reaches here after Task 4.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui/tool-presentation.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression**

Run: `npx vitest run src/__tests__/ui/tool-presentation.test.ts src/__tests__/ui/block-pipeline-locale.test.ts src/__tests__/tui/pipeline-integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/tool-presentation.ts src/locale/resources/zh-CN.ts src/locale/resources/en-US.ts src/__tests__/ui/tool-presentation.test.ts
git diff --check
git commit -m "feat(tui): improve tool activity summaries"
```

---

## Task 7: Integrated transcript / user-level acceptance

Verify the full real case end-to-end **through the production decision seam** (`shouldEmitTurnStatus` from Task 5), plus overlay/history regression. No duplicated `if` logic in tests.

**Files:**
- Test: `src/__tests__/tui/pipeline-integration.test.ts` (extend with `setup()` which returns `{ pipeline, store }`); `src/__tests__/turn-final-feedback.test.ts` (production-seam assertions).

**Interfaces:**
- Consumes: real `BlockPipeline` + `PipelineToStoreAdapter` + `createMessagesStore` + `selectCommittedTranscript`; `isVisibleInNormalMode`; `finalizeTurnForUser`; `shouldEmitTurnStatus` (Task 5); `hasVisibleAbnormalActivity`.

- [ ] **Step 1: Write the production-seam acceptance tests**

In `src/__tests__/turn-final-feedback.test.ts`, drive the **real** finalizer + the **real** decision helper (this is the test that can genuinely RED on a production bug):
```ts
import { finalizeTurnForUser, shouldEmitTurnStatus } from '../agent/turn-final-feedback.js';

describe('production TurnStatus seam — spawn_agent cancelled case', () => {
  it('aborted turn with an Agent cancelled -> no duplicate TurnStatus', () => {
    // Real production finalizer on an aborted fixture (spawn_agent was cancelled by user_abort)
    const finalized = finalizeTurnForUser({ messages: abortedMessages, turnStartIndex: 0, toolFacts: [], error: undefined, aborted: true }, zhTranslator);
    // candidate is 'cancelled' (from aborted, not from classifyTurn)
    expect(finalized.candidate?.status).toBe('cancelled');
    // items reflect what the user actually saw: an AgentBlock(cancelled) already committed by Task 4
    const items = [{ id: 'a1', kind: 'agent', label: '调查项目', status: 'cancelled' }] as any;
    expect(shouldEmitTurnStatus(finalized.candidate, items)).toBe(false);   // explained -> no TurnStatus
  });

  it('partial turn with no visible abnormal activity -> emits TurnStatus', () => {
    const finalized = finalizeTurnForUser({ messages: partialNoAbnormalMessages, turnStartIndex: 0, toolFacts: [], error: undefined, aborted: false }, zhTranslator);
    expect(finalized.candidate?.status).toBe('partial');
    expect(shouldEmitTurnStatus(finalized.candidate, [])).toBe(true);        // genuine fallback
  });
});
```
In `src/__tests__/tui/pipeline-integration.test.ts`, add the full compact-transcript case:
```ts
describe('message presentation v1 — full case', () => {
  it('compact transcript for memory+read+spawn_agent(cancelled)+partial', () => {
    const { pipeline, store } = setup();
    pipeline.emit({ kind: 'user_input', text: '启动子代理调查项目' });
    pipeline.emit({ kind: 'assistant_text', text: '我来启动…', isFinal: true });
    pipeline.emit({ kind: 'thinking_start' });
    pipeline.emit({ kind: 'thinking_end', durationSec: 0, filesRead: 0 });   // <1s -> no committed summary
    pipeline.emit({ kind: 'tool_call', name: 'memory_list', input: {}, toolUseId: 't1' });
    pipeline.emit({ kind: 'tool_result', name: 'memory_list', output: 'No memories', toolUseId: 't1' });
    // routine hook suppressed at source -> no hook emit
    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: '.' }, toolUseId: 't2' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: '.', toolUseId: 't2' });
    pipeline.emit({ kind: 'assistant_text', text: '现在启动…', isFinal: true });
    pipeline.emit({ kind: 'tool_call', name: 'spawn_agent', input: { description: '调查项目' }, toolUseId: 'a1' });
    pipeline.cancelPendingTools(new Set(['a1']));
    const items = selectCommittedTranscript(store.getState().model.items);

    expect(items.some(i => i.kind === 'user')).toBe(true);
    expect(items.filter(i => i.kind === 'assistant')).toHaveLength(2);
    expect(items.some(i => i.kind === 'tool' && (i as any).presentations?.[0]?.summary === 'Checked memory')).toBe(true);
    expect(items.some(i => i.kind === 'tool' && (i as any).presentations?.[0]?.summary === 'Read project structure')).toBe(true);
    expect(items.some(i => i.kind === 'agent' && (i as any).status === 'cancelled' && (i as any).label === '调查项目')).toBe(true);

    // absent
    expect(items.some(i => i.kind === 'system' && i.subkind === 'thinking-summary')).toBe(false);
    expect(items.some(i => i.kind === 'system' && i.subkind === 'notification')).toBe(false);
    expect(items.some(i => i.kind === 'turn-status')).toBe(false);  // AgentBlock(cancelled) explains the turn
  });
});
```

- [ ] **Step 2: Run tests (genuine RED-on-bug possible)**

Run: `npx vitest run src/__tests__/turn-final-feedback.test.ts src/__tests__/tui/pipeline-integration.test.ts`
Expected: If Tasks 1–6 are correct, PASS. If FAIL, the failing assertion identifies the production gap (finalizer candidate, `shouldEmitTurnStatus`, or a routing bug) — return to that task; do **not** weaken assertions. The `turn-status` absent-assertion is now meaningful because it is backed by the real `shouldEmitTurnStatus(finalized.candidate, items)` decision, not a hardcoded `false`.

- [ ] **Step 3: Overlay / history regression (no new code)**

Run: `npx vitest run src/__tests__/permission/ src/__tests__/plan-approval.test.ts src/__tests__/plan-approval-i18n.test.ts src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx src/__tests__/turn-final-feedback.test.ts`
Expected: PASS (overlays untouched; `tool_result` still persisted in `Message[]` — verify via the updated turn-final-feedback persistence assertions).

- [ ] **Step 4: Typecheck + lint + full suite (baseline-aware)**

Run: `npm --prefix . run typecheck`
- Changed-files lint **must be 0 errors**: `npx eslint <list of files changed across Tasks 1–7>`.
- Repo standard lint still runs: `npm --prefix . run lint`. If the repo-wide lint has **pre-existing** baseline failures, attribute them per `superpowers:verification-before-completion` baseline discipline (do not mask them as new). **No new lint failures may be introduced by this feature.**
- Full suite: `npm --prefix . test`. The known flaky `unified-tool-execution-paths.test.ts` ESLint cold-start timeout must be confirmed by isolated rerun, not treated as a real failure.

Expected: typecheck PASS; changed-files lint 0 errors; no new repo-wide lint failures; full suite green except the known flaky test (isolated-rerun-confirmed).

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/turn-final-feedback.test.ts src/__tests__/tui/pipeline-integration.test.ts
git diff --check
git commit -m "test(tui): verify concise transcript presentation"
```

---

## Spec acceptance criteria → Task coverage

| Spec §13 criterion | Task |
|---|---|
| 1. `<1s` thinking produces no `Thought for 0s` | Task 2 (+ Task 7) |
| 2. `>=1s` thinking shows `Thought for Ns` | Task 2 (+ Task 7) |
| 3. routine success hook not in normal transcript | Task 3 (+ Task 7) |
| 4. hook / user-actionable error still visible | Task 1 (`tone=error`→activity) + Task 3 |
| 5. partial/cancelled/failed show no four-field template | Task 5 (+ Task 7) |
| 6. no duplicate TurnStatus when abnormal Activity exists | Task 5 (`shouldEmitTurnStatus`) (+ Task 7 production-seam) |
| 7. spawn_agent uses Agent Activity (running/completed/failed/cancelled) | Task 4 (+ Task 7) |
| 8. cancelled agent shows `Agent "{label}" cancelled`, not raw | Task 4 (+ Task 7) |
| 9. memory/read deterministic semantics | Task 6 (+ Task 7) |
| 10. assistant substantive text fully preserved | Task 5 (no narration dedup) + Task 7 |
| 11. permission/plan/ask overlay unchanged | Task 7 regression |
| 12. model/session history `tool_result` behavior unchanged | Task 5 (persistence preserved) + Task 7 |

---

## Out-of-scope (v1) — do not implement

Web/GUI; renderer DSL / plugin renderer; theme/animation; child subagent live progress / token-tool realtime / `SubagentOptions.onProgress`; `SubagentExecutionResult → string → regex` refactor; per-block expand/collapse UI (incl. AgentBlock Ctrl+O); `ToolPresentation.details` full activation; `/verbose` / `/debug` / verbosity enum pre-emption; assistant NLP dedup; deleting `Block` / `pipeline-adapter` (Plan C — future direction only); a parallel `agentBuffer` (reuse `toolBuffer`); folding overlays into the Presentation Model; legacy/dead-code cleanup; unrelated TUI rewrites.

---

## Review / Verification handoff (post-implementation)

Per-task review follows `subagent-driven-development`'s required review gate during execution. After all tasks land, the brain runs the unified Review: (1) `open-code-review`, (2) `requesting-code-review`, (3) `receiving-code-review`, then `verification-before-completion`, then `finishing-a-development-branch`. This plan does not repeat those skill-internal steps.
