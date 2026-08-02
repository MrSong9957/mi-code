# `run_bash` Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded `timeout_ms` control to `run_bash` and make timeout, Abort, and spawn failures enter the existing structured execution-failure contract while preserving non-zero exit codes as success.

**Architecture:** Extend the existing `ToolParameter` numeric schema with inclusive `minimum`/`maximum` keywords and enforce them inside `validateToolInput`, so invalid timeout values fail before permission or execution. Keep `ToolExecutor` as `Promise<string>` and make `createBashTool` settle timeout/Abort immediately through the error shapes that `executeToolCall` already classifies; wrap every child `error` in the existing `ToolOperationalError`. Use deterministic mocked-child tests and fake timers for lifecycle races, while retaining the existing real `killProcessTree` regression tests unchanged.

**Tech Stack:** TypeScript ES2022/NodeNext, Node.js `child_process`, `AbortSignal`, Vitest 3, existing `ToolRegistry`, existing `executeToolCall`, existing `PermissionChecker`/`RuntimeSecurityGate` test runtime.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-08-02-run-bash-timeout-design.md`.
- Follow RED → GREEN → REFACTOR. Observe each focused test fail for the intended missing behavior before editing production code.
- `timeout_ms?: number`; omission uses `30_000` milliseconds.
- The inclusive valid range is `1` through `600_000` milliseconds. Values below or above it return `invalid_input` before the executor runs.
- Keep the schema type as `number`; do not add an unapproved integer-only constraint.
- Timeout immediately settles as `failure(timeout)`: guard duplicate settlement, clean up timer/listener state, terminate the process tree, then reject an error named `TimeoutError`. Later child events are ignored.
- An already-aborted signal returns `failure(cancelled)` before `spawn`. In-flight Abort immediately guards, cleans up, terminates the process tree, and rejects an error named `AbortError`; later child events are ignored.
- Every child `error`, with or without a string `code`, returns `failure(operational_error)` by wrapping it in the existing `ToolOperationalError` without changing `executeToolCall`.
- A command that starts and exits non-zero remains `success` with the existing stderr/stdout/fallback output selection.
- Do not change `ToolExecutor`, `ToolExecutionResult`, `classifyExecutorError`, or any other `executeToolCall` error semantics.
- Do not modify `dispatch-map.ts`, background execution, `BackgroundManager`, Git Bash documentation, or unrelated code.
- Do not modify, stage, regenerate, or commit `src/prompts/planner.generated.ts`; use path-specific `git add` commands.
- Add no dependency and introduce no general process abstraction.

---

## File Map

- Modify `src/agent/types.ts:59-65`: add optional numeric schema bounds to `ToolParameter`.
- Modify `src/agent/tool-execution.ts:121-170`: enforce inclusive numeric bounds in `validateToolInput` without changing result construction or error classification.
- Modify `src/agent/tool-registry.ts:254-409`: declare and consume `timeout_ms`, classify timeout/Abort/spawn failures by rejection, and preserve non-zero success.
- Modify `src/__tests__/agent/tool-execution.test.ts:79-258`: specify generic inclusive numeric-bound validation.
- Create `src/__tests__/agent/run-bash-tool.test.ts`: deterministically exercise the real `createBashTool` executor through `executeToolCall` with mocked child-process events and process-tree termination.
- Read-only regression reference `src/__tests__/regression/bash-process-control.test.ts:17-117`: already verifies real commands, output truncation, and `killProcessTree`; do not edit it.
- Read-only helper `src/__tests__/helpers/tool-execution-runtime.ts`: reuse `createToolExecutionRuntime()` with its default `auto` permission mode.

## Dependency Order

```text
Task 1: numeric schema bounds
  └─> Task 2: timeout_ms + timeout classification + non-zero success
        └─> Task 3: Abort classification + process-tree termination
              └─> Task 4: spawn error classification
