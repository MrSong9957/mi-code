// BackgroundManager 单元测试
//
// 物理本质：测试"快递中转站"能不能正确发快递、等回执、通知收件人。
// 用真实子进程（echo/timeout）验证，不 mock spawn。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BackgroundManager } from '../background/background-manager.js';

describe('BackgroundManager', () => {
  let workDir: string;
  let manager: BackgroundManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `bg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new BackgroundManager(workDir);
  });

  afterEach(() => {
    manager.killAll();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('run: 立刻返回 task_id，不阻塞', () => {
    const start = Date.now();
    const taskId = manager.run('echo hello');
    const elapsed = Date.now() - start;

    expect(taskId).toBeTruthy();
    expect(elapsed).toBeLessThan(100); // 应该几乎瞬间返回
  });

  it('run: 任务完成后通知队列有消息', async () => {
    manager.run('echo hello-world');

    // 等待子进程完成（用 pendingCount 而非 drain，避免清空队列）
    await waitFor(() => manager.pendingCount() > 0, 3000);

    const notifications = manager.drainNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('background_completed');
    expect(notifications[0].status).toBe('completed');
    expect(notifications[0].preview).toContain('hello-world');
  });

  it('run: 完整输出写入 log 文件', async () => {
    const taskId = manager.run('echo full-output-line');

    await waitFor(() => manager.pendingCount() > 0, 3000);

    const task = manager.getStatus(taskId);
    expect(task).not.toBeNull();
    expect(task!.outputFile).toBeTruthy();
    expect(existsSync(task!.outputFile)).toBe(true);

    const content = readFileSync(task!.outputFile, 'utf8');
    expect(content).toContain('full-output-line');
  });

  it('getStatus: 查询任务状态', async () => {
    const taskId = manager.run('echo status-check');

    // 还在运行时查
    const running = manager.getStatus(taskId);
    expect(running).not.toBeNull();
    expect(running!.status).toBe('running');

    await waitFor(() => manager.pendingCount() > 0, 3000);

    const done = manager.getStatus(taskId);
    expect(done!.status).toBe('completed');
    expect(done!.finishedAt).toBeTruthy();
  });

  it('getStatus: 不存在的 ID 返回 null', () => {
    expect(manager.getStatus('nonexistent')).toBeNull();
  });

  it('list: 列出所有任务', () => {
    manager.run('echo a');
    manager.run('echo b');

    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list[0].command).toBe('echo a');
    expect(list[1].command).toBe('echo b');
  });

  it('drain: 取出后清空队列', async () => {
    manager.run('echo drain-test');

    await waitFor(() => manager.pendingCount() > 0, 3000);

    const first = manager.drainNotifications();
    expect(first).toHaveLength(1);

    const second = manager.drainNotifications();
    expect(second).toHaveLength(0);
  });

  it('timeout: 超时任务标记为 timeout', async () => {
    // 用一个会超时的命令（sleep 10s，超时设为 500ms）
    manager.run('sleep 10', { timeoutMs: 500 });

    await waitFor(() => manager.pendingCount() > 0, 5000);

    const notifications = manager.drainNotifications();
    expect(notifications[0].status).toBe('timeout');
  }, 10000);

  it('error: 不存在的命令标记为 error', async () => {
    manager.run('this_command_definitely_does_not_exist_xyz');

    await waitFor(() => manager.pendingCount() > 0, 3000);

    const notifications = manager.drainNotifications();
    expect(notifications[0].status).toBe('error');
  });

  it('preview: 截断到 500 字符', async () => {
    // 生成超过 500 字符的输出
    const longText = 'x'.repeat(1000);
    manager.run(`echo ${longText}`);

    await waitFor(() => manager.pendingCount() > 0, 3000);

    const notifications = manager.drainNotifications();
    expect(notifications[0].preview.length).toBeLessThanOrEqual(500);
  });

  // ── 超时 vs exit 竞态稳定性（flaky 回归防护）──
  // 根因：超时回调 child.kill('SIGTERM') 后，close 事件（非零退出码 → error）
  // 可能抢先于 finishTask('timeout') 执行，导致误标 error。
  // 本测试重复跑多次，放大竞态窗口，确保每次都正确标记 timeout。
  it('timeout: 多次超时均标记为 timeout（无 SIGTERM/close 竞态误标 error）', async () => {
    const TRIALS = 5;
    const results: string[] = [];
    for (let i = 0; i < TRIALS; i++) {
      manager.run('sleep 30', { timeoutMs: 100 });
      await waitFor(() => manager.pendingCount() > 0, 5000);
      const notifs = manager.drainNotifications();
      results.push(notifs[0]?.status ?? '(none)');
    }
    // 每次（包括竞态最激烈的第一次）都必须是 timeout，不能是 error
    for (let i = 0; i < TRIALS; i++) {
      expect(results[i], `trial ${i}: 超时任务被误标为 ${results[i]}（应为 timeout）`).toBe('timeout');
    }
  }, 30000);
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
