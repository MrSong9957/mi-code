// 配置模块测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from '../config/store.js';
import { parseCommand } from '../commands/parser.js';
import { executeCommand } from '../commands/executor.js';
import { PermissionChecker } from '../permission/checker.js';

describe('ConfigStore', () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-config-test-'));
    originalHome = process.env.USERPROFILE;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    if (originalHome) {
      process.env.USERPROFILE = originalHome;
    } else {
      delete process.env.USERPROFILE;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return default config when no file exists', () => {
    // 显式传临时目录，避免 os.homedir() 读取真实 ~/.micode/config.json（Windows 上
    // 运行时改 USERPROFILE 对 homedir() 不可靠，会读到真实配置导致断言失败）
    const store = new ConfigStore(tempDir);
    expect(store.getDefaultProvider()).toBe('anthropic');
    expect(store.getModel()).toBe('claude-sonnet-4-20250514');
  });

  it('should load config from file', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      providers: {
        anthropic: { apiKey: 'sk-ant-test', model: 'claude-3-opus' },
      },
      defaultProvider: 'anthropic',
    }));

    const store = new ConfigStore(configDir);
    expect(store.getApiKey('anthropic')).toBe('sk-ant-test');
    expect(store.getModel()).toBe('claude-3-opus');
  });

  it('should load spinner verb append/replace configuration', () => {
    const configDir = join(tempDir, '.micode-spinner');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      spinnerVerbs: { mode: 'replace', verbs: ['Customizing'] },
    }));

    const store = new ConfigStore(configDir);
    expect(store.getSpinnerVerbsConfig()).toEqual({
      mode: 'replace',
      verbs: ['Customizing'],
    });
  });

  it('should return undefined when language is absent', () => {
    const store = new ConfigStore(tempDir);
    expect(store.getLanguage()).toBeUndefined();
  });

  it('should load a valid persisted language', () => {
    const configDir = join(tempDir, '.micode-language');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      language: 'en-US',
    }));

    const store = new ConfigStore(configDir);
    expect(store.getLanguage()).toBe('en-US');
  });

  it('should treat an invalid persisted language as unconfigured without rewriting bytes', () => {
    const configDir = join(tempDir, '.micode-invalid-language');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    const original = '{\n  "language": "fr-FR",\n  "futureFeature": {\n    "enabled": true\n  }\n}\n';
    writeFileSync(configPath, original, 'utf8');

    const store = new ConfigStore(configDir);

    expect(store.getLanguage()).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('should set and get API key', () => {
    const store = new ConfigStore(tempDir);
    store.setApiKey('openai', 'sk-test-123');
    expect(store.getApiKey('openai')).toBe('sk-test-123');
  });

  it('should mask API key', () => {
    const store = new ConfigStore(tempDir);
    store.setApiKey('anthropic', 'sk-ant-1234567890');
    const masked = store.getMasked();
    expect(masked.providers.anthropic?.apiKey).toBe('sk-ant-1***');
  });

  it('should default permission mode to "build"', () => {
    const store = new ConfigStore(tempDir);
    expect(store.getPermissionMode()).toBe('build');
    expect(store.getPermissionRules()).toEqual([]);
  });

  it('should migrate legacy "default" mode to "build" on load', () => {
    const configDir = join(tempDir, '.micode-legacy');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      providers: {},
      defaultProvider: 'anthropic',
      permissions: { mode: 'default', rules: [] },
    }));
    const store = new ConfigStore(configDir);
    // 旧版 'default' 应被自动迁移为 'build'
    expect(store.getPermissionMode()).toBe('build');
  });

  it('should persist and reload permission mode', () => {
    const configDir = join(tempDir, '.micode');
    const store1 = new ConfigStore(configDir);
    store1.setPermissionMode('plan');
    store1.setPermissionRules([{ tool: 'run_bash', behavior: 'deny', content: 'sudo *' }]);

    // 重新加载，验证从文件恢复
    const store2 = new ConfigStore(configDir);
    expect(store2.getPermissionMode()).toBe('plan');
    expect(store2.getPermissionRules()).toEqual([{ tool: 'run_bash', behavior: 'deny', content: 'sudo *' }]);
  });

  it('should be backward-compatible with config files lacking permissions field', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      providers: {},
      defaultProvider: 'anthropic',
    }));
    const store = new ConfigStore(configDir);
    expect(store.getPermissionMode()).toBe('build');
    expect(store.getPermissionRules()).toEqual([]);
  });

  // ── smallModel：小模型配置（子代理 / 压缩摘要等轻量任务使用）──
  it('getSmallModel should return configured smallModel from file', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      providers: {
        anthropic: { apiKey: 'sk-test', model: 'mimo-v2.5-pro', smallModel: 'mimo-v2.5' },
      },
      defaultProvider: 'anthropic',
    }));

    const store = new ConfigStore(configDir);
    expect(store.getSmallModel('anthropic')).toBe('mimo-v2.5');
  });

  it('getSmallModel should fall back to main model when smallModel not configured', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      providers: {
        anthropic: { apiKey: 'sk-test', model: 'mimo-v2.5-pro' },
      },
      defaultProvider: 'anthropic',
    }));

    const store = new ConfigStore(configDir);
    // 未配置 smallModel → 回退到主模型（默认行为零变化）
    expect(store.getSmallModel('anthropic')).toBe('mimo-v2.5-pro');
    expect(store.getSmallModel('anthropic')).toBe(store.getModel());
  });

  it('getSmallModel should fall back to default model when provider has no model at all', () => {
    const store = new ConfigStore(tempDir);
    // 空配置：连主模型都没有 → 回退到 DEFAULT_MODELS.anthropic
    expect(store.getSmallModel('anthropic')).toBe(store.getModel());
  });

  it('setSmallModel should persist and reload', () => {
    const configDir = join(tempDir, '.micode');
    const store1 = new ConfigStore(configDir);
    store1.setSmallModel('anthropic', 'mimo-v2.5');

    // 重新加载，验证从文件恢复
    const store2 = new ConfigStore(configDir);
    expect(store2.getSmallModel('anthropic')).toBe('mimo-v2.5');
  });

  // ── plansDirectory：plan 目录可配置化 ──
  it('getPlansDirectory should default to undefined', () => {
    const store = new ConfigStore(tempDir);
    expect(store.getPlansDirectory()).toBeUndefined();
  });

  it('setPlansDirectory should persist and reload', () => {
    const configDir = join(tempDir, '.micode');
    const store1 = new ConfigStore(configDir);
    store1.setPlansDirectory('/custom/plans');

    const store2 = new ConfigStore(configDir);
    expect(store2.getPlansDirectory()).toBe('/custom/plans');
  });

  it('setPlansDirectory(undefined) clears the override', () => {
    const configDir = join(tempDir, '.micode');
    const store1 = new ConfigStore(configDir);
    store1.setPlansDirectory('/custom/plans');
    store1.setPlansDirectory(undefined);

    const store2 = new ConfigStore(configDir);
    expect(store2.getPlansDirectory()).toBeUndefined();
  });

  it('should load plansDirectory from config file', () => {
    const configDir = join(tempDir, '.micode-plans');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      plansDirectory: '/from/file/plans',
    }));

    const store = new ConfigStore(configDir);
    expect(store.getPlansDirectory()).toBe('/from/file/plans');
  });

  it('setLanguage should persist en-US while preserving unknown fields', () => {
    const configDir = join(tempDir, '.micode-language-save');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      futureFeature: { enabled: 'maybe' },
    }), 'utf8');

    const store = new ConfigStore(configDir);
    store.setLanguage('en-US');

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.futureFeature).toEqual({ enabled: 'maybe' });
    expect(raw.language).toBe('en-US');
  });
});

