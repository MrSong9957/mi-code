// WorktreeManager：管理 git worktree 的创建、绑定、移除和恢复
//
// 物理本质：快递中转站的台账管理员。
// 每来一个快递（任务），就在一个独立的货架（worktree 目录）上贴标签。
// 台账（index.json）记录每个货架的位置和归属。
// 事件流水账（events.jsonl）记录每一次收发动作。
// 即使中转站停电（进程崩溃），来电后看台账就能恢复现场。

import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { WorktreeRecord, WorktreeEvent } from './types.js';

/** 只允许字母、数字、连字符、下划线（防命令注入） */
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export class WorktreeManager {
  private repoRoot: string;
  private worktreesDir: string;
  private indexPath: string;
  private eventsPath: string;
  private records: WorktreeRecord[] = [];

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.worktreesDir = join(repoRoot, '.worktrees');
    this.indexPath = join(this.worktreesDir, 'index.json');
    this.eventsPath = join(this.worktreesDir, 'events.jsonl');
    mkdirSync(this.worktreesDir, { recursive: true });
    this.loadIndex();
  }

  /** 从磁盘加载索引 */
  private loadIndex(): void {
    if (existsSync(this.indexPath)) {
      try {
        this.records = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      } catch {
        this.records = [];
      }
    }
  }

  /** 持久化索引到磁盘 */
  private saveIndex(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.records, null, 2), 'utf8');
  }

  /** 追加一条事件到 events.jsonl */
  private writeEvent(event: WorktreeEvent): void {
    const line = JSON.stringify(event) + '\n';
    const existing = existsSync(this.eventsPath)
      ? readFileSync(this.eventsPath, 'utf8')
      : '';
    writeFileSync(this.eventsPath, existing + line, 'utf8');
  }

  /** 创建 worktree 并绑定任务 */
  create(name: string, taskId: string): WorktreeRecord {
    if (!SAFE_NAME_RE.test(name)) {
      throw new Error(`Worktree name "${name}" contains invalid characters (use alphanumeric, hyphens, underscores)`);
    }
    if (!SAFE_NAME_RE.test(taskId)) {
      throw new Error(`Task ID "${taskId}" contains invalid characters`);
    }
    if (this.records.find(r => r.name === name)) {
      throw new Error(`Worktree "${name}" already exists`);
    }

    const branch = `wt/${name}`;
    const wtPath = join(this.worktreesDir, name);

    execSync(`git worktree add -b "${branch}" "${wtPath}" HEAD`, {
      cwd: this.repoRoot,
      stdio: 'ignore',
    });

    const record: WorktreeRecord = {
      name,
      branch,
      path: wtPath,
      taskId,
      createdAt: new Date().toISOString(),
    };

    this.records.push(record);
    this.saveIndex();

    this.writeEvent({ ts: record.createdAt, type: 'created', name });
    this.writeEvent({ ts: record.createdAt, type: 'bound', name, taskId });

    return record;
  }

  /** 移除 worktree */
  remove(name: string): void {
    const idx = this.records.findIndex(r => r.name === name);
    if (idx === -1) {
      throw new Error(`Worktree "${name}" not found`);
    }

    const record = this.records[idx];
    execSync(`git worktree remove "${record.path}"`, {
      cwd: this.repoRoot,
      stdio: 'ignore',
    });

    this.records.splice(idx, 1);
    this.saveIndex();

    this.writeEvent({ ts: new Date().toISOString(), type: 'removed', name });
  }

  /** 标记保留（不移除目录） */
  keep(name: string): void {
    const record = this.records.find(r => r.name === name);
    if (!record) {
      throw new Error(`Worktree "${name}" not found`);
    }

    this.writeEvent({ ts: new Date().toISOString(), type: 'kept', name });
  }

  /** 按任务 ID 查 worktree */
  getByTask(taskId: string): WorktreeRecord | null {
    return this.records.find(r => r.taskId === taskId) ?? null;
  }

  /** 按名称查 worktree */
  getByName(name: string): WorktreeRecord | null {
    return this.records.find(r => r.name === name) ?? null;
  }

  /** 列出所有 worktree 记录 */
  list(): WorktreeRecord[] {
    return [...this.records];
  }

  /** 绑定已有 worktree 到任务（不改变任务状态） */
  bind(name: string, taskId: string): WorktreeRecord {
    const record = this.records.find(r => r.name === name);
    if (!record) throw new Error(`Worktree "${name}" not found`);
    record.taskId = taskId;
    this.saveIndex();
    this.writeEvent({ ts: new Date().toISOString(), type: 'bound', name, taskId });
    return record;
  }

  /** 记录进入 worktree */
  enter(name: string): void {
    const record = this.records.find(r => r.name === name);
    if (!record) throw new Error(`Worktree "${name}" not found`);
    record.lastEnteredAt = new Date().toISOString();
    this.saveIndex();
  }

  /** 在 worktree 目录执行命令 */
  runCommand(name: string, command: string): string {
    const record = this.records.find(r => r.name === name);
    if (!record) throw new Error(`Worktree "${name}" not found`);
    record.lastCommandAt = new Date().toISOString();
    record.lastCommandPreview = command.length > 100 ? command.slice(0, 100) : command;
    this.saveIndex();
    try {
      return execSync(command, { cwd: record.path, encoding: 'utf8', timeout: 30000 });
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      return e.stderr || e.message || 'Command failed';
    }
  }

  /** 安全移除：无 discard_changes 则拒绝删除有未提交改动的工作区 */
  safeRemove(name: string, discardChanges = false): string {
    const record = this.records.find(r => r.name === name);
    if (!record) throw new Error(`Worktree "${name}" not found`);

    if (!discardChanges) {
      try {
        const status = execSync('git status --porcelain', {
          cwd: record.path,
          encoding: 'utf8',
        });
        if (status.trim().length > 0) {
          return `Refused: worktree "${name}" has uncommitted changes. Use discard_changes=true to force remove.`;
        }
      } catch {
        return `Refused: cannot check worktree status. Use discard_changes=true to force remove.`;
      }
    }

    // 强制删除：--force 覆盖未提交改动
    execSync(`git worktree remove "${record.path}" --force`, {
      cwd: this.repoRoot,
      stdio: 'ignore',
    });

    const idx = this.records.indexOf(record);
    this.records.splice(idx, 1);
    this.saveIndex();
    this.writeEvent({ ts: new Date().toISOString(), type: 'removed', name });
    return `Worktree "${name}" removed.`;
  }

  /** 收尾：keep 或 remove */
  closeout(name: string, action: 'keep' | 'remove', reason: string): string {
    const record = this.records.find(r => r.name === name);
    if (!record) throw new Error(`Worktree "${name}" not found`);

    record.closeout = { action, reason, at: new Date().toISOString() };
    this.saveIndex();
    this.writeEvent({
      ts: record.closeout.at,
      type: action === 'keep' ? 'closeout_keep' : 'closeout_remove',
      name,
      reason,
    });

    if (action === 'remove') {
      this.remove(name);
    }

    return `Worktree "${name}" closeout: ${action}. ${reason}`;
  }

  /** 从磁盘重建状态（对比 git worktree list 与 index.json） */
  recover(): WorktreeRecord[] {
    let gitWorktrees: string[] = [];
    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: this.repoRoot,
        encoding: 'utf8',
      });
      gitWorktrees = output
        .split('\n')
        .filter(line => line.startsWith('worktree '))
        .map(line => line.replace('worktree ', '').trim());
    } catch {
      // git 命令失败，保持空列表
    }

    // 清理 index.json 中已不存在的 worktree
    const before = this.records.length;
    this.records = this.records.filter(r => {
      return existsSync(r.path) || gitWorktrees.includes(r.path);
    });

    if (this.records.length !== before) {
      this.saveIndex();
    }

    return [...this.records];
  }
}
