# Subagent Journal and Final User Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each completed subagent work turn so partial results survive missing summaries and failures, and enforce one user-visible final assistant status block for every foreground user turn.

**Architecture:** Add an awaited, opt-in checkpoint seam to `streamingQuery()` and back it with a subagent JSONL sidecar built from the existing `Message` and `SessionStore` formats. `runSubagent()` recovers bounded evidence from that journal when its final summary is absent or execution fails. A separate pure turn-finalization helper classifies the parent turn from structured tool results, appends a fixed four-field status block to the final assistant message, and lets `index.ts` persist and render that finalized message before lifecycle cleanup.

**Tech Stack:** TypeScript ES2022/NodeNext, Node.js `fs/promises` and `crypto.randomUUID`, existing `Message`, `SessionStore`, `ToolExecutionResult`, `streamingQuery`, Vitest, ESLint.

## Global Constraints

- This plan implements only “subagent work journal + final user feedback”; Auto Mode is explicitly out of scope.
- Follow RED → GREEN → REFACTOR. Every behavioral change starts with a focused failing test whose failure reason matches the missing contract.
- Reuse the existing structured `Message[]`, JSONL session serialization, `ToolExecutionResult.status`, and legacy `[Subagent status=...]` envelope.
- Do not add a database, queue, daemon, telemetry payload store, new provider protocol, or general workflow engine.
- Do not enable `useCompletionContract` globally. Its current V2 evidence/deliverable requirements are a separate migration.
- A checkpoint represents a completed message boundary. Persist the initial child prompt, every completed `assistant tool_use + user tool_result` pair, and the final completed assistant message.
- Checkpoint writes are awaited and serialized. After an awaited checkpoint returns, a later provider/communication failure must not erase it.
- Checkpoint persistence is fail-fast: a write failure stops that child execution and is returned as `incomplete/error`. Best-effort continuation is forbidden because it would knowingly continue without the required recovery trail.
- Batch only the new JSONL records belonging to one completed boundary into a single `appendFile` call. Do not buffer across boundaries or add an I/O timeout; a timeout cannot safely cancel an in-flight filesystem append.
- Journal content lives outside the parent provider-visible session history under `subagents/<parent-session-id>/<execution-id>.jsonl`.
- Recovery output shown to the parent is bounded; the journal remains the lossless source and its absolute path is returned as a reference.
- Inline recovery preserves all completed assistant text and successful paired tool results in chronological order until the 12,000-character display bound. Truncation is presentation-only; the JSONL journal remains lossless.
- Each child receives a fresh `randomUUID()` execution ID and therefore a distinct journal file. Writes within one journal are serialized; sibling children under the same parent session never append to the same file.
- `spawn_agent` and `task` production registrations both receive a journal factory. Direct legacy test calls to `runSubagent()` may omit it and retain current behavior.
- `[Hook] <tool> done`, warnings, spinner state, and generic console errors never satisfy the final assistant reply contract.
- Every non-background user turn ends with exactly one four-field assistant status block: `当前状态`, `已获得结果`, `失败或受阻位置`, `下一步`.
- Keep edits limited to the files listed below; do not reformat or refactor neighboring code.
- Use `npx.cmd` on Windows if PowerShell blocks `npx.ps1`.
- Journal retention follows the parent session's existing retention lifecycle. This repair does not add an independent TTL or deletion scheduler; journals remain available until a future SessionStore-wide retention feature removes the parent session and its child directory.
- CompletionReport V2 has no prerequisite relationship to this repair. A later migration may consume journal references, but this plan neither schedules nor enables that separate work.
- If final assistant persistence itself fails, the runtime still emits an explicit user-visible `失败` block. That exceptional block cannot survive reload because the storage layer failed; this is an accepted boundary rather than a reason to add a second persistence system.

---

## File Map

### New files

- `src/agent/subagent-journal.ts` — journal interface and deterministic, bounded recovery from structured child messages.
- `src/agent/subagent-result-format.ts` — shared legacy `SubagentResult` envelope formatter used by both child tools.
- `src/agent/turn-final-feedback.ts` — pure parent-turn outcome classification and final assistant status-block construction.
- `src/__tests__/session-store-subagent-journal.test.ts` — JSONL namespace, incremental append, reload, and corrupt-tail coverage.
- `src/__tests__/turn-final-feedback.test.ts` — success/partial/failure classification and exactly-one-final-block behavior.

### Modified files

- `src/agent/streaming-query.ts` — awaited checkpoint callback at completed message boundaries.
- `src/session/store.ts` — create/load subagent journal sidecars using existing JSONL message records.
- `src/agent/subagent.ts` — accept a journal, checkpoint the child transcript, and recover partial work before final classification.
- `src/agent/tools/spawn-agent-tool.ts` — create one journal per foreground spawn and pass it to `runSubagent()`.
- `src/agent/tools/task-tool.ts` — use the same journal factory and return the same status envelope as `spawn_agent`.
- `src/index.ts` — inject the journal factory, collect turn facts, finalize messages, await persistence, emit final feedback, then end the lifecycle.
- `src/__tests__/streaming-query.test.ts` — checkpoint timing and serialization tests.
- `src/__tests__/subagent-result-integrity.test.ts` — failure/no-summary recovery tests.
- `src/__tests__/role-agents.test.ts` — `spawn_agent` journal injection and recovered-envelope tests.
- `src/__tests__/task-tool.test.ts` — `task` journal injection and status-envelope tests.
- `src/__tests__/hooks.test.ts` — retain Hook semantics and prove it is not an assistant terminal reply.

---

## Phase A — Durable Subagent Work

### Task 1: Add Awaited Transcript Checkpoints to `streamingQuery`

**Files:**

- Modify: `src/agent/streaming-query.ts:151-175, 665-682, 797-807`
- Modify: `src/__tests__/streaming-query.test.ts`

**Interfaces:**

- Consumes: existing `Message[]` history after a complete message boundary.
- Produces: `StreamingQueryOptions.onMessageCheckpoint?: (messages: readonly Message[]) => Promise<void>`.
- Guarantee: callbacks run in query order and are awaited before another provider turn begins.

- [ ] **Step 1: Add a failing test for incremental, awaited checkpoints**

Reuse `ScriptedStreamClient` and register an `echo` tool. The first model turn calls the tool and the second returns final text. Add:

