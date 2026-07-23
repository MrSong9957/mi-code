# AUTO-0025 Task 4 Report

## Status

Implemented questionnaire keyboard routing, bootstrap-owned store composition, `ConnectedApp` / `InlineAppV2` wiring, compile-fixture updates, and the V2 inline questionnaire user-path E2E suite. Task 5 manager/tools code was not changed.

## TDD evidence

### Input routing RED

Command:

```powershell
npx.cmd vitest run src/__tests__/tui/use-input-handler.test.tsx
```

Observed before production routing was added:

- Exit code: 1
- 1 test file failed
- 8 questionnaire tests failed, 36 tests passed
- Failures showed `focusIndex` / `pageIndex` remained `0`, outcomes were never called, and Other mode never opened.
- The Ctrl+C-global-priority test passed, proving that fixture wiring itself was valid.

### Input routing GREEN

Same command after the minimal routing implementation:

- Exit code: 0
- 44/44 tests passed

Covered routes: Up/Down, Ctrl+P/Ctrl+N, Tab/Right, Shift+Tab/Left, Space/Enter, Other character/Backspace/Delete/Enter, Esc, Chat, Ctrl+C, and questionnaire priority over overlay/select/completion/input. Every draft-preservation assertion passed.

### E2E RED

Command:

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx
```

Observed before production composition was added:

- Exit code: 1
- 5/5 tests failed
- Frames still showed the old footer/spinner and did not contain the questionnaire.
- Esc/Chat outcomes were never called because `ConnectedApp` did not yet route the harness-owned store.

### E2E GREEN

Same command after wiring one store through `ConnectedApp` and `InlineAppV2`:

- Exit code: 0
- 5/5 tests passed

Covered: immediate single-choice settlement, multi-question flow through Submit, Esc cancellation, Chat settlement, spinner/footer replacement and restoration, and byte-for-byte preservation of a pre-existing multiline Unicode draft.

## Implementation

- `useInputHandler` now accepts an optional final `askQuestionStore` argument. Production supplies it; unrelated positional call sites remain unchanged.
- Routing order is Ctrl+C, questionnaire, overlay, select, completion, normal input.
- Other editing stays exclusively in `AskQuestionStore`; it cannot mutate `InputStore`.
- `bootstrap()` owns one `askQuestionStore`, exposes it on `BootstrapHandle`, passes that same instance to `ConnectedApp`, and returns it.
- `ConnectedApp` passes the same instance to `useInputHandler` and `InlineAppV2`.
- `InlineAppV2` subscribes only to questionnaire visibility and renders questionnaire before select, spinner, and footer.
- The E2E harness mirrors production ownership and exposes the same store to tests.
- All requested direct `InlineAppV2Stores` / `ConnectedApp` fixtures were updated mechanically; their assertions were not changed.

## Files

Production:

- `src/tui/input/use-input-handler.ts`
- `src/tui/ConnectedApp.tsx`
- `src/tui/bootstrap.tsx`
- `src/tui/inline-v2/InlineAppV2.tsx`

Tests and fixtures:

- `src/__tests__/tui/use-input-handler.test.tsx`
- `src/__tests__/tui/inline-v2/helpers/e2e-harness.tsx`
- `src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx`
- `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`
- `src/__tests__/tui/inline-v2/logo-regression.test.tsx`
- `src/__tests__/tui/inline-v2/logo-static-identity.test.tsx`
- `src/__tests__/tui/inline-v2/overlay-footer-recovery.test.tsx`
- `src/__tests__/tui/inline-v2/v2-resize.test.tsx`
- `src/__tests__/tui/connected-app-spinner-clock.test.tsx`

## Verification

Required combined command:

```powershell
npx.cmd vitest run src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/inline-v2/select-overlay.test.tsx
```

Result: exit 0, 4 files passed, 72/72 tests passed.

Expanded Task 4 regression command covering every changed fixture:

```powershell
npx.cmd vitest run src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/inline-v2/select-overlay.test.tsx src/__tests__/tui/inline-v2/logo-regression.test.tsx src/__tests__/tui/inline-v2/logo-static-identity.test.tsx src/__tests__/tui/inline-v2/overlay-footer-recovery.test.tsx src/__tests__/tui/inline-v2/v2-resize.test.tsx src/__tests__/tui/connected-app-spinner-clock.test.tsx
```

Result: exit 0, 9 files passed, 96/96 tests passed.

TypeScript:

```powershell
npm.cmd run typecheck
```

Result: exit 0.

Focused lint:

- Normal lint on production/input/bootstrap, substantive tests, harness, E2E, and clean fixtures: exit 0.
- `ConnectedApp.tsx` passed with `--no-inline-config` to bypass its pre-existing references to an unavailable `react-hooks/rules-of-hooks` plugin rule.
- `InlineAppV2.tsx` and two mechanical fixtures passed with only their pre-existing `no-unused-vars` diagnostics disabled.
- A raw lint run over every touched file reports only six pre-existing diagnostics on unchanged lines: three missing `react-hooks/rules-of-hooks` rule definitions, `overlayVisible`, `overlayVer`, and an unused `vi` import.

Additional full-suite check:

```powershell
npm.cmd test
```

Result: exit 1 with 13 unrelated failures outside Task 4: background timeout classification (3), ANSI-sensitive layout assertions (2), Windows process-tree cleanup assertions (2), and sandbox-denied image-cache writes (6). All Task 4 tests passed within that run.

## Self-review

- Confirmed the diff contains only the 13 Task 4 production/test files listed above plus this report; no manager/tools files changed.
- Confirmed `askQuestionStore` identity is created once in bootstrap and is not recreated by components.
- Confirmed Ctrl+C returns before questionnaire state is inspected.
- Confirmed questionnaire returns before overlay/select/completion/input branches.
- Confirmed input-mode editing branches precede navigation and all draft-preservation tests use the real stores.
- Confirmed active-region precedence is questionnaire, select, spinner/footer without changing existing overlay host lifecycle or fixture assertions.
- Found one initially missed second store factory in `logo-regression.test.tsx`; its existing 7 failing whole-tree tests identified the omission, and adding only the missing fixture store restored 12/12.

## Concerns

- No Task 4 blocking concern.
- Repository-wide lint and test baselines contain the unrelated diagnostics/failures documented above. They were deliberately not fixed because Task 4 forbids expanding into manager/tools or unrelated cleanup.

## Reviewer follow-up: questionnaire paste ownership

### Finding

`ConnectedApp` owns Ink's `usePaste` callback independently of `useInputHandler`. The original Task 4 wiring routed keyboard input correctly, but bracketed paste still unconditionally inserted a generated placeholder into `InputStore` while the questionnaire was visible. This violated the input-draft preservation invariant and could not populate Other mode.

### RED

Added three full-tree Ink/E2E cases to `ask-question-e2e.test.tsx`:

1. Visible questionnaire outside Other mode swallows paste and preserves `InputStore` exactly.
2. Visible questionnaire in Other mode inserts the raw pasted text into `AskQuestionStore.otherDraft` and preserves `InputStore` exactly.
3. After questionnaire close, ordinary paste still uses the existing placeholder path.

Command:

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx
```

