// Task 4 corrective: executor.ts command feedback localization
//
// Spec §3.1/§11.8 first-version localization. This test covers the
// spec-mandated categories with representative tests (NOT one-per-string):
// zh/en switches for /config /login /provider /model /theme /skill /y|/n
// unknown /compact /build (mode switch), plus back-compat (no translator).
//
// Production path: executeCommand(cmd, configStore, { translator, ... }).

import { describe, expect, it, vi } from 'vitest';
import { executeCommand } from '../../commands/executor.js';
import type { CommandContext } from '../../commands/executor.js';
import type { Command } from '../../commands/parser.js';
import type { ConfigStore } from '../../config/store.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import type { Language } from '../../locale/types.js';

// ─── helpers ──────────────────────────────────────────────────────────────

function cmd(name: string, args: string[] = []): Command {
  return { name, args };
}

/** Build a CommandContext carrying a translator for the chosen language. */
function contextFor(language: Language): CommandContext {
  const languageStore = createLanguageStore(language);
  return {
    languageStore,
    translator: createTranslator(languageStore),
  };
}

/** Minimal ConfigStore stub: only the methods executor.ts touches. */
function createConfig(overrides: {
  providers?: Record<string, { apiKey?: string; model?: string }>;
  defaultProvider?: string;
  model?: string;
} = {}): ConfigStore {
  const providers = overrides.providers ?? {};
  const defaultProvider = overrides.defaultProvider ?? 'anthropic';
  const model = overrides.model ?? 'claude-3';
  return {
    getMasked: () => ({
      providers,
      defaultProvider,
      permissions: { mode: 'build', rules: [] },
    }),
    getDefaultProvider: () => defaultProvider,
    setDefaultProvider: vi.fn(),
    getModel: () => model,
    setModel: vi.fn(),
    setApiKey: vi.fn(),
    setPermissionMode: vi.fn(),
  } as unknown as ConfigStore;
}

// ─── /config ──────────────────────────────────────────────────────────────

describe('/config localization', () => {
  it('switches the no-providers message zh/en while keeping config keys and provider values raw', () => {
    const config = createConfig({ providers: {}, defaultProvider: 'anthropic' });

    const zh = executeCommand(cmd('config'), config, contextFor('zh-CN'));
    const en = executeCommand(cmd('config'), config, contextFor('en-US'));

    expect(zh.message).toContain('尚未配置任何提供商');
    expect(en.message).toContain('No providers configured');

    // Both still carry the raw provider name + arg hint (raw technical content).
    expect(zh.message).toContain('/login <provider>');
    expect(en.message).toContain('/login <provider>');
  });

  it('renders the current-configuration header in the current locale', () => {
    const config = createConfig({
      providers: { anthropic: { apiKey: 'sk-12345678', model: 'claude-3' } },
      defaultProvider: 'anthropic',
    });

    const zh = executeCommand(cmd('config'), config, contextFor('zh-CN'));
    const en = executeCommand(cmd('config'), config, contextFor('en-US'));

    expect(zh.message).toContain('当前配置');
    expect(en.message).toContain('Current configuration');
    // Config display markers + keys stay raw.
    expect(zh.message).toContain('apiKey:');
    expect(zh.message).toContain('model:');
    expect(zh.message).toContain('(default)');
  });
});

// ─── /login ───────────────────────────────────────────────────────────────

describe('/login localization', () => {
  it('switches the saved message zh/en while keeping provider name raw', () => {
    const config = createConfig();

    const zh = executeCommand(cmd('login', ['openai', 'sk-xyz']), config, contextFor('zh-CN'));
    const en = executeCommand(cmd('login', ['openai', 'sk-xyz']), config, contextFor('en-US'));

    expect(zh.message).toContain('已为 openai 保存 API Key');
    expect(zh.message).toContain('openai');
    expect(en.message).toContain('API Key saved for openai');
    expect(en.message).toContain('/provider openai');
  });
});

// ─── /provider ────────────────────────────────────────────────────────────

