# Subagent visibility and plan isolation

## Pending tool visibility

- Root cause: `tool_call` entered `BlockPipeline.toolBuffer` but was not emitted to
  `MessagesStore` until the matching `tool_result` arrived.
- TDD RED: a standalone `tool_call` left the message list empty; the store had no
  pending-tool lifecycle API.
- Minimal fix: create a `tool-progress` message immediately, then resolve the same
  message by `toolUseId`; calls without IDs keep the FIFO compatibility path.
- Regression fix: an orphan result clears the previous hook target, so its hook
  cannot attach to an earlier completed tool.
- Verification: block pipeline, pipeline integration, and message store tests pass
  (63 tests); TypeScript and scoped ESLint pass.

## Plan approval isolation

- TDD regression: an old plan must not open approval UI for a new turn without a write.
- Active approval capability is keyed by `sessionId + turnId`; explicit session recovery is read-only and does not activate approval.
- Verification: plan approval and plan streaming tests pass; TypeScript typecheck passes.

## Planner Ask/Exit control flow

- TDD RED: the runtime `plannerPrompt` lacked the direct-answer rule and still
  contained the unconditional Ask-or-Exit instruction.
- Minimal fix: informational/read-only turns and no-other-task responses end
  directly; Ask is limited to unresolved blocking choices; Exit requires a
  successful `write_plan_file` in the current user turn.
- The Ask tool definition now carries the same blocking-clarification and
  no-generic-follow-up boundaries.
- Verification: planner streaming and approval tests pass (41 tests);
  TypeScript typecheck passes.

## Final verification

- Impacted suite on final HEAD: 6 files, 109 tests passed.
- TypeScript: `npm.cmd run typecheck` passed.
- Full suite: completed with 15 failures, the same count and categories observed
  before implementation (background timeout race, ANSI layout assertions,
  task-tool fixture, sandboxed image cache, and Windows process cleanup).
- Project lint remains red on the pre-existing baseline: 54 errors and 68 warnings
  across unrelated files. Scoped lint for every changed production/test file passed;
  the generated planner file retains one existing unused-disable warning.

## Final review recovery safeguards

- Legacy plans without `turn` remain recoverable historical entries with `turnId: null`.
  They never populate the in-memory active plan, so they cannot regain current-turn
  read or exit approval capability.
- When a renderer declines `finishToolCall`, the pipeline falls back to ordinary
  message rendering for the complete call and result, then removes the buffer item.
  A successful in-place finish still returns before fallback and does not duplicate it.
- TDD: both regressions were observed RED before the minimal fixes, then GREEN.

## AUTO-0025 live progress and final summary (Tasks 1-5)

### Task 1: pending tool calls visible in Inline V2

- Root cause: `InlineAppV2` only rendered `finalized` messages in `<Static>`; pending
  `tool-progress` messages (kind='tool-progress', finalized=false) were filtered out
  of the active region, so `spawn_agent(...)` stayed invisible until its result arrived.
- TDD RED: a standalone pending `spawn_agent` message produced a frame without
  `spawn_agent`; two parallel pending tools produced a frame without `explore`/`plan`.
- Minimal fix: filter `pendingTools` (finalized=false, kind='tool-progress') and render
  them via `MessageLine` between `<StreamingText>` and the spinner/footer. Include their
  line count in `inputRowY` so the footer offset stays correct.
- Verification: `inline-app-v2.test.tsx` (21) + `pipeline-integration.test.ts` (13) pass.

### Task 2: child progress associated with parent spawn call

- Root cause: `ToolExecutor` received only `input`; there was no way for `spawn_agent`
  to know its own `toolUseId`, and `runSubagentWithClient` never forwarded its private
  event-bus tool events to an outer callback.
- TDD RED: executor captured an empty context array; `onProgress` captured no events.
- Minimal fix:
  - Added `ToolExecutionContext { toolUseId }` (optional 2nd arg) threaded through
    `ToolRegistry.execute` -> `StreamingToolExecutor.executeTool` -> streaming-query
    serial branch.
  - Added `SubagentProgressEvent` + `SubagentOptions.parentToolUseId` / `onProgress`;
    `runSubagentWithClient` subscribes to its private `StreamEventBus` and forwards
    `tool_call`/`tool_result` stamped with `parentToolUseId`, removing all listeners
    in `finally`.
  - `createSpawnAgentTool` reads `context?.toolUseId` and passes it to the runner;
    no global ID generation or FIFO matching.
- Verification: `tool-execution-context.test.ts` (3) + `subagent-result-integrity.test.ts`
  child-progress suite + `role-agents.test.ts` (29) pass.

### Task 3: matching parent pending message updated

- Root cause: there was no block type or store operation to attach child tool activity
  to the parent `spawn_agent` pending message; child progress would have created a
  second top-level tool message or been lost.
