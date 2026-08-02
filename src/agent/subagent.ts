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
import { recoverSubagentWork, type SubagentJournal } from './subagent-journal.js';
import { formatUnknownError } from '../utils/error-message.js';
import type { RegisteredTool, StreamingLLMClient } from './types.js';
import { ROLE_REGISTRY, filterToolsByRole, type Role } from './roles.js';
import type { ToolExecutionRuntime } from './tool-execution.js';
import type { NormalizedEnvironmentSnapshot } from './context/intake/environment.js';
import {
  normalizeEnvironmentSnapshot,
  formatNormalizedEnvironment,
} from './context/intake/environment.js';
import {
  createCompletionReport,
  createDispatchReceipt,
  type CompletionReport,
  type CompletionOutcome,
  type DispatchReceipt,
  type DeliverableReport,
  type VerificationLevel,
  type VerificationStatus,
  type VerificationFailureKind,
} from './contracts/completion-report.js';

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
   * Wave B Task 9:显式 platform family(如 'linux' / 'darwin' / 'win32')。
   * 用于构建 NormalizedEnvironmentSnapshot 注入 system prompt,避免
   * `enhanceSubagentSystemPrompt` 直接读 process.platform。未传时回退到
   * process.platform(legacy 行为,集中在一处读取)。
   */
  platform?: string;
  /**
   * Wave B Task 9:显式 shell family(如 '/bin/zsh' / 'cmd.exe')。
   * null 表示"未观测到 shell"。未传(undefined)时回退到
   * process.env.SHELL ?? process.env.ComSpec ?? null。
   */
  shell?: string | null;
  /**
   * 角色：'explore' | 'plan' | 'general'。
   * 设置后套用 ROLE_REGISTRY 的 systemPrompt + 工具白名单。
   * 未设置或传 system 字段时，行为与原版一致（全量工具 + 默认 prompt）。
   */
  role?: Role;
  executionRuntime: ToolExecutionRuntime;
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
  /**
   * RC-4 Wave A: 显式 subject id，用于 `runSubagentContracted` 生成的
   * CompletionReport.subject.id。未传时默认 `'subagent:' + (role ?? 'general')`。
   */
  subject_id?: string;
  /**
   * RC-4 Wave A: 显式证据引用（test refs / file refs），透传给分类器。
   * 未传时为空数组（legacy SubagentResult 不携带 test refs）。
   */
  evidence_refs?: string[];
  /**
   * RC-4 Wave A: 显式交付物列表，透传给分类器。
   * 未传时为空数组（legacy SubagentResult 不携带 deliverables）。
   */
  deliverables?: DeliverableReport[];
  /**
   * 子代理工作日志:把每条已完成的消息边界 awaited 落盘。
   *
   * provider 崩溃 / final turn 交白卷时,runSubagent 从 journal.load() 恢复已完成
   * 的工作(已配对的工具结果 + assistant 文本),用有界内联文本替换 `(no final text)`。
   * 不传时(LEGACY,直接调用 runSubagent 的测试)行为不变。
   */
  journal?: SubagentJournal;
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

// ────────────────────────────────────────────────────────────────────────────
// RC-4 Completion Contract (Wave A) — new discriminated union return path.
//
// `SubagentResult` above is the LEGACY internal computation shape (kept for
// backwards compat with existing tests/non-migrated callers). The new public
// contract for the spawn-agent tool output and `runSubagentContracted` is the
// `SubagentExecutionResult` discriminated union below: either a foreground
// `CompletionReport` or a background `DispatchReceipt` (never a loose merge).
//
// See docs/superpowers/specs/2026-07-26-agent-foundation-wave-a-design.md §10.6
// for the migration table these types implement.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Structured evidence the classifier consumes to pick a `CompletionOutcome`.
 *
 * NOTE: every field here is STRUCTURED — the classifier MUST NOT parse machine
 * state out of the `summary` text or any `[Subagent ...]` prefix. `summary` is
 * purely descriptive and flows through to `CompletionReport.summary` verbatim.
 */
