// SkillRegistry：管理所有技能（多源、条件激活、预算控制）
//
// 物理本质：图书馆的目录系统。
// 目录卡片（manifest）告诉你有哪些书、每本讲什么。
// 只有你真正需要时，才去书架取书（loadFullText）。

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { SkillManifest, SkillDocument } from './types.js';

/** 上下文预算：技能目录最大字符数（总上下文的 ~1%） */
const CATALOG_BUDGET = 8000;

export class SkillRegistry {
  private skills = new Map<string, SkillDocument>();

  /** 从单个目录加载技能 */
  loadFromDir(dir: string, source: SkillManifest['source'] = 'project'): void {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      try {
        const content = readFileSync(skillFile, 'utf8');
        const { meta, body } = parseFrontmatter(content);
        const name = meta.name || entry.name;
        this.skills.set(name, {
          manifest: {
            name,
            description: meta.description || '',
            paths: meta.paths ? parseList(meta.paths) : undefined,
            context: (meta.context as 'fork' | 'main') || 'main',
            allowedTools: meta.allowedTools ? parseList(meta.allowedTools) : undefined,
            source,
          },
          body,
        });
      } catch { /* skip */ }
    }
  }

  /** 多源加载：从多个目录聚合技能 */
  loadFromSources(sources: { dir: string; source: SkillManifest['source'] }[]): void {
    for (const { dir, source } of sources) {
      this.loadFromDir(dir, source);
    }
  }

  /** 注册单个技能 */
  register(name: string, description: string, body: string, extra?: Partial<SkillManifest>): void {
    this.skills.set(name, {
      manifest: { name, description, source: 'project', ...extra },
      body,
    });
  }

  /** 返回技能目录（预算控制：限制在 CATALOG_BUDGET 字符内） */
  describeAvailable(): string {
    if (this.skills.size === 0) return 'No skills available.';

    const lines = ['Skills available:'];
    let totalLength = lines[0]!.length;

    for (const [name, doc] of this.skills) {
      const line = `- ${name}: ${doc.manifest.description}`;
      if (totalLength + line.length + 1 > CATALOG_BUDGET) {
        lines.push(`... and ${this.skills.size - lines.length + 1} more skills`);
        break;
      }
      lines.push(line);
      totalLength += line.length + 1;
    }
    return lines.join('\n');
  }

  /** 条件激活：根据文件路径返回自动激活的技能 */
  getAutoActivated(filePaths: string[]): SkillDocument[] {
    const activated: SkillDocument[] = [];
    for (const doc of this.skills.values()) {
      if (!doc.manifest.paths?.length) continue;
      const matches = filePaths.some(fp =>
        doc.manifest.paths!.some(pattern => matchPattern(pattern, fp))
      );
      if (matches) activated.push(doc);
    }
    return activated;
  }

  /** 加载某个技能的完整内容 */
  loadFullText(name: string): string {
    const doc = this.skills.get(name);
    if (!doc) return `Error: Skill "${name}" not found.`;
    return `# ${doc.manifest.name}\n\n${doc.manifest.description}\n\n${doc.body}`;
  }

  /** 获取 fork 上下文的技能 */
  getForkSkills(): SkillDocument[] {
    return Array.from(this.skills.values()).filter(d => d.manifest.context === 'fork');
  }

  /** 获取技能的工具白名单 */
  getAllowedTools(name: string): string[] | undefined {
    return this.skills.get(name)?.manifest.allowedTools;
  }

  /** 获取单个技能文档 */
  get(name: string): SkillDocument | undefined {
    return this.skills.get(name);
  }

  getNames(): string[] { return Array.from(this.skills.keys()); }
  get size(): number { return this.skills.size; }
}

/** 解析 frontmatter */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta, body: content };

  const frontmatter = match[1]!;
  const body = match[2]!.trim();

  for (const line of frontmatter.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    meta[key] = value;
  }

  return { meta, body };
}

/** 解析逗号分隔的列表 */
function parseList(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/** 简单的通配符匹配（*.ext） */
function matchPattern(pattern: string, path: string): boolean {
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    return path.endsWith(ext);
  }
  return path.includes(pattern);
}
