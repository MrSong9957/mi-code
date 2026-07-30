# Unified Tool Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace string-shaped TUI messages with lifecycle-safe transcript/activity types and aggregate adjacent read-only tool calls into concise, structured summaries.

**Architecture:** `BlockPipeline` continues to pair tool calls and results by `toolUseId`, then synchronously builds semantic presentations. A reducer keeps adjacent groupable calls in one mutable `PendingTool` and completes it in place as one append-only `ToolBlock`; Ink receives already-finalized transcript blocks and never performs tool-name string matching. Ask becomes its own `AskBlock`, while footer state remains independent.

**Tech Stack:** Node.js 18+, TypeScript 6 strict/NodeNext/ESM, Zustand vanilla stores, React 19, Ink 7, Vitest 3, ink-testing-library.

## Global Constraints

- Follow RED → GREEN → REFACTOR. Do not write production behavior before observing the intended test fail.
- Do not add dependencies.
- Do not modify tool schemas, provider behavior, Agent API history, prompt files, or generated prompt files.
- Tool executors and Agent reasoning must continue receiving complete raw results; summarization is UI-only.
- Phase 1 supports typed details but no expand/collapse keybinding, focus state, or prompt-intent inference.
- Only `glob`, `search`, `grep`, `read_file`, and `read` are groupable; all side-effecting, lifecycle, and interaction tools remain independent.
- Same normalized tool name plus adjacency defines a group. Parameter differences do not.
- Tool-level `empty` and `error` statuses stay in the group; pipeline/presentation integrity failures close it and use a safe fallback.
- Thinking summaries are transparent and aggregate into group-tail metadata. User, assistant, Ask, a different/ungroupable tool, and system notifications close the group.
- Ask and existing Read visual contracts must remain unchanged except for the explicitly approved read-only summary aggregation.
- The renderer owns bullets, child glyphs, indentation, wrapping, colors, and blank lines. It must not identify tools by parsing rendered strings.
- Preserve the existing `TurnCompletionVerb`; do not replace it with a new verb enum.
- Preserve the existing expandable thinking/tool detail registry and hook visibility.
- Do not commit unless the user explicitly authorizes commits. Commit commands below are checkpoints to execute only after that authorization.
- File line ranges are snapshot navigation hints, not patch coordinates. Before each task, re-read the named symbol/function in the current worktree and anchor edits by symbol name because earlier tasks will shift later line numbers.

## Wheel Reuse Check

- Reuse `formatUnknownError()` from `src/utils/error-message.ts` for fallback diagnostics.
- Reuse `buildAskUserPresentation()` from `src/ui/ask-user-presentation.ts`; change only its delivery type.
- Reuse `buildSubagentCompletionPresentation()` from `src/ui/subagent-presentation.ts`.
- Reuse `ExpandableBlockStore`; do not create a second details registry in Phase 1.
- Reuse `renderFinalizedLine()` and `wrapStreamingText()` for unchanged assistant/system physical-line layout.
- Reuse `TurnCompletionVerb`, `formatSpinnerDuration()`, theme tokens, and existing pending glyph behavior.
- Do not reuse `groupConsecutiveReadMessages()`: it depends on rendered strings and cannot safely rewrite already-emitted Ink `<Static>` items.

## Core Anchor Function

The core anchor is:

```ts
buildToolPresentation(input: BuildToolPresentationInput): ToolPresentation
```

It has a complete input (`toolUseId`, name, call input, raw output) and a deterministic semantic output. `BlockPipeline` calls it only after call/result pairing; the store reducer then determines whether that presentation completes a single block or one member of an adjacent group.

---

### Task 1: Introduce the transcript and activity type system

**Files:**
- Create: `src/tui/transcript-types.ts`
- Create: `src/__tests__/tui/transcript-types.test.ts`
- Modify: `src/tui/types.ts:14-36`
- Modify: `src/tui/state/turn-duration-message.ts:12-50`

**Interfaces:**
- Consumes: existing `StructuredAskResult`, `FormattedLine`, `TurnCompletionVerb`.
- Produces: `TranscriptBlock`, `ActivityItem`, `TimelineItem`, `ToolPresentation`, `DetailItem`, `completeActivity()`, and exhaustive type guards used by later tasks.

- [ ] **Step 1: Write the failing type/lifecycle test**

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  completeActivity,
  isActivityItem,
  isTranscriptBlock,
  type AskBlock,
  type PendingThinking,
  type PendingTool,
  type StreamingAssistant,
  type ToolBlock,
} from '../../tui/transcript-types.js';

describe('transcript lifecycle types', () => {
  it('maps each activity kind to one deterministic transcript kind', () => {
    const assistant: StreamingAssistant = {
      id: 'a1', kind: 'streaming-assistant', text: 'hello',
    };
    expect(completeActivity(assistant)).toMatchObject({
      id: 'a1', kind: 'assistant', text: 'hello',
    });

    const tool: PendingTool = {
      id: 't1',
      kind: 'pending-tool',
      toolName: 'glob',
      closed: true,
      entries: [{
        toolUseId: 'u1',
        input: { pattern: '*.ts' },
        presentation: {
          toolUseId: 'u1',
          toolName: 'glob',
          summary: '*.ts → 2 files',
          details: [],
          status: 'success',
        },
      }],
      thinking: [],
    };
    expect(completeActivity(tool)).toMatchObject({
      id: 't1', kind: 'tool', toolName: 'glob',
    });

    const thinking: PendingThinking = {
      id: 'th1',
      kind: 'pending-thinking',
      text: 'private reasoning',
      summary: 'Thought for 2s',
      durationMs: 2_000,
    };
    expect(completeActivity(thinking)).toMatchObject({
      id: 'th1',
      kind: 'system',
      subkind: 'thinking-summary',
      groupBoundary: 'transparent',
    });
  });

  it('exposes disjoint runtime guards', () => {
    const ask: AskBlock = {
      id: 'q1',
      kind: 'ask',
      summary: 'Answered 1 question',
      items: ['Auth → OAuth'],
    };
    expect(isTranscriptBlock(ask)).toBe(true);
    expect(isActivityItem(ask)).toBe(false);
    expectTypeOf<ToolBlock['presentations']>().toMatchTypeOf<
      readonly { toolUseId: string }[]
    >();
  });
});
```

- [ ] **Step 2: Run the test and observe RED**

Run:

```bash
npx vitest run src/__tests__/tui/transcript-types.test.ts
```

Expected: FAIL because `src/tui/transcript-types.ts` does not exist.

- [ ] **Step 3: Add the minimal discriminated unions**

Define these exact public shapes in `src/tui/transcript-types.ts`:

```ts
import type { StructuredAskResult } from '../agent/ask-user-types.js';
import type { TurnCompletionVerb } from './state/turn-duration-message.js';

