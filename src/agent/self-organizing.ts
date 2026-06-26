// 自组织子代理：WORK/IDLE 生命周期
//
// 物理本质：一个会自己找活干的临时工。
// 干完活 → 举手说"没事了" → 自己看看板 → 有活就认领 → 没活等 60 秒 → 走人。

import { runWithVercelAI } from './llm-vercel.js';
import type { ToolRegistry } from './tool-registry.js';
import type { TodoManager } from './todo.js';
import type { InboxManager } from './inbox.js';

export interface SelfOrganizingOptions {
  model?: string;
  idleTimeout?: number;   // 空闲超时（毫秒），默认 60000
  pollInterval?: number;  // 轮询间隔（毫秒），默认 5000
  maxWorkTurns?: number;  // 单次工作阶段最大轮数，默认 50
}

const DEFAULT_IDLE_TIMEOUT = 60000;
const DEFAULT_POLL_INTERVAL = 5000;
const DEFAULT_MAX_WORK_TURNS = 50;

/**
 * 运行自组织子代理
 *
 * 生命周期：
 * 1. WORK 阶段：执行任务，直到调用 idle 或无工具调用
 * 2. IDLE 阶段：轮询收件箱和任务看板
 *    - 有消息 → 回到 WORK
 *    - 有未认领任务 → 认领并回到 WORK
 *    - 超时 → 关闭
 */
export async function runSelfOrganizingSubagent(
  name: string,
  role: string,
  identity: string,
  tools: ToolRegistry,
  todoManager: TodoManager,
  inboxManager: InboxManager,
  options: SelfOrganizingOptions = {},
): Promise<string> {
  const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
  const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const maxWorkTurns = options.maxWorkTurns ?? DEFAULT_MAX_WORK_TURNS;

  let prompt = `You are ${name}, a ${role}. ${identity}`;
  const statusUpdates: string[] = [];

  while (true) {
    // === WORK 阶段 ===
    setStatus(name, 'working', statusUpdates);

    const systemPrompt = buildSystemPrompt(name, role, identity);
    const result = await runWithVercelAI(prompt, tools.tools, {
      model: options.model,
      system: systemPrompt,
      maxSteps: maxWorkTurns,
    });

    const output = result.text || '';

    // 检查是否请求 idle
    const requestedIdle = output.includes('IDLE_REQUESTED') || result.steps < maxWorkTurns;

    if (!requestedIdle) {
      return output || `${name} completed work.`;
    }

    // === IDLE 阶段 ===
    setStatus(name, 'idle', statusUpdates);

    const idleStart = Date.now();
    let resumed = false;

    while (Date.now() - idleStart < idleTimeout) {
      await sleep(pollInterval);

      // 检查收件箱
      if (inboxManager.hasMessages(name)) {
        const messages = inboxManager.receive(name);
        prompt = messages.map(m => `[From ${m.from}] ${m.content}`).join('\n');
        resumed = true;
        break;
      }

      // 扫描任务看板
      const unclaimed = todoManager.getUnclaimed();
      if (unclaimed.length > 0) {
        const task = unclaimed[0]!;
        todoManager.claim(task.id, name);
        prompt = `New task claimed: ${task.content}`;
        resumed = true;
        break;
      }
    }

    if (!resumed) {
      setStatus(name, 'shutdown', statusUpdates);
      return `${name} shutdown after ${idleTimeout / 1000}s idle timeout.`;
    }
  }
}

function buildSystemPrompt(name: string, role: string, identity: string): string {
  return [
    `You are ${name}, a ${role}.`,
    identity,
    '',
    'When you finish your current task and have nothing to do, call the idle tool.',
    'You can claim unassigned tasks from the todo list using claim_task.',
  ].join('\n');
}

function setStatus(name: string, status: string, updates: string[]): void {
  updates.push(`[${new Date().toISOString()}] ${name}: ${status}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
