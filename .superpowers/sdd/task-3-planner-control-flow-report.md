# Task 3: Planner Ask/Exit control flow

## Implementation

- Removed the unconditional instruction requiring every planner turn to end with
  `ask_user_question` or `exit_plan_mode`.
- Added explicit direct-answer, blocking-clarification, no-generic-follow-up,
  conditional-exit, and no-other-task rules to the planner prompt.
- Made Phase 3 and Phase 4 conditional on an unresolved blocking choice and a
  successful `write_plan_file` in the current user turn.
- Added the same blocking-clarification and no-generic-follow-up boundaries to
  the actual `createAskUserTool(...).definition.description`.

## TDD evidence

### RED

Command:

```powershell
npx.cmd vitest run src/__tests__/plan-mode-streaming.test.ts -t "planner control flow"
```

Result: failed as expected, with 1 failed test and 4 skipped. The runtime
`plannerPrompt` did not contain `For informational or read-only requests,
answer directly and end the turn.` The failure output also showed the old
`Every turn MUST end with either ask_user_question or exit_plan_mode.` rule.

### GREEN

Command:

```powershell
npx.cmd vitest run src/__tests__/plan-mode-streaming.test.ts src/__tests__/plan-approval.test.ts
```

Result: passed, 2 test files and 41 tests.

Command:

```powershell
npx.cmd tsc --noEmit
```

Result: passed with exit code 0.

Command:

```powershell
npx.cmd eslint src/__tests__/plan-mode-streaming.test.ts src/agent/tools/ask-user-tool.ts src/prompts/planner.generated.ts
```

Result: exit code 0, 0 errors, and 1 warning for the pre-existing unused
`eslint-disable` directive in the generated prompt header.

## Generated prompt check

Ran:

```powershell
node scripts/gen-prompts.mjs
```

It regenerated `src/prompts/planner.generated.ts`. `git diff --name-only --
src/prompts` showed only `planner.md` and `planner.generated.ts`; no other
generated prompt file changed.

## Files

- `src/prompts/planner.md`
- `src/prompts/planner.generated.ts` (generated)
- `src/agent/tools/ask-user-tool.ts`
- `src/__tests__/plan-mode-streaming.test.ts`
- `logs/subagent-visibility-and-plan-isolation.md`
- `.superpowers/sdd/task-3-planner-control-flow-report.md`

## Self-audit

- The test imports the runtime `plannerPrompt` and calls the actual Ask tool
  factory to inspect its definition.
- No validator, AskUserManager lifecycle, or plan storage behavior changed.
- Existing `package-lock.json` and untracked `docs/` changes were preserved and
  excluded from this task.

## Concerns

- The limited lint command exits successfully but reports the existing
  generated-file warning noted above. Removing it would require changing the
  generator or generated header, outside this task's minimum scope.
