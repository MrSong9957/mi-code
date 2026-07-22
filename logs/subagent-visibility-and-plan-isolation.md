# Plan approval isolation

- TDD regression: an old plan must not open approval UI for a new turn without a write.
- Active approval capability is keyed by `sessionId + turnId`; explicit session recovery is read-only and does not activate approval.
- Verification: plan approval and plan streaming tests pass; TypeScript typecheck passes.
