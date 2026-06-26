// 定时调度系统测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { matchesCron } from '../agent/scheduler/cron-matcher.js';
import { ScheduleManager } from '../agent/scheduler/schedule-manager.js';
import { ProcessLock } from '../agent/scheduler/process-lock.js';
import { createScheduleTool, createScheduleListTool, createScheduleRemoveTool, createScheduleUpdateTool } from '../agent/tools/schedule-tool.js';
import { createDefaultRegistry } from '../agent/tool-registry.js';
import { unlinkSync, existsSync } from 'fs';

describe('matchesCron', () => {
  it('should match wildcard', () => {
    const date = new Date(2026, 0, 1, 14, 30);
    expect(matchesCron('* * * * *', date)).toBe(true);
  });

  it('should match exact minute', () => {
    const date = new Date(2026, 0, 1, 14, 30);
    expect(matchesCron('30 * * * *', date)).toBe(true);
    expect(matchesCron('31 * * * *', date)).toBe(false);
  });

  it('should match exact hour', () => {
    const date = new Date(2026, 0, 1, 14, 30);
    expect(matchesCron('* 14 * * *', date)).toBe(true);
    expect(matchesCron('* 15 * * *', date)).toBe(false);
  });

  it('should match step */5', () => {
    const date = new Date(2026, 0, 1, 14, 30);
    expect(matchesCron('*/5 * * * *', date)).toBe(true);

    const date2 = new Date(2026, 0, 1, 14, 33);
    expect(matchesCron('*/5 * * * *', date2)).toBe(false);
  });

  it('should match day of week', () => {
    const monday = new Date(2026, 0, 5, 9, 0);
    expect(matchesCron('0 9 * * 1', monday)).toBe(true);

    const tuesday = new Date(2026, 0, 6, 9, 0);
    expect(matchesCron('0 9 * * 1', tuesday)).toBe(false);
  });

  it('should match comma-separated values', () => {
    const date = new Date(2026, 0, 1, 14, 0);
    expect(matchesCron('0 10,14,18 * * *', date)).toBe(true);

    const date2 = new Date(2026, 0, 1, 15, 0);
    expect(matchesCron('0 10,14,18 * * *', date2)).toBe(false);
  });

  it('should match full expression', () => {
    const date = new Date(2026, 0, 5, 9, 0);
    expect(matchesCron('0 9 * * 1', date)).toBe(true);
  });

  it('should reject invalid expression', () => {
    const date = new Date(2026, 0, 1, 14, 30);
    expect(matchesCron('invalid', date)).toBe(false);
    expect(matchesCron('* * *', date)).toBe(false);
  });

  // === Range 支持 ===

  it('should match range N-M (day of week 1-5 = Mon-Fri)', () => {
    const monday = new Date(2026, 0, 5, 9, 0);    // Mon
    const friday = new Date(2026, 0, 9, 9, 0);    // Fri
    const saturday = new Date(2026, 0, 10, 9, 0);  // Sat
    const sunday = new Date(2026, 0, 4, 9, 0);    // Sun

    expect(matchesCron('0 9 * * 1-5', monday)).toBe(true);
    expect(matchesCron('0 9 * * 1-5', friday)).toBe(true);
    expect(matchesCron('0 9 * * 1-5', saturday)).toBe(false);
    expect(matchesCron('0 9 * * 1-5', sunday)).toBe(false);
  });

  it('should match range N-M (hour 9-17)', () => {
    const at9 = new Date(2026, 0, 1, 9, 0);
    const at17 = new Date(2026, 0, 1, 17, 0);
    const at18 = new Date(2026, 0, 1, 18, 0);

    expect(matchesCron('0 9-17 * * *', at9)).toBe(true);
    expect(matchesCron('0 9-17 * * *', at17)).toBe(true);
    expect(matchesCron('0 9-17 * * *', at18)).toBe(false);
  });

  it('should match range combined with step */5', () => {
    const date = new Date(2026, 0, 5, 10, 15); // Mon, 10:15
    expect(matchesCron('*/5 9-17 * * 1-5', date)).toBe(true);

    const date2 = new Date(2026, 0, 10, 10, 15); // Sat
    expect(matchesCron('*/5 9-17 * * 1-5', date2)).toBe(false);
  });

  // === 时区对齐 ===

  it('should match cron in specified timezone (Asia/Shanghai)', () => {
    // UTC 2026-01-05 01:00 = 北京时间 2026-01-05 09:00 (周一)
    const utcDate = new Date(Date.UTC(2026, 0, 5, 1, 0));
    expect(matchesCron('0 9 * * 1', utcDate, 'Asia/Shanghai')).toBe(true);

    // UTC 2026-01-05 02:00 = 北京时间 2026-01-05 10:00
    expect(matchesCron('0 9 * * 1', utcDate, 'Asia/Shanghai')).toBe(true);
    const utcDate2 = new Date(Date.UTC(2026, 0, 5, 2, 0));
    expect(matchesCron('0 9 * * 1', utcDate2, 'Asia/Shanghai')).toBe(false);
  });

  it('should match cron in America/New_York timezone', () => {
    // UTC 2026-01-05 14:00 = 纽约 2026-01-05 09:00 (EST, UTC-5)
    const utcDate = new Date(Date.UTC(2026, 0, 5, 14, 0));
    expect(matchesCron('0 9 * * 1', utcDate, 'America/New_York')).toBe(true);

    // UTC 2026-01-05 15:00 = 纽约 10:00
    const utcDate2 = new Date(Date.UTC(2026, 0, 5, 15, 0));
    expect(matchesCron('0 9 * * 1', utcDate2, 'America/New_York')).toBe(false);
  });

  it('should fallback to local time when no timezone specified', () => {
    // 无 timezone 参数时使用本地时间（旧行为不变）
    const date = new Date(2026, 0, 5, 9, 0);
    expect(matchesCron('0 9 * * 1', date)).toBe(true);
  });
});