export interface SubagentExecutionEvidence {
  subject_id: string;
  termination_reason: 'end_turn' | 'max_turns' | 'user_abort' | 'error';
  required_level: VerificationLevel;
  achieved_level: VerificationLevel | null;
  evidence_refs: string[];
  deliverables: DeliverableReport[];
  summary: string;
}

/**
 * The new public return type for the migrated subagent path. A discriminated
 * union: either a foreground completion report or a background dispatch receipt.
 * Callers MUST branch on `kind` explicitly — never merge the two variants.
 */
export type SubagentExecutionResult =
  | { kind: 'completion'; report: CompletionReport }
  | { kind: 'dispatch'; receipt: DispatchReceipt };

/**
 * Local copy of the VerificationLevel ranking.
 *
 * Source of truth is `LEVEL_RANK` in `src/agent/contracts/completion-report.ts`,
 * which is intentionally not re-exported from here to keep this module's import
 * surface minimal. The two maps MUST stay in sync — "no string comparison for
 * levels" is a cross-cutting rule, so if completion-report.ts adds a level,
 * update SUBAGENT_LEVEL_RANK here too.
 */
const SUBAGENT_LEVEL_RANK: Record<VerificationLevel, number> = {
  V0: 0,
  V1: 1,
  V2: 2,
  V3: 3,
};

/**
 * RC-4 §10.6 classifier: pick a {@link CompletionOutcome} from structured
 * {@link SubagentExecutionEvidence}, then delegate to {@link createCompletionReport}
 * which validates consistency.
 *
 * This is a PURE function: it reads only the structured fields of `execution`.
 * It does NOT inspect `execution.summary` for machine state, and it does NOT
 * parse any `[Subagent ...]` text prefix. The summary is passed through to the
 * report verbatim (descriptive only).
 *
 * Invariants enforced by the classification (delegated validation in
 * createCompletionReport):
 *  - Never produces `completed + user_abort`.
 *  - Never produces `completed` when `achieved_level` is null or below
 *    `required_level`, or when `evidence_refs` is empty.
 *  - Never produces a top-level `incomplete`/`unverified`/`background` outcome
 *    (those are legacy SubagentStatus values, not CompletionOutcome values).
 */
