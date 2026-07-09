// 定时调度系统测试（精简版）
// 保留：cron 核心匹配 / ScheduleManager CRUD+触发+持久化+catch-up / 工具注册 / ProcessLock
// 精简：cron 穷举（range/comma/多时区合并为代表用例）/ 工具层重复 CRUD（只保留 create + 注册）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { matchesCron } from '../agent/scheduler/cron-matcher.js';
import { ScheduleManager } from '../agent/scheduler/schedule-manager.js';
import { ProcessLock } from '../agent/scheduler/process-lock.js';
import { createScheduleTool } from '../agent/tools/schedule-tool.js';
import { createDefaultRegistry } from '../agent/tool-registry.js';
import { unlinkSync, existsSync, writeFileSync } from 'fs';

describe('matchesCron', () => {
  it('通配符 + 精确值 + 步进 + 非法表达式', () => {
    const date = new Date(2026, 0, 1, 14, 30);
    expect(matchesCron('* * * * *', date)).toBe(true);       // 通配
    expect(matchesCron('30 * * * *', date)).toBe(true);      // 精确 minute
    expect(matchesCron('31 * * * *', date)).toBe(false);     // 不匹配
    expect(matchesCron('*/5 * * * *', date)).toBe(true);     // 步进
    expect(matchesCron('invalid', date)).toBe(false);         // 非法
    expect(matchesCron('* * *', date)).toBe(false);           // 字段不足
  });

  it('时区：指定时区按该时区计算（Asia/Shanghai）', () => {
    // UTC 2026-01-05 01:00 = 北京时间 2026-01-05 09:00 (周一)
    const utcDate = new Date(Date.UTC(2026, 0, 5, 1, 0));
    expect(matchesCron('0 9 * * 1', utcDate, 'Asia/Shanghai')).toBe(true);
  });
});

describe('ScheduleManager', () => {
  let scheduler: ScheduleManager;
  const testFile = '.test-schedules.json';

  beforeEach(() => { scheduler = new ScheduleManager(testFile); });
  afterEach(() => { if (existsSync(testFile)) unlinkSync(testFile); });

  it('create + list + remove 基础 CRUD', () => {
    const job = scheduler.create('0 9 * * *', 'Run report');
    expect(job.id).toMatch(/^sched_/);
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.remove(job.id)).toBe(true);
    expect(scheduler.list()).toHaveLength(0);
    expect(scheduler.remove('nonexistent')).toBe(false);
  });

  it('cron 匹配时触发通知，同分钟不重复', () => {
    scheduler.create('* * * * *', 'Every minute');
    const now = new Date(2026, 0, 1, 14, 30);
    scheduler.check(now);
    scheduler.check(now); // 同分钟第二次不触发
    expect(scheduler.drain()).toHaveLength(1);
  });

  it('disabled 不触发；非 recurring 触发后自动 disable', () => {
    const job = scheduler.create('* * * * *', 'Disabled');
    scheduler.disable(job.id);
    scheduler.check(new Date(2026, 0, 1, 14, 30));
    expect(scheduler.drain()).toHaveLength(0);

    scheduler.create('* * * * *', 'Once', false);
    scheduler.check(new Date(2026, 0, 1, 14, 31));
    expect(scheduler.list().find(j => j.prompt === 'Once')!.enabled).toBe(false);
  });

  it('persist + load：durable 持久化，non-durable 重启后消失', () => {
    scheduler.create('0 9 * * *', 'Durable job');
    scheduler.create('0 18 * * *', 'Ephemeral', true, false);

    const scheduler2 = new ScheduleManager(testFile);
    scheduler2.load();
    const loaded = scheduler2.list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.prompt).toBe('Durable job');
  });
});

describe('ScheduleManager - catch-up（冷启动追赶）', () => {
  let scheduler: ScheduleManager;
  const testFile = '.test-schedules-catchup.json';

  beforeEach(() => { scheduler = new ScheduleManager(testFile); });
  afterEach(() => { if (existsSync(testFile)) unlinkSync(testFile); });

  it('冷启动补发错过的任务，已触发的不补发', () => {
    scheduler.create('0 9 * * *', 'Daily report');
    const jobs = scheduler.list();
    jobs[0]!.lastFiredAt = new Date(2026, 0, 4, 9, 0).getTime(); // 昨天触发
    scheduler.save();

    const now = new Date(2026, 0, 5, 10, 0); // 今天 10am，错过了 9am
    expect(scheduler.checkCatchUp(now)).toHaveLength(1);

    // 已在今天触发过 → 不补发
    jobs[0]!.lastFiredAt = new Date(2026, 0, 5, 9, 1).getTime();
    scheduler.save();
    expect(scheduler.checkCatchUp(now)).toHaveLength(0);
  });
});

describe('schedule tools（注册 + create）', () => {
  it('工具注册：提供 scheduler 时注册，否则不注册', () => {
    const withScheduler = createDefaultRegistry(undefined, undefined, new ScheduleManager());
    const names = withScheduler.getDefinitions().map(d => d.name);
    expect(names).toContain('schedule_create');

    const without = createDefaultRegistry();
    expect(without.getDefinitions().map(d => d.name)).not.toContain('schedule_create');
  });

  it('schedule_create 返回确认信息', async () => {
    const scheduler = new ScheduleManager();
    const { executor } = createScheduleTool(scheduler);
    const result = await executor({ cron: '0 9 * * *', prompt: 'Run report' });
    expect(result).toContain('Created schedule');
    expect(result).toContain('Run report');
  });
});

describe('ProcessLock', () => {
  const lockFile = '.test-scheduler.lock';
  afterEach(() => { try { unlinkSync(lockFile); } catch { /* ignore */ } });

  it('acquire + release + 已锁拒绝 + stale pid 可抢', () => {
    const lock1 = new ProcessLock(lockFile);
    expect(lock1.acquire()).toBe(true);
    expect(existsSync(lockFile)).toBe(true);

    // 已被 live process 锁定 → 拒绝
    const lock2 = new ProcessLock(lockFile);
    expect(lock2.acquire()).toBe(false);

    // release 后文件消失
    lock1.release();
    expect(existsSync(lockFile)).toBe(false);

    // stale pid（进程已死）→ 可抢
    writeFileSync(lockFile, JSON.stringify({ pid: 99999999, time: Date.now() }));
    const lock3 = new ProcessLock(lockFile);
    expect(lock3.acquire()).toBe(true);
  });
});
