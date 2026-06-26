// MemoryManager：跨会话持久化记忆
//
// 物理本质：随身笔记本。
// 压缩会丢细节，记忆不会。
// 写到磁盘 → 下次会话还能读到。

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  name: string;
  type: MemoryType;
  description: string;
  body: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
}

export class MemoryManager {
  private dir: string;

  constructor(baseDir: string = '.memory') {
    this.dir = baseDir;
    mkdirSync(this.dir, { recursive: true });
  }

  /** 写入记忆文件 */
  write(name: string, type: MemoryType, description: string, body: string): void {
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    const filepath = join(this.dir, `${slug}.md`);
    const now = Date.now();

    const content = [
      '---',
      `name: ${name}`,
      `type: ${type}`,
      `description: ${description}`,
      `created: ${now}`,
      `updated: ${now}`,
      '---',
      '',
      body,
    ].join('\n');

    writeFileSync(filepath, content, 'utf8');
    this.rebuildIndex();
  }

  /** 读取记忆文件 */
  read(slug: string): MemoryEntry | null {
    const filepath = join(this.dir, `${slug}.md`);
    if (!existsSync(filepath)) return null;
    return this.parseFile(readFileSync(filepath, 'utf8'), slug);
  }

  /** 列出所有记忆 */
  list(): MemoryEntry[] {
    const files = readdirSync(this.dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    return files.map(f => this.read(f.replace('.md', ''))).filter((e): e is MemoryEntry => e !== null);
  }

  /** 删除记忆 */
  delete(slug: string): boolean {
    const filepath = join(this.dir, `${slug}.md`);
    if (!existsSync(filepath)) return false;
    unlinkSync(filepath);
    this.rebuildIndex();
    return true;
  }

  /** 重建索引文件 */
  private rebuildIndex(): void {
    const entries = this.list();
    const lines = ['# Memory Catalog', ''];
    for (const e of entries) lines.push(`- [${e.name}](./${e.slug}.md) — ${e.description}`);
    writeFileSync(join(this.dir, 'MEMORY.md'), lines.join('\n'), 'utf8');
  }

  /** 获取索引内容（注入 system prompt） */
  getIndex(): string {
    const indexFile = join(this.dir, 'MEMORY.md');
    if (!existsSync(indexFile)) return 'No memories recorded yet.';
    return readFileSync(indexFile, 'utf8');
  }

  /** 获取记忆摘要（轻量级） */
  getSummary(): string {
    const entries = this.list();
    if (entries.length === 0) return '';
    const lines = ['Long-term memory:'];
    for (const e of entries) lines.push(`- ${e.name} (${e.type}): ${e.description}`);
    return lines.join('\n');
  }

  /** 解析记忆文件 */
  private parseFile(content: string, slug: string): MemoryEntry | null {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const meta: Record<string, string> = {};
    for (const line of match[1]!.split('\n')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      meta[line.slice(0, colonIndex).trim()] = line.slice(colonIndex + 1).trim();
    }

    return {
      name: meta.name || slug,
      type: (meta.type as MemoryType) || 'reference',
      description: meta.description || '',
      body: match[2]!.trim(),
      slug,
      createdAt: parseInt(meta.created) || Date.now(),
      updatedAt: parseInt(meta.updated) || Date.now(),
    };
  }
}
