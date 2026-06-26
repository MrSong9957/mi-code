// 配置模块测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
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
    const store = new ConfigStore();
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

  it('should set and get API key', () => {
    const store = new ConfigStore();
    store.setApiKey('openai', 'sk-test-123');
    expect(store.getApiKey('openai')).toBe('sk-test-123');
  });

  it('should mask API key', () => {
    const store = new ConfigStore();
    store.setApiKey('anthropic', 'sk-ant-1234567890');
    const masked = store.getMasked();
    expect(masked.providers.anthropic?.apiKey).toBe('sk-ant-1***');
  });

  it('should default permission mode to "default"', () => {
    const store = new ConfigStore();
    expect(store.getPermissionMode()).toBe('default');
    expect(store.getPermissionRules()).toEqual([]);
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
    expect(store.getPermissionMode()).toBe('default');
    expect(store.getPermissionRules()).toEqual([]);
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
    const store = new ConfigStore();
    const result = executeCommand({ name: 'help', args: [] }, store);
    expect(result.message).toContain('Available commands');
  });

  it('should execute /login command', () => {
    const store = new ConfigStore();
    const result = executeCommand({ name: 'login', args: ['anthropic', 'sk-test'] }, store);
    expect(result.message).toContain('API Key saved');
  });

  it('should execute /config command', () => {
    const store = new ConfigStore();
    const result = executeCommand({ name: 'config', args: [] }, store);
    expect(result.message).toContain('Current configuration');
  });

  it('should execute /provider command', () => {
    const store = new ConfigStore();
    const result = executeCommand({ name: 'provider', args: ['openai'] }, store);
    expect(result.message).toContain('Switched to provider');
  });

  it('should return error for unknown command', () => {
    const store = new ConfigStore();
    const result = executeCommand({ name: 'unknown', args: [] }, store);
    expect(result.message).toContain('Unknown command');
  });

  it('/mode shows current mode when no args', () => {
    const store = new ConfigStore();
    const result = executeCommand({ name: 'mode', args: [] }, store);
    expect(result.message).toContain('Current permission mode');
  });

  it('/mode rejects invalid mode', () => {
    const store = new ConfigStore();
    const result = executeCommand({ name: 'mode', args: ['bogus'] }, store);
    expect(result.message).toContain('Invalid mode');
    expect(store.getPermissionMode()).toBe('default');
  });

  it('/mode sets mode on checker and persists to config', () => {
    const store = new ConfigStore();
    const checker = new PermissionChecker();
    const result = executeCommand({ name: 'mode', args: ['plan'] }, store, { permissionChecker: checker });

    expect(result.message).toContain('Permission mode set to: plan');
    // 即时生效：checker 模式已切换
    expect(checker.getMode()).toBe('plan');
    // plan 模式下写操作应被拒
    expect(checker.check('write_file', { path: 'a.txt', content: 'x' }).behavior).toBe('deny');
    // 持久化：config 已写入
    expect(store.getPermissionMode()).toBe('plan');
  });
});