export function classifySubagentCompletion(
  execution: SubagentExecutionEvidence,
): CompletionReport {
  const subject = { kind: 'subagent' as const, id: execution.subject_id };
  const protocol_version = '1';
  // Wave A: the classifier does not infer remaining_uncertainty. Callers that
  // need it can extend the report later.
  const remaining_uncertainty: string[] = [];

  let outcome: CompletionOutcome;
  let verification_status: VerificationStatus;
  let failure_kind: VerificationFailureKind | null;

  const hasVerifiedDeliverable = execution.deliverables.some(
    (d) => d.evidence_refs.length > 0,
  );

  if (execution.termination_reason === 'user_abort') {
    // §10.6: cancelled keeps achieved evidence; status blocked; failure_kind repairable.
    outcome = 'cancelled';
    verification_status = 'blocked';
    failure_kind = 'repairable';
  } else if (execution.termination_reason === 'end_turn') {
    const levelMet =
      execution.achieved_level !== null
      && SUBAGENT_LEVEL_RANK[execution.achieved_level] >= SUBAGENT_LEVEL_RANK[execution.required_level];
    if (levelMet && execution.evidence_refs.length > 0) {
      outcome = 'completed';
      verification_status = 'passed';
      failure_kind = null;
    } else if (hasVerifiedDeliverable) {
      outcome = 'partial';
      verification_status = 'blocked';
      failure_kind = 'repairable';
    } else {
      outcome = 'failed';
      verification_status = 'failed';
      failure_kind = 'blocked';
    }
  } else if (execution.termination_reason === 'max_turns') {
    if (hasVerifiedDeliverable) {
      outcome = 'partial';
      verification_status = 'blocked';
      failure_kind = 'repairable';
    } else {
      outcome = 'failed';
      verification_status = 'failed';
      failure_kind = 'blocked';
    }
  } else {
    // termination_reason === 'error'
    if (hasVerifiedDeliverable) {
      outcome = 'partial';
      verification_status = 'failed';
      failure_kind = 'repairable';
    } else {
      outcome = 'failed';
      verification_status = 'failed';
      failure_kind = 'unrecoverable';
    }
  }

  // Delegate to the validator. If our classification is consistent this
  // succeeds; if it throws, that's a bug in this classifier — do NOT swallow.
  return createCompletionReport({
    protocol_version,
    subject,
    outcome,
    termination_reason: execution.termination_reason,
    verification: {
      required_level: execution.required_level,
      achieved_level: execution.achieved_level,
      status: verification_status,
      evidence_refs: execution.evidence_refs,
      failure_kind,
    },
    deliverables: execution.deliverables,
    summary: execution.summary,
    remaining_uncertainty,
  });
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
 *
 * ── Wave B Task 9 迁移说明 ──
 *
 * 该函数过去直接读取 `process.cwd()` / `process.platform` / `process.env.SHELL` /
 * `process.env.ComSpec`,这让单元测试无法稳定断言"system prompt 反映了某个
 * NormalizedEnvironmentSnapshot 而不是真实运行环境"。
 *
 * 现在新增可选的 `options.environment` 参数:当调用方传入一个
 * {@link NormalizedEnvironmentSnapshot} 时,本函数 **只** 通过
 * `formatNormalizedEnvironment(snapshot)` 渲染环境段,**不再** 读取
 * `process.cwd/platform/env`。这是 BRC-3 + RC-5 推荐的迁移路径。
 *
 * 向后兼容:未传 `environment` 时,走 legacy 路径(读 process.cwd/platform/env)。
 * 这是为现有非迁移调用方保留的;Wave C+ 调用方应总是通过 `runSubagent` 间接调用,
 * 由 `runSubagent` 在 **唯一一处** 构造 NormalizedEnvironmentSnapshot 后显式传入。
 *
 * 这样把 process.env 的直接读取从"散落在 enhanceSubagentSystemPrompt 内部"
 * 收敛到"runSubagent 集中一处构造 snapshot"——函数本身在有 environment 时是纯函数。
 */
export function enhanceSubagentSystemPrompt(
  baseSystem: string,
  options?: {
    skillsDescription?: string;
    /** BRC-3 normalized snapshot —— 传入时不再读 process.env。 */
    environment?: NormalizedEnvironmentSnapshot;
  },
): string {
  const lines = [
    baseSystem,
    '',
    'Notes:',
    '- Use absolute file paths in your responses.',
    '- Do not use emojis.',
    '- Do not use a colon before tool calls.',
  ];

  if (options?.environment) {
    // BRC-3 路径:只读 snapshot,绝不读 process.cwd/platform/env。
    lines.push(formatNormalizedEnvironment(options.environment));
  } else {
    // Legacy 路径(未传 environment):保留原行为,向后兼容现有调用方与测试。
    // Wave C+ 应避免直接调用此函数而不传 environment。
    lines.push(`- Working directory: ${process.cwd()}`);
    lines.push(`- Platform: ${process.platform}`);
    lines.push(`- Shell: ${process.env.SHELL ?? process.env.ComSpec ?? 'unknown'}`);
    lines.push(`- Is a git repository: ${existsSync(join(process.cwd(), '.git'))}`);
  }

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
interface SubagentExecutionProgress {
  toolCallCount: number;
  successfulToolResultCount: number;
}

async function runSubagentWithClient(
  client: StreamingLLMClient,
  toolSubset: Map<string, RegisteredTool>,
  prompt: string,
  system: string,
  options: SubagentOptions,
  progress: SubagentExecutionProgress,
): Promise<{ text: string; toolCallCount: number; successfulToolResultCount: number; terminationReason: string; finalTurnSynthesized?: boolean }> {
  const controller = new AbortController();
  // 子代理作为有限步循环：显式 maxSteps 作为安全网（默认 10，对齐 Vercel 回退路径）
  const maxTurns = options.maxSteps || 10;

  const subRegistry = buildSubRegistry(toolSubset);

  let resultText = '';
  // 收集工具调用信息，用于 maxTurns 耗尽且无文本输出时的 fallback 摘要
  const toolCallNames: string[] = [];
  // AUTO-0025 Task 4:子代理默认启用"无工具最终总结轮"(仅在 maxTurns 已定义时生效)。
  // 物理本质:让临时工在工时耗尽前,用已收集的证据写一份正式总结,
  // 而不是把"Now let me check..."这种过程句当成交付物。
  const reserveFinalTextTurn = true;

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
    // Intentional behavior change: child `ask` decisions use the main
    // RuntimeSecurityGate and wait for explicit approval.
    executionRuntime: options.executionRuntime,
    // 子代理路径:ask 静默分流(不弹 channel),deny/allow 透传。
    origin: 'subagent',
    model: options.model,
    eventBus,
    reserveFinalTextTurn,
    // 子代理工作日志:每完成一条消息边界 awaited 落盘。
    // fail-fast:checkpoint 写失败会抛错,runSubagent 的 catch 块将其转为 incomplete/error。
    onMessageCheckpoint: options.journal
      ? messages => options.journal!.checkpoint(messages)
      : undefined,
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
                  progress.toolCallCount++;
                }
              }
            }
          }
          if (turnText.trim()) resultText = turnText;
        }
      } else if (message.type === 'tool_result') {
        const tr = message as { name?: string; output?: string };
        if (tr.name && tr.output && isSuccessfulEvidence(tr.name, tr.output)) {
          progress.successfulToolResultCount++;
        }
      }
    }
  }
  } finally {
    eventBus.offLoopEnd(onLoopEnd);
  }
  // AUTO-0025 Task 4:判断 final turn 是否真的产出了基于证据的总结。
  //
  // 物理语义:end_turn 退出 + resultText 非空 = 模型在 final turn 用工具结果写了总结。
  // 若 end_turn 但 resultText 空,说明 final turn 模型"交白卷"——标记为未合成,
  // 让 finalizeSubagentExecution 判为 incomplete(不再用旧的工具调用兜底摘要冒充结果)。
  //
  // 关键边界:只有当 maxTurns >= 2(reserveFinalTextTurn 有机会生效)时,
  // finalTurnSynthesized 才参与判定。maxTurns < 2 时根本没机会进入 final turn,
  // 此时 finalTurnSynthesized 为 undefined,不影响既有的 terminationReason 判定。
  const finalTurnWasActive = reserveFinalTextTurn && maxTurns >= 2;
  const finalTurnSynthesized = finalTurnWasActive
    ? (terminationReason === 'end_turn' && resultText.trim().length > 0)
    : undefined;

  // 模型可能只调工具不输出文字（某些 GLM/MiMo 行为），用工具调用信息兜底。
  // 但 reserveFinalTextTurn 启用时,若 final turn 没产出文本,不走此兜底——
  // 否则会把"模型交白卷"伪装成"已完成 N 个工具调用",与 final summary 语义冲突。
  if (!resultText && toolCallNames.length > 0 && !reserveFinalTextTurn) {
    const counts: Record<string, number> = {};
    for (const n of toolCallNames) counts[n] = (counts[n] ?? 0) + 1;
    const summary = Object.entries(counts).map(([n, c]) => `${n}${c > 1 ? `×${c}` : ''}`).join(', ');
    return {
      text: `Sub-agent completed ${toolCallNames.length} tool call(s) [${summary}] — no explicit text summary produced.`,
      toolCallCount: progress.toolCallCount,
      successfulToolResultCount: progress.successfulToolResultCount,
      terminationReason,
      finalTurnSynthesized,
    };
  }
  return {
    text: resultText || '(no final text)',
    toolCallCount: progress.toolCallCount,
    successfulToolResultCount: progress.successfulToolResultCount,
    terminationReason,
    finalTurnSynthesized,
  };
}