```ts
it('awaits a checkpoint after the completed tool round and final assistant', async () => {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
    },
    async input => String(input.value),
  );
  const client = new ScriptedStreamClient([
    [{ type: 'tool_use', id: 'tool-1', name: 'echo', input: { value: 'saved' } }],
    [{ type: 'text', text: 'final summary' }],
  ]);
  const snapshots: Message[][] = [];
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve; });

  const consume = (async () => {
    for await (const _ of streamingQuery(client, registry, 'work', {
      systemPrompt: 'test',
      tools: registry.getDefinitions(),
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      onMessageCheckpoint: async messages => {
        snapshots.push(structuredClone(messages) as Message[]);
        if (snapshots.length === 1) await firstWrite;
      },
    })) { /* consume */ }
  })();

  await vi.waitFor(() => expect(snapshots).toHaveLength(1));
  expect(snapshots[0]?.at(-1)?.content).toEqual([
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'saved' },
  ]);
  expect(client.calls).toBe(1);

  releaseFirst();
  await consume;

  expect(snapshots.at(-1)?.at(-1)?.role).toBe('assistant');
  expect(snapshots.at(-1)?.at(-1)?.content).toEqual([
    { type: 'text', text: 'final summary' },
  ]);
});
```

If `ScriptedStreamClient` does not expose `calls`, add only this getter to the test helper:

```ts
get calls(): number {
  return this.callCount;
}
```

- [ ] **Step 1b: Add a failing fail-fast checkpoint test**

```ts
it('does not start another provider turn when checkpoint persistence fails', async () => {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'echo', description: 'echo', parameters: { type: 'object' } },
    async () => 'saved',
  );
  const client = new ScriptedStreamClient([
    [{ type: 'tool_use', id: 'tool-1', name: 'echo', input: {} }],
    [{ type: 'text', text: 'must not run' }],
  ]);

  const consume = async () => {
    for await (const _ of streamingQuery(client, registry, 'work', {
      systemPrompt: 'test',
      tools: registry.getDefinitions(),
      signal: new AbortController().signal,
      executionRuntime: createToolExecutionRuntime(),
      onMessageCheckpoint: async () => {
        throw new Error('journal disk unavailable');
      },
    })) { /* consume */ }
  };

  await expect(consume()).rejects.toThrow('journal disk unavailable');
  expect(client.calls).toBe(1);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
npx.cmd vitest run src/__tests__/streaming-query.test.ts -t "awaits a checkpoint"
```

Expected: TypeScript/test failure because `onMessageCheckpoint` is not defined.

- [ ] **Step 3: Add the minimal awaited callback**

Add to `StreamingQueryOptions`:

```ts
onMessageCheckpoint?: (messages: readonly Message[]) => Promise<void>;
```

Destructure it beside `onMessages`. After the phase-4 tool-use/tool-result pair is appended to `messages`, add:

```ts
await onMessageCheckpoint?.(messages);
```

After a final no-tool assistant message is appended and before `end_turn` returns, add the same awaited call. Do not invoke it for partial provider deltas or before tool-use/result pairing is complete.

Let checkpoint errors propagate. `runSubagent()` will convert them into `incomplete/error` in Task 3. Do not catch-and-warn, batch multiple completed turns, or race the append against a timeout.

The I/O count is bounded by completed turns, not streamed tokens: `N` tool rounds plus one final assistant produce at most `N + 1` awaited checkpoint appends. A 10-round child therefore adds at most 11 filesystem appends. Their latency is accepted as the cost of the durability contract; Task 2 batches all records within each boundary into that single append.

- [ ] **Step 4: Run the focused test and existing streaming tests**

```powershell
npx.cmd vitest run src/__tests__/streaming-query.test.ts
```

Expected: all tests pass; one test proves the second provider call does not begin before the first checkpoint resolves, and the other proves a failed checkpoint prevents the next provider call.

- [ ] **Step 5: Commit the isolated checkpoint seam**

```powershell
git add src/agent/streaming-query.ts src/__tests__/streaming-query.test.ts
git commit -m "feat: checkpoint completed agent turns"
```

---

### Task 2: Add a Namespaced JSONL Subagent Journal

**Files:**

- Create: `src/agent/subagent-journal.ts`
- Modify: `src/session/store.ts:307-382, 552-554`
- Create: `src/__tests__/session-store-subagent-journal.test.ts`

**Interfaces:**

- Consumes: ordered snapshots supplied by Task 1.
- Produces:

```ts
export interface SubagentJournal {
  readonly executionId: string;
  readonly reference: string;
  checkpoint(messages: readonly Message[]): Promise<void>;
  load(): Promise<Message[]>;
}
```

- Produces: `SessionStore.createSubagentJournal(parentSessionId, executionId): SubagentJournal`.

- [ ] **Step 1: Write the failing sidecar test**

```ts
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../session/store.js';
import type { Message } from '../agent/types.js';

describe('SessionStore subagent journal', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('appends only new messages and reloads the lossless child transcript', async () => {
    const base = await mkdtemp(join(tmpdir(), 'micode-subagent-'));
    dirs.push(base);
    const store = new SessionStore(base);
    const journal = store.createSubagentJournal('parent-1', 'child-1');
    const prompt: Message = { role: 'user', content: 'inspect' };
    const use: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } }],
    };
    const result: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'important result' }],
    };

    await journal.checkpoint([prompt, use, result]);
    await journal.checkpoint([prompt, use, result]);

    expect(await journal.load()).toEqual([prompt, use, result]);
    expect(journal.reference).toBe(
      join(base, 'subagents', 'parent-1', 'child-1.jsonl'),
    );
    expect((await readFile(journal.reference, 'utf8')).trim().split('\n')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

```powershell
npx.cmd vitest run src/__tests__/session-store-subagent-journal.test.ts
```

Expected: FAIL because `createSubagentJournal()` does not exist.

- [ ] **Step 3: Add the journal contract and SessionStore sidecar**

Create `src/agent/subagent-journal.ts` with the interface above. In `SessionStore`, retain the constructor base directory and add:

```ts
private readonly subagentsDir: string;

