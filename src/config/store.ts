// 配置存储：读写配置文件，合并环境变量
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MiCodeConfig, ProviderConfig, PermissionMode, PermissionRuleConfig, ThemeName, SpinnerVerbConfig, CapabilityOverrideConfig, CapabilitySupportValue } from './schema.js';
import { DEFAULT_CONFIG, DEFAULT_MODELS } from './schema.js';
import type { CapabilityOverrideRecord } from './capability-override.js';

export class ConfigStore {
  private config: MiCodeConfig;
  private configDir: string;
  private configFile: string;

  constructor(configPath?: string) {
    this.configDir = configPath || join(homedir(), '.micode');
    this.configFile = join(this.configDir, 'config.json');
    this.config = this.load();
  }

  /** 加载配置（用户级文件 + 环境变量覆盖） */
  private load(): MiCodeConfig {
    // 深拷贝 permissions，避免修改实例时污染共享的 DEFAULT_CONFIG
    const config: MiCodeConfig = {
      ...DEFAULT_CONFIG,
      providers: {},
      permissions: {
        mode: DEFAULT_CONFIG.permissions.mode,
        rules: [...DEFAULT_CONFIG.permissions.rules],
      },
    };

    // 读取用户级配置文件
    if (existsSync(this.configFile)) {
      try {
        const raw = readFileSync(this.configFile, 'utf8');
        const saved = JSON.parse(raw) as Partial<MiCodeConfig>;
        if (saved.providers) {
          for (const [name, provider] of Object.entries(saved.providers)) {
            config.providers[name] = provider;
          }
        }
        if (saved.defaultProvider) {
          config.defaultProvider = saved.defaultProvider;
        }
        // 权限配置（向后兼容：旧文件无此字段时保留默认）
        if (saved.permissions) {
          // 模式校验：只接受合法值，旧版 'default' 迁移为 'build'，其余非法值回退 'build'
          // 防止配置文件被污染（手改/损坏）后传入非法模式导致权限层行为未定义
          const rawMode = saved.permissions.mode ?? DEFAULT_CONFIG.permissions.mode;
          const VALID_MODES: PermissionMode[] = ['build', 'plan', 'auto'];
          const safeMode: PermissionMode =
            rawMode === ('default' as PermissionMode) || !VALID_MODES.includes(rawMode as PermissionMode)
              ? 'build'
              : (rawMode as PermissionMode);
          config.permissions = {
            mode: safeMode,
            rules: saved.permissions.rules ?? [],
          };
        }
        // 主题配置（向后兼容：旧文件无此字段时保留默认 'dark'）
        if (saved.theme) {
          const VALID_THEMES: ThemeName[] = ['dark', 'light'];
          config.theme = VALID_THEMES.includes(saved.theme) ? saved.theme : 'dark';
        }
        if (saved.spinnerVerbs && Array.isArray(saved.spinnerVerbs.verbs)) {
          const mode = saved.spinnerVerbs.mode === 'replace' ? 'replace' : 'append';
          config.spinnerVerbs = {
            mode,
            verbs: saved.spinnerVerbs.verbs.filter((v): v is string => typeof v === 'string'),
          };
        }
        // plan 目录（向后兼容：旧文件无此字段时保留默认 undefined → ~/.micode/plans/）
        if (typeof saved.plansDirectory === 'string') {
          config.plansDirectory = saved.plansDirectory;
        }
        // capability overrides（CRC-2 / M-059，向后兼容：旧文件无此字段时保留 undefined）
        // 这里只做"原始数组保存"，schema/key 校验在 getCapabilityOverrides() 做，
        // 保证 load() 自身永不因一条坏 override 抛错（spec §8.5:override loader 异常
        // 时使用 adapter default，不能猜测）。
        if (Array.isArray(saved.capability_overrides)) {
          config.capability_overrides = saved.capability_overrides;
        }
      } catch {
        // 配置文件损坏，使用默认
      }
    }

    // 环境变量覆盖（不写入文件）
    const envAnthropic = process.env.ANTHROPIC_API_KEY;
    if (envAnthropic) {
      config.providers.anthropic = {
        ...config.providers.anthropic,
        apiKey: envAnthropic,
        model: config.providers.anthropic?.model || DEFAULT_MODELS.anthropic!,
      };
    }

    const envOpenai = process.env.OPENAI_API_KEY;
    if (envOpenai) {
      config.providers.openai = {
        ...config.providers.openai,
        apiKey: envOpenai,
        model: config.providers.openai?.model || DEFAULT_MODELS.openai!,
      };
    }

    return config;
  }

