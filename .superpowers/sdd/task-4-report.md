# Task 4 — Shared Spinner View report

## Scope

Implemented only Task 4: an atomic `SpinnerContextSnapshot` in the spinner store and the pure shared `selectSpinnerView()` / `selectSpinnerTip()` selector. Ink, inline, Bootstrap, and `index` were not changed.

## TDD evidence

### RED

Command:

```powershell
npx.cmd vitest run src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=verbose
```

Exit code: `1`.

Observed failures:

- `store.getState(...).setContext is not a function` in the atomic copy and normalization test.
- `Cannot find module '../../tui/state/spinner-view.js'` in the shared selector suite.

Reason: Task 4's store setter and selector module did not yet exist. This is the expected RED state.

### GREEN

Command:

```powershell
npx.cmd vitest run src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=verbose
```

Exit code: `0`; 2 test files and 38 tests passed.

The tests cover:

- `setContext()` deep copies teammates, tasks, and each `blockedBy`; optional text is trimmed and blank text becomes `null`.
- inactive has zero rows; brief has only its animation row.
- normal prefers non-shutdown teammates, then falls back to uncompleted tasks.
- Tip threshold precedence at 30 seconds and 30 minutes.
- normal auxiliary ordering: activity, Tip, Budget, NextTask.
- animation takes the store's effective `time`, while its active teammate count derives only from `context.teammates` with `status === 'working'`.

## Verification

### Focused and affected store tests

```powershell
npx.cmd vitest run src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=dot
```

Exit code: `0`; 2 test files and 38 tests passed.

### TypeScript

```powershell
npm.cmd run typecheck
```

Exit code: `0`.

### Related ESLint

```powershell
npx.cmd eslint src/tui/state/spinner-store.ts src/tui/state/spinner-view.ts src/__tests__/tui/spinner-store.test.ts src/__tests__/tui/spinner-view.test.ts
```

Exit code: `0`.

### Diff whitespace

```powershell
git diff --check
```

Exit code: `0`.

### Full suite

```powershell
npm.cmd test -- --reporter=dot
```

Exit code: `1` after 69.5 seconds. The focused Task 4 suites passed, but the repository-wide suite has pre-existing/unrelated failures outside this task's files, including:

- inline footer physical-line and status truncation expectations that differ by one reserved row;
- image command/cache tests blocked by `EPERM` writing under `C:\Users\sry27\.micode\image-cache` in this sandbox;
- Windows process-tree cleanup assertions in `bash-process-control.test.ts`;
- `layout.test.tsx` StatusBar plain-text assertions against ANSI-styled output.

## Risks and decisions

- The legacy `activeTeammateCount` and `setActiveTeammateCount` remain unchanged because existing Ink, inline, and Bootstrap consumers still use them. The new selector deliberately does not read either field.
- The selector is intentionally not wired into renderers in this task; that work belongs to later tasks.
- No plan contradiction was found. The supplied Task 4 brief explicitly requires retaining the compatibility fields until Task 7.
- The full suite is not green due to the unrelated failures listed above. They are deliberately not changed because Task 4 forbids modifying inline, Bootstrap, or UI integration paths.

## Review follow-up — 2026-07-19

### RED

Command:

```powershell
npx.cmd vitest run src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=verbose
```

Exit code: `1`; 2 test files failed with 2 failed and 39 passed tests.

- The store test showed CR/LF remained in teammate, task, Tip, Budget, and NextTask snapshot fields.
- The view test showed a teammate auxiliary line containing CR/LF, proving one logical auxiliary item could occupy multiple physical rows.
- The newly added 1,799,999 ms and pause/resume Tip tests already passed, confirming the existing effective-time clock behavior before the text fix.

### Fix

`normalizeSpinnerContext()` now replaces each CRLF, LF, or CR sequence with one space and trims every visible context string. It applies to teammate name/role; task content/owner/activeForm/blockedBy entries; and Tip/Budget/NextTask. Optional values that become empty are normalized to `null`; task `id` remains untouched. Ordinary internal whitespace is not collapsed.

### GREEN and verification

```powershell
npx.cmd vitest run src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=verbose
npx.cmd vitest run src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=dot
npm.cmd run typecheck
npx.cmd eslint src/tui/state/spinner-store.ts src/tui/state/spinner-view.ts src/__tests__/tui/spinner-store.test.ts src/__tests__/tui/spinner-view.test.ts
git diff --check
```

All commands exited `0`; the focused suite passed 2 files and 41 tests.
