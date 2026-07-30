# Tool Transcript Compaction Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure context compaction never destroys `tool_use.id === tool_result.tool_use_id` pairs, so a successful `spawn_agent` result can survive later tool rounds and pass the next `before_provider_send` checkpoint.

**Architecture:** Keep the existing transcript validator and fail-closed checkpoints unchanged. Fix the producer of the invalid transcript: L2 micro-compaction must shorten only `ToolResultBlock.content` while retaining the block type and ID; L1 snip-compaction must choose a removal interval that does not cross any tool pair. Add a real multi-turn `streamingQuery` regression that executes more than three long tool-result rounds and reaches the provider's final turn.

**Tech Stack:** Node.js 18+, TypeScript ES2022/NodeNext, Vitest, existing `Message`/`ContentBlock` types and `validateToolTranscript`.

## Global Constraints

- Preserve all uncommitted changes from the preceding subagent error-propagation fix.
- Do not modify `src/agent/subagent.ts`, `src/agent/stream-event-bus.ts`, `src/utils/error-message.ts`, or their new tests.
- Do not modify `src/prompts/planner.generated.ts`; its current diff belongs to the user.
- Do not weaken, bypass, or remove any transcript checkpoint.
- Do not synthesize a successful tool result. Compaction may shorten content, but must retain the original result identity.
- Do not change `KEEP_RECENT = 3`, `SNIP_THRESHOLD = 50`, `SNIP_KEEP_TAIL = 47`, or `COMPACT_MIN_LENGTH = 120`.
- Do not add dependencies or new public types.
- Follow RED → GREEN → REFACTOR and run focused tests before wider tests.
- Leave changes uncommitted unless the user separately authorizes a commit.

## Confirmed Root Cause

The observed missing IDs were the two initial parallel `spawn_agent` calls. After later `read_file`/`glob`/`grep` rounds, more than three tool-result messages existed. `microCompact()` replaced the oldest result message with:

```ts
{
  role: 'user',
  content: [{
    type: 'text',
    text: '[Earlier tool result compacted. Re-run if needed.]',
  }],
}
```

That deleted both `tool_result.tool_use_id` values while retaining both preceding `tool_use` blocks. The next provider preflight correctly rejected the transcript with:

```text
pair.missing_result:call_e04218618a19495696c02f78
pair.missing_result:call_1d0322612d0546b49827101e
```

A local reproduction using five long tool rounds produced the same two `pair.missing_result` reasons. A second reproduction showed that `snipCompact()` can also split a pair when one half is in the fixed three-message head and the other half is in the removed middle.

## Wheel Reuse Check

- Reuse `ContentBlock` and `ToolResultBlock` from `src/agent/types.ts`; do not create a compacted-result type.
- Reuse `validateToolTranscript()` for behavioral assertions; do not duplicate pairing logic in tests.
- Reuse `CapturingStreamClient`, `ToolRegistry`, and `drain()` in `src/__tests__/agent/tool-transcript-checkpoints.test.ts`.
- Keep `before_compaction` and `before_provider_send` as the enforcement boundaries. The fix belongs in `compression.ts`, not in the validator.

## File Map

- Modify `src/agent/compression.ts`: preserve tool-result identity during L2 compaction and calculate pair-safe L1 snip boundaries.
- Modify `src/__tests__/compression.test.ts`: focused unit regressions for L1 and L2 behavior.
- Modify `src/__tests__/agent/tool-transcript-checkpoints.test.ts`: validator-backed and full streaming-loop regressions.

---

### Task 1: Preserve `tool_result` identity during micro-compaction

**Files:**
- Modify: `src/agent/compression.ts:26-127`
- Test: `src/__tests__/compression.test.ts:69-109`

**Interfaces:**
- Consumes: `Message`, `ContentBlock`, and the existing `microCompact(messages: Message[]): Message[]`.
- Produces: the same `microCompact` signature; compacted blocks remain `{ type: 'tool_result'; tool_use_id: string; content: string }`.

- [ ] **Step 1: Change the existing expectation into a failing identity-preservation test**

Replace the current “should compact old tool results longer than 120 chars” assertions with:

```ts
it('should compact old tool result content without deleting its identity', () => {
  const longContent = 'x'.repeat(200);
  const messages = [
    makeToolResult('r1', longContent),
    makeToolResult('r2', longContent),
    makeToolResult('r3', longContent),
    makeToolResult('r4', 'keep'),
    makeToolResult('r5', 'keep'),
    makeToolResult('r6', 'keep'),
  ];

  const compacted = microCompact(messages);
  const first = (compacted[0]!.content as ContentBlock[])[0]!;

  expect(first).toEqual({
    type: 'tool_result',
    tool_use_id: 'r1',
    content: '[Earlier tool result compacted. Re-run if needed.]',
  });
  expect(compacted[3]).toEqual(messages[3]);
});
```

Add coverage for a parallel tool-result message:

```ts
it('should preserve every tool_use_id in a compacted parallel result message', () => {
  const parallel: Message = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'spawn_1', content: 'x'.repeat(200) },
      { type: 'tool_result', tool_use_id: 'spawn_2', content: 'y'.repeat(200) },
    ],
  };
  const messages = [
    parallel,
    makeToolResult('r2', 'x'.repeat(200)),
    makeToolResult('r3', 'x'.repeat(200)),
    makeToolResult('r4', 'keep'),
  ];

  const compacted = microCompact(messages);
  const blocks = compacted[0]!.content as ContentBlock[];

  expect(blocks).toEqual([
    {
      type: 'tool_result',
      tool_use_id: 'spawn_1',
      content: '[Earlier tool result compacted. Re-run if needed.]',
    },
    {
      type: 'tool_result',
      tool_use_id: 'spawn_2',
      content: '[Earlier tool result compacted. Re-run if needed.]',
    },
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/__tests__/compression.test.ts
```

Expected: both new assertions fail because the current result contains a `text` block and no `tool_use_id`.

- [ ] **Step 3: Implement the minimal identity-preserving rewrite**

In `src/agent/compression.ts`, add one private constant beside the existing compression constants:

```ts
const COMPACTED_TOOL_RESULT =
  '[Earlier tool result compacted. Re-run if needed.]';
```

Replace the whole-message rewrite inside `microCompact()` with a block-level rewrite:

```ts
const blocks = msg.content as ContentBlock[];
compacted[idx] = {
  ...msg,
  content: blocks.map(block => (
    block.type === 'tool_result'
      ? { ...block, content: COMPACTED_TOOL_RESULT }
      : block
  )),
};
```

Do not convert a `tool_result` into `text`. Preserve non-result blocks if a mixed content array is encountered.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npx vitest run src/__tests__/compression.test.ts
```

Expected: all compression tests pass.

- [ ] **Step 5: Review the Task 1 diff**

Run:

```powershell
git diff -- src/agent/compression.ts src/__tests__/compression.test.ts
```

Verify that the diff changes only result content, not result IDs, thresholds, or public signatures. Do not commit.

---

### Task 2: Prevent L1 snipping from crossing a tool pair

**Files:**
- Modify: `src/agent/compression.ts:55-90`
- Test: `src/__tests__/compression.test.ts:35-67`

**Interfaces:**
- Consumes: `Message[]` and the existing `snipCompact(messages: Message[]): Message[]`.
- Produces: the same `snipCompact` signature; only a contiguous middle interval is removed, and neither boundary may lie inside the span of a paired tool call.

- [ ] **Step 1: Replace the weak boundary test with two failing behavioral tests**

Replace the current test that only asserts `result.length` with:

```ts
it('should keep a pair intact when the fixed head would split it', () => {
  const messages: Message[] = [];
  for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));
  messages[2] = makeToolUse('call_head', 'bash');
  messages[10] = makeToolResult('call_head', 'output');

  const compacted = snipCompact(messages);
  const ids = compacted.flatMap(message =>
    Array.isArray(message.content)
      ? message.content.flatMap(block => {
          if (block.type === 'tool_use') return [block.id];
          if (block.type === 'tool_result') return [block.tool_use_id];
          return [];
        })
      : [],
  );

  expect(ids.filter(id => id === 'call_head')).toHaveLength(2);
});
```

Add a tail-boundary regression:

```ts
it('should keep a pair intact when the tail boundary would split it', () => {
  const messages: Message[] = [];
  for (let i = 0; i < 60; i++) messages.push(makeMsg('user', `msg ${i}`));
  messages[10] = makeToolUse('call_tail', 'bash');
  messages[14] = makeToolResult('call_tail', 'output');

  const compacted = snipCompact(messages);
  const ids = compacted.flatMap(message =>
    Array.isArray(message.content)
      ? message.content.flatMap(block => {
          if (block.type === 'tool_use') return [block.id];
          if (block.type === 'tool_result') return [block.tool_use_id];
          return [];
        })
      : [],
  );

  expect(ids.filter(id => id === 'call_tail')).not.toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/__tests__/compression.test.ts
```

Expected: both new cases fail because the current algorithm can retain only one side of each deliberately non-adjacent pair.

- [ ] **Step 3: Add a private helper that calculates complete pair spans**

Add this private helper above `snipCompact()`:

```ts
function collectToolPairSpans(
  messages: Message[],
): Array<{ start: number; end: number }> {
  const uses = new Map<string, number>();
  const results = new Map<string, number>();

  for (let index = 0; index < messages.length; index++) {
    const content = messages[index]!.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'tool_use') uses.set(block.id, index);
      if (block.type === 'tool_result') {
        results.set(block.tool_use_id, index);
      }
    }
  }

  const spans: Array<{ start: number; end: number }> = [];
  for (const [id, useIndex] of uses) {
    const resultIndex = results.get(id);
    if (resultIndex === undefined) continue;
    spans.push({
      start: Math.min(useIndex, resultIndex),
      end: Math.max(useIndex, resultIndex),
    });
  }
  return spans;
}
```

This helper only identifies pairs already present. It must not synthesize missing results or change validator behavior.

- [ ] **Step 4: Make both removal boundaries pair-safe**

Replace the existing one-sided `while (cutPoint > headCount)` boundary logic with:

```ts
let cutStart = 3;
let cutEnd = messages.length - SNIP_KEEP_TAIL;
const spans = collectToolPairSpans(messages);

