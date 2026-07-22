# Tool call visibility

- Core flow: `tool_call` creates a `tool-progress` message immediately; `tool_result` replaces that message's lines by `toolUseId` and finalizes it in place.
- TDD: RED proved isolated calls left the store empty and the pending-store API was missing. GREEN covered immediate visibility, reverse result order, unknown IDs, hook attachment, turn cleanup, expandable output, and no-ID FIFO.
- Verification: focused Vitest suite passed 62/62; `tsc --noEmit`, scoped ESLint, and `git diff --check` passed.
