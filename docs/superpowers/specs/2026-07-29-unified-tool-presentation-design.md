# Unified Tool Presentation and Transcript Model Design

**Date:** 2026-07-29  
**Status:** Approved in discussion  
**Scope:** Phase 1 data-path unification and read-only tool output reduction

## 1. Goal

Make the terminal transcript quieter and more professional without hiding information from the agent or changing unrelated UI behavior.

Phase 1 will:

- aggregate adjacent calls to the same read-only tool;
- show a compact summary for each call instead of expanding raw result lists;
- retain structured details for a future expand/collapse interaction;
- replace renderer-side tool-name string parsing with typed presentation data;
- give Ask its own transcript type instead of disguising it as an agent completion;
- separate append-only transcript records, mutable activity items, and footer state.

Phase 1 will not add interactive expansion, infer display behavior from the user's prompt, aggregate tools with side effects, or redesign existing Ask/Read styling.

## 2. User-facing behavior

Adjacent calls to the same groupable tool render as one block:

```text
● Searched 4 patterns
  ⎿ src/tui/**/*.test.ts → 11 files
  ⎿ src/render/**/*.test.ts → 2 files
  ⎿ src/**/*.spec.ts → no matches
  ⎿ src/**/protected/*.ts → failed: permission denied
  ⎿ Thought 3s (2 entries)
```

Rules:

- Only adjacent calls with the same normalized tool name are grouped.
- Different parameters do not break a group.
- Assistant text, user text, Ask, a different tool, or a real system notification ends the group.
- Thinking summaries are transparent to grouping.
- Turn-duration records remain associated with the same turn and do not visually split the preceding group.
- A tool-level error remains in its group and is sorted to the bottom of that group's display.
- A pipeline or presentation-system failure ends the group and uses a safe generic fallback.
- Store order remains unchanged; success/empty/error ordering is a display-only projection.
- If there is one thinking summary shorter than two seconds, its metadata line is omitted.
- One thinking summary of at least two seconds renders as `Thought Ns`.
- Multiple thinking summaries render as their summed duration plus entry count.

The agent still receives complete tool results. UI summarization never truncates the data available to agent reasoning.

If the user explicitly asks to list all files, the assistant response supplies the list. The renderer does not inspect natural-language prompts to decide whether tool logs should expand.

## 3. Phase boundaries

### Phase 1

- Add structured transcript and activity types.
- Add synchronous tool-presentation construction after tool call/result pairing.
- Store both summary and structured details.
- Aggregate adjacent calls for a fixed whitelist of read-only tools.
- Render summaries, with empty/error differentiation and errors last.
- Preserve details in memory without providing an expansion interaction.
- Migrate Ask and Read to typed paths.
- Remove renderer tool-name string matching.
- Preserve existing Ask and Read symbols, indentation, colors, and established visual contracts.

### Phase 2

Phase 2 begins only after:

- Phase 1 types have remained stable through real usage;
- summary formats cover the common tool-result shapes;
- actual usage confirms which details users need to expand.

Phase 2 may add keyboard expansion and focus state without changing the Phase 1 presentation data contract.

## 4. Lifecycle model

The current generic `TuiMessage` combines permanent transcript records and mutable activity. Phase 1 separates them by lifecycle.

```ts
type TranscriptBlock =
  | UserBlock
  | AssistantBlock
  | ToolBlock
  | AskBlock
  | SystemBlock
  | TurnDurationBlock;

type ActivityItem =
  | StreamingAssistant
  | PendingTool
  | PendingThinking;

interface StatusBarData {
  // Existing footer fields remain unchanged.
}
```

### TranscriptBlock

- append-only;
- finalized;
- rendered through Ink `<Static>`;
- retained in terminal scrollback.

### ActivityItem

- mutable while work is in progress;
- rendered in the active terminal region;
- completed through one exhaustive transition function;
- never inferred from combinations of role, kind, and finalized flags.

### StatusBarData

- remains in its independent footer store;
- does not enter transcript grouping or message lifecycle logic.

Runtime transitions use a discriminated-union switch with an `assertNever` default. A conditional helper type may document mappings, but it does not replace runtime exhaustiveness.

Expected completion mappings:

- `StreamingAssistant` → `AssistantBlock`
- `PendingTool` → `ToolBlock`
- `PendingThinking` → `SystemBlock` with `subkind: 'thinking-summary'`

For a groupable tool, one `PendingTool` represents one logical adjacent group and contains one or more invocation entries. The corresponding `ToolBlock` contains the same settled entries. An ungroupable tool is the same shape with exactly one entry. This preserves the required 1:1 activity-to-transcript transition without pretending each invocation must become an independent terminal block.

Thinking completion is one deterministic transaction: remove the pending activity, retain the existing expandable thinking detail, and defer its summary until the next semantic block determines ownership. If the next block is a matching groupable tool, the summary becomes `ToolBlock.thinking` metadata and no independent `SystemBlock` is appended. Otherwise it is appended as its own transparent `SystemBlock`. Phase 1 does not change the current thinking disclosure policy outside aggregated tool groups.

## 5. Transcript types

### Tool presentation

