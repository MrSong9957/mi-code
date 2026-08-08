// 配置存储：读写配置文件，合并环境变量
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, fsyncSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MiCodeConfig, ProviderConfig, PermissionMode, PermissionRuleConfig, ThemeName, SpinnerVerbConfig, CapabilityOverrideConfig, CapabilitySupportValue } from './schema.js';
import { DEFAULT_CONFIG, DEFAULT_MODELS } from './schema.js';
import type { CapabilityOverrideRecord } from './capability-override.js';
import type { PermissionRule } from '../permission/types.js';
import type { PermissionUpdate } from '../permission/permission-updates.js';
import type { SessionState } from '../permission/session-state.js';
import { isLanguage, type Language } from '../locale/types.js';

export class ConfigStore {
  private config: MiCodeConfig;
  private configDir: string;
  private configFile: string;
  /**
   * 原始 JSON 解析结果（含未知字段）。
   * save() 写盘时基于此对象，保证未知字段 byte-for-value 保留（设计 §10 / A72）。
   * 损坏 JSON 时保留 last-known-good（设计 §10 / A67）。
   */
  private rawConfig: Record<string, unknown>;
  /** 当前项目路径（reloadForProject 跟踪） */
  private _currentProject: string | undefined;

  constructor(configPath?: string) {
    this.configDir = configPath || join(homedir(), '.micode');
    this.configFile = join(this.configDir, 'config.json');
    this.rawConfig = {};
    this.config = this.load();
  }

