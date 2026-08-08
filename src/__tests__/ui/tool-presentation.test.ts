import { describe, expect, it } from 'vitest';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import type { Language, Translator } from '../../locale/types.js';
import {
  buildToolGroupTitle,
  buildToolPresentation,
  isGroupableTool,
  normalizeToolName,
} from '../../ui/tool-presentation.js';

function translatorFor(language: Language): Translator {
  return createTranslator(createLanguageStore(language));
}

describe('buildToolPresentation', () => {
  it.each([
    {
      language: 'zh-CN' as const,
      globSummary: 'src/**/*.test.ts → 2 个文件',
      grepSummary: 'TODO 在 src 中 → 2 个匹配',
      globEmptySummary: '*.none → 无匹配',
      globErrorSummary: 'protected/** → 失败：permission denied',
      groupGlobTitle: '搜索了 4 个模式',
      groupReadTitle: '读取了 2 项',
    },
    {
      language: 'en-US' as const,
      globSummary: 'src/**/*.test.ts → 2 files',
      grepSummary: 'TODO in src → 2 matches',
      globEmptySummary: '*.none → no matches',
      globErrorSummary: 'protected/** → failed: permission denied',
      groupGlobTitle: 'Searched 4 patterns',
      groupReadTitle: 'Read 2 items',
    },
  ])(
    'localizes fixed tool labels in $language while keeping raw pattern/path/snippet content',
    ({ language, globSummary, grepSummary, globEmptySummary, globErrorSummary }) => {
      const translator = translatorFor(language);

      const globResult = buildToolPresentation({
        toolUseId: 'g1',
        toolName: 'glob',
        input: { pattern: 'src/**/*.test.ts' },
        output: 'src/a.test.ts\nsrc/b.test.ts',
      }, translator);
      expect(globResult).toMatchObject({
        status: 'success',
        summary: globSummary,
      });
      expect(globResult.details).toEqual([
        { kind: 'path', path: 'src/a.test.ts' },
        { kind: 'path', path: 'src/b.test.ts' },
      ]);

      const grepResult = buildToolPresentation({
        toolUseId: 'p1',
        toolName: 'grep',
        input: { pattern: 'TODO', path: 'src' },
        output: 'src/a.ts:12: TODO fix\nsrc/b.ts:3: TODO test',
      }, translator);
      expect(grepResult.summary).toBe(grepSummary);
      expect(grepResult.details).toEqual([
        { kind: 'snippet', path: 'src/a.ts', line: 12, text: 'TODO fix' },
        { kind: 'snippet', path: 'src/b.ts', line: 3, text: 'TODO test' },
      ]);

      const emptyResult = buildToolPresentation({
        toolUseId: 'g0',
        toolName: 'glob',
        input: { pattern: '*.none' },
        output: '',
      }, translator);
      expect(emptyResult).toMatchObject({
        status: 'empty',
        summary: globEmptySummary,
      });

      const errorResult = buildToolPresentation({
        toolUseId: 'g2',
        toolName: 'glob',
        input: { pattern: 'protected/**' },
        output: 'Error: permission denied',
      }, translator);
      expect(errorResult).toMatchObject({
        status: 'error',
        summary: globErrorSummary,
        errorMessage: 'permission denied',
      });
    },
  );

  it('uses read input as semantic identity and preserves raw file content', () => {
    const result = buildToolPresentation({
      toolUseId: 'r1',
      toolName: 'read_file',
      input: { path: 'src/index.ts', limit: 20 },
      output: '1: import x\n2: export y\n3: https://example.com/docs',
    }, translatorFor('zh-CN'));
    expect(result).toMatchObject({
      status: 'success',
      summary: 'src/index.ts',
    });
    expect(result.details).toEqual([
      { kind: 'text', text: '1: import x\n2: export y\n3: https://example.com/docs' },
    ]);
  });

  it('keeps compact subagent summaries free of renderer glyphs', () => {
    const result = buildToolPresentation({
      toolUseId: 'a1',
      toolName: 'spawn_agent',
      input: { description: '探索项目' },
      output: '[Subagent status=completed]\nDone.',
      durationMs: 5_000,
    }, translatorFor('zh-CN'));

    expect(result).toMatchObject({
      layout: 'compact-completion',
      summary: '子代理 "探索项目" 已完成 · 5 秒',
    });
  });

  it.each([
    { language: 'zh-CN' as const, groupGlobTitle: '搜索了 4 个模式', groupReadTitle: '读取了 2 项' },
    { language: 'en-US' as const, groupGlobTitle: 'Searched 4 patterns', groupReadTitle: 'Read 2 items' },
  ])('normalizes aliases and localizes group titles in $language', ({ language, groupGlobTitle, groupReadTitle }) => {
    const translator = translatorFor(language);

    expect(normalizeToolName('read')).toBe('read_file');
    expect(normalizeToolName('search')).toBe('glob');
    expect(isGroupableTool('read')).toBe(true);
    expect(isGroupableTool('run_bash')).toBe(false);
    expect(buildToolGroupTitle('glob', 4, translator)).toBe(groupGlobTitle);
    expect(buildToolGroupTitle('read_file', 2, translator)).toBe(groupReadTitle);
  });

  it('falls back safely when a presentation builder receives malformed values', () => {
    const result = buildToolPresentation({
      toolUseId: 'bad',
      toolName: 'glob',
      input: { pattern: { unexpected: true } },
      output: 'Error: {"apiKey":"secret","message":"denied"}',
    }, translatorFor('zh-CN'));
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('[object Object]');
  });
});