Observed before the fix: exit 1, 2 failed and 6 passed. The first failure showed `[Pasted text #1 +2 lines]` appended to the input draft; the second showed `otherDraft === ''` instead of the raw `alpha\nbeta`. The closed-questionnaire regression case already passed.

### Minimal fix and GREEN

`ConnectedApp` now reads `askQuestionStore.getState()` inside `usePaste`. If visible, it inserts the original paste text into Other only when `inputMode` is true, then returns; otherwise it swallows the paste. Only an invisible questionnaire reaches `storePastedContent()` and `inputStore.insert()`.

Commands and results:

```powershell
npx.cmd vitest run src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/paste-inline-integration.test.tsx
```

Exit 0, 2 files and 12/12 tests passed.

```powershell
npx.cmd vitest run src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/paste-inline-integration.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/inline-v2/select-overlay.test.tsx src/__tests__/tui/inline-v2/logo-regression.test.tsx src/__tests__/tui/inline-v2/logo-static-identity.test.tsx src/__tests__/tui/inline-v2/overlay-footer-recovery.test.tsx src/__tests__/tui/inline-v2/v2-resize.test.tsx src/__tests__/tui/connected-app-spinner-clock.test.tsx
```

Exit 0, 10 files and 103/103 tests passed.

`npm.cmd run typecheck`, focused ESLint for the two changed source/test files, and `git diff --check` all exited 0. No image-paste behavior was added and no Task 5 files changed.