```

Tasks 3 and 4 are conceptually separate but execute sequentially because both modify the same child lifecycle handlers in `createBashTool` and the same focused test file.

---

### Task 1: Add Inclusive Numeric Schema Bounds

**Files:**

- Modify: `src/agent/types.ts:59-65`
- Modify: `src/agent/tool-execution.ts:121-170`
- Modify: `src/__tests__/agent/tool-execution.test.ts:219-239`

**Interfaces:**

- Consumes: existing `ToolParameter`, `validateToolInput(value, schema, path)`, `executeToolCall(...)`, and the test-local `register(...)`/`call(...)` helpers.
- Produces: `ToolParameter.minimum?: number` and `ToolParameter.maximum?: number`; numeric validation accepts inclusive endpoints and reports stable field-path errors outside them.

- [ ] **Step 1: Add failing lower/upper-bound tests**

Add these tests immediately after the existing “does not coerce a string to a number” test in `src/__tests__/agent/tool-execution.test.ts`:

```ts
it.each([
  { value: 0, message: '$.timeout_ms: expected number >= 1' },
  { value: 600_001, message: '$.timeout_ms: expected number <= 600000' },
])('rejects $value outside inclusive number bounds', async ({ value, message }) => {
  const registry = register({
    name: 'bounded-number',
    description: 'bounded number',
    parameters: {
      type: 'object',
      properties: {
        timeout_ms: {
          type: 'number',
          minimum: 1,
          maximum: 600_000,
        },
      },
      required: ['timeout_ms'],
    },
  });

  const result = await executeToolCall(
    registry,
    call('bounded-number', { timeout_ms: value }),
    createToolExecutionRuntime(),
  );

  expect(result).toMatchObject({
    status: 'failure',
    failure: {
      kind: 'invalid_input',
      stage: 'validation',
      message,
    },
  });
});

