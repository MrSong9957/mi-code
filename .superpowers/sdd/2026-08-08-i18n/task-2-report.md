# Task 2 report - persist and validate language

## Status

- Task: Task 2
- Branch: `feat/i18n`
- Worktree: `D:\Files\Projects\mi-code\.worktrees\feat-i18n`
- Base commit before Task 2 commit: `63c5db2`

## Scope and ruling

- Scope stayed inside the Task 2 brief file set only:
  - `src/config/schema.ts`
  - `src/config/store.ts`
  - `src/cli.ts`
  - `src/locale/startup-language.ts`
  - `src/__tests__/config.test.ts`
  - `src/__tests__/cli.test.ts`
  - `src/__tests__/language-startup.test.ts`
- Latest user ruling took precedence over the older brief wording:
  - CLI accepts only literal `zh-CN` and `en-US`
  - no lowercase normalization for explicit CLI input
  - invalid explicit CLI input remains a nonzero error path
  - invalid or absent config stays unconfigured
  - config load remains byte-stable
  - CLI override does not persist

## RED

### Baseline evidence without discarding the current implementation

I did not revert the existing Task 2 work, per handoff instructions. Instead I verified the pre-Task-2 baseline directly from `HEAD`:

- `git show HEAD:src/cli.ts`
  - `CliOptions` had no `language` or `languageError`
  - `parseCliArgs()` had no `language` option or validation branch
- `git show HEAD:src/config/store.ts`
  - no language load branch
  - no `getLanguage()` / `setLanguage()`
  - no language serialization branch
- `git cat-file -e HEAD:src/locale/startup-language.ts`
  - failed with `fatal: path 'src/locale/startup-language.ts' exists on disk, but not in 'HEAD'`

This matched the brief's required RED condition: `language`, `languageError`, and `resolveStartupLanguage` were absent before the current Task 2 implementation.

## GREEN

### Focused Vitest command requested by the brief

```bash
npx vitest run src/__tests__/config.test.ts src/__tests__/cli.test.ts src/__tests__/language-startup.test.ts
```

### Execution note

PowerShell execution policy blocked `npx.ps1`, so I ran the same Vitest arguments through `npx.cmd`:

```bash
npx.cmd vitest run src/__tests__/config.test.ts src/__tests__/cli.test.ts src/__tests__/language-startup.test.ts
```

### Output summary

- `3` test files passed
- `54` tests passed
- Verified behaviors:
  - absent persisted language returns `undefined`
  - valid persisted `en-US` loads as `en-US`
  - invalid persisted language stays unconfigured and does not rewrite config bytes
  - `setLanguage('en-US')` persists while preserving unknown fields
  - CLI accepts literal `en-US`
  - CLI accepts literal `zh-CN`
  - CLI rejects explicit unsupported `fr-FR` with `languageError`
  - CLI rejects lowercase `en-us` instead of normalizing it
  - no `--language` flag produces neither `language` nor `languageError`
  - startup selection prefers CLI over config
  - startup selection prefers valid config over default
  - invalid config falls back to default
  - valid CLI survives invalid config
  - invalid explicit CLI input returns `{ error, exitCode: 1 }` instead of falling back

### Typecheck command requested by the brief

```bash
npm run typecheck
```

### Execution note

PowerShell execution policy blocked `npm.ps1`, so I ran the same script through `npm.cmd`:

```bash
npm.cmd run typecheck
```

### Output summary

- `tsc --noEmit` passed

## Diff review

- Reviewed the current Task 2 diff in the specified worktree
- Confirmed the implementation stays in the intended Task 2 files
- Confirmed the tests reflect the latest user ruling on strict literal CLI language matching
- Confirmed no evidence that CLI override persists:
  - CLI parsing only returns transient fields
  - persistence is only through `ConfigStore.setLanguage()`
- Confirmed invalid or absent config remains unconfigured:
  - `load()` only adopts `saved.language` when `isLanguage(saved.language)` is true
  - `load()` does not call `save()`, preserving file bytes on read

## Concerns

- No code-level concerns found for Task 2.
- Operational note only: PowerShell execution policy required `npx.cmd` / `npm.cmd` shims instead of the PowerShell wrappers.
