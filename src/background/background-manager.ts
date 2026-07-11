// BackgroundManager：管理后台任务的启动、完成通知和状态查询
//
// 物理本质：快递中转站的调度员。
// 你把包裹（命令）交给他，他立刻给你一个单号（task_id）。
// 包裹在后台传送带上跑（子进程），跑完后调度员在通知板上贴一张便签。
// 你下次来中转站时，扫一眼通知板就知道哪些包裹到了。
// 完整的包裹详情存在仓库里（.log 文件），通知板只写摘要。

import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { RuntimeTaskRecord, Notification, TaskStatus } from './types.js';

const PREVIEW_MAX_LEN = 500;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 分钟
const DEFAULT_ZOMBIE_TIMEOUT_MS = 300_000; // 5 分钟无输出 → 僵尸
const ZOMBIE_CHECK_INTERVAL_MS = 30_000; // 每 30 秒检查一次

export interface RunOptions {
  timeoutMs?: number;
}

export interface BackgroundManagerOptions {
  /** 僵尸检测超时（毫秒）：任务超过此时间无 stdout 输出则判定为僵尸 */
  zombieTimeoutMs?: number;
  /** 僵尸检测间隔（毫秒），默认 30000 */
  zombieCheckIntervalMs?: number;
}

export class BackgroundManager {
  private tasksDir: string;
  private tasks = new Map<string, RuntimeTaskRecord>();
  private notifications: Notification[] = [];
  private processes = new Map<string, ChildProcess>();
  /** 被超时/僵尸机制主动 kill 的 task id（区分「被超时杀」vs「自然崩溃」）。
   *  解决 SIGTERM → close 事件竞态：close handler 看到此标志时优先判 timeout。 */
  private killedByManager = new Set<string>();
  private zombieTimer: ReturnType<typeof setInterval> | null = null;
  private zombieTimeoutMs: number;
  private zombieCheckIntervalMs: number;

  constructor(workDir: string, options: BackgroundManagerOptions = {}) {
    this.tasksDir = join(workDir, '.runtime-tasks');
    mkdirSync(this.tasksDir, { recursive: true });
    this.zombieTimeoutMs = options.zombieTimeoutMs ?? DEFAULT_ZOMBIE_TIMEOUT_MS;
    this.zombieCheckIntervalMs = options.zombieCheckIntervalMs ?? ZOMBIE_CHECK_INTERVAL_MS;
    this._startZombieWatcher();
  }