export type ToolPresentationStatus = 'success' | 'empty' | 'error';

export type DetailItem =
  | { kind: 'path'; path: string }
  | { kind: 'location'; path: string; line?: number; column?: number }
  | { kind: 'snippet'; text: string; path?: string; line?: number }
  | { kind: 'text'; text: string };

export interface ToolPresentation {
  toolUseId: string;
  toolName: string;
  summary: string;
  details: DetailItem[];
  status: ToolPresentationStatus;
  errorMessage?: string;
  layout?: 'standard' | 'compact-completion';
}

export interface ThinkingGroupMetadata {
  durationMs: number;
  expandableId?: string;
}

export interface PendingToolEntry {
  toolUseId: string;
  input: Record<string, unknown>;
  presentation?: ToolPresentation;
}

export interface UserBlock {
  id: string;
  kind: 'user';
  text: string;
}

export interface AssistantBlock {
  id: string;
  kind: 'assistant';
  text: string;
  interrupted?: boolean;
}

export interface ToolBlock {
  id: string;
  kind: 'tool';
  toolName: string;
  presentations: ToolPresentation[];
  thinking: ThinkingGroupMetadata[];
}

export interface AskBlock {
  id: string;
  kind: 'ask';
  summary: string;
  items: string[];
  outcome?: StructuredAskResult['outcome'];
}

export type SystemBlock =
  | {
      id: string;
      kind: 'system';
      subkind: 'thinking-summary';
      text: string;
      durationMs: number;
      groupBoundary: 'transparent';
      expandableId?: string;
    }
  | {
      id: string;
      kind: 'system';
      subkind: 'notification';
      text: string;
      groupBoundary: 'break';
      tone?: 'normal' | 'error';
    };

export interface TurnDurationBlock {
  id: string;
  kind: 'turn-duration';
  durationMs: number;
  verb: TurnCompletionVerb;
  prependBlankLine: boolean;
}

export interface StreamingAssistant {
  id: string;
  kind: 'streaming-assistant';
  text: string;
  interrupted?: boolean;
}

export interface PendingTool {
  id: string;
  kind: 'pending-tool';
  toolName: string;
  entries: PendingToolEntry[];
  thinking: ThinkingGroupMetadata[];
  closed: boolean;
}

export interface PendingThinking {
  id: string;
  kind: 'pending-thinking';
  text: string;
  summary?: string;
  durationMs?: number;
  expandableId?: string;
}

export type TranscriptBlock =
  | UserBlock
  | AssistantBlock
  | ToolBlock
  | AskBlock
  | SystemBlock
  | TurnDurationBlock;

export type ActivityItem =
  | StreamingAssistant
  | PendingTool
  | PendingThinking;

export type TimelineItem = TranscriptBlock | ActivityItem;
```

Implement `completeActivity()` with overloads and an exhaustive switch. Reject an open or unresolved `PendingTool`, and reject a `PendingThinking` without summary/duration:

```ts
export function completeActivity(item: StreamingAssistant): AssistantBlock;
export function completeActivity(item: PendingTool): ToolBlock;
export function completeActivity(item: PendingThinking): SystemBlock;
export function completeActivity(item: ActivityItem): TranscriptBlock {
  switch (item.kind) {
    case 'streaming-assistant':
      return { id: item.id, kind: 'assistant', text: item.text, interrupted: item.interrupted };
    case 'pending-tool': {
      if (!item.closed || item.entries.some(entry => !entry.presentation)) {
        throw new Error('Cannot complete an open or unresolved PendingTool');
      }
      return {
        id: item.id,
        kind: 'tool',
        toolName: item.toolName,
        presentations: item.entries.map(entry => entry.presentation!),
        thinking: item.thinking,
      };
    }
    case 'pending-thinking':
      if (item.summary === undefined || item.durationMs === undefined) {
        throw new Error('Cannot complete PendingThinking without summary metadata');
      }
      return {
        id: item.id,
        kind: 'system',
        subkind: 'thinking-summary',
        text: item.summary,
        durationMs: item.durationMs,
        expandableId: item.expandableId,
        groupBoundary: 'transparent',
      };
    default:
      return assertNever(item);
  }
}
```

- [ ] **Step 4: Reuse the new `TurnDurationBlock` shape**

Keep `TurnDurationMessage()` unchanged for now, but make `createTurnDurationMessage()` reuse `TurnCompletionVerb` and expose a conversion helper:

```ts
interface CreateTurnDurationMessageInput {
  uuid: string;
  durationMs: number;
  prependBlankLine: boolean;
  random?: () => number;
}

export function createTurnDurationBlock(
  input: CreateTurnDurationMessageInput,
): TurnDurationBlock
```

`uuid` maps to `TurnDurationBlock.id`; `durationMs` and `prependBlankLine` copy through; `random` retains the existing deterministic-test seam for selecting a `TurnCompletionVerb`. Do not change the randomly selected verb or visible text in this task.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npx vitest run src/__tests__/tui/transcript-types.test.ts src/__tests__/tui/turn-duration-message.test.ts
npm run typecheck
```

Expected: both test files PASS and typecheck exits 0.

- [ ] **Step 6: Commit checkpoint if authorized**

```bash
git add src/tui/transcript-types.ts src/tui/types.ts src/tui/state/turn-duration-message.ts src/__tests__/tui/transcript-types.test.ts
git commit -m "refactor: define transcript lifecycle types"
```

---

### Task 2: Build structured tool presentations

**Files:**
- Create: `src/ui/tool-presentation.ts`
- Create: `src/__tests__/ui/tool-presentation.test.ts`
- Modify: `src/ui/subagent-presentation.ts:68-116`
- Reuse: `src/utils/error-message.ts`

**Interfaces:**
- Consumes:

```ts
interface BuildToolPresentationInput {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  durationMs?: number;
}
```

- Produces:

```ts
buildToolPresentation(input: BuildToolPresentationInput): ToolPresentation
normalizeToolName(name: string): string
isGroupableTool(name: string): boolean
buildToolGroupTitle(name: string, count: number): string
```

- [ ] **Step 1: Write failing behavior tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildToolGroupTitle,
  buildToolPresentation,
  isGroupableTool,
  normalizeToolName,
} from '../../ui/tool-presentation.js';

