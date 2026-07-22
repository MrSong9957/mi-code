# Plan approval isolation

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
