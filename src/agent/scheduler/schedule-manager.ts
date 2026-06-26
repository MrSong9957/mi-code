// ScheduleManager：调度管理器
//
// 物理本质：闹钟管理员。
// 创建闹钟 → 定时检查 → 到点了就响 → 响完看要不要继续。

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { matchesCron } from './cron-matcher.js';
import type { ScheduleRecord, ScheduleNotification } from './types.js';

let nextId = 1;

export class ScheduleManager {
  private jobs: ScheduleRecord[] = [];
  private notifications: ScheduleNotification[] = [];
  private filePath: string | null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? null;
  }

  /** 创建调度 */
  create(cron: string, prompt: string, recurring = true, durable = true): ScheduleRecord {
    const job: ScheduleRecord = {
      id: `sched_${nextId++}`,
      cron,
      prompt,
      recurring,
      enabled: true,
      durable,
      createdAt: Date.now(),
      lastFiredAt: null,
      expectedNextRun: null,
    };
    this.jobs.push(job);
    this.save();
    return job;
  }

  /** 删除调度 */
  remove(id: string): boolean {
    const idx = this.jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this.jobs.splice(idx, 1);
    this.save();
    return true;
  }

  /** 启用调度 */
  enable(id: string): boolean {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return false;
    job.enabled = true;
    this.save();
    return true;
  }

  /** 禁用调度 */
  disable(id: string): boolean {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return false;
    job.enabled = false;
    this.save();
    return true;
  }

  /** 更新调度 */
  update(id: string, changes: { cron?: string; prompt?: string; recurring?: boolean }): boolean {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return false;
    if (changes.cron !== undefined) job.cron = changes.cron;
    if (changes.prompt !== undefined) job.prompt = changes.prompt;
    if (changes.recurring !== undefined) job.recurring = changes.recurring;
    this.save();
    return true;
  }

  /** 列出所有调度 */
  list(): ScheduleRecord[] {
    return [...this.jobs];
  }

  /** 检查是否有任务需要触发 */
  check(now?: Date, timezone?: string): void {
    const currentTime = now ?? new Date();
    const currentMinute = Math.floor(currentTime.getTime() / 60000);

    for (const job of this.jobs) {
      if (!job.enabled) continue;

      // 检查是否匹配 cron（支持时区）
      if (!matchesCron(job.cron, currentTime, timezone)) continue;

      // 同一分钟内不重复触发
      if (job.lastFiredAt !== null) {
        const lastMinute = Math.floor(job.lastFiredAt / 60000);
        if (lastMinute === currentMinute) continue;
      }

      // 触发
      this.notifications.push({
        type: 'scheduled_prompt',
        scheduleId: job.id,
        prompt: job.prompt,
      });

      job.lastFiredAt = currentTime.getTime();

      // 计算下次预期触发时间
      job.expectedNextRun = findNextCronMatch(job.cron, currentTime, timezone)?.getTime() ?? null;

      // 非重复调度触发后禁用
      if (!job.recurring) {
        job.enabled = false;
      }
    }

    this.save();
  }

  /** 取走所有待处理通知 */
  drain(): ScheduleNotification[] {
    const result = [...this.notifications];
    this.notifications = [];
    return result;
  }

  /**
   * 冷启动追赶：检查是否错过了触发时间
   *
   * 物理本质：闹钟响了但你不在家，回来后看看有没有错过。
   * 优先使用 expectedNextRun（精确），回退到回溯策略（兜底）。
   */
  checkCatchUp(now: Date, timezone?: string): ScheduleNotification[] {
    const missed: ScheduleNotification[] = [];
    const currentTime = now.getTime();

    for (const job of this.jobs) {
      if (!job.enabled) continue;

      // 从未触发过 → 不补发（新建任务不应立即触发）
      if (job.lastFiredAt === null) continue;

      // 检查上次触发距今是否超过 1 分钟
      const elapsed = currentTime - job.lastFiredAt;
      if (elapsed < 60000) continue;

      let shouldCatchUp = false;

      // 策略 1：用 expectedNextRun（精确）
      if (job.expectedNextRun !== null && job.expectedNextRun <= currentTime) {
        shouldCatchUp = true;
      } else {
        // 策略 2：回溯找最近匹配点（兜底）
        const lastMatch = findLastCronMatch(job.cron, now, timezone);
        if (lastMatch !== null && lastMatch.getTime() > job.lastFiredAt) {
          shouldCatchUp = true;
        }
      }

      if (shouldCatchUp) {
        missed.push({
          type: 'scheduled_prompt',
          scheduleId: job.id,
          prompt: job.prompt,
        });
        job.lastFiredAt = currentTime;
        job.expectedNextRun = findNextCronMatch(job.cron, now, timezone)?.getTime() ?? null;
      }
    }

    if (missed.length > 0) this.save();
    return missed;
  }

  /** 持久化保存 */
  save(): void {
    if (!this.filePath) return;
    try {
      writeFileSync(this.filePath, JSON.stringify(this.jobs, null, 2), 'utf8');
    } catch {
      // 静默忽略写入失败
    }
  }

  /** 持久化加载（跳过非 durable 调度） */
  load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;

    try {
      const data = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        // 只加载 durable 的调度（非 durable 的重启后丢失）
        this.jobs = parsed.filter((j: ScheduleRecord) => j.durable !== false);

        // 更新 nextId 避免冲突
        for (const job of this.jobs) {
          const num = parseInt(job.id.replace('sched_', ''), 10);
          if (!isNaN(num) && num >= nextId) {
            nextId = num + 1;
          }
        }
      }
    } catch {
      // 静默忽略加载失败，从空列表开始
    }
  }
}

/**
 * 从当前时间往前回溯，找最近的 cron 匹配时间点
 * 最多回溯 48 小时（避免无限循环）
 */
function findLastCronMatch(cronExpr: string, now: Date, timezone?: string): Date | null {
  const maxBacktrack = 48 * 60; // 48 小时，以分钟为单位
  const currentMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());

  for (let i = 0; i < maxBacktrack; i++) {
    const checkTime = new Date(currentMinute.getTime() - i * 60000);
    if (matchesCron(cronExpr, checkTime, timezone)) {
      return checkTime;
    }
  }
  return null;
}

/**
 * 从当前时间往后找下一个 cron 匹配时间点
 * 最多前瞻 48 小时（避免无限循环）
 */
function findNextCronMatch(cronExpr: string, now: Date, timezone?: string): Date | null {
  const maxForward = 48 * 60; // 48 小时，以分钟为单位
  // 从下一分钟开始找
  const startMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
  startMinute.setTime(startMinute.getTime() + 60000);

  for (let i = 0; i < maxForward; i++) {
    const checkTime = new Date(startMinute.getTime() + i * 60000);
    if (matchesCron(cronExpr, checkTime, timezone)) {
      return checkTime;
    }
  }
  return null;
}
