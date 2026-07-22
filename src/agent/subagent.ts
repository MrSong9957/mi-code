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

import { existsSync } from 'fs';
import { join } from 'path';
import { runWithVercelAI } from './llm-vercel.js';
import { streamingQuery } from './streaming-query.js';
import { StreamEventBus } from './stream-event-bus.js';
import { ToolRegistry } from './tool-registry.js';
import type { RegisteredTool, StreamingLLMClient } from './types.js';
import { ROLE_REGISTRY, filterToolsByRole, type Role } from './roles.js';
import type { PermissionChecker } from '../permission/checker.js';

/**
 * 用工具子集构建一个新的 ToolRegistry（streamingQuery 需要 registry.execute）。
 *
 * streamingQuery 走主 agent 路径，对工具的并发分区/执行依赖 ToolRegistry 完整接口，
 * 而非原始 Map。这里把角色过滤后的工具重新注册进一个干净的 registry。
 */
function buildSubRegistry(toolSubset: Map<string, RegisteredTool>): ToolRegistry {
  const registry = new ToolRegistry();
  for (const { definition, executor } of toolSubset.values()) {
    registry.register(definition, executor);
  }
  return registry;
}

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
  /**
   * 角色：'explore' | 'plan' | 'general'。
   * 设置后套用 ROLE_REGISTRY 的 systemPrompt + 工具白名单。
   * 未设置或传 system 字段时，行为与原版一致（全量工具 + 默认 prompt）。
   */
  role?: Role;
  /**
   * 权限检查器：透传给 runWithVercelAI，让子代理也受 PermissionChecker 约束。
   * 不传则子代理工具调用裸跑（向后兼容，但不推荐生产用）。
   */
  permissionChecker?: PermissionChecker;
  /**
   * 流式 LLM 客户端（多 provider 支持）。
   *
   * 物理本质：子代理的"工作证件"。主 agent 按 provider 配置分发到 anthropic/openai/google
   * 等流式客户端；子代理复用同一套 client，从而支持 OpenAI 兼容的 MiMo 等非 Anthropic provider。
   *
   * 传入时走主 agent 的 streamingQuery 路径（多 provider，修复子代理写死 Anthropic 的 bug）；
   * 不传时回退到 runWithVercelAI（向后兼容，仅 Anthropic，测试路径用）。
   */
  client?: StreamingLLMClient;
  /**
   * 可用技能描述（注入 system prompt，让子代理发现/调用技能）。
   * 由主 agent 通过 skillRegistry.describeAvailable() 生成，spawn-agent-tool 透传。
   */
  skillsDescription?: string;
}

export type SubagentStatus = 'completed' | 'incomplete' | 'unverified' | 'background';

export interface SubagentEvidence {
  toolCallCount: number;
  successfulToolResultCount: number;
}

export interface SubagentResult {
  text: string;
  isBackground: boolean;
  status: SubagentStatus;
  terminationReason: string;
  evidence: SubagentEvidence;
}

const EVIDENCE_TOOLS = new Set([
  'read_file', 'run_bash', 'memory_read', 'memory_list', 'read_plan_file',
]);

