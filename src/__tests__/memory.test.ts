// MemoryManager 测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryManager } from '../memory/memory-manager.js';

describe('MemoryManager', () => {
  let workDir: string;
  let mem: MemoryManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mem = new MemoryManager(workDir);
  });

  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('write: 写入记忆 + 重建索引', () => {
    const entry = mem.write('tabs', 'user', 'Prefers tabs', 'Always use tabs.');
    expect(entry.slug).toBe('tabs');
    expect(existsSync(join(workDir, '.memory', 'tabs.md'))).toBe(true);
    expect(readFileSync(join(workDir, '.memory', 'MEMORY.md'), 'utf8')).toContain('tabs');
  });

  it('list: 返回所有记忆', () => {
    mem.write('a', 'user', 'A', 'Body A');
    mem.write('b', 'feedback', 'B', 'Body B');
    expect(mem.list()).toHaveLength(2);
  });

  it('read: 读取内容', () => {
    mem.write('pref', 'user', 'My pref', 'Use single quotes.');
    expect(mem.read('pref')).toContain('Use single quotes.');
  });

  it('read: 不存在返回 null', () => { expect(mem.read('nope')).toBeNull(); });

  it('delete: 删除记忆', () => {
    mem.write('del', 'project', 'Delete me', 'Body');
    expect(mem.delete('del')).toBe(true);
    expect(mem.list()).toHaveLength(0);
  });

  it('getIndexContent: 返回索引', () => {
    mem.write('test', 'user', 'Test', 'Body');
    expect(mem.getIndexContent()).toContain('Memory Catalog');
  });

  it('selectByKeywords: 关键词匹配', () => {
    mem.write('tabs', 'user', 'Tab preference', 'Body');
    mem.write('docker', 'project', 'Docker setup', 'Body');
    expect(mem.selectByKeywords('tabs indentation')).toContain('tabs');
  });

  it('inject: 生成借调内容', () => {
    mem.write('mem', 'user', 'Test', 'Body here.');
    const injected = mem.inject(['mem']);
    expect(injected).toContain('borrowed-memory');
    expect(injected).toContain('Body here.');
  });

  it('needsConsolidation: 达到阈值返回 true', () => {
    for (let i = 0; i < 10; i++) mem.write(`m${i}`, 'project', `M${i}`, `B${i}`);
    expect(mem.needsConsolidation()).toBe(true);
  });
});
