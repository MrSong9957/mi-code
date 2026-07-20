# Task 7: runtime spinner context bridge

## Scope

- Added a pure `readSpinnerContext()` boundary that maps `TeammateManager.list()` and
  `TodoManager.getItems()` into an atomic `SpinnerContextSnapshot`.
- Bootstrapped the initial snapshot, refreshed it before each spinner start, and refreshed it
  after each tool-result pipeline emission.
- Replaced the legacy active-teammate setter path with `setSpinnerContext()`.

## TDD evidence

### RED

1. `npx.cmd vitest run src/__tests__/tui/spinner-store.test.ts --reporter=verbose`
   exited 1: the new initial-context test expected `variant: 'brief'`, but the store still
   contained the default `variant: 'normal'`.
2. `npx.cmd vitest run src/__tests__/tui/spinner-context.test.ts --reporter=verbose`
   exited 1: `../../tui/spinner-context.js` did not exist.

### GREEN

`npx.cmd vitest run src/__tests__/tui/spinner-store.test.ts src/__tests__/tui/spinner-context.test.ts src/__tests__/tui/spinner-view.test.ts --reporter=verbose`
exited 0: 3 files and 44 tests passed. The mapping test verifies copied teammate data, selected
todo fields, copied `blockedBy`, `owner`/`activeForm` normalization to `null`, and fallback reuse.

## Verification

- Focused Task 4-7 and manager regression suite:
  `npx.cmd vitest run src/__tests__/tui/spinner-store.test.ts src/__tests__/tui/spinner-context.test.ts src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/use-spinner-clock.test.tsx src/__tests__/tui/spinner-component.test.tsx src/__tests__/tui/spinner-integration.test.tsx src/__tests__/tui/SpinnerLine.test.tsx src/__tests__/tui/layout-spinner-row-count.test.tsx src/__tests__/tui/connected-app-spinner-clock.test.tsx src/__tests__/tui/bootstrap-spinner-completion.test.ts src/__tests__/team.test.ts src/__tests__/todo.test.ts --reporter=dot`
  exited 0: 12 files and 118 tests passed.
- TypeScript: `npm.cmd run typecheck` exited 0.
- Targeted ESLint for new/changed non-index files exited 0.
- `git diff --check` exited 0.

## Baseline issues

- `src/tui/inline/` has 31 existing failures when run as a directory. They consistently expect one
  more footer row than the implementation produces (for example 6 expected vs 5 received in
  `commit-footer-erase.test.ts`). This is the pre-Task-7 stale two-row-reservation expectation
  documented by the implementation plan; Task 7 does not modify footer layout.
- Full `npm.cmd run lint` exits 1 with 111 existing errors and 49 warnings. The changed
  `src/index.ts` is also blocked by its pre-existing unused `COMMAND_NAMES` import at line 43.
