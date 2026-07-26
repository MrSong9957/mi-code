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
