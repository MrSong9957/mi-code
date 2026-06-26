// runIdleLoop：队友空闲循环（双源轮询版）
//
// 物理本质：员工干完活后坐在工位上等新任务。
// 先看信箱（有人找我吗？），再看任务板（有我能干的活吗？）。
// 收到关机通知 → 回复确认 → 下班走人。
// 收到新任务 → 打开笔记本 → 继续干活。
// 等太久没人理 → 自动下班（超时）。

import type { MessageBus } from './message-bus.js';
import type { TodoManager } from '../todo.js';

export interface IdleLoopOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number;
  /** 双源轮询：传入 TodoManager 后会自动扫描任务板 */
  todoManager?: TodoManager;
  /** 队友角色，用于角色匹配认领 */
  role?: string;
}

export interface IdleLoopResult {
  exitReason: 'shutdown' | 'new_task' | 'timeout';
  shutdownRequestId?: string;
  taskMessage?: string;
  /** 自动认领的任务 ID（如果有） */
  claimedTaskId?: string;
}

/**
 * 队友空闲循环（双源轮询）
 *
 * 优先级 1：检查收件箱（紧急协议消息不被饿死）
 * 优先级 2：扫描任务板（主动找活）
 * 超时：没有任何输入则退出
 */
export async function runIdleLoop(
  name: string,
  bus: MessageBus,
  options: IdleLoopOptions = {},
): Promise<IdleLoopResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    // 优先级 1：检查收件箱
    const messages = bus.readInbox(name);
    if (messages.length > 0) {
      for (const msg of messages) {
        if (msg.type === 'shutdown_request') {
          bus.send(name, msg.from, 'Shutting down.', 'shutdown_response', msg.requestId);
          return { exitReason: 'shutdown', shutdownRequestId: msg.requestId };
        }
        if (msg.type === 'message' || msg.type === 'broadcast') {
          return { exitReason: 'new_task', taskMessage: msg.content };
        }
      }
    }

    // 优先级 2：扫描任务板主动找活
    if (options.todoManager) {
      const claimable = options.todoManager.scanClaimable(options.role);
      if (claimable.length > 0) {
        const task = claimable[0];
        const result = options.todoManager.claim(task.id, name, 'auto');
        if (result.startsWith('Claimed')) {
          return {
            exitReason: 'new_task',
            taskMessage: `Task #${task.id}: ${task.content}`,
            claimedTaskId: task.id,
          };
        }
        // 认领失败（被别人抢了），继续轮询
      }
    }
  }

  return { exitReason: 'timeout' };
}