```ts
interface ToolPresentation {
  toolUseId: string;
  toolName: string;
  summary: string;
  details: DetailItem[];
  status: 'success' | 'empty' | 'error';
  errorMessage?: string;
  layout?: 'standard' | 'compact-completion';
}

interface ToolBlock {
  kind: 'tool';
  toolName: string;
  presentations: ToolPresentation[];
  thinking: ThinkingGroupMetadata[];
}

interface PendingTool {
  kind: 'pending-tool';
  toolName: string;
  entries: PendingToolEntry[];
  thinking: ThinkingGroupMetadata[];
  closed: boolean;
}

type DetailItem =
  | { kind: 'path'; path: string }
  | { kind: 'location'; path: string; line?: number; column?: number }
  | { kind: 'snippet'; text: string; path?: string; line?: number }
  | { kind: 'text'; text: string };
```

`ToolBlock` owns one or more `ToolPresentation` values; it does not encode bullets, child glyphs, terminal indentation, or ANSI colors.

`layout` is a semantic presentation variant, not a terminal-format string. `standard` is the default. `compact-completion` preserves the existing single-line truncation contract for completion-style tools such as `spawn_agent` without making the renderer match on a tool name.

`PendingTool.closed` means that the logical group accepts no additional invocations. A groupable tool starts open and becomes closed when a boundary arrives. An ungroupable tool starts closed because its single invocation must never accept a neighbor, even though its result may still be pending.

Phase 1 uses a fixed whitelist:

```ts
const GROUPABLE_TOOLS = new Set([
  'glob',
  'grep',
  'read_file',
]);

const TOOL_ALIASES = {
  search: 'glob',
  read: 'read_file',
} as const;
```

`normalizeToolName()` applies `TOOL_ALIASES` before the whitelist lookup and before comparing adjacent calls. The canonical set therefore contains three entries; `search` and `read` remain groupable through normalization. Tools outside the canonical whitelist retain independent blocks even when adjacent and identically named.

### Ask

`AskBlock` owns the existing structured Ask presentation. It no longer uses the `agent-completion` kind. Phase 1 preserves its current parent line, child lines, glyphs, indentation, colors, and cancellation/feedback variants.

```ts
buildAskBlock(id: string, result: unknown): AskBlock | null
```

The builder validates the runtime value, reuses `buildAskUserPresentation()`, and returns `null` for unsupported versions or malformed submitted/cancelled/chat outcomes so the pipeline can use its generic non-grouped fallback.

### System records

```ts
type SystemBlock =
  | {
      kind: 'system';
      subkind: 'thinking-summary';
      text: string;
      groupBoundary: 'transparent';
      expandableId?: string;
      durationMs: number;
    }
  | {
      kind: 'system';
      subkind: 'notification';
      text: string;
      groupBoundary: 'break';
    };
```

Using literal `groupBoundary` values prevents contradictory combinations such as a non-breaking notification.

`TurnDurationBlock` remains independent because it owns structured duration and completion-verb data and has specialized rendering:

```ts
interface TurnDurationBlock {
  id: string;
  kind: 'turn-duration';
  durationMs: number;
  verb: TurnCompletionVerb;
  prependBlankLine: boolean;
}
```

`TurnCompletionVerb` reuses the existing project type and its current rotating completion labels. `prependBlankLine` preserves the current specialized spacing contract without storing a preformatted blank `FormattedLine`. `UserBlock` is an unconditional hard group boundary, preventing grouping across user turns.

## 6. Data flow and integration point

The new presentation adapter is independent of `formatSubagentResult()`. That function is specific to subagents and is not a general tool-output boundary.

```text
tool_call + tool_result
        ↓ pair by toolUseId
BlockPipeline
        ↓ synchronous pure conversion
ToolPresentationAdapter
        ↓
ToolPresentation
        ↓
open PendingTool group
        ↓ boundary closes group, all entries settle
messagesStore completes PendingTool → ToolBlock in place
        ↓
TranscriptBlock rendering
        ↓
renderer
```

The adapter runs synchronously after `BlockPipeline` has both call input and result output. It must not subscribe asynchronously to store writes.

This guarantees:

- deterministic ordering;
- no transient raw-message frame before summary replacement;
- no subscription race or duplicate consumption;
- pure-function unit tests;
- a store containing semantic data rather than parsed display strings.

Presentation failures must not alter tool execution or lifecycle results. They fall back to a generic structured presentation. The fallback is safe, readable, and never relies on `[object Object]`.

## 7. Grouping algorithm

Grouping happens before transcript finalization; it never inspects rendered text.

This ordering is required by Ink `<Static>`: once a finalized transcript item has been written to scrollback, a later result cannot replace it with a larger group. Groupable calls therefore accumulate in one mutable `PendingTool`. The store converts that activity item in place to one append-only `ToolBlock` only after the group boundary is known and every member has settled.

For each groupable tool call:

1. Reuse the current open `PendingTool` when its normalized tool name matches.
2. Otherwise close the current group and start a new `PendingTool`.
3. Transparent thinking summaries immediately preceding or between matching calls attach to that group as metadata. If the next semantic block is not a matching groupable tool, the summary completes as its own `SystemBlock`.
4. Close the current group at:
   - user or assistant content;
   - Ask;
   - a different tool;
   - an ungroupable tool;
   - a system notification;
   - an unknown block type;
   - a presentation/pipeline integrity failure.
5. A turn-duration event closes any still-open group before appending its independent `TurnDurationBlock`.
6. Closing a group with unresolved entries leaves it as a closed `PendingTool` at its original timeline position. It does not create a fallback or call `completeActivity()` until the expected results arrive.
7. When a closed group has no unresolved entries, atomically complete its `PendingTool` as one `ToolBlock`.
8. Render successful entries first, then empty entries, then errors.
9. Preserve invocation ordering within each status class.
10. Aggregate attached thinking duration and entry count into one group-tail metadata row.

Single groupable calls use the same typed presentation path. The renderer may use a singular title, but it does not fall back to the legacy formatted-line model.

### Thinking metadata rendering contract

Thinking metadata attached to a `ToolBlock` remains stored regardless of whether it produces a visible row. The display projection is:

```ts
summarizeThinking(entries: readonly ThinkingGroupMetadata[]): string | null
```

- no entries → `null`;
- exactly one entry below 2,000 ms → `null`, while the entry remains in `ToolBlock.thinking`;
- exactly one entry at or above 2,000 ms → `Thought Ns`;
- two or more entries → `Thought Ns (M entries)`, using summed duration and entry count even when an individual entry is below 2,000 ms.

Therefore one 1-second entry followed by one 2-second entry is stored as two metadata entries and renders as `Thought 3s (2 entries)`. Attached entries never also appear as independent thinking-summary `SystemBlock` values.

## 8. Rendering ownership

The renderer becomes the only owner of:

- `●`;
- `⎿`;
- indentation;
- terminal-width wrapping;
- status color;
- physical blank lines.

Formatters and presentation adapters produce semantic text and structured details, not terminal glyphs.

Phase 1 removes:

- `● Read(...)` string recognition;
- Ask's `agent-completion` disguise;
- tool-specific parsing inside the renderer.

Assistant continuation remains renderer-derived in Phase 1 because changing streaming text representation is outside the requested scope. Its existing output and tests remain unchanged.

## 9. Error behavior

Tool-result statuses:

- `success`: normal summary;
- `empty`: explicit `no matches` or equivalent empty summary;
- `error`: explicit failure summary and error styling.

Tool errors do not break a same-tool group. System/integrity failures do.

Sensitive error fields continue to use the existing safe unknown-error formatter. Raw secrets, stacks, and `[object Object]` must not enter summaries or details.

Unknown tools use a generic non-grouped `ToolPresentation` rather than a renderer string heuristic.

## 10. Testing strategy

Development follows RED → GREEN → REFACTOR.

### Characterization protection

Before migration:

- capture Ask parent/child terminal output;
- capture existing Read aggregate output;
- capture assistant continuation;
- capture pending-tool completion transitions;
- capture thinking summary and turn-duration placement.

### Unit tests

- tool-specific presentation builders;
- structured details for path, location, snippet, and text;
- success/empty/error classification;
- safe fallback behavior;
- tool-name normalization and whitelist checks;
- exhaustive activity completion;
- group boundary decisions;
- error-last stable ordering;
- thinking duration aggregation and the single-entry threshold.

### Integration tests

- `BlockPipeline` pairing → presentation adapter → store;
- pending tool → finalized `ToolBlock`;
- Ask outcome → `AskBlock`;
- Read result → typed `ToolPresentation`;
- no renderer tool-name string matching;
- no Ask `agent-completion` kind;
- groups split by user/assistant/Ask/different tool/notification;
- thinking summaries remain transparent.

### Terminal tests

- adjacent glob/grep/read summaries;
- errors and empty results;
- unchanged Ask rendering;
- unchanged Read visual contract;
- unchanged assistant wrapping;
- unchanged thinking and turn-duration rendering outside aggregated groups;
- no extra blank lines or duplicate tool headings.

All existing UI tests must pass. Tests covering intentionally replaced legacy internals may be migrated only when their visible output assertion remains equivalent or when the approved aggregation output is the explicit new behavior.

## 11. Acceptance criteria

- Adjacent calls to the same whitelisted read-only tool render as one group.
- Parameter differences do not break a same-tool group.
- Assistant/user/Ask/different-tool/notification blocks end a group.
- Thinking summaries do not end a group and render as aggregated group-tail metadata.
- Tool failures remain visible, styled as errors, and sort after normal/empty entries.
- Complete details remain available to the agent and stored for Phase 2.
- Ask uses `AskBlock`, with current terminal output unchanged.
- Read uses `ToolPresentation`, with no renderer string matching.
- Renderer contains no tool-name pattern matching.
- Store contains no Ask-as-agent-completion disguise.
- Activity completion is exhaustive and deterministic.
- Footer state remains independent.
- Existing non-targeted UI behavior and visual tests do not regress.
- Phase 1 introduces no expansion keybinding, prompt-intent inference, or aggregation of side-effecting tools.
