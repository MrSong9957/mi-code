# Unified Tool Execution Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `executeToolCall()` the single execution boundary for P1-P5, with one validation/authorization/execution pipeline and a structured result that later Hook and verification-ledger work can consume.

**Architecture:** `ToolRegistry` remains a registration/lookup container and exposes the full registered pair through `get()`. The new `src/agent/tool-execution.ts` owns validation, final-input identity, permission-gate execution, operational-error classification, result construction, and the three callback injection points. Streaming, serial fallback, and all three child modes receive the same required `ToolExecutionRuntime` and delegate to that boundary.

**Tech Stack:** TypeScript ES2022/NodeNext, Node.js `crypto`, Vitest, ESLint flat config, existing `PermissionChecker`, existing `RuntimeSecurityGate`, existing `freezeSnapshot`.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-07-31-unified-tool-execution-design.md`.
- Follow RED → GREEN → REFACTOR. Run each focused test once before implementation and confirm it fails for the intended missing behavior.
- Do not add Hook discovery/configuration, a verification ledger, delegated child authorization, AJV, or speculative abstractions.
- Keep `ToolRegistry.execute()` public and unchanged for the explicitly deferred legacy paths.
- P1-P5 may not call `registry.execute()` directly after migration.
- The original input is cloned before lookup; the final candidate is cloned and deep-frozen before permission/execution.
- Permission and executor must observe the same final input values.
- Unclassified executor exceptions and Pre callback invariant failures must bubble.
- Post/Failure callback exceptions must attach structured callback errors without changing the already-determined success/failure status.
- `durationMs` excludes Post/Failure callback time.
- Do not stage or modify unrelated existing worktree changes.

---

## Task 1: Establish Registry Lookup and Public Execution Contracts

**Files:**

- Modify: `src/agent/tool-registry.ts`
- Modify: `src/agent/types.ts`
- Create: `src/agent/tool-execution.ts`
- Create: `src/__tests__/agent/tool-execution.test.ts`

### 1.1 RED: specify full Registry lookup

- [ ] Add a test proving `get()` returns the exact registered definition and executor reference:

```ts
it('returns the complete registered tool without replacing its executor', () => {
  const registry = new ToolRegistry();
  const definition: ToolDefinition = {
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object' },
  };
  const executor: ToolExecutor = async () => 'ok';

  registry.register(definition, executor);

  expect(registry.get('echo')).toEqual({ definition, executor });
  expect(registry.get('echo')?.executor).toBe(executor);
  expect(registry.get('missing')).toBeUndefined();
});
```

- [ ] Run:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts
```

Expected: FAIL because `ToolRegistry.get()` does not exist.

### 1.2 GREEN: add the minimal lookup

- [ ] Add this method without changing `execute()`:

```ts
get(name: string): RegisteredTool | undefined {
  return this.tools.get(name);
}
```

- [ ] Run the focused test and confirm it passes.

### 1.3 Add the agreed contract surface

- [ ] Add `signal?: AbortSignal` to `ToolExecutionContext` in `src/agent/types.ts`; retain `sanitizedExecutionPlan`.
- [ ] In `src/agent/tool-execution.ts`, define and export:

```ts
export interface CallbackError {
  name: string;
  message: string;
  code?: string;
}

export interface ToolExecutionStageHits {
  preExecute: boolean;
  postExecute: boolean;
  failure: boolean;
}

export interface ToolExecutionBase {
  toolUseId: string;
  toolName: string;
  inputUsed: Readonly<Record<string, unknown>>;
  durationMs: number;
  stageHits: ToolExecutionStageHits;
}

export interface ToolExecutionSuccess extends ToolExecutionBase {
  status: 'success';
  output: string;
  postExecuteError?: CallbackError;
}

type ToolExecutionFailureDetail =
  | { kind: 'unknown_tool'; stage: 'lookup'; message: string }
  | { kind: 'invalid_input'; stage: 'validation'; message: string }
  | { kind: 'permission_denied'; stage: 'permission'; message: string; code?: string }
  | { kind: 'cancelled'; stage: 'execution'; message: string; code?: string }
  | { kind: 'timeout'; stage: 'execution'; message: string; code?: string }
  | { kind: 'operational_error'; stage: 'execution'; message: string; code?: string };

export interface ToolExecutionFailure extends ToolExecutionBase {
  status: 'failure';
  output: string;
  failure: ToolExecutionFailureDetail;
  failureCallbackError?: CallbackError;
}

export type ToolExecutionResult =
  | ToolExecutionSuccess
  | ToolExecutionFailure;
```

- [ ] Define and export the callback and runtime injection contracts:

```ts
export interface ToolPreExecuteContext {
  toolUseId: string;
  toolName: string;
  input: Readonly<Record<string, unknown>>;
}

export interface ToolPreExecuteResult {
  updatedInput?: Record<string, unknown>;
}

export interface ToolExecutionCallbacks {
  onPreExecute?: (
    context: ToolPreExecuteContext,
  ) =>
    | void
    | ToolPreExecuteResult
    | Promise<void | ToolPreExecuteResult>;
  onPostExecute?: (
    result: ToolExecutionSuccess,
  ) => void | Promise<void>;
  onFailure?: (
    result: ToolExecutionFailure,
  ) => void | Promise<void>;
}

export interface ToolExecutionRuntime {
  permissionChecker: PermissionChecker;
  runtimeGate: RuntimeSecurityGate;
  callbacks?: ToolExecutionCallbacks;
}
```

- [ ] Define and export:

```ts
export class ToolOperationalError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'ToolOperationalError';
  }
}

export class PreCallbackInputViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreCallbackInputViolation';
  }
}
```

- [ ] Do not add `executeToolCall()` until Task 2 has a failing behavioral test and can implement a usable lookup/validation/permission/success path in the same commit.

### 1.4 Verify and commit

- [ ] Run:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts
npx tsc --noEmit
```

- [ ] Commit only Task 1 files:

```bash
git add src/agent/tool-registry.ts src/agent/types.ts src/agent/tool-execution.ts src/__tests__/agent/tool-execution.test.ts
git commit -m "feat: define unified tool execution contracts"
```

---

## Task 2: Implement Lookup, Original-Input Validation, and Success

**Files:**

- Modify: `src/agent/tool-execution.ts`
- Modify: `src/__tests__/agent/tool-execution.test.ts`
- Create: `src/__tests__/helpers/tool-execution-runtime.ts`

### 2.1 Build one concrete test runtime

- [ ] Add a test-only in-memory `PendingDecisionStore`.
- [ ] Export `createToolExecutionRuntime()` with a real `PermissionChecker` and real `RuntimeSecurityGate`:

```ts
export function createToolExecutionRuntime(
  options: {
    mode?: PermissionMode;
    channel?: UserDecisionChannel | null;
    callbacks?: ToolExecutionCallbacks;
  } = {},
): ToolExecutionRuntime
```

Default it to `mode: 'auto'` and `channel: null`; auto-allowed tests do not need a decision channel. Reuse the in-memory store pattern from `src/__tests__/permission/runtime-gate.test.ts`.

### 2.2 RED: lookup, recursive validation, and success

- [ ] Add tests for:

  - unknown tool → `status: 'failure'`, `kind: 'unknown_tool'`, `stage: 'lookup'`;
  - valid input → success with executor output;
  - required property missing → `invalid_input + validation`;
  - nested object failure path;
  - nested array failure path such as `$.questions[0].header`;
  - number is not coerced from a string;
  - extra properties are accepted;
  - `inputUsed` is a deep snapshot and remains unchanged when the original object is mutated later;
  - no configured callback leaves all stage hits false;
  - duration is non-negative.

- [ ] Run the focused test and confirm failures come from the temporary implementation.

### 2.3 GREEN: implement the declared schema subset

- [ ] Add the public boundary:

```ts
export async function executeToolCall(
  registry: ToolRegistry,
  call: ToolUseBlock,
  runtime: ToolExecutionRuntime,
  context: Omit<ToolExecutionContext, 'toolUseId'> = {},
): Promise<ToolExecutionResult>
```

The function itself owns `toolUseId` from `call.id`; callers may only supply `signal` and existing execution-plan fields.

- [ ] Add a private recursive validator over `ToolParameter`:

```ts
type ValidationResult =
  | { valid: true }
  | { valid: false; message: string };

function validateToolInput(
  value: unknown,
  schema: ToolParameter,
  path = '$',
): ValidationResult
```

- [ ] Implement only:

  - `object`, `string`, `number`, `boolean`, `array`, `null`;
  - `required`, `properties`, `items`;
  - recursive nested paths;
  - extra-property compatibility.

- [ ] Use `typeof value === 'number' && Number.isFinite(value)` for `number`.
- [ ] Reject arrays for `object`; reject `null` for `object`.
- [ ] Keep deterministic first-error traversal using the schema’s property order and ascending array index.

### 2.4 GREEN: implement lookup and success boundary

- [ ] At entry, record `performance.now()` and `structuredClone(call.input)`.
- [ ] Resolve through `registry.get(call.name)`.
- [ ] On lookup/validation failure, construct the structured failure with a deep-frozen snapshot.
- [ ] Generate the decision from the final input:

```ts
const actionSnapshotId =
  `snap:${createHash('sha256')
    .update(JSON.stringify({ name: call.name, input: finalInput }))
    .digest('hex')
    .slice(0, 16)}`;

