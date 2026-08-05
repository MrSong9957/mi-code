// Authority Gate：真实生产 resolver/classifier 接线（Task 14 / 设计 §10 A83/A85）
//
// 物理本质：根据 authority 模式构造 turn-local executionRuntime。
//   - enforced：构造 classifier + resolver，注入 askResolver（走新权限链）
//   - legacy：不构造 resolver（askResolver undefined，走 legacy fast-path）
//   - shadow：构造 classifier + resolver，但 resolver 包装为 shadow wrapper——
//     内部跑 candidate（真实 classifier），最终返回 legacy decision（原始 ask），
//     使 gate 按 legacy 处理。candidate 结果只用于 observation（Task 13 audit）。
//
// 复用 Task 4/6/7 组件，不新增第二套 permission chain。
//
// 不变量：
//   - streamClient 必须实现 DirectProviderTextClient.completeText（Task 4 contract）；
//   - evaluateWithMode 桥接 permissionChecker.checkWithEvaluationMode → SecurityDecision；
//   - shadow wrapper 的 candidate 失败不影响 legacy decision（设计 A85）。

import type { StreamingLLMClient } from '../agent/types.js';
import type { ToolExecutionRuntime } from '../agent/tool-execution.js';
import type { PermissionChecker } from './checker.js';
import type { RuntimeSecurityGate } from './runtime-gate.js';
import type { SessionAllowlist } from './session-allowlist.js';
import type { SessionState } from './session-state.js';
import type { PermissionRequestHook } from './permission-request-hooks.js';
import type { PermissionAskResolver } from './ask-resolver.js';
import type { PermissionAskResolutionRequest } from './ask-resolver.js';
import type { SecurityDecision } from './decisions.js';
import type { ClassifierModelContext } from './classifier-model-policy.js';
import type { PermissionAuthority } from './cutover.js';
import { DefaultPermissionAskResolver } from './ask-resolver.js';
import { DefaultPermissionClassifier } from './classifier.js';
import { DefaultClassifierModelPolicy } from './classifier-model-policy.js';
import { classifierProviderFromTextClient, type DirectProviderTextClient } from './classifier-provider.js';
import { createSecurityDecision } from './decisions.js';
import { projectClassifierConfigSources, loadStaticClassifierProviderMetadata, type ClassifierConfigSourcesInput } from '../config/permission-sources.js';
import type { ProviderConfig } from '../config/schema.js';

/** turn-local 依赖（由 index.ts 在 handleUserSubmit 内提供） */
export interface TurnRuntimeDeps {
  readonly authority: PermissionAuthority;
  /** 当前 turn 的 stream client（必须实现 DirectProviderTextClient.completeText） */
  readonly streamClient: StreamingLLMClient;
  readonly providerId: string;
  readonly modelId: string;
  readonly permissionChecker: PermissionChecker;
  readonly runtimeGate: RuntimeSecurityGate;
  readonly sessionAllowlist: SessionAllowlist;
  readonly sessionState: SessionState;
  readonly hooks?: readonly PermissionRequestHook[];
  /** Task 7：main-origin dialog 函数（经 resolveInteractiveAsk 竞速）；未提供时 main 走直等 classifier */
  readonly dialogProvider?: (input: import('./interactive-ask.js').InteractiveAskInput) => Promise<import('./interactive-ask.js').DialogResult>;
  /** Task 7：dialog 创建延迟 ms（竞速窗口），默认 2000 */
  readonly dialogDelayMs?: number;
  /**
   * Task 9：从可信配置来源投影的 classifier rules（projectClassifierConfigSources 输出）。
   * index.ts 在构造 turn runtime 前投影，传入此处作为 additional rules。
   * 未提供时为空数组（classifier prompt 的 Rules 段为空，依赖模型先验判断）。
   */
  readonly classifierRules?: readonly string[];
  /**
   * Task 9：classifier model context（含 providerFastClassifierModel + classifierModel）。
   * 由 index.ts 用 loadStaticClassifierProviderMetadata + projectClassifierConfigSources 组装。
   * 未提供时回退到 session 主模型（当前硬编码行为）。
   */
  readonly classifierModelContext?: ClassifierModelContext;
}