describe('Command Parser', () => {
  it('should parse slash commands', () => {
    const cmd = parseCommand('/login anthropic sk-ant-test');
    expect(cmd).toEqual({ name: 'login', args: ['anthropic', 'sk-ant-test'] });
  });

  it('should return null for non-commands', () => {
    expect(parseCommand('hello world')).toBeNull();
  });

  it('should handle command with no args', () => {
    const cmd = parseCommand('/config');
    expect(cmd).toEqual({ name: 'config', args: [] });
  });
});

describe('Command Executor', () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-cmd-test-'));
    originalHome = process.env.USERPROFILE;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    if (originalHome) {
      process.env.USERPROFILE = originalHome;
    } else {
      delete process.env.USERPROFILE;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should execute /help command', () => {
    const store = new ConfigStore(tempDir);
    const result = executeCommand({ name: 'help', args: [] }, store);
    expect(result.message).toContain('Available commands');
    expect(result.message).not.toContain('/approve');
    expect(result.message).not.toContain('/reject');
  });

  it('should execute /login command', () => {
    const store = new ConfigStore(tempDir);
    const result = executeCommand({ name: 'login', args: ['anthropic', 'sk-test'] }, store);
    expect(result.message).toContain('API Key saved');
  });

  it('should execute /config command', () => {
    const store = new ConfigStore(tempDir);
    const result = executeCommand({ name: 'config', args: [] }, store);
    expect(result.message).toContain('Current configuration');
  });

  it('/config set plansDirectory persists the override', () => {
    const store = new ConfigStore(tempDir);
    const result = executeCommand({ name: 'config', args: ['set', 'plansDirectory', '/custom/plans'] }, store);
    expect(result.message).toContain('plansDirectory set to: /custom/plans');
    expect(store.getPlansDirectory()).toBe('/custom/plans');
  });

  it('/config set plansDirectory default clears the override', () => {
    const store = new ConfigStore(tempDir);
    store.setPlansDirectory('/custom/plans');
    const result = executeCommand({ name: 'config', args: ['set', 'plansDirectory', 'default'] }, store);
    expect(result.message).toContain('(default ~/.micode/plans/)');
    expect(store.getPlansDirectory()).toBeUndefined();
  });

  it('should execute /provider command', () => {
    const store = new ConfigStore(tempDir);
    const result = executeCommand({ name: 'provider', args: ['openai'] }, store);
    expect(result.message).toContain('Switched to provider');
  });

  it('should return error for unknown command', () => {
    const store = new ConfigStore(tempDir);
    const result = executeCommand({ name: 'unknown', args: [] }, store);
    expect(result.message).toContain('Unknown command');
  });

  it('/mode is no longer a valid command (removed)', () => {
    const store = new ConfigStore(tempDir);
    const result = executeCommand({ name: 'mode', args: ['plan'] }, store);
    expect(result.message).toContain('Unknown command');
  });

  it('/build sets mode to build on checker and persists', () => {
    const store = new ConfigStore(tempDir);
    const checker = new PermissionChecker();
    // 先切到 plan，再切回 build 验证生效
    checker.setMode('plan');
    const result = executeCommand({ name: 'build', args: [] }, store, { permissionChecker: checker });

    expect(result.message).toContain('build');
    expect(checker.getMode()).toBe('build');
    // build 模式下写操作不应在闸门3被拒（走到闸门4 ask）
    const decision = checker.check('write_file', { path: 'a.txt', content: 'x' });
    expect(decision.behavior).not.toBe('deny');
    expect(store.getPermissionMode()).toBe('build');
  });

  it('/plan sets mode to plan on checker and persists', () => {
    const store = new ConfigStore(tempDir);
    const checker = new PermissionChecker();
    const result = executeCommand({ name: 'plan', args: [] }, store, { permissionChecker: checker });

    expect(result.message).toContain('plan');
    expect(checker.getMode()).toBe('plan');
    // plan 模式下写操作应被拒
    expect(checker.check('write_file', { path: 'a.txt', content: 'x' }).behavior).toBe('deny');
    expect(store.getPermissionMode()).toBe('plan');
  });

  it('/auto sets mode to auto on checker and persists', () => {
    const store = new ConfigStore(tempDir);
    const checker = new PermissionChecker();
    const result = executeCommand({ name: 'auto', args: [] }, store, { permissionChecker: checker });

    expect(result.message).toContain('auto');
    expect(checker.getMode()).toBe('auto');
    // A15：auto 模式下未决写操作返回 ask（交 resolver/classifier），不再无条件 allow
    expect(checker.check('write_file', { path: 'a.txt', content: 'x' }).behavior).toBe('ask');
    expect(store.getPermissionMode()).toBe('auto');
  });
});
