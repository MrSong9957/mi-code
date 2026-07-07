// PlanStore：plan 文件落盘与读取
//
// 物理本质：plan 模式产出的"设计图纸"档案柜。
// AI 在 plan 模式用 write_plan_file 把方案写进这里（plan 模式唯一允许写入的目录），
// exit_plan_mode 工具从这里读出方案展示给用户审批。
//
// 目录约定：~/.micode/plans/（与 ConfigStore/SessionStore 同级，用户级跨工作区）
// 文件名约定：<sessionId>-<timestamp>.md（支持同会话多次 plan）

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

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
  private plansDir: string;
  /** 当前会话最近一次写入的 plan 路径（exit_plan_mode 读它） */
  private currentPath: string | null = null;

  constructor(baseDir: string) {
    // baseDir 期望是 ~/.micode；plans 落到 baseDir/plans/
    this.plansDir = join(baseDir, 'plans');
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
    const fileName = `${sessionId}-${Date.now()}.md`;
    const filePath = join(this.plansDir, fileName);
    const body = `---\nsession: ${sessionId}\ncreated: ${createdAt}\nstatus: pending\n---\n\n${content}\n`;
    writeFileSync(filePath, body, 'utf8');
    this.currentPath = filePath;
    return filePath;
  }

  /**
   * 读取最近一次写入的 plan（供 exit_plan_mode 展示）。
   * 没有任何 plan 时返回 null。
   */
  getCurrent(): PlanEntry | null {
    if (!this.currentPath || !existsSync(this.currentPath)) return null;
    const content = readFileSync(this.currentPath, 'utf8');
    const m = content.match(/^---\n[\s\S]*?created:\s*([^\n]+)\n[\s\S]*?\n---/);
    return {
      filePath: this.currentPath,
      content,
      createdAt: m?.[1]?.trim() ?? new Date().toISOString(),
    };
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
}
