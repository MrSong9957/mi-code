// Agent 模块导出
export type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  ToolParameter,
  ToolExecutor,
  RegisteredTool,
  ModelResponse,
  LoopState,
  AgentConfig,
  LLMClient,
} from './types.js';
export { isStreamEvent } from './types.js';

export { ToolRegistry, createBashTool, createDefaultRegistry } from './tool-registry.js';
export { MockLLMClient, createMockClient } from './llm-client.js';
export { agentLoop, createLoopState, type LoopCallbacks } from './loop.js';

// 错误恢复模块
export {
  createRecoveryState,
  classifyError,
  handleError,
  FailureInbox,
  MAX_RETRY_LIMIT,
  type ErrorType,
  type RecoveryState,
  type FailureRecord,
} from './recovery.js';

export {
  exponentialBackoff,
  jitteredBackoff,
  sleep,
  withBackoff,
} from './backoff.js';

// 流式输出模块
export { QueryEngine, type NormalizedMessage, type QueryEngineOptions } from './query-engine.js';
export {
  StreamEventBus,
  type StreamEventType,
  type ToolCallEvent,
  type ToolResultEvent,
  type ErrorEvent,
  type LoopEndEvent,
} from './stream-event-bus.js';
export { streamingQuery, type StreamMessage, type StreamingQueryOptions } from './streaming-query.js';

// Wave A 公共契约导出（RC-1 ~ RC-4）。
//
// 这些导出是后续 Wave B 各机制的稳定输入。只导出 Root Contract 所需的公共类型和
// 构造函数；不导出内部排序 helper、测试 factory 或 legacy adapter。
//
// RC-1 Prompt Asset Governance
export {
  buildPromptAssetRegistry,
  type PromptAssetRecord,
  type PromptAssetRegistrySnapshot,
  type PromptEvaluationStatus,
  type BuildPromptAssetRegistryInput,
} from './prompt/registry.js';

// RC-2 Semantic Request Boundary
export {
  buildSemanticRequestSnapshot,
  type SemanticPlacement,
  type SemanticSection,
  type SemanticMessage,
  type SemanticRequestSnapshot,
  type BuildSemanticRequestSnapshotInput,
} from './contracts/request-snapshot.js';

export {
  buildToolDefinitionSnapshot,
  type ToolDescriptor,
  type ToolDefinitionSnapshot,
} from './tools/descriptor-snapshot.js';

// RC-3 Project Rule Discovery
export {
  discoverProjectRuleSources,
  type ProjectRuleDiscoveryInput,
  type ProjectRuleSourcePolicy,
  type DiscoveredRuleSource,
} from './context/discovery.js';

// RC-4 Completion & Agent Result
export {
  createCompletionReport,
  createDispatchReceipt,
  type CompletionReport,
  type DispatchReceipt,
  type CompletionOutcome,
  type VerificationReport,
  type VerificationLevel,
  type VerificationStatus,
  type VerificationFailureKind,
  type DeliverableReport,
  type SubjectRef,
  type CreateCompletionReportInput,
  type CreateDispatchReceiptInput,
} from './contracts/completion-report.js';

// 共享身份原语（被多个 RC 复用，作为公共工具暴露）
export {
  requireIdentity,
  freezeSnapshot,
} from './contracts/identities.js';

// Wave B 公共契约导出（BRC-1 ~ BRC-7）。
//
// 只导出 Root Contract 所需的公共类型和 builder/validator/gate；不导出内部
// hash helper、legacy adapter 或测试 factory。

// BRC-1 Prompt Compilation
export {
  compilePromptSnapshot,
  type PromptSectionInput,
  type PromptCompilationInput,
  type CompiledPromptSnapshot,
  type PromptAssetApprovalLookup,
} from './prompt/compiler.js';

// BRC-2 Capability-Aware Tool View
export {
  createModelCapabilitySnapshot,
  type CapabilitySupport,
  type ModelCapabilitySnapshot,
} from './tools/capability-snapshot.js';

export {
  deriveRequestToolView,
  type RequestToolViewSnapshot,
  type RequestToolViewEntry,
  type ToolViewOverlayInput,
} from './tools/overlay.js';

export {
  materializeIncludedToolDefinitions,
} from './tool-registry.js';

// BRC-3 Typed Context Intake
export {
  createContextSourceEnvelope,
  runContextIntake,
  buildBoundedContextSource,
  type ContextSourceEnvelope,
  type ContextWriterKind,
  type ContextSourceClass,
  type BoundedContextSource,
  type SourceBudgetPolicy,
  type ContextSanitizationResult,
} from './context/intake.js';