- TDD RED: emitting `subagent_tool_progress` left the parent message without a nested
  `read_file` line; a second top-level message would have appeared.
- Minimal fix:
  - New `Block` variant `subagent_tool_progress` keyed by `parentToolUseId` +
    `childToolUseId` + `phase` ('running'|'done').
  - `BlockPipeline` keeps a per-parent `Map<childToolUseId, FormattedLine>` so a `done`
    phase replaces the matching `running` line (no accumulation); renders via the new
    optional `PipelineRenderer.updateToolProgress`.
  - `MessagesStore.updatePendingToolProgress(parentToolUseId, lines)` rebuilds the
    pending message as `originalCallLines + progressLines`; `originalCallLines` is
    snapshotted at `appendPendingTool` and dropped at `resolvePendingTool`. Unknown
    parent IDs return `false` and touch nothing (no FIFO fallback).
  - `index.ts` wires a `progressBridge` factory that reads the live `pipeline` at
    execution time (not the initial no-op) and emits `subagent_tool_progress`.
- Verification: `messages-store.test.ts` (28) + `pipeline-integration.test.ts` (18) +
  `block-pipeline.test.ts` (27) + `pipeline-adapter.test.ts` (10) pass, including
  interleaved progress for two parent spawn calls.

### Task 4: reserved final summary turn

- Root cause: on `max_turns`, the last assistant turn still exposed tools, so the model
  could emit `Now let me check...` and that process narration leaked as the final result.
- TDD RED: final turn still listed `read_file`; an empty final turn was reported
  `completed` instead of `incomplete`.
- Minimal fix:
  - `StreamingQueryOptions.reserveFinalTextTurn?: boolean`. When true and
    `maxTurns >= 2` and `turnCount === maxTurns`, the upcoming call is the final turn:
    `tools=[]` and the system prompt gets a "do not call tools, summarize from evidence"
    suffix. The `maxTurns >= 2` guard leaves room for at least one evidence-gathering
    turn (maxTurns=1 cannot reserve a summary turn).
  - `runSubagentWithClient` enables it by default and returns `finalTurnSynthesized`
    (true only when `end_turn` + non-empty text). `finalizeSubagentExecution` marks the
    run `incomplete` (`terminationReason: 'max_turns'`) when the final turn was active
    but produced no summary; the old tool-call fallback summary no longer masks a blank
    final turn.
  - Main-agent `streamingQuery` path is unaffected (option defaults to false).
- Verification: `subagent-result-integrity.test.ts` final-summary suite +
  `streaming-query.test.ts` (7) pass.

### Task 5: explicit delegation honored

- Root cause: `spawn_agent` returned only prose, so the main agent could not reliably
  distinguish a completed subagent from an incomplete one, and silently re-did the work
  with its own filesystem tools even when the user explicitly asked for a subagent.
- Minimal fix:
  - `formatSubagentResult(result)` serializes a leading `[Subagent status=...]` line
    (`reason=` only for `incomplete`). `background` is exempt (not a final result).
  - `index.ts` main system prompt gains a conditional rule: when the user explicitly
    requires a subagent, do not replace an incomplete/failed run with your own tool
    investigation; report the status prefix instead. Automatic delegation the main agent
    chose itself is unaffected.
- Design note: no full main-agent E2E test asserts "the LLM does not fall back" — that
  is a prompt-level soft constraint depending on model instruction-following, not code.
  The hard contract (status prefix parseable by the main agent) is locked by
  `subagent-explicit-delegation.test.ts` (6) and the `role-agents.test.ts` status suite.
- Verification: both suites pass (38 tests total).

### Final verification (AUTO-0025 Tasks 1-5)

- Impacted suite on final HEAD `f39af6e`: 11 files, 167 tests passed.
- TypeScript: `npm run typecheck` passed.
- Full suite: 1863 passed, 4 failed, 2 skipped. The 4 failures are pre-existing
  baseline ANSI/layout assertions in `src/__tests__/tui/layout.test.tsx` (confirmed by
  checking out `1067243`, the commit before this work — same 2 failures there) plus
  the known flaky categories. No new failure was introduced by Tasks 1-5.
- Lint: project baseline remains red (54 errors, 68 warnings across unrelated files).
  Scoped ESLint over every changed source file reports only pre-existing issues
  (`COMMAND_NAMES` unused in `index.ts`, `overlayVisible` unused in `InlineAppV2.tsx`,
  one unused `eslint-disable` in `streaming-query.ts`) — none introduced by this work.
- Build source: `D:/Files/Projects/mi-code/.worktrees/auto-0025`, branch
  `codex/auto-0025`, HEAD `f39af6e`.
- Manual scenario ("用子代理告诉我你能看到哪些技能"): pending real LLM run in an
  interactive terminal; automated coverage (pending visibility, nested progress,
  final summary, status prefix) is green via the suites above.

