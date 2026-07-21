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

Command (files were enumerated by `git diff --name-only dce7012..HEAD -- 'src/**/*.ts' 'src/**/*.tsx'`):

```text
npx.cmd eslint <36 AUTO-0025-modified source/test files>
```

- Exit code: 1
- Actual result: 10 problems (6 errors, 4 warnings) in 5 files.
- The diagnostics are on lines unchanged from baseline `dce7012`: 3 warnings in `streaming-executor.test.ts`; 1 error in `logo-static-identity.test.tsx`; 1 error in `overlay-footer-recovery.test.tsx`; 3 errors plus 1 warning in `ConnectedApp.tsx`; 1 error in `InlineAppV2.tsx`.
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
- Test files: 2 failed
- Tests: 14 passed, 5 failed
- Failures are exactly the approved baseline: three background timeout status assertions and two layout ANSI-sensitive string assertions. These accepted baseline tests did **not** pass.

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