const decision = runtime.permissionChecker.checkDecision(
  call.name,
  finalInput,
  {
    decision_id: `exec:${call.id}`,
    action_snapshot_id: actionSnapshotId,
    policy_id: 'permission-default',
    policy_version: '1',
  },
);
```

- [ ] Call `runtime.runtimeGate.execute(decision, executorCallback)`.
- [ ] Invoke the exact executor returned by `registry.get()` with:

```ts
await registered.executor(finalInput, {
  ...context,
  toolUseId: call.id,
});
```

- [ ] If the gate returns `DeniedAction`, construct `permission_denied + permission` using `human_reason` as the model-facing output and `reason_code` as `code`.
- [ ] If the executor returns, construct success.
- [ ] Stop duration measurement before notification callbacks are introduced.

### 2.5 Verify and commit

- [ ] Run:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts
npx tsc --noEmit
```

- [ ] Commit:

```bash
git add src/agent/tool-execution.ts src/__tests__/agent/tool-execution.test.ts src/__tests__/helpers/tool-execution-runtime.ts
git commit -m "feat: validate and authorize unified tool calls"
```

---

## Task 3: Implement Pre Callback and Final-Input Identity

**Files:**

- Modify: `src/agent/tool-execution.ts`
- Modify: `src/__tests__/agent/tool-execution.test.ts`

### 3.1 RED: Pre semantics and identity invariant

- [ ] Add tests proving:

  - Pre sees an immutable snapshot of valid original input;
  - in-place mutation of Pre context cannot alter executed input;
  - `{ updatedInput }` is a complete replacement, not a patch;
  - a valid replacement is revalidated and executed;
  - PermissionChecker and executor receive deeply equal final values;
  - executor mutation cannot alter returned `inputUsed`;
  - Pre starts before permission checking and sets `stageHits.preExecute=true`;
  - Pre returning `null`, an array, extra keys, or non-object data throws an invariant error;
  - a replacement missing a required field throws `PreCallbackInputViolation`;
  - original invalid input still returns normal `invalid_input` and never calls Pre.

- [ ] Add a spying `PermissionChecker` subclass or method spy around `checkDecision()` to capture the authorized input without mocking `RuntimeSecurityGate`.
- [ ] Run the focused test and verify the new cases fail.

### 3.2 GREEN: insert Pre into the decision chain

- [ ] Run Pre only after original validation.
- [ ] Mark `stageHits.preExecute = true` immediately before invoking the configured callback.
- [ ] Pass Pre a separately cloned and frozen context input.
- [ ] Accept only:

  - `undefined`;
  - a plain object whose only allowed key is `updatedInput`;
  - `updatedInput` absent or a plain record.

- [ ] Treat `updatedInput` as the whole input. Revalidate it with the registered schema.
- [ ] Wrap replacement validation failure in `PreCallbackInputViolation`.
- [ ] After Pre completes, make two independent deep clones:

  - mutable `executorInput`, passed to PermissionChecker and executor;
  - frozen `inputUsed`, retained in the result.

This separation preserves the snapshot even if a legacy executor mutates its input.

### 3.3 Verify and commit

- [ ] Run:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts
npx tsc --noEmit
```

- [ ] Commit:

```bash
git add src/agent/tool-execution.ts src/__tests__/agent/tool-execution.test.ts
git commit -m "feat: enforce pre-execution input invariants"
```

---

## Task 4: Classify Executor Failures Without Swallowing Bugs

**Files:**

- Modify: `src/agent/tool-execution.ts`
- Modify: `src/__tests__/agent/tool-execution.test.ts`

### 4.1 RED: explicit classification table

- [ ] Add one test per classifier row:

  - `ToolOperationalError` → `operational_error`;
  - ordinary `Error` with any string `code` → `operational_error`;
  - `AbortError` → `cancelled`;
  - `TimeoutError` → `timeout`;
  - `TypeError` bubbles by identity;
  - unmarked `Error` bubbles by identity;
  - non-`Error` thrown value bubbles unchanged;
  - an error whose message contains “timeout” but whose name/code is unmarked bubbles.

- [ ] Include an arbitrary open-set errno such as `EUNLISTED_TEST_CODE`; this prevents implementation by enumerating known codes.
- [ ] Run the focused test and confirm the classification cases fail.

### 4.2 GREEN: classify only values thrown by the executor

- [ ] Add an internal classifier returning the structured execution failure detail or `undefined`.
- [ ] Preserve this exact order:

```ts
if (error instanceof ToolOperationalError) { /* operational */ }
if (
  error instanceof Error
  && 'code' in error
  && typeof (error as NodeJS.ErrnoException).code === 'string'
) { /* operational */ }
if (error instanceof Error && error.name === 'AbortError') { /* cancelled */ }
if (error instanceof Error && error.name === 'TimeoutError') { /* timeout */ }
return undefined;
```

- [ ] Do not wrap the whole `runtimeGate.execute(...)` call in the executor classifier. A store/channel/gate exception is not an executor business failure.
- [ ] Inside the callback passed to the gate, capture only the executor outcome:

```ts
type ExecutorOutcome =
  | { kind: 'returned'; output: string }
  | { kind: 'threw'; error: unknown };

