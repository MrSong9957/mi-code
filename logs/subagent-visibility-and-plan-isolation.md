# Subagent visibility and plan isolation

## Pending tool visibility

- Root cause: `tool_call` entered `BlockPipeline.toolBuffer` but was not emitted to
  `MessagesStore` until the matching `tool_result` arrived.
- TDD RED: a standalone `tool_call` left the message list empty; the store had no
  pending-tool lifecycle API.
- Minimal fix: create a `tool-progress` message immediately, then resolve the same
  message by `toolUseId`; calls without IDs keep the FIFO compatibility path.
- Regression fix: an orphan result clears the previous hook target, so its hook
  cannot attach to an earlier completed tool.
- Verification: block pipeline, pipeline integration, and message store tests pass
  (63 tests); TypeScript and scoped ESLint pass.

## Plan approval isolation

- TDD regression: an old plan must not open approval UI for a new turn without a write.
- Active approval capability is keyed by `sessionId + turnId`; explicit session recovery is read-only and does not activate approval.
- Verification: plan approval and plan streaming tests pass; TypeScript typecheck passes.

## Planner Ask/Exit control flow

- TDD RED: the runtime `plannerPrompt` lacked the direct-answer rule and still
  contained the unconditional Ask-or-Exit instruction.
- Minimal fix: informational/read-only turns and no-other-task responses end
  directly; Ask is limited to unresolved blocking choices; Exit requires a
  successful `write_plan_file` in the current user turn.
- The Ask tool definition now carries the same blocking-clarification and
  no-generic-follow-up boundaries.
- Verification: planner streaming and approval tests pass (41 tests);
  TypeScript typecheck passes.

## Final verification

- Impacted suite: 6 files, 107 tests passed.
- TypeScript: `npm.cmd run typecheck` passed.
- Full suite: completed with 15 failures, the same count and categories observed
  before implementation (background timeout race, ANSI layout assertions,
  task-tool fixture, sandboxed image cache, and Windows process cleanup).
- Project lint remains red on the pre-existing baseline: 54 errors and 68 warnings
  across unrelated files. Scoped lint for every changed production/test file passed;
  the generated planner file retains one existing unused-disable warning.
