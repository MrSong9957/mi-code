// classifier direct provider RPC（Task 4 / 设计 §7.3 PermissionClassifierProvider 边界）
//
// 物理本质：classifier 到底层 provider 的“直拨电话”。只做一次 RPC + 参数翻译，
// 原样上抛 raw response，不解析 decision、不 trim、不容错、不调用 model policy。
//
// 真实 provider API 适配：现有 StreamingLLMClient 只有 stream()（流式），
// 没有 completeText。DirectProviderTextClient 是新增契约——adapter（在 stream-clients
// 中实现，Task 4 不接线生产 adapter）从 stream 事件收集 text block，拼成完整 text 返回。
// classifier-provider 只消费该契约，不依赖具体 provider SDK。
//
// 不变量（设计 §7.3）：
//   - invoke(): Promise<unknown> —— 原样上抛底层返回值（默认 string）；
//   - 不持有 ToolRegistry / RuntimeSecurityGate / Agent state / messageSink / TuiCallback；
//   - capability 只来自静态 adapter/config 声明，unknown -> unsupported，禁止 discovery RPC；
//   - unsupported hint 直接省略，不改变权限协议。

import type { ModelRef } from './classifier-model-policy.js';

/**
 * provider 静态 capability 声明（设计 §7.3）。
 * 只能由各 provider adapter 或已有 provider config 静态声明；
 * 未声明/缺失/未知一律视为 unsupported。
 */
export interface ClassifierProviderCapabilities {
  /** 是否支持显式关闭 reasoning/thinking */
  readonly reasoningControl: boolean;
  /** provider 允许的最小输出 token 预算（advisory，可为 1） */
  readonly minimumOutputTokens?: number;
  /** 是否支持确定性/低方差 decoding（temperature=0） */
  readonly decodingControl: boolean;
  /** 是否支持 prompt cache（复用固定前缀） */
  readonly promptCache: boolean;
}

/**
 * 一次 classifier provider RPC 请求。
 * stage 决定 reasoning hint（Stage1 disabled，Stage2 enabled）。
 */
export interface ClassifierProviderRequest {
  readonly stage: 1 | 2;
  readonly model: ModelRef;
  readonly prefix: string;
  readonly instruction: string;
  readonly signal: AbortSignal;
  readonly reasoning?: 'disabled' | 'enabled';
  readonly maxOutputTokens?: number;
  readonly temperature?: 0;
}

/**
 * classifier provider 接口（设计 §7.3）。
 * invoke 返回原始 unknown（adapter 通常返回 string）；decision 解析由 classifier.ts 负责。
 */
export interface PermissionClassifierProvider {
  readonly capabilities: ClassifierProviderCapabilities;
  invoke(request: ClassifierProviderRequest): Promise<unknown>;
}

/**
 * 底层 direct text client 契约（adapter 实现）。
 * completeText 只返回 raw response string，不做 ALLOW/FLAG 解析、不 trim、不容错。
 * Task 4 定义契约；adapter 接线（从 stream 收集 text）超出本 Task 范围。
 */
export interface DirectProviderTextClient {
  completeText(request: {
    readonly model: ModelRef;
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly reasoning?: 'disabled' | 'enabled';
    readonly maxOutputTokens?: number;
    readonly temperature?: 0;
  }): Promise<string>;
}

/** 返回全 unsupported 的 capability（unknown/缺失时的归一化结果） */
export function unsupportedClassifierCapabilities(): ClassifierProviderCapabilities {
  return { reasoningControl: false, decodingControl: false, promptCache: false };
}

/**
 * 归一化静态 capability：undefined/缺失 -> unsupported；
 * 已声明 -> 透传（minimumOutputTokens 保留可选）。
 * 不发任何 discovery RPC。
 */
export function normalizeStaticClassifierCapabilities(
  caps: ClassifierProviderCapabilities | undefined,
): ClassifierProviderCapabilities {
  if (!caps) return unsupportedClassifierCapabilities();
  return {
    reasoningControl: !!caps.reasoningControl,
    decodingControl: !!caps.decodingControl,
    promptCache: !!caps.promptCache,
    ...(caps.minimumOutputTokens !== undefined ? { minimumOutputTokens: caps.minimumOutputTokens } : {}),
  };
}

/**
 * 构建 classifier provider request（设计 §7.3）。
 *
 * 根据 stage 与静态 capability 选择性加入 reasoning/output/decoding hints：
 *   - reasoningControl=true -> Stage1 reasoning='disabled'，Stage2 reasoning='enabled'；
 *   - minimumOutputTokens 声明 -> maxOutputTokens=该值（adapter 允许的最小值，可为 1）；
 *   - decodingControl=true -> temperature=0。
 * unsupported hint 直接省略（不发 discovery RPC，不改变协议）。
 */
export function buildClassifierProviderRequest(
  stage: 1 | 2,
  model: ModelRef,
  prefix: string,
  signal: AbortSignal,
  capabilities: ClassifierProviderCapabilities,
  instruction: string = stage === 1 ? '' : '',
): ClassifierProviderRequest {
  const normalized = normalizeStaticClassifierCapabilities(capabilities);
  // 用可变缓冲构建，最后作为 readonly 返回
  const buf: {
    stage: 1 | 2;
    model: ModelRef;
    prefix: string;
    instruction: string;
    signal: AbortSignal;
    reasoning?: 'disabled' | 'enabled';
    maxOutputTokens?: number;
    temperature?: 0;
  } = { stage, model, prefix, instruction, signal };
  if (normalized.reasoningControl) {
    buf.reasoning = stage === 1 ? 'disabled' : 'enabled';
  }
  if (normalized.minimumOutputTokens !== undefined) {
    buf.maxOutputTokens = normalized.minimumOutputTokens;
  }
  if (normalized.decodingControl) {
    buf.temperature = 0;
  }
  return buf;
}

/**
 * 把 ClassifierProviderRequest 翻译为 DirectProviderTextClient 的 completeText 入参。
 * adapter 侧只做参数映射 + 一次直接 RPC，返回 raw string。
 */
export function toDirectTextRequest(
  req: ClassifierProviderRequest,
): {
  model: ModelRef;
  systemPrompt: string;
  prompt: string;
  signal: AbortSignal;
  reasoning?: 'disabled' | 'enabled';
  maxOutputTokens?: number;
  temperature?: 0;
} {
  return {
    model: req.model,
    systemPrompt: req.instruction,
    prompt: req.prefix,
    signal: req.signal,
    ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
    ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

/**
 * 从一个实现了 DirectProviderTextClient 的真实 adapter 构造 PermissionClassifierProvider。
 *
 * wrapper 持有 adapter 引用 + 其静态 classifier capabilities；
 * invoke 把 ClassifierProviderRequest 翻译为 completeText 入参，原样上抛 raw response。
 * wrapper 不持有 ToolRegistry/RuntimeSecurityGate/Agent state/messageSink/TuiCallback。
 */
export function classifierProviderFromTextClient(
  client: DirectProviderTextClient,
  capabilities?: ClassifierProviderCapabilities,
): PermissionClassifierProvider {
  const caps =
    capabilities ??
    (typeof (client as unknown as { classifierCapabilities?: () => ClassifierProviderCapabilities }).classifierCapabilities ===
    'function'
      ? (client as unknown as { classifierCapabilities: () => ClassifierProviderCapabilities }).classifierCapabilities()
      : unsupportedClassifierCapabilities());
  return {
    capabilities: normalizeStaticClassifierCapabilities(caps),
    async invoke(req: ClassifierProviderRequest): Promise<unknown> {
      return client.completeText(toDirectTextRequest(req));
    },
  };
}