constructor(baseDir?: string) {
  const base = baseDir ?? join(homedir(), '.micode');
  this.sessionsDir = join(base, 'sessions');
  this.subagentsDir = join(base, 'subagents');
}
```

Add a private `appendMessages(filePath, messages)` and `loadMessages(filePath)` by moving the existing JSONL record serialization/parsing from `append()` and `load()` without changing their behavior. `append()` calls `appendMessages(filePath, [message])`; one child checkpoint serializes its entire delta and performs one append:

```ts
createSubagentJournal(parentSessionId: string, executionId: string): SubagentJournal {
  const filePath = join(this.subagentsDir, parentSessionId, `${executionId}.jsonl`);
  let persistedCount = 0;

  return {
    executionId,
    reference: filePath,
    checkpoint: async messages => {
      const pending = messages.slice(persistedCount);
      await this.appendMessages(filePath, pending);
      persistedCount = messages.length;
    },
    load: async () => this.loadMessages(filePath),
  };
}
```

`appendMessages()` must return immediately for an empty delta; otherwise it calls `mkdir(dirname(filePath), { recursive: true })`, converts every message to the existing `SessionRecord` shape, joins the records with trailing newlines, and calls `appendFile()` exactly once. `loadMessages()` must preserve the current behavior of skipping a truncated/corrupt JSONL line while retaining earlier valid records.

- [ ] **Step 4: Add a corrupt-tail assertion**

```ts
await appendFile(journal.reference, '{broken\n', 'utf8');
expect(await journal.load()).toEqual([prompt, use, result]);
```

Add a second journal whose last line is a realistic partial JSON write:

```ts
const partial = store.createSubagentJournal('parent-1', 'child-partial');
await partial.checkpoint([prompt, use, result]);
await appendFile(partial.reference, '{"role":"user","con', 'utf8');
expect(await partial.load()).toEqual([prompt, use, result]);
```

Both cases lock in crash-tolerant append-only recovery. An embedded NUL is handled by the same JSON parse rejection. Do not add sequence-number repair for reordered lines: one journal has one awaited writer, so write order is serialized by construction.

- [ ] **Step 4b: Add a sibling-concurrency isolation test**

```ts
const childA = store.createSubagentJournal('parent-1', 'child-a');
const childB = store.createSubagentJournal('parent-1', 'child-b');
await Promise.all([
  childA.checkpoint([{ role: 'user', content: 'A' }]),
  childB.checkpoint([{ role: 'user', content: 'B' }]),
]);

expect(childA.reference).not.toBe(childB.reference);
expect(await childA.load()).toEqual([{ role: 'user', content: 'A' }]);
expect(await childB.load()).toEqual([{ role: 'user', content: 'B' }]);
```

- [ ] **Step 5: Run the focused storage tests**

```powershell
npx.cmd vitest run src/__tests__/session-store-subagent-journal.test.ts
```

Expected: all tests pass; files are under `subagents/`, not `sessions/`; duplicate snapshots do not duplicate records; corrupt/partial tails retain earlier records; sibling children write separate files.

- [ ] **Step 6: Commit the sidecar store**

```powershell
git add src/agent/subagent-journal.ts src/session/store.ts src/__tests__/session-store-subagent-journal.test.ts
git commit -m "feat: persist subagent transcript journals"
```

---

### Task 3: Recover Completed Child Work When Summary Generation Fails

**Files:**

- Modify: `src/agent/subagent-journal.ts`
- Modify: `src/agent/subagent.ts:53-129, 378-515, 548-685`
- Modify: `src/__tests__/subagent-result-integrity.test.ts`

**Interfaces:**

- Consumes: `SubagentJournal` from Task 2 and Task 1 checkpoints.
- Produces:

```ts
export interface RecoveredSubagentWork {
  readonly text: string;
  readonly successfulToolResults: number;
}

export function recoverSubagentWork(
  messages: readonly Message[],
  journalReference: string,
  maxChars?: number,
): RecoveredSubagentWork;
```

- Extends `SubagentOptions` with `journal?: SubagentJournal`.

- [ ] **Step 1: Replace the current counter-only failure assertion with a failing recovery assertion**

In the existing “provider 在工具成功后失败” test, provide an in-memory journal:

```ts
let snapshot: Message[] = [];
const journal: SubagentJournal = {
  executionId: 'child-provider-failure',
  reference: 'memory://child-provider-failure',
  checkpoint: async messages => { snapshot = structuredClone(messages) as Message[]; },
  load: async () => snapshot,
};
```

Pass `journal` to `runSubagent()` and assert:

```ts
expect(result.status).toBe('incomplete');
expect(result.terminationReason).toBe('error');
expect(result.text).toContain('contents of src');
expect(result.text).toContain('memory://child-provider-failure');
expect(result.text).toContain('provider exploded');
expect(result.evidence.successfulToolResultCount).toBe(1);
```

- [ ] **Step 2: Add a failing no-final-summary recovery test**

Use the existing script “tool succeeds, reserved final turn returns empty content”. Pass the journal and assert:

```ts
expect(result.status).toBe('incomplete');
expect(result.text).toContain('[Subagent incomplete: no final summary]');
expect(result.text).toContain('contents of src');
expect(result.text).toContain('memory://child-empty-summary');
expect(result.text).not.toContain('(no final text)');
```

- [ ] **Step 2b: Add a failing chronological-context recovery test**

Build a journal snapshot containing `text A → read_file result → text B → grep result`, then assert both analysis texts and both tool results survive in order:

```ts
const recovered = recoverSubagentWork(
  [
    { role: 'assistant', content: [{ type: 'text', text: 'text A: inspect structure' }, { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/index.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'file contents' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'text B: analyze TODOs' }, { type: 'tool_use', id: 'g1', name: 'run_bash', input: { command: 'grep TODO' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'three TODOs' }] },
  ],
  'memory://chronological',
);

expect(recovered.text.indexOf('text A')).toBeLessThan(recovered.text.indexOf('file contents'));
expect(recovered.text.indexOf('file contents')).toBeLessThan(recovered.text.indexOf('text B'));
expect(recovered.text.indexOf('text B')).toBeLessThan(recovered.text.indexOf('three TODOs'));
```

- [ ] **Step 2c: Lock the mixed-block provider ordering**

An assistant message may contain text and tool-use blocks together. The provider completes the entire assistant message before the runtime executes any tool, so every text block in that message chronologically precedes the following user `tool_result`, including text blocks positioned after `tool_use` inside the same content array:

```ts
const mixed = recoverSubagentWork(
  [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'text A: preparing' },
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/index.ts' } },
        { type: 'text', text: 'text B: request prepared' },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'file contents' }] },
  ],
  'memory://mixed-blocks',
);