  /** 获取当前 Provider 名称 */
  getDefaultProvider(): string {
    return this.config.defaultProvider;
  }

  /** 设置默认 Provider */
  setDefaultProvider(name: string): void {
    this.config.defaultProvider = name;
    this.save();
  }

  /** 获取 Provider 配置 */
  getProvider(name: string): ProviderConfig | undefined {
    return this.config.providers[name];
  }

  /** 获取 API Key（优先级：环境变量 > 配置文件） */
  getApiKey(provider: string): string | undefined {
    // 环境变量优先
    const envKey = process.env[`${provider.toUpperCase()}_API_KEY`];
    if (envKey) return envKey;

    return this.config.providers[provider]?.apiKey;
  }

  /** 获取当前模型 */
  getModel(): string {
    const provider = this.config.defaultProvider;
    const providerConfig = this.config.providers[provider];
    return providerConfig?.model || DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic!;
  }

  /**
   * 获取小模型（用于子代理、压缩摘要等轻量任务）。
   * 解析顺序：provider.smallModel → (空时回退) getModel()
   * 未配置时回退到主模型，保证默认行为零变化。
   */
  getSmallModel(provider: string = this.config.defaultProvider): string {
    const smallModel = this.config.providers[provider]?.smallModel;
    if (smallModel) return smallModel;
    // 回退到主模型（含 DEFAULT_MODELS 兜底）
    return this.getModel();
  }

  /** 设置 Provider API Key */
  setApiKey(provider: string, apiKey: string): void {
    if (!this.config.providers[provider]) {
      this.config.providers[provider] = {
        apiKey: '',
        model: DEFAULT_MODELS[provider] || '',
      };
    }
    this.config.providers[provider]!.apiKey = apiKey;
    this.save();
  }

  /** 设置 Provider 模型 */
  setModel(provider: string, model: string): void {
    if (!this.config.providers[provider]) {
      this.config.providers[provider] = {
        apiKey: '',
        model: DEFAULT_MODELS[provider] || '',
      };
    }
    this.config.providers[provider]!.model = model;
    this.save();
  }

  /** 设置 Provider 小模型（持久化） */
  setSmallModel(provider: string, smallModel: string): void {
    if (!this.config.providers[provider]) {
      this.config.providers[provider] = {
        apiKey: '',
        model: DEFAULT_MODELS[provider] || '',
      };
    }
    this.config.providers[provider]!.smallModel = smallModel;
    this.save();
  }

  /** 获取主题名 */
  getTheme(): ThemeName {
    return this.config.theme;
  }

  /** 设置主题名（持久化） */
  setTheme(theme: ThemeName): void {
    this.config.theme = theme;
    this.save();
  }

  /** 获取 Spinner 动词配置副本，供渲染层在 turn 启动时抽样。 */
  getSpinnerVerbsConfig(): SpinnerVerbConfig {
    return { mode: this.config.spinnerVerbs.mode, verbs: [...this.config.spinnerVerbs.verbs] };
  }

  /** 获取权限模式 */
  getPermissionMode(): PermissionMode {
    return this.config.permissions.mode;
  }

  /** 设置权限模式（持久化） */
  setPermissionMode(mode: PermissionMode): void {
    this.config.permissions.mode = mode;
    this.save();
  }

  /** 获取权限规则列表（副本） */
  getPermissionRules(): PermissionRuleConfig[] {
    return [...this.config.permissions.rules];
  }

  /** 设置权限规则列表（持久化，替换全部） */
  setPermissionRules(rules: PermissionRuleConfig[]): void {
    this.config.permissions.rules = [...rules];
    this.save();
  }

  /** 获取 plan 目录覆盖（未配置返回 undefined，由 PlanStore 用默认 ~/.micode/plans/） */
  getPlansDirectory(): string | undefined {
    return this.config.plansDirectory;
  }

  /** 设置 plan 目录覆盖（持久化）。传 undefined 清除配置回到默认。 */
  setPlansDirectory(path: string | undefined): void {
    this.config.plansDirectory = path;
    this.save();
  }

