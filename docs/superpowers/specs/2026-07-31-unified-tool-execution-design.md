# Unified Tool Execution Foundation Design

Date: 2026-07-31

Status: Approved for planning

## 1. Purpose

mi-code currently has multiple tool execution engines and multiple runtime
assemblies with different validation, permission, Hook, error, and output
semantics. This design establishes one production execution boundary before
adding Hook configuration, Stop verification, or a verification ledger.

The central invariant is:

> Every production-reachable tool execution in P1-P5 passes through the same
> function, and the input that is validated and authorized is the input that is
> executed.

The current-path evidence is recorded in
`docs/5.md`. Claude Code v2.1.88 behavior in `docs/4.md` is an architectural
reference obtained from reverse-engineered source on another device. It is not
independently verifiable in this workspace and is not a compatibility target.

## 2. Scope

This project implements:

1. A single `executeToolCall()` production boundary.
2. Runtime validation of the project’s declared `ToolParameter` schema subset.
3. A structured `ToolExecutionResult` success/failure union.
4. Explicit operational-error classification.
5. Three optional lifecycle callbacks:
   - `onPreExecute`
   - `onPostExecute`
   - `onFailure`
6. Migration of the following paths:
   - P1 main-agent streaming execution
   - P2 `spawn_agent` child execution
   - P3 `task` child execution
   - P4 self-organizing child execution
   - P5 main-agent non-streaming fallback
7. A CI-enforced static guard against reintroducing direct
   `registry.execute()` calls in migrated production code.

## 3. Non-goals

This project does not implement:

- Hook settings discovery or command execution.
- Claude Code Hook protocol compatibility.
- Stop or SubagentStop lifecycle events.
- A verification ledger.
- Test/lint/typecheck evidence policy.
- Input hashing, timestamps, artifacts, or evidence references.
- Delegated authorization or child permission inheritance.
- Cleanup of the old `agentLoop`.
- Migration of the Vercel AI SDK fallback.
- dispatch-map cleanup.
- MCP integration.
- Making `ToolRegistry.execute()` private or deprecated.

Those concerns belong to later projects. No placeholder classes, empty Hook
loaders, empty ledger objects, or speculative abstraction layers are created
here.

## 4. Current-state problem

The audit identified four execution engines:

1. `StreamingToolExecutor.executeTool()`
2. The serial fallback inside `streamingQuery()`
3. The old `agentLoop()`
4. The Vercel AI SDK executor wrapper

The default production graph has at least four permission semantics:

- Main agent: `PermissionChecker + RuntimeSecurityGate`
- `spawn_agent`: legacy checker; `ask` silently allowed
- `task`: no checker
- Self-organizing child: legacy checker; `ask` silently allowed

Additional problems:

- Main streaming execution does not run PreToolUse.
- Main PostToolUse is a UI observer after the result already exists.
- `ToolRegistry.execute()` catches executor exceptions and turns them into
  ordinary strings.
- Runtime input is not independently validated before permission checks.
- Tool results cannot distinguish success from failure without parsing text.

The foundation must remove these differences for P1-P5 without prematurely
redesigning the remaining legacy paths.

## 5. Chosen architecture

### 5.1 Independent execution function

Create `src/agent/tool-execution.ts`.

The module owns:

- `ToolExecutionResult` and its public supporting types.
- `ToolOperationalError`.
- `PreCallbackInputViolation`.
- Operational-error classification.
- Runtime validation for `ToolParameter`.
- `executeToolCall()`.

`ToolRegistry` remains a registration and lookup container.

### 5.2 Registry lookup

Add:

```ts
get(name: string): RegisteredTool | undefined
```

`get()` returns the complete `RegisteredTool`:

```ts
interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}
```

It does not return a descriptor-only projection.

Current executors are stored as plain function references. They are not
`ToolRegistry` instance methods and do not use Registry `this`. The existing
`execute()` method invokes `tool.executor(input, ctx)` directly. Therefore
`get()` preserves the exact executor reference and its paired definition; no
per-caller binding is required.

