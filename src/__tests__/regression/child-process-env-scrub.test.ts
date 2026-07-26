// 回归测试：M-063 子进程环境清洗——真实 spawn 路径
//
// 物理本质：安检名单是否真的在通关时生效。
//   单元测试验证 decideChildProcessEnvironment 的逻辑；
//   本测试验证 createBashTool() 和 BackgroundManager.run() 这两个真实 spawn
//   入口确实：
//     1. 用 sanitized env 启动（子进程能跑——PATH 还在）；
//     2. secret 环境变量不泄漏到子进程 stdout。
//
// 关键不变量：父进程设置的 TEST_API_KEY=leaked-secret-* 必须不出现在
// 子进程 `env` (unix) / `set` (windows) 的输出里——既不能有 value，也不能有 NAME。
//
// 平台注意：用 process.platform 切换命令与断言；不支持的平台上 it.skip。

import { describe, it, expect, afterEach } from 'vitest';
import { createBashTool } from '../../agent/tool-registry.js';
import { BackgroundManager } from '../../background/background-manager.js';
import { existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SECRET_NAME = 'TEST_API_KEY';
const SECRET_VALUE = 'leaked-secret-DO-NOT-APPEAR-xyz-999';

/** 设置父进程 secret，确保子进程若继承就会泄漏。 */
function plantSecret(): void {
  process.env[SECRET_NAME] = SECRET_VALUE;
}

/** 清理父进程 secret。 */
function clearSecret(): void {
  delete process.env[SECRET_NAME];
}

const isWindows = process.platform === 'win32';

// 等待 background 任务完成通知
async function waitFor<T>(fn: () => T | null, timeoutMs: number): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('M-063 child-process env scrubbing — real spawn paths', () => {
  afterEach(() => {
    clearSecret();
  });

  // ─────────────────────────────────────────────
  // createBashTool
  // ─────────────────────────────────────────────
  describe('createBashTool spawn passes sanitized env', () => {
    it('child can still execute (PATH survived scrubbing)', async () => {
      const bash = createBashTool();
      const out = await bash.executor({ command: isWindows ? 'echo hello' : 'echo hello' });
      expect(out.trim()).toContain('hello');
    });

    it('secret env var does NOT leak to child stdout (env / set)', async () => {
      plantSecret();
      const bash = createBashTool();
      // env (unix) / set (windows) both dump the child's environment.
      const cmd = isWindows ? 'set' : 'env';
      const out = await bash.executor({ command: cmd });
      expect(out).not.toContain(SECRET_VALUE);
      // The NAME must also not appear (it should have been stripped entirely).
      expect(out).not.toContain(SECRET_NAME);
    }, 15000);
  });

  // ─────────────────────────────────────────────
  // BackgroundManager.run
  // ─────────────────────────────────────────────
  describe('BackgroundManager.run spawn passes sanitized env', () => {
    let workDir: string;
    let manager: BackgroundManager;

    afterEach(() => {
      try {
        manager?.killAll();
      } catch {
        /* ignore */
      }
      if (workDir) {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('background child can still execute (PATH survived scrubbing)', async () => {
      workDir = join(tmpdir(), `bg-envscrub-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      manager = new BackgroundManager(workDir);
      const id = manager.run('echo bg-hello');
      const notif = await waitFor(
        () => (manager.pendingCount() > 0 ? manager.drainNotifications()[0] : null),
        5000,
      );
      expect(notif).toBeTruthy();
      expect(notif!.status).toBe('completed');
      // Read full log file to confirm output
      const task = manager.getStatus(id);
      expect(task).toBeTruthy();
      expect(task!.outputFile).toBeTruthy();
      const content = readFileSync(task!.outputFile, 'utf8');
      expect(content).toContain('bg-hello');
    });

    it('secret env var does NOT leak to background child log', async () => {
      plantSecret();
      workDir = join(tmpdir(), `bg-envscrub-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      manager = new BackgroundManager(workDir);
      const cmd = isWindows ? 'set' : 'env';
      manager.run(cmd);

      const notif = await waitFor(
        () => (manager.pendingCount() > 0 ? manager.drainNotifications()[0] : null),
        8000,
      );
      expect(notif).toBeTruthy();

      // Read full log (preview may be truncated, so check the underlying file).
      const list = manager.list();
      const task = list[0];
      expect(task).toBeTruthy();
      expect(existsSync(task!.outputFile)).toBe(true);
      const content = readFileSync(task!.outputFile, 'utf8');
      expect(content).not.toContain(SECRET_VALUE);
      expect(content).not.toContain(SECRET_NAME);
    }, 15000);
  });
});