const gated = await runtime.runtimeGate.execute(decision, async () => {
  try {
    return {
      kind: 'returned',
      output: await registered.executor(executorInput, executorContext),
    } satisfies ExecutorOutcome;
  } catch (error) {
    return { kind: 'threw', error } satisfies ExecutorOutcome;
  }
});
```

- [ ] Process `DeniedAction` first. For an authorized `threw` outcome, run the classifier; if it returns no failure, rethrow `gated.error` unchanged.
- [ ] Do not inspect `message` for classification.

### 4.3 Verify and commit

- [ ] Run:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts
npx tsc --noEmit
```

- [ ] Commit:

```bash
git add src/agent/tool-execution.ts src/__tests__/agent/tool-execution.test.ts
git commit -m "feat: classify operational tool failures"
```

---

## Task 5: Add Callback Exception Post-processing as an Independent Batch

**Files:**

- Modify: `src/agent/tool-execution.ts`
- Modify: `src/__tests__/agent/tool-execution.test.ts`

This task deliberately starts only after Tasks 2-4 have fixed the success/failure fact. It tests the “result constructed but not returned” phase independently from the main 1-20 execution sequence.

### 5.1 RED: Pre exception behavior

- [ ] Add tests proving:

  - a normal `Error` from Pre bubbles unchanged;
  - a non-`Error` from Pre bubbles unchanged;
  - executor and permission checker are not called;
  - Pre’s stage is considered hit internally, but no result is returned.

Do not add a catch around Pre merely to observe stage hits; the absence of a result is the contract.

### 5.2 RED: Post cannot erase success

- [ ] Add tests proving:

  - Post receives the already-built `ToolExecutionSuccess`;
  - `stageHits.postExecute` is true in the object passed to Post;
  - Post throwing `Error` preserves `status: 'success'` and output;
  - Post throwing a non-`Error` also preserves success;
  - the thrown value is safely serialized into exported `postExecuteError`;
  - callback time is excluded from `durationMs`.

Use a deferred promise or fake timers so the callback takes measurable time without relying on a flaky wall-clock threshold.

### 5.3 RED: Failure notification cannot erase failure

- [ ] Parameterize lookup, validation, permission, and classified execution failures.
- [ ] For each, prove:

  - Failure receives the already-built `ToolExecutionFailure`;
  - `stageHits.failure` is true in the callback argument;
  - a thrown `Error` preserves the original failure kind/stage/output;
  - a thrown non-`Error` preserves failure;
  - the callback problem is attached as `failureCallbackError`;
  - callback time is excluded from `durationMs`.

- [ ] Run the focused test and confirm these post-processing cases fail independently of Tasks 2-4.

### 5.4 GREEN: centralize result finalization

- [ ] Add a safe serializer that never throws:

```ts
function toCallbackError(value: unknown): CallbackError {
  if (value instanceof Error) {
    const result: CallbackError = {
      name: value.name || 'Error',
      message: value.message,
    };
    if (
      'code' in value
      && typeof (value as NodeJS.ErrnoException).code === 'string'
    ) {
      result.code = (value as NodeJS.ErrnoException).code;
    }
    return result;
  }
  return {
    name: 'NonErrorThrown',
    message: safeString(value),
  };
}
```

- [ ] Make `safeString()` handle circular objects and hostile values without throwing; a stable fallback such as `"[unserializable thrown value]"` is sufficient.
- [ ] Add two internal finalizers:

```ts
async function finalizeSuccess(
  result: ToolExecutionSuccess,
  callback?: ToolExecutionCallbacks['onPostExecute'],
): Promise<ToolExecutionSuccess>

async function finalizeFailure(
  result: ToolExecutionFailure,
  callback?: ToolExecutionCallbacks['onFailure'],
): Promise<ToolExecutionFailure>
```