If a future registered executor needs binding, registration or `get()` must
return an already-bound executor. Binding must never be delegated to
`executeToolCall()` callers.

### 5.3 Why `executeToolCall()` does not call `registry.execute()`

`ToolRegistry.execute()` currently catches every executor exception and returns
an `"Error executing tool ..."` string. Calling it would make it impossible to
distinguish operational failures from programmer bugs.

For this project:

- `executeToolCall()` uses `registry.get()` and invokes the returned executor.
- Existing `registry.execute()` remains unchanged for non-migrated legacy paths.
- No deprecation annotation or visibility change is made.

In the later path-convergence project:

- E3/E4 and other legacy paths are migrated.
- direct executor and `registry.execute()` callers are removed.
- the remaining low-level invocation API is then deleted or made private.

## 6. Public result model

### 6.1 Callback error

`CallbackError` is explicitly exported because consumers must inspect callback
failures without using inline casts or `any`.

```ts
export interface CallbackError {
  name: string;
  message: string;
  code?: string;
}
```

Stack traces are not included in structured results.

### 6.2 Stage hits

```ts
export interface ToolExecutionStageHits {
  preExecute: boolean;
  postExecute: boolean;
  failure: boolean;
}
```

A stage is `true` when the configured callback began execution. It remains
`true` if that callback throws.

An absent optional callback leaves its stage `false`.

### 6.3 Common result fields

```ts
export interface ToolExecutionBase {
  toolUseId: string;
  toolName: string;
  inputUsed: Readonly<Record<string, unknown>>;
  durationMs: number;
  stageHits: ToolExecutionStageHits;
}
```

Semantics:

- `inputUsed` is a deep snapshot of the final candidate input at the terminal
  stage.
- For lookup or validation failure, `inputUsed` does not mean that the executor
  ran.
- The permission decision and executor receive the same final input values.
- `durationMs` starts at `executeToolCall()` entry and ends when the
  success/failure fact is determined.
- Post/Failure notification callback duration is excluded.

### 6.4 Success

```ts
export interface ToolExecutionSuccess extends ToolExecutionBase {
  status: 'success';
  output: string;
  postExecuteError?: CallbackError;
}
```

### 6.5 Failure

The failure detail is an internal construction type, not a separately exported
public type. Consumers access it through `ToolExecutionFailure['failure']`.

Its discriminated union enforces the only valid `kind`/`stage` mappings at
compile time:

```ts
type ToolExecutionFailureDetail =
  | {
      kind: 'unknown_tool';
      stage: 'lookup';
      message: string;
    }
  | {
      kind: 'invalid_input';
      stage: 'validation';
      message: string;
    }
  | {
      kind: 'permission_denied';
      stage: 'permission';
      message: string;
      code?: string;
    }
  | {
      kind: 'cancelled';
      stage: 'execution';
      message: string;
      code?: string;
    }
  | {
      kind: 'timeout';
      stage: 'execution';
      message: string;
      code?: string;
    }
  | {
      kind: 'operational_error';
      stage: 'execution';
      message: string;
      code?: string;
    };

export interface ToolExecutionFailure extends ToolExecutionBase {
  status: 'failure';
  output: string;
  failure: ToolExecutionFailureDetail;
  failureCallbackError?: CallbackError;
}
```

This structure prevents a future consumer from receiving combinations such as
`unknown_tool + execution` or `timeout + validation`.

### 6.6 Result union

```ts
export type ToolExecutionResult =
  | ToolExecutionSuccess
  | ToolExecutionFailure;
```

The model-facing compatibility string is always `output`.

Machine consumers must branch on `status` and read `failure`. They must never
parse `output` to infer success or failure.

