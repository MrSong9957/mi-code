// 配置 Schema 定义

/** 单个 Provider 配置 */
export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** 轻量任务（子代理、压缩摘要）所用模型 */
  smallModel?: string;
}

/** 权限模式（与 permission/types.ts 同步，本地定义避免循环依赖） */
export type PermissionMode = 'build' | 'plan' | 'auto';

/** 权限规则（与 permission/types.ts 同步） */
export interface PermissionRuleConfig {
  tool: string;
  behavior: 'allow' | 'deny' | 'ask';
  path?: string;
  content?: string;
}

/** 权限配置 */
export interface PermissionConfig {
  mode: PermissionMode;
  rules: PermissionRuleConfig[];
}

/** 完整配置结构 */
export interface MiCodeConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  permissions: PermissionConfig;
}

/** 默认配置 */
export const DEFAULT_CONFIG: MiCodeConfig = {
  providers: {},
  defaultProvider: 'anthropic',
  permissions: {
    mode: 'build',
    rules: [],
  },
};

/** 各 Provider 默认模型 */
export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  google: 'gemini-2.5-flash',
};

/** 支持的 Provider 列表 */
export const SUPPORTED_PROVIDERS = Object.keys(DEFAULT_MODELS);