expect(mixed.text.indexOf('text A')).toBeLessThan(mixed.text.indexOf('text B'));
expect(mixed.text.indexOf('text B')).toBeLessThan(mixed.text.indexOf('file contents'));
```

Do not move a same-message text block after the tool result merely because it follows the `tool_use` block in the content array; tool execution starts only after the assistant message is complete.

- [ ] **Step 3: Run both tests and confirm RED**

```powershell
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts -t "工具成功后失败|no final summary"
```

Expected: FAIL because the journal is neither checkpointed nor read by `runSubagent()`.

- [ ] **Step 4: Implement deterministic bounded recovery**

In `recoverSubagentWork()`:

1. Pair each assistant `tool_use.id/name/input` with the later user `tool_result.tool_use_id/content`.
2. Keep result bodies that do not start with the existing error markers; do not infer success from the tool count. Recovery includes successful write/edit tools even though the existing explore-agent verification counter intentionally recognizes a smaller evidence-tool whitelist.
3. Preserve every completed non-empty assistant text and successful paired result in transcript order, but return them only when at least one successful paired tool result exists. This keeps the existing evidence gate while avoiding “last text only” context loss.
4. Bound the inline body to `maxChars = 12_000` and always append `完整留痕：<journalReference>`.
5. Return an empty recovery body with `successfulToolResults: 0` when no paired successful result exists.

Implement the pairing with structured blocks, not regex over transcript JSON:

```ts
const ERROR_OUTPUT = /^\s*(?:\[Tool Error\]|\[Blocked|Error:)/i;
const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
const sections: string[] = [];
let successfulToolResults = 0;

for (const message of messages) {
  const blocks = typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content;

  if (message.role === 'assistant') {
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        uses.set(block.id, { name: block.name, input: block.input });
      } else if (block.type === 'text' && block.text.trim()) {
        sections.push(`已有分析：${block.text.trim()}`);
      }
    }
    continue;
  }

  for (const block of blocks) {
    if (block.type !== 'tool_result' || ERROR_OUTPUT.test(block.content)) continue;
    const use = uses.get(block.tool_use_id);
    if (!use) continue;
    successfulToolResults += 1;
    sections.push(
      `工具 ${use.name}(${JSON.stringify(use.input)})：\n${block.content}`,
    );
  }
}

if (successfulToolResults === 0) {
  return { text: '', successfulToolResults: 0 };
}

const raw = [
  '已恢复的子代理工作：',
  ...sections,
  `完整留痕：${journalReference}`,
].filter(Boolean).join('\n');
const text = raw.length <= maxChars
  ? raw
  : `${raw.slice(0, maxChars)}\n[内联恢复内容已截断]\n完整留痕：${journalReference}`;
```

Return the local `successfulToolResults` value. This recovery count describes paired journal results only; do not replace or reinterpret the existing `SubagentEvidence` verification counters. The 12,000-character inline view is deliberately bounded, but the referenced journal retains the full ordered transcript.

- [ ] **Step 5: Wire journal checkpoints and recovery into `runSubagent()`**

Pass this option to the production streaming path:

```ts
onMessageCheckpoint: options.journal
  ? messages => options.journal!.checkpoint(messages)
  : undefined,
```

Before calling `finalizeSubagentExecution()`, when `finalTurnSynthesized === false`, load the journal and replace `(no final text)` with recovered work if available. In the `catch` block, load the journal and compose:

```ts
const errorText = formatUnknownError(error);
const recovered = options.journal
  ? recoverSubagentWork(
      await options.journal.load(),
      options.journal.reference,
    )
  : { text: '', successfulToolResults: 0 };
const text = recovered.text
  ? `${errorText}\n${recovered.text}`
  : errorText;
```

Keep `terminationReason: 'error'`. Do not convert provider failure into completed merely because a tool result was recovered.

- [ ] **Step 6: Run the integrity suite**

```powershell
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts
```

Expected: all tests pass. Existing completed/unverified behavior remains unchanged; the two failure cases now expose actual recovered work.

- [ ] **Step 7: Commit child recovery**

```powershell
git add src/agent/subagent-journal.ts src/agent/subagent.ts src/__tests__/subagent-result-integrity.test.ts
git commit -m "fix: recover subagent work from journal"
```

---

### Task 4: Inject Journals into Both User-Visible Subagent Tools

**Files:**

- Create: `src/agent/subagent-result-format.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts:121-276`
- Modify: `src/agent/tools/task-tool.ts:20-79`
- Modify: `src/index.ts:164-169, 408-416`
- Modify: `src/__tests__/role-agents.test.ts`
- Modify: `src/__tests__/task-tool.test.ts`

**Interfaces:**

- Consumes: `SessionStore.createSubagentJournal()` and `SubagentJournal`.
- Produces: `export type SubagentJournalFactory = () => SubagentJournal`.
- Both tool factories accept an optional `journalFactory` dependency and invoke it exactly once per foreground child execution.

- [ ] **Step 0: Enforce the Task 3 prerequisite before editing Task 4**

```powershell
npm.cmd run typecheck
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts
Select-String -Path src/agent/subagent.ts -Pattern 'journal\?: SubagentJournal'
Select-String -Path src/agent/tools/spawn-agent-tool.ts -Pattern '^export function createSpawnAgentTool' -Context 0,50
Select-String -Path src/agent/tools/task-tool.ts -Pattern '^export function createTaskTool' -Context 0,20
```

Expected: typecheck and the Task 3 suite pass; `SubagentOptions` contains `journal?: SubagentJournal`; the printed factory declarations still match the 9-parameter and 5-parameter baselines recorded below. If any check fails, stop Task 4 and reconcile the whole signature/dependency change before editing callers; do not partially cherry-pick Task 4 around a missing or drifted interface.

- [ ] **Step 1: Add failing factory-injection tests**

For `spawn_agent`, inject a journal factory and a mocked `runSubagentFn`, then assert:

```ts
expect(journalFactory).toHaveBeenCalledTimes(1);
expect(runSubagentFn).toHaveBeenCalledWith(
  expect.any(String),
  expect.anything(),
  expect.objectContaining({ journal }),
);
```

Repeat for `task`. Make the mocked `runSubagentFn` return:

```ts
{
  text: 'recovered work',
  isBackground: false,
  status: 'incomplete',
  terminationReason: 'error',
  evidence: { toolCallCount: 1, successfulToolResultCount: 1 },
}
```

Assert both tool outputs contain the same envelope:

```ts
expect(output).toContain('[Subagent status=incomplete reason=error]');
expect(output).toContain('recovered work');
```

- [ ] **Step 2: Run focused tool tests and confirm RED**

```powershell
npx.cmd vitest run src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts -t "journal|status envelope"
```

Expected: FAIL because neither factory accepts a journal dependency and `task` returns raw `result.text`.

- [ ] **Step 3: Extract the shared envelope formatter and add the optional factory**

Define in `subagent-journal.ts`:

```ts
export type SubagentJournalFactory = () => SubagentJournal;
```

Add `journalFactory?: SubagentJournalFactory` at the end of both tool-factory parameter lists. In each foreground executor:

```ts
const journal = journalFactory?.();
const result = await runSubagentFn(prompt, childTools, {
  // existing options stay unchanged
  journal,
});
```

For `spawn_agent`, create the journal after input/delegation validation and before the `fork` branch so both fork and role-based foreground paths reuse the same instance. For `task`, create it after optional worktree resolution and before calling the runner. Do not create a journal for denied delegation or invalid input.

The existing formatter is currently exported from `src/agent/tools/spawn-agent-tool.ts:59-70`. Move that implementation unchanged to `src/agent/subagent-result-format.ts`:

```ts
import type { SubagentResult } from './subagent.js';

