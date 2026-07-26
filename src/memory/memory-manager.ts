// MemoryManager：文件记忆库
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { writeFile, readFile, rename, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { freezeSnapshot } from '../agent/contracts/identities.js';
import type { MemoryEntry, MemoryIndexEntry, MemoryType } from './types.js';
import type {
  MemoryPersistenceRecord,
  DurableCommitAcknowledgement,
} from './persistence.js';
import type {
  MemoryCatalogSnapshot,
  MemoryCatalogEntry,
} from './catalog.js';

const CONSOLIDATE_THRESHOLD = 10;
const MAX_INJECT = 5;

export class MemoryManager {
  private memoryDir: string;
  /**
   * governed detail records 目录(.records/),独立于根目录 list()。
   *
   * ERC-2 §8.4-4 / INV-E7:detail commit 后、index commit 前,record 处于不可发现状态。
   * 把 detail 写入 `.memory/.records/` 而不是根 `.memory/`,根 list() 只扫描根目录的
   * `*.md`(不递归),因此 detail 在 index commit 前不可由 governed catalog 发现。
   */
  private recordsDir: string;
  /**
   * governed catalog 目录(.catalog/),存放 selector 唯一可见的不可变 snapshot。
   *
   * snapshot.json 是 governed catalog 的正式视图。selector(M-046)从这里 loadSnapshot(),
   * 不会扫描 .records/ —— 因此 detail/index 两阶段可发现性边界由目录隔离保证。
   */
  private catalogDir: string;
  /** 内存缓存:最近一次写入的 snapshot(简化 find 实现,避免每次 load 都读盘)。 */
  private catalogCache: MemoryCatalogSnapshot | null = null;

  constructor(workDir: string) {
    this.memoryDir = join(workDir, '.memory');
    this.recordsDir = join(this.memoryDir, '.records');
    this.catalogDir = join(this.memoryDir, '.catalog');
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

  // =========================================================================
  // ERC-2 / M-045 governed primitives (Wave E Task 4)
  //
  // detail commit 写入独立目录 `.memory/.records/`,不进入根目录 list()。
  // 因此 index commit 前 detail 不可由 governed catalog 发现 (INV-E7)。
  //
  // writeGovernedDetail 使用 temp file + same-directory rename 实现原子性:
  //   1. 先写 `<record_id>.json.tmp` (含 random suffix 防并发碰撞)
  //   2. rename 到 `<record_id>.json`(同目录 rename 在 POSIX/Win32 上原子)
  //   3. ack 只在 write/flush/rename 全部完成后产生 (§6.3)
  //
  // 这些方法 *不* 调用 selector、*不* 更新正式 catalog、*不* 重建 MEMORY.md。
  // =========================================================================

  /**
   * 把 admitted record 写入 governed detail 存储。
   *
   * @returns DurableCommitAcknowledgement —— 仅在 write/flush/rename 全部完成后产生。
   *          detail_commit_ref = memory_record_id(按 record 寻址,内容寻址由上层负责)。
   */
  async writeGovernedDetail(record: MemoryPersistenceRecord): Promise<DurableCommitAcknowledgement> {
    // 确保 .records/ 目录存在(惰性创建,避免在构造期就建空目录)
    await mkdir(this.recordsDir, { recursive: true });

    const finalPath = join(this.recordsDir, `${record.memory_record_id}.json`);
    // random suffix 防止并发写入同名 record 时的 tmp 碰撞
    const tmpPath = join(this.recordsDir, `${record.memory_record_id}.${randomBytes(6).toString('hex')}.json.tmp`);

    // 1. 写 temp file(deterministic JSON,key 排序)
    const serialized = JSON.stringify(record, null, 2);
    await writeFile(tmpPath, serialized, 'utf8');

    // 2. 同目录 rename(原子)。失败时清理 tmp,避免遗留。
    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      // 尽力清理 tmp;忽略清理自身的错误,把 rename 错误上抛。
      try { await unlinkQuiet(tmpPath); } catch { /* swallow cleanup error */ }
      throw err;
    }

    // 3. durable acknowledgement —— 只在 write/flush/rename 完成后产生 (§6.3)
    return {
      detail_commit_ref: record.memory_record_id,
      memory_record_id: record.memory_record_id,
      record_version: record.record_version,
      committed_at: new Date().toISOString(),
    };
  }

  /**
   * 按 ref(memory_record_id)读取 detail 原文。
   * 不存在时返回 null(不抛错)。
   */
  async readGovernedDetail(ref: string): Promise<string | null> {
    const filePath = join(this.recordsDir, `${ref}.json`);
    try {
      return await readFile(filePath, 'utf8');
    } catch (err) {
      // ENOENT → null;其它错误上抛(避免吞掉真实 I/O 故障)
      if (isNodeError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // =========================================================================
  // ERC-2 / M-045 governed catalog primitives (Wave E Task 5)
  //
  // catalog snapshot 写入独立目录 `.memory/.catalog/`,与 `.records/` 物理隔离。
  // selector(M-046)只 loadSnapshot(),不扫描 .records/ ——
  // 因此 detail 在 catalog commit 前不可由 governed catalog 发现 (INV-E7)。
  //
  // writeGovernedCatalog 使用 temp file + same-directory rename 实现原子性:
  //   1. 先写 `snapshot.json.tmp`(含 random suffix 防并发碰撞)
  //   2. rename 到 `snapshot.json`(同目录 rename 在 POSIX/Win32 上原子)
  //   3. 写入成功后更新内存缓存,find() 直接走缓存避免 I/O
  // =========================================================================

  /**
   * 把 governed catalog snapshot 原子写入磁盘。
   * 写成功后更新内存缓存,使 find() 立即可见。
   */
  async writeGovernedCatalog(snapshot: MemoryCatalogSnapshot): Promise<void> {
    await mkdir(this.catalogDir, { recursive: true });

    const finalPath = join(this.catalogDir, 'snapshot.json');
    const tmpPath = join(
      this.catalogDir,
      `snapshot.${randomBytes(6).toString('hex')}.json.tmp`,
    );

    const serialized = JSON.stringify(snapshot, null, 2);
    await writeFile(tmpPath, serialized, 'utf8');

    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      try {
        await unlinkQuiet(tmpPath);
      } catch {
        /* swallow cleanup error */
      }
      throw err;
    }

    // 写入成功后更新缓存,使 find() 不依赖读盘。
    // 注意:缓存值是从入参 snapshot 直接引用 —— snapshot 已 frozen,无 aliasing 风险。
    this.catalogCache = snapshot;
  }

  /**
   * 加载 governed catalog snapshot。无 snapshot 返回 null。
   *
   * 优先用内存缓存(本实例刚写入过的);否则读盘。
   * 读盘成功后解析并冻结返回(snapshot 写入时已 frozen,但读盘结果是新对象,
   * 需要重新冻结以维持调用方不可变契约)。
   */
  async readGovernedCatalog(): Promise<MemoryCatalogSnapshot | null> {
    if (this.catalogCache !== null) {
      return this.catalogCache;
    }
    const filePath = join(this.catalogDir, 'snapshot.json');
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
    const parsed = JSON.parse(raw) as MemoryCatalogSnapshot;
    // 重新冻结,确保调用方拿到的对象不可变。
    // freezeSnapshot 是递归深冻结,适用于嵌套 snapshot 结构。
    return freezeSnapshot(parsed) as MemoryCatalogSnapshot;
  }

  /**
   * 在 governed catalog snapshot 中查找某 memory_record_id 的 entry。
   * 不存在返回 null(不抛错)。
   *
   * 这是 MemoryManager 实现 GovernedCatalogStore 接口的方法。
   */
  async findGovernedCatalogEntry(memory_record_id: string): Promise<MemoryCatalogEntry | null> {
    const snap = await this.readGovernedCatalog();
    if (snap === null) return null;
    for (const e of snap.entries) {
      if (e.memory_record_id === memory_record_id) return e;
    }
    return null;
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

// ─── helpers (module-private) ─────────────────────────────────────────────

/** Node 错误形状判断(用于 ENOENT 检测)。 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

/** 静默删除 tmp file(清理路径,失败不抛)。 */
async function unlinkQuiet(path: string): Promise<void> {
  const { unlink } = await import('fs/promises');
  await unlink(path);
}
