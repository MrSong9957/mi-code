// API Key 解析契约测试（RED 阶段）
//
// 根因：src/index.ts 用 configStore.getApiKey(configStore.getDefaultProvider())，
// 但 defaultProvider="openai" 时读到假 key "sk-test-123"，而客户端恒为 Anthropic。
//
// 本测试锁定修复后的契约：
// 即使 config 的 defaultProvider 是 openai，key/model 解析也必须走 anthropic 槽位
// （因为 AnthropicStreamClient 只支持 Anthropic 兼容端点）。
//
// 测试策略：构造一个 defaultProvider=openai 的临时配置，
// 验证 ConfigStore 能独立返回 anthropic 槽位的 key/model。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from '../../config/store.js';

describe('API Key 解析契约（客户端恒为 Anthropic）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-apikey-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * 场景：复刻用户实际的错误配置——
   * defaultProvider=openai（错误），但 anthropic 槽位有真 key。
   * 修复后的 index.ts 应显式取 anthropic 槽位，不受 defaultProvider 影响。
   */
  it('defaultProvider=openai 时，getApiKey(anthropic) 仍返回 anthropic 槽位的真 key', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      providers: {
        anthropic: { apiKey: 'tp-real-valid-key', model: 'mimo-v2.5-pro', smallModel: 'mimo-v2.5' },
        openai: { apiKey: 'sk-test-123', model: 'gpt-4o' },
      },
      defaultProvider: 'openai', // ← 错误配置，但不应影响 Anthropic 客户端
    }));

    const store = new ConfigStore(configDir);

    // BUG 形态：getApiKey(getDefaultProvider()) 会返回 'sk-test-123'
    expect(store.getDefaultProvider()).toBe('openai');
    expect(store.getApiKey(store.getDefaultProvider())).toBe('sk-test-123'); // 错的

    // 修复后契约：index.ts 显式取 anthropic 槽位
    expect(store.getApiKey('anthropic')).toBe('tp-real-valid-key'); // 对的
  });

  it('defaultProvider=openai 时，anthropic 槽位的 model 仍可独立读取', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      providers: {
        anthropic: { apiKey: 'tp-key', model: 'mimo-v2.5-pro', smallModel: 'mimo-v2.5' },
        openai: { apiKey: 'sk-test-123', model: 'gpt-4o' },
      },
      defaultProvider: 'openai',
    }));

    const store = new ConfigStore(configDir);

    // 修复后契约：MODEL 应来自 anthropic provider，而非 getModel()(读 defaultProvider)
    const anthropicProvider = store.getProvider('anthropic');
    expect(anthropicProvider?.model).toBe('mimo-v2.5-pro');
    expect(anthropicProvider?.smallModel).toBe('mimo-v2.5');

    // getSmallModel 显式传 'anthropic' 应返回 mimo-v2.5
    expect(store.getSmallModel('anthropic')).toBe('mimo-v2.5');

    // 对照：getModel() 读 defaultProvider=openai 会返回 gpt-4o（错的模型）
    expect(store.getModel()).toBe('gpt-4o');
  });

  it('defaultProvider=anthropic（正确配置）时行为不变', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      providers: {
        anthropic: { apiKey: 'tp-key', model: 'mimo-v2.5-pro' },
      },
      defaultProvider: 'anthropic',
    }));

    const store = new ConfigStore(configDir);
    expect(store.getApiKey('anthropic')).toBe('tp-key');
    expect(store.getProvider('anthropic')?.model).toBe('mimo-v2.5-pro');
  });

  it('ANTHROPIC_API_KEY 环境变量覆盖配置文件的 key', () => {
    const configDir = join(tempDir, '.micode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      providers: {
        anthropic: { apiKey: 'file-key', model: 'mimo-v2.5-pro' },
      },
      defaultProvider: 'anthropic',
    }));

    const oldEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'env-key-override';
    try {
      const store = new ConfigStore(configDir);
      // 环境变量优先
      expect(store.getApiKey('anthropic')).toBe('env-key-override');
    } finally {
      if (oldEnv !== undefined) process.env.ANTHROPIC_API_KEY = oldEnv;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