// BRC-4 Agent Prompt Profiles
export {
  composeAgentPromptProfile,
  type AgentRoleProfile,
  type TaskPromptTemplate,
  type AgentPromptProfileSnapshot,
  type ComposedAgentProfile,
} from './prompt/profiles.js';

// BRC-5 Tool Transcript Integrity
export {
  validateToolTranscript,
  type ToolTranscriptValidation,
  type ToolTranscriptSnapshot,
  type ToolPairState,
  type ToolPairRecord,
  type TranscriptCheckpoint,
} from './tools/transcript-validator.js';

// BRC-7 Observability Planes
export {
  createObservabilityEnvelope,
  canEnterPlane,
  type ObservabilityEventEnvelope,
  type ObservabilityPlane,
  type ObservabilityPlanePolicies,
} from './observability/envelopes.js';

// Wave C 公共契约导出(CRC-1 ~ CRC-6)。
//
// 只导出 Root Contract 所需的公共 policy anchor 和类型;内部 rank、hash、formatter
// 不导出。每个 CRC 的导出紧跟其 Wave B 前置,便于追溯依赖关系。

// CRC-1 Prompt Resolution Policy (M-002/M-003/M-004)
export {
  resolvePromptPolicy,
  compileResolvedPrompt,
  evaluatePromptCondition,
  classifyPromptScope,
  type PromptResolutionPlan,
  type PromptResolutionCandidate,
  type PromptResolutionInput,
  type PromptCondition,
  type ConditionTruth,
  type ConditionEvaluation,
  type PromptScopeDecision,
  type PromptScopeClass,
  type ResolvedPromptCompileDeps,
} from './prompt/resolution.js';

// CRC-3 Context Routing (M-009/M-012) — environment block + markdown routing
export {
  buildEnvironmentContextBlock,
  routeMarkdownSource,
  type EnvironmentContextBlock,
  type EnvironmentBlockUnavailable,
  type MarkdownRouteDecision,
  type MarkdownRouteTarget,
  type MarkdownSourceRouteInput,
  type MarkdownRouteTrustEvidence,
} from './context/routing.js';

// CRC-4 Tool Policy Projection (M-026)
export {
  projectToolPolicy,
  type ToolPolicyProjection,
  type ToolPolicyProjectionInput,
  type ToolPolicyProjectionDeps,
} from './tools/policy-projection.js';

// CRC-4 No-Tool Request Contract (M-031)
export {
  createNoToolRequestContract,
  validateNoToolRequest,
  bindValidationToContract,
  NO_TOOL_PROTOCOL_VERSION,
  type NoToolRequestContract,
  type NoToolRequestState,
  type NoToolValidationResult,
} from './tools/no-tool-contract.js';

// CRC-5 Injection Suspicion Signal (M-069)
export {
  createInjectionSuspicionSignal,
  shouldRecommendUserReport,
  type InjectionSuspicionSignal,
  type InjectionSuspicionSignalInput,
} from './context/injection-signal.js';

// CRC-6 Decision Trace (M-054)
export {
  createDecisionTraceEvent,
  type DecisionTraceEvent,
  type DecisionTraceEventInput,
  type DecisionSubsystem,
} from './observability/decision-trace.js';

// CRC-6 Telemetry Redaction (M-056)
export {
  redactTelemetryEvent,
  type TelemetryRedactionResult,
  type TelemetryFieldPolicy,
  type TelemetryEventInput,
  type TelemetryFieldClass,
  type TelemetryFieldAction,
  type TelemetryPiiLabel,
} from './observability/redaction.js';

// Wave D 公共契约导出(DRC-1 ~ DRC-4)。
//
// 只导出 DRC 所需的公共 capability anchor 和类型;内部 helper、test corpus 不导出。

// DRC-1 Mode Profile (M-048)
export {
  selectModeProfile,
  compileProfiledPrompt,
  type ModeProfileDefinition,
  type ModeProfileRegistry,
  type ModeProfileSelectionInput,
  type ModeProfileSelection,
  type ProfiledCompileDeps,
} from './prompt/profiles.js';

// DRC-2 Trusted Context Activation (M-008 + M-044 orchestration)
export {
  activateProjectInstruction,
  attachMetaContext,
  activateTrustedContext,
  type ProjectInstructionActivationInput,
  type MetaContextActivation,
  type TrustedContextActivationInput,
  type TrustedContextActivationResult,
  type TrustedContextDependencies,
} from './context/activation.js';

// DRC-3 Tool Reference Integrity (M-028)
export {
  buildToolReferenceManifest,
  validateToolReferences,
  type ToolReferenceManifest,
  type ToolReferenceValidation,
  type ToolReferenceValidationInput,
} from './tools/reference-validator.js';

