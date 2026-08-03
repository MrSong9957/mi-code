// 权限模块导出
export type { PermissionMode, PermissionBehavior, PermissionRule, PermissionDecision } from './types.js';
export { WRITE_TOOLS, READ_ONLY_TOOLS } from './types.js';
export { PermissionChecker, type PermissionCheckerOptions } from './checker.js';
export {
  DANGEROUS_BASH_PATTERNS,
  isDangerousBash,
  globToRegex,
  isPathOutsideWorkspace,
  matchesRule,
} from './patterns.js';
// Task 1: canonical 规则解析、通配匹配、canonical 别名归一化与 MCP 匹配
export {
  parsePermissionRule,
  matchWildcardPattern,
  normalizePermissionToolName,
  parseMcpToolId,
  toolMatchesRule,
  detectUnreachableRules,
  WILDCARD_CORPUS,
  type ParsedRule,
  type McpToolId,
  type UnreachableRule,
  type WildcardCorpusSample,
} from './rules.js';
// Task 2: 单一 PermissionUpdate 与危险 allow 分区
export {
  isDangerousAllowRule,
  partitionDangerousAllows,
  applyPermissionUpdate,
  type PermissionSnapshot,
  type PermissionUpdate,
} from './permission-updates.js';
// Task 4: 独立两阶段 PermissionClassifier
export {
  projectPermissionClassifierInput,
  type AuthenticUserMessage,
  type ExecutableToolCall,
  type PermissionClassifierInput,
} from './classifier-input.js';
export {
  shouldFallbackToPrompting,
  recordAllow,
  recordDenial,
  createDenialState,
  DENIAL_CONSECUTIVE_THRESHOLD,
  DENIAL_TOTAL_THRESHOLD,
  type DenialState,
} from './denial-tracker.js';
export {
  DefaultClassifierModelPolicy,
  ClassifierModelUnavailableError,
  type ModelRef,
  type ClassifierModelContext,
  type ClassifierModelPolicy,
} from './classifier-model-policy.js';
export {
  buildClassifierPromptPrefix,
  renderClassifierRuleSections,
  STAGE1_INSTRUCTION,
  STAGE2_INSTRUCTION,
} from './classifier-prompt.js';
export {
  buildClassifierProviderRequest,
  unsupportedClassifierCapabilities,
  normalizeStaticClassifierCapabilities,
  toDirectTextRequest,
  classifierProviderFromTextClient,
  type PermissionClassifierProvider,
  type ClassifierProviderCapabilities,
  type ClassifierProviderRequest,
  type DirectProviderTextClient,
} from './classifier-provider.js';
export {
  DefaultPermissionClassifier,
  parseStage1Decision,
  parseStage2Decision,
  type ClassifierDecision,
} from './classifier.js';
// RC-5 结构化安全决策（spec §11）
export {
  SECURITY_PROTOCOL_VERSION,
  createSecurityDecision,
  mergeSecurityDecisions,
  type SecurityAction,
  type SecurityDecision,
  type UserDecision,
  type CreateSecurityDecisionInput,
} from './decisions.js';

// Wave B BRC-6 Child-Process Environment Gate
export {
  decideChildProcessEnvironment,
  getDefaultEnvironmentPolicy,
  type ChildProcessEnvironmentInput,
  type ChildProcessEnvironmentDecision,
  type EnvironmentPolicy,
} from './child-environment.js';

// Wave B BRC-6 Runtime Security Gate (Blocking Ask)
export {
  RuntimeSecurityGate,
  type PendingSecurityDecision,
  type AuthorizedAction,
  type DeniedAction,
  type ActionProvenance,
  type UserDecisionChannel,
  type PendingDecisionStore,
} from './runtime-gate.js';

// Wave C CRC-5 (M-067/M-069): Delegation Gate + Handoff Envelope
export {
  evaluateDelegationGate,
  createDelegationHandoffEnvelope,
  DELEGATION_PROTOCOL_VERSION,
  HANDOFF_PROTOCOL_VERSION,
  type DelegationRequest,
  type DelegationGateDependencies,
  type DelegationGateDecision,
  type DelegationHandoffInput,
  type DelegationHandoffEnvelope,
} from './delegation.js';

// Wave D DRC-5 (M-064): Shell Command Structural Policy
export {
  parseCommandStructure,
  compareCommandPolicyShadow,
  composeCommandStructuralDecision,
  assertActivationGate,
  type CommandParseResult,
  type CommandParseInput,
  type CommandComplexityPolicy,
  type CommandShadowComparison,
  type CommandStructuralDecision,
  type CommandStructuralDecisionInput,
  type CommandPolicyState,
  type CommandPolicyMode,
  type ActivationGateInput,
} from './command-policy.js';

// Wave E ERC-4 (M-065): Executable Environment + Sanitized Execution
export {
  classifyInlineAssignments,
  decideInlineEnvironment,
  resolveExecutableIdentity,
  buildSanitizedExecutionPlan,
  revalidateExecutableIdentity,
  executeSanitizedCommand,
  getDefaultPlatformEnvironmentPolicy,
  type PlatformFamily,
  type InlineEnvironmentDecision,
  type PlatformEnvironmentPolicy,
  type ExecutableResolutionResult,
  type SanitizedExecutionPlan,
  type RevalidationResult,
  type ExecuteSanitizedCommandResult,
  type PlatformResolutionAdapter,
} from './executable-environment.js';
