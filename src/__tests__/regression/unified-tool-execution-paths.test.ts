import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

// Resolve the repo root from this test file's location instead of
// process.cwd(). Other tests (e.g. worktree-integration) chdir into temporary
// directories, which would otherwise break source reads under full-suite runs.
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

// P1-P5 production paths that must route through executeToolCall() and never
// call ToolRegistry.execute() directly after the unified-execution migration.
const PRODUCTION_PATHS = [
  'src/agent/streaming-executor.ts',
  'src/agent/streaming-query.ts',
  'src/agent/subagent.ts',
  'src/agent/self-organizing.ts',
  'src/agent/tools/spawn-agent-tool.ts',
  'src/agent/tools/task-tool.ts',
  'src/agent/tools/spawn-self-organizing-tool.ts',
  'src/index.ts',
] as const;

const FORBIDDEN_DIRECT_EXECUTION =
  /\b(?:this\.)?registry\.execute\s*\(/;

function readSource(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('unified tool execution source boundary', () => {
  it.each(PRODUCTION_PATHS)(
    '%s does not call ToolRegistry.execute() directly',
    (rel) => {
      const source = readSource(rel);
      expect(FORBIDDEN_DIRECT_EXECUTION.test(source)).toBe(false);
    },
  );

  it('detects direct registry execution in source text', () => {
    expect(FORBIDDEN_DIRECT_EXECUTION.test(
      'await registry.execute(name, input);',
    )).toBe(true);
  });

  it('does not flag executeToolCall or unrelated execute() calls', () => {
    expect(FORBIDDEN_DIRECT_EXECUTION.test(
      'await executeToolCall(registry, call, runtime);',
    )).toBe(false);
    expect(FORBIDDEN_DIRECT_EXECUTION.test(
      'await runtime.runtimeGate.execute(decision, cb);',
    )).toBe(false);
  });
});

describe('ESLint enforcement of the unified execution boundary', () => {
  it('reports the configured restriction for direct registry.execute() in a production path', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const [result] = await eslint.lintText(
      'await registry.execute(name, input);',
      { filePath: 'src/agent/direct-execution-fixture.ts' },
    );

    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            'Use executeToolCall() instead of ToolRegistry.execute() in production paths.',
        }),
      ]),
    );
  });
});