  /**
   * 受信 loader 入口（CRC-2 / M-059，spec §8.2 + §8.3）。
   *
   * 从 config 读取 capability_overrides，逐条做 schema 校验（每个字段非空、changes 值
   * 合法），返回 CapabilityOverrideRecord[]。
   *
   * 确定性语义:同一份 config 永远产出同样的 record 数组(顺序与文件中一致)。
   * 安全语义:
   *   - 任何一条 schema 不合法(字段缺失/类型错/changes value 非法)→ 直接丢弃该条,
   *     不抛错(spec §8.5:loader 异常时使用 adapter default,不猜测)。
   *   - 这里**只**做 schema 校验。Trust 判断(trusted_source/schema_valid/exact_scope_match)
   *     由调用方在 applyCapabilityOverride 时通过 evidence 独立给出。
   *   - 缺省 / 全部非法时返回空数组,保证向后兼容。
   */
  getCapabilityOverrides(): CapabilityOverrideRecord[] {
    const raw = this.config.capability_overrides;
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: CapabilityOverrideRecord[] = [];
    for (const item of raw) {
      const record = coerceOverrideRecord(item);
      if (record !== null) {
        out.push(record);
      }
    }
    return out;
  }

  /** 获取脱敏配置（用于显示） */
  getMasked(): MiCodeConfig {
    const masked = { ...this.config, providers: {} as Record<string, ProviderConfig> };
    for (const [name, provider] of Object.entries(this.config.providers)) {
      masked.providers[name] = {
        ...provider,
        apiKey: maskApiKey(provider.apiKey),
      };
    }
    return masked;
  }

  /** 保存到文件 */
  save(): void {
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8');
  }
}

/** 脱敏 API Key：只显示前 8 位 */
function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return key.slice(0, 8) + '***';
}

/** 合法的 capability support value 字面量集合(精确匹配)。 */
const ALLOWED_CAPABILITY_SUPPORT_VALUES: ReadonlySet<string> = new Set([
  'supported',
  'unsupported',
  'unknown',
]);

/**
 * 把一个原始 JSON 值强制校验并转成 CapabilityOverrideRecord。
 * 校验失败返回 null(调用方丢弃该条),不抛错(spec §8.5 loader 语义)。
 *
 * 校验项:
 *   - 必须是 plain object。
 *   - 所有身份/溯源字段非空字符串。
 *   - changes 是 object,每个 value 必须是 supported/unsupported/unknown 之一。
 */
function coerceOverrideRecord(value: unknown): CapabilityOverrideRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;

  // 身份/溯源字段:必须是非空字符串
  const stringFields: ReadonlyArray<keyof CapabilityOverrideConfig> = [
    'override_id',
    'override_version',
    'source_config_ref',
    'source_trust_proof_ref',
    'provider_id',
    'endpoint_scope',
    'model_scope',
    'base_capability_snapshot_id',
    'justification',
  ];
  for (const field of stringFields) {
    const v = obj[field as string];
    if (typeof v !== 'string' || v.trim().length === 0) {
      return null;
    }
  }

  // changes:必须是 object,每个 value 必须是合法字面量
  const changesRaw = obj.changes;
  if (changesRaw === null || typeof changesRaw !== 'object' || Array.isArray(changesRaw)) {
    return null;
  }
  const changes: Record<string, CapabilitySupportValue> = {};
  for (const [key, rawValue] of Object.entries(changesRaw as Record<string, unknown>)) {
    if (
      typeof rawValue !== 'string' ||
      !ALLOWED_CAPABILITY_SUPPORT_VALUES.has(rawValue)
    ) {
      return null;
    }
    changes[key] = rawValue as CapabilitySupportValue;
  }

  return {
    override_id: obj.override_id as string,
    override_version: obj.override_version as string,
    source_config_ref: obj.source_config_ref as string,
    source_trust_proof_ref: obj.source_trust_proof_ref as string,
    provider_id: obj.provider_id as string,
    endpoint_scope: obj.endpoint_scope as string,
    model_scope: obj.model_scope as string,
    base_capability_snapshot_id: obj.base_capability_snapshot_id as string,
    changes,
    justification: obj.justification as string,
  };
}
