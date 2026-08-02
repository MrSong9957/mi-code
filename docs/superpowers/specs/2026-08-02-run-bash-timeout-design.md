# `run_bash` Timeout Design

Date: 2026-08-02

Status: Approved

## Purpose

Add a caller-configurable timeout to `run_bash` while preserving its existing
default and the existing unified tool-execution error contract.

## Input contract

`run_bash` adds one optional parameter:

```ts
timeout_ms?: number
```

The contract is:

- Default: `30_000` milliseconds when `timeout_ms` is omitted.
- Valid range: `1` through `600_000` milliseconds, inclusive.
- A value below `1` or above `600_000` is an `invalid_input` failure.

## Execution outcomes

- When the configured timeout expires, return `failure(timeout)`.
- When the execution signal is aborted, terminate the process tree and return
  `failure(cancelled)`.
- A spawn error returns `failure(operational_error)`.
- A command that starts successfully and exits with a non-zero exit code remains
  `success`; its existing output behavior is preserved.

## Minimal change scope

Implementation is limited to:

- `ToolParameter`, to represent the confirmed numeric range.
- `validateToolInput`, to reject out-of-range input as `invalid_input`.
- `createBashTool`, to declare and consume `timeout_ms`, preserve the default,
  and implement timeout, Abort, and spawn-error outcomes.
- Focused tests for the schema and range validation, default and explicit
  timeout behavior, timeout classification, Abort process-tree termination and
  classification, spawn-error classification, and preservation of non-zero
  exit-code success.

## Explicit non-goals

This change does not modify:

- The `ToolExecutor` return type.
- The `executeToolCall` error system.
- Background command execution or `BackgroundManager`.
- The unused `dispatch-map.ts` path.
- Git Bash documentation issues.
