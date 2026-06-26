// MemoryManager：文件记忆库
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { MemoryEntry, MemoryIndexEntry, MemoryType } from './types.js';

const CONSOLIDATE_THRESHOLD = 10;
const MAX_INJECT = 5;

export class MemoryManager {
  private memoryDir: string;

  constructor(workDir: string) {
    this.memoryDir = join(workDir, '.memory');
    mkdirSync(this.memoryDir, { recursive: true });
  }

  private toSlug(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  }

  write(name: string, type: MemoryType, description: string, body: string): MemoryEntry {
    const slug = this.toSlug(name);
    const filepath = join(this.memoryDir, `${slug}.md`);
    const content = `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`;
    writeFileSync(filepath, content, 'utf8');
    this.rebuildIndex();
    return { name, type, description, body, slug, createdAt: new Date().toISOString() };
  }

  list(): MemoryIndexEntry[] {
    return this.getMemoryFiles().map(f => this.parseFrontmatter(f));
  }

  read(slug: string): string | null {
    const filepath = join(this.memoryDir, `${slug}.md`);
    return existsSync(filepath) ? readFileSync(filepath, 'utf8') : null;
  }

  delete(slug: string): boolean {
    const filepath = join(this.memoryDir, `${slug}.md`);
    if (!existsSync(filepath)) return false;
    unlinkSync(filepath);
    this.rebuildIndex();
    return true;
  }

  rebuildIndex(): void {
    const entries = this.list();
    const lines = ['# Memory Catalog\n'];
    for (const e of entries) lines.push(`- [${e.name}](./${e.slug}.md) — ${e.description}`);
    writeFileSync(join(this.memoryDir, 'MEMORY.md'), lines.join('\n'), 'utf8');
  }

  getIndexContent(): string {
    const indexPath = join(this.memoryDir, 'MEMORY.md');
    return existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : 'No memories recorded yet.';
  }

  selectByKeywords(keywords: string): string[] {
    const entries = this.list();
    if (entries.length === 0) return [];
    const lower = keywords.toLowerCase();
    return entries
      .filter(e => lower.includes(e.slug) || lower.includes(e.name.toLowerCase()) || e.description.toLowerCase().includes(lower.split(' ')[0]))
      .map(e => e.slug)
      .slice(0, MAX_INJECT);
  }

  inject(slugs: string[]): string {
    const parts: string[] = [];
    for (const slug of slugs.slice(0, MAX_INJECT)) {
      const content = this.read(slug);
      if (content) parts.push(`<borrowed-memory slug='${slug}'>\n${content}\n</borrowed-memory>`);
    }
    return parts.join('\n');
  }

  needsConsolidation(): boolean {
    return this.list().length >= CONSOLIDATE_THRESHOLD;
  }

  private getMemoryFiles(): string[] {
    if (!existsSync(this.memoryDir)) return [];
    return readdirSync(this.memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').sort();
  }

  private parseFrontmatter(filename: string): MemoryIndexEntry {
    const content = readFileSync(join(this.memoryDir, filename), 'utf8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { slug: filename.replace('.md', ''), name: filename, type: 'project', description: '' };
    const meta = match[1];
    return {
      slug: filename.replace('.md', ''),
      name: meta.match(/name:\s*(.+)/)?.[1]?.trim() || filename,
      type: (meta.match(/type:\s*(.+)/)?.[1]?.trim() as MemoryType) || 'project',
      description: meta.match(/description:\s*(.+)/)?.[1]?.trim() || '',
    };
  }
}
