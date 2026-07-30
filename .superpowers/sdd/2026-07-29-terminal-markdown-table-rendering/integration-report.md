# Unified Tool Presentation prerequisite integration report

## Result

- Repository: `D:\Files\Projects\mi-code`
- Preserved dirty worktree: `D:\Files\Projects\mi-code`
- Isolated worktree: `D:\Files\Projects\mi-code\.worktrees\terminal-markdown-table-integration`
- Integration branch: `codex/terminal-markdown-table-integration`
- Integration base: `01699a9bf37b9cab40b625186b26ff6800b9d2f6`
- Current integrated tip before this report: `6df829a`

The original `feature/agent-mechanisms-wave-a` worktree was not switched, reset,
cleaned, stashed, staged, or rewritten.

## Source change inventory

### Included Unified Tool Presentation production changes

- Transcript lifecycle and presentation types:
  - `src/tui/transcript-types.ts`
  - `src/tui/state/turn-duration-message.ts`
- Presentation builders and safe error formatting:
  - `src/ui/tool-presentation.ts`
  - `src/ui/ask-user-presentation.ts`
  - `src/utils/error-message.ts`
- Semantic transcript reducer/store/pipeline:
  - `src/tui/state/transcript-reducer.ts`
  - `src/tui/state/messages-store.ts`
  - `src/tui/state/pipeline-adapter.ts`
  - `src/ui/block-pipeline.ts`
  - `src/ui/message-formatter.ts`
  - the minimum `PipelineRenderer` bootstrap hunk in `src/index.ts`
- Typed Inline V2 rendering:
  - `src/tui/inline-v2/AskBlockLine.tsx`
  - `src/tui/inline-v2/ToolBlockLine.tsx`
  - `src/tui/inline-v2/TranscriptBlockLine.tsx`
  - `src/tui/inline-v2/InlineAppV2.tsx`
  - deletion of the superseded `src/tui/inline-v2/MessageLine.tsx`
- Unified Tool Presentation source documentation:
  - `docs/superpowers/plans/2026-07-29-unified-tool-presentation.md`
  - `docs/superpowers/specs/2026-07-29-unified-tool-presentation-design.md`

### Included direct tests and helpers

- Lifecycle/presentation/reducer tests:
  - `src/__tests__/tui/transcript-types.test.ts`
  - `src/__tests__/tui/transcript-reducer.test.ts`
  - `src/__tests__/ui/tool-presentation.test.ts`
  - `src/__tests__/ui/ask-block.test.ts`
  - `src/__tests__/utils/error-message.test.ts`
- Semantic store/pipeline tests:
  - `src/__tests__/tui/messages-store.test.ts`
  - `src/__tests__/tui/pipeline-adapter.test.ts`
  - `src/__tests__/tui/pipeline-integration.test.ts`
  - `src/__tests__/tui/turn-lifecycle.test.ts`
  - `src/__tests__/ui/block-pipeline.test.ts`
  - `src/__tests__/ui/thinking-stream.test.ts`
- Typed Inline V2 tests:
  - `src/__tests__/tui/inline-v2/ask-block-line.test.tsx`
  - `src/__tests__/tui/inline-v2/tool-block-line.test.tsx`
  - `src/__tests__/tui/inline-v2/transcript-block-line.test.tsx`
  - `src/__tests__/tui/inline-v2/ask-user-structured-result-integration.test.ts`
  - `src/__tests__/tui/inline-v2/e2e-basic.test.tsx`
  - `src/__tests__/tui/inline-v2/e2e-bug-regression.test.tsx`
  - `src/__tests__/tui/inline-v2/e2e-stream-interrupt.test.tsx`
  - `src/__tests__/tui/inline-v2/finalize-atomic.test.ts`
  - `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`
  - `src/__tests__/tui/inline-v2/logo-regression.test.tsx`
  - deletion of superseded `message-line.test.tsx` and `read-grouping.test.ts`

`inline-app-v2.test.tsx` retained the dirty-worktree `makeProps` and `stripAnsi`
helpers before the table lifecycle commit was applied.

### Explicit exclusions

- Agent/subagent error propagation:
  - agent implementation changes and agent/role/subagent/tool-registry tests
  - `docs/superpowers/plans/2026-07-28-subagent-error-propagation.md`
- Compression/recovery:
  - `src/agent/compression.ts`, `src/agent/recovery.ts`
  - their tests and the tool-transcript compaction plan
- Stream/provider and unrelated CLI wiring:
  - `src/agent/stream-event-bus.ts`
  - `src/agent/streaming-query.ts`
  - `src/agent/subagent.ts`
  - `src/agent/tool-registry.ts`
  - `src/cli/format-error.ts`
- Unrelated TUI/status work:
  - `src/tui/components/StatusBar.tsx`
- Prompt work:
  - `src/prompts/system.md`
  - `src/prompts/planner.generated.ts`
  - `src/prompts/system.generated.ts`
- Other unrelated files:
  - `ai-news-2026-07.html`
  - unrelated plans/specs/tests

The `src/index.ts` file was initially classified as mixed-scope. TypeScript
proved that its `PipelineRenderer` bootstrap object was a direct build
prerequisite. Only that object-literal hunk was transferred.

## Prerequisite commits

Dependency order:

1. `914d2cc` `refactor: define transcript lifecycle types`
2. `51de393` `feat: add structured tool presentations`
3. `8fd9b9d` `feat: add transcript grouping reducer`
4. `170035e` `refactor: represent ask results as ask blocks`
5. `a4379f2` `refactor: route pipeline through semantic timeline`
6. `19a1d81` `feat: render grouped tool transcript blocks`
7. `ae53085` `docs: add unified tool presentation plan`

The prerequisite `TranscriptBlockLine` used the existing raw assistant rendering
behavior so every prerequisite commit remained buildable. Tool and Ask routing
were already present before any terminal table commit.

## Table cherry-picks

| Source | Integrated commit | Result |
| --- | --- | --- |
| `d054fb2` | `3217631` | clean |
| `17059d6` | `c98be02` | clean |
| `7697ac9` | `c5bb215` | clean |
| `2f55ad7` | `45c50ba` | clean |
| `6b5bd89` | `266aa16` | clean |
| `d203faa` | `e3025af` | clean |
| `838f2e3` | `066861d` | expected add/add conflict resolved |
| `d27662c` | `f8c5f22` | clean automatic merge |
| `4ebfdda` | `8970f38` | clean |
| `9dab2d2` | `58db841` | clean |

`838f2e3` conflicted only in:

- `src/tui/inline-v2/TranscriptBlockLine.tsx`
- `src/__tests__/tui/inline-v2/transcript-block-line.test.tsx`

Resolution preserved the already-tested Tool/Ask/system/user/duration routing and
changed only the assistant branch to `AssistantBlockLine`, plus the corresponding
bordered-table assertion. The resolved component slice passed 15/15 tests and
TypeScript before `git cherry-pick --continue`.

## Lifecycle test

- `1df6c96` `test: use one renderer for table finalization`

The streaming/finalization test now:

- creates one renderer;
- does not call `unmount`;
- does not call a second `render`;
- finalizes the assistant and calls `app.rerender`;
- asserts the raw `| Tool | Purpose |` Markdown disappears;
- asserts `glob` and the assistant marker each occur once.

The file passed 47/47 tests after the change.

Scoped ESLint also exposed one stale unused reducer-test import. It was removed
in `6df829a` (`test: remove stale reducer import`), after which the reducer test
passed 12/12 and scoped ESLint passed.

## Verification

### Prerequisite checkpoints

- `npx.cmd vitest run src/__tests__/tui/transcript-types.test.ts src/__tests__/tui/turn-duration-message.test.ts`
  - 2 files, 18/18 tests passed.
- `npx.cmd vitest run src/__tests__/utils/error-message.test.ts src/__tests__/ui/tool-presentation.test.ts src/__tests__/ui/message-formatter.test.ts`
  - 3 files, 52/52 tests passed.
- `npx.cmd vitest run src/__tests__/tui/transcript-reducer.test.ts src/__tests__/tui/transcript-types.test.ts`
  - 2 files, 14/14 tests passed.
- `npx.cmd vitest run src/__tests__/ui/ask-block.test.ts src/__tests__/ui/ask-user-presentation.test.ts`
  - 2 files, 10/10 tests passed.
- Semantic store/pipeline command covering messages-store, pipeline-adapter,
  block-pipeline, thinking-stream, pipeline-integration, and turn-lifecycle:
  - 6 files, 93/93 tests passed.
- Typed renderer command covering ten Inline V2 files:
  - 10 files, 96/96 tests passed.
- Every prerequisite code checkpoint also ran TypeScript successfully.

### Final required checks

- Table affected slice:

  ```text
  npx.cmd vitest run src/__tests__/tui/table-layout.test.ts src/__tests__/tui/inline-v2/assistant-block-line.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx src/__tests__/tui/inline-v2/transcript-block-line.test.tsx src/__tests__/tui/inline-v2/streaming-text.test.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/render-markdown.test.tsx
  ```

  Result: 8 files, 105/105 tests passed.

- TypeScript:

  ```text
  npx.cmd tsc --noEmit
  ```

  Result: exit 0.

- Scoped ESLint:

  ```text
  $files = git diff --name-only '01699a9..HEAD' -- '*.ts' '*.tsx' |
    Where-Object { (Test-Path -LiteralPath $_) -and ($_ -ne 'src/index.ts') }
  npx.cmd eslint -- $files
  ```

  Result: exit 0 across all integrated TUI/UI/table files.

  A broader first run including the whole `src/index.ts` reported two unrelated
  existing-file diagnostics outside the integration hunk:
  `COMMAND_NAMES` unused at line 47 and `no-useless-catch` at line 365. They were
  not modified because the only integrated `src/index.ts` change is the
  `PipelineRenderer` bootstrap object near line 270.

- Build:

  ```text
  npm.cmd run build
  ```

  Result: exit 0 (`node scripts/gen-prompts.mjs && tsc`).

  On Windows the generation step changed only embedded LF to CRLF in
  `planner.generated.ts` and `system.generated.ts`. Those build-created working
  tree differences were restored because prompt/generated-prompt changes are
  explicitly excluded.

- Whitespace and status:

  ```text
  git diff --check
  git status --short
  ```

  Final expected result after report creation: both produce no output and exit 0.

## Concerns

- The full test suite was not run. No full-suite success is claimed. The earlier
  dirty-worktree run recorded 14 unclassified failures; this report does not
  reclassify them.
- Whole-file ESLint for `src/index.ts` still has the two unrelated diagnostics
  listed above. The integrated hunk is covered by TypeScript and the successful
  project build.
- No unresolved cherry-pick conflict, dependency, or prerequisite scope concern
  remains.
