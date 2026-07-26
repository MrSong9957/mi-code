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