- [ ] Set the relevant stage hit immediately before callback invocation.
- [ ] Catch every value only in Post/Failure notification finalizers.
- [ ] Attach `postExecuteError` or `failureCallbackError`; never change the determined status, output, failure detail, `inputUsed`, or duration.

### 5.5 Verify and commit

- [ ] Run:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts
npx tsc --noEmit
```

- [ ] Commit:

```bash
git add src/agent/tool-execution.ts src/__tests__/agent/tool-execution.test.ts
git commit -m "feat: preserve results across callback failures"
```

---

## Task 6: Migrate the Streaming Executor (P1)

**Files:**

- Modify: `src/agent/streaming-executor.ts`
- Modify: `src/__tests__/streaming-executor.test.ts`
- Modify: `src/__tests__/regression/permission-executor-integration.test.ts`
- Modify: `src/__tests__/regression/streaming-permission-passthrough.test.ts`

### 6.1 RED: one streaming execution action

- [ ] Replace legacy-constructor expectations with tests that construct:

```ts
new StreamingToolExecutor(registry, runtime, signal)
```

- [ ] Add tests proving:

  - a tracked tool stores the complete `ToolExecutionResult`;
  - provider-facing `ToolResultBlock.content` equals `executionResult.output`;
  - deny and ask-without-channel are structured permission failures;
  - an unmarked executor `TypeError` rejects `waitForAll()` instead of becoming a string;
  - `signal` reaches `ToolExecutionContext`.

- [ ] Run the three focused files and confirm they fail against the old dual-path constructor.

### 6.2 GREEN: remove duplicate execution branches

- [ ] Change `TrackedTool` to retain `executionResult?: ToolExecutionResult` rather than a string-only execution fact.
- [ ] Replace optional checker/gate fields with one required `ToolExecutionRuntime`.
- [ ] Delete the local decision/hash/gate branch and the checker-only legacy branch.
- [ ] Make `executeTool()` call only:

```ts
const executionResult = await executeToolCall(
  this.registry,
  tool.block,
  this.runtime,
  { signal: this.signal },
);
```

- [ ] Derive the existing model-facing `ToolResultBlock` from `executionResult.output`.
- [ ] Preserve queueing, read-only parallelism, progress notification, and discard behavior.

### 6.3 Verify and commit

- [ ] Run:

```bash
npx vitest run src/__tests__/streaming-executor.test.ts
npx vitest run src/__tests__/regression/permission-executor-integration.test.ts
npx vitest run src/__tests__/regression/streaming-permission-passthrough.test.ts
npx tsc --noEmit
```

- [ ] Commit:

```bash
git add src/agent/streaming-executor.ts src/__tests__/streaming-executor.test.ts src/__tests__/regression/permission-executor-integration.test.ts src/__tests__/regression/streaming-permission-passthrough.test.ts
git commit -m "refactor: route streaming tools through unified execution"
```

---

## Task 7: Migrate streamingQuery Serial Fallback and Expose Structured Results (P5)

**Files:**

- Modify: `src/agent/streaming-query.ts`
- Modify: `src/__tests__/regression/streaming-permission-passthrough.test.ts`
- Audit and modify tool-exposing calls in:
  - `src/__tests__/idle-break.test.ts`
  - `src/__tests__/plan-mode-streaming.test.ts`
  - `src/__tests__/streaming-query-structured-outcome.test.ts`
  - `src/__tests__/streaming-query.test.ts`
  - `src/__tests__/subagent-result-integrity.test.ts`
  - `src/__tests__/agent/bounded-memory-request.test.ts`
  - `src/__tests__/agent/no-tool-contract-streaming.test.ts`
  - `src/__tests__/agent/reconstruction-streaming.test.ts`
  - `src/__tests__/agent/request-tool-view-integration.test.ts`
  - `src/__tests__/agent/tool-transcript-checkpoints.test.ts`

### 7.1 RED: require one runtime when tools are exposed

- [ ] Change `StreamingQueryOptions` to carry:

```ts
executionRuntime?: ToolExecutionRuntime;
```

- [ ] Add tests proving:

  - a query with a non-empty tool list and no runtime rejects with an invariant error before execution;
  - a true no-tool query may omit runtime;
  - streaming and serial modes yield the same structured failure for the same denied call;
  - serial execution emits `executionResult` and keeps `output`;
  - unclassified executor errors bubble in serial mode.

- [ ] Run the focused regression tests and confirm they fail.

### 7.2 GREEN: remove serial permission/execution duplication

- [ ] Extend the stream union:

```ts
| {
    type: 'tool_result';
    toolUseId: string;
    name: string;
    output: string;
    structuredOutcome?: StructuredAskResult;
    executionResult?: ToolExecutionResult;
  };
