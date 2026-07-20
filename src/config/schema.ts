// 配置 Schema 定义

/** 单个 Provider 配置 */
export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** 轻量任务（子代理、压缩摘要）所用模型 */
  smallModel?: string;
  /** 可选模型列表(/model 选择界面用)。配置后替换硬编码预设。
   *  格式:[{ "value": "model-id", "label": "显示名", "description": "描述" }] */
  models?: Array<{ value: string; label: string; description?: string }>;
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

/** Spinner 动词配置：默认追加内置词库，也可完全替换。 */
export interface SpinnerVerbConfig {
  mode: 'append' | 'replace';
  verbs: string[];
}

/** 主题名（与 utils/theme.ts ThemeName 同步） */
export type ThemeName = 'dark' | 'light';

/** 完整配置结构 */
export interface MiCodeConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  permissions: PermissionConfig;
  theme: ThemeName;
  spinnerVerbs: SpinnerVerbConfig;
}

/** 默认配置 */
export const DEFAULT_CONFIG: MiCodeConfig = {
  providers: {},
  defaultProvider: 'anthropic',
  permissions: {
    mode: 'build',
    rules: [],
  },
  theme: 'dark',
  spinnerVerbs: {
    mode: 'append',
    verbs: [],
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