export function formatSubagentResult(result: SubagentResult): string {
  if (result.status === 'background') return result.text;
  const reason = result.status === 'incomplete' && result.terminationReason
    ? ` reason=${result.terminationReason}`
    : '';
  return `[Subagent status=${result.status}${reason}]\n${result.text}`;
}
```

Import it from the shared module in both tools. Re-export it from `spawn-agent-tool.ts` so existing imports remain source-compatible:

```ts
export { formatSubagentResult } from '../subagent-result-format.js';
```

Change `task-tool.ts` to return the shared `formatSubagentResult(result)` instead of `result.text`.

- [ ] **Step 4: Inject the production factory from `index.ts`**

Use the existing dynamic `sessionId` closure so resume/session rotation remains correct:

```ts
const createSubagentJournal = () =>
  sessionStore.createSubagentJournal(sessionId, randomUUID());
```

Pass this factory to both `createSpawnAgentTool()` and `createTaskTool()`. Do not capture the initial session ID as a value.

The current `createSpawnAgentTool` declaration has exactly these nine parameters, verified from `src/agent/tools/spawn-agent-tool.ts:105-154`:

```ts
createSpawnAgentTool(
  childTools,
  clientProvider,
  executionRuntime,
  runSubagentFn = runSubagent,
  skillsDescription?,
  getParentSystemPrompt?,
  useCompletionContract = false,
  runSubagentContractedFn?,
  delegationGateHook?,
)
```

Add `journalFactory?: SubagentJournalFactory` as parameter 10. This task deliberately avoids converting all established callers to an options object because that would touch 19 role-agent/regression call sites for no behavioral benefit. The explicit signature, compile gate, and named comments below make the new tail dependency auditable.

The current `createTaskTool` declaration has exactly five parameters, verified from `src/agent/tools/task-tool.ts:26-38`:

```ts
createTaskTool(
  childTools,
  executionRuntime,
  worktreeManager?,
  clientProvider?,
  runSubagentFn = runSubagent,
)
```

Add `journalFactory?: SubagentJournalFactory` as parameter 6. The production call therefore passes the existing real `runSubagent` explicitly in position 5 and `createSubagentJournal` in position 6.

Preserve every existing parameter position. The production calls must be:

```ts
const taskTool = createTaskTool(
  childToolRegistry,
  executionRuntime,
  worktreeManager,
  subagentClientProvider,
  runSubagent,
  createSubagentJournal,
);

const spawnAgentTool = createSpawnAgentTool(
  childToolRegistry,
  subagentClientProvider,
  executionRuntime,
  runSubagent,
  truncateSkillsDescription(skillRegistry.describeAvailable()),
  () => lastSystemPrompt,
  false,      // keep the current legacy completion-contract path
  undefined,  // no contracted runner migration in this change
  undefined,  // preserve the current delegation-gate argument
  createSubagentJournal,
);
```

- [ ] **Step 5: Run both tool suites**

```powershell
npx.cmd vitest run src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts src/__tests__/subagent-explicit-delegation.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts
```

Expected: all tests pass; both user-visible child tools return recoverable status envelopes and create a fresh journal per execution; the formatter's existing public import and permission-passthrough calls remain compatible.

- [ ] **Step 6: Commit production journal wiring**

```powershell
git add src/agent/subagent-result-format.ts src/agent/tools/spawn-agent-tool.ts src/agent/tools/task-tool.ts src/index.ts src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts
git commit -m "feat: journal user-visible subagent runs"
```

---

## Phase B — Mandatory Final Assistant Feedback

### Task 5: Define the Pure Turn Final-Feedback Contract

**Files:**

- Create: `src/agent/turn-final-feedback.ts`
- Create: `src/__tests__/turn-final-feedback.test.ts`

**Interfaces:**

- Consumes: final `Message[]`, the projected `ToolExecutionResult.status`, tool names/outputs, and an optional terminal error.
- Produces:

```ts
export type UserTurnStatus = '成功' | '部分完成' | '失败';

export interface TurnToolFact {
  name: string;
  output: string;
  executionStatus?: ToolExecutionResult['status'];
}

export interface TurnFinalizationInput {
  messages: readonly Message[];
  turnStartIndex: number;
  toolFacts: readonly TurnToolFact[];
  error?: string;
  aborted: boolean;
}

export interface TurnFinalizationResult {
  status: UserTurnStatus;
  feedbackText: string;
  messages: Message[];
}

