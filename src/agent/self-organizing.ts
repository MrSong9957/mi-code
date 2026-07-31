// 自组织子代理：WORK/IDLE 生命周期
//
// 物理本质：一个会自己找活干的临时工。
// 干完活 → 举手说"没事了" → 自己看看板 → 有活就认领 → 没活等 60 秒 → 走人。
//
// provider 支持：传入 client 时走 streamingQuery（多 provider），
// 不传则回退 runWithVercelAI（仅 Anthropic，向后兼容/测试用）。

import { runWithVercelAI } from './llm-vercel.js';
import { streamingQuery } from './streaming-query.js';
import { ToolRegistry } from './tool-registry.js';
import type { RegisteredTool, StreamingLLMClient } from './types.js';
import type { TodoManager } from './todo.js';
import type { InboxManager } from './inbox.js';

export interface SelfOrganizingOptions {
  model?: string;
  /** 流式 LLM 客户端（多 provider 支持）。传入时走 streamingQuery。 */
  client?: StreamingLLMClient;
  executionRuntime: import('./tool-execution.js').ToolExecutionRuntime;
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
  options: SelfOrganizingOptions,
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

    let output: string;
    if (options.client) {
      // 多 provider 路径：走 streamingQuery
      output = await runSelfOrganizingWithClient(options.client, tools.tools, prompt, systemPrompt, maxWorkTurns, options);
    } else {
      // 回退：Vercel AI SDK（仅 Anthropic）
      const result = await runWithVercelAI(prompt, tools.tools, {
        model: options.model,
        system: systemPrompt,
        maxSteps: maxWorkTurns,
      });
      output = result.text || '';
    }

    // 检查是否请求 idle
    // Vercel 回退路径用 result.steps < maxWorkTurns 判断是否提前结束（= idle 请求）。
    // client 路径没有 steps 计数，仅靠 IDLE_REQUESTED 标记判断。
    const requestedIdle = output.includes('IDLE_REQUESTED');

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

/**
 * 用 streamingQuery 执行自组织子代理的单次 WORK 阶段（多 provider 支持）。
 *
 * 复用 subagent.ts 的模式：构造 subRegistry、遍历 generator 收集 assistant 文本。
 */
async function runSelfOrganizingWithClient(
  client: StreamingLLMClient,
  toolSubset: Map<string, RegisteredTool>,
  prompt: string,
  system: string,
  maxTurns: number,
  options: SelfOrganizingOptions,
): Promise<string> {
  const controller = new AbortController();
  // 构造一个干净的 ToolRegistry（streamingQuery 需要 registry.execute 完整接口）
  const subRegistry = new ToolRegistry();
  for (const { definition, executor } of toolSubset.values()) {
    subRegistry.register(definition, executor);
  }

  let resultText = '';
  for await (const message of streamingQuery(client, subRegistry, prompt, {
    systemPrompt: system,
    tools: Array.from(toolSubset.values()).map(t => t.definition),
    signal: controller.signal,
    maxTurns,
    // Intentional behavior change: child `ask` decisions use the main
    // RuntimeSecurityGate and wait for explicit approval.
    executionRuntime: options.executionRuntime,
    model: options.model,
  })) {
    if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'assistant') {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block !== null && typeof block === 'object' && 'type' in block && (block as { type: string }).type === 'text') {
            const text = (block as { text?: string }).text;
            if (text) resultText += text;
          }
        }
      }
    }
  }
  return resultText || '';
}