## 7. Lifecycle callback contract

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
```

Rules:

- Pre may modify input only by returning `updatedInput`.
- In-place mutation is not an input-update mechanism.
- Pre may return only `undefined` or a valid `ToolPreExecuteResult`.
- Post receives an already-determined success.
- Failure receives an already-determined expected failure.
- These callbacks are injection points only. This project does not implement
  Hook discovery, matching, configuration, or command execution.

## 8. Callback exception behavior

Callbacks belong to two different semantic classes.

### 8.1 Pre is part of the decision chain

If `onPreExecute` throws:

- The exception bubbles.
- No `ToolExecutionResult` is returned.
- The executor is not called.

If Pre returns an invalid result shape:

- Throw an invariant error.
- Do not convert it to a normal failure.

If Pre returns `updatedInput` that fails schema validation:

- Throw `PreCallbackInputViolation`.
- Do not return `invalid_input`.

The distinction is deliberate:

- Invalid original input is a normal request failure.
- Invalid replacement input is a callback/system contract violation.

### 8.2 Post cannot erase success

The executor has already succeeded before `onPostExecute` runs.

If Post throws any value:

- Catch it.
- Safely serialize it into `postExecuteError`.
- Return the original success result.

### 8.3 Failure notification cannot erase failure

The expected failure has already been determined before `onFailure` runs.

If Failure throws any value:

- Catch it.
- Safely serialize it into `failureCallbackError`.
- Return the original failure result.

No callback exception is silently discarded.

## 9. Runtime input validation

### 9.1 Supported schema subset

The validator implements only the schema surface declared by the current
`ToolParameter` type:

- `object`
- `string`
- `number`
- `boolean`
- `array`
- `null`
- `required`
- `properties`
- `items`
- nested arrays and objects

It does not add a dependency such as AJV.

It does not implement undeclared JSON Schema keywords.

### 9.2 Validation rules

- No type coercion.
- Extra object properties are allowed for compatibility.
- Arrays validate each element recursively.
- Missing required properties fail.
- Errors contain a deterministic JSON-style field path, for example:

```text
$.questions[0].header: expected string
```

### 9.3 Two validation points

1. Validate original model input before Pre.
2. If Pre returns `updatedInput`, validate the complete replacement input again.

The second input is a replacement, not a partial patch. Missing required fields
therefore make the callback contract invalid and cause
`PreCallbackInputViolation`.

## 10. Exception classification

### 10.1 Explicit operational error

```ts
export class ToolOperationalError extends Error {
  readonly code?: string;
}
```

Executor code may throw this class to declare an expected business or
environment failure.

### 10.2 Classification

The classifier follows this order:

1. `ToolOperationalError` → `operational_error`
2. `Error` with a string-valued `code` property → `operational_error`
3. `Error.name === 'AbortError'` → `cancelled`
4. `Error.name === 'TimeoutError'` → `timeout`
5. Any other `Error` → bubble
6. Any non-`Error` thrown value → bubble unchanged

The string `code` check is open-ended:

```ts
'code' in error
  && typeof (error as NodeJS.ErrnoException).code === 'string'
