// 配置模块导出
export type { MiCodeConfig, ProviderConfig, PermissionMode, PermissionRuleConfig, PermissionConfig, CapabilityOverrideConfig, CapabilitySupportValue } from './schema.js';
export { DEFAULT_CONFIG, DEFAULT_MODELS, SUPPORTED_PROVIDERS } from './schema.js';
export { ConfigStore } from './store.js';

// Wave C CRC-2 (M-059): Trusted Capability Override
export {
  applyCapabilityOverride,
  type EffectiveCapabilitySnapshot,
  type CapabilityOverrideRecord,
  type CapabilityOverrideTrustEvidence,
} from './capability-override.js';

// Task 9: 权限配置来源与安全持久化（设计 §9.1-§9.4、§10）
export {
  PERMISSION_RULE_SOURCE_PRECEDENCE,
  isPermissionRuleSource,
  mergePermissionRules,
  projectClassifierConfigSources,
  mergeAutoModeRules,
  loadStaticClassifierProviderMetadata,
  mergeRawConfig,
  loadLegacyConfig,
  type PermissionRuleSource,
  type MergedPermissionRule,
  type SourcedPermissionRules,
  type ClassifierConfigSourcesInput,
  type ProjectedClassifierConfig,
  type RejectedClassifierSource,
  type AutoModeRuleSource,
  type ProviderMetadataInput,
  type StaticProviderMetadata,
  type LegacyConfig,
  type LoadedLegacyConfig,
} from './permission-sources.js';