describe('ScheduleManager', () => {
  let scheduler: ScheduleManager;
  const testFile = '.test-schedules.json';

  beforeEach(() => {
    scheduler = new ScheduleManager(testFile);
  });

  afterEach(() => {
    if (existsSync(testFile)) unlinkSync(testFile);
  });

  it('should create a schedule', () => {
    const job = scheduler.create('0 9 * * *', 'Run report');

    expect(job.id).toMatch(/^sched_/);
    expect(job.cron).toBe('0 9 * * *');
    expect(job.prompt).toBe('Run report');
    expect(job.recurring).toBe(true);
    expect(job.enabled).toBe(true);
    expect(job.lastFiredAt).toBeNull();
  });

  it('should list schedules', () => {
    scheduler.create('0 9 * * *', 'Job 1');
    scheduler.create('0 18 * * *', 'Job 2');

    const list = scheduler.list();
    expect(list.length).toBe(2);
  });

  it('should remove a schedule', () => {
    const job = scheduler.create('0 9 * * *', 'Job');
    const removed = scheduler.remove(job.id);

    expect(removed).toBe(true);
    expect(scheduler.list().length).toBe(0);
  });

  it('should return false when removing non-existent schedule', () => {
    expect(scheduler.remove('nonexistent')).toBe(false);
  });

  it('should disable and enable schedule', () => {
    const job = scheduler.create('0 9 * * *', 'Job');

    scheduler.disable(job.id);
    expect(scheduler.list()[0]!.enabled).toBe(false);

    scheduler.enable(job.id);
    expect(scheduler.list()[0]!.enabled).toBe(true);
  });

  it('should fire notification when cron matches', () => {
    scheduler.create('* * * * *', 'Every minute');
    const now = new Date(2026, 0, 1, 14, 30);

    scheduler.check(now);
    const notifications = scheduler.drain();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.prompt).toBe('Every minute');
  });

  it('should not fire disabled schedule', () => {
    const job = scheduler.create('* * * * *', 'Disabled');
    scheduler.disable(job.id);

    scheduler.check(new Date(2026, 0, 1, 14, 30));
    expect(scheduler.drain().length).toBe(0);
  });

  it('should not fire twice in same minute', () => {
    scheduler.create('* * * * *', 'Test');
    const now = new Date(2026, 0, 1, 14, 30, 0);

    scheduler.check(now);
    scheduler.check(now);

    expect(scheduler.drain().length).toBe(1);
  });

  it('should disable non-recurring after firing', () => {
    scheduler.create('* * * * *', 'Once only', false);
    const now = new Date(2026, 0, 1, 14, 30);

    scheduler.check(now);
    const list = scheduler.list();

    expect(list[0]!.enabled).toBe(false);
  });

  it('should keep recurring enabled after firing', () => {
    scheduler.create('* * * * *', 'Recurring', true);
    const now = new Date(2026, 0, 1, 14, 30);

    scheduler.check(now);
    const list = scheduler.list();

    expect(list[0]!.enabled).toBe(true);
  });

  it('should persist and load', () => {
    scheduler.create('0 9 * * *', 'Persistent job');

    const scheduler2 = new ScheduleManager(testFile);
    scheduler2.load();

    expect(scheduler2.list().length).toBe(1);
    expect(scheduler2.list()[0]!.prompt).toBe('Persistent job');
  });

  // === durable 字段 ===

  it('should create durable schedule by default', () => {
    const job = scheduler.create('0 9 * * *', 'Durable job');
    expect(job.durable).toBe(true);
  });

  it('should create non-durable schedule when specified', () => {
    const job = scheduler.create('0 9 * * *', 'Ephemeral job', true, false);
    expect(job.durable).toBe(false);
  });

  it('should not load non-durable schedules on restart', () => {
    scheduler.create('0 9 * * *', 'Durable job');
    scheduler.create('0 18 * * *', 'Ephemeral job', true, false);

    // 模拟重启
    const scheduler2 = new ScheduleManager(testFile);
    scheduler2.load();

    // 只有 durable 的被加载
    expect(scheduler2.list().length).toBe(1);
    expect(scheduler2.list()[0]!.prompt).toBe('Durable job');
  });

  // === expectedNextRun 追踪 ===

  it('should set expectedNextRun after firing', () => {
    scheduler.create('0 9 * * *', 'Daily job');
    const now = new Date(2026, 0, 5, 9, 0); // Mon 9am
    scheduler.check(now);

    const jobs = scheduler.list();
    expect(jobs[0]!.expectedNextRun).not.toBeNull();
    // 下次触发应该是明天 9am = 2026-01-06 09:00
    const expected = new Date(jobs[0]!.expectedNextRun!);
    expect(expected.getDate()).toBe(6);
    expect(expected.getHours()).toBe(9);
    expect(expected.getMinutes()).toBe(0);
  });

  it('should use expectedNextRun for catch-up instead of backtracking', () => {
    scheduler.create('0 9 * * *', 'Daily job');

    // 模拟已经触发过，expectedNextRun 设为今天 9am
    const today9am = new Date(2026, 0, 5, 9, 0);
    const yesterday9am = new Date(2026, 0, 4, 9, 0);
    const jobs = scheduler.list();
    jobs[0]!.lastFiredAt = yesterday9am.getTime();
    jobs[0]!.expectedNextRun = today9am.getTime();
    scheduler.save();

    // 现在是 10am，错过了 9am
    const now = new Date(2026, 0, 5, 10, 0);
    const missed = scheduler.checkCatchUp(now);

    expect(missed.length).toBe(1);
    expect(missed[0]!.prompt).toBe('Daily job');
  });

  it('should drain all notifications', () => {
    scheduler.create('* * * * *', 'Job 1');
    scheduler.create('* * * * *', 'Job 2');

    scheduler.check(new Date(2026, 0, 1, 14, 30));
    const notifications = scheduler.drain();

    expect(notifications.length).toBe(2);
    expect(scheduler.drain().length).toBe(0);
  });
});

