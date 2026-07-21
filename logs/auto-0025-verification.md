# AUTO-0025 verification evidence

Date: 2026-07-22 (Asia/Shanghai)
Branch: `codex/auto-0025`
Verification start HEAD: `1c4f515`

## Focused AUTO-0025 suite

Command:

```text
npx.cmd vitest run src/__tests__/agent/ask-user-validation.test.ts src/__tests__/agent/ask-user-serialization.test.ts src/__tests__/ask-user.test.ts src/__tests__/tui/ask-question-store.test.ts src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/plan-approval.test.ts src/__tests__/plan-approval-transition.test.ts
```

- Exit code: 0
- Test files: 9 passed, 0 failed
- Tests: 133 passed, 0 failed, 0 skipped
- Duration: 40.98s

## Affected-module regression suite

Command:

```text
npx.cmd vitest run src/__tests__/tui/inline-v2/ src/__tests__/tui/select-store.test.ts src/__tests__/streaming-query.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/regression/permission-executor-integration.test.ts
```

- Exit code: 0
- Test files: 23 passed, 0 failed
- Tests: 145 passed, 0 failed, 0 skipped
- Duration: 20.36s

## Static checks

### TypeScript

Command: `npm.cmd run typecheck`

- Exit code: 0
- `tsc --noEmit` produced no diagnostics.

### Full-repository lint

Command: `npm.cmd run lint`

- Exit code: 1
- Actual result: 119 problems (52 errors, 67 warnings).
- This is existing repository lint debt; the full repository did **not** pass lint.

### AUTO-0025 modified-file lint

Reproducible PowerShell command (the array splat expands to the 36 paths listed below):

```powershell
$auto0025Files = @(git diff --name-only dce7012..HEAD -- 'src/**/*.ts' 'src/**/*.tsx')
$auto0025Files
$auto0025Files.Count
& npx.cmd eslint @auto0025Files
$auto0025LintExit = $LASTEXITCODE
Write-Output ('ESLINT_EXIT=' + $auto0025LintExit)
exit $auto0025LintExit
```

- Expanded file list (36):

```text
src/__tests__/agent/ask-user-serialization.test.ts
src/__tests__/agent/ask-user-validation.test.ts
src/__tests__/ask-user.test.ts
src/__tests__/commands/command-names.test.ts
src/__tests__/commands/suggestion-data.test.ts
src/__tests__/config.test.ts
src/__tests__/fixtures/ask-user-chat-feedback.ts
src/__tests__/plan-approval-transition.test.ts
src/__tests__/plan-approval.test.ts
src/__tests__/streaming-executor.test.ts
src/__tests__/tui/ask-question-store.test.ts
src/__tests__/tui/connected-app-spinner-clock.test.tsx
src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx
src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
src/__tests__/tui/inline-v2/helpers/e2e-harness.tsx
src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
src/__tests__/tui/inline-v2/logo-regression.test.tsx
src/__tests__/tui/inline-v2/logo-static-identity.test.tsx
src/__tests__/tui/inline-v2/overlay-footer-recovery.test.tsx
src/__tests__/tui/inline-v2/v2-resize.test.tsx
src/__tests__/tui/use-input-handler.test.tsx
src/agent/ask-user-manager.ts
src/agent/ask-user-serialization.ts
src/agent/ask-user-types.ts
src/agent/ask-user-validation.ts
src/agent/tools/ask-user-tool.ts
src/agent/tools/plan-tools.ts
src/commands/executor.ts
src/commands/suggestion-data.ts
src/plan/plan-approval-transition.ts
src/tui/ConnectedApp.tsx
src/tui/bootstrap.tsx
src/tui/inline-v2/AskQuestionOverlayV2.tsx
src/tui/inline-v2/InlineAppV2.tsx
src/tui/input/use-input-handler.ts
src/tui/state/ask-question-store.ts
```

- Exit code: 1
- Actual result: 10 problems (6 errors, 4 warnings) in 5 files.
- Exact diagnostics:

| File | Line:column | Severity | Rule/message |
|---|---:|---|---|
| `src/__tests__/streaming-executor.test.ts` | 55:27 | warning | `@typescript-eslint/no-explicit-any` |
| `src/__tests__/streaming-executor.test.ts` | 71:27 | warning | `@typescript-eslint/no-explicit-any` |
| `src/__tests__/streaming-executor.test.ts` | 72:27 | warning | `@typescript-eslint/no-explicit-any` |
| `src/__tests__/tui/inline-v2/logo-static-identity.test.tsx` | 67:12 | error | `@typescript-eslint/no-unused-vars`: `overlayVer` unused |
| `src/__tests__/tui/inline-v2/overlay-footer-recovery.test.tsx` | 14:32 | error | `@typescript-eslint/no-unused-vars`: `vi` unused |
| `src/tui/ConnectedApp.tsx` | 56:1 | warning | unused `no-control-regex` disable directive |
| `src/tui/ConnectedApp.tsx` | 309:5 | error | `react-hooks/rules-of-hooks`: rule definition not found |
| `src/tui/ConnectedApp.tsx` | 318:5 | error | `react-hooks/rules-of-hooks`: rule definition not found |
| `src/tui/ConnectedApp.tsx` | 320:5 | error | `react-hooks/rules-of-hooks`: rule definition not found |
| `src/tui/inline-v2/InlineAppV2.tsx` | 124:9 | error | `@typescript-eslint/no-unused-vars`: `overlayVisible` unused |

- Baseline attribution: `git diff --unified=3 dce7012..HEAD --` for these five files shows the AUTO-0025 hunks do not change any diagnostic line; direct `git show dce7012:<path>` checks confirm the same constructs already exist at baseline.
- AUTO-0025 additions adjacent to those lines did not add a lint diagnostic. No unrelated lint debt was modified.

## Full suite and accepted baseline

Command: `npm.cmd test`

- Exit code: 1
- Test files: 161 passed, 5 failed (166 total)
- Tests: 1745 passed, 13 failed, 2 skipped (1760 total)
- Duration: 159.81s
- Accepted failures present: 3 assertions in `src/__tests__/background.test.ts` and 2 ANSI assertions in `src/__tests__/tui/layout.test.tsx`.
- Additional sandbox/Windows failures in the full run: 2 process-reaping assertions in `bash-process-control.test.ts` and 6 writes to `C:\Users\sry27\.micode\image-cache` across `image-utils.test.ts` and `image-command.test.ts`.

Environment classification rerun (outside the sandbox):

```text
npx.cmd vitest run src/__tests__/regression/bash-process-control.test.ts src/__tests__/agent/image-utils.test.ts src/__tests__/commands/image-command.test.ts
```

- Exit code: 0
- Test files: 3 passed, 0 failed
- Tests: 51 passed, 0 failed, 0 skipped
- The 8 additional full-run failures are therefore environment-specific, not AUTO-0025 regressions.

Accepted-baseline-only confirmation:

```text
npx.cmd vitest run src/__tests__/background.test.ts src/__tests__/tui/layout.test.tsx
```

- Exit code: 1
- Test files: 0 passed, 2 failed, 0 skipped (2 total)
- Tests: 14 passed, 5 failed, 0 skipped (19 total)
- Failures are exactly the approved baseline: three background timeout status assertions and two layout ANSI-sensitive string assertions. These accepted baseline tests did **not** pass.

## Diff whitespace check

Fresh command:

```text
git diff --check dce7012..HEAD
```

- Exit code: 0
- Output: none.

## Manual inline V2 verification

Status: **pending user testing**.

This execution environment does not provide an attached interactive TTY or external model/API session, so the real inline V2 paths could not be manually exercised. Automated Ink/E2E results were not counted as manual verification. The following remain to be tested by a user in a real terminal:

1. Single-choice Enter immediate submission.
2. Two-question Tab/Shift+Tab navigation and unanswered-submit warning.
3. Multi-select Space/Enter toggle without auto-advance.
4. Other text overriding selected labels.
5. Chat result matching the fixture structure.
6. Esc returning `User declined to answer questions`.
7. Normal input draft preservation after the questionnaire.
8. `exit_plan_mode` mappings for auto+clear, auto+keep, build+keep, feedback, Esc, and Chat, including visible context reset for auto+clear.

## Conclusion

No AUTO-0025 regression was found by the focused, affected-module, typecheck, full-suite baseline comparison, or environment-isolation rerun. Repository-wide lint debt and the five approved baseline assertions remain. Manual real-terminal verification remains outstanding.
