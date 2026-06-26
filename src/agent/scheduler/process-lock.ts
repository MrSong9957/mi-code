// ProcessLock：进程级单例锁
//
// 物理本质：门上的"使用中"牌子。
// 一个进程挂上牌子（acquire），其他进程看到牌子就退出。
// 进程结束时摘下牌子（release）。如果进程异常退出，
// 下次启动时检查牌子上的 pid 是否还活着，活着就等，死了就抢。

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';

interface LockData {
  pid: number;
  time: number;
}

export class ProcessLock {
  private lockPath: string;
  private locked = false;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  /** 尝试获取锁。成功返回 true，已被其他活进程持有返回 false */
  acquire(): boolean {
    if (this.locked) return true;

    if (existsSync(this.lockPath)) {
      try {
        const data: LockData = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        // 检查持有锁的进程是否还活着
        if (isProcessAlive(data.pid)) {
          return false; // 还活着，不能抢
        }
        // 进程已死，清理残留锁
        try { unlinkSync(this.lockPath); } catch { /* ignore */ }
      } catch {
        // 锁文件损坏，清理
        try { unlinkSync(this.lockPath); } catch { /* ignore */ }
      }
    }

    // 写入锁文件
    const data: LockData = { pid: process.pid, time: Date.now() };
    writeFileSync(this.lockPath, JSON.stringify(data), 'utf8');
    this.locked = true;
    return true;
  }

  /** 释放锁 */
  release(): void {
    if (!this.locked) return;
    try {
      unlinkSync(this.lockPath);
    } catch { /* ignore */ }
    this.locked = false;
  }

  /** 是否持有锁 */
  isLocked(): boolean {
    return this.locked;
  }
}

/** 检查进程是否存活（发送信号 0） */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