export function finalizeTurnForUser(
  input: TurnFinalizationInput,
): TurnFinalizationResult;
```

`turnStartIndex` is the parent session message count captured before `streamingQuery()` starts. Classification and assistant-text lookup must inspect only `messages.slice(turnStartIndex)`, never an earlier turn.

- [ ] **Step 1: Add the failing classification table**

```ts
it.each([
  {
    name: 'normal final text',
    messages: [assistant('answer')],
    toolFacts: [],
    error: undefined,
    expected: '成功',
  },
  {
    name: 'missing final text after recovered subagent work',
    messages: [],
    toolFacts: [tool('spawn_agent', '[Subagent status=incomplete reason=error]\nrecovered work', 'success')],
    error: undefined,
    expected: '部分完成',
  },
  {
    name: 'completed subagent result without a model-authored final message',
    messages: [],
    toolFacts: [tool('spawn_agent', '[Subagent status=completed]\ncompleted work', 'success')],
    error: undefined,
    expected: '成功',
  },
  {
    name: 'tool failure without result',
    messages: [],
    toolFacts: [tool('read_file', 'Error: denied', 'failure')],
    error: undefined,
    expected: '失败',
  },
  {
    name: 'provider error after useful output',
    messages: [assistant('partial answer')],
    toolFacts: [],
    error: 'provider disconnected',
    expected: '部分完成',
  },
])('$name => $expected', ({ messages, toolFacts, error, expected }) => {
  const result = finalizeTurnForUser({
    messages,
    turnStartIndex: 0,
    toolFacts,
    error,
    aborted: false,
  });
  expect(result.status).toBe(expected);
  expect(result.feedbackText).toContain(`当前状态：${expected}`);
  expect(result.feedbackText).toContain('已获得结果：');
  expect(result.feedbackText).toContain('失败或受阻位置：');
  expect(result.feedbackText).toContain('下一步：');
});
```

Define the test helpers explicitly:

```ts
function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantToolUse(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  };
}

function toolResult(id: string, output: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: output }],
  };
}

function tool(
  name: string,
  output: string,
  status: 'success' | 'failure',
): TurnToolFact {
  return { name, output, executionStatus: status };
}

function countStatusBlocks(messages: readonly Message[]): number {
  return messages
    .flatMap(message => typeof message.content === 'string'
      ? [message.content]
      : message.content.filter(block => block.type === 'text').map(block => block.text))
    .reduce((count, text) => count + (text.match(/^当前状态：/gm)?.length ?? 0), 0);
}
```

The production caller projects `ToolExecutionResult.status` into `executionStatus`; tests therefore depend only on the classifier's actual input instead of constructing unrelated execution metadata. String parsing is reserved for the existing subagent envelope.

- [ ] **Step 2: Add a failing exactly-once message test**

```ts
it('appends one terminal status block to the last assistant message', () => {
  const first = finalizeTurnForUser({
    messages: [assistant('answer')],
    turnStartIndex: 0,
    toolFacts: [],
    aborted: false,
  });
  const second = finalizeTurnForUser({
    messages: first.messages,
    turnStartIndex: 0,
    toolFacts: [],
    aborted: false,
  });

  expect(second.messages).toEqual(first.messages);
  expect(countStatusBlocks(second.messages)).toBe(1);
});
```

- [ ] **Step 2a: Add a failing post-tool terminal-text boundary test**

```ts
it('does not count assistant prose before the last tool result as a terminal reply', () => {
  const result = finalizeTurnForUser({
    messages: [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 't1', name: 'task', input: {} },
        ],
      },
      toolResult('t1', '[Subagent status=incomplete reason=error]\nrecovered work'),
    ],
    turnStartIndex: 1,
    toolFacts: [tool('task', '[Subagent status=incomplete reason=error]\nrecovered work', 'success')],
    aborted: false,
  });

  expect(result.status).toBe('部分完成');
  expect(result.messages.at(-1)?.role).toBe('assistant');
  expect(countStatusBlocks(result.messages)).toBe(1);
});
```

- [ ] **Step 3: Run the new suite and confirm RED**

```powershell
npx.cmd vitest run src/__tests__/turn-final-feedback.test.ts
```

Expected: FAIL because the final-feedback module does not exist.

- [ ] **Step 4: Implement the smallest deterministic classifier**

Use these rules in order:

1. `error` or `aborted` plus useful assistant/tool output → `部分完成`.
2. `error` or `aborted` without useful output → `失败`.
3. Any `executionStatus === 'failure'` → `部分完成` when another useful result exists, otherwise `失败`.
4. A `spawn_agent` or `task` envelope with `status=incomplete|unverified` → `部分完成`.
5. A `spawn_agent` or `task` envelope with `status=completed` and a non-empty body → `成功`, even when the model did not author a later assistant message. The runtime status block becomes the required final assistant feedback and relays that completed result.
6. Non-empty assistant text after the last tool-result message, with no failure facts → `成功`.
7. No terminal assistant text after a generic successful tool output → `部分完成`; generic tool success alone does not prove the user's whole task is complete.
8. No text and no successful output → `失败`.

This distinction is intentional: an explicit completed subagent envelope is a task-level completion assertion and may produce `成功`; a successful low-level tool call is only evidence of partial progress. An incomplete/unverified child never becomes successful merely because its tool execution wrapper returned normally.

Do not parse arbitrary natural-language summaries. Parsing is restricted to the existing anchored envelope:

```ts
const SUBAGENT_ENVELOPE =
  /^\[Subagent status=(completed|incomplete|unverified)(?: reason=([^\]]+))?\]\r?\n/;