it.each([1, 1.5, 600_000])(
  'accepts %s inside inclusive number bounds',
  async (value) => {
    const registry = register({
      name: 'bounded-number',
      description: 'bounded number',
      parameters: {
        type: 'object',
        properties: {
          timeout_ms: {
            type: 'number',
            minimum: 1,
            maximum: 600_000,
          },
        },
        required: ['timeout_ms'],
      },
    });

    const result = await executeToolCall(
      registry,
      call('bounded-number', { timeout_ms: value }),
      createToolExecutionRuntime(),
    );

    expect(result.status).toBe('success');
  },
);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts -t "number bounds"
```

Expected: the out-of-range cases return `status: 'success'`, proving the current validator ignores bounds. If TypeScript diagnostics are surfaced by the runner, `minimum`/`maximum` may also be reported as absent from `ToolParameter`; both failures are caused by the same missing contract.

- [ ] **Step 3: Extend `ToolParameter` minimally**

Add only these properties in `src/agent/types.ts`:

```ts
export interface ToolParameter {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  items?: ToolParameter;
  minimum?: number;
  maximum?: number;
}
```

Do not add `integer`, `exclusiveMinimum`, `exclusiveMaximum`, schema self-validation, or another JSON Schema keyword.

- [ ] **Step 4: Enforce inclusive bounds in `validateToolInput`**

Replace only the current `case 'number'` branch in `src/agent/tool-execution.ts`:

```ts
case 'number': {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return invalid(path, 'expected number');
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    return invalid(path, `expected number >= ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    return invalid(path, `expected number <= ${schema.maximum}`);
  }
  return { valid: true };
}
```

This keeps existing finite-number validation and automatically applies the same bounds when `executeToolCall` revalidates `onPreExecute.updatedInput`.

- [ ] **Step 5: Run GREEN verification**

Run:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts -t "number bounds"
npx vitest run src/__tests__/agent/tool-execution.test.ts
npm run typecheck
```

Expected: all commands exit `0`; the focused tests cover below-minimum, above-maximum, both inclusive endpoints, and an in-range fractional number.

- [ ] **Step 6: Review and commit Task 1**

Run `git diff -- src/agent/types.ts src/agent/tool-execution.ts src/__tests__/agent/tool-execution.test.ts` and confirm every changed line belongs to numeric-bound validation. Then commit only those files:

```bash
git add src/agent/types.ts src/agent/tool-execution.ts src/__tests__/agent/tool-execution.test.ts
git commit -m "feat: validate numeric tool parameter bounds"
```

---

### Task 2: Add `timeout_ms`, Timeout Failure, and Non-Zero Success Regression

**Files:**

- Modify: `src/agent/tool-registry.ts:254-409`
- Create: `src/__tests__/agent/run-bash-tool.test.ts`

**Interfaces:**

- Consumes: Task 1’s `ToolParameter.minimum`/`maximum`, existing `createBashTool()`, `ToolRegistry.register(...)`, `executeToolCall(...)`, `createToolExecutionRuntime()`, and existing `killProcessTree(pid)`.
- Produces: optional `run_bash.timeout_ms` schema field; executor-local `timeoutMs: number`; an immediate single-settlement helper ordered as guard → cleanup → optional tree kill → reject; unchanged resolved strings for non-zero exit codes.

- [ ] **Step 1: Create the deterministic child-process test harness**

Create `src/__tests__/agent/run-bash-tool.test.ts` with this shared harness and the initial behavior tests:

```ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('child_process', async () => ({
  ...(await vi.importActual<typeof import('child_process')>('child_process')),
  spawn: mocks.spawn,
}));

vi.mock('../../agent/process-tree.js', () => ({
  killProcessTree: mocks.killProcessTree,
}));

import { executeToolCall } from '../../agent/tool-execution.js';
import { createBashTool, ToolRegistry } from '../../agent/tool-registry.js';
import type { ToolExecutionContext, ToolUseBlock } from '../../agent/types.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';

function makeChild(pid = 4_242): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

function executeBash(
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const registry = new ToolRegistry();
  const bash = createBashTool();
  registry.register(bash.definition, bash.executor);
  const call: ToolUseBlock = {
    type: 'tool_use',
    id: 'run-bash-test',
    name: 'run_bash',
    input,
  };
  const context: Omit<ToolExecutionContext, 'toolUseId'> = signal
    ? { signal }
    : {};
  return executeToolCall(
    registry,
    call,
    createToolExecutionRuntime(),
    context,
  );
}

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(() => {
    const child = makeChild();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  mocks.killProcessTree.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('run_bash timeout contract', () => {
  it('declares optional timeout_ms with inclusive bounds', () => {
    const bash = createBashTool();
    expect(bash.definition.parameters.properties?.timeout_ms).toMatchObject({
      type: 'number',
      minimum: 1,
      maximum: 600_000,
    });
    expect(bash.definition.parameters.required).toEqual(['command']);
  });

  it.each([
    { timeout_ms: 0, message: '$.timeout_ms: expected number >= 1' },
    { timeout_ms: 600_001, message: '$.timeout_ms: expected number <= 600000' },
  ])(
    'rejects run_bash timeout_ms $timeout_ms before spawn',
    async ({ timeout_ms, message }) => {
      await expect(executeBash({ command: 'echo blocked', timeout_ms }))
        .resolves.toMatchObject({
          status: 'failure',
          failure: {
            kind: 'invalid_input',
            stage: 'validation',
            message,
          },
        });
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { input: { command: 'echo ok' }, delay: 30_000 },
    { input: { command: 'echo ok', timeout_ms: 1_234 }, delay: 1_234 },
  ])('schedules the configured timeout $delay', async ({ input, delay }) => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const bash = createBashTool();

    const resultPromise = bash.executor(input);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), delay);
    child.stdout?.emit('data', Buffer.from('ok'));
    child.emit('close', 0);
    await expect(resultPromise).resolves.toBe('ok');
  });

  it('immediately returns failure(timeout) without a child close/error event', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const settled = vi.fn();

    const execution = executeBash({ command: 'echo waiting', timeout_ms: 1_234 });
    void execution.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_234);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failure',
      failure: expect.objectContaining({
        kind: 'timeout',
        stage: 'execution',
      }),
    }));
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(mocks.killProcessTree).toHaveBeenCalledWith(4_242);
    expect(clearTimeoutSpy.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.killProcessTree.mock.invocationCallOrder[0]);
    expect(mocks.killProcessTree.mock.invocationCallOrder[0])
      .toBeLessThan(settled.mock.invocationCallOrder[0]);

    child.emit('close', 0);
    child.emit('error', new Error('late child error'));
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-zero exit code as success with stderr output', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);

    const execution = executeBash({ command: 'echo failing', timeout_ms: 600_000 });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    child.stderr?.emit('data', Buffer.from('command failed'));
    child.emit('close', 7);

    await expect(execution).resolves.toMatchObject({
      status: 'success',
      output: 'command failed',
    });
  });
});
```

The mock isolates child event ordering; it does not replace the existing real process-tree tests in `bash-process-control.test.ts`.

- [ ] **Step 2: Run the new file and confirm RED**

Run:

```bash
npx vitest run src/__tests__/agent/run-bash-tool.test.ts
```

Expected failures:

- `timeout_ms` is absent from the schema.
- out-of-range `run_bash` input reaches success because the schema does not yet declare bounds.
- the explicit timer still uses `30_000`.
- advancing the controlled timer does not settle the execution until the missing immediate-settlement behavior is implemented.
- the non-zero regression may already pass and must remain green throughout later tasks.

- [ ] **Step 3: Add the bounded optional schema property**

Add this sibling to `command` in `createBashTool().definition.parameters.properties`:

```ts
timeout_ms: {
  type: 'number',
  description: 'Timeout in milliseconds (1-600000). Defaults to 30000.',
  minimum: 1,
  maximum: 600_000,
},
```

Keep `required: ['command']`; do not add `timeout_ms` to it.

- [ ] **Step 4: Select timeout and define immediate single settlement**

At the start of the executor, immediately after reading `command`, add:

```ts
const timeoutMs = (input.timeout_ms as number | undefined) ?? 30_000;
```

Change `new Promise<string>((resolve) => {` to accept `reject`:

```ts
return new Promise<string>((resolve, reject) => {
```

Do not revalidate the range inside the executor; Task 1’s schema validation is the single input gate on production `executeToolCall` paths.

- [ ] **Step 5: Settle timeout immediately and guard late child events**

Replace `let timedOut = false`, the hard-coded timer, and the current close/error handlers with this lifecycle state. Keep the existing stdout/stderr collection code before it:

```ts
let settled = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const cleanup = (): void => {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
};

const settleFailure = (error: Error, terminateTree: boolean): void => {
  if (settled) return;
  settled = true;
  cleanup();
  if (terminateTree && child.pid) killProcessTree(child.pid);
  reject(error);
};

timer = setTimeout(() => {
  const error = new Error(`Command timed out after ${timeoutMs} ms`);
  error.name = 'TimeoutError';
  settleFailure(error, true);
}, timeoutMs);

child.on('close', (code) => {
  if (settled) return;
  settled = true;
  cleanup();

  const stdout = stdoutChunks.length > 0
    ? Encoder.decodeBuffer(Buffer.concat(stdoutChunks))
    : '';
  const stderr = stderrChunks.length > 0
    ? Encoder.decodeBuffer(Buffer.concat(stderrChunks))
    : '';

  if (code !== 0) {
    resolve(stderr || stdout || `Command exited with code ${code}`);
    return;
  }

  if (stderr) {
    resolve(stdout ? `${stdout}\n${stderr}` : stderr);
    return;
  }
  resolve(stdout);
});

child.on('error', (err) => {
  if (settled) return;
  settled = true;
  cleanup();
  resolve(`Command failed: ${err.message}`);
});
```

`settleFailure` deliberately performs guard → cleanup → optional process-tree termination → reject in that order. It does not wait for `close` or `error`; those later events observe `settled` and return. Task 4 replaces only the still-existing spawn-error string resolution.

- [ ] **Step 6: Run GREEN verification**

Run:

```bash
npx vitest run src/__tests__/agent/run-bash-tool.test.ts
npx vitest run src/__tests__/agent/tool-execution.test.ts src/__tests__/agent/run-bash-tool.test.ts
npm run typecheck
```

Expected: all commands exit `0`; the fake-timer test observes timeout settlement without emitting a child terminal event, verifies cleanup-before-kill-before-result ordering, and confirms late child events cannot settle twice. Default/explicit delay and non-zero success remain green.

- [ ] **Step 7: Review and commit Task 2**

Confirm `git diff -- src/agent/tool-registry.ts src/__tests__/agent/run-bash-tool.test.ts` contains only timeout schema/execution work and the non-zero regression. Commit only these paths:

```bash
git add src/agent/tool-registry.ts src/__tests__/agent/run-bash-tool.test.ts
git commit -m "feat: add configurable run_bash timeout"
```

---

### Task 3: Abort the Running Command and Classify Cancellation

**Files:**

- Modify: `src/agent/tool-registry.ts:290-405`
- Modify: `src/__tests__/agent/run-bash-tool.test.ts`

**Interfaces:**

- Consumes: existing optional `ToolExecutionContext.signal`, Task 2’s `settled`/`cleanup`/`settleFailure(error, terminateTree)` lifecycle, current `killProcessTree(pid)`, and existing `AbortError` classification in `executeToolCall`.
- Produces: already-aborted signals throw `AbortError` before `spawn`; in-flight Abort reuses immediate settlement in strict guard → cleanup → tree kill → reject order; later `close`/`error` events return at the settled guard.

- [ ] **Step 1: Add failing in-flight and already-aborted tests**

Append inside the existing `describe('run_bash timeout contract', ...)` block:

```ts
it('kills the process tree and returns failure(cancelled) on Abort', async () => {
  const child = makeChild();
  mocks.spawn.mockReturnValue(child);
  const controller = new AbortController();
  const removeListenerSpy = vi.spyOn(
    controller.signal,
    'removeEventListener',
  );
  const settled = vi.fn();

  const execution = executeBash(
    { command: 'echo waiting', timeout_ms: 600_000 },
    controller.signal,
  );
  void execution.then(settled);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  controller.abort();

  await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({
    status: 'failure',
    failure: expect.objectContaining({
      kind: 'cancelled',
      stage: 'execution',
    }),
  }));
  expect(removeListenerSpy).toHaveBeenCalledWith(
    'abort',
    expect.any(Function),
  );
  expect(mocks.killProcessTree).toHaveBeenCalledWith(4_242);
  expect(removeListenerSpy.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.killProcessTree.mock.invocationCallOrder[0]);
  expect(mocks.killProcessTree.mock.invocationCallOrder[0])
    .toBeLessThan(settled.mock.invocationCallOrder[0]);

  child.emit('close', 0);
  child.emit('error', new Error('late child error'));
  await Promise.resolve();
  expect(settled).toHaveBeenCalledTimes(1);
});

it('returns cancelled before spawn for an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(executeBash(
    { command: 'echo never-started', timeout_ms: 600_000 },
    controller.signal,
  )).resolves.toMatchObject({
    status: 'failure',
    failure: { kind: 'cancelled', stage: 'execution' },
  });
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.killProcessTree).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the Abort test and confirm RED**

Run:

```bash
npx vitest run src/__tests__/agent/run-bash-tool.test.ts -t "Abort|aborted signal"
```

Expected: FAIL because the current executor ignores its optional context: in-flight Abort does not settle, and an already-aborted signal still reaches `spawn`.

- [ ] **Step 3: Reject an already-aborted signal before spawn**

Change the executor signature to:

```ts
executor: async (input, ctx) => {
```

Immediately after reading `command` and `timeoutMs`, before environment-policy work and before `new Promise` calls `spawn`, add:

```ts
if (ctx?.signal?.aborted) {
  const error = new Error('Command aborted');
  error.name = 'AbortError';
  throw error;
}
```

- [ ] **Step 4: Extend Task 2 cleanup for in-flight Abort**

Inside the Promise, add an optional handler variable beside Task 2’s `timer` declaration:

```ts
let abortHandler: (() => void) | undefined;
```

Extend Task 2’s `cleanup` function without changing its timer cleanup:

```ts
const cleanup = (): void => {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (abortHandler) {
    ctx?.signal?.removeEventListener('abort', abortHandler);
  }
};
```

After assigning the timeout timer and after child `close`/`error` listeners are registered, attach the Abort handler through Task 2’s immediate settlement function:

```ts
abortHandler = (): void => {
  const error = new Error('Command aborted');
  error.name = 'AbortError';
  settleFailure(error, true);
};

ctx?.signal?.addEventListener('abort', abortHandler, { once: true });
if (ctx?.signal?.aborted) abortHandler();
```

The post-registration `aborted` check closes the race between the pre-spawn check and listener attachment. If Abort fires during that interval, either the listener or this check invokes `abortHandler`; Task 2’s settled guard makes duplicate invocation harmless. No child event participates in producing the cancellation result.

- [ ] **Step 5: Run GREEN and immediate-settlement verification**

Run:

```bash
npx vitest run src/__tests__/agent/run-bash-tool.test.ts -t "Abort|aborted signal"
npx vitest run src/__tests__/agent/run-bash-tool.test.ts
npm run typecheck
```

Expected: all commands exit `0`; already-aborted input never calls `spawn`, in-flight Abort settles without a child terminal event, cleanup happens before tree kill and result delivery, late child events are ignored, timeout remains immediate, and non-zero remains success.

- [ ] **Step 6: Review and commit Task 3**

Review the two-file diff and confirm there is no change to `executeToolCall` or `process-tree.ts`. Commit:

```bash
git add src/agent/tool-registry.ts src/__tests__/agent/run-bash-tool.test.ts
git commit -m "feat: cancel run_bash on abort"
```

---

### Task 4: Classify Spawn Errors as Operational Failures

**Files:**

- Modify: `src/agent/tool-registry.ts:401-405`
- Modify: `src/__tests__/agent/run-bash-tool.test.ts`

**Interfaces:**

- Consumes: Task 3’s settled/cleanup ordering and existing exported `ToolOperationalError`, which `executeToolCall` already maps to `operational_error` with an optional code.
- Produces: every child `error` is wrapped in `ToolOperationalError`, preserving a string code when present; plain errors are also guaranteed to become `failure(operational_error)` without a classifier change.

- [ ] **Step 1: Add the failing spawn-error classification test**

Append inside the focused test block:

```ts
it.each([
  {
    label: 'without code',
    error: new Error('plain spawn failure'),
    expectedCode: undefined,
  },
  {
    label: 'with string code',
    error: Object.assign(new Error('coded spawn failure'), { code: 'ENOENT' }),
    expectedCode: 'ENOENT',
  },
])(
  'returns failure(operational_error) for child error $label',
  async ({ error, expectedCode }) => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);

    const execution = executeBash({ command: 'echo unavailable' });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    child.emit('error', error);

    await expect(execution).resolves.toMatchObject({
      status: 'failure',
      failure: {
        kind: 'operational_error',
        stage: 'execution',
        message: error.message,
        code: expectedCode,
      },
    });
  },
);
```

- [ ] **Step 2: Run the spawn test and confirm RED**

Run:

```bash
npx vitest run src/__tests__/agent/run-bash-tool.test.ts -t "spawn error"
```

Expected: both cases FAIL because Task 3 still resolves a `"Command failed: ..."` string, so `executeToolCall` reports `status: 'success'`. The plain-error case additionally proves that rejecting the original error would be insufficient because the existing classifier would rethrow it.

- [ ] **Step 3: Wrap every child error in `ToolOperationalError`**

Add this value import in `src/agent/tool-registry.ts`:

```ts
import { ToolOperationalError } from './tool-execution.js';
```

`tool-execution.ts` imports `ToolRegistry` with `import type`, so this does not create a runtime module cycle.

Replace Task 2’s complete child error handler with:

```ts
child.on('error', (err) => {
  const code = 'code' in err
    && typeof (err as NodeJS.ErrnoException).code === 'string'
    ? (err as NodeJS.ErrnoException).code
    : undefined;
  settleFailure(new ToolOperationalError(err.message, code), false);
});
```

Passing `false` prevents a spawn failure from attempting to kill a process tree. If timeout or Abort already settled, the shared guard returns before cleanup/reject, so a late child error cannot overwrite the earlier result.

- [ ] **Step 4: Run GREEN and full focused verification**

Run:

```bash
npx vitest run src/__tests__/agent/run-bash-tool.test.ts -t "spawn error"
npx vitest run src/__tests__/agent/run-bash-tool.test.ts
npx vitest run src/__tests__/agent/tool-execution.test.ts src/__tests__/agent/run-bash-tool.test.ts
npm run typecheck
```

Expected: all commands exit `0`; both plain and code-bearing child errors are operational, the optional string code is preserved, and timeout, Abort, schema, default timeout, explicit timeout, and non-zero success tests remain green.

- [ ] **Step 5: Review and commit Task 4**

Confirm the production diff contains only the `ToolOperationalError` import, the child error handler replacement, and its two focused cases. Commit:

```bash
git add src/agent/tool-registry.ts src/__tests__/agent/run-bash-tool.test.ts
git commit -m "fix: classify run_bash spawn failures"
```

---

## Final Verification and Scope Audit

After all four task commits, run these commands without editing code between them:

```bash
npx vitest run src/__tests__/agent/tool-execution.test.ts
npx vitest run src/__tests__/agent/run-bash-tool.test.ts
npx vitest run src/__tests__/regression/bash-process-control.test.ts src/__tests__/regression/child-process-env-scrub.test.ts
npx eslint src/agent/types.ts src/agent/tool-execution.ts src/agent/tool-registry.ts src/__tests__/agent/tool-execution.test.ts src/__tests__/agent/run-bash-tool.test.ts
npm run typecheck
npm test
```

The focused tests, targeted regressions, lint, and typecheck must exit `0`. Keep `npm test` as the real acceptance for the original command that exceeded 30 seconds. Launch it through the updated tool with this exact tool input rather than changing the default or invoking the command repeatedly:

```json
{
  "command": "npm test",
  "timeout_ms": 600000
}
```

Expected: `npm test` completes within the explicit 10-minute tool budget and exits `0`. If its only failure is a confirmed, unrelated pre-existing/flaky test, record the command, elapsed time, failing test name, exact failure output, and why it is outside the five-file implementation diff. Do not fix unrelated code, weaken this feature’s focused gates, or rerun the full gate hoping for a different result. Report the full-suite acceptance as blocked by that recorded pre-existing failure while retaining the passing focused evidence.

Do not run `npm run build` in this worktree: that script invokes `gen:prompts` and would touch the protected existing `src/prompts/planner.generated.ts` modification. `npm run typecheck` supplies the required TypeScript compilation check without generation.

The plan defines exactly four implementation commits. After Task 4, verify the committed scope against the parent of those four commits with:

```bash
git diff --name-only HEAD~4...HEAD
git status --short
```

The committed implementation diff must contain only:

```text
src/agent/tool-execution.ts
src/agent/tool-registry.ts
src/agent/types.ts
src/__tests__/agent/run-bash-tool.test.ts
src/__tests__/agent/tool-execution.test.ts
```

The expected remaining pre-existing worktree change is:

```text
 M src/prompts/planner.generated.ts
```

Do not create a final “verification” commit when no files changed. If a focused fix is required, repeat that task’s failing test, minimal implementation, full focused verification, and amend only the corresponding task commit before the final scope audit.
