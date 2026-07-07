// glob / grep 工具测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setWorkdir } from '../agent/tools/path-sandbox.js';
import { createGlobTool, createGrepTool } from '../agent/tools/search-tools.js';

describe('glob Tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-glob-'));
    setWorkdir(tempDir);
    // 造一棵小树
    mkdirSync(join(tempDir, 'src'));
    mkdirSync(join(tempDir, 'src', 'sub'));
    writeFileSync(join(tempDir, 'a.ts'), 'export const a = 1;', 'utf8');
    writeFileSync(join(tempDir, 'b.md'), '# b', 'utf8');
    writeFileSync(join(tempDir, 'src', 'c.ts'), 'export const c = 3;', 'utf8');
    writeFileSync(join(tempDir, 'src', 'sub', 'd.ts'), 'export const d = 4;', 'utf8');
    // 排除 node_modules（即使不存在也造一个占位）
    mkdirSync(join(tempDir, 'node_modules'));
    writeFileSync(join(tempDir, 'node_modules', 'dep.ts'), 'x', 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('matches files by extension across the tree', async () => {
    const tool = createGlobTool();
    const result = (await tool.executor({ pattern: '**/*.ts' })) as string;
    const lines = result.split('\n').filter(Boolean);
    expect(lines).toContain('a.ts');
    expect(lines).toContain('src/c.ts');
    expect(lines).toContain('src/sub/d.ts');
  });

  it('matches files under a specific path', async () => {
    const tool = createGlobTool();
    const result = (await tool.executor({ pattern: 'src/**/*.ts' })) as string;
    const lines = result.split('\n').filter(Boolean);
    expect(lines).toContain('src/c.ts');
    expect(lines).toContain('src/sub/d.ts');
    expect(lines).not.toContain('a.ts');
  });

  it('matches a single-level wildcard', async () => {
    const tool = createGlobTool();
    const result = (await tool.executor({ pattern: '*.md' })) as string;
    const lines = result.split('\n').filter(Boolean);
    expect(lines).toContain('b.md');
    expect(lines).not.toContain('a.ts');
  });

  it('excludes node_modules by default', async () => {
    const tool = createGlobTool();
    const result = (await tool.executor({ pattern: '**/*.ts' })) as string;
    expect(result).not.toContain('node_modules');
  });

  it('returns relative paths, not absolute', async () => {
    const tool = createGlobTool();
    const result = (await tool.executor({ pattern: '**/*.ts' })) as string;
    expect(result).not.toContain(tempDir);
  });

  it('returns empty when no match', async () => {
    const tool = createGlobTool();
    const result = (await tool.executor({ pattern: '**/*.nonexistent' })) as string;
    expect(result.trim()).toBe('');
  });
});

describe('grep Tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-grep-'));
    setWorkdir(tempDir);
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'a.ts'), 'const x = 1;\n// TODO: refactor this\nexport const y = 2;\n', 'utf8');
    writeFileSync(join(tempDir, 'src', 'b.ts'), 'const z = 3;\nconsole.log("hello TODO world");\n', 'utf8');
    writeFileSync(join(tempDir, 'c.md'), '# Nothing here\n', 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds matches across the workspace', async () => {
    const tool = createGrepTool();
    const result = (await tool.executor({ pattern: 'TODO' })) as string;
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
  });

  it('reports file path and line number', async () => {
    const tool = createGrepTool();
    const result = (await tool.executor({ pattern: 'TODO' })) as string;
    // a.ts 第 2 行
    expect(result).toMatch(/a\.ts:\s*2/);
    // b.ts 第 2 行
    expect(result).toMatch(/src\/b\.ts:\s*2/);
  });

  it('includes the matching line text', async () => {
    const tool = createGrepTool();
    const result = (await tool.executor({ pattern: 'TODO' })) as string;
    expect(result).toContain('// TODO: refactor this');
    expect(result).toContain('console.log("hello TODO world")');
  });

  it('scopes search to a specific path', async () => {
    const tool = createGrepTool();
    const result = (await tool.executor({ pattern: 'TODO', path: 'src' })) as string;
    expect(result).toContain('src/b.ts');
    expect(result).not.toContain('a.ts:');
  });

  it('supports regex patterns', async () => {
    const tool = createGrepTool();
    const result = (await tool.executor({ pattern: 'const \\w+ = \\d+' })) as string;
    expect(result).toContain('a.ts');
    expect(result).toContain('const x = 1');
    expect(result).toContain('const z = 3');
  });

  it('returns empty when no match', async () => {
    const tool = createGrepTool();
    const result = (await tool.executor({ pattern: 'NOTHING_MATCHES_THIS_XYZ' })) as string;
    expect(result.trim()).toBe('');
  });
});
