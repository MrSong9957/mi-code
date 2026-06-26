// 子代理：用独立 messages[] 运行，上下文隔离
//
// 物理本质：请一个"临时工"帮忙干活。
// 临时工有自己的笔记本（messages[]），干完活笔记本直接扔掉。
// 你只拿到他写的总结报告（摘要文本）。
//
// 新版特性：
// 1. Fork 模式：共享缓存友好前缀，触发 API prompt cache
// 2. 上下文克隆：继承父代理的文件读取状态
// 3. 异步后台执行：run_in_background 支持

import { runWithVercelAI } from './llm-vercel.js';
import type { ToolRegistry } from './tool-registry.js';

export interface SubagentOptions {
  model?: string;
  maxSteps?: number;
  system?: string;
  /** Fork 模式：共享父代理的 system prompt + tools 触发 prompt cache */
  forkMode?: boolean;
  /** 父代理的 system prompt（用于 fork 模式） */
  parentSystem?: string;
  /** 克隆父代理的文件读取状态 */
  readFileState?: Map<string, string>;
  /** 后台执行：立即返回，完成后通过回调通知 */
  runInBackground?: boolean;
  /** 后台完成回调 */
  onBackgroundComplete?: (result: string) => void;
  /**
   * 工作目录：子代理在其下执行所有 bash/文件操作（worktree 隔离）。
   * 执行期间切换 process.cwd()，结束后恢复。
   */
  cwd?: string;
}

export interface SubagentResult {
  text: string;
  isBackground: boolean;
}

/** 共享的文件读取状态（跨子代理） */
const sharedFileState = new Map<string, string>();

/**
 * 运行子代理
 */
export async function runSubagent(
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions = {},
): Promise<SubagentResult> {
  const system = options.system || 'You are a helpful subagent. Complete the task and return a concise summary.';

  // Fork 模式：使用父代理的 system 触发 prompt cache
  const effectiveSystem = options.forkMode && options.parentSystem
    ? options.parentSystem
    : system;

  // 异步后台执行
  if (options.runInBackground) {
    runSubagentBackground(prompt, tools, options, effectiveSystem);
    return { text: '[Subagent launched in background]', isBackground: true };
  }

  // 同步执行（在指定 cwd 下运行，结束后恢复）
  const prevCwd = options.cwd ? process.cwd() : null;
  if (options.cwd) process.chdir(options.cwd);
  try {
    const result = await runWithVercelAI(prompt, tools.tools, {
      model: options.model,
      maxSteps: options.maxSteps || 10,
      system: effectiveSystem,
    });

    // 克隆文件读取状态到共享池
    if (options.readFileState) {
      for (const [key, value] of options.readFileState) {
        sharedFileState.set(key, value);
      }
    }

    return { text: result.text || '(no summary)', isBackground: false };
  } finally {
    if (prevCwd) process.chdir(prevCwd);
  }
}

/**
 * 后台执行子代理
 */
async function runSubagentBackground(
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions,
  system: string,
): Promise<void> {
  try {
    const result = await runWithVercelAI(prompt, tools.tools, {
      model: options.model,
      maxSteps: options.maxSteps || 10,
      system,
    });
    if (options.onBackgroundComplete) {
      options.onBackgroundComplete(result.text || '(no summary)');
    }
  } catch (err) {
    if (options.onBackgroundComplete) {
      options.onBackgroundComplete(`[Subagent error] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * 获取共享的文件读取状态
 */
export function getSharedFileState(): Map<string, string> {
  return sharedFileState;
}

/**
 * 从父代理克隆文件读取状态
 */
export function cloneReadFileState(parentState?: Map<string, string>): Map<string, string> {
  const cloned = new Map<string, string>();
  if (parentState) {
    for (const [key, value] of parentState) {
      cloned.set(key, value);
    }
  }
  for (const [key, value] of sharedFileState) {
    if (!cloned.has(key)) cloned.set(key, value);
  }
  return cloned;
}