describe('schedule tools', () => {
  it('schedule_create should return confirmation', async () => {
    const scheduler = new ScheduleManager();
    const { executor } = createScheduleTool(scheduler);

    const result = await executor({ cron: '0 9 * * *', prompt: 'Run report' });

    expect(result).toContain('Created schedule');
    expect(result).toContain('Run report');
    expect(result).toContain('0 9 * * *');
  });

  it('schedule_list should show schedules', async () => {
    const scheduler = new ScheduleManager();
    scheduler.create('0 9 * * *', 'Job 1');
    const { executor } = createScheduleListTool(scheduler);

    const result = await executor({});

    expect(result).toContain('Job 1');
    expect(result).toContain('active');
  });

  it('schedule_list should return message when empty', async () => {
    const scheduler = new ScheduleManager();
    const { executor } = createScheduleListTool(scheduler);

    const result = await executor({});

    expect(result).toBe('No scheduled tasks.');
  });

  it('schedule_remove should remove schedule', async () => {
    const scheduler = new ScheduleManager();
    const job = scheduler.create('0 9 * * *', 'Job');
    const { executor } = createScheduleRemoveTool(scheduler);

    const result = await executor({ schedule_id: job.id });

    expect(result).toContain('Removed');
    expect(scheduler.list().length).toBe(0);
  });

  it('schedule_remove should return error for non-existent', async () => {
    const scheduler = new ScheduleManager();
    const { executor } = createScheduleRemoveTool(scheduler);

    const result = await executor({ schedule_id: 'nonexistent' });

    expect(result).toContain('Error');
  });

  it('schedule_update should update cron and prompt', async () => {
    const scheduler = new ScheduleManager();
    const job = scheduler.create('0 9 * * *', 'Old prompt');
    const { executor } = createScheduleUpdateTool(scheduler);

    const result = await executor({ schedule_id: job.id, cron: '0 18 * * *', prompt: 'New prompt' });

    expect(result).toContain('Updated');
    const updated = scheduler.list()[0]!;
    expect(updated.cron).toBe('0 18 * * *');
    expect(updated.prompt).toBe('New prompt');
  });

  it('schedule_update should return error for non-existent', async () => {
    const scheduler = new ScheduleManager();
    const { executor } = createScheduleUpdateTool(scheduler);

    const result = await executor({ schedule_id: 'nonexistent', prompt: 'New' });

    expect(result).toContain('Error');
  });
});