  /** 启动僵尸检测定时器 */
  private _startZombieWatcher(): void {
    this.zombieTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, task] of this.tasks) {
        if (task.status !== 'running') continue;
        const lastActive = task.lastActivityAt ?? Date.parse(task.startedAt);
        if (now - lastActive > this.zombieTimeoutMs) {
          // 僵尸：强制击杀
          const child = this.processes.get(id);
          if (child) {
            this.killedByManager.add(id);
            child.kill('SIGKILL');
            this.processes.delete(id);
          }
          this.finishTask(id, 'timeout', 'zombie detected: no output for too long');
        }
      }
    }, this.zombieCheckIntervalMs);

    // 不阻止 Node 进程退出
    if (this.zombieTimer?.unref) this.zombieTimer.unref();
  }

  /** 生成短 ID */
  private newId(): string {
    return randomBytes(4).toString('hex');
  }

  /** 启动后台命令，立刻返回 task_id */
  run(command: string, options: RunOptions = {}): string {
    const id = this.newId();
    const logFile = join(this.tasksDir, `${id}.log`);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const now = Date.now();
    const record: RuntimeTaskRecord = {
      id,
      command,
      status: 'running',
      startedAt: new Date(now).toISOString(),
      outputFile: logFile,
      lastActivityAt: now,
    };
    this.tasks.set(id, record);

    // 写入初始 JSON 记录和空 log 文件
    const jsonFile = join(this.tasksDir, `${id}.json`);
    writeFileSync(jsonFile, JSON.stringify(record, null, 2), 'utf8');
    writeFileSync(logFile, '', 'utf8');

    // 在 shell 中执行命令，stdout/stderr 合并写入 log 文件
    const child = spawn(command, [], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    this.processes.set(id, child);

    // 收集输出写入 log 文件（try-catch 防止进程退出后写入已删除的文件）
    const safeAppend = (data: Buffer) => {
      try {
        appendFileSync(logFile, data);
        // 更新心跳时间戳（用于僵尸检测）
        const task = this.tasks.get(id);
        if (task) task.lastActivityAt = Date.now();
      } catch { /* file deleted */ }
    };
    child.stdout?.on('data', safeAppend);
    child.stderr?.on('data', safeAppend);

    // 超时定时器
    // 先置 killedByManager 标志再 kill，防止 close 事件竞态抢先标记 error。
    // （SIGTERM 触发的 close 事件可能先于此处的 finishTask 执行）
    const timer = setTimeout(() => {
      this.killedByManager.add(id);
      child.kill('SIGTERM');
      this.finishTask(id, 'timeout', 'command timed out');
    }, timeoutMs);

    // 进程结束处理
    child.on('close', (code) => {
      clearTimeout(timer);
      this.processes.delete(id);

      // 如果已经被超时处理过，跳过
      const task = this.tasks.get(id);
      if (!task || task.status !== 'running') return;

      // 竞态防护：被超时/僵尸机制 kill 的进程，即使 close 带非零码也判 timeout。
      // （此分支只在 finishTask('timeout') 尚未执行时到达——即 close 抢先）
      if (this.killedByManager.has(id)) {
        this.killedByManager.delete(id);
        this.finishTask(id, 'timeout', 'command timed out');
        return;
      }
      this.killedByManager.delete(id);

      if (code === 0) {
        let preview = '(no output)';
        try {
          const full = readFileSync(logFile, 'utf8');
          preview = full.length > PREVIEW_MAX_LEN
            ? full.slice(0, PREVIEW_MAX_LEN)
            : full;
        } catch {
          // ignore
        }
        this.finishTask(id, 'completed', preview);
      } else if (code === null) {
        // code=null 表示进程被信号终止（非自然退出）。
        // 全量测试并发压力下，外部信号/OS 资源回收可能杀掉子进程，
        // 此时既非命令自身错误（code≠0）也非正常完成（code=0），判 timeout 更准确
        // （信号终止 ≈ 被外部强制结束）。这也修了 flaky：sleep 被信号杀时不再误标 error。
        this.finishTask(id, 'timeout', 'process terminated by signal');
      } else {
        let preview = `exit code: ${code}`;
        try {
          const full = readFileSync(logFile, 'utf8');
          if (full.length > 0) {
            preview = full.length > PREVIEW_MAX_LEN
              ? full.slice(0, PREVIEW_MAX_LEN)
              : full;
          }
        } catch {
          // ignore
        }
        this.finishTask(id, 'error', preview);
      }
    });

    // spawn 失败处理
    child.on('error', (err) => {
      clearTimeout(timer);
      this.processes.delete(id);
      // 竞态防护：超时/僵尸 kill 可能触发 error 事件（Windows 下信号不支持等），
      // 此时必须判 timeout，不能让 error 覆盖（flaky 根因）。
      // finishTask 的幂等保护也会拦住已被处理的 task，但这里优先判 timeout 语义更正确。
      if (this.killedByManager.has(id)) {
        this.killedByManager.delete(id);
        this.finishTask(id, 'timeout', 'command timed out');
        return;
      }
      this.finishTask(id, 'error', err.message);
    });

    return id;
  }

  /** 完成任务：更新记录 + 写通知 + 持久化。
   *  幂等：task 已是终态时直接返回，防止 close/error/timeout 竞态重复 push notification
   *  或后到的 error 覆盖先到的 timeout（flaky 根因）。 */
  private finishTask(id: string, status: TaskStatus, preview: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    // 幂等保护：已完成的任务不再处理（防竞态重复通知 / 状态覆盖）
    if (task.status !== 'running') return;

    task.status = status;
    task.finishedAt = new Date().toISOString();
    task.preview = preview.length > PREVIEW_MAX_LEN
      ? preview.slice(0, PREVIEW_MAX_LEN)
      : preview;

    // 更新 JSON 文件
    const jsonFile = join(this.tasksDir, `${id}.json`);
    writeFileSync(jsonFile, JSON.stringify(task, null, 2), 'utf8');

    // 写入通知队列
    this.notifications.push({
      type: 'background_completed',
      taskId: id,
      status,
      preview: task.preview,
    });
  }

  /** 取出并清空通知队列 */
  drainNotifications(): Notification[] {
    const result = [...this.notifications];
    this.notifications = [];
    return result;
  }

  /** 待处理通知数量（不清空队列） */
  pendingCount(): number {
    return this.notifications.length;
  }

  /** 查询单个任务状态 */
  getStatus(taskId: string): RuntimeTaskRecord | null {
    return this.tasks.get(taskId) ?? null;
  }

  /** 列出所有任务 */
  list(): RuntimeTaskRecord[] {
    return [...this.tasks.values()];
  }

  /** 获取所有正在运行的任务 ID */
  getRunningTaskIds(): string[] {
    const ids: string[] = [];
    for (const [id, task] of this.tasks) {
      if (task.status === 'running') ids.push(id);
    }
    return ids;
  }

  /** 取出通知并聚合成单条结构化消息（供 loop 注入） */
  drainNotificationsAggregated(): string | null {
    const notifs = this.drainNotifications();
    if (notifs.length === 0) return null;

    const label = notifs.length === 1 ? '1 task' : `${notifs.length} tasks`;
    const lines = notifs.map(n => `- ${n.taskId} (${this.tasks.get(n.taskId)?.command ?? '?'}): ${n.status}${n.preview ? ' - ' + n.preview.slice(0, 200) : ''}`);
    return `[BACKGROUND] ${label} completed:\n${lines.join('\n')}`;
  }

  /** 终止所有后台进程 */
  killAll(): void {
    for (const [id, child] of this.processes) {
      child.kill('SIGTERM');
      this.finishTask(id, 'error', 'killed by manager');
    }
    this.processes.clear();
    if (this.zombieTimer) {
      clearInterval(this.zombieTimer);
      this.zombieTimer = null;
    }
  }
}
