// 后台任务高级特性测试：僵尸检测、聚合通知、运行中任务查询
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BackgroundManager } from '../background/background-manager.js';

describe('BackgroundManager - 高级特性', () => {
  let workDir: string;
  let manager: BackgroundManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `bg-adv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    manager?.killAll();
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('getRunningTaskIds', () => {
    it('无任务时返回空数组', () => {
      manager = new BackgroundManager(workDir);
      expect(manager.getRunningTaskIds()).toEqual([]);
    });

    it('应返回正在运行的任务 ID', async () => {
      manager = new BackgroundManager(workDir);
      manager.run('sleep 5');
      manager.run('sleep 5');

      const running = manager.getRunningTaskIds();
      expect(running).toHaveLength(2);

      // 清理：kill 避免等待
      manager.killAll();
    });

    it('任务完成后不再返回', async () => {
      manager = new BackgroundManager(workDir);
      manager.run('echo done');

      await waitFor(() => manager.pendingCount() > 0, 3000);

      expect(manager.getRunningTaskIds()).toEqual([]);
    });
  });

  describe('聚合通知', () => {
    it('无通知时返回 null', () => {
      manager = new BackgroundManager(workDir);
      expect(manager.drainNotificationsAggregated()).toBeNull();
    });

    it('单条通知格式正确', async () => {
      manager = new BackgroundManager(workDir);
      manager.run('echo single-test');

      await waitFor(() => manager.pendingCount() > 0, 3000);

      const aggregated = manager.drainNotificationsAggregated();
      expect(aggregated).not.toBeNull();
      expect(aggregated).toContain('[BACKGROUND]');
      expect(aggregated).toContain('1 task');
      expect(aggregated).toContain('completed');
      expect(aggregated).toContain('single-test');
    });

    it('多条通知合并为一条', async () => {
      manager = new BackgroundManager(workDir);
      manager.run('echo task-a');
      manager.run('echo task-b');

      await waitFor(() => manager.pendingCount() >= 2, 5000);

      const aggregated = manager.drainNotificationsAggregated();
      expect(aggregated).not.toBeNull();
      expect(aggregated).toContain('2 tasks');
      expect(aggregated).toContain('task-a');
      expect(aggregated).toContain('task-b');
    });

    it('drain 后再次调用返回 null', async () => {
      manager = new BackgroundManager(workDir);
      manager.run('echo drain-test');

      await waitFor(() => manager.pendingCount() > 0, 3000);

      manager.drainNotificationsAggregated();
      expect(manager.drainNotificationsAggregated()).toBeNull();
    });
  });

  describe('僵尸检测', () => {
    it('无输出超过阈值的任务应被标记为 timeout', async () => {
      // 使用极短的僵尸超时和检查间隔，加速测试
      manager = new BackgroundManager(workDir, { zombieTimeoutMs: 500, zombieCheckIntervalMs: 200 });

      // 用一个会挂起但不输出的命令
      manager.run('node -e "setTimeout(() => {}, 60000)"');

      // 等待僵尸检测触发（检查间隔 200ms + 僵尸超时 500ms）
      await waitFor(() => manager.pendingCount() > 0, 5000);

      const notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].status).toBe('timeout');
      expect(notifications[0].preview).toContain('zombie');
    }, 10000);

    it('有持续输出的任务不应被误杀', async () => {
      manager = new BackgroundManager(workDir, { zombieTimeoutMs: 500, zombieCheckIntervalMs: 200 });

      // 每 100ms 输出一行，持续 600ms（超过僵尸检测间隔）
      const cmd = process.platform === 'win32'
        ? 'node -e "let i=0; const t=setInterval(()=>{console.log(i++);if(i>=10)clearInterval(t)},100)"'
        : 'for i in $(seq 1 10); do echo $i; sleep 0.1; done';

      manager.run(cmd);

      // 等待正常完成
      await waitFor(() => manager.pendingCount() > 0, 5000);

      const notifications = manager.drainNotifications();
      expect(notifications[0].status).toBe('completed');
    }, 10000);
  });
});

/** 轮询等待条件成立 */
async function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
