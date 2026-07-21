# Prompts

Prompt files for mi-code agents.

## How it works

1. Edit `.md` files in this directory (e.g. `planner.md`)
2. Run `npm run gen:prompts` (or `node scripts/gen-prompts.mjs`)
3. The script generates `<name>.generated.ts` from each `<name>.md`
4. Import via `src/prompts/index.ts`

## Adding a new prompt

1. Create `src/prompts/<name>.md`
2. Run `npm run gen:prompts`
3. Add export to `src/prompts/index.ts`
4. Commit both the `.md` and `.generated.ts` files