describe('buildToolPresentation', () => {
  it('summarizes glob output and retains every path', () => {
    const result = buildToolPresentation({
      toolUseId: 'g1',
      toolName: 'glob',
      input: { pattern: 'src/**/*.test.ts' },
      output: 'src/a.test.ts\nsrc/b.test.ts',
    });
    expect(result).toMatchObject({
      status: 'success',
      summary: 'src/**/*.test.ts → 2 files',
    });
    expect(result.details).toEqual([
      { kind: 'path', path: 'src/a.test.ts' },
      { kind: 'path', path: 'src/b.test.ts' },
    ]);
  });

  it('distinguishes empty and error results', () => {
    expect(buildToolPresentation({
      toolUseId: 'g0', toolName: 'glob',
      input: { pattern: '*.none' }, output: '',
    })).toMatchObject({ status: 'empty', summary: '*.none → no matches' });

    expect(buildToolPresentation({
      toolUseId: 'g2', toolName: 'glob',
      input: { pattern: 'protected/**' },
      output: 'Error: permission denied',
    })).toMatchObject({
      status: 'error',
      summary: 'protected/** → failed: permission denied',
      errorMessage: 'permission denied',
    });
  });

  it('parses grep locations without discarding snippets', () => {
    const result = buildToolPresentation({
      toolUseId: 'p1',
      toolName: 'grep',
      input: { pattern: 'TODO', path: 'src' },
      output: 'src/a.ts:12: TODO fix\nsrc/b.ts:3: TODO test',
    });
    expect(result.summary).toBe('TODO in src → 2 matches');
    expect(result.details[0]).toEqual({
      kind: 'snippet', path: 'src/a.ts', line: 12, text: 'TODO fix',
    });
  });

  it('uses read input as semantic identity and retains raw detail', () => {
    const result = buildToolPresentation({
      toolUseId: 'r1',
      toolName: 'read_file',
      input: { path: 'src/index.ts', limit: 20 },
      output: '1: import x\n2: export y',
    });
    expect(result).toMatchObject({
      status: 'success',
      summary: 'src/index.ts',
    });
    expect(result.details).toEqual([
      { kind: 'text', text: '1: import x\n2: export y' },
    ]);
  });

  it('normalizes aliases and keeps side-effecting tools ungroupable', () => {
    expect(normalizeToolName('read')).toBe('read_file');
    expect(normalizeToolName('search')).toBe('glob');
    expect(isGroupableTool('read')).toBe(true);
    expect(isGroupableTool('run_bash')).toBe(false);
    expect(buildToolGroupTitle('glob', 4)).toBe('Searched 4 patterns');
    expect(buildToolGroupTitle('read_file', 2)).toBe('Read 2 items');
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run src/__tests__/ui/tool-presentation.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the whitelist and status classifier**

Use an internal fixed set:

```ts
const GROUPABLE_TOOLS = new Set(['glob', 'grep', 'read_file']);
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  read: 'read_file',
  search: 'glob',
};
```

Classification order:

1. `/^\s*Error:\s*/i` → `error`;
2. trimmed empty output → `empty`;
3. otherwise → `success`.

Strip only the leading `Error:` marker for `errorMessage`; pass unexpected thrown values through `formatUnknownError()`.

- [ ] **Step 4: Implement the tool-specific pure builders**

Implement private builders:

```ts
buildGlobPresentation(...)
buildGrepPresentation(...)
buildReadPresentation(...)
buildGenericPresentation(...)
```

Requirements:

- Glob counts non-empty output lines and stores them as `{kind:'path'}`.
- Grep parses `path:line: text` from the right contract used by `search-tools.ts`; retain unparseable/truncation lines as `{kind:'text'}`.
- Read uses `input.path` for its visible summary and stores output as one text detail.
- Generic tools remain non-groupable and use `summarizeOutput()` for a safe one-line summary.
- `spawn_agent` reuses `buildSubagentCompletionPresentation()` and marks the result `layout: 'compact-completion'`.
- Never emit bullets, child glyphs, indentation, ANSI, stacks, or `[object Object]`.

- [ ] **Step 5: Add malformed-value and sensitive-error tests**

Add:

```ts
  it('falls back safely when a presentation builder receives malformed values', () => {
  const result = buildToolPresentation({
    toolUseId: 'bad',
    toolName: 'glob',
    input: { pattern: { unexpected: true } },
    output: 'Error: {"apiKey":"secret","message":"denied"}',
  });
  expect(result.status).toBe('error');
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(JSON.stringify(result)).not.toContain('[object Object]');
});
```

Use the existing error redaction utility rather than adding another sensitive-field regex.
For an error payload whose stripped body begins with `{` or `[`, attempt `JSON.parse()` and pass the parsed value to `formatUnknownError()` so the existing object-field redaction applies. If parsing fails, pass the plain string to `formatUnknownError()` without inventing a second redaction implementation.

- [ ] **Step 6: Run focused tests**

```bash
npx vitest run src/__tests__/ui/tool-presentation.test.ts src/__tests__/ui/message-formatter.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit checkpoint if authorized**

```bash
git add src/ui/tool-presentation.ts src/ui/subagent-presentation.ts src/__tests__/ui/tool-presentation.test.ts
git commit -m "feat: add structured tool presentations"
```

---

### Task 3: Implement the lifecycle-safe timeline reducer

**Files:**
- Create: `src/tui/state/transcript-reducer.ts`
- Create: `src/__tests__/tui/transcript-reducer.test.ts`
- Modify: `src/tui/transcript-types.ts`

**Interfaces:**
- Consumes: `TimelineItem`, `PendingTool`, `ToolPresentation`, `SystemBlock`.
- Produces:

```ts
interface TranscriptModel {
  items: TimelineItem[];
  deferredThinking: ThinkingSummaryBlock[];
}

type ThinkingSummaryBlock = Extract<
  SystemBlock,
  { subkind: 'thinking-summary' }
>;

type BoundaryBlock = Exclude<TranscriptBlock, ToolBlock>;

interface StartToolInput {
  activityId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

emptyModel(): TranscriptModel
startTool(model: TranscriptModel, call: StartToolInput): TranscriptModel
resolveTool(
  model: TranscriptModel,
  toolUseId: string,
  presentation: ToolPresentation,
): TranscriptModel
closeOpenToolGroup(model: TranscriptModel): TranscriptModel
deferThinking(
  model: TranscriptModel,
  summary: ThinkingSummaryBlock,
): TranscriptModel
flushDeferredThinking(model: TranscriptModel): TranscriptModel
appendBoundaryBlock(
  model: TranscriptModel,
  block: BoundaryBlock,
): TranscriptModel
selectCommittedTranscript(
  items: readonly TimelineItem[],
): TranscriptBlock[]
```

- [ ] **Step 1: Write the failing grouping state-machine tests**

Cover these exact cases:

```ts
function thinkingSummary(durationMs: number): ThinkingSummaryBlock {
  return {
    id: `thinking-${durationMs}`,
    kind: 'system',
    subkind: 'thinking-summary',
    text: `Thought for ${durationMs / 1_000}s`,
    durationMs,
    groupBoundary: 'transparent',
  };
}

function globPresentation(toolUseId: string): ToolPresentation {
  return {
    toolUseId,
    toolName: 'glob',
    summary: `${toolUseId}.ts → 1 file`,
    details: [{ kind: 'path', path: `${toolUseId}.ts` }],
    status: 'success',
  };
}

function pendingTool(
  id: string,
  toolName: string,
  toolUseIds: readonly string[],
): PendingTool {
  return {
    id,
    kind: 'pending-tool',
    toolName,
    closed: false,
    entries: toolUseIds.map(toolUseId => ({
      toolUseId,
      input: { pattern: `${toolUseId}.ts` },
    })),
    thinking: [],
  };
}

function completePendingTool(
  pending: PendingTool,
  presentations: readonly ToolPresentation[],
): ToolBlock {
  if (pending.entries.length !== presentations.length) {
    throw new Error('Fixture presentations must match pending entries');
  }
  return completeActivity({
    ...pending,
    closed: true,
    entries: pending.entries.map((entry, index) => ({
      ...entry,
      presentation: presentations[index]!,
    })),
  });
}

it('adds adjacent same-name calls to one PendingTool despite parameter differences', () => {
  let model = emptyModel();
  model = startTool(model, { activityId: 'tg1', toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' } });
  // The call merges into tg1, so tg2 is intentionally ignored and must not be stored on the entry.
  model = startTool(model, { activityId: 'tg2', toolUseId: 'g2', toolName: 'glob', input: { pattern: '*.json' } });
  expect(model.items).toHaveLength(1);
  expect(model.items[0]).toMatchObject({
    kind: 'pending-tool',
    toolName: 'glob',
    entries: [{ toolUseId: 'g1' }, { toolUseId: 'g2' }],
  });
});

it('closes a group on assistant text or a different tool', () => {
  let model = startTool(emptyModel(), {
    activityId: 'tg1', toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' },
  });
  model = appendBoundaryBlock(model, { id: 'a1', kind: 'assistant', text: 'Now inspect it.' });
  model = startTool(model, {
    activityId: 'tg2', toolUseId: 'g2', toolName: 'glob', input: { pattern: '*.json' },
  });
  expect(model.items.filter(item => item.kind === 'pending-tool')).toHaveLength(2);
});

it('attaches deferred thinking to a matching read-only group', () => {
  let model = deferThinking(emptyModel(), thinkingSummary(1_000));
  model = startTool(model, {
    activityId: 'tg1', toolUseId: 'g1', toolName: 'glob', input: { pattern: '*.ts' },
  });
  expect(model.deferredThinking).toEqual([]);
  expect(model.items[0]).toMatchObject({
    kind: 'pending-tool',
    thinking: [{ durationMs: 1_000 }],
  });
});

it('flushes deferred thinking before non-tool content', () => {
  let model = deferThinking(emptyModel(), thinkingSummary(1_000));
  model = appendBoundaryBlock(model, { id: 'a1', kind: 'assistant', text: 'Done.' });
  expect(model.items.map(item => item.kind)).toEqual(['system', 'assistant']);
});

it('atomically closes a resolved open group before appending a boundary', () => {
  let model = startTool(emptyModel(), {
    activityId: 'tg1',
    toolUseId: 'g1',
    toolName: 'glob',
    input: { pattern: '*.ts' },
  });
  model = resolveTool(model, 'g1', globPresentation('g1'));
  expect(model.items[0]?.kind).toBe('pending-tool'); // resolved but still open

  model = appendBoundaryBlock(model, {
    id: 'a1',
    kind: 'assistant',
    text: 'Done.',
  });
  expect(model.items.map(item => item.kind)).toEqual(['tool', 'assistant']);
});

it('closes but does not complete an unresolved group at a boundary', () => {
  let model = startTool(emptyModel(), {
    activityId: 'tg1',
    toolUseId: 'g1',
    toolName: 'glob',
    input: { pattern: '*.ts' },
  });

  expect(() => {
    model = appendBoundaryBlock(model, {
      id: 'a1',
      kind: 'assistant',
      text: 'Waiting for the result.',
    });
  }).not.toThrow();
  expect(model.items[0]).toMatchObject({
    kind: 'pending-tool',
    closed: true,
    entries: [{ toolUseId: 'g1' }],
  });
  expect(model.items[0]?.kind === 'pending-tool'
    ? model.items[0].entries[0]?.presentation
    : 'wrong-kind').toBeUndefined();
  expect(model.items[1]).toMatchObject({ kind: 'assistant' });
  expect(selectCommittedTranscript(model.items)).toEqual([]);

  model = resolveTool(model, 'g1', globPresentation('g1'));
  expect(model.items.map(item => item.kind)).toEqual(['tool', 'assistant']);
  expect(selectCommittedTranscript(model.items).map(item => item.kind))
    .toEqual(['tool', 'assistant']);
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run src/__tests__/tui/transcript-reducer.test.ts
```

Expected: FAIL because the reducer module does not exist.

- [ ] **Step 3: Implement immutable start/close/resolve transitions**

Implement the exported functions with these contracts:

- `emptyModel()` returns `{items: [], deferredThinking: []}`.
- `startTool()` consumes `deferredThinking`. For a groupable call, it attaches those summaries to the matching open group or the new group it creates. For an ungroupable call, it first flushes the summaries as independent `SystemBlock` values. `activityId` is used only when a new `PendingTool` is created; a merged call keeps the existing group id.
- `resolveTool()` replaces only the matching unresolved entry. An unknown id or a duplicate resolution returns the original model unchanged. A closed group with no unresolved entries completes in place as `ToolBlock`.
- `closeOpenToolGroup()` marks the latest open `PendingTool` closed and completes it immediately if all entries are already resolved.
- `deferThinking()` appends one typed thinking summary to `deferredThinking`; it does not append a transcript item.
- `flushDeferredThinking()` appends all deferred summaries to `items` in arrival order and clears the queue.
- `appendBoundaryBlock()` closes the open group, flushes deferred thinking, then appends the supplied non-tool transcript block. It performs both boundary and append responsibilities atomically.
- Closing an unresolved group does not create a fallback and does not call `completeActivity()` yet. It remains a closed `PendingTool` at its original timeline position until `resolveTool()` settles the final entry, then completes in place.
- `selectCommittedTranscript()` returns the contiguous `TranscriptBlock` prefix ending before the first activity item.

State rules:

- Reuse the last open `PendingTool` only when both names normalize identically and the tool is groupable.
- Starting any different or ungroupable tool closes the previous open group.
- Every ungroupable call creates a closed single-entry `PendingTool`.
- `resolveTool()` finds an entry by `toolUseId`, sets its presentation once, and ignores duplicate completion attempts.
- A closed group converts in place via `completeActivity()` only after all entries have presentations.
- A tool presentation with `status:'error'` still completes normally and does not itself close a matching group.
- A reducer integrity error must return a generic single-call fallback block and close the current group; it must not throw through the UI event loop.

- [ ] **Step 4: Add the Ink append-only ordering test**

```ts
it('withholds later transcript blocks until an earlier activity settles', () => {
  const pending = pendingTool('p1', 'glob', ['g1']);
  const later: AssistantBlock = { id: 'a1', kind: 'assistant', text: 'later' };
  expect(selectCommittedTranscript([pending, later])).toEqual([]);

  const completed = completePendingTool(pending, [globPresentation('g1')]);
  expect(selectCommittedTranscript([completed, later])).toEqual([completed, later]);
});
```

`selectCommittedTranscript()` must return only the contiguous finalized prefix before the first `ActivityItem`. This prevents a later-completing block from entering `<Static>` before an earlier pending group.

- [ ] **Step 5: Add status ordering and thinking metadata projection**

Export pure display helpers:

```ts
orderToolPresentations(
  presentations: readonly ToolPresentation[],
): ToolPresentation[]

summarizeThinking(
  entries: readonly ThinkingGroupMetadata[],
): string | null
```

Tests:

- success retains original relative order;
- empty follows success;
- error follows empty;
- one entry below 2,000 ms returns `null`;
- one entry at 2,000 ms returns `Thought 2s`;
- two entries totaling 3,000 ms return `Thought 3s (2 entries)`.

- [ ] **Step 6: Run focused tests**

```bash
npx vitest run src/__tests__/tui/transcript-reducer.test.ts src/__tests__/tui/transcript-types.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit checkpoint if authorized**

```bash
git add src/tui/state/transcript-reducer.ts src/tui/transcript-types.ts src/__tests__/tui/transcript-reducer.test.ts
git commit -m "feat: add transcript grouping reducer"
```

---

### Task 4: Cut the store and pipeline adapter over to semantic timeline items

**Files:**
- Modify: `src/tui/state/messages-store.ts:18-300`
- Modify: `src/tui/state/pipeline-adapter.ts:31-170`
- Modify: `src/ui/block-pipeline.ts:24-510`
- Modify: `src/ui/types.ts:71-79`
- Modify: `src/__tests__/tui/messages-store.test.ts`
- Modify: `src/__tests__/tui/pipeline-adapter.test.ts`
- Modify: `src/__tests__/ui/block-pipeline.test.ts`
- Modify: `src/__tests__/ui/thinking-stream.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 `buildToolPresentation()`, Task 3 reducer.
- Produces semantic store actions:

```ts
startTool(call: { toolUseId: string; toolName: string; input: Record<string, unknown> }): string
resolveTool(toolUseId: string, presentation: ToolPresentation): boolean
finishAsk(toolUseId: string, block: AskBlock): boolean
startAssistant(text: string): string
finishAssistant(): void
startThinking(text: string): string
finishThinking(summary: SystemBlock): void
appendTranscript(block: TranscriptBlock): void
closeOpenToolGroup(): void
```

- [ ] **Step 1: Replace line-shaped store expectations with failing semantic expectations**

Add tests asserting:

```ts
store.getState().startTool({
  toolUseId: 'g1',
  toolName: 'glob',
  input: { pattern: '*.ts' },
});
store.getState().resolveTool('g1', buildToolPresentation({
  toolUseId: 'g1', toolName: 'glob',
  input: { pattern: '*.ts' }, output: 'src/a.ts',
}));
store.getState().closeOpenToolGroup();

expect(store.getState().items[0]).toMatchObject({
  kind: 'tool',
  toolName: 'glob',
  presentations: [{ summary: '*.ts → 1 file' }],
});
```

Add an Ask assertion:

```ts
expect(store.getState().items[0]).toMatchObject({
  kind: 'ask',
  summary: 'Answered 1 question',
});
expect(JSON.stringify(store.getState().items[0])).not.toContain('agent-completion');
```

- [ ] **Step 2: Run the store and adapter tests and observe RED**

```bash
npx vitest run src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-adapter.test.ts
```

Expected: FAIL because the semantic actions and `items` state do not exist.

- [ ] **Step 3: Replace `TuiMessage[]` state with the timeline model**

In `messages-store.ts`:

- rename state storage from `messages` to `items`;
- retain `_idCounter` for stable React keys;
- route all state transitions through `transcript-reducer.ts`;
- make `clear()` reset `items` and `deferredThinking`;
- make rewind locate the last `UserBlock`;
- finalize interrupted streaming as an `AssistantBlock` with `interrupted:true`;
- append `TurnDurationBlock` through its existing creator;
- expose `selectCommittedTranscript()` and activity selectors rather than asking components to combine `role/kind/finalized`.

Do not keep a second legacy message array.

- [ ] **Step 4: Change `PipelineRenderer` to semantic operations**

Replace:

```ts
startToolCall(toolUseId, lines)
finishToolCall(toolUseId, lines, finalKind)
```

with:

```ts
startToolCall(call: {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}): void;

finishToolCall(toolUseId: string, presentation: ToolPresentation): boolean;

finishAsk(toolUseId: string, block: AskBlock): boolean;
```

Remove the superseded raw-result overload; `PipelineRenderer` receives only the semantic `ToolPresentation`.

`PipelineToStoreAdapter` becomes a thin synchronous bridge. It must not parse tool output, subscribe to store changes, or generate glyphs.

- [ ] **Step 5: Move presentation construction to the paired-result point**

In `BlockPipeline`:

- keep `BufferedTool.name`, `input`, and `toolUseId`;
- stop storing formatted call/result lines for semantic Ink delivery;
- after pairing, call `buildToolPresentation()` synchronously;
- pass the resulting `ToolPresentation` through `finishToolCall`;
- migrate `user_input` to `UserBlock`, assistant completion to `AssistantBlock`, thinking completion to deferred `SystemBlock`, and system/error output to notification `SystemBlock`;
- attach hook output to the paired tool presentation/expandable detail instead of emitting an independent formatted line;
- on presentation construction failure, log only under `DEBUG`, call the generic safe fallback builder, and close the current group;
- retain expandable registration using `ToolPresentation.details`/existing raw output.

`printMessage` may exist temporarily while editing Step 5, but it is not a retained fallback. Before Step 7, remove it from `PipelineRenderer`, `BlockPipeline`, and `PipelineToStoreAdapter`. Turn duration already uses its typed store action; no production transcript event remains on the legacy formatted-line delivery path at the end of Task 4.

Do not put this logic in `formatSubagentResult()` or in a store subscription.

- [ ] **Step 6: Convert thinking completion into one deterministic transaction**

`thinking_end` must:

1. update the existing `PendingThinking` with summary, duration, and expandable id;
2. call its exhaustive completion path;
3. defer the resulting transparent `SystemBlock`;
4. let the next semantic block either attach it to a matching tool group or flush it independently.

Add tests for empty thinking deltas, duplicate start/end events, and the existing expandable content.

- [ ] **Step 7: Run module tests**

```bash
npx vitest run src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-adapter.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/ui/thinking-stream.test.ts
npm run typecheck
git grep -n "printMessage" -- src/ui src/tui
```

Expected: tests and typecheck PASS; the final `git grep` returns no production UI/TUI matches (exit 1 means no legacy path or stale coupling comment remains).

- [ ] **Step 8: Commit checkpoint if authorized**

```bash
git add src/tui/state/messages-store.ts src/tui/state/pipeline-adapter.ts src/ui/block-pipeline.ts src/ui/types.ts src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-adapter.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/ui/thinking-stream.test.ts
git commit -m "refactor: route pipeline through semantic timeline"
```

---

### Task 5: Give Ask an independent `AskBlock` path

**Files:**
- Modify: `src/ui/ask-user-presentation.ts:14-66`
- Modify: `src/ui/block-pipeline.ts:309-344`
- Modify: `src/tui/state/pipeline-adapter.ts`
- Create: `src/__tests__/ui/ask-block.test.ts`
- Modify: `src/__tests__/ui/ask-user-presentation.test.ts`
- Modify: `src/__tests__/ui/block-pipeline.test.ts`
- Modify: `src/__tests__/tui/inline-v2/ask-user-structured-result-integration.test.ts`

**Interfaces:**
- Consumes: existing `StructuredAskResult`, Task 1 `AskBlock`.
- Produces:

```ts
buildAskBlock(id: string, result: unknown): AskBlock | null
```

- [ ] **Step 1: Write independent failing tests for `buildAskBlock()`**

Create `src/__tests__/ui/ask-block.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildAskBlock } from '../../ui/ask-user-presentation.js';
import type {
  AskQuestionOutcome,
  StructuredAskResult,
} from '../../agent/ask-user-types.js';

function askResult(outcome: AskQuestionOutcome): StructuredAskResult {
  return {
    version: 1,
    request: {
      questions: [{
        header: 'Auth',
        question: 'Which auth?',
        options: [
          { label: 'OAuth', description: 'OAuth' },
          { label: 'Key', description: 'API key' },
        ],
        multiSelect: false,
      }],
    },
    outcome,
  };
}

describe('buildAskBlock', () => {
  it('maps submitted answers to a typed AskBlock', () => {
    expect(buildAskBlock('q1', askResult({
      kind: 'submitted',
      answers: { 'Which auth?': 'OAuth' },
    }))).toEqual({
      id: 'q1',
      kind: 'ask',
      summary: 'Answered 1 question',
      items: ['Auth → OAuth'],
      outcome: {
        kind: 'submitted',
        answers: { 'Which auth?': 'OAuth' },
      },
    });
  });

  it('preserves cancelled presentation semantics', () => {
    expect(buildAskBlock('q2', askResult({ kind: 'cancelled' }))).toMatchObject({
      id: 'q2',
      kind: 'ask',
      summary: 'Declined to answer',
      items: ['User declined to answer questions'],
    });
  });

  it('preserves feedback/chat presentation semantics', () => {
    expect(buildAskBlock('q3', askResult({
      kind: 'chat',
      feedback: 'Use the simpler path',
    }))).toMatchObject({
      id: 'q3',
      kind: 'ask',
      summary: 'Feedback: Use the simpler path',
      items: ['Use the simpler path'],
    });
  });

  it('returns null for unsupported or malformed input', () => {
    expect(buildAskBlock('q4', { version: 2 })).toBeNull();
    expect(buildAskBlock('q5', { version: 1 })).toBeNull();
    expect(buildAskBlock('q6', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the unit test and observe RED**

```bash
npx vitest run src/__tests__/ui/ask-block.test.ts
```

Expected: FAIL because `buildAskBlock()` is not exported.

- [ ] **Step 3: Change the integration expectation to `AskBlock`**

Replace the legacy `finalKind === 'agent-completion'` assertion with:

```ts
expect(store.getState().items).toContainEqual(expect.objectContaining({
  kind: 'ask',
  summary: 'Answered 2 questions',
  items: ['Auth → OAuth', 'Lib → A, B'],
}));
expect(JSON.stringify(store.getState().items)).not.toContain('agent-completion');
```

Keep assertions that raw API strings, full question text, and the original `ask_user_question(...)` call do not appear.

- [ ] **Step 4: Run the integration test and observe RED**

```bash
npx vitest run src/__tests__/tui/inline-v2/ask-user-structured-result-integration.test.ts
```

Expected: FAIL because Ask still completes as `agent-completion`.

- [ ] **Step 5: Build and store `AskBlock` directly**

Wrap `buildAskUserPresentation()` with `buildAskBlock()`. The wrapper accepts `unknown`, returns `null` when the value is not a version-1 `StructuredAskResult`, and catches malformed nested shapes rather than throwing through the pipeline. Preserve exact existing summary/items for submitted, cancelled, and feedback/chat outcomes.

In `BlockPipeline`, successful structured Ask handling must call:

```ts
renderer.finishAsk(item.toolUseId, askBlock)
```

It must not:

- create `FormattedLine[]`;
- set `finalKind`;
- register an expandable block;
- include the original tool-call line.

Missing or malformed `structuredOutcome` still uses the generic non-grouped tool fallback.

- [ ] **Step 6: Add boundary behavior**

Before writing an `AskBlock`, close any open read-only group and flush any deferred thinking that belongs to the Ask rather than a tool group.

Add a test:

```text
glob → ask → glob
```

Expected: two independent glob groups with one Ask block between them.

- [ ] **Step 7: Run Ask and pipeline tests**

```bash
npx vitest run src/__tests__/ui/ask-block.test.ts src/__tests__/ui/ask-user-presentation.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/inline-v2/ask-user-structured-result-integration.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit checkpoint if authorized**

```bash
git add src/ui/ask-user-presentation.ts src/ui/block-pipeline.ts src/tui/state/pipeline-adapter.ts src/__tests__/ui/ask-block.test.ts src/__tests__/ui/ask-user-presentation.test.ts src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/inline-v2/ask-user-structured-result-integration.test.ts
git commit -m "refactor: represent ask results as ask blocks"
```

---

### Task 6: Render typed transcript blocks and remove string heuristics

**Files:**
- Create: `src/tui/inline-v2/TranscriptBlockLine.tsx`
- Create: `src/tui/inline-v2/ToolBlockLine.tsx`
- Create: `src/tui/inline-v2/AskBlockLine.tsx`
- Create: `src/__tests__/tui/inline-v2/tool-block-line.test.tsx`
- Modify: `src/tui/inline-v2/InlineAppV2.tsx:84-130,157-177,243-282,361-460`
- Modify: `src/tui/inline-v2/MessageLine.tsx:17-53`
- Modify: `src/tui/inline-v2/PendingToolMessage.tsx:21-80`
- Modify: `src/tui/inline-v2/StreamingText.tsx`
- Modify: `src/tui/ConnectedApp.tsx`
- Modify: `src/tui/bootstrap.tsx`
- Modify: `src/tui/selection/flatten-messages.ts`
- Modify: `src/__tests__/tui/inline-v2/read-grouping.test.ts`
- Modify: `src/__tests__/tui/inline-v2/message-line.test.tsx`
- Modify: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`
- Modify: `src/__tests__/tui/selection/flatten-messages.test.ts`

**Interfaces:**
- Consumes: typed timeline selectors, `orderToolPresentations()`, `summarizeThinking()`.
- Produces: typed transcript rendering with no tool-name parsing.

- [ ] **Step 1: Write the failing final-frame tests**

Use ink-testing-library and `strip-ansi`:

```ts
// File-local fixtures for tool-block-line.test.tsx. They are intentionally
// independent from Task 3's reducer fixtures.
function globPresentation(
  toolUseId: string,
  pattern: string,
  count: number,
): ToolPresentation {
  return {
    toolUseId,
    toolName: 'glob',
    summary: `${pattern} → ${count} file${count === 1 ? '' : 's'}`,
    details: Array.from({ length: count }, (_, index) => ({
      kind: 'path' as const,
      path: `${pattern}#${index + 1}`,
    })),
    status: 'success',
  };
}

function emptyGlobPresentation(
  toolUseId: string,
  pattern: string,
): ToolPresentation {
  return {
    toolUseId,
    toolName: 'glob',
    summary: `${pattern} → no matches`,
    details: [],
    status: 'empty',
  };
}

function errorGlobPresentation(
  toolUseId: string,
  pattern: string,
  errorMessage: string,
): ToolPresentation {
  return {
    toolUseId,
    toolName: 'glob',
    summary: `${pattern} → failed: ${errorMessage}`,
    details: [],
    status: 'error',
    errorMessage,
  };
}

it('renders one summary block for adjacent glob calls', () => {
  const block: ToolBlock = {
    id: 'tg1',
    kind: 'tool',
    toolName: 'glob',
    presentations: [
      globPresentation('g1', 'src/**/*.test.ts', 11),
      globPresentation('g2', 'src/render/**/*.test.ts', 2),
      emptyGlobPresentation('g3', 'src/**/*.spec.ts'),
      errorGlobPresentation('g4', 'src/**/protected/*.ts', 'permission denied'),
    ],
    thinking: [{ durationMs: 1_000 }, { durationMs: 2_000 }],
  };
  const { lastFrame } = render(<ToolBlockLine block={block} cols={100} />);
  expect(stripAnsi(lastFrame() ?? '')).toBe([
    '● Searched 4 patterns',
    '  ⎿ src/**/*.test.ts → 11 files',
    '  ⎿ src/render/**/*.test.ts → 2 files',
    '  ⎿ src/**/*.spec.ts → no matches',
    '  ⎿ src/**/protected/*.ts → failed: permission denied',
    '  ⎿ Thought 3s (2 entries)',
  ].join('\n'));
});
```

Add tests proving:

- error entries render after success/empty even when invoked earlier;
- one sub-2-second thought entry is omitted;
- Ask frame is byte-for-byte equivalent after ANSI stripping;
- a single/aggregated Read frame preserves the approved current glyph/indent contract;
- a compact subagent completion remains one truncated line;
- assistant continuation remains unchanged.

- [ ] **Step 2: Run RED**

```bash
npx vitest run src/__tests__/tui/inline-v2/tool-block-line.test.tsx src/__tests__/tui/inline-v2/message-line.test.tsx
```

Expected: FAIL because typed block components do not exist.

- [ ] **Step 3: Implement `ToolBlockLine`**

Renderer rules:

- title comes from `buildToolGroupTitle(block.toolName, count)`;
- `● ` belongs to this component;
- every visible summary uses `  ⎿ `;
- status controls semantic theme tokens: normal, dim empty, error;
- summaries are terminal-width wrapped without changing stored text;
- `layout:'compact-completion'` keeps the existing one-line truncation behavior;
- thinking metadata is the last child line;
- details remain unrendered in Phase 1 but remain reachable through the existing expandable store.

- [ ] **Step 4: Implement `AskBlockLine` with unchanged output**

Render:

```text
● {summary}
  ⎿ {item 1}
  ⎿ {item 2}
```

Reuse current brand/dim styles and physical line endings. Do not inspect `toolName`, `agent-completion`, or raw structured outcome in the component.

- [ ] **Step 5: Route typed blocks in `TranscriptBlockLine`**

Use an exhaustive `switch (block.kind)`:

- user → existing user layout;
- assistant → `renderFinalizedLine`/existing wrapping;
- tool → `ToolBlockLine`;
- ask → `AskBlockLine`;
- system thinking/notification → existing system style;
- turn-duration → existing duration renderer;
- default → `assertNever`.

- [ ] **Step 6: Replace Inline V2 selectors**

`InlineAppV2` must:

- read the committed transcript prefix from the store selector;
- render each `TranscriptBlock` directly in `<Static>`;
- render `ActivityItem[]` in the active area;
- use one `PendingToolMessage` per `PendingTool` group;
- keep `PendingThinking` and `StreamingAssistant` behavior;
- delete `ReadGroupLine`, `DisplayItem`, `isReadToolMessage`, `isThinkingSummary`, and `groupConsecutiveReadMessages`.

No component may call:

```ts
content.startsWith('● Read(')
content.includes('Thought for')
```

for type or grouping decisions.

- [ ] **Step 7: Update transcript selection flattening**

Map typed blocks to selectable plain text without ANSI:

- assistant/user/system/turn-duration → their semantic text;
- tool → title plus ordered summaries and thought metadata;
- Ask → summary plus items;
- exclude mutable activity unless the existing selection behavior explicitly included it.

Add tests ensuring no detail data or secret error fields leak into copied collapsed summaries.

- [ ] **Step 8: Run Inline V2 and selection tests**

```bash
npx vitest run src/__tests__/tui/inline-v2/ src/__tests__/tui/selection/flatten-messages.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit checkpoint if authorized**

```bash
git add src/tui/inline-v2 src/tui/ConnectedApp.tsx src/tui/bootstrap.tsx src/tui/selection/flatten-messages.ts src/__tests__/tui/inline-v2 src/__tests__/tui/selection/flatten-messages.test.ts
git commit -m "feat: render grouped tool transcript blocks"
```

---

### Task 7: Verify the full production path and remove legacy type disguises

**Files:**
- Modify: `src/__tests__/tui/pipeline-integration.test.ts`
- Modify: `src/__tests__/tui/inline-v2/e2e-basic.test.tsx`
- Modify: `src/__tests__/tui/inline-v2/ask-user-structured-result-integration.test.ts`
- Modify: `scripts/tty-verify/render-scenarios.tsx`
- Modify: `scripts/tty-verify/run-verify.cjs` only if a new named scenario must be registered
- Delete or simplify obsolete code in:
  - `src/tui/types.ts`
  - `src/ui/message-formatter.ts`
  - `src/tui/inline-v2/InlineAppV2.tsx`
  - `src/tui/inline-v2/MessageLine.tsx`

**Interfaces:**
- Consumes: completed Phase 1 architecture.
- Produces: end-to-end regression evidence and removal of obsolete `TuiMessage`/`agent-completion`/Read string matching.

- [ ] **Step 1: Add an end-to-end store-chain regression test**

Exercise:

```text
thinking_start/end (1s)
glob("src/**/*.test.ts") → 2 files
thinking_start/end (2s)
glob("src/**/*.spec.ts") → empty
glob("src/**/protected/*.ts") → error
assistant_text("Done")
```

Assert the semantic timeline contains:

1. one finalized glob `ToolBlock` with three presentations;
2. attached thinking total of three seconds/two entries;
3. one following `AssistantBlock`;
4. no independent thinking-summary transcript blocks for the attached entries;
5. no `[object Object]`;
6. no duplicate tool headings.

Lock the 1-second thinking entry's store behavior with explicit assertions:

```ts
const items = store.getState().items;
expect(items).toHaveLength(2); // one ToolBlock, then one AssistantBlock
expect(items[0]).toMatchObject({
  kind: 'tool',
  thinking: [{ durationMs: 1_000 }, { durationMs: 2_000 }],
});
expect(items.filter(
  item => item.kind === 'system' && item.subkind === 'thinking-summary',
)).toHaveLength(0);
expect(summarizeThinking(
  items[0]!.kind === 'tool' ? items[0]!.thinking : [],
)).toBe('Thought 3s (2 entries)');
```

The `< 2s` threshold is display-only and applies only when the group contains exactly one thinking entry. It never deletes metadata from the store.

- [ ] **Step 2: Add a real Ink frame scenario**

The TTY scenario must construct events through `BlockPipeline` and `PipelineToStoreAdapter`; it must not write preformatted lines directly into the store.

Expected stripped frame:

```text
● Searched 3 patterns
  ⎿ src/**/*.test.ts → 2 files
  ⎿ src/**/*.spec.ts → no matches
  ⎿ src/**/protected/*.ts → failed: permission denied
  ⎿ Thought 3s (2 entries)
```

Add a separate Ask scenario proving its existing parent/child frame is unchanged.

- [ ] **Step 3: Prove legacy heuristics are gone**

Run:

```bash
git grep -n -E "agent-completion|groupConsecutiveReadMessages|Read|Thought for" -- src/tui src/ui
git grep -n -E "(startsWith|includes|match|test).*?(Read|Thought for)|(Read|Thought for).*?(startsWith|includes|match|test)" -- src/tui src/ui
```

Expected:

- no Ask-as-`agent-completion`;
- no renderer-side Read/thinking string recognition;
- the second command returns no renderer type/grouping decisions based on Read or thinking text;
- broad matches from the first command are individually inspected and limited to user-facing copy, formatters, tests, or explicitly historical comments.

Do not remove `buildSubagentCompletionPresentation()`; only its old message-kind coupling should disappear.

- [ ] **Step 4: Run layered verification**

L1:

```bash
npx vitest run src/__tests__/ui/tool-presentation.test.ts src/__tests__/tui/transcript-types.test.ts src/__tests__/tui/transcript-reducer.test.ts
```

L2:

```bash
npx vitest run src/__tests__/ui/ src/__tests__/tui/
npm run test:tty
```

L3:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: all commands exit 0. The known Windows `AttachConsole failed` helper noise after successful TTY scenarios is non-fatal only when the command exit code remains 0.

- [ ] **Step 5: Protect generated prompts**

Because this work does not touch prompts, verify:

```bash
git diff -- src/prompts/planner.generated.ts src/prompts/system.generated.ts
```

Expected: no new diff attributable to this work. Do not run a prompt generation command merely to verify UI changes.

- [ ] **Step 6: Review the final diff for scope**

Confirm:

- no tool schema/provider/Agent history changes;
- no Phase 2 keybindings or focus state;
- no groupable flag added to tool schemas;
- no duplicate presentation/error sanitization utility;
- every new production branch has a failing-first test;
- unrelated pre-existing working-tree changes remain untouched.

- [ ] **Step 7: Commit checkpoint if authorized**

```bash
git add src scripts/tty-verify
git commit -m "test: verify unified tool transcript rendering"
```

Do not include unrelated pre-existing changes in this commit.

---

## Final User-Level Acceptance

Manually verify this input:

```text
Find tests under src/tui, src/render, src/commands, and src/skills.
```

Expected behavior:

```text
● Searched 4 patterns
  ⎿ src/tui/**/*.test.ts → 11 files
  ⎿ src/render/**/*.test.ts → 2 files
  ⎿ src/commands/**tests**/*.test.ts → 2 files
  ⎿ src/skills/**tests**/*.test.ts → 1 file
  ⎿ Thought Ns (M entries)
```

The exact counts come from the live workspace. There must be one heading, no expanded file list by default, no renderer string matching, no duplicated Ask/tool call line, and no loss of raw tool data available to the agent.