let changed = true;
while (changed) {
  changed = false;
  for (const span of spans) {
    if (span.start < cutStart && cutStart <= span.end) {
      cutStart = span.end + 1;
      changed = true;
    }
    if (span.start < cutEnd && cutEnd <= span.end) {
      cutEnd = span.start;
      changed = true;
    }
  }
}

if (cutStart >= cutEnd) return messages;

const snipped = cutEnd - cutStart;
return [
  ...messages.slice(0, cutStart),
  { role: 'user', content: `[snipped ${snipped} messages...]` },
  ...messages.slice(cutEnd),
];
```

The loop computes closure when overlapping spans push a boundary into another span. It preserves message order and still removes one contiguous middle interval.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```powershell
npx vitest run src/__tests__/compression.test.ts
```

Expected: both boundary tests and all existing compression tests pass.

- [ ] **Step 6: Review the Task 2 diff**

Run:

```powershell
git diff -- src/agent/compression.ts src/__tests__/compression.test.ts
```

Verify that `snipCompact()` still returns the original array below 51 messages and still uses one `[snipped N messages...]` marker. Do not commit.

---

### Task 3: Protect the full compaction-to-next-provider path

**Files:**
- Test: `src/__tests__/agent/tool-transcript-checkpoints.test.ts:177-238`
- Test: `src/__tests__/agent/tool-transcript-checkpoints.test.ts:241-350`

**Interfaces:**
- Consumes: `runCompaction()`, `validateToolTranscript()`, `streamingQuery()`, `CapturingStreamClient`, and `ToolRegistry`.
- Produces: regression evidence that an accepted pre-compaction transcript remains accepted after compaction and that the next provider request occurs.

- [ ] **Step 1: Add a validator-backed compaction invariant test**

Inside the existing `runCompaction` checkpoint describe block, add:

```ts
it('accepted transcript remains accepted after L1/L2 compaction', () => {
  const messages: Message[] = [userText('start')];
  for (let index = 1; index <= 5; index++) {
    messages.push(use(`call_${index}`, index <= 2 ? 'spawn_agent' : 'echo'));
    messages.push(result(`call_${index}`, 'x'.repeat(200)));
  }

  const preflight = acceptedValidation('before_compaction', messages);
  const compacted = runCompaction(messages, {
    preflightValidation: preflight,
  }).messages;
  const postflight = validateToolTranscript(snapshot(compacted), {
    checkpoint: 'before_provider_send',
    ...POLICY,
  });

  expect(postflight.status).toBe('accepted');
  expect(postflight.reason_codes).toEqual([]);
  expect(postflight.pair_records.every(pair => pair.state === 'paired')).toBe(true);
});
```

- [ ] **Step 2: Temporarily revert only the Task 1 implementation and verify the invariant test is RED**

Use the editor to restore the old whole-message `text` rewrite only, run:

```powershell
npx vitest run src/__tests__/agent/tool-transcript-checkpoints.test.ts
```

Expected: the new invariant test fails with `pair.missing_result:call_1` and `pair.missing_result:call_2`. Immediately restore the Task 1 implementation; do not use `git checkout` because the working tree contains unrelated user changes.

- [ ] **Step 3: Add a real five-request streaming regression**

In `streamingQuery before_provider_send integration`, add:

```ts
it('continues to the next provider turn after old long tool results are compacted', async () => {
  const scripts: ContentBlock[][] = [
    [{ type: 'tool_use', id: 'call_1', name: 'echo', input: {} }],
    [{ type: 'tool_use', id: 'call_2', name: 'echo', input: {} }],
    [{ type: 'tool_use', id: 'call_3', name: 'echo', input: {} }],
    [{ type: 'tool_use', id: 'call_4', name: 'echo', input: {} }],
    [{ type: 'text', text: 'done' }],
  ];
  const client = new CapturingStreamClient(scripts);
  const registry = new ToolRegistry();
  const echo: ToolDefinition = {
    name: 'echo',
    description: 'returns a long deterministic result',
    parameters: { type: 'object', properties: {} },
  };
  registry.register(echo, async () => 'x'.repeat(200));

  await drain(streamingQuery(client, registry, 'continue', {
    systemPrompt: 'sys',
    tools: registry.getDefinitions(),
    signal: new AbortController().signal,
    maxTurns: 6,
    enableStreamingExecution: false,
  }));

  expect(client.streamCallCount).toBe(5);
});
```

This test exercises the same lifecycle as the report: completed tool calls accumulate, L2 compacts the oldest result, and the next loop runs `before_provider_send`.

- [ ] **Step 4: Run the integration test and verify GREEN**

Run:

```powershell
npx vitest run src/__tests__/agent/tool-transcript-checkpoints.test.ts
```

Expected: all checkpoint tests pass and the new streaming test observes exactly five provider calls.

- [ ] **Step 5: Run affected-module regression**

Run:

```powershell
npx vitest run src/__tests__/compression.test.ts src/__tests__/agent/tool-transcript-validator.test.ts src/__tests__/agent/tool-transcript-checkpoints.test.ts src/__tests__/streaming-query.test.ts
```

Expected: all selected suites pass.

- [ ] **Step 6: Run static verification**

Run:

```powershell
npm run typecheck
npm run lint
```

Expected: both commands exit with code 0 and introduce no unused imports or floating promises.

- [ ] **Step 7: Run full regression**

Run:

```powershell
npx vitest run
```

Expected: the full suite passes. If a pre-existing failure appears, first verify whether it also occurs on the unmodified baseline; do not alter unrelated code to make it green.

- [ ] **Step 8: Protect the generated prompt and inspect final scope**

Run:

```powershell
git diff -- src/prompts/planner.generated.ts
git diff -- src/agent/compression.ts src/__tests__/compression.test.ts src/__tests__/agent/tool-transcript-checkpoints.test.ts
git status --short
```

Expected: `planner.generated.ts` is unchanged relative to its state before this plan began; the new fix touches only the three files listed in the File Map. Do not commit.

## Out-of-Scope Follow-up: Ordered Session Persistence

The inspected session JSONL also contained message records out of runtime order. `src/index.ts` currently launches every `sessionStore.append()` with `void` inside a loop, so multiple `appendFile()` operations race. This did not cause the live `before_provider_send` failure—the in-memory `microCompact()` reproduction does—but it can corrupt ordering on resume.

Handle persistence ordering in a separate plan. Its minimum acceptance test should append delayed messages concurrently through the production persistence adapter and assert that `SessionStore.load()` returns the original `user → assistant(tool_use) → user(tool_result)` order. Do not mix that change into the compaction fix.