function isSuccessfulEvidence(name: string, output: string): boolean {
  return EVIDENCE_TOOLS.has(name)
    && !/^\s*(?:\[Tool Error\]|\[Blocked|Error:)/i.test(output);
}

/** 共享的文件读取状态（跨子代理） */
const sharedFileState = new Map<string, string>();

/**
 * 在角色 system prompt 后追加环境信息 + 行为约束（对齐 CC enhanceSystemPromptWithEnvDetails）。
 *
 * CC 追加：绝对路径要求、emoji 禁令、tool call 前不用冒号、CWD/平台/Shell/git 仓库检测。
 * 这些约束让子代理输出更规范（绝对路径方便主 agent 定位文件）。
 */
export function enhanceSubagentSystemPrompt(
  baseSystem: string,
  options?: { skillsDescription?: string },
): string {
  const lines = [
    baseSystem,
    '',
    'Notes:',
    '- Use absolute file paths in your responses.',
    '- Do not use emojis.',
    '- Do not use a colon before tool calls.',
    `- Working directory: ${process.cwd()}`,
    `- Platform: ${process.platform}`,
    `- Shell: ${process.env.SHELL ?? process.env.ComSpec ?? 'unknown'}`,
    `- Is a git repository: ${existsSync(join(process.cwd(), '.git'))}`,
  ];
  if (options?.skillsDescription) {
    lines.push('', `Available skills:\n${options.skillsDescription}`);
  }
  return lines.join('\n');
}

/**
 * 用流式客户端（streamingQuery）执行子代理。
 *
 * 复用主 agent 的 streamingQuery 路径，从而支持 OpenAI/Google/MiMo 等非 Anthropic provider。
 * 返回子代理输出的最终文本（累加所有 assistant 文本块，行为对齐 runWithVercelAI 的 .text）。
 *
 * 物理本质：临时工走正门，和正式员工用同一套门禁（provider 分发）。
 */
async function runSubagentWithClient(
  client: StreamingLLMClient,
  toolSubset: Map<string, RegisteredTool>,
  prompt: string,
  system: string,
  options: SubagentOptions,
): Promise<{ text: string; toolCallCount: number; successfulToolResultCount: number; terminationReason: string }> {
  const controller = new AbortController();
  // 子代理作为有限步循环：显式 maxSteps 作为安全网（默认 10，对齐 Vercel 回退路径）
  const maxTurns = options.maxSteps || 10;

  const subRegistry = buildSubRegistry(toolSubset);

  let resultText = '';
  // 收集工具调用信息，用于 maxTurns 耗尽且无文本输出时的 fallback 摘要
  const toolCallNames: string[] = [];
  let toolCallCount = 0;
  let successfulToolResultCount = 0;

  // 用 StreamEventBus 捕获真实终止原因（end_turn / max_turns / user_abort / error）
  const eventBus = new StreamEventBus();
  let terminationReason = 'unknown';
  const onLoopEnd = ({ reason }: { reason: string }) => { terminationReason = reason; };
  eventBus.onLoopEnd(onLoopEnd);

  try {
    for await (const message of streamingQuery(client, subRegistry, prompt, {
    systemPrompt: system,
    tools: Array.from(toolSubset.values()).map(t => t.definition),
    signal: controller.signal,
    maxTurns,
    permissionChecker: options.permissionChecker,
    model: options.model,
    eventBus,
  })) {
    if (message !== null && typeof message === 'object' && 'type' in message) {
      if (message.type === 'assistant') {
        const content = (message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          let turnText = '';
          for (const block of content) {
            if (block !== null && typeof block === 'object' && 'type' in block) {
              const bt = (block as { type: string }).type;
              if (bt === 'text') {
                const text = (block as { text?: string }).text;
                if (text) turnText += text;
              } else if (bt === 'tool_use') {
                const name = (block as { name?: string }).name;
                if (name) {
                  toolCallNames.push(name);
                  toolCallCount++;
                }
              }
            }
          }
          if (turnText.trim()) resultText = turnText;
        }
      } else if (message.type === 'tool_result') {
        const tr = message as { name?: string; output?: string };
        if (tr.name && tr.output && isSuccessfulEvidence(tr.name, tr.output)) {
          successfulToolResultCount++;
        }
      }
    }
  }
  } finally {
    eventBus.offLoopEnd(onLoopEnd);
  }
  // 模型可能只调工具不输出文字（某些 GLM/MiMo 行为），用工具调用信息兜底
  if (!resultText && toolCallNames.length > 0) {
    const counts: Record<string, number> = {};
    for (const n of toolCallNames) counts[n] = (counts[n] ?? 0) + 1;
    const summary = Object.entries(counts).map(([n, c]) => `${n}${c > 1 ? `×${c}` : ''}`).join(', ');
    return {
      text: `Sub-agent completed ${toolCallNames.length} tool call(s) [${summary}] — no explicit text summary produced.`,
      toolCallCount,
      successfulToolResultCount,
      terminationReason,
    };
  }
  return { text: resultText || '(no summary)', toolCallCount, successfulToolResultCount, terminationReason };
}

/**
 * 根据执行证据和终止原因，判定子代理最终状态并格式化安全返回值。
 */
function finalizeSubagentExecution(
  text: string,
  isBackground: boolean,
  role: Role | undefined,
  execution: { toolCallCount: number; successfulToolResultCount: number; terminationReason: string },
): SubagentResult {
  const base = { isBackground, evidence: { toolCallCount: execution.toolCallCount, successfulToolResultCount: execution.successfulToolResultCount } };

  if (isBackground) {
    return { text: '[Subagent launched in background]', ...base, status: 'background', terminationReason: 'background' };
  }

  // max_turns / user_abort / error 优先于 explore 证据门槛
  if (execution.terminationReason !== 'end_turn') {
    const reasonLabel = execution.terminationReason === 'max_turns'
      ? `reached max turns`
      : execution.terminationReason === 'user_abort'
        ? 'aborted by user'
        : `terminated: ${execution.terminationReason}`;
    return {
      text: `[Subagent incomplete: ${reasonLabel}] ${text || '(no final text)'}`,
      ...base,
      status: 'incomplete',
      terminationReason: execution.terminationReason,
    };
  }

  if (role === 'explore' && execution.successfulToolResultCount === 0) {
    return {
      text: '[Subagent unverified] Explore agent produced no successful evidence tool result. Retry with read_file or read-only run_bash.',
      ...base,
      status: 'unverified',
      terminationReason: execution.terminationReason,
    };
  }

  return { text, ...base, status: 'completed', terminationReason: execution.terminationReason };
}

/**
 * 运行子代理
 */
export async function runSubagent(
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions = {},
): Promise<SubagentResult> {
  // system 选择优先级：显式 system > 角色预设 > 默认
  const system = options.system
    || (options.role ? ROLE_REGISTRY[options.role].systemPrompt : null)
    || 'You are a helpful subagent. Complete the task and return a concise summary.';

  // 工具子集：按角色过滤（role 未设置时全量，向后兼容）
  const toolSubset: Map<string, RegisteredTool> = filterToolsByRole(tools.tools, options.role);

  // Fork 模式：使用父代理的 system 触发 prompt cache
  const baseSystem = options.forkMode && options.parentSystem
    ? options.parentSystem
    : system;
  // 追加环境信息 + 行为约束（对齐 CC enhanceSystemPromptWithEnvDetails）
  const effectiveSystem = enhanceSubagentSystemPrompt(baseSystem, {
    skillsDescription: options.skillsDescription,
  });

  // 异步后台执行
  if (options.runInBackground) {
    runSubagentBackground(prompt, toolSubset, options, effectiveSystem);
    return {
      text: '[Subagent launched in background]',
      isBackground: true,
      status: 'background',
      terminationReason: 'background',
      evidence: { toolCallCount: 0, successfulToolResultCount: 0 },
    };
  }

  // 同步执行（在指定 cwd 下运行，结束后恢复）
  const prevCwd = options.cwd ? process.cwd() : null;
  if (options.cwd) process.chdir(options.cwd);
  try {
    let text: string;
    let toolCallCount = 0;
    let successfulToolResultCount = 0;
    let terminationReason = 'end_turn';
    if (options.client) {
      // 多 provider 路径：走主 agent 的 streamingQuery，支持 OpenAI/MiMo 等
      const exec = await runSubagentWithClient(options.client, toolSubset, prompt, effectiveSystem, options);
      text = exec.text;
      toolCallCount = exec.toolCallCount;
      successfulToolResultCount = exec.successfulToolResultCount;
      terminationReason = exec.terminationReason;
    } else {
      // 回退：Vercel AI SDK（仅 Anthropic；测试路径/向后兼容）
      const result = await runWithVercelAI(prompt, toolSubset, {
        model: options.model,
        maxSteps: options.maxSteps || 10,
        system: effectiveSystem,
        permissionChecker: options.permissionChecker,
      });
      text = result.text || '(no summary)';
    }

    // 克隆文件读取状态到共享池
    if (options.readFileState) {
      for (const [key, value] of options.readFileState) {
        sharedFileState.set(key, value);
      }
    }

    return finalizeSubagentExecution(text, false, options.role, {
      toolCallCount,
      successfulToolResultCount,
      terminationReason,
    });
  } finally {
    if (prevCwd) process.chdir(prevCwd);
  }
}

/**
 * 后台执行子代理
 */
async function runSubagentBackground(
  prompt: string,
  toolSubset: Map<string, RegisteredTool>,
  options: SubagentOptions,
  system: string,
): Promise<void> {
  try {
    let text: string;
    if (options.client) {
      // 多 provider 路径（后台执行同样支持 OpenAI/MiMo 等）
      text = await runSubagentWithClient(options.client, toolSubset, prompt, system, options);
    } else {
      const result = await runWithVercelAI(prompt, toolSubset, {
        model: options.model,
        maxSteps: options.maxSteps || 10,
        system,
        permissionChecker: options.permissionChecker,
      });
      text = result.text || '(no summary)';
    }
    if (options.onBackgroundComplete) {
      options.onBackgroundComplete(text);
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