/**
 * 根据执行证据和终止原因，判定子代理最终状态并格式化安全返回值。
 */
function finalizeSubagentExecution(
  text: string,
  isBackground: boolean,
  role: Role | undefined,
  execution: { toolCallCount: number; successfulToolResultCount: number; terminationReason: string; finalTurnSynthesized?: boolean },
): SubagentResult {
  const base = { isBackground, evidence: { toolCallCount: execution.toolCallCount, successfulToolResultCount: execution.successfulToolResultCount } };

  if (isBackground) {
    return { text: '[Subagent launched in background]', ...base, status: 'background', terminationReason: 'background' };
  }

  // AUTO-0025 Task 4:reserveFinalTextTurn 启用但 final turn 没合成文本 → incomplete。
  // 物理本质:工时耗尽前给了临时工"写总结"的机会,但他交了白卷——不算完成。
  // 即使 terminationReason 是 end_turn(模型自主结束了),没有总结文本就是没交付。
  if (execution.finalTurnSynthesized === false) {
    return {
      text: `[Subagent incomplete: no final summary] ${text || '(no final text)'}`,
      ...base,
      status: 'incomplete',
      // 用 max_turns 表达"轮次耗尽且未产出总结"——比 end_turn 更准确反映未完成
      terminationReason: 'max_turns',
    };
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
  options: SubagentOptions,
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

  // ── Wave B Task 9:集中在一处构造 NormalizedEnvironmentSnapshot,──
  // ── 然后显式传给 enhanceSubagentSystemPrompt,避免该函数直接读 process.env。
  //
  // 物理本质:把"环境观测"从 enhanceSubagentSystemPrompt 内部下沉到 runSubagent。
  // 这样 enhanceSubagentSystemPrompt 在有 environment 入参时是纯函数(可测试)。
  //
  // 显式输入优先(options.platform / options.shell / options.cwd);未传时回退到
  // process.* —— 这是"集中一处读取"的妥协,不在 enhanceSubagentSystemPrompt 里
  // 再次读取。allowed_fields / privacy_omitted_fields 在 Wave B 设为空集
  // (子代理默认不携带额外观测字段;Wave C+ 可由调用方注入)。
  const envCwd = options.cwd ?? process.cwd();
  const envSnapshot = normalizeEnvironmentSnapshot(
    {
      environment_snapshot_id: 'subagent-env-1',
      platform_family: options.platform ?? process.platform,
      shell_family: options.shell ?? process.env.SHELL ?? process.env.ComSpec ?? null,
      workspace_root: envCwd,
      working_directory: envCwd,
      repository_present: existsSync(join(envCwd, '.git')),
      observed_at: new Date().toISOString(),
      collected_fields: {},
    },
    { allowed_fields: new Set(), privacy_omitted_fields: new Set() },
  );

  // 追加环境信息 + 行为约束（对齐 CC enhanceSystemPromptWithEnvDetails）
  const effectiveSystem = enhanceSubagentSystemPrompt(baseSystem, {
    skillsDescription: options.skillsDescription,
    environment: envSnapshot,
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

  // 证据变量提到 try 外：catch 和正常返回共享它们。
  // provider 异常发生时，本轮已积累的工具调用证据仍应反映在回执里。
  const executionProgress: SubagentExecutionProgress = {
    toolCallCount: 0,
    successfulToolResultCount: 0,
  };
  let finalTurnSynthesized: boolean | undefined;

  try {
    let text: string;
    let terminationReason = 'end_turn';
    if (options.client) {
      // 多 provider 路径：走主 agent 的 streamingQuery，支持 OpenAI/MiMo 等
      const exec = await runSubagentWithClient(
        options.client,
        toolSubset,
        prompt,
        effectiveSystem,
        options,
        executionProgress,
      );
      text = exec.text;
      terminationReason = exec.terminationReason;
      finalTurnSynthesized = exec.finalTurnSynthesized;
    } else {
      // 回退：Vercel AI SDK（仅 Anthropic；测试路径/向后兼容）
      const result = await runWithVercelAI(prompt, toolSubset, {
        model: options.model,
        maxSteps: options.maxSteps || 10,
        system: effectiveSystem,
        // E4 deferred: the Vercel fallback still consumes only the checker.
        permissionChecker: options.executionRuntime.permissionChecker,
      });
      text = result.text || '(no summary)';
    }

    // 克隆文件读取状态到共享池
    if (options.readFileState) {
      for (const [key, value] of options.readFileState) {
        sharedFileState.set(key, value);
      }
    }

    // 子代理工作日志恢复:final turn 未合成总结时,从 journal 恢复已完成的工作,
    // 用恢复文本替换 `(no final text)`。无 journal 或无恢复内容时保持原行为。
    if (finalTurnSynthesized === false && options.journal) {
      const recovered = recoverSubagentWork(
        await options.journal.load(),
        options.journal.reference,
      );
      if (recovered.text) {
        text = recovered.text;
      }
    }

    return finalizeSubagentExecution(text, false, options.role, {
      toolCallCount: executionProgress.toolCallCount,
      successfulToolResultCount: executionProgress.successfulToolResultCount,
      terminationReason,
      finalTurnSynthesized,
    });
  } catch (error) {
    // 核心生命周期边界：provider/流式异常统一转换为 incomplete/error 回执，
    // 而非让 promise reject。runSubagent 的契约是"始终返回 SubagentResult"。
    //
    // 子代理工作日志恢复:provider 崩溃后,从 journal 加载已完成的工作,
    // 用 `${errorText}\n${recovered.text}` 组合回执(恢复内容在前,错误信息在后)。
    // 保留 terminationReason: 'error' —— 不因恢复到工具结果就假装任务完成。
    const errorText = formatUnknownError(error);
    const recovered = options.journal
      ? recoverSubagentWork(
          await options.journal.load(),
          options.journal.reference,
        )
      : { text: '', successfulToolResults: 0 };
    const text = recovered.text
      ? `${errorText}\n${recovered.text}`
      : errorText;
    return finalizeSubagentExecution(
      text,
      false,
      options.role,
      {
        toolCallCount: executionProgress.toolCallCount,
        successfulToolResultCount: executionProgress.successfulToolResultCount,
        terminationReason: 'error',
        finalTurnSynthesized,
      },
    );
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
      const exec = await runSubagentWithClient(
        options.client,
        toolSubset,
        prompt,
        system,
        options,
        { toolCallCount: 0, successfulToolResultCount: 0 },
      );
      text = exec.text;
    } else {
      const result = await runWithVercelAI(prompt, toolSubset, {
        model: options.model,
        maxSteps: options.maxSteps || 10,
        system,
        // E4 deferred: the Vercel fallback still consumes only the checker.
        permissionChecker: options.executionRuntime.permissionChecker,
      });
      text = result.text || '(no summary)';
    }
    if (options.onBackgroundComplete) {
      options.onBackgroundComplete(text);
    }
  } catch (err) {
    if (options.onBackgroundComplete) {
      options.onBackgroundComplete(`[Subagent error] ${formatUnknownError(err)}`);
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

// ────────────────────────────────────────────────────────────────────────────
// RC-4 Completion Contract (Wave A) — migrated entry point.
//
// `runSubagent` (above) returns the LEGACY `SubagentResult`. `runSubagentContracted`
// wraps it and produces the new `SubagentExecutionResult` discriminated union:
//   - background dispatch → `{ kind: 'dispatch', receipt }` (no outcome)
//   - foreground completion → `{ kind: 'completion', report }` via classifySubagentCompletion
//
// The legacy `runSubagent` is kept UNCHANGED so existing tests/callers stay green.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Monotonic counter for default subject_id / task_id derivation.
 * Avoids randomness: ids are deterministic within a process run.
 */
let subagentContractCounter = 0;

/**
 * Migrated entry point: run a subagent and return the new
 * {@link SubagentExecutionResult} discriminated union.
 *
 * Wraps the legacy {@link runSubagent} (which returns `SubagentResult`) and
 * adapts:
 *  - `result.isBackground === true` → `{ kind: 'dispatch', receipt }` via
 *    {@link createDispatchReceipt}. No outcome is produced (background has not
 *    finished).
 *  - otherwise → build {@link SubagentExecutionEvidence} from the legacy result
 *    and call {@link classifySubagentCompletion}, returning
 *    `{ kind: 'completion', report }`.
 *
 * Conservative evidence mapping from `SubagentResult` (documented because the
 * legacy shape carries less information than the new contract):
 *  - `subject_id`: `options.subject_id` ?? `'subagent:' + (options.role ?? 'general')`.
 *  - `termination_reason`: mapped from `result.terminationReason`. Legacy values
 *    include `'unknown'` (mapped to `'error'` conservatively) and `'background'`
 *    (handled by the dispatch branch above, never reaches the classifier).
 *  - `required_level`: hardcoded `'V2'` for Wave A (subagent must demonstrate
 *    V2 = unit+integration). Update when callers can express per-task levels.
 *  - `achieved_level`: `'V1'` when `successfulToolResultCount > 0` else `null`.
 *    V1 = at least one successful tool result; V2 requires explicit test
 *    evidence which the legacy SubagentResult does not carry, so we cap at V1
 *    unless the caller supplies `evidence_refs`/`deliverables` via options.
 *  - `evidence_refs`/`deliverables`: from options (default empty).
 *  - `summary`: `result.text`.
 */
export async function runSubagentContracted(
  prompt: string,
  tools: ToolRegistry,
  options: SubagentOptions,
): Promise<SubagentExecutionResult> {
  const result = await runSubagent(prompt, tools, options);

  if (result.isBackground) {
    // Background dispatch → DispatchReceipt, no outcome.
    const taskId = options.subject_id
      ?? `subagent:${options.role ?? 'general'}:${++subagentContractCounter}`;
    const receipt = createDispatchReceipt({
      protocol_version: '1',
      task_id: taskId,
      accepted: true,
    });
    return { kind: 'dispatch', receipt };
  }

  // Foreground completion → classify.
  // Map legacy terminationReason onto the classifier's narrower union.
  let termination_reason: 'end_turn' | 'max_turns' | 'user_abort' | 'error';
  switch (result.terminationReason) {
    case 'end_turn':
    case 'max_turns':
    case 'user_abort':
    case 'error':
      termination_reason = result.terminationReason;
      break;
    default:
      // 'unknown' / any other value → conservative 'error'.
      termination_reason = 'error';
  }

  const subject_id = options.subject_id
    ?? `subagent:${options.role ?? 'general'}`;

  // Conservative achieved_level: V1 if any successful tool result, else null.
  // V2 requires explicit test evidence which legacy SubagentResult lacks.
  const achieved_level: VerificationLevel | null =
    result.evidence.successfulToolResultCount > 0 ? 'V1' : null;

  const execution: SubagentExecutionEvidence = {
    subject_id,
    termination_reason,
    // Wave A: subagent must demonstrate V2 (unit + integration).
    required_level: 'V2',
    achieved_level,
    evidence_refs: options.evidence_refs ?? [],
    deliverables: options.deliverables ?? [],
    summary: result.text,
  };

  const report = classifySubagentCompletion(execution);
  return { kind: 'completion', report };
}