```

Build exactly this four-line block:

```ts
const feedbackText = [
  `当前状态：${status}`,
  `已获得结果：${obtainedResult}`,
  `失败或受阻位置：${blockedAt}`,
  `下一步：${nextStep}`,
].join('\n');
```

If the current turn's last assistant message already contains a block beginning with `当前状态：`, return unchanged messages. Otherwise append `\n\n${feedbackText}` to the last current-turn assistant message only when it occurs after the last tool-result message; when no such terminal assistant message exists, append a new assistant message containing only `feedbackText`.

- [ ] **Step 5: Run the focused suite**

```powershell
npx.cmd vitest run src/__tests__/turn-final-feedback.test.ts
```

Expected: all table cases pass and repeated finalization still leaves exactly one status block.

- [ ] **Step 6: Commit the pure finalizer**

```powershell
git add src/agent/turn-final-feedback.ts src/__tests__/turn-final-feedback.test.ts
git commit -m "feat: define mandatory turn feedback"
```

---

### Task 6: Enforce and Persist Final Feedback Before Turn Cleanup

**Files:**

- Modify: `src/index.ts:821-945`
- Modify: `src/__tests__/turn-final-feedback.test.ts`
- Modify: `src/__tests__/hooks.test.ts`

**Interfaces:**

- Consumes: `finalizeTurnForUser()` from Task 5.
- Produces: one finalized `Message[]` snapshot, awaited persistence of its new messages, and one final user-visible feedback emission before `finalizeTurnLifecycle()`.

- [ ] **Step 1: Add a failing integration-style commit test around the finalizer boundary**

Add an exported helper beside `finalizeTurnForUser()`:

```ts
export async function commitFinalizedTurn(
  result: TurnFinalizationResult,
  persistedMessageCount: number,
  append: (message: Message) => Promise<void>,
  emit: (text: string) => void,
): Promise<number>;
```

Specify its observable behavior before implementation:

```ts
it('persists and emits fallback text when the stream ended after a tool-only assistant', async () => {
  const appended: Message[] = [];
  const emitted: string[] = [];
  const result = finalizeTurnForUser({
    messages: [
      assistantToolUse('s1', 'task'),
      toolResult('s1', '[Subagent status=incomplete reason=error]\nrecovered work'),
    ],
    turnStartIndex: 0,
    toolFacts: [tool('task', '[Subagent status=incomplete reason=error]\nrecovered work', 'success')],
    aborted: false,
  });

  const count = await commitFinalizedTurn(
    result,
    0,
    async message => { appended.push(message); },
    text => { emitted.push(text); },
  );

  expect(count).toBe(result.messages.length);
  expect(appended.at(-1)?.role).toBe('assistant');
  expect(emitted).toEqual([result.feedbackText]);
  expect(emitted[0]).toContain('当前状态：部分完成');
});
```

- [ ] **Step 2: Add the Hook contract assertion**

Keep the existing PostToolUse expectations and add:

```ts
const hook = postToolLogger({
  name: 'PostToolUse',
  payload: { tool_name: 'task', output: 'work' },
});
expect(hook.message).toBe('[Hook] task done');
expect(hook.message).not.toContain('当前状态：');
```

This test documents that a Hook is diagnostic output and cannot satisfy finalization.

- [ ] **Step 3: Run the focused tests and confirm RED**

```powershell
npx.cmd vitest run src/__tests__/turn-final-feedback.test.ts src/__tests__/hooks.test.ts
```

Expected: FAIL because `commitFinalizedTurn()` does not exist; Hook tests continue to pass independently.

- [ ] **Step 4: Implement `commitFinalizedTurn()`**

```ts
export async function commitFinalizedTurn(
  result: TurnFinalizationResult,
  persistedMessageCount: number,
  append: (message: Message) => Promise<void>,
  emit: (text: string) => void,
): Promise<number> {
  for (const message of result.messages.slice(persistedMessageCount)) {
    await append(message);
  }
  emit(result.feedbackText);
  return result.messages.length;
}
```

The helper must await every append in order and emit only after persistence succeeds. A persistence failure is handled by the caller as a failed turn; it must not silently report success.

- [ ] **Step 5: Replace `index.ts`’s weak completion flags with collected turn facts**

At the start of `handleUserSubmit`, retain:

```ts
let finalMessages: Message[] | null = null;
const toolFacts: TurnToolFact[] = [];
let terminalError: string | undefined;
let aborted = false;
const turnStartIndex = sessionMessages.length;
let persistedMessageCount = turnStartIndex;
```

`turnStartIndex` and `persistedMessageCount` intentionally start at the same value but have different meanings:

- `turnStartIndex` is immutable and bounds classification to the current user turn.
- `persistedMessageCount` is the count of parent-session messages already durable on disk.
- The revised `onMessages` callback only captures `finalMessages`; it performs no append and therefore does not change `persistedMessageCount` during streaming.
- `commitFinalizedTurn()` receives the complete finalized snapshot, appends `messages.slice(persistedMessageCount)`, and returns the new total. For three streamed messages plus one synthesized final assistant message, the transition is `turnStartIndex → turnStartIndex + 4` in one awaited commit.

Change the existing `onMessages` callback so it only captures the finished snapshot:

```ts
onMessages: messages => {
  finalMessages = messages;
},
```

This does **not** remove parent-session incremental persistence because the current implementation has none: `StreamingQueryOptions.onMessages` is documented as a query-end callback and is invoked only from `streamingQuery()`'s outer `finally` (`src/agent/streaming-query.ts:172-175, 927-928`). The existing callback then loops over the completed snapshot and starts non-awaited appends. The revised path captures that same query-end snapshot, adds the mandatory status block, and performs one ordered awaited commit immediately before lifecycle cleanup.

Consequences are explicit:

- A process crash during provider streaming can lose the current parent turn both before and after this change; this plan does not regress that behavior.
- A process crash after `streamingQuery` returns but before final commit remains a narrow query-finalization window; closing it would require parent-turn checkpoints and is outside the child-journal repair.
- The revised path improves query-end durability by awaiting all parent session appends instead of launching them with `void`.
- Child work has the stronger per-completed-turn durability contract from Phase A and remains recoverable independently of the parent status block.

For each `tool_result`, store the structured result before running the Hook:

```ts
toolFacts.push({
  name: tr.name,
  output: tr.output,
  executionStatus: tr.executionResult?.status,
});
```

Remove `gotAnyResponse` as the turn-completion guard. Text streaming remains unchanged; the finalizer decides whether a terminal assistant message exists from `finalMessages`.

- [ ] **Step 6: Route normal, error, and abort paths through one final gate**

In `catch`, set facts instead of treating console output as completion:

```ts
if (ac.signal.aborted) {
  aborted = true;
} else {
  terminalError = formatErrorForDisplay(err);
}
```

Before `finalizeTurnLifecycle()` in `finally`, finalize and commit:

```ts
const baseMessages = finalMessages ?? sessionMessages;
const finalized = finalizeTurnForUser({
  messages: baseMessages,
  turnStartIndex,
  toolFacts,
  error: terminalError,
  aborted,
});