```

The implementation must not enumerate errno values. Node and network error
codes are an open set.

The implementation must not classify errors from message text.

`TypeError` and other unmarked programmer errors bubble.

## 11. Execution algorithm

`executeToolCall()` performs these steps in order:

1. Start monotonic duration measurement.
2. Deep-clone the original input.
3. Resolve the complete registered tool with `registry.get()`.
4. If absent, create `unknown_tool` failure and run Failure notification.
5. Validate original input.
6. If invalid, create `invalid_input` failure and run Failure notification.
7. If configured, run Pre and mark `preExecute=true`.
8. Validate Pre’s return shape.
9. If Pre supplied `updatedInput`, treat it as the complete replacement input.
10. Revalidate that replacement.
11. If replacement validation fails, throw `PreCallbackInputViolation`.
12. Create the immutable `inputUsed` snapshot.
13. Generate a SecurityDecision from the final input.
14. Ask RuntimeSecurityGate to execute the authorized callback.
15. Pass the same final input values and `ToolExecutionContext` to the executor.
16. If denied, create `permission_denied` failure.
17. If executor returns, create success.
18. If executor throws a classified operational error, create the corresponding
    execution failure.
19. If executor throws an unclassified value, rethrow it.
20. End duration measurement when success/failure is determined.
21. Run Post or Failure notification and set the relevant stage hit.
22. Attach notification callback error if one occurs.
23. Return the structured result.

`ToolExecutionContext` carries:

- `toolUseId`
- `signal`
- existing execution-plan fields

## 12. Required runtime dependencies

```ts
export interface ToolExecutionRuntime {
  permissionChecker: PermissionChecker;
  runtimeGate: RuntimeSecurityGate;
  callbacks?: ToolExecutionCallbacks;
}
```

For any query that exposes tools:

- `permissionChecker` is required.
- `runtimeGate` is required.
- Missing runtime dependencies are invariant violations.

A true no-tool request may omit the runtime because no executor can run.

There is no fallback to:

- checker-only `ask` allow;
- no-checker execution;
- implicit auto mode.

## 13. Production path migration

### 13.1 Main streaming path

`StreamingToolExecutor` receives `ToolExecutionRuntime`.

Delete its duplicated RuntimeGate and legacy checker branches. Its only
execution action is calling `executeToolCall()`.

`TrackedTool` stores the complete `ToolExecutionResult`.

### 13.2 Main serial fallback

Delete `checkPermissionOrBlock()`.

The serial branch calls `executeToolCall()` with the same runtime as the
streaming branch.

### 13.3 Subagents

Thread the same execution runtime through:

- `createSpawnAgentTool()`
- `createTaskTool()`
- `createSpawnSelfOrganizingTool()`
- `runSubagent()`
- `runSubagentWithClient()`
- `runSelfOrganizingSubagent()`
- `runSelfOrganizingWithClient()`

The three child modes therefore use RuntimeSecurityGate instead of checker-only
or no-checker execution.

### 13.4 Main assembly order

The main RuntimeSecurityGate depends on the permission-question channel.

Create registries first, then create the question channel and RuntimeGate, then
register the three subagent tools with the complete runtime.

Do not solve ordering with an uninitialized mutable runtime variable or an
optional getter that can return `undefined`.

### 13.5 Provider and UI compatibility

The provider-facing `tool_result.content` remains a string and uses
`ToolExecutionResult.output`.

The yielded stream tool result gains an optional structured
`executionResult`.

Existing UI consumers may continue reading `output`. Future ledger and Hook
consumers read `executionResult`.

## 14. Known breaking behavior change

### Child `ask` no longer silently proceeds

This migration intentionally changes user-visible behavior.

Before:

- `spawn_agent` and self-organizing children had checker-only execution.
- A child permission decision of `ask` silently proceeded.
- `task` children had no PermissionChecker.

After:

- All P2-P4 child calls use the main RuntimeSecurityGate.
- Every child `ask` waits for explicit user approval.
- Multi-step child tasks may interrupt the user repeatedly.
- Background self-organizing work may pause while waiting for approval.

This is a security-correctness change, not a transparent refactor.

Expected impact:

- Safer child execution.
- More permission prompts.
- Lower child autonomy in default permission mode.
- Possible UX friction during long delegated tasks.

This project does not implement delegated authorization inheritance. A future
project may define a child execution context in which approving a delegation
grants a bounded, auditable subset of parent authority. Until such a mechanism
exists, explicit per-tool approval is the required behavior.

## 15. Static guard

### 15.1 Mechanism

The guard is an ESLint-enforced rule, not a code-review convention.

Use the built-in rule:

```text
no-restricted-syntax
```

Configure it in:

```text
eslint.config.js
```

The rule rejects direct `.execute()` calls whose receiver is named `registry`
or is `this.registry`, with the message:

```text
Use executeToolCall() instead of ToolRegistry.execute() in production paths.
```

It applies to production TypeScript under `src/`.

### 15.2 Explicit allowlist

Temporarily disable this restriction only for:

- `src/agent/loop.ts`
- test files that directly exercise ToolRegistry compatibility behavior

`llm-vercel.ts` does not call `registry.execute()` and is outside this specific
guard. Its direct executor path remains an explicit E4 migration item.

No other production file is allowlisted.

### 15.3 CI enforcement

The existing lint command:

```text
npm run lint
```

must fail if a migrated production path reintroduces direct
`registry.execute()`.

A focused regression test additionally scans the known P1-P5 source files and
asserts that they do not contain a direct Registry execution call. The ESLint
rule is the primary enforcement; the test documents the migration boundary.

The later path-convergence project removes the allowlist and makes the
low-level Registry invocation private or deletes it.

## 16. TDD strategy

Implementation follows RED → GREEN → REFACTOR.

### 16.1 Unit tests: result model and lookup

Verify:

- Registry `get()` returns the full RegisteredTool.
- The executor reference is preserved.
- Unknown tool returns `unknown_tool + lookup`.
- Success contains output, final input snapshot, duration, and stage hits.

### 16.2 Unit tests: validation

Verify:

- Required fields.
- Nested objects and arrays.
- Stable error paths.
- No coercion.
- Extra properties remain allowed.
- Invalid original input returns `invalid_input + validation`.
- Invalid replacement input throws `PreCallbackInputViolation`.

### 16.3 Unit tests: input identity

Verify:

- Pre can replace input.
- Replacement is revalidated.
- PermissionChecker observes the final input.
- Executor observes equal final input values.
- Executor mutation does not mutate the returned `inputUsed` snapshot.

### 16.4 Unit tests: error classification

Verify:

- `ToolOperationalError` becomes `operational_error`.
- Any `Error` with `code:string` becomes `operational_error`.
- AbortError becomes `cancelled`.
- TimeoutError becomes `timeout`.
- TypeError bubbles.
- Unmarked Error bubbles.
- Non-Error thrown values bubble unchanged.
- Message text is never used for classification.

### 16.5 Unit tests: callbacks

Verify:

- Absent callbacks leave all stage hits false.
- Pre start sets its stage hit.
- Pre throw bubbles.
- Invalid Pre result shape bubbles as invariant violation.
- Post throw preserves success and attaches `postExecuteError`.
- Failure throw preserves failure and attaches `failureCallbackError`.
- Callback errors omit stack.

### 16.6 Permission integration tests

Verify:

- allow executes once.
- deny does not execute.
- ask blocks until the decision channel resolves.
- rejected ask returns `permission_denied`.
- stale or missing decision channels fail closed.

### 16.7 Path parity tests

Verify:

- Main streaming and serial fallback produce equivalent structured outcomes.
- `spawn_agent`, `task`, and self-organizing children all reach RuntimeGate.
- No child path silently allows `ask`.
- P1-P5 no longer call `registry.execute()` directly.

## 17. Completion criteria

The project is complete only when:

1. P1-P5 can execute a tool only through `executeToolCall()`.
2. P1-P5 use required PermissionChecker and RuntimeSecurityGate dependencies.
3. Original input is runtime validated before Pre and permission.
4. Replacement input is runtime validated and invalid replacement bubbles as
   a callback invariant violation.
5. Permission and executor operate on the same final input values.
6. Expected failures return structured failure results.
7. Programmer errors still throw.
8. Post/Failure callback errors cannot erase the settled result.
9. The structured result reaches the stream boundary.
10. ESLint and regression guards reject new direct Registry execution in
    migrated production paths.
11. Focused tests, affected-module tests, typecheck, lint, and build pass.
12. No Hook loader, Stop mechanism, verification ledger, or speculative
    framework is added.

## 18. Rollback boundary

The change is kept reversible by:

- leaving `ToolRegistry.execute()` intact;
- leaving E3/E4 and disconnected facilities intact;
- adapting structured results back to existing string tool results;
- avoiding data migrations and persistent-format changes;
- adding no Hook settings format.

If migration of a production caller fails, that caller can be reverted to its
previous engine without removing the new execution module. However, the final
merged state must not mix migrated and legacy semantics within P1-P5.