  /** 当前项目路径（reloadForProject 设置） */
  get currentProject(): string | undefined {
    return this._currentProject;
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

    // rawConfig 初始化（保留未知字段，损坏时保留 last-known-good）
    let parsed: Record<string, unknown> | null = null;

    // 读取用户级配置文件
    if (existsSync(this.configFile)) {
      try {
        const raw = readFileSync(this.configFile, 'utf8');
        const saved = JSON.parse(raw) as Partial<MiCodeConfig>;
        parsed = saved as Record<string, unknown>;
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
        if (isLanguage(saved.language)) {
          config.language = saved.language;
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
        // 配置文件损坏，使用默认（rawConfig 保留 last-known-good：若已有则不动）
        parsed = null;
      }
    }

    // rawConfig：成功解析则采用，损坏则保留已有 last-known-good（首次为空）
    if (parsed) {
      this.rawConfig = parsed;
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

  /** 获取持久化语言；未配置或配置无效时返回 undefined。 */
  getLanguage(): Language | undefined {
    return this.config.language;
  }

  /** 设置语言（持久化）。 */
  setLanguage(language: Language): void {
    const previousLanguage = this.config.language;
    this.config.language = language;
    try {
      this.save();
    } catch (error) {
      this.config.language = previousLanguage;
      throw error;
    }
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

  /** Task 9：读取用户级 classifier config（trusted userSettings 来源）。 */
  getClassifierUserSettings(): { rules?: readonly string[]; classifierModel?: string } {
    const perms = this.config.permissions;
    const section: { rules?: readonly string[]; classifierModel?: string } = {};
    if (perms.classifierRules && perms.classifierRules.length > 0) {
      section.rules = [...perms.classifierRules];
    }
    if (perms.classifierModel) {
      section.classifierModel = perms.classifierModel;
    }
    return section;
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

  /**
   * 原子保存到文件（设计 §10）。
   *
   * 流程：同目录临时文件 -> 写入 + fsync -> rename。
   * 失败保留原文件（rename 前 temp 文件不影响原文件）。
   * 基于完整对象（合并 rawConfig + schema 校验后的 config），保留未知字段。
   * 写盘成功后同步 rawConfig，使后续 reload 的 last-known-good 包含本次变更。
   */
  save(): void {
    mkdirSync(this.configDir, { recursive: true });
    // 合并：以 rawConfig 为基（保留未知字段），用 schema 的 config 覆盖已知字段
    const merged = this.serializeWithUnknownFields();
    const json = JSON.stringify(merged, null, 2);
    this.atomicWrite(this.configFile, json);
    // 写盘成功：rawConfig 同步为 merged（含未知字段 + schema 字段最新值）
    this.rawConfig = merged;
  }

  /**
   * 把当前 config 与 rawConfig 合并成完整对象。
   * rawConfig 的未知字段保留；config 的 schema 字段权威（覆盖 rawConfig 中的对应键）。
   */
  private serializeWithUnknownFields(): Record<string, unknown> {
    // 用 rawConfig 做基，再用 config 覆盖所有 schema 字段
    const merged: Record<string, unknown> = {
      ...this.rawConfig,
      providers: this.config.providers,
      defaultProvider: this.config.defaultProvider,
      permissions: this.config.permissions,
      theme: this.config.theme,
      spinnerVerbs: this.config.spinnerVerbs,
    };
    // 可选字段：undefined 表示删除（清除配置），非 undefined 表示设置
    if (this.config.language !== undefined) {
      merged.language = this.config.language;
    } else {
      delete merged.language;
    }
    if (this.config.plansDirectory !== undefined) {
      merged.plansDirectory = this.config.plansDirectory;
    } else {
      delete merged.plansDirectory;
    }
    if (this.config.capability_overrides !== undefined) {
      merged.capability_overrides = this.config.capability_overrides;
    } else {
      delete merged.capability_overrides;
    }
    return merged;
  }

  /**
   * 原子写：同目录 temp -> write + fsync -> rename（设计 §10）。
   * rename 在同目录下是 POSIX 原子操作；失败时原文件不受影响。
   */
  private atomicWrite(filePath: string, content: string): void {
    const tmpPath = filePath + '.tmp';
    const fd = openSync(tmpPath, 'w');
    try {
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);
  }

  // ─── Task 9: reload / readRaw / replaceRawFile（设计 §10 / A67） ─────────────

  /**
   * 重新从磁盘加载配置（设计 §10 / A67）。
   * 损坏 JSON 时保留 last-known-good（rawConfig 与 config 都不变）。
   * 返回当前 config 快照。
   */
  reload(): MiCodeConfig {
    const previousRaw = this.rawConfig;
    const previousConfig = this.config;
    this.rawConfig = {};
    this.config = this.load();
    // load() 解析失败时 rawConfig 保持空对象 -> 恢复 last-known-good
    if (Object.keys(this.rawConfig).length === 0) {
      this.rawConfig = previousRaw;
      this.config = previousConfig;
    }
    return this.config;
  }

  /**
   * 替换磁盘上的原始配置文件内容（测试用，设计 §10 / A67）。
   * 不经过 schema 校验——用于模拟外部写入损坏 JSON。
   */
  replaceRawFile(content: string): void {
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.configFile, content, 'utf8');
  }

  /** 读取磁盘上的原始 JSON 字符串（含未知字段，未经 schema 校验）。 */
  readRaw(): Record<string, unknown> {
    try {
      const raw = readFileSync(this.configFile, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ...this.rawConfig };
    }
  }

  // ─── Task 9: persistPermissionUpdate（设计 §10 / A72） ───────────────────────

  /**
   * 持久化一个 PermissionUpdate 到 settings（设计 §10 / A72）。
   *
   * 行为：
   *   - setMode：更新 permissions.mode 并原子写盘；
   *   - addRule / removeRule / replaceRules：更新 permissions.rules 并原子写盘；
   *   - 未知字段 byte-for-value 保留（save 基于 rawConfig + config 合并）。
   *
   * 不改变 session 瞬态状态——session 状态由调用方通过 SessionState 管理。
   */
  persistPermissionUpdate(update: PermissionUpdate): void {
    switch (update.kind) {
      case 'setMode':
        this.setPermissionMode(update.mode);
        break;
      case 'addRule': {
        const rules = this.getPermissionRules();
        rules.push(toPermissionRuleConfig(update.rule));
        this.setPermissionRules(rules);
        break;
      }
      case 'removeRule': {
        const rules = this.getPermissionRules().filter((r) => !ruleConfigEqual(r, update.rule));
        this.setPermissionRules(rules);
        break;
      }
      case 'replaceRules': {
        this.setPermissionRules(update.rules.map(toPermissionRuleConfig));
        break;
      }
    }
  }

  // ─── Task 9: reloadForProject（设计 §10 / A66） ──────────────────────────────

  /**
   * 切换项目并重载权限规则（设计 §10 / A66）。
   *
   * 行为：
   *   - 更新 currentProject；
   *   - 通过 session.applyPermissionUpdate(replaceRules) 更新 session 快照（唯一状态变换入口）；
   *   - auto 模式下危险 allow 自动进入 stash（由 applyPermissionUpdate 内部 partition 负责）。
   *
   * 不写盘——project 规则是运行时来源，不持久化到 settings。
   */
  reloadForProject(
    projectPath: string,
    rules: readonly PermissionRule[],
    session: SessionState,
  ): void {
    this._currentProject = projectPath;
    // 唯一状态变换入口：replaceRules 会按当前 mode 分区（auto -> 危险 allow 进 stash）
    session.applyPermissionUpdate({ kind: 'replaceRules', rules: [...rules] });
  }
}

/** 脱敏 API Key：只显示前 8 位 */
function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return key.slice(0, 8) + '***';
}

// ─── Task 9: PermissionRule <-> PermissionRuleConfig 桥接（结构相同，独立类型） ──

/** PermissionRule（permission/types.ts）-> PermissionRuleConfig（config/schema.ts），结构相同 */
function toPermissionRuleConfig(rule: PermissionRule): PermissionRuleConfig {
  return {
    tool: rule.tool,
    behavior: rule.behavior,
    ...(rule.path !== undefined ? { path: rule.path } : {}),
    ...(rule.content !== undefined ? { content: rule.content } : {}),
  };
}

/** 结构化比较 PermissionRuleConfig 与 PermissionRule（跨类型相等） */
function ruleConfigEqual(config: PermissionRuleConfig, rule: PermissionRule): boolean {
  return (
    config.tool === rule.tool &&
    config.behavior === rule.behavior &&
    config.path === rule.path &&
    config.content === rule.content
  );
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
