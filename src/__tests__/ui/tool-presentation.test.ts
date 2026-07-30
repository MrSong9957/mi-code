import { describe, expect, it } from 'vitest';
import {
  buildToolGroupTitle,
  buildToolPresentation,
  isGroupableTool,
  normalizeToolName,
} from '../../ui/tool-presentation.js';

describe('buildToolPresentation', () => {
  it('summarizes glob output and retains every path', () => {
    const result = buildToolPresentation({
      toolUseId: 'g1',
      toolName: 'glob',
      input: { pattern: 'src/**/*.test.ts' },
      output: 'src/a.test.ts\nsrc/b.test.ts',
    });
    expect(result).toMatchObject({
      status: 'success',
      summary: 'src/**/*.test.ts → 2 files',
    });
    expect(result.details).toEqual([
      { kind: 'path', path: 'src/a.test.ts' },
      { kind: 'path', path: 'src/b.test.ts' },
    ]);
  });

  it('distinguishes empty and error results', () => {
    expect(buildToolPresentation({
      toolUseId: 'g0', toolName: 'glob',
      input: { pattern: '*.none' }, output: '',
    })).toMatchObject({ status: 'empty', summary: '*.none → no matches' });

    expect(buildToolPresentation({
      toolUseId: 'g2', toolName: 'glob',
      input: { pattern: 'protected/**' },
      output: 'Error: permission denied',
    })).toMatchObject({
      status: 'error',
      summary: 'protected/** → failed: permission denied',
      errorMessage: 'permission denied',
    });
  });

  it('parses grep locations without discarding snippets', () => {
    const result = buildToolPresentation({
      toolUseId: 'p1',
      toolName: 'grep',
      input: { pattern: 'TODO', path: 'src' },
      output: 'src/a.ts:12: TODO fix\nsrc/b.ts:3: TODO test',
    });
    expect(result.summary).toBe('TODO in src → 2 matches');
    expect(result.details[0]).toEqual({
      kind: 'snippet', path: 'src/a.ts', line: 12, text: 'TODO fix',
    });
  });

  it('uses read input as semantic identity and retains raw detail', () => {
    const result = buildToolPresentation({
      toolUseId: 'r1',
      toolName: 'read_file',
      input: { path: 'src/index.ts', limit: 20 },
      output: '1: import x\n2: export y',
    });
    expect(result).toMatchObject({
      status: 'success',
      summary: 'src/index.ts',
    });
    expect(result.details).toEqual([
      { kind: 'text', text: '1: import x\n2: export y' },
    ]);
  });

  it('keeps compact subagent summaries free of renderer glyphs', () => {
    const result = buildToolPresentation({
      toolUseId: 'a1',
      toolName: 'spawn_agent',
      input: { description: '探索项目' },
      output: '[Subagent status=completed]\nDone.',
      durationMs: 5_000,
    });

    expect(result).toMatchObject({
      layout: 'compact-completion',
      summary: 'Agent "探索项目" finished · 5s',
    });
  });

  it('normalizes aliases and keeps side-effecting tools ungroupable', () => {
    expect(normalizeToolName('read')).toBe('read_file');
    expect(normalizeToolName('search')).toBe('glob');
    expect(isGroupableTool('read')).toBe(true);
    expect(isGroupableTool('run_bash')).toBe(false);
    expect(buildToolGroupTitle('glob', 4)).toBe('Searched 4 patterns');
    expect(buildToolGroupTitle('read_file', 2)).toBe('Read 2 items');
  });

  it('falls back safely when a presentation builder receives malformed values', () => {
    const result = buildToolPresentation({
      toolUseId: 'bad',
      toolName: 'glob',
      input: { pattern: { unexpected: true } },
      output: 'Error: {"apiKey":"secret","message":"denied"}',
    });
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('[object Object]');
  });
});