## AUTO-0025-stable: stable running indicator (Tasks 1-4)

### Root cause of flicker

The live-progress bridge (Tasks 2-3 of the first AUTO-0025 round) appended every
child tool event to the parent pending message's `lines`. Each new child tool added
a row, so Ink had to clear and redraw the whole activity region. `pendingToolsRowCount`
estimated height from `lines.length`, but `MessageLine` wraps by terminal width, so
logical and physical line counts diverged and the footer offset went wrong. Message
updates and spinner ticks coincided, expanding the clear/redraw blast radius.

### Task 1: fixed-height blinking pending tool component

- Created `pending-tool-indicator.ts` with `isPendingToolGlyphVisible(timeMs)` (600ms
  cycle, NaN/negative guarded to 0) and `PendingToolMessage.tsx` (`height={1}`,
  2-column glyph slot, `wrap="truncate-end"`, leaf subscription to spinnerStore).
- `stripLeadingToolGlyph` handles canonical `● spawn_agent(...)`, no-glyph, empty and
  blank-first-line inputs (fallback `tool`). The component never reads `lines.slice(1)`,
  structurally guaranteeing child details cannot affect height.
- TDD: blink test RED (module missing) -> GREEN (4 tests); component tests cover
  single row, truncation, Chinese double-width, no-glyph, empty, active=false forced
  visible, and blink-changes-only-glyph.

### Task 2: stable indicator wired into Inline V2

- Replaced `<MessageLine>` for pending tools with `<PendingToolMessage>`.
- Row accounting changed to `pendingToolsRowCount = pendingTools.length` (exact
  invariant; no more `lines.length` estimate).
- Audit confirmed `flatten-messages.ts` / `row-text-map.ts` skip `!finalized`, so
  pending height no longer leaks into selection row mapping.
- TDD: dynamic->static migration, 4-way parallel, mid-blink resolve, active=false
  resolve all green (33 inline-app-v2 tests); spinner clock isolation unchanged.

### Task 3: removed child tool details from the main pipeline

- Deleted the entire live-progress bridge introduced in the first round:
  `SubagentProgressEvent`, `SubagentProgressBridge`, `subagent_tool_progress` block,
  `BlockPipeline.subagentProgress`, `formatSubagentProgressLine`, `summarizeSingleLine`,
  `PipelineRenderer.updateToolProgress`, `MessagesState.updatePendingToolProgress`,
  `TuiMessage.originalCallLines`, `parentToolUseId`/`onProgress` options, and the
  UI-only `ToolExecutionContext` (executor signature restored to `(input) => Promise<string>`).
- Preserved: outer `tool_call/tool_result` lifecycle, `resolvePendingTool()`,
  `formatSubagentResult()` status prefix, reserved final summary turn, explicit
  delegation prompt rule.
- `ToolExecutionContext` consumer audit (Step 0) confirmed only UI-progress readers;
  post-deletion grep found zero dangling references to any removed symbol.
- Net: -680 lines of bridge code; +53 lines of stable-indicator code.
- TDD: "hidden child progress" suite asserts evidence counts (3 tools) stay correct
  while no `read_file/run_bash` appears in the pending message; pipeline integration
  re-locked to outer pending lifecycle only.

### Task 4: verification

- Affected suite: 11 files, 168 tests passed (pending indicator, inline-app-v2,
  spinner clock, messages-store, pipeline-integration, block-pipeline,
  subagent-result-integrity, role-agents, streaming-query, explicit-delegation,
  pipeline-adapter).
- TypeScript: `npm run typecheck` passed.
- Full suite: 1866 passed, 7 failed, 2 skipped. All 7 failures are baseline or flaky:
  - `layout.test.tsx` (2): pre-existing ANSI/status-bar assertions (confirmed on
    `28454f7`, the commit before this round).
  - `task-tool.test.ts` (2): pre-existing fixture `clientProvider is not a function`
    (confirmed on `28454f7`).
  - `history.test.ts` (2): flaky file-I/O race (29/29 pass when run in isolation).
  - `incremental-rendering.test.tsx` (1): flaky spinner-tick timing (6/6 pass in
    isolation).
- Lint: project baseline red (54 errors / 68 warnings in unrelated files). Scoped
  ESLint over all 15 changed source files reports only the 3 pre-existing issues
  (`COMMAND_NAMES`, `overlayVisible`, one unused eslint-disable) — none introduced.
- Build source: `D:/Files/Projects/mi-code/.worktrees/auto-0025`, branch
  `codex/auto-0025`, HEAD `5ed7723` (after Task 3 commit).
- Manual terminal scenario: pending real interactive LLM run; automated coverage
  (fixed one row, blink glyph only, no child details, finalized cleanup) is green
  via the suites above.
