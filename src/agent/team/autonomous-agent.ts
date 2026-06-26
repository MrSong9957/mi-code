// runAutonomousAgent：队友生命周期循环
//
// 物理本质：一个有自主意识的员工。
// 干完活 → 坐下等新任务 → 看信箱 → 看任务板 → 有活就干 → 没活就下班。
// 身份被压缩了？重新自我介绍。
// Lead 说关机？回复确认，收拾东西走人。

import type { MessageBus } from './message-bus.js';
import type { TodoManager } from '../todo.js';
import { runIdleLoop, type IdleLoopResult } from './idle-loop.js';

export interface AutonomousAgentOptions {
  /** 最大 WORK 轮数（防死循环） */
  maxWorkRounds?: number;
  /** idle 轮询间隔 */
  pollIntervalMs?: number;
  /** idle 超时时间 */
  idleTimeoutMs?: number;
  /** 任务管理器（启用主动找活） */
  todoManager?: TodoManager;
  /** 工作回调：每轮 WORK 阶段调用，返回 true 表示任务完成 */
  onWork?: () => Promise<boolean>;
}

export interface AutonomousAgentResult {
  reason: 'shutdown' | 'timeout' | 'max_rounds';
  summary: string;
  workRounds: number;
}

/**
 * 队友自主生命周期循环
 *
 * WORK → IDLE → 判断是否继续 → WORK → ... → SHUTDOWN
 */
export async function runAutonomousAgent(
  name: string,
  role: string,
  bus: MessageBus,
  options: AutonomousAgentOptions = {},
): Promise<AutonomousAgentResult> {
  const maxWorkRounds = options.maxWorkRounds ?? 10;
  let workRounds = 0;
  let totalTasks = 0;

  while (true) {
    // === WORK 阶段 ===
    if (options.onWork) {
      for (let round = 0; round < maxWorkRounds; round++) {
        const done = await options.onWork();
        workRounds++;
        if (done) break;
      }
    }

    // === IDLE 阶段（双源轮询）===
    const idleResult: IdleLoopResult = await runIdleLoop(name, bus, {
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      maxWaitMs: options.idleTimeoutMs ?? 60_000,
      todoManager: options.todoManager,
      role,
    });

    // 收到关机指令
    if (idleResult.exitReason === 'shutdown') {
      const summary = `Agent "${name}" (${role}) shutting down. Completed ${totalTasks} tasks in ${workRounds} rounds.`;
      bus.send(name, 'lead', summary, 'result');
      return { reason: 'shutdown', summary, workRounds };
    }

    // 超时退出
    if (idleResult.exitReason === 'timeout') {
      const summary = `Agent "${name}" (${role}) timed out. Completed ${totalTasks} tasks in ${workRounds} rounds.`;
      bus.send(name, 'lead', summary, 'result');
      return { reason: 'timeout', summary, workRounds };
    }

    // 收到新任务，继续 WORK 循环
    if (idleResult.claimedTaskId) {
      totalTasks++;
    }

    // 防止无限循环
    if (workRounds >= maxWorkRounds * 3) {
      const summary = `Agent "${name}" (${role}) hit max rounds. Completed ${totalTasks} tasks.`;
      bus.send(name, 'lead', summary, 'result');
      return { reason: 'max_rounds', summary, workRounds };
    }
  }
}