describe('/provider localization', () => {
  it('switches the current-provider message zh/en; provider name raw', () => {
    const config = createConfig({ defaultProvider: 'anthropic' });

    const zh = executeCommand(cmd('provider'), config, contextFor('zh-CN'));
    const en = executeCommand(cmd('provider'), config, contextFor('en-US'));

    expect(zh.message).toBe('当前提供商：anthropic');
    expect(en.message).toBe('Current provider: anthropic');
  });

  it('switches the switched-provider message zh/en; provider name raw', () => {
    const config = createConfig({ defaultProvider: 'anthropic' });

    const zh = executeCommand(cmd('provider', ['openai']), config, contextFor('zh-CN'));
    const en = executeCommand(cmd('provider', ['openai']), config, contextFor('en-US'));

    expect(zh.message).toBe('已切换到提供商：openai');
    expect(en.message).toBe('Switched to provider: openai');
  });
});

// ─── /model ───────────────────────────────────────────────────────────────

describe('/model localization', () => {
  it('switches the current-model message zh/en; model name raw', () => {
    const config = createConfig({ model: 'claude-3' });

    const zh = executeCommand(cmd('model'), config, contextFor('zh-CN'));
    const en = executeCommand(cmd('model'), config, contextFor('en-US'));

    expect(zh.message).toBe('当前模型：claude-3');
    expect(en.message).toBe('Current model: claude-3');
  });

  it('switches the model-set message zh/en; model + provider raw', () => {
    const config = createConfig({ defaultProvider: 'anthropic' });

    const zh = executeCommand(cmd('model', ['gpt-4']), config, contextFor('zh-CN'));
    const en = executeCommand(cmd('model', ['gpt-4']), config, contextFor('en-US'));

    expect(zh.message).toBe('模型已设置为：gpt-4（anthropic）');
    expect(en.message).toBe('Model set to: gpt-4 (for anthropic)');
  });
});

// ─── /theme ───────────────────────────────────────────────────────────────

describe('/theme localization', () => {
  it('switches the theme-switched message zh/en; theme name raw', () => {
    // theme lives in BOTH config-branch (ctx as 3rd arg) and context-branch (ctx as 2nd arg).
    // Test both paths localize.
    const setTheme = vi.fn();
    const zhConfigCtx = contextFor('zh-CN');
    const enConfigCtx = contextFor('en-US');
    (zhConfigCtx as CommandContext).themeStore = { getState: () => ({ setTheme }) } as never;
    (enConfigCtx as CommandContext).themeStore = { getState: () => ({ setTheme }) } as never;

    const zhViaConfig = executeCommand(cmd('theme', ['dark']), createConfig(), zhConfigCtx);
    const enViaConfig = executeCommand(cmd('theme', ['light']), createConfig(), enConfigCtx);

    expect(zhViaConfig.message).toBe('已切换到主题 dark');
    expect(enViaConfig.message).toBe('Theme switched to light');

    // Context-branch path (ctx as 2nd arg) also localizes.
    const zhContext = contextFor('zh-CN');
    const enContext = contextFor('en-US');
    (zhContext as CommandContext).themeStore = { getState: () => ({ setTheme }) } as never;
    (enContext as CommandContext).themeStore = { getState: () => ({ setTheme }) } as never;

    const zhViaCtx = executeCommand(cmd('theme', ['dark']), zhContext);
    const enViaCtx = executeCommand(cmd('theme', ['light']), enContext);

    expect(zhViaCtx.message).toBe('已切换到主题 dark');
    expect(enViaCtx.message).toBe('Theme switched to light');
  });
});

// ─── /skill ───────────────────────────────────────────────────────────────

