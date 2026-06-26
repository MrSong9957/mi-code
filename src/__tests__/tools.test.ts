// 工具测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { safePath, setWorkdir, getWorkdir } from '../agent/tools/path-sandbox.js';
import { createReadFileTool, createWriteFileTool, createEditFileTool } from '../agent/tools/file-tools.js';

describe('Path Sandbox', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-test-'));
    setWorkdir(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should allow paths inside workspace', () => {
    const result = safePath('test.txt');
    expect(result).toBe(join(tempDir, 'test.txt'));
  });

  it('should allow nested paths inside workspace', () => {
    const result = safePath('subdir/test.txt');
    expect(result).toBe(join(tempDir, 'subdir', 'test.txt'));
  });

  it('should block path traversal escape', () => {
    expect(() => safePath('../escape.txt')).toThrow('Path escapes workspace');
  });

  it('should block absolute path escape', () => {
    expect(() => safePath('/etc/passwd')).toThrow('Path escapes workspace');
  });

  it('should return current workdir', () => {
    expect(getWorkdir()).toBe(tempDir);
  });
});

describe('read_file Tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-test-'));
    setWorkdir(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should read file content', async () => {
    const filePath = join(tempDir, 'test.txt');
    writeFileSync(filePath, 'Hello, World!', 'utf8');

    const tool = createReadFileTool();
    const result = await tool.executor({ path: 'test.txt' });

    expect(result).toBe('Hello, World!');
  });

  it('should limit lines when specified', async () => {
    const filePath = join(tempDir, 'test.txt');
    writeFileSync(filePath, 'Line 1\nLine 2\nLine 3\nLine 4', 'utf8');

    const tool = createReadFileTool();
    const result = await tool.executor({ path: 'test.txt', limit: 2 });

    expect(result).toBe('Line 1\nLine 2');
  });

  it('should throw for path escape', async () => {
    const tool = createReadFileTool();
    await expect(tool.executor({ path: '../escape.txt' })).rejects.toThrow('Path escapes workspace');
  });
});

describe('write_file Tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-test-'));
    setWorkdir(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write file content', async () => {
    const tool = createWriteFileTool();
    const result = await tool.executor({ path: 'test.txt', content: 'Hello!' });

    expect(result).toBe('File written: test.txt');
    expect(readFileSync(join(tempDir, 'test.txt'), 'utf8')).toBe('Hello!');
  });

  it('should create parent directories', async () => {
    const tool = createWriteFileTool();
    await tool.executor({ path: 'sub/dir/test.txt', content: 'Nested' });

    expect(readFileSync(join(tempDir, 'sub', 'dir', 'test.txt'), 'utf8')).toBe('Nested');
  });

  it('should throw for path escape', async () => {
    const tool = createWriteFileTool();
    await expect(tool.executor({ path: '../escape.txt', content: 'Bad' })).rejects.toThrow('Path escapes workspace');
  });
});

describe('edit_file Tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-test-'));
    setWorkdir(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should replace text in file', async () => {
    const filePath = join(tempDir, 'test.txt');
    writeFileSync(filePath, 'Hello, World!', 'utf8');

    const tool = createEditFileTool();
    const result = await tool.executor({
      path: 'test.txt',
      old_text: 'World',
      new_text: 'TypeScript',
    });

    expect(result).toBe('File edited: test.txt');
    expect(readFileSync(filePath, 'utf8')).toBe('Hello, TypeScript!');
  });

  it('should return error when old_text not found', async () => {
    const filePath = join(tempDir, 'test.txt');
    writeFileSync(filePath, 'Hello, World!', 'utf8');

    const tool = createEditFileTool();
    const result = await tool.executor({
      path: 'test.txt',
      old_text: 'NotFound',
      new_text: 'Replacement',
    });

    expect(result).toContain('Error: old_text not found');
  });

  it('should throw for path escape', async () => {
    const tool = createEditFileTool();
    await expect(
      tool.executor({ path: '../escape.txt', old_text: 'a', new_text: 'b' }),
    ).rejects.toThrow('Path escapes workspace');
  });
});
