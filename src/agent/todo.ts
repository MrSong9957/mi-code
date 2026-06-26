// TodoManager：进度追踪（V1/V2 双模式）
//
// 物理本质：白板上的任务清单。
// V1: 内存版，适合 SDK/脚本
// V2: 持久化版，支持依赖图 + activeForm Spinner
//
// 自动切换：isTTY → V2, 非 isTTY → V1

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  worktree?: string;
  activeForm?: string;
  blockedBy?: string[];
  claimedAt?: string;
  claimSource?: 'auto' | 'manual';
  role?: string;
}

export function isTodoV2Enabled(): boolean {
  return process.stdin?.isTTY === true;
}

export class TodoManager {
  private items: TodoItem[] = [];
  private roundsSinceTodo = 0;
  private tasksDir: string | null = null;
  private version: 1 | 2;

  constructor(version?: 1 | 2) {
    this.version = version ?? (isTodoV2Enabled() ? 2 : 1);
  }

  enablePersistence(repoRoot: string): void {
    this.tasksDir = join(repoRoot, '.tasks');
    mkdirSync(this.tasksDir, { recursive: true });
  }

  private persistItem(item: TodoItem): void {
    if (!this.tasksDir) return;
    writeFileSync(join(this.tasksDir, `task_${item.id}.json`), JSON.stringify(item, null, 2), 'utf8');
  }

  private persistAll(): void {
    for (const item of this.items) this.persistItem(item);
  }

  loadFromDisk(): void {
    if (!this.tasksDir || !existsSync(this.tasksDir)) return;
    const files = readdirSync(this.tasksDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
    this.items = [];
    for (const file of files) {
      try { this.items.push(JSON.parse(readFileSync(join(this.tasksDir, file), 'utf8'))); } catch { /* skip */ }
    }
  }

  update(items: TodoItem[]): string {
    let inProgressCount = 0;
    for (const item of items) { if (item.status === 'in_progress') inProgressCount++; }
    if (inProgressCount > 1) return 'Error: Only one task can be in_progress at a time';

    if (this.version === 2) {
      for (const item of items) {
        if (item.status === 'in_progress' && item.blockedBy?.length) {
          const unmet = item.blockedBy.filter(depId => {
            const dep = items.find(i => i.id === depId);
            return !dep || dep.status !== 'completed';
          });
          if (unmet.length > 0) return `Error: Task "${item.id}" is blocked by uncompleted tasks: ${unmet.join(', ')}`;
        }
      }
    }

    this.items = items;
    this.roundsSinceTodo = 0;
    if (this.version === 2) this.persistAll();
    return this.render();
  }

  getItems(): TodoItem[] { return [...this.items]; }

  render(): string {
    if (this.items.length === 0) return 'No todos yet.';
    return this.items.map(item => {
      const prefix = item.status === 'completed' ? '[x] ' : item.status === 'in_progress' ? '[>] ' : '[ ] ';
      let suffix = '';
      if (this.version === 2 && item.blockedBy?.length) {
        const pending = item.blockedBy.filter(depId => { const dep = this.items.find(i => i.id === depId); return !dep || dep.status !== 'completed'; });
        if (pending.length > 0) suffix = ` (blocked by: ${pending.join(', ')})`;
      }
      let activeFormStr = '';
      if (this.version === 2 && item.status === 'in_progress' && item.activeForm) activeFormStr = ` ⟩ ${item.activeForm}`;
      return `${prefix}${item.content}${activeFormStr}${suffix}`;
    }).join('\n');
  }

  incrementRounds(): void { this.roundsSinceTodo++; }
  needsReminder(): boolean { return this.roundsSinceTodo >= 3; }
  getReminder(): string | null { return this.needsReminder() ? '<reminder>Update your todos. Ensure completed tasks are marked, and current work is set to in_progress.</reminder>' : null; }

  getVerificationNudge(): string | null {
    if (this.items.length === 0) return null;
    if (!this.items.every(i => i.status === 'completed')) return null;
    return '<reminder>All tasks are marked completed. Verify your work and confirm the task is done, or update todos if more work remains.</reminder>';
  }

  canStart(taskId: string): boolean {
    const item = this.items.find(i => i.id === taskId);
    if (!item) return false;
    if (!item.blockedBy || item.blockedBy.length === 0) return true;
    return item.blockedBy.every(depId => { const dep = this.items.find(i => i.id === depId); return dep && dep.status === 'completed'; });
  }

  scanClaimable(role?: string): TodoItem[] {
    return this.items.filter(item => {
      if (item.status !== 'pending' || item.owner || !this.canStart(item.id)) return false;
      if (role && item.role && item.role !== role) return false;
      return true;
    });
  }

  claim(itemId: string, owner: string, source: 'auto' | 'manual' = 'manual'): string {
    const item = this.items.find(i => i.id === itemId);
    if (!item) return `Error: Task "${itemId}" not found`;
    if (item.owner && item.owner !== owner) return `Error: Task "${itemId}" already claimed by ${item.owner}`;
    // 同 owner 重新认领（幂等）
    if (item.owner === owner && item.status === 'in_progress') return `Claimed task "${item.content}" as ${owner}`;
    if (item.status !== 'pending') return `Error: Task "${itemId}" is ${item.status}, cannot claim`;
    if (!this.canStart(itemId)) return `Error: Task "${itemId}" is blocked by dependencies`;
    item.owner = owner;
    item.status = 'in_progress';
    item.claimedAt = new Date().toISOString();
    item.claimSource = source;
    if (this.version === 2) this.persistItem(item);
    this.writeClaimEvent(itemId, owner, source);
    return `Claimed task "${item.content}" as ${owner}`;
  }

  private writeClaimEvent(taskId: string, owner: string, source: 'auto' | 'manual'): void {
    if (!this.tasksDir) return;
    writeFileSync(join(this.tasksDir, 'claim_events.jsonl'), JSON.stringify({ event: 'task.claimed', task_id: taskId, owner, source, ts: Date.now() }) + '\n', { flag: 'a' });
  }

  getUnclaimed(): TodoItem[] { return this.items.filter(i => !i.owner && i.status !== 'completed'); }
  getByOwner(owner: string): TodoItem[] { return this.items.filter(i => i.owner === owner); }
  getVersion(): 1 | 2 { return this.version; }
}