/**
 * 根据 authority 模式构造 turn-local executionRuntime（Task 14 生产 gate）。
 *
 * - enforced：构造 classifier + resolver，返回含 askResolver 的 runtime
 * - legacy：返回不含 askResolver 的 runtime（走 legacy fast-path）
 * - shadow：构造 classifier + shadow resolver wrapper，candidate 跑真实 classifier，
 *   但 resolve() 返回 legacy decision（原始 ask decision）
 */
export function createExecutionRuntimeForTurn(deps: TurnRuntimeDeps): ToolExecutionRuntime {
  const base: ToolExecutionRuntime = {
    permissionChecker: deps.permissionChecker,
    runtimeGate: deps.runtimeGate,
    sessionAllowlist: deps.sessionAllowlist,
    authority: deps.authority,
  };

  // legacy：不构造 resolver
  if (deps.authority === 'legacy') {
    return base;
  }

  // enforced / shadow：构造真实 classifier + resolver
  const resolver = createResolver(deps);

  if (deps.authority === 'enforced') {
    return { ...base, askResolver: resolver };
  }

  // shadow：包装 resolver——candidate 真实运行，但返回 legacy decision
  return { ...base, askResolver: createShadowResolver(resolver) };
}

/**
 * Production composition seam (Task 9): 组装 classifier config 并构造 turn runtime。
 *
 * index.ts 必须通过此函数构造 auto-mode runtime，不得直接调 createExecutionRuntimeForTurn。
 */
export function createConfiguredExecutionRuntimeForTurn(input: {
  readonly authority: PermissionAuthority;
  readonly streamClient: StreamingLLMClient;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerConfig?: ProviderConfig;
  readonly providerModelIds: readonly string[];
  readonly classifierConfigSources: ClassifierConfigSourcesInput;
  readonly permissionChecker: PermissionChecker;
  readonly runtimeGate: RuntimeSecurityGate;
  readonly sessionAllowlist: SessionAllowlist;
  readonly sessionState: SessionState;
  readonly hooks?: readonly PermissionRequestHook[];
  readonly dialogProvider?: (input: import('./interactive-ask.js').InteractiveAskInput) => Promise<import('./interactive-ask.js').DialogResult>;
  readonly dialogDelayMs?: number;
}): ToolExecutionRuntime {
  const projected = projectClassifierConfigSources(input.classifierConfigSources);
  const metadata = loadStaticClassifierProviderMetadata(
    input.providerConfig
      ? {
          fastClassifierModel: input.providerConfig.fastClassifierModel,
          classifierCapabilities: input.providerConfig.classifierCapabilities,
        }
      : {},
    {},
  );
  // staticallySelectableModels 只来自 provider 声明的模型列表（不含 classifierModel 自举）
  const staticallySelectableModels = input.providerModelIds.map((id) => ({
    providerId: input.providerId,
    modelId: id,
  }));
  const modelContext: ClassifierModelContext = {
    sessionMainModel: { providerId: input.providerId, modelId: input.modelId },
    staticallySelectableModels,
    ...(metadata.fastClassifierModel !== undefined
      ? { providerFastClassifierModel: { providerId: input.providerId, modelId: metadata.fastClassifierModel } }
      : {}),
    ...(projected.classifierModel !== undefined
      ? { classifierModel: { providerId: input.providerId, modelId: projected.classifierModel } }
      : {}),
  };
  return createExecutionRuntimeForTurn({
    authority: input.authority,
    streamClient: input.streamClient,
    providerId: input.providerId,
    modelId: input.modelId,
    permissionChecker: input.permissionChecker,
    runtimeGate: input.runtimeGate,
    sessionAllowlist: input.sessionAllowlist,
    sessionState: input.sessionState,
    hooks: input.hooks,
    classifierRules: projected.rules,
    classifierModelContext: modelContext,
    ...(input.dialogProvider !== undefined ? { dialogProvider: input.dialogProvider } : {}),
    ...(input.dialogDelayMs !== undefined ? { dialogDelayMs: input.dialogDelayMs } : {}),
  });
}