// DRC-4 Component Telemetry (M-055)
export {
  measureTelemetryComponent,
  buildComponentTelemetryBatch,
  type ComponentTelemetryEvent,
  type ComponentTelemetryBatch,
  type ComponentTelemetryBatchInput,
  type TelemetryComponentRef,
  type TokenMeasurement,
} from './observability/telemetry.js';

// Wave E 公共契约导出(ERC-1 / ERC-3)。

// ERC-1 Meta Retention (M-038)
export {
  decideMetaRetention,
  createMetaLifecycleRecord,
  serializeMetaLifecycleRecord,
  deserializeMetaLifecycleRecord,
  applyMetaRetentionToCompression,
  canActivateMetaRetention,
  type MetaRetentionPolicy,
  type MetaRetentionDecision,
  type MetaMessageLifecycleRecord,
  type MetaRetentionCompressionResult,
  type MetaRetentionActivationResult,
} from './context/retention.js';

// ERC-3 Local Diagnostic Buffer (M-052)
export {
  createLocalDiagnosticBuffer,
  enqueueDiagnosticEvent,
  flushDiagnosticBuffer,
  shutdownDiagnosticBuffer,
  type LocalDiagnosticBufferPolicy,
  type LocalDiagnosticBuffer,
  type EnqueueResult,
  type DiagnosticFlushResult,
  type DiagnosticSinkAdapter,
} from './observability/local-buffer.js';

// Wave F 公共契约导出(FRC-1 Bounded Memory Entrypoint / M-013)。
//
// 只导出 FRC policy/input/output、core builder、activation result、compiler handoff
// 和 rebuild identity。**不导出** Budget internals、escape helper、cache map、
// claim lookup adapter —— 这些是 Wave F 内部实现细节,不属于公共稳定契约。
//
// 来源拆分(物理实现跨 4 个文件):
//   - bounded-memory.ts        — T1/T2/T3/T6/T9 主入口 + policy/input/output 类型
//   - bounded-memory-render.ts — T5 Render Profile + T8 Compiler Handoff
//   - bounded-memory-cache.ts  — T7 Cache(可选优化)

// === FRC-1 Bounded Memory Entrypoint ===
// 值导出(函数 + 常量)— T1 policy/capture / T2+T3 projection / T6 Core Anchor /
// T9 Activation+Integration / T8 Compiler Handoff / T7 Cache / Rebuild identity
export {
  // T1 policy + capture
  captureMemoryEntrypointBuild,
  // T2+T3 projection
  projectMemoryNavigation,
  projectVerifiedMemoryClaims,
  // T6 Core Anchor
  buildBoundedMemoryEntrypoint,
  // T9 Activation + Integration
  canActivateBoundedMemoryEntrypoint,
  integrateBoundedMemoryIntoRequest,
  createMemoryEntrypointRebuildInput,
  // Constants — 各 protocol version 独立演进(INV-F14)
  ENTRYPOINT_PROTOCOL_VERSION,
  ENTRYPOINT_POLICY_PROTOCOL_VERSION,
} from './context/bounded-memory.js';

// T5 Render Profile + T8 Compiler Handoff —— 来自 render.ts
export {
  toMemoryPromptSection,
  createRendererAdaptor,
  DEFAULT_MEMORY_RENDER_PROFILE,
} from './context/bounded-memory-render.js';

// T7 Cache(可选优化)—— 来自 cache.ts
export {
  createMemoryEntrypointCache,
  getOrBuildMemoryEntrypoint,
} from './context/bounded-memory-cache.js';

// 类型导出 — policy / input / output / activation / integration / rebuild
export type {
  // 共享身份与状态
  WaveFContractRef,
  MemoryEntrypointState,
  // T1 policy + capture
  MemoryEntrypointPolicy,
  MemoryEntrypointBuildInput,
  PreparedMemoryEntrypointBuild,
  // T2+T3 projection
  MemoryNavigationItem,
  NavigationProjectionResult,
  VerifiedMemoryClaimProjection,
  VerifiedClaimProjectionResult,
  // T6 Core Anchor
  BoundedMemoryEntrypointItem,
  BoundedMemoryEntrypointSnapshot,
  BoundedMemoryEntrypointDependencies,
  // T9 Activation + Integration
  BoundedMemoryActivationEvidence,
  BoundedMemoryActivationResult,
  BoundedMemoryRequestIntegrationInput,
  BoundedMemoryRequestIntegrationResult,
  // T9 Rebuild identity(Wave G handoff)
  MemoryEntrypointRebuildInput,
} from './context/bounded-memory.js';

// T5 Render Profile + T8 Compiler Handoff 类型 —— 来自 render.ts
export type {
  RenderProfileAsset,
  RenderedMemorySection,
  MemoryPromptHandoffInput,
  MemoryPromptHandoffResult,
} from './context/bounded-memory-render.js';