describe('/skill localization', () => {
  // Context-branch commands (skill/trigger/y/n/edit) take ctx as the 2nd arg
  // in production (index.ts:766). Config is not needed by these handlers.
  function skillCtx(language: Language, negotiator?: object): CommandContext {
    const ctx = contextFor(language);
    (ctx as CommandContext).skillRegistry = undefined;
    (ctx as CommandContext).negotiator = negotiator as never;
    return ctx;
  }

  it('switches the blocked-skill message zh/en; skill name raw', () => {
    const block = vi.fn();
    const zh = executeCommand(
      cmd('skill', ['off', 'web-gui-tester']),
      skillCtx('zh-CN', { block, unskip: vi.fn() }),
    );
    const en = executeCommand(
      cmd('skill', ['off', 'web-gui-tester']),
      skillCtx('en-US', { block, unskip: vi.fn() }),
    );

    expect(block).toHaveBeenCalledWith('web-gui-tester', 'default');
    expect(zh.message).toBe('技能 "web-gui-tester" 已屏蔽。');
    expect(en.message).toBe('Skill "web-gui-tester" blocked.');
  });

  it('switches the no-system message zh/en for /trigger without registry', () => {
    const zh = executeCommand(
      cmd('trigger', ['missing-skill']),
      skillCtx('zh-CN', {
        block: vi.fn(),
        unskip: vi.fn(),
        getPendingConfirmation: vi.fn(() => null),
        negotiate: vi.fn(),
      }),
    );
    const en = executeCommand(
      cmd('trigger', ['missing-skill']),
      skillCtx('en-US', {
        block: vi.fn(),
        unskip: vi.fn(),
        getPendingConfirmation: vi.fn(() => null),
        negotiate: vi.fn(),
      }),
    );

    // /trigger <name> needs both registry and negotiator; without registry we
    // expect the no-system message which still localizes.
    expect(zh.message).toBe('无可用技能系统。');
    expect(en.message).toBe('No skill system available.');
  });
});

// ─── /y | /n (no pending confirmation) ────────────────────────────────────

describe('/y | /n no-pending-confirmation localization', () => {
  it('switches the no-pending message zh/en for /y', () => {
    const zhCtx = contextFor('zh-CN');
    const enCtx = contextFor('en-US');
    (zhCtx as CommandContext).negotiator = undefined;
    (enCtx as CommandContext).negotiator = undefined;

    // /y is a context-branch command → ctx is the 2nd arg.
    const zh = executeCommand(cmd('y'), zhCtx);
    const en = executeCommand(cmd('y'), enCtx);

    expect(zh.message).toBe('没有待处理的确认。');
    expect(en.message).toBe('No pending confirmation.');
  });
});

// ─── unknown command ──────────────────────────────────────────────────────

describe('unknown command localization', () => {
  it('switches the unknown-command message zh/en; command name raw', () => {
    const zh = executeCommand(cmd('bogus'), createConfig(), contextFor('zh-CN'));
    const en = executeCommand(cmd('bogus'), createConfig(), contextFor('en-US'));

    expect(zh.message).toBe('未知命令：/bogus。输入 /help 查看可用命令。');
    expect(en.message).toBe('Unknown command: /bogus. Type /help for available commands.');
  });
});

// ─── /compact ─────────────────────────────────────────────────────────────

describe('/compact localization', () => {
  it('switches the triggered message zh/en', () => {
    const zh = executeCommand(cmd('compact'), createConfig(), contextFor('zh-CN'));
    const en = executeCommand(cmd('compact'), createConfig(), contextFor('en-US'));

    expect(zh.message).toContain('已触发压缩');
    expect(en.message).toBe('Compaction triggered. Use the agent to run a task and it will auto-compact when needed.');
  });
});

// ─── /build (mode switch) ─────────────────────────────────────────────────

describe('/build (mode switch) localization', () => {
  it('switches the mode-set message zh/en; mode raw', () => {
    const zh = executeCommand(cmd('build'), createConfig(), contextFor('zh-CN'));
    const en = executeCommand(cmd('build'), createConfig(), contextFor('en-US'));

    expect(zh.message).toBe('权限模式已切换为：build');
    expect(en.message).toBe('Permission mode set to: build');
  });
});

// ─── back-compat: no translator → English literal ─────────────────────────

describe('back-compat: handler without translator returns English literal', () => {
  it('/provider without translator keeps the English fallback', () => {
    const result = executeCommand(cmd('provider'), createConfig({ defaultProvider: 'anthropic' }));
    expect(result.message).toBe('Current provider: anthropic');
  });

  it('/compact without translator keeps the English fallback', () => {
    const result = executeCommand(cmd('compact'), createConfig());
    expect(result.message).toBe('Compaction triggered. Use the agent to run a task and it will auto-compact when needed.');
  });
});