/**
 * 构造真实 DefaultPermissionAskResolver（enforced/shadow 共用）。
 */
function createResolver(deps: TurnRuntimeDeps): PermissionAskResolver {
  // 1. classifier provider（复用 streamClient 的 completeText）
  const provider = classifierProviderFromTextClient(
    deps.streamClient as unknown as DirectProviderTextClient,
  );

  // 2. model context（Task 9：由 composition seam 用 loadStaticClassifierProviderMetadata +
  //    config 投影组装；enforced/shadow 缺失时 fail-closed，不再硬编码回退）
  if (!deps.classifierModelContext) {
    throw new Error('classifierModelContext is required for enforced/shadow authority (Task 9 production wiring)');
  }
  const modelContext = deps.classifierModelContext;

  // 3. classifier（Task 9：additional rules 从可信配置来源投影，append 到 mandatory baseline）
  const classifier = new DefaultPermissionClassifier({
    provider,
    modelPolicy: new DefaultClassifierModelPolicy(),
    modelContext,
    ...(deps.classifierRules !== undefined ? { rules: deps.classifierRules } : {}),
  });

  // 4. evaluateWithMode：桥接 permissionChecker.checkWithEvaluationMode → SecurityDecision。
  // acceptEdits simulation（A25）：CWD write 在 acceptEdits 下 allow → resolver 直接放行，
  // classifier = 0 calls。
  const evaluateWithMode = (
    toolName: string,
    input: Record<string, unknown>,
    evaluationMode: string,
  ): Promise<SecurityDecision> => {
    const legacyDecision = deps.permissionChecker.checkWithEvaluationMode(
      toolName,
      input,
      evaluationMode as 'build' | 'plan' | 'auto' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk',
    );
    return Promise.resolve(legacyToSecurityDecision(legacyDecision.behavior, toolName, evaluationMode));
  };

  // 5. resolver
  return new DefaultPermissionAskResolver({
    classifier,
    evaluateWithMode,
    hooks: deps.hooks ?? [],
    denialState: deps.sessionState.denialState,
    ...(deps.dialogProvider !== undefined ? { dialogProvider: deps.dialogProvider } : {}),
    ...(deps.dialogDelayMs !== undefined ? { dialogDelayMs: deps.dialogDelayMs } : {}),
  });
}

/**
 * Shadow resolver wrapper（设计 A85）。
 *
 * 内部调用真实 resolver（candidate），但 resolve() 返回原始的 legacy decision（request.decision）。
 * candidate 结果只用于 observation（Task 13 audit），不影响授权。
 * candidate 失败时静默吞掉，仍返回 legacy decision。
 */
function createShadowResolver(candidateResolver: PermissionAskResolver): PermissionAskResolver {
  return {
    async resolve(request: PermissionAskResolutionRequest): Promise<SecurityDecision> {
      // 跑 candidate（真实 classifier chain），用于 observation/shadow comparison
      try {
        await candidateResolver.resolve(request);
      } catch {
        // candidate failure 不影响 legacy decision（设计 A85）
      }
      // 始终返回 legacy decision（原始 ask decision）
      return request.decision;
    },
  };
}

/**
 * 把 legacy PermissionDecision behavior 映射为 SecurityDecision。
 * resolver 的 evaluateWithMode 只消费 behavior（allow/deny/ask）。
 */
function legacyToSecurityDecision(
  behavior: 'allow' | 'deny' | 'ask',
  toolName: string,
  evaluationMode: string,
): SecurityDecision {
  return createSecurityDecision({
    protocol_version: '1',
    decision_id: `resolver-eval:${toolName}:${evaluationMode}`,
    action: { kind: 'tool_call', subject_id: toolName, snapshot_id: 'resolver-eval' },
    behavior,
    deciding_layer: 'resolver-evaluation',
    risk_kind: behavior === 'allow' ? 'none' : 'medium',
    policy_id: 'resolver-evaluation',
    policy_version: '1',
    reason_code: `resolver.${evaluationMode}.${behavior}`,
    human_reason: `acceptEdits simulation: ${behavior}`,
    provenance_refs: ['resolver:1'],
  });
}