persistedMessageCount = await commitFinalizedTurn(
  finalized,
  persistedMessageCount,
  message => sessionStore.append(
    sessionId,
    stripImagesForPersistence(message),
  ),
  text => pipeline.emit({ kind: 'assistant_text', text, isFinal: true }),
);
sessionMessages = finalized.messages;
```

Wrap only the persistence call in a narrow error boundary. If persistence fails, build the visible failed result from the unfinalized `baseMessages` so an earlier success block cannot suppress it:

```ts
try {
  persistedMessageCount = await commitFinalizedTurn(
    finalized,
    persistedMessageCount,
    message => sessionStore.append(
      sessionId,
      stripImagesForPersistence(message),
    ),
    text => pipeline.emit({ kind: 'assistant_text', text, isFinal: true }),
  );
  sessionMessages = finalized.messages;
} catch (persistError) {
  const persistenceFailure = finalizeTurnForUser({
    messages: baseMessages,
    turnStartIndex,
    toolFacts,
    error: `最终回复落盘失败：${formatErrorForDisplay(persistError)}`,
    aborted,
  });
  sessionMessages = persistenceFailure.messages;
  pipeline.emit({
    kind: 'assistant_text',
    text: persistenceFailure.feedbackText,
    isFinal: true,
  });
}
```

This exceptional path cannot promise durable storage because storage itself failed, but it still guarantees explicit user-visible failure text. Then run the existing lifecycle cleanup.

- [ ] **Step 7: Run the focused finalization and Hook suites**

```powershell
npx.cmd vitest run src/__tests__/turn-final-feedback.test.ts src/__tests__/hooks.test.ts
```

Expected: all tests pass; the final assistant feedback is persisted and emitted after the Hook, and Hook text has no terminal status marker.

- [ ] **Step 8: Run TypeScript immediately after the `index.ts` wiring**

```powershell
npm.cmd run typecheck
```

Expected: exit 0. In particular, the `tool_result` branch must project `tr.executionResult?.status` into `TurnToolFact.executionStatus` without retaining unrelated execution metadata.

- [ ] **Step 9: Commit the final gate**

```powershell
git add src/agent/turn-final-feedback.ts src/index.ts src/__tests__/turn-final-feedback.test.ts src/__tests__/hooks.test.ts
git commit -m "fix: always finish turns with user feedback"
```

---

### Task 7: Run Cross-Layer Acceptance Regression

**Files:**

- Modify only if a test exposes a defect in Tasks 1-6: files already listed in this plan.
- Test: all focused suites listed below.

**Interfaces:**

- Consumes: completed Phase A and Phase B behavior.
- Produces: verification evidence for every requested acceptance scenario.

- [ ] **Step 1: Run the child-path acceptance set**

```powershell
npx.cmd vitest run src/__tests__/streaming-query.test.ts src/__tests__/session-store-subagent-journal.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts src/__tests__/subagent-explicit-delegation.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts --reporter=verbose
```

Expected:

- normal child completion persists a journal and returns a summary;
- provider failure after one successful tool result returns recovered content;
- empty final-summary turn returns recovered content rather than `(no final text)`;
- total failure returns an incomplete/failed envelope without invented results;
- `spawn_agent` and `task` both allocate journals and return status envelopes.

- [ ] **Step 2: Run the parent-feedback acceptance set**

```powershell
npx.cmd vitest run src/__tests__/turn-final-feedback.test.ts src/__tests__/hooks.test.ts --reporter=verbose
```

Expected:

- success, partial completion, and failure each generate all four required fields;
- recovered child work is included in partial-completion facts;
- tool-only and empty-final-message cases still commit an assistant message;
- `[Hook] task done` is never interpreted as a final assistant reply;
- repeated finalization does not duplicate the status block.

- [ ] **Step 3: Run affected-module regression**

```powershell
npx.cmd vitest run src/__tests__/streaming-query.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts src/__tests__/subagent-explicit-delegation.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts src/__tests__/hooks.test.ts src/__tests__/turn-final-feedback.test.ts src/__tests__/session-store-subagent-journal.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 4: Run static checks**

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: both commands exit 0; no unused journal/finalization symbols and no floating promises.

- [ ] **Step 5: Run the full test suite**

```powershell
npm.cmd test
```

Expected: all repository tests pass. If an unrelated pre-existing failure appears, record the exact failing test and verify the focused acceptance set remains green; do not modify unrelated code.

- [ ] **Step 6: Inspect the final diff for scope**

```powershell
$baseCommit = git merge-base HEAD master
git diff --stat "$baseCommit..HEAD"
git diff --name-only "$baseCommit..HEAD"
git diff --check
git status --short
```

Expected: the branch-point diff—not a fixed commit count—contains only files in this plan, `git diff --check` reports no whitespace errors, and no generated `.transcripts` or temporary journal files are staged. This repository's verified integration branch is `master`; if execution begins after that branch is renamed, replace `master` with the actual branch reported by `origin/HEAD` before starting Task 1.

- [ ] **Step 7: Request code review**

Use `superpowers:requesting-code-review`. Block completion for correctness issues involving:

- a non-awaited checkpoint;
- duplicate or missing JSONL records;
- lost tool result bodies after failure;
- a Hook/warning being counted as terminal assistant output;
- final feedback emitted but not persisted;
- a user turn leaving lifecycle cleanup without a status block.

- [ ] **Step 8: Apply verification-before-completion and prepare branch handoff**

Use `superpowers:verification-before-completion` with fresh outputs from Steps 1-5, then `superpowers:finishing-a-development-branch`. Do not claim the repair complete from source inspection alone.

---

## Acceptance Traceability

| Required behavior | Implemented by | Proved by |
|---|---|---|
| Child completes normally with final summary | Tasks 1-4 | Streaming checkpoint test plus existing completed-result tests |
| Child does partial work then fails | Tasks 1-3 | Provider-failure recovery test with persisted tool result body |
| Child completely fails but parent replies clearly | Tasks 5-6 | Failure classification and committed fallback tests |
| Missing final summary does not discard completed work | Tasks 1-4 | Empty-final-summary recovery test and journal reload assertion |
| `[Hook] task done` cannot replace assistant reply | Tasks 5-6 | Hook marker assertion plus tool-only finalization test |
| Every user turn exposes status and next step | Tasks 5-6 | Classification table asserting all four fields |
| Results survive reload/corrupt tail | Task 2 | JSONL reload, deduplication, and corrupt-tail tests |
| Both `spawn_agent` and `task` use the same reliability path | Task 4 | Factory-injection and common-envelope tests |