```

- [ ] At query entry, assert `executionRuntime` exists whenever `options.tools.length > 0`.
- [ ] Pass the same runtime and signal to `StreamingToolExecutor`.
- [ ] Delete `checkPermissionOrBlock()`.
- [ ] In the serial fallback, call `executeToolCall()` and use:

  - `executionResult.output` for `ToolResultBlock.content`;
  - the complete result for yielded `executionResult`;
  - the existing ask-user `structuredOutcome` lookup unchanged.

- [ ] Stop reading the old `permissionChecker`/`runtimeGate` option fields. Keep their declarations temporarily so current child call sites remain type-correct during this commit; Task 8 removes them after every production caller passes `executionRuntime`.

### 7.3 Migrate focused test call sites

- [ ] Update every test that exposes tools to pass `createToolExecutionRuntime()`.
- [ ] Leave no-tool tests unchanged to exercise the allowed omission.
- [ ] Do not retain a compatibility fallback that synthesizes auto permission.

### 7.4 Verify the checkpoint, but do not commit yet

- [ ] Run:

```bash
npx vitest run src/__tests__/regression/streaming-permission-passthrough.test.ts
npx vitest run src/__tests__ --testNamePattern="streamingQuery"
npx tsc --noEmit
```

- [ ] Keep the Task 7 changes uncommitted until Task 8 migrates every child caller. Committing here would leave checker-only child calls unable to satisfy the new runtime invariant.
- [ ] Inspect `git diff -- src/__tests__` and keep unrelated pre-existing test changes out of the later combined commit.

---

## Task 8: Thread the Same Runtime Through All Child Modes (P2-P4)

**Files:**

- Modify: `src/agent/streaming-query.ts`
- Modify: `src/agent/subagent.ts`
- Modify: `src/agent/self-organizing.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts`
- Modify: `src/agent/tools/task-tool.ts`
- Modify: `src/agent/tools/spawn-self-organizing-tool.ts`
- Modify: `src/index.ts`
- Modify: `src/__tests__/regression/subagent-permission-passthrough.test.ts`
- Modify: `src/__tests__/role-agents.test.ts`
- Modify: `src/__tests__/task-tool.test.ts`
- Modify: `src/__tests__/spawn-self-organizing-tool.test.ts`
- Modify: `src/__tests__/subagent-result-integrity.test.ts`
- Modify: `src/__tests__/worktree-integration.test.ts`
- Include the tool-exposing `streamingQuery` test changes audited in Task 7

**Known breaking behavior change:** after this task, child `ask` decisions no longer proceed silently. They wait on the shared main `RuntimeSecurityGate`, so delegated multi-step work may prompt the user repeatedly. This is the required security behavior; delegated authorization inheritance remains out of scope.

### 8.1 RED: adapters propagate runtime by identity

- [ ] Replace the old checker-gap assertions and failing documentation test with tests that capture runner options.
- [ ] For `spawn_agent`, `task`, and `spawn_self_organizing`, assert:

```ts
expect(capturedOptions.executionRuntime).toBe(runtime);
```

- [ ] Add a child `ask` integration test using a deferred `UserDecisionChannel`:

  - start the child tool call;
  - assert child executor call count remains zero before approval;
  - resolve `approved_once`;
  - assert the child executor runs once.

- [ ] Add the rejection case and assert the child gets `permission_denied`.
- [ ] Run the focused child tests and confirm the runtime assertions fail.

### 8.2 GREEN: make runtime a required child dependency

- [ ] Replace `permissionChecker?` in `SubagentOptions` and `SelfOrganizingOptions` with:

```ts
executionRuntime: ToolExecutionRuntime;
```

- [ ] Remove the now-unused `permissionChecker` and `runtimeGate` fields from `StreamingQueryOptions`, then fix every remaining production/test call site rather than retaining a compatibility fallback.
- [ ] Add the same required argument to `createSpawnAgentTool()` and `createTaskTool()`.
- [ ] Carry it in `SpawnSelfOrganizingToolOptions`.
- [ ] Thread the exact object through:

  - `runSubagent()` → `runSubagentWithClient()` → `streamingQuery()`;
  - `runSelfOrganizingSubagent()` → streaming client path → `streamingQuery()`;
  - all three tool factories.

- [ ] Do not clone the gate or create a child-local gate.
- [ ] Keep Vercel fallback outside this project; when no streaming client exists, preserve its existing path and document in code that E4 remains deferred. Do not pretend that fallback is covered by the P2-P4 streaming migration.

### 8.3 GREEN: fix main assembly order without mutable placeholders

- [ ] In `src/index.ts`:

  1. create main/child registries;
  2. create AskManager/question channel and `RuntimeSecurityGate`;
  3. create one `ToolExecutionRuntime`;
  4. register `task`, `spawn_self_organizing`, and `spawn_agent`;
  5. pass that same runtime to the main `streamingQuery()`.

- [ ] Move the existing registration block; do not introduce an uninitialized variable, optional getter, or second gate.

### 8.4 Record and verify the breaking child behavior

- [ ] Add a concise source comment at the child runtime handoff:

```ts
// Intentional behavior change: child `ask` decisions use the main
// RuntimeSecurityGate and wait for explicit approval.
```

- [ ] Run:

```bash
npx vitest run src/__tests__/regression/subagent-permission-passthrough.test.ts
npx vitest run src/__tests__/role-agents.test.ts
npx vitest run src/__tests__/task-tool.test.ts
npx vitest run src/__tests__/spawn-self-organizing-tool.test.ts
npx vitest run src/__tests__/subagent-result-integrity.test.ts
npx vitest run src/__tests__/worktree-integration.test.ts
npx tsc --noEmit
```

- [ ] Before staging, inspect `git diff -- src/__tests__` and exclude unrelated pre-existing test changes.
- [ ] Commit the completed P2-P5 migration together:

```bash
git add src/agent/streaming-query.ts src/agent/subagent.ts src/agent/self-organizing.ts src/agent/tools/spawn-agent-tool.ts src/agent/tools/task-tool.ts src/agent/tools/spawn-self-organizing-tool.ts src/index.ts
git add src/__tests__/idle-break.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/streaming-query-structured-outcome.test.ts src/__tests__/streaming-query.test.ts src/__tests__/subagent-result-integrity.test.ts
git add src/__tests__/agent/bounded-memory-request.test.ts src/__tests__/agent/no-tool-contract-streaming.test.ts src/__tests__/agent/reconstruction-streaming.test.ts src/__tests__/agent/request-tool-view-integration.test.ts src/__tests__/agent/tool-transcript-checkpoints.test.ts
git add src/__tests__/regression/streaming-permission-passthrough.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts src/__tests__/spawn-self-organizing-tool.test.ts src/__tests__/worktree-integration.test.ts
git commit -m "refactor: unify main and child tool execution"
```

---

## Task 9: Add the CI-enforced Direct-execution Guard

**Files:**

- Modify: `eslint.config.js`
- Create: `src/__tests__/regression/unified-tool-execution-paths.test.ts`

### 9.1 RED: document the P1-P5 source boundary

- [ ] Add a focused regression test that reads:

  - `src/agent/streaming-executor.ts`;
  - `src/agent/streaming-query.ts`;
  - `src/agent/subagent.ts`;
  - `src/agent/self-organizing.ts`;
  - the three child tool factories;
  - `src/index.ts`.

- [ ] Assert none contains a direct `registry.execute(` or `this.registry.execute(` call.
- [ ] Temporarily demonstrate the test’s sensitivity by matching the current pre-migration call before Task 6/7, or if executing sequentially after migration, insert and immediately revert a one-line fixture mutation in the test’s in-memory string. Do not modify production source solely to make RED.
- [ ] Run the test and preserve the observed intentional failure in the task log.

### 9.2 GREEN: configure ESLint’s primary guard

- [ ] Add `no-restricted-syntax` for `src/**/*.ts` with selectors for:

```text
CallExpression[callee.type='MemberExpression'][callee.property.name='execute'][callee.object.name='registry']
CallExpression[callee.type='MemberExpression'][callee.property.name='execute'][callee.object.type='MemberExpression'][callee.object.object.type='ThisExpression'][callee.object.property.name='registry']
```

- [ ] Use this message for both selectors:

```text
Use executeToolCall() instead of ToolRegistry.execute() in production paths.
```

- [ ] Add a narrower override disabling only these two restrictions for:

  - `src/agent/loop.ts`;
  - `src/__tests__/**/*.ts`.

Do not allowlist `src/agent/llm-vercel.ts`; it has a different direct-executor pattern and remains a separately documented E4 item.

### 9.3 Verify guard behavior

- [ ] Run:

```bash
npx vitest run src/__tests__/regression/unified-tool-execution-paths.test.ts
npx eslint src/agent/streaming-executor.ts src/agent/streaming-query.ts src/agent/subagent.ts src/agent/self-organizing.ts src/agent/tools/spawn-agent-tool.ts src/agent/tools/task-tool.ts src/agent/tools/spawn-self-organizing-tool.ts src/index.ts
```

- [ ] Run a temporary copied fixture through ESLint or use ESLint’s programmatic API in the regression test to confirm `registry.execute()` produces the configured error message. The fixture must live under a temporary directory and must be removed by the test.
- [ ] Commit:

```bash
git add eslint.config.js src/__tests__/regression/unified-tool-execution-paths.test.ts
git commit -m "chore: guard unified tool execution paths"
```

---

## Task 10: Cross-path Verification and Scope Audit

**Files:**

- Planned source changes: none
- Create: `logs/unified-tool-execution-foundation.md`

If verification exposes a defect introduced by Tasks 1-9, first identify it with `superpowers:systematic-debugging`, then modify only the file that owns the proven cause and its lowest-level regression test.

### 10.1 Focused integration matrix

- [ ] Run the core unit boundary:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts
```

- [ ] Run P1/P5:

```bash
npx vitest run src/__tests__/streaming-executor.test.ts
npx vitest run src/__tests__/regression/permission-executor-integration.test.ts
npx vitest run src/__tests__/regression/streaming-permission-passthrough.test.ts
```

- [ ] Run P2-P4:

```bash
npx vitest run src/__tests__/regression/subagent-permission-passthrough.test.ts
npx vitest run src/__tests__/role-agents.test.ts
npx vitest run src/__tests__/task-tool.test.ts
npx vitest run src/__tests__/spawn-self-organizing-tool.test.ts
npx vitest run src/__tests__/worktree-integration.test.ts
```

- [ ] Run the static boundary test:

```bash
npx vitest run src/__tests__/regression/unified-tool-execution-paths.test.ts
```

### 10.2 Required repository checks

- [ ] Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

- [ ] If a command fails, record the exact failure and use `superpowers:systematic-debugging` before changing code.
- [ ] Do not fix unrelated pre-existing failures; prove they are unrelated and record them.

### 10.3 Manual source audit

- [ ] Search production source for:

```text
registry.execute(
this.registry.execute(
.executor(
permissionChecker:
runtimeGate:
```

- [ ] Confirm:

  - direct Registry execution remains only in explicit legacy allowlist scope;
  - P1-P5 contain `executeToolCall()` or pass `ToolExecutionRuntime`;
  - `llm-vercel.ts` and old `loop.ts` remain visibly deferred;
  - no Hook loader, ledger, delegated authorization, or schema dependency was added;
  - no `ToolExecutionFailureDetail` export was introduced;
  - `CallbackError` remains exported.

### 10.4 Write evidence and obtain review

- [ ] Write `logs/unified-tool-execution-foundation.md` containing only:

  - core data/control flow;
  - TDD RED evidence;
  - failures encountered and causes;
  - exact verification commands and results;
  - known child `ask` behavior change;
  - deferred E3/E4 paths.

- [ ] Use `superpowers:requesting-code-review`.
- [ ] Treat architecture, security, or correctness findings as blocking.
- [ ] Apply accepted review fixes through RED → GREEN and rerun affected checks.
- [ ] Use `superpowers:verification-before-completion` before claiming success.

### 10.5 Final implementation commit

- [ ] Inspect status and diff to ensure unrelated user files are excluded:

```bash
git status --short
git diff --stat
git diff --check
```

- [ ] Commit only verification-log or review-fix files not already committed:

```bash
git add logs/unified-tool-execution-foundation.md
git commit -m "docs: record unified execution verification"
```

- [ ] Use `superpowers:finishing-a-development-branch` to choose merge, PR, or cleanup only after all required verification evidence is current.

---

## Specification Coverage Checklist

- [ ] One boundary: Tasks 2, 6, 7, 8, 9.
- [ ] Full Registry lookup and executor reference preservation: Task 1.
- [ ] Structured result and kind/stage type mapping: Task 1.
- [ ] Original/replacement validation distinction: Tasks 2 and 3.
- [ ] Final-input permission/execution identity: Task 3.
- [ ] Operational-vs-programmer exception boundary: Task 4.
- [ ] Independent callback exception batch: Task 5.
- [ ] `durationMs` notification exclusion: Tasks 2 and 5.
- [ ] Signal propagation: Tasks 1 and 6.
- [ ] P1/P5 provider string compatibility plus structured stream result: Tasks 6 and 7.
- [ ] Shared child RuntimeGate and explicit `ask` approval: Task 8.
- [ ] ESLint CI enforcement with explicit allowlist: Task 9.
- [ ] Deferred legacy paths and non-goals remain untouched: Tasks 8 and 10.
