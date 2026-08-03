// 配置 Schema 定义

/** 单个 Provider 配置 */
export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** 轻量任务（子代理、压缩摘要）所用模型 */
  smallModel?: string;
  /**
   * classifier（auto 权限裁决）使用的 fast 模型（advisory，设计 §7.4）。
   * 未配置时 classifier 绑定 session 主模型；静态已知不可选时也回退主模型。
   */
  fastClassifierModel?: string;
  /**
   * provider 静态声明的 classifier capability（设计 §7.3）。
   * 只来自 adapter/config 静态声明，不做运行时 discovery RPC。
   */
  classifierCapabilities?: {
    reasoningControl?: boolean;
    minimumOutputTokens?: number;
    decodingControl?: boolean;
    promptCache?: boolean;
  };
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

/**
 * 单项能力的支持状态（与 src/agent/tools/capability-snapshot.ts CapabilitySupport 同步，
 * 本地定义避免 config 层反向依赖 agent 层）。`unknown` 与 `supported`/`unsupported` 互斥。
 */
export type CapabilitySupportValue = 'supported' | 'unsupported' | 'unknown';

/**
 * 受信配置对 adapter 默认能力快照的单条 override（CRC-2 / M-059，spec §8.2）。
 *
 * 这是配置层 schema 字段；进入 `applyCapabilityOverride` 前还要经过四重 trust gate
 * + capability key 注册检查 + scope 精确匹配（在 capability-override.ts 中实现）。
 * schema 层只做"长得对不对"，不做"信不信得过"。
 */
export interface CapabilityOverrideConfig {
  override_id: string;
  override_version: string;
  source_config_ref: string;
  source_trust_proof_ref: string;
  provider_id: string;
  endpoint_scope: string;
  model_scope: string;
  base_capability_snapshot_id: string;
  changes: Record<string, CapabilitySupportValue>;
  justification: string;
}

/** 完整配置结构 */
export interface MiCodeConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  permissions: PermissionConfig;
  theme: ThemeName;
  spinnerVerbs: SpinnerVerbConfig;
  /** plan 文件落盘目录（绝对路径或相对 cwd 的路径）。未配置时用 ~/.micode/plans/ */
  plansDirectory?: string;
  /**
   * 受信配置层 capability override 列表（CRC-2 / M-059，spec §8.2）。
   * 可选字段：未配置时为 undefined，loader 返回空数组。Agent/Prompt/Tool Result
   * 不能写此字段（spec §8.4 rule 3），本配置入口只接受受信配置来源。
   */
  capability_overrides?: ReadonlyArray<CapabilityOverrideConfig>;
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
  plansDirectory: undefined,
};

/** 各 Provider 默认模型 */
export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  google: 'gemini-2.5-flash',
};

/** 支持的 Provider 列表 */
export const SUPPORTED_PROVIDERS = Object.keys(DEFAULT_MODELS);
