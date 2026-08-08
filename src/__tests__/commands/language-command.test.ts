import { describe, expect, it, vi } from 'vitest';
import { executeCommand } from '../../commands/executor.js';
import type { CommandContext } from '../../commands/executor.js';
import type { Command } from '../../commands/parser.js';
import type { ConfigStore } from '../../config/store.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import type { Language } from '../../locale/types.js';

function languageCommand(args: string[]): Command {
  return { name: 'language', args };
}

function createRuntime(initialLanguage: Language, onSetLanguage?: (language: Language) => void): {
  context: CommandContext;
  setLanguageSpy: ReturnType<typeof vi.fn<(language: Language) => void>>;
} {
  const languageStore = createLanguageStore(initialLanguage);
  const setLanguage = languageStore.getState().setLanguage;
  const setLanguageSpy = vi.fn((language: Language) => {
    onSetLanguage?.(language);
    setLanguage(language);
  });
  languageStore.setState({ setLanguage: setLanguageSpy });

  return {
    context: {
      languageStore,
      translator: createTranslator(languageStore),
    },
    setLanguageSpy,
  };
}

function createConfig(onSetLanguage?: (language: Language) => void): {
  config: ConfigStore;
  setLanguageSpy: ReturnType<typeof vi.fn<(language: Language) => void>>;
} {
  const setLanguageSpy = vi.fn((language: Language) => {
    onSetLanguage?.(language);
  });

  return {
    config: { setLanguage: setLanguageSpy } as unknown as ConfigStore,
    setLanguageSpy,
  };
}

describe('/language command lifecycle', () => {
  it('reports current and supported languages without persisting or mutating runtime state', () => {
    const { context, setLanguageSpy: runtimeSetLanguage } = createRuntime('zh-CN');
    const { config, setLanguageSpy: persistLanguage } = createConfig();

    const result = executeCommand(languageCommand([]), config, context);

    expect(result.message).toBe('当前语言：zh-CN。支持：zh-CN, en-US。');
    expect(persistLanguage).not.toHaveBeenCalled();
    expect(runtimeSetLanguage).not.toHaveBeenCalled();
  });

  it('persists before updating runtime state and reports success in the new locale', () => {
    const calls: string[] = [];
    const { context } = createRuntime('zh-CN', (language) => {
      calls.push(`runtime:${language}`);
    });
    const { config } = createConfig((language) => {
      calls.push(`persist:${language}`);
    });

    const result = executeCommand(languageCommand(['en-US']), config, context);

    expect(calls).toEqual(['persist:en-US', 'runtime:en-US']);
    expect(context.languageStore?.getState().language).toBe('en-US');
    expect(result.message).toBe('Language switched to en-US.');
  });

  it('rejects unsupported values without changing zh-CN runtime state', () => {
    const { context, setLanguageSpy: runtimeSetLanguage } = createRuntime('zh-CN');
    const { config, setLanguageSpy: persistLanguage } = createConfig();

    const result = executeCommand(languageCommand(['fr-FR']), config, context);

    expect(result.message).toBe('不支持的语言：fr-FR。支持：zh-CN, en-US。');
    expect(context.languageStore?.getState().language).toBe('zh-CN');
    expect(persistLanguage).not.toHaveBeenCalled();
    expect(runtimeSetLanguage).not.toHaveBeenCalled();
  });

  it('keeps zh-CN runtime state and reports persistence failure in the old locale', () => {
    const { context, setLanguageSpy: runtimeSetLanguage } = createRuntime('zh-CN');
    const setLanguageSpy = vi.fn(() => {
      throw new Error('disk full');
    });
    const config = { setLanguage: setLanguageSpy } as unknown as ConfigStore;

    const result = executeCommand(languageCommand(['en-US']), config, context);

    expect(result.message).toBe('保存语言 en-US 失败：disk full');
    expect(context.languageStore?.getState().language).toBe('zh-CN');
    expect(setLanguageSpy).toHaveBeenCalledOnce();
    expect(runtimeSetLanguage).not.toHaveBeenCalled();
  });

  it('/help uses the current locale while keeping command tokens and arg hints unchanged', () => {
    const { context } = createRuntime('zh-CN');
    const { config } = createConfig();

    const result = executeCommand({ name: 'help', args: [] }, config, context);

    expect(result.message).toContain('可用命令：');
    expect(result.message).toContain('/theme <dark|light>  切换主题');
    expect(result.message).toContain('/language [lang]  查看当前语言或切换界面语言');
  });
});