describe('createDefaultRegistry - 调度工具', () => {
  it('should register schedule tools when scheduler provided', () => {
    const scheduler = new ScheduleManager();
    const registry = createDefaultRegistry(undefined, undefined, scheduler);

    const names = registry.getDefinitions().map(d => d.name);

    expect(names).toContain('schedule_create');
    expect(names).toContain('schedule_list');
    expect(names).toContain('schedule_remove');
  });

  it('should not register schedule tools when no scheduler', () => {
    const registry = createDefaultRegistry();

    const names = registry.getDefinitions().map(d => d.name);

    expect(names).not.toContain('schedule_create');
  });
});

// === Catch-up 追赶测试 ===

describe('ScheduleManager - catch-up', () => {
  let scheduler: ScheduleManager;
  const testFile = '.test-schedules-catchup.json';

  beforeEach(() => {
    scheduler = new ScheduleManager(testFile);
  });

  afterEach(() => {
    if (existsSync(testFile)) unlinkSync(testFile);
  });

  it('should catch up missed daily schedule on cold start', () => {
    // 创建一个每天 9am 的任务
    scheduler.create('0 9 * * *', 'Daily report');

    // 模拟上次触发是昨天
    const yesterday = new Date(2026, 0, 4, 9, 0); // Sun 9am
    const jobs = scheduler.list();
    jobs[0]!.lastFiredAt = yesterday.getTime();
    scheduler.save();

    // 冷启动检查：现在是周一 10am，错过了今天 9am
    const now = new Date(2026, 0, 5, 10, 0); // Mon 10am
    const missed = scheduler.checkCatchUp(now);

    expect(missed.length).toBe(1);
    expect(missed[0]!.prompt).toBe('Daily report');
  });

  it('should not catch up if already triggered this cycle', () => {
    scheduler.create('0 9 * * *', 'Daily report');

    // 已经在今天 9:01 触发过了
    const alreadyFired = new Date(2026, 0, 5, 9, 1);
    const jobs = scheduler.list();
    jobs[0]!.lastFiredAt = alreadyFired.getTime();
    scheduler.save();

    // 现在是 10am，不应该再补发
    const now = new Date(2026, 0, 5, 10, 0);
    const missed = scheduler.checkCatchUp(now);

    expect(missed.length).toBe(0);
  });

  it('should not catch up disabled schedules', () => {
    const job = scheduler.create('0 9 * * *', 'Disabled job');
    scheduler.disable(job.id);

    const now = new Date(2026, 0, 5, 10, 0);
    const missed = scheduler.checkCatchUp(now);

    expect(missed.length).toBe(0);
  });

  it('should update lastFiredAt after catch-up', () => {
    scheduler.create('0 9 * * *', 'Job');

    // 设置上次触发为昨天（模拟错过）
    const yesterday = new Date(2026, 0, 4, 9, 0);
    const jobs = scheduler.list();
    jobs[0]!.lastFiredAt = yesterday.getTime();
    scheduler.save();

    const now = new Date(2026, 0, 5, 10, 0);
    scheduler.checkCatchUp(now);

    const updatedJobs = scheduler.list();
    expect(updatedJobs[0]!.lastFiredAt).toBe(now.getTime());
  });
});

// === ProcessLock 测试 ===

describe('ProcessLock', () => {
  const lockFile = '.test-scheduler.lock';

  afterEach(() => {
    try { unlinkSync(lockFile); } catch { /* ignore */ }
  });

  it('should acquire lock and write pid', () => {
    const lock = new ProcessLock(lockFile);
    const acquired = lock.acquire();

    expect(acquired).toBe(true);
    expect(existsSync(lockFile)).toBe(true);
  });

  it('should release lock and remove file', () => {
    const lock = new ProcessLock(lockFile);
    lock.acquire();
    lock.release();

    expect(existsSync(lockFile)).toBe(false);
  });

  it('should fail to acquire if already locked by live process', () => {
    const lock1 = new ProcessLock(lockFile);
    lock1.acquire();

    const lock2 = new ProcessLock(lockFile);
    const acquired = lock2.acquire();

    expect(acquired).toBe(false);
  });

  it('should acquire if lock file has stale pid', () => {
    // 写入一个不存在的 pid（模拟进程异常退出）
    const lock = new ProcessLock(lockFile);
    // 直接写入 99999999（不太可能有这个 pid）
    require('fs').writeFileSync(lockFile, JSON.stringify({ pid: 99999999, time: Date.now() }));

    const acquired = lock.acquire();
    expect(acquired).toBe(true);
  });
});
