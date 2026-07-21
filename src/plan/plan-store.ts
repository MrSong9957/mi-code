// PlanStore：plan 文件落盘与读取
//
// 物理本质：plan 模式产出的"设计图纸"档案柜。
// AI 在 plan 模式用 write_plan_file 把方案写进这里（plan 模式唯一允许写入的目录），
// exit_plan_mode 工具从这里读出方案展示给用户审批。
//
// 目录约定：~/.micode/plans/（与 ConfigStore/SessionStore 同级，用户级跨工作区）
//          可由 config.plansDirectory 覆盖（绝对路径或相对 cwd 的路径）。
// 文件名约定：<sessionId>-<6hex>.md（randomBytes(3) 产生的 slug，支持同会话多次 plan）

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { randomBytes } from 'crypto';

/** 一份 plan 的元数据 + 内容 */
export interface PlanEntry {
  /** 落盘的绝对路径 */
  filePath: string;
  /** plan 正文（含 frontmatter） */
  content: string;
  /** 创建时间 ISO */
  createdAt: string;
}

export class PlanStore {
  private static readonly CLEANUP_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

  private plansDir: string;
  /** 当前会话最近一次写入的 plan 路径（exit_plan_mode 读它） */
  private currentPath: string | null = null;

  constructor(baseDir: string, plansDirOverride?: string) {
    // baseDir 期望是 ~/.micode；plans 默认落到 baseDir/plans/
    // plansDirOverride 可用 config.plansDirectory 覆盖（绝对路径或相对 cwd 的路径）
    this.plansDir = plansDirOverride
      ? (isAbsolute(plansDirOverride) ? plansDirOverride : resolve(process.cwd(), plansDirOverride))
      : join(baseDir, 'plans');
    mkdirSync(this.plansDir, { recursive: true });
  }

  /** plans 目录绝对路径（供 PermissionChecker 设置 planDir 白名单） */
  getPlansDir(): string {
    return this.plansDir;
  }

  /**
   * 写一份 plan 到磁盘。
   *
   * @param sessionId 当前会话 id（用于文件名前缀）
   * @param content   plan 正文（用户的方案文本）
   * @returns 落盘的文件绝对路径
   */
  write(sessionId: string, content: string): string {
    const createdAt = new Date().toISOString();
    const fileName = `${sessionId}-${randomBytes(3).toString('hex')}.md`;
    const filePath = join(this.plansDir, fileName);
    const body = `---\nsession: ${sessionId}\ncreated: ${createdAt}\nstatus: pending\n---\n\n${content}\n`;
    writeFileSync(filePath, body, 'utf8');
    this.currentPath = filePath;
    // 惰性清理：每次写入时顺便回收过期 plan 文件
    this.cleanupOldPlans();
    return filePath;
  }

  /**
   * 读取最近一次写入的 plan（供 exit_plan_mode 展示）。
   * currentPath 丢失时从目录恢复最新 plan 文件。
   * 没有任何 plan 时返回 null。
   */
  getCurrent(): PlanEntry | null {
    // 1. 优先读 currentPath
    if (this.currentPath && existsSync(this.currentPath)) {
      return this.readPlanFile(this.currentPath);
    }
    // 2. currentPath 丢失 → 从目录恢复最新的 plan 文件
    const latest = this.findLatestPlan();
    if (latest) {
      this.currentPath = latest;
      return this.readPlanFile(latest);
    }
    return null;
  }

  /** 标记当前 plan 已批准/已拒绝（更新 frontmatter status） */
  setStatus(status: 'approved' | 'rejected'): void {
    if (!this.currentPath || !existsSync(this.currentPath)) return;
    const content = readFileSync(this.currentPath, 'utf8');
    // ^...m 多行模式下锚定行首，只动 frontmatter 中首个 status: 行，
    // 防止 plan 正文里的 "status: xxx" 字样被误改。
    const updated = content.replace(/^(status:\s*)\w+/m, `$1${status}`);
    writeFileSync(this.currentPath, updated, 'utf8');
  }

  /** 清理超过 30 天的 plan 文件。写时惰性触发。 */
  private cleanupOldPlans(): void {
    try {
      const cutoff = Date.now() - PlanStore.CLEANUP_AGE_MS;
      const files = readdirSync(this.plansDir).filter(f => f.endsWith('.md'));
      for (const f of files) {
        const fp = join(this.plansDir, f);
        const stat = statSync(fp);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(fp);
        }
      }
    } catch { /* 静默容错 */ }
  }

  /** 扫描 plans 目录，返回 mtime 最新的 plan 文件路径（无文件返回 null） */
  private findLatestPlan(): string | null {
    try {
      const files = readdirSync(this.plansDir).filter(f => f.endsWith('.md'));
      if (files.length === 0) return null;
      let latest: { path: string; mtime: number } | null = null;
      for (const f of files) {
        const fp = join(this.plansDir, f);
        const mtime = statSync(fp).mtimeMs;
        if (!latest || mtime > latest.mtime) {
          latest = { path: fp, mtime };
        }
      }
      return latest?.path ?? null;
    } catch { return null; }
  }

  /** 从指定路径读取 plan 文件并解析 frontmatter 中的 created 字段 */
  private readPlanFile(filePath: string): PlanEntry {
    const content = readFileSync(filePath, 'utf8');
    const m = content.match(/^---\n[\s\S]*?created:\s*([^\n]+)\n[\s\S]*?\n---/);
    return {
      filePath,
      content,
      createdAt: m?.[1]?.trim() ?? new Date().toISOString(),
    };
  }
}
